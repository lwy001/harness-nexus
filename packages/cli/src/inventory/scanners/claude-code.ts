import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredItem } from '../common.js';
import {
  MAX_ITEM_BYTES,
  isPlatformMcpName,
  mcpMeta,
  previewOf,
  readTextBounded,
  redactSecretMap,
  skillDirFiles,
  summarize,
} from '../common.js';
import type { RawMcpEntry, TargetScanner } from '../types.js';

/**
 * Claude Code scanner (Phase 8 C3). Ground truth mirrors what our adapters and
 * the marketplace emitter write:
 *   skills   → ~/.claude/skills/<name>/SKILL.md (+ bundle files)
 *   commands → ~/.claude/commands/<name>.md
 *   agents   → ~/.claude/agents/<name>.md
 *   mcp      → `mcpServers` in ~/.claude.json (user scope — OUTSIDE ~/.claude)
 * Rules and hooks are not scanned (no established global rules dir; CC's hook
 * matcher format is lossy vs the 4.5 event map). `~/.claude/plugins`
 * (marketplace installs) are out of scope for C3.
 */

const CLAUDE_JSON_LIMIT = 4 * 1024 * 1024;

function parseClaudeJson(homeDir: string): Record<string, RawMcpEntry> {
  // NB: ~/.claude.json holds CC's full state (projects, history) — bound the
  // read and tolerate garbage; MCP absence is not an error.
  const file = path.join(homeDir, '.claude.json');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > CLAUDE_JSON_LIMIT) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, RawMcpEntry>;
    };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

/** Scan one directory of sibling markdown artifacts (commands/, agents/). */
function scanMarkdownDir(
  dir: string,
  relBase: string,
  kind: 'command' | 'sub_agent',
  ext: '.md',
): DiscoveredItem[] {
  if (!fs.existsSync(dir)) return [];
  const items: DiscoveredItem[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
    const name = entry.name.slice(0, -ext.length);
    if (!name) continue;
    const abs = path.join(dir, entry.name);
    const text = readTextBounded(abs);
    items.push({
      kind,
      name,
      absPath: abs,
      relPath: `${relBase}/${entry.name}`,
      importable: text.ok,
      ...(text.ok ? { summary: summarize(text.content) } : { note: text.error }),
      ...(text.ok ? { preview: previewOf(text.content) } : {}),
    });
  }
  return items;
}

export const claudeCodeScanner: TargetScanner = {
  target: 'claude-code',
  homeOf: (homeDir) => path.join(homeDir, '.claude'),

  discover(home) {
    // ~/.claude.json lives at HOME root; the home dir itself may be absent
    // while user-scope MCP servers still exist — scan both independently.
    const homeDir = path.dirname(home);
    const items: DiscoveredItem[] = [];
    const homeExists = fs.existsSync(home);

    if (homeExists) {
      const skillsDir = path.join(home, 'skills');
      if (fs.existsSync(skillsDir)) {
        for (const entry of fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name))) {
          if (!entry.isDirectory()) continue;
          const dir = path.join(skillsDir, entry.name);
          const files = skillDirFiles(dir);
          const skillMd = readTextBounded(path.join(dir, 'SKILL.md'));
          if (!skillMd.ok) {
            items.push({
              kind: 'skill',
              name: entry.name,
              absPath: dir,
              relPath: `skills/${entry.name}`,
              importable: false,
              note: files.length === 0 ? 'empty' : `SKILL.md ${skillMd.error}`,
            });
            continue;
          }
          const totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
          items.push({
            kind: 'skill',
            name: entry.name,
            absPath: dir,
            relPath: `skills/${entry.name}`,
            importable: totalBytes <= MAX_ITEM_BYTES,
            ...(totalBytes > MAX_ITEM_BYTES ? { note: 'too-large' } : {}),
            summary: summarize(skillMd.content),
            preview: previewOf(skillMd.content),
            meta: { multi: files.length > 1 },
          });
        }
      }
      items.push(...scanMarkdownDir(path.join(home, 'commands'), 'commands', 'command', '.md'));
      items.push(...scanMarkdownDir(path.join(home, 'agents'), 'agents', 'sub_agent', '.md'));
    }

    for (const [key, entry] of Object.entries(parseClaudeJson(homeDir))) {
      if (!entry || typeof entry !== 'object') continue;
      items.push({
        kind: 'mcp',
        name: key,
        absPath: path.join(homeDir, '.claude.json'),
        relPath: '~/.claude.json#mcpServers',
        importable: Boolean(entry.command ?? entry.url),
        ...((entry.command ?? entry.url) ? {} : { note: 'unsupported shape' }),
        meta: mcpMeta(entry),
        ...(isPlatformMcpName(key) ? { platform: true } : {}),
      });
    }

    return homeExists || items.length > 0 ? items : null;
  },

  platformMarkers(home) {
    const homeDir = path.dirname(home);
    return Object.keys(parseClaudeJson(homeDir)).filter(isPlatformMcpName);
  },

  async collect(home, item) {
    if (item.kind === 'skill') {
      const files: Record<string, string> = {};
      for (const rel of skillDirFiles(item.absPath)) {
        const text = readTextBounded(path.join(item.absPath, rel));
        if (!text.ok)
          return { kind: 'skill', name: item.name, ok: false, error: `${rel}: ${text.error}` };
        files[rel] = text.content;
      }
      if (!('SKILL.md' in files)) {
        return { kind: 'skill', name: item.name, ok: false, error: 'SKILL.md missing' };
      }
      return { kind: 'skill', name: item.name, ok: true, artifact: { kind: 'skill', files } };
    }
    if (item.kind === 'command' || item.kind === 'sub_agent') {
      const text = readTextBounded(item.absPath);
      if (!text.ok) return { kind: item.kind, name: item.name, ok: false, error: text.error };
      return {
        kind: item.kind,
        name: item.name,
        ok: true,
        artifact: { kind: item.kind, content: text.content },
      };
    }
    // mcp — re-read ~/.claude.json, redact env/header values daemon-side.
    const homeDir = path.dirname(home);
    const entry = parseClaudeJson(homeDir)[item.name];
    if (!entry) return { kind: 'mcp', name: item.name, ok: false, error: 'entry missing' };
    if (entry.command) {
      return {
        kind: 'mcp',
        name: item.name,
        ok: true,
        artifact: {
          kind: 'mcp',
          transport: {
            type: 'stdio',
            command: entry.command,
            ...(entry.args ? { args: entry.args } : {}),
            ...(entry.env ? { env: redactSecretMap(entry.env) } : {}),
          },
        },
      };
    }
    if (entry.url) {
      const type = entry.type === 'sse' ? 'sse' : 'streamable-http';
      return {
        kind: 'mcp',
        name: item.name,
        ok: true,
        artifact: {
          kind: 'mcp',
          transport: {
            type,
            url: entry.url,
            ...(entry.headers ? { headers: redactSecretMap(entry.headers) } : {}),
          },
        },
      };
    }
    return { kind: 'mcp', name: item.name, ok: false, error: 'unsupported shape' };
  },
};

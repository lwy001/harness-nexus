import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REDACTED_PLACEHOLDER,
  readRuntimeConfigView,
  redactEnvFile,
  redactLineConfig,
} from '../src/daemon/config-view.js';

/**
 * Redacted config-view reader (Phase 9 W4). The load-bearing property: a
 * planted secret under ANY secret-ish key never survives the mask — in JSON
 * (key-name walk), TOML/YAML (line level), and `.env` (wholesale, the file
 * exists to hold credentials) — while ordinary config stays readable.
 */

let home: string;
const secret = 'sk-never-leave-the-machine';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hnx-cv-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeRel(rel: string, content: string): string {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  chmodSync(file, 0o600);
  return file;
}

describe('redactLineConfig (TOML/YAML)', () => {
  it('masks values under secret-ish keys, keeps everything else', () => {
    const redacted: string[] = [];
    const out = redactLineConfig(
      [
        'model = "gw-large"',
        'experimental_bearer_token = "sk-live"',
        'apiKeyEnv: HARNESS_NEXUS_API_KEY',
        'displayName: "team"',
        '# env_key = "commented"',
        '[model_providers.harness_nexus]',
        'requires_openai_auth = true',
      ].join('\n'),
      redacted,
    );
    expect(out).toContain('model = "gw-large"');
    expect(out).toContain(`experimental_bearer_token = ${REDACTED_PLACEHOLDER}`);
    expect(out).toContain(`apiKeyEnv: ${REDACTED_PLACEHOLDER}`);
    expect(out).toContain('displayName: "team"');
    expect(out).toContain('requires_openai_auth = true');
    expect(out).not.toContain('sk-live');
    expect(redacted).toContain('experimental_bearer_token');
  });
});

describe('redactEnvFile', () => {
  it('masks EVERY value (the file exists to hold credentials)', () => {
    const redacted: string[] = [];
    const out = redactEnvFile(
      `HARNESS_NEXUS_API_KEY=${secret}\nDEEPSEEK_API_KEY=other\nEDITOR=vim\n# comment\n`,
      redacted,
    );
    expect(out).toBe(
      `HARNESS_NEXUS_API_KEY=${REDACTED_PLACEHOLDER}\nDEEPSEEK_API_KEY=${REDACTED_PLACEHOLDER}\nEDITOR=${REDACTED_PLACEHOLDER}\n# comment\n`,
    );
    expect(out).not.toContain(secret);
    expect(redacted).toHaveLength(3);
  });
});

describe('readRuntimeConfigView', () => {
  it('claude-code: JSON walk masks the settings env tokens, keeps the rest', () => {
    writeRel(
      '.claude/settings.json',
      JSON.stringify({
        model: 'opus',
        permissions: { allow: ['Bash'] },
        env: { ANTHROPIC_AUTH_TOKEN: secret, ANTHROPIC_BASE_URL: 'https://gw', KEEP: 'me' },
      }),
    );
    const view = readRuntimeConfigView('claude-code', home);
    expect(view.files).toHaveLength(1);
    expect(view.files[0]!.path).toBe('~/.claude/settings.json');
    const parsed = JSON.parse(view.files[0]!.content) as {
      model: string;
      env: Record<string, string>;
    };
    expect(parsed.model).toBe('opus');
    expect(parsed.env.ANTHROPIC_AUTH_TOKEN).toBe(REDACTED_PLACEHOLDER);
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('https://gw');
    expect(parsed.env.KEEP).toBe('me');
    expect(view.files[0]!.content).not.toContain(secret);
    expect(view.redacted).toContain('~/.claude/settings.json:env.ANTHROPIC_AUTH_TOKEN');
  });

  it('codex: auth.json key masked, TOML secrets masked, user keys readable', () => {
    writeRel(
      '.codex/config.toml',
      'model = "m"\nexperimental_bearer_token = "sk-t"\n[servers.x]\nurl = "u"\n',
    );
    writeRel('.codex/auth.json', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: secret }));
    const view = readRuntimeConfigView('codex', home);
    const auth = view.files.find((f) => f.path === '~/.codex/auth.json')!;
    expect(JSON.parse(auth.content).OPENAI_API_KEY).toBe(REDACTED_PLACEHOLDER);
    expect(auth.content).not.toContain(secret);
    const toml = view.files.find((f) => f.path === '~/.codex/config.toml')!;
    expect(toml.content).toContain('model = "m"');
    expect(toml.content).toContain(`experimental_bearer_token = ${REDACTED_PLACEHOLDER}`);
    expect(view.redacted).toEqual(expect.arrayContaining(['~/.codex/auth.json:OPENAI_API_KEY']));
  });

  it('deepseek: patch rows readable except the key channel; .env fully masked', () => {
    writeRel(
      '.dsh/cordis.patch.yml',
      [
        '# BEGIN harness-nexus:provider (managed)',
        '- insert:',
        '    - id: hnx-llm',
        "      name: '@deepseek-ai/dsh-llm-pi-ai'",
        '      config:',
        '        providers:',
        '          harness-nexus:',
        '            api: anthropic-messages',
        '            baseURL: "https://gw"',
        '            apiKeyEnv: HARNESS_NEXUS_API_KEY',
        '            models:',
        '              - id: "deepseek-chat"',
        '# END harness-nexus:provider (managed)',
      ].join('\n') + '\n',
    );
    writeRel('.dsh/.env', `HARNESS_NEXUS_API_KEY=${secret}\n`);
    const view = readRuntimeConfigView('deepseek', home);
    const patch = view.files.find((f) => f.path === '~/.dsh/cordis.patch.yml')!;
    expect(patch.content).toContain('api: anthropic-messages');
    expect(patch.content).toContain('baseURL: "https://gw"');
    expect(patch.content).toContain(`apiKeyEnv: ${REDACTED_PLACEHOLDER}`);
    const env = view.files.find((f) => f.path === '~/.dsh/.env')!;
    expect(env.content).toBe(`HARNESS_NEXUS_API_KEY=${REDACTED_PLACEHOLDER}\n`);
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it('skips absent files honestly and flags oversized/binary ones', () => {
    // A fresh home: no codex files exist at all.
    const fresh = mkdtempSync(path.join(tmpdir(), 'hnx-cv-none-'));
    const view = readRuntimeConfigView('codex', fresh);
    expect(view.files).toHaveLength(0);
    rmSync(fresh, { recursive: true, force: true });

    mkdirSync(path.join(home, '.claude'), { recursive: true });
    writeFileSync(path.join(home, '.claude', 'settings.json'), Buffer.alloc(64, 0)); // binary
    const binaryView = readRuntimeConfigView('claude-code', home);
    expect(binaryView.files[0]!.content).toBe('[skipped: binary]');
  });

  it('an unparseable JSON file falls back to pair + line masking (never leaks)', () => {
    writeRel('.claude/settings.json', `{"env":{"ANTHROPIC_AUTH_TOKEN":"${secret}"`); // broken JSON
    const view = readRuntimeConfigView('claude-code', home);
    expect(view.files[0]!.content).not.toContain(secret);
    expect(view.files[0]!.content).toContain(`"ANTHROPIC_AUTH_TOKEN":"${REDACTED_PLACEHOLDER}"`);
  });
});

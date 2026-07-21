import type { FastifyBaseLogger } from 'fastify';
import type { SkillBundle, SkillMeta, SkillSource } from '@harness-nexus/core';
import type { PluginResourceSource } from '@harness-nexus/shared';
import type { MarketplaceFetcher } from './types.js';

/**
 * UrlSource (Phase 7.4) — a single-file `SKILL.md` at a direct HTTP(S) URL.
 * Mirrors Hermes's `UrlSource` (`skills_hub.py:1319`). This source is
 * fetch-only: `search()` is a no-op (it has no catalog to search), and `inspect`
 * parses the SKILL.md frontmatter at the given URL identifier. Always
 * `community` trust.
 *
 * Used when a user already knows the exact URL of a SKILL.md (pasted into the
 * hub's search box) and wants to save it as a skill reference.
 */

export interface UrlSourceOptions {
  fetcher?: MarketplaceFetcher;
  logger: FastifyBaseLogger;
}

export class UrlSource implements SkillSource {
  private readonly fetcher: MarketplaceFetcher;
  private readonly log: FastifyBaseLogger;

  constructor(opts: UrlSourceOptions) {
    this.fetcher = opts.fetcher ?? globalThis.fetch;
    this.log = opts.logger;
  }

  sourceId(): string {
    return 'url';
  }

  // No catalog to search — the identifier IS the URL the user supplies.
  async search(): Promise<SkillMeta[]> {
    return [];
  }

  async inspect(identifier: string): Promise<SkillMeta | null> {
    if (!/^https?:\/\//i.test(identifier) || !/\.md$/i.test(identifier)) return null;
    let body: string;
    try {
      const res = await this.fetcher(identifier, {});
      if (!res.ok) return null;
      body = await res.text();
    } catch (err) {
      this.log.warn({ url: identifier, err }, 'url source fetch failed');
      return null;
    }
    const front = parseFrontmatter(body);
    const name =
      front.name ??
      // Fallback: last path segment minus extension (matches Hermes).
      identifier.split('/').pop()?.replace(/\.md$/i, '') ??
      'unnamed';
    const pluginSource: PluginResourceSource = {
      type: 'plugin',
      source: { source: 'url', url: identifier },
      plugin: name,
    };
    return {
      name,
      description: front.description ?? '',
      source: this.sourceId(),
      identifier,
      trustLevel: 'community',
      extra: { pluginSource },
    };
  }

  async fetch(): Promise<SkillBundle | null> {
    return null;
  }

  trustLevelFor(): 'community' {
    return 'community';
  }
}

/** Parse a minimal YAML frontmatter block (`---\nkey: value\n---`). */
function parseFrontmatter(body: string): { name?: string; description?: string } {
  const m = body.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m || !m[1]) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const k = kv[1];
    const v = kv[2] ?? '';
    if (k === 'name') out.name = v.replace(/^['"]|['"]$/g, '');
    if (k === 'description') out.description = v.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

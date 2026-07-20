import { z } from 'zod';

/**
 * Claude Code / ZCode marketplace.json schema (Phase 7.2).
 *
 * Models the live `anthropics/claude-plugins-official` `.claude-plugin/
 * marketplace.json` shape (ground-truth verified 2026-07). Used by the
 * server-side `SkillCatalogService` to parse a fetched catalog before caching
 * and filtering it for the hub search UI (7.3).
 *
 * Key facts captured here (see `docs/design/phase-7.2-marketplace-fetch.md`):
 *   - Top level has exactly 5 keys: `$schema`, `name`, `description`, `owner`,
 *     `plugins`. There is NO `renames` map in the live official catalog.
 *   - `source` is a discriminated union on the `source` field with 3 object
 *     arms (`git-subdir` / `url` / `github`). The string relative-path form
 *     (`"./plugins/foo"`) is intentionally NOT modeled — those ~30 in-repo
 *     entries are filtered out during parsing because they only make sense
 *     inside the marketplace's own repo and cannot be stored as a standalone
 *     installable spec.
 *   - `npm` is a documented source kind but is absent from the official
 *     catalog; it lives on `ResourceSource.plugin` (storage side), not here.
 *   - `github` entries carry BOTH `commit` and `sha` (treated as aliases; `sha`
 *     is the effective pin).
 *
 * The schema is non-strict (unknown keys pass through) so new fields the
 * official catalog adds don't break parsing — we only validate what we use.
 */

const marketplaceOwnerSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});

/**
 * The 3 object `source` kinds that produce a standalone-installable spec.
 * The string relative-path form is excluded by construction (this is a
 * discriminated union on the `source` literal, which only objects carry).
 */
export const marketplaceSourceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('git-subdir'),
    url: z.string().min(1),
    path: z.string().min(1),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
  z.object({
    source: z.literal('url'),
    url: z.string().min(1),
    sha: z.string().optional(),
    ref: z.string().optional(),
    path: z.string().optional(),
  }),
  z.object({
    source: z.literal('github'),
    repo: z.string().min(1),
    commit: z.string().optional(),
    sha: z.string().optional(),
    path: z.string().optional(),
  }),
]);

export const marketplacePluginSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  source: marketplaceSourceSchema,
  // Search/filter-relevant optional fields. `category` is the primary filter
  // axis (present on ~243/257 live entries). `author`/`homepage`/`version`/
  // `displayName`/`tags`/`keywords` are carried for display. `lspServers`/
  // `strict`/`skills` are dropped — unused by the hub UI.
  displayName: z.string().optional(),
  category: z.string().optional(),
  homepage: z.string().optional(),
  version: z.string().optional(),
  author: marketplaceOwnerSchema.optional(),
  tags: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
});

export const marketplaceCatalogSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  owner: marketplaceOwnerSchema.optional(),
  /**
   * The raw plugin entries, validated as `unknown` here so that entries with
   * the string relative-path `source` form (not modeled) don't fail the whole
   * catalog parse. The catalog service validates each entry with
   * `marketplacePluginSchema` and drops the invalid ones, producing a
   * `MarketplaceCatalog` whose `plugins` are typed `MarketplacePlugin[]`.
   */
  plugins: z.array(z.unknown()),
});

export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;
export type MarketplacePlugin = z.infer<typeof marketplacePluginSchema>;
/**
 * Parsed marketplace shape. Note `plugins` is `MarketplacePlugin[]` at the
 * type level (the catalog service filters out unmodeled string-source entries
 * before constructing this), even though the runtime zod schema accepts
 * `unknown[]` to avoid rejecting the whole catalog on those entries.
 */
export interface MarketplaceCatalog {
  $schema?: string | undefined;
  name: string;
  description?: string | undefined;
  owner?: z.infer<typeof marketplaceOwnerSchema> | undefined;
  plugins: MarketplacePlugin[];
}

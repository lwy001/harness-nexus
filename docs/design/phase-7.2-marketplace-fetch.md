# Design: Phase 7.2 — Marketplace allowlist fetch

> Status: implemented in Phase 7.2 (✅). PRD: `docs/prd/phase-7-skills.md` §7.2.
> Prior design: `docs/design/phase-7.1-plugin-source.md` (the `plugin` source
> variant + trust model this builds on).

The server's **first outbound HTTP path**. A single, allowlisted fetch surface
for Claude Code / ZCode marketplace catalogs, behind a lazy-TTL cache. Bounded
by `MARKETPLACE_ALLOWLIST` (which marketplaces) and a per-fetch timeout (how
long). No other module in the server may make outbound requests.

## Ground-truth marketplace.json (verified, with corrections)

Re-verified against the live
`anthropics/claude-plugins-official/.claude-plugin/marketplace.json` (main
branch, 2026-07). Two facts corrected from earlier research notes:

1. **No top-level `renames`.** The catalog has exactly 5 top-level keys:
   `$schema`, `name`, `description`, `owner { name, email? }`, `plugins[]`.
2. **The `github` source carries `commit` AND `sha`** (not `ref`). These are
   aliases — `sha` is the effective pin. The catalog schema models `commit?`
   explicitly; the storage-side `ResourceSource.plugin.source.github` (Phase
   7.1) uses `ref?/sha?`, and a marketplace entry is converted to that shape
   at save time by treating `commit` as `sha`.

### The 4 `source` kinds in the live catalog

| Kind         | Shape                                                      | Count (~257) |
| ------------ | ---------------------------------------------------------- | ------------ |
| `url`        | `{ url, sha?, path?, ref? }`                               | ~131         |
| `git-subdir` | `{ url, path, ref?, sha? }` (`path` required)              | ~72          |
| `github`     | `{ repo, commit?, sha?, path? }`                           | 2            |
| string path  | `"./plugins/foo"` — relative to the marketplace's own repo | ~52          |

**The string-path form is intentionally dropped** during parsing. Those
entries only make sense inside the marketplace repo; Harness Nexus stores
standalone-installable specs, and a relative path cannot be resolved without
cloning the marketplace repo itself (out of scope for 7.2).

`npm` is a documented source kind but is absent from the live catalog; it
lives on `ResourceSource.plugin` (storage side, Phase 7.1), not in this
catalog schema.

## Architecture

```
 GET /api/skills/marketplaces                    → allowlist only (no fetch)
 GET /api/skills/marketplaces/:id/plugins        → SkillCatalogService
         │
         │ resolveAllowlistId(allowlist, id) → url | null (404 if null)
         ▼
 SkillCatalogService.listPlugins(id, url, filter)
         │
         │ cache hit & fresh → return
         │ cache miss → getCatalog(id, url)
         ▼
 fetcher(url, { signal: AbortSignal.timeout(10s) })
         │  (globalThis.fetch in prod; fixture reader in tests)
         ▼
 marketplaceCatalogSchema.safeParse(JSON)   ← plugins typed unknown[] so
         │                                    string-source entries don't fail
         ▼
 per-plugin marketplacePluginSchema.safeParse  ← drops string-source entries
         │
         ▼
 cache → filter by ?category= / ?q= → return MarketplacePlugin[]
```

## Key components

### `packages/shared/src/schemas/marketplace.ts`

- `marketplaceSourceSchema`: discriminated union on `source`, 3 object arms
  (`git-subdir`/`url`/`github`). String form not modeled.
- `marketplacePluginSchema`: `name/description/source` + optional
  `category/author/homepage/version/displayName/tags/keywords`. Drops
  `lspServers/strict/skills` (unused by the hub UI).
- `marketplaceCatalogSchema`: top-level shape; **`plugins: z.array(z.unknown())`**
  so a string-source entry doesn't fail the whole parse. Per-entry validation
  happens in the service.
- `MarketplaceCatalog` (manual interface, not `z.infer`): `plugins:
MarketplacePlugin[]` — the type the service produces after filtering.

### `packages/server/src/infra/source-fetchers/`

Establishes the outbound-fetch layer:

- **`types.ts`** — `MarketplaceFetcher = typeof globalThis.fetch` (the
  injection point; default `globalThis.fetch`, tests pass a fixture reader).
- **`allowlist.ts`** — `parseAllowlist(raw)` parses
  `name=owner/repo` (→ GitHub raw URL) or `name=url` (verbatim) tokens.
  `resolveAllowlistId(entries, id)` is the route-layer gate.
- **`catalog-service.ts`** — `SkillCatalogService`. Two first-in-codebase
  patterns, both mirroring `McpRegistry`:
  1. **Lazy TTL cache** — `Map<id, { catalog, expiresAt }>`; expired on read
     (`Date.now() > expiresAt`). No `setTimeout` eviction.
  2. **Per-key in-flight dedup** — `Map<id, Promise>` collapses concurrent
     `getCatalog(sameId)` calls onto one fetch, exactly like
     `McpRegistry.reloadPromise` but keyed per marketplace.
  - Errors: network/timeout/non-200/parse → `AppError(502,
'MARKETPLACE_FETCH_FAILED')`.
- **`factory.ts`** — `createMarketplaceFetcher(fixturePath?)`. Returns
  `globalThis.fetch` when unset; a file-reading fetcher when
  `MARKETPLACE_FIXTURE_PATH` is set (smoke/test mode, reads the fixture once
  into memory).

### `packages/server/src/modules/skills.ts`

| Method | Path                                   | Auth          | Notes                                |
| ------ | -------------------------------------- | ------------- | ------------------------------------ |
| GET    | `/api/skills/marketplaces`             | `requireAuth` | list allowlist ids (no fetch)        |
| GET    | `/api/skills/marketplaces/:id/plugins` | `requireAuth` | fetch+cache; `?category=&q=` filters |

- Non-allowlisted id → `404 MARKETPLACE_NOT_ALLOWED` (not 403 — avoids leaking
  which ids are configured).
- Any authenticated user can browse — marketplaces are public catalogs. Saving
  a skill resource from one still goes through the normal `/api/resources`
  scope rules.

### Config (3 new env keys)

| Env                            | Default                                                      | Purpose                                           |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| `MARKETPLACE_ALLOWLIST`        | `claude-plugins-official=anthropics/claude-plugins-official` | comma-separated `name=owner/repo` or `name=url`   |
| `MARKETPLACE_FETCH_TTL_MS`     | `3600000` (1h)                                               | catalog cache TTL                                 |
| `MARKETPLACE_FETCH_TIMEOUT_MS` | `10000` (10s)                                                | per-fetch timeout                                 |
| `MARKETPLACE_FIXTURE_PATH`     | unset                                                        | if set, fetcher reads this local file (test mode) |

### Fastify decorations

- `app.skillCatalog: SkillCatalogService` — co-located augmentation in
  `catalog-service.ts` (mirrors `mcpRegistry` in `proxy.ts`).
- `app.marketplaceAllowlist: MarketplaceEntry[]` — co-located augmentation in
  `allowlist.ts`.

Both decorated in `app.ts:buildApp` after `uow`/`jwt` (decorations must exist
before the auth hook runs).

## Decisions carried in

1. **Lazy cache, not scheduled eviction** — matches the codebase's only
   time-expiry idiom (`Date.parse(x) > Date.now()` in the auth hook) and the
   `McpRegistry` in-flight dedup. No `setTimeout` introduced.
2. **Fetcher injection via env, not constructor param** — the smoke script
   runs the server as a separate process and can't reach its constructor.
   `MARKETPLACE_FIXTURE_PATH` flips the whole fetcher to fixture mode
   (mirrors `STORAGE_DRIVER=memory`'s env-driven mode switch). Production
   leaves it unset → real `globalThis.fetch`.
3. **Drop string-source entries during parse** — they can't be a
   standalone-installable spec without cloning the marketplace repo, which is
   out of scope (a future `marketplace-local` adapter, if needed).
4. **`MarketplaceCatalog.plugins` typed manually** (not `z.infer`) — the zod
   schema accepts `unknown[]` to avoid rejecting the catalog on string-source
   entries; the service produces `MarketplacePlugin[]` after filtering. The
   interface captures the post-filter type.

## Testing

`scripts/fixtures/marketplace.json` — a 6-entry slice of the real CC catalog:
4 object-source entries (`git-subdir`×1, `url`×2, `github`×1) + 2 relative-path
entries (must be filtered). The `[7.2]` smoke block (run with
`MARKETPLACE_FIXTURE_PATH=$PWD/scripts/fixtures/marketplace.json`):

1. `GET /api/skills/marketplaces` → default present.
2. `GET .../plugins` → 4 (after filtering 2 string-source).
3. `?category=security` → 2 security entries.
4. `?q=artifact` → 1 (jfrog, matched on description).
5. Non-allowlisted id → 404 `MARKETPLACE_NOT_ALLOWED`.
6. Second read → same 4 (cache hit).
7. No auth → 401.

121 passed / 0 failed (7.1 block unaltered, 7.2 added).

## Out of scope (deferred)

- **Hub search UI** — Phase 7.3. This phase is backend-only.
- **"Save entry as skill resource" UI** — 7.3. The data model (7.1's `plugin`
  variant) and API (`POST /api/resources`) already support it; 7.2 only
  browses.
- **Real `SkillSource` adapters** (github/url/skills-sh fetching individual
  repos) — Phase 7.4. 7.2 fetches the marketplace's _aggregated catalog_
  only, not individual plugin repos.
- **Content scanning, private-marketplace credentials** — Out of Scope.

## Runbook

Boot production (real fetch):

```bash
JWT_SECRET=... pnpm dev:server
# MARKETPLACE_ALLOWLIST defaults to claude-plugins-official
```

Boot test (fixture, no network):

```bash
JWT_SECRET=... STORAGE_DRIVER=memory \
  MARKETPLACE_FIXTURE_PATH=$PWD/scripts/fixtures/marketplace.json \
  pnpm dev:server
BASE_URL=http://127.0.0.1:8080 node scripts/smoke.mjs
```

Add a second marketplace:

```bash
MARKETPLACE_ALLOWLIST="claude-plugins-official=anthropics/claude-plugins-official,my-org=myorg/plugins"
```

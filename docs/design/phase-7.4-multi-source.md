# Design: Phase 7.4 — Multi-source skill search

> Status: implemented in Phase 7.4 (✅). PRD: `docs/prd/phase-7-skills.md` §7.4.
> Prior designs: `phase-7.1-plugin-source.md` (storage) +
> `phase-7.2-marketplace-fetch.md` (single-marketplace browse) +
> `phase-7.3-hub-ui.md` (the hub page this extends). **Phase 7 complete.**

Hermes-style multi-source skill search. A query dispatches to a set of
`SkillSource` adapters in parallel; results are merged, deduped by identifier,
ranked by trust, and surfaced in the existing `/skills/hub` page alongside the
7.2/7.3 marketplace browse. This is the last sub-phase of Phase 7.

## Scope (ground-truth verified, with corrections)

Hermes ships 10 adapters. This phase ports the 4 worth porting and explicitly
skips/defers the rest, with reasons:

| Adapter                   | Verdict                         | Why                                                                                                    |
| ------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `GitHubSource`            | **PORT**                        | Foundational. Taps + recursive-tree cache + trust tiers.                                               |
| `WellKnownSkillSource`    | **PORT**                        | Open `/.well-known/skills/` protocol, no auth, ~220 lines.                                             |
| `UrlSource`               | **PORT**                        | Trivial single-file fetch. ~160 lines.                                                                 |
| `ClaudeMarketplaceSource` | **PORT as `MarketplaceSource`** | Same `.claude-plugin/marketplace.json` mechanism as 7.2 — wrapped, not reimplemented.                  |
| `SkillsShSource`          | **DEFER (7.5+)**                | Thin GitHub-redirect layer with sitemap-walking complexity. If ported, `/api/search` only.             |
| `BrowseShSource`          | **DEFER (7.5+)**                | Clean API but niche (browser-automation skills only).                                                  |
| `HermesIndexSource`       | **SKIP**                        | Hermes-specific artifact (`hermes-agent.nousresearch.com`). Borrow the _schema_ later, not the source. |
| `ClawHubSource`           | **SKIP**                        | Docstring itself confirms distrust post-ClawHavoc (341 malicious skills, Feb 2026).                    |
| `LobeHubSource`           | **SKIP**                        | System-prompt templates, wrong artifact class.                                                         |
| `OptionalSkillSource`     | **SKIP**                        | Hermes-bundled official skills (not a remote source).                                                  |

## Architecture

```
 GET /api/skills/search?q=<query>
        │
        ▼
 SkillSearchRouter.search(q)
        │
        │ Promise.all(sources.map(s => race(s.search(q), timeout)))   ← per-source timeout
        │   • marketplace source → SkillCatalogService.getCatalog (7.2, cached)
        │   • github source      → GitHub trees API (per-tap, tree-cached 1h)
        │   • well-known source  → GET <host>/.well-known/skills/index.json
        │   • url source         → no-op (fetch-only; contributes nothing to search)
        ▼
 merge: dedupe by identifier, keep higher trust tier on collision
        │
        ▼
 { results: SkillMeta[], timedOut: string[], errored: string[] }
```

## Components (`packages/server/src/infra/source-fetchers/`)

### `github-source.ts`

- `GitHubSource { fetcher, token?, taps, logger }`. `taps` default = the 4
  `TRUSTED_REPOS` (`openai/skills`, `anthropics/skills`, `huggingface/skills`,
  `NVIDIA/skills`).
- `search(q)`: for each tap, `GET /repos/{repo}/git/trees/HEAD?recursive=1`
  (the **recursive tree API** — one call per tap, vs the naive per-directory
  walk that blows the rate limit). Collect every dir containing a `SKILL.md`,
  filter by name ⊇ q, return `SkillMeta` (identifier = `owner/repo/dir`,
  trust via `resolveTrustTier`).
- **Tree cache**: `Map<repo, {dirs, expiresAt}>`, 1h TTL. Trees change rarely.
- **Rate-limit handling**: 403/429 → log warn + return `[]` for that tap. The
  source never throws — partial results from other sources still surface.
- **Auth**: optional `GITHUB_TOKEN` (5000/hr authenticated vs 60/hr anonymous).
  Hermes's `gh auth token` subprocess + GitHub App fallbacks deliberately not
  ported — too heavy; a user with a token sets the env.
- `inspect`/`fetch` return null (7.4 ships search only; install-time fetch is
  Phase 3.3).

### `well-known-source.ts`

- `WellKnownSource { fetcher, logger }`. No auth.
- `search(q)`: only handles **URL-form queries** (`http(s)://host`). GETs
  `<origin>/.well-known/skills/index.json` → `{skills:[{name,description}]}`,
  returns `SkillMeta` (identifier `well-known:<origin>/<name>`, always
  `community`). Non-URL queries return empty (no host auto-discovery).
- `inspect`/`fetch` return null.

### `url-source.ts`

- `UrlSource { fetcher, logger }`. Single-file `SKILL.md` at a direct URL.
- `search()`: **no-op** (Hermes is too; this source is fetch-only — it has no
  catalog). It contributes when a user pastes a URL into the search box and the
  hub resolves it via `inspect` (not yet wired in the UI — Phase 3.3 territory).
- `inspect(url)`: GET url, parse YAML frontmatter for name/description.

### `marketplace-source.ts`

- `MarketplaceSource { catalog, allowlist }`. **Wraps 7.2's
  `SkillCatalogService`** — no reimplemented fetch, the catalog cache is reused.
- `search(q)`: for each allowlist entry, `catalog.listPlugins(id, url, {q})`,
  map `MarketplacePlugin` → `SkillMeta` (identifier `{marketplaceId}:{name}`,
  trust via `resolveTrustTier`). Catalog-fetch errors (502) are swallowed — a
  failed marketplace contributes nothing.

### `search-router.ts`

- `SkillSearchRouter { sources, timeoutMs, logger }`.
- `search(q, limit=50): Promise<{results, timedOut, errored}>`:
  - **Per-source timeout** via `Promise.race([s.search(q), timeout])` — a slow
    source can't block the response past `timeoutMs` (default 30s). Timed-out
    source ids go to `timedOut`; rejected ones to `errored`. **The whole search
    never throws on a source failure** (partial-results-first, matching Hermes).
  - **Merge/dedupe**: key = `identifier` (NOT `name` — browse-sh skills across
    sites share task names). On collision, the higher-trust entry wins
    (`TRUST_RANK = {builtin:2, trusted:1, community:0}`); within a tier,
    insertion order (source priority) is preserved.
- Decorated as `app.skillSearch` (co-located Fastify augmentation).

## Two Hermes gotchas carried over

1. **Timeout must not block.** Hermes deliberately avoids Python's
   `with ThreadPoolExecutor(...)` because its `__exit__` calls
   `shutdown(wait=True)`, making the overall timeout a no-op. The JS equivalent
   of its `shutdown(wait=False, cancel_futures=True)` is `Promise.race` + a
   per-source timeout promise — a plain `await Promise.all(...)` would let a
   slow source block past the budget. The in-flight promises settle in the
   background after the timeout; their results are discarded.
2. **Dedupe by identifier, not name.** Same skill name from two sources (or two
   repos) are distinct results. The collision rule keeps the higher-trust copy.

## Config (4 new env keys)

| Env                       | Default                                                            | Purpose                                            |
| ------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `GITHUB_TOKEN`            | unset                                                              | optional PAT for `GitHubSource` (5000/hr vs 60/hr) |
| `SKILL_GITHUB_TAPS`       | `openai/skills,anthropics/skills,huggingface/skills,NVIDIA/skills` | comma-separated `owner/repo` taps                  |
| `SKILL_SEARCH_TIMEOUT_MS` | `30000`                                                            | per-source timeout (overall budget)                |
| `SKILL_DISABLED_SOURCES`  | unset                                                              | comma-separated source ids to disable (test mode)  |

## API + SDK

- `GET /api/skills/search?q=<query>&limit=50` → `{results: SkillMeta[], timedOut: string[], errored: string[]}`. `q` required (400 if absent). Browsing without a query stays on 7.2's `/api/skills/marketplaces/:id/plugins`.
- SDK: `api.searchSkills(q, limit?)`.

## Web (`/skills/hub`)

The existing hub page (7.3) gains a **dual mode**:

- **Search box empty** → 7.2/7.3 marketplace browse (marketplace Select + category Select).
- **Search box non-empty** → multi-source search. The marketplace/category Selects
  hide; the table shows results from all sources with a per-row `sourceKind`
  badge (marketplace / github / well-known / url).

Both modes project into a unified `HubRow` (key/name/description/sourceKind/
category/homepage/tier/pluginSource/hasPin) so the table and the save dialog
render one way. `pluginSource` is **precomputed by each adapter** and carried in
`SkillMeta.extra.pluginSource` — the save dialog stores it verbatim via
`skillMetaToResourceSource(meta)`, no identifier reverse-engineering.

If `timedOut.length > 0`, a `text-muted-foreground` notice appears above the
table ("Some sources timed out (…); showing partial results").

## Testing

The smoke suite verifies the search pipeline with `SKILL_DISABLED_SOURCES=
github,well-known,url` — so only the marketplace source runs against the 7.2
fixture. The `[7.4]` block asserts: `q` required (400), the marketplace result
surfaces (jfrog), every result carries `identifier` + `trustLevel`,
`extra.pluginSource` is the `plugin` variant, and `timedOut`/`errored` are
arrays. **133 passed / 0 failed.**

The per-adapter fetch logic (GitHub tree parsing, well-known index shape, URL
frontmatter) is covered by typecheck + manual verification (like 7.3's UI):
real GitHub/well-known behavior requires a `GITHUB_TOKEN` and live network,
which the smoke suite deliberately avoids.

## Runbook

Production (real multi-source search):

```bash
JWT_SECRET=… pnpm dev:server
# GITHUB_TOKEN unset → github source runs anonymous (60 req/hr); set it for 5000/hr
```

Test (marketplace-only search against a fixture):

```bash
JWT_SECRET=… STORAGE_DRIVER=memory \
  MARKETPLACE_FIXTURE_PATH=$PWD/scripts/fixtures/marketplace.json \
  SKILL_DISABLED_SOURCES=github,well-known,url \
  pnpm dev:server
```

Add a custom GitHub tap:

```bash
SKILL_GITHUB_TAPS="openai/skills,anthropics/skills,myorg/my-skills"
```

## Out of scope (deferred / skipped)

- **`fetch()` (materialize bytes)** — Phase 3.3's install writers. 7.4 adapters
  implement `search` (+ `inspect` for url); `fetch` returns null.
- **skills.sh / browse.sh adapters** — DEFER (7.5+).
- **clawhub / lobehub / hermes-index** — SKIP (verified).
- **Taps management UI/API** — env config is enough for 7.4; a CRUD surface is
  a follow-on.
- **Content scanning** — Out of Scope (AgentNexus stores references; the target
  tool executes).
- **A pre-built merged index** (the Hermes `hermes-index` pattern with
  `resolved_github_id` shortcuts). Worth revisiting if multi-source search
  proves slow against live GitHub; for now the per-tap tree cache suffices.

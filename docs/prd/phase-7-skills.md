# PRD: Phase 7 — Skill multi-source & plugin references

> Status: 7.1–7.4 implemented (✅) — Phase 7 complete. This PRD covers all four sub-phases.
> Research: `docs/research/phase-4.4-skills.md` (read it first). Technical
> design: `docs/design/phase-7.1-plugin-source.md` (7.1); 7.2–7.4 designs are
> written before each ships.

## Problem Statement

Phase 4.6 delivered **local** skills only — a user can author a skill inline
(single-file `SKILL.md`) or as a multi-file `inline-bundle` (SKILL.md +
`references/` + `scripts/`). But the vast majority of real-world skills are not
authored from scratch — they are **sourced from outside**: a Claude Code / ZCode
plugin marketplace, a GitHub repo, skills.sh, a direct URL, a vendor hub. Today
Harness Nexus has no way to store such a reference: the `ResourceSource` union has
no `plugin` variant, the skill validator (`validateSkillResource`) actively
**rejects** any non-inline source (`409 INVALID_SKILL_SOURCE`), and there is no
way to browse or search a marketplace.

Three concrete gaps:

1. **A skill reference has no home.** "This skill comes from plugin `foo` in
   marketplace `bar`, pinned to this SHA" cannot be expressed. The closest
   existing variant (`git`) loses the plugin namespace, the skill subpath
   inside the plugin, and the marketplace-entry version pin.
2. **Trust is invisible.** A skill from `anthropics/skills` and a skill from an
   unknown community repo carry the same weight in the UI. There is no trust
   tier, no provenance pin, no install-warning when a community skill lacks a
   pin. Hermes solves this (`TRUSTED_REPOS` + `lock.json` + per-install scan);
   CC/ZCode do not. Harness Nexus should adopt the trust tier + provenance model
   even though it defers the content scanner (it stores references, the target
   tool executes).
3. **There is no browse/search surface.** A user who wants a skill from the
   CC official marketplace must today leave Harness Nexus, find the plugin
   manually, and paste a spec. The "search the skill hub" feature — researched
   in `docs/research/phase-4.4-skills.md` — is unbuilt.

This phase closes all three, sequenced so the riskiest change (the server's
first outbound-network path) is isolated in its own sub-phase.

## Solution

Four sub-phases, ordered so each is independently verifiable and so the
outbound-network risk is isolated to 7.2:

1. **7.1 — plugin source + trust/provenance model (the foundation, zero
   outbound).** Add a `plugin` variant to `ResourceSource` (mirroring the CC
   marketplace source kinds). Add trust tiers (`builtin` / `trusted` /
   `community`) and an optional provenance pin (`content_hash` / `sha` /
   `version`) to the resource shape. Define a `SkillSource` port in `core`
   (abstract interface mirroring Hermes's ABC) with one no-op `inspect`
   implementation. Flip `validateSkillResource` to accept `plugin`, and flip
   the smoke test that asserts the rejection. **No outbound fetch** — the user
   pastes the spec; trust is computed from the repo owner string.
2. **7.2 — marketplace allowlist fetch (the first outbound path, isolated).**
   The server gains its first outbound HTTP: a `GET /api/skills/marketplaces/
:id/plugins` endpoint that fetches a `marketplace.json` from a configured
   allowlist (`MARKETPLACE_ALLOWLIST` env), caches it in-memory with a TTL, and
   times out. Trust is recomputed server-side from the repo owner. A marketplace
   entry can be saved as a `plugin`-source skill resource.
3. **7.3 — hub search UI.** A web page that browses a fetched marketplace
   (filter by `category`, free-text search, trust badge per entry) and a
   "save as skill resource" action that reuses 7.1's `plugin` source storage.
   Install-warning UX surfaces trust tier + a missing-pin warning.
4. **7.4 — Hermes-style multi-source (the large, least-certain block).**
   Implement the remaining `SkillSource` adapters (`skills-sh`, `well-known`,
   `url`, `github`, `claude-marketplace`, …), value-ranked. Parallel search
   with merge/dedupe (key = identifier, sort = trust rank). A `taps.json`-style
   custom-tap management UI. **Content scanning stays deferred** — Harness Nexus
   stores references; the target tool executes.

> **Why this order.** 7.1 is the data model + trust model with **no outbound
> network** — minimum risk, lands the foundation. 7.2 opens exactly one
> outbound path (allowlisted GitHub raw) so it can be reviewed in isolation
> (it is the server's first fetch ever). 7.3 is the UX closed loop on top of
> 7.2. 7.4 is the most uncertain (each adapter needs its source re-verified);
> it can stop partway — every adapter shipped is independently useful.

## Research corrections (ground-truth verified before this PRD)

The research doc `docs/research/phase-4.4-skills.md` was re-verified against the
live Hermes source (`~/.hermes/hermes-agent/tools/skills_hub.py`,
`tools/skills_guard.py`) and the live CC `marketplace.json`. Four corrections
apply and are authoritative for implementation:

1. **Hermes has 10 adapters, not 9.** `OptionalSkillSource` (`source_id =
"official"`) is the 10th; the research doc merged it into the catalog table.
   The full source-id list: `official`, `hermes-index`, `skills-sh`,
   `well-known`, `url`, `github`, `clawhub`, `claude-marketplace`, `lobehub`,
   `browse-sh`.
2. **Trust is 4 tiers internally, 3 surfaced.** Hermes's `INSTALL_POLICY` has
   `builtin` / `trusted` / `community` / `agent-created` (the 4th is
   off-by-default, gated behind `guard_agent_created`). Harness Nexus surfaces
   only the 3 user-visible tiers; `agent-created` is not modeled.
3. **The live CC `marketplace.json` has 4 source kinds and NO `npm`.** Observed
   across 257 entries: `url` (131), `git-subdir` (72), string-path (52),
   `github` (2). `npm` is a documented source kind but is **not used** in the
   official catalog — we model it in the schema but build no npm-search UI until
   there is demand. The `github` entries carry **both** `commit` and `sha`
   (treat as aliases; `sha` is the effective pin).
4. **`category` is the filter axis, not `tags` or `metadata`.** `category` is
   present on 243/257 entries (e.g. `security`, `design`, `development`,
   `database`, `monitoring`, `deployment`). `tags` appears on only 3; there is
   no `metadata` field. The hub search UI (7.3) filters on `category` + free
   text, not on `tags`.

Plus two structural facts from the research that stay authoritative:

- **Skills bundle inside plugins** (CC/ZCode) — installing a skill is
  clone-and-cache a plugin. Harness Nexus stores the **source spec**, never a live
  reference; resolution happens at install time (Phase 3.3's writer pipeline).
- **Hermes treats skills as first-class across heterogeneous sources** — the
  `SkillSource` ABC (4 abstract methods + 1 concrete default) is the mature
  multi-source pattern we mirror in 7.4.

## Sub-phase breakdown

| #       | Sub-phase                   | Status | Carries                                                                                                                                                                                                                            | Depends on | Outbound? |
| ------- | --------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------- |
| **7.1** | plugin source + trust model | 🚧     | `ResourceSource` `plugin` variant; trust tiers + provenance pin; `SkillSource` port (one no-op impl); flip `validateSkillResource` + smoke                                                                                         | Phase 4.6  | **none**  |
| **7.2** | marketplace allowlist fetch | ✅     | `GET /api/skills/marketplaces/:id/plugins` (fetch + cache + timeout); `MARKETPLACE_ALLOWLIST` config; server-side trust; "save marketplace entry as skill resource"                                                                | 7.1        | **yes**   |
| **7.3** | hub search UI               | ✅     | web marketplace browser (category filter + search + trust badge) → "save as skill resource"; install-warning UX                                                                                                                    | 7.2        | no        |
| **7.4** | Hermes-style multi-source   | ✅     | 4 adapters (github/well-known/url/marketplace); `SkillSearchRouter` (per-source timeout + identifier dedupe + trust-rank); `/api/skills/search`; hub dual-mode. skills.sh/browse.sh deferred; clawhub/lobehub/hermes-index skipped | 7.1, 7.3   | **yes**   |

Dependencies: 7.1 is the foundation (no outbound — safe to land first). 7.2
builds the single outbound path on top of 7.1's `plugin` storage. 7.3 is the
UI on 7.2's endpoint. 7.4 generalizes 7.2's single fetcher into the
`SkillSource` adapter set and is the only sub-phase that may stop partway.

## User Stories

### 7.1 — plugin source + trust/provenance model

1. As a user, I want to save a skill as a **plugin reference** (which plugin, in
   which marketplace, pinned to a SHA), so that profiles can carry a skill that
   lives in a CC/ZCode plugin.
2. As a user, I want to choose the marketplace source kind (`github` / `url` /
   `git-subdir` / `npm`) when storing a plugin reference, so that the spec
   matches how the plugin is really distributed.
3. As a user, I want the skill's **trust tier** (`builtin` / `trusted` /
   `community`) shown in the resource browser, so I can tell an
   Anthropic-shipped skill from a community one at a glance.
4. As a user, I want to optionally pin a `content_hash` / `sha` / `version`, so
   that the reference is immutable against supply-chain drift.
5. As a developer, I want a `SkillSource` port in `core` (abstract interface),
   so that 7.2's fetcher and 7.4's adapters all share one shape.
6. As a developer, I want `validateSkillResource` to accept `plugin` (instead
   of rejecting every non-inline source as `INVALID_SKILL_SOURCE`), so that
   the data model and the validator agree.

### 7.2 — marketplace allowlist fetch

7. As an admin, I want to configure which marketplaces the server may fetch
   from (an env-driven allowlist), so that outbound network stays bounded and
   auditable.
8. As a user, I want to list a marketplace's plugins via the API, so that I can
   browse without the server scraping the whole web.
9. As a user, I want fetched marketplace data cached with a TTL, so that
   repeated browses don't hammer GitHub.
10. As a user, I want a fetched marketplace entry to be saved as a skill
    resource with one action, so that I don't have to re-type the spec by hand.
11. As an operator, I want the fetch to time out cleanly, so that a slow
    upstream never blocks the server.

### 7.3 — hub search UI

12. As a user, I want a "Skill hub" page reachable from the sidebar, so that I
    can browse a marketplace without leaving Harness Nexus.
13. As a user, I want to filter by `category` and search by free text, so that
    I can narrow a long catalog.
14. As a user, I want each entry's trust tier shown as a badge, so that I can
    see provenance at a glance.
15. As a user, I want a "save as skill resource" action on an entry, so that
    it lands in my resources list as a `plugin`-source skill.
16. As a user, I want an install warning when a saved skill is `community`
    trust with no pin, so that I'm alerted to supply-chain risk before it ships
    in a profile.

### 7.4 — Hermes-style multi-source

17. As a user, I want to search across multiple sources (skills.sh, a direct
    URL, a well-known index, a GitHub repo), not just one marketplace, so that
    I find skills wherever they live.
18. As a user, I want results from different sources merged and de-duplicated,
    so that the same skill from two sources doesn't show twice.
19. As a user, I want results ranked by trust tier, so that the most-trusted
    copy is on top.
20. As a user, I want to add a custom GitHub "tap" (a repo + path), so that my
    team's private skills are searchable alongside the public ones.

## Implementation Decisions

### New `ResourceSource` variant — `plugin` (lands in 7.1)

A new variant is added (not overloading `git`), because the plugin concept
carries information `git` cannot express — the plugin namespace, the skill
subpath inside the plugin, and the marketplace-entry version pin. Mirrors the
verified CC marketplace source kinds:

```ts
| {
    type: 'plugin';
    // Mirrors marketplace.json source kinds (see research corrections: 4 live
    // kinds, no npm in the official catalog; npm modeled for completeness).
    source:
      | { source: 'github'; repo: string; ref?: string; sha?: string; path?: string }
      | { source: 'url'; url: string; ref?: string; sha?: string; path?: string }
      | { source: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
      | { source: 'npm'; package: string; version: string; registry?: string };
    // The plugin this entry resolves to (the `plugin:skill` namespace half).
    plugin: string;
    // Optional marketplace-entry version pin (falls back to sha / git commit).
    version?: string;
  }
```

### Trust model (lands in 7.1, server-side computation in 7.2)

Three user-visible tiers, mirroring Hermes's surfaced set:

- **`builtin`** — ships with the target tool (Harness Nexus does not own any
  builtin skills today; reserved).
- **`trusted`** — the 4 named repos: `openai/skills`, `anthropics/skills`,
  `huggingface/skills`, `NVIDIA/skills`. (Exact strings, ground-truth verified
  from Hermes's `TRUSTED_REPOS`; capitalization of `NVIDIA` matters.)
- **`community`** — everything else (the default).

The fourth Hermes tier (`agent-created`, off-by-default) is **not surfaced**.
Resolution: `official` source → `builtin`; repo owner in `TRUSTED_REPOS` →
`trusted`; else `community`. Stored on the resource (denormalized at save time
in 7.1 from the spec string; recomputed server-side in 7.2 when the marketplace
entry is known).

### Provenance pin (lands in 7.1)

Optional, on the resource. Any one of:

- `content_hash` — a hash of the materialized skill bytes (Hermes `lock.json`
  style). The strongest pin.
- `sha` — a git commit SHA (the effective pin for `github` / `url` /
  `git-subdir` sources).
- `version` — a semver string (npm sources, or a marketplace entry version).

A missing pin is allowed but surfaces an install warning in 7.3's UI.

### `SkillSource` port (defined in 7.1, implemented across 7.2/7.4)

Lives in `packages/core/src/ports/` (a port, not a driver — pure interface).
Mirrors Hermes's ABC ground truth: **4 abstract methods + 1 concrete default**
(`trustLevelFor` defaults to `'community'`). `search` is optional (only
multi-source adapters implement it; the single-marketplace fetcher in 7.2 does
not need it — it lists the whole catalog).

```ts
interface SkillSource {
  sourceId(): string; // 'github' | 'url' | ...
  inspect(identifier): Promise<SkillMeta | null>; // metadata only, no bytes
  fetch(identifier): Promise<SkillBundle | null>; // bytes (7.2+)
  search?(query, limit): Promise<SkillMeta[]>; // optional (7.4+)
  trustLevelFor(identifier): TrustTier; // default 'community'
}
```

7.1 ships exactly one implementation: a no-op `inspect` used to satisfy the
port shape (the real implementations arrive in 7.2 / 7.4).

### Marketplace allowlist (implemented in 7.2)

The server's first outbound path. `MARKETPLACE_ALLOWLIST` env (comma-separated
list of `name=github-owner/repo` or `name=url`); default is
`claude-plugins-official=anthropics/claude-plugins-official`. A new module set
`packages/server/src/infra/source-fetchers/` (`SkillCatalogService` + allowlist
parser + fetcher factory) performs the fetch with Node ≥20's built-in
`globalThis.fetch` (**no new HTTP dependency**), a lazy-TTL in-memory cache
(default 1 h, expired-on-read with per-key in-flight dedup mirroring
`McpRegistry.reloadPromise`), and a per-fetch timeout (default 10 s). Routes
`GET /api/skills/marketplaces` + `GET /api/skills/marketplaces/:id/plugins`
return the cached, parsed, filtered catalog. Full design:
`docs/design/phase-7.2-marketplace-fetch.md`.

### Hub search UI (implemented in 7.3)

New nav item **"Skill hub"** (`/skills/hub`). Filters: `category` Select (the
verified filter axis) + free-text search over name/description. Each entry
shows a trust badge — **neutral** Badge variants (`default` for `trusted`,
`secondary` for `community`); `--signal` is deliberately NOT used (reserved for
liveness per the Signal design system). Trust is computed client-side for
display via `resolveTrustTier`; the server recomputes authoritatively at save
time. "Save as skill resource" opens a lightweight inline dialog (key/scope/
targets) and creates a `plugin`-source skill via the existing `/api/resources`
endpoint. If the entry lacks a `sha`/`version` pin and is `community` trust, a
`text-warn` callout appears. Full design: `docs/design/phase-7.3-hub-ui.md`.

### Multi-source adapters (implemented in 7.4)

Four adapters ship (`packages/server/src/infra/source-fetchers/`): `GitHubSource`
(recursive-tree API per tap, 1h tree cache, optional `GITHUB_TOKEN`, rate-limit
→ empty), `WellKnownSource` (`/.well-known/skills/index.json`, URL-query only),
`UrlSource` (fetch-only, `search` no-op), and `MarketplaceSource` (wraps 7.2's
`SkillCatalogService`, reusing its cache). Parallel dispatch via
`SkillSearchRouter` with a **per-source timeout** (`Promise.race`, 30s default)
— a slow source can't block the response (partial-results-first). Merge/dedupe:
key = `identifier`, keep highest trust rank, then preserve insertion order.
`GET /api/skills/search?q=` exposes it; the hub page runs in dual-mode
(marketplace browse when the search box is empty, multi-source search when it
has text). **Verified scope**: skills.sh / browse.sh **deferred** (7.5+);
clawhub / lobehub / hermes-index **skipped** (distrusted post-ClawHavoc, wrong
artifact class, or Hermes-specific). Content scanning is **deferred**
(Harness Nexus stores references; the target tool executes). Full design:
`docs/design/phase-7.4-multi-source.md`.

## Cross-phase dependencies

- **Install wiring ↔ Phase 3.3.** A `plugin`-source skill is only _installed_
  when the Phase 3.3 writer emits a plugin directory. 7.1–7.4 store and browse
  the reference; they do not materialize it. Each sub-phase is independently
  useful (management without install), matching how Phase 4 shipped before
  Phase 3.
- **Profile entry selection.** Profiles already reference resources by
  `kind:key`; a saved `plugin`-source skill becomes referenceable the moment it
  is created. A resource picker in the profile editor is a natural follow-on
  (not required for 7.x to deliver value).
- **Hermes writer ↔ Phase 3.5.** 7.4's `SkillSource` adapters are the
  discovery layer; the actual emission into Hermes's skill format is Phase 3.5's
  writer. The two are decoupled — discovery ships in 7.4, emission in 3.5.

## Testing Decisions

- **7.1:** flip the existing `INVALID_SKILL_SOURCE` smoke block
  (`scripts/smoke.mjs:593-606`) to a positive create-and-verify flow (a
  `plugin`-source skill returns 201). Add a trust-tier assertion (a
  `anthropics/skills` repo → `trusted`; an unknown repo → `community`). The
  storage layer is variant-agnostic (JSON round-trip), so no driver test churn.
- **7.2:** a smoke block for the marketplace fetch endpoint using a fixture
  `marketplace.json` served from the test (no live GitHub dependency in CI —
  the fetcher is injectable). Assert caching (second call hits cache), timeout
  behavior (slow upstream → 504), and allowlist rejection (non-allowlisted
  marketplace → 404).
- **7.3:** frontend; the backend is covered by 7.2's smoke. Manual UX review
  against the Signal design system.
- **7.4:** per-adapter smoke (each adapter fetches a fixture); merge/dedupe
  test (two sources return the same `identifier` → one result, highest trust
  kept); ranking test (order = trust rank then insertion order).

## Out of Scope

- **Content security scanning** (Hermes's `skills_guard.py` model — regex
  threat DB, quarantine, verdict × tier gate). Harness Nexus stores references;
  the target tool executes. Re-evaluate if we ever materialize/execute skill
  bytes.
- **`npm` source search.** The official CC catalog has no npm entries; we model
  it in the schema but build no search UI until there is demand.
- **Full Hermes `parallel_search_sources` + merged index for 7.1–7.3.** Only
  7.4 implements parallel multi-source search; 7.1–7.3 are single-marketplace.
- **The `hermes-index` pre-built merged index adapter.** Hermes uses it to skip
  ~70 API calls; Harness Nexus's single-marketplace browse (7.2) does not need it.
  Re-evaluate if 7.4's multi-source search proves slow.
- **Private npm registry / private GitHub credentials.** Reuse the `${cred:NAME}`
  model from Phase 2.1 when there is demand.
- **Actual install materialization.** Phase 3.3's writer pipeline owns this;
  7.x only stores and browses the reference.
- **The Hermes 4th trust tier (`agent-created`).** Off-by-default in Hermes;
  not surfaced in Harness Nexus.

## Further Notes

- The research doc's recommendation to add a `plugin` variant (rather than
  reuse `git`) is preserved — the plugin namespace, the source-kind
  distinctions (`git-subdir` = sparse clone ≠ `github`/`url` = full clone), and
  the marketplace-entry version pin all matter for install correctness.
- The `ResourceSource` blast radius is small (verified): storage is
  variant-agnostic (SQLite `JSON.stringify`/`JSON.parse`; memory is a direct
  `Map`), the SDK is pass-through, and `serialize.resourceView` is an identity
  function. The 7.1 type change touches 4 code spots + 1 inverted smoke
  assertion; see the design doc for the exact edit map.
- Technical design (the `plugin` variant shape, the trust tier resolution, the
  `SkillSource` port, the `validateSkillResource` flip, the marketplace
  allowlist + fetcher module) lives in `docs/design/phase-7.1-plugin-source.md`
  (7.1) and will be written per-sub-phase for 7.2–7.4 before each ships.

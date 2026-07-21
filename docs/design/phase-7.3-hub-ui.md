# Design: Phase 7.3 — Skill hub search UI

> Status: implemented in Phase 7.3 (✅). PRD: `docs/prd/phase-7-skills.md` §7.3.
> Prior designs: `phase-7.1-plugin-source.md` (storage) +
> `phase-7.2-marketplace-fetch.md` (browse backend). This is the UX closed loop.

The browse surface for 7.2's marketplace catalog. A user opens `/skills/hub`,
picks a marketplace, filters by category / free text, sees each plugin's trust
tier, and saves an entry as a `plugin`-source skill resource (the 7.1 variant)
— which then appears in `/resources` and can be referenced from a profile via
`skill:<name>`.

## Architecture

```
 /skills/hub (SkillHubPage)
    │
    │  mount → api.listMarketplaces()           [once, from 7.2 allowlist]
    │  selectedMkt/category/q change
    │     → api.listMarketplacePlugins(id, {category, q})   [7.2, server cached]
    ▼
 <Table>
   row: Name + description | Category badge | Source kind (mono) | Trust | [Save as skill]
                                                                                    │
                              client-side resolveTrustTier(plugin.source)          │
                                                                                     ▼
                                                                         <SavePluginDialog>
                                                                           key/scope/targets
                                                                           + warn callout
                                                                           (community & no pin)
                                                                                     │
                                                                 api.createResource({kind:'skill', source, ...})
                                                                                     ▼
                                                                            /resources row (kind=skill)
```

No new backend. The page consumes 7.2's two endpoints + 7.1's `POST /api/resources`.

## Page structure (`apps/web/src/pages/SkillHub.tsx`)

Mirrors the `ResourcesPage` / `ProfilesPage` shape (AppShell wrapper + Card +
filter bar + Table). Three module-scope sub-components (defined at module
scope, never inline — per the React perf rule in AGENTS.md):

- **`SkillHubPage`** — owns state: `marketplaces`, `selectedMkt`, `category`,
  `q`, `items`, `saving`. Two `useEffect`s: one loads the allowlist on mount
  (auto-selecting the first), the other refetches plugins when
  selectedMkt/category/q change (Pattern B from Resources). Filter state is
  `useState`, not URL params (matches every existing page).
- **`PluginRow`** — one catalog row. Trust computed via
  `resolveTrustTier(plugin.source)` (client-side; the server recomputes
  authoritatively at save time via `withTrustLabels`).
- **`TrustBadge`** — neutral-variant badge (see Decision 1 below).
- **`SavePluginDialog`** — the lightweight save form (see Decision 2).

## Three design decisions (recorded for future contributors)

### 1. Trust badge uses neutral variants, NOT `--signal`

The Signal design system (AGENTS.md "Web UI design system") reserves `--signal`
(cyan) for liveness — "Spend that accent in one place per view; do not sprinkle
it as decoration." A trust tier is not a liveness concept, so the badge uses
the same neutral pattern as the scope badge on every other page:

- **trusted** → `Badge variant="default"` (ink/primary) + `ShieldCheckIcon`
- **community** → `Badge variant="secondary"` (muted surface) + a small gray dot

This is a deliberate choice over `bg-signal text-signal-foreground` (which is
technically available). The PRD's earlier "signal accent for trusted" wording
is superseded by this decision — recorded here so the next contributor doesn't
"fix" it toward cyan.

### 2. Save UX is an inline dialog, not the Resources editor

Each row has a "Save as skill" button that opens a small `SavePluginDialog`
asking only for `key` / `scope` / `targets`. The `source`, `name`,
`description` come from the marketplace entry (converted via
`marketplacePluginToResourceSource`). This deliberately does **not** route
through the `ResourceEditor` on `/resources`:

- The `ResourceEditor` is built for inline authoring (markdown body, bundle
  files) — none of which applies to a `plugin` source (there's no body).
- Routing through it would require extending its `computedSource` with a
  `plugin` branch + accepting prefilled inputs — larger surface area for a
  worse fit.
- The inline dialog keeps the hub self-contained: browse → save → done,
  without a context switch.

The existing `ResourceEditor` therefore still emits only `inline` /
`inline-bundle`; `plugin`-source skills are created exclusively via the hub
(data model allows them everywhere; the editor just doesn't produce them).

### 3. Trust is computed client-side for display, server-side for storage

`MarketplacePlugin` has no `trust` field (7.2's catalog schema doesn't carry
it). Rather than add it to the 7.2 endpoint response (which would change a
shipped shape), the page imports `resolveTrustTier` from `@agent-nexus/sdk`
(re-exported from `@agent-nexus/shared`) and computes the tier for display from
the plugin's `source`. The same function runs server-side in `withTrustLabels`
at save time, so the displayed badge and the stored `labels.trust` agree.

## The marketplace → resource-source conversion

`packages/shared/src/schemas/marketplace.ts` exports
`marketplacePluginToResourceSource(plugin, pluginName?)`:
`MarketplacePlugin` → `PluginResourceSource` (the `ResourceSource.plugin`
shape, mirrored in shared because shared can't import core — same layering
pattern as `TrustTier`). The one wrinkle: the marketplace `github` source
carries `commit` AND `sha` (aliases per research); the storage shape only has
`sha`, so `commit` folds into `sha` when `sha` is absent. `git-subdir` / `url`
map 1:1. `npm` is in the storage union but never produced here (the live
catalog has no npm entries).

## Install-warning UX

`SavePluginDialog` shows a `text-warn` callout at the top when the source is
`community` trust AND has no pin (`sha` absent and `version` absent). This is
the supply-chain drift warning from the PRD — a floating community reference
tracks upstream HEAD, which is a risk surface. The callout uses
`TriangleAlertIcon` + `border-warn/40 bg-warn/10`, matching the warn pattern
in `guards.tsx`. Pinned entries (sha or version present) and trusted entries
show no callout.

## Wiring

- **Route** (`App.tsx`): `<Route path="/skills/hub" element={<RequireAuth>
<SkillHubPage/></RequireAuth>} />` — any authenticated user may browse (the
  marketplace is a public catalog; saving still respects the normal resource
  scope rules).
- **Nav** (`app-shell.tsx`): one entry in `navItems()` after `/resources`:
  `{ to: '/skills/hub', icon: <StoreIcon/>, label: 'Skill hub' }`. The mobile
  drawer reuses the same array, so one addition covers both surfaces.
- **SDK**: no new SDK methods (7.2's `listMarketplaces` /
  `listMarketplacePlugins` + 7.1's `createResource` cover it). The page
  imports `resolveTrustTier` / `marketplacePluginToResourceSource` /
  `TrustTier` re-exported through `@agent-nexus/sdk`.

## Testing

7.3 is pure frontend. The backend (7.2 fetch + 7.1 plugin source) is covered
by the smoke suite (121 passed, 0 failed — unchanged in 7.3). For the UI, the
manual acceptance flow:

1. Register (first user → admin), land on dashboard.
2. Click "Skill hub" in the sidebar → marketplace loads.
3. Verify the 4 object-source plugins show (the 2 string-source entries are
   filtered by the catalog service).
4. `category=security` → 2 rows; `q=artifact` → 1 row (jfrog).
5. Click "Save as skill" on jfrog → dialog with `key=skill:jfrog`, targets,
   scope. (No warn callout — jfrog has a sha.)
6. Save → success toast → the row appears on `/resources` as `kind=skill`.

All verified green on a memory + fixture server.

## Out of scope (deferred to 7.4 / later)

- **Multi-source search** (skills.sh, direct URL, custom taps alongside the
  marketplace) — Phase 7.4. 7.3 browses one marketplace catalog at a time.
- **The `ResourceEditor` gaining a `plugin` branch** — not needed; the hub is
  the plugin-source entry point. If inline editing of a plugin source later
  makes sense, extend `computedSource` then.
- **URL-param filter persistence** — no existing page does this; 7.3 matches.
- **Content scanning / private marketplace credentials** — Out of Scope.

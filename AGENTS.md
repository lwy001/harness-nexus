# AGENTS.md — Harness Nexus workspace guide

This file orients future ZCode (and Claude Code) agents working in this repo.
Read it before making changes. The repo is a **skeleton** as of this writing —
most logic is TODO; respect the layering below while filling it in.

## What this project is

**Harness Nexus** (`harnessnexus`, npm scope `@harness-nexus/*`) is a unified management
platform for Agent-tool assets (Claude Code, ZCode, Hermes) across machines. Four
pillars:

1. **MCP proxy** — consume upstream MCP servers once, re-expose one aggregated
   server to every tool. (`packages/server/src/mcp/`)
2. **Resources & profiles** — versioned skills/hooks/sub-agents/rules/MCP defs,
   bundled into installable profiles. (`packages/core/src/domain/`)
3. **Third-party harness import** — ECC / Superpower release packages folded into
   profiles. (CLI adapters, TODO)
4. **Users, roles, PATs** — global vs. personal scoping + personal access tokens.
   (`packages/core/src/domain/user.ts`)

> The directory is still named `mcp-proxy` for historical reasons; the project
> name is `harnessnexus`. Don't be confused by the path.

## Stack

Node.js ≥20 · TypeScript (strict) · Fastify · pnpm workspaces · zod ·
SQLite (`better-sqlite3`, default; pluggable) · official `@modelcontextprotocol/sdk` ·
React + Vite (web).

## Repository layout

```
packages/
  core/        domain entities + repository PORTS (pure TS — NO I/O, NO frameworks)
  shared/      zod schemas + utils — single source of truth for manifest shapes
  server/      Fastify API + MCP proxy + storage DRIVERS (sqlite/memory)
  sdk-ts/      HTTP client SDK
  cli/         `hnx` one-click install tool (must run WITHOUT the server)
  acp-bridge/  local ACP <-> Harness Nexus daemon (roadmap)
apps/web/      React + TS + Vite admin UI
docs/          architecture.md, mcp-proxy.md, profiles.md, roadmap.md, adr/
```

## Architecture rules (enforced — a regression if violated)

1. **`packages/core` stays pure.** Only domain types and repository _interfaces_
   (ports). Never import Fastify, the MCP SDK, `better-sqlite3`, or any storage
   driver here. Concrete repository implementations live ONLY under
   `packages/server/src/infra/storage/*`.
2. **Dependencies flow one way.** `server`, `cli`, `sdk-ts`, `acp-bridge`, `web`
   may depend on `core`/`shared`. `core` depends on nothing in this repo.
3. **Storage is pluggable via `UnitOfWork`** (`core/src/ports/repository.ts`).
   Adding a backend = new folder under `server/src/infra/storage/`, implement all
   five repositories, add a case in `server/src/infra/storage/factory.ts`. Nothing
   else changes. The in-memory driver (`memory/index.ts`) is the reference shape.
4. **MCP transport is decoupled from REST routes.** Keep aggregation in
   `server/src/mcp/` (registry, TODO) so the same registry can serve stdio, SSE,
   and streamable-http. Do not push MCP logic into route handlers.
5. **Manifest schemas live in `packages/shared`.** Server, web, and CLI must all
   validate via those zod schemas — keep them in sync with `core` domain types.
6. **The CLI must run standalone.** `packages/cli` can talk to a server via the
   SDK, but the common `install` path must work from a local manifest with no
   server running. Don't couple it to server availability.

## Common commands

The repo uses [Task](https://taskfile.dev) as a convenience wrapper around pnpm.
Either form works.

```bash
pnpm install                 # first-time setup
task dev          | pnpm dev               # all packages, watch mode (parallel)
task dev:server   | pnpm --filter @harness-nexus/server run dev   # API on :8080
task dev:web      | pnpm --filter @harness-nexus/web run dev      # UI on :5173
task build        | pnpm -r run build
task test         | pnpm -r run test
task typecheck    | pnpm -r run typecheck
task lint         | pnpm -r run lint
task format       | pnpm format
task clean        | pnpm clean
```

Run a single package by filter, e.g. `pnpm --filter @harness-nexus/core run build`.

To boot the server without SQLite set up: `STORAGE_DRIVER=memory pnpm dev:server`.

## Coding conventions

- **TypeScript strict**, ESM (`"type": "module"`), `moduleResolution: "Bundler"`,
  `verbatimModuleSyntax: true`. Shared flags in `tsconfig.base.json`.
- **Use `import type` for type-only imports** (required by `verbatimModuleSyntax`).
- **Relative imports inside a package use `.js` extensions** (e.g.
  `./domain/user.js`) — ESM output expects them even for TS sources.
- **Cross-package imports use the scoped name**, e.g.
  `import type { Resource } from '@harness-nexus/core'`.
- **Ports vs. implementations**: define interfaces in `core/src/ports/`,
  implement them in `server/src/infra/`. Route modules depend on the interface,
  never a concrete driver.
- **Errors**: throw `AppError` from `@harness-nexus/shared` for expected failures;
  Fastify maps `statusCode`/`code` to the response.
- **Formatting**: Prettier (single quotes, trailing comma `all`, 100 cols). Run
  `pnpm format` before committing.
- **Config from env**, with defaults, in `packages/server/src/config.ts`. Don't
  read `process.env` ad hoc inside modules.
- **Logging**: use the Fastify logger (`app.log` / `req.log`), not `console.*`
  (the CLI/bridge daemons may use `console` until they get a logger).

## Web UI design system ("Signal")

The `apps/web` UI follows a deliberate system, not stock shadcn defaults. Read
this before adding screens or components so the look stays consistent.

- **Concept.** The interface is a _signal console_. Color encodes connection
  state only; everything else is a disciplined cool neutral. The single accent
  — `--signal` (cyan) — marks what is live: links, focus, the brand mark, and
  (once Phase 2.2 ships) online connections. Spend that accent in one place per
  view; do not sprinkle it as decoration.
- **Tokens live in `apps/web/src/index.css`.** Light + dark are both defined;
  `color-scheme` is set per theme. Do not hardcode hex in components — derive
  from the CSS variables (`bg-background`, `text-signal`, etc.). The semantic
  palette maps through the `chart-*` tokens: `--signal`, `--ok`, `--warn`,
  `--danger` are the only colors that carry meaning.
- **Typography.** IBM Plex Sans (UI + body) and IBM Plex Mono (URLs, headers,
  tokens, transport types, all numeric data) are **self-hosted via Fontsource**
  — never load external font CDNs; this product handles secrets and makes no
  outbound requests for assets. Use the `.nums` helper or `tabular-nums` for any
  column of figures or monospaced protocol strings.
- **Brand.** The mark, wordmark, and favicon are inline SVG (`components/
brand-mark.tsx`, `public/favicon.svg`) encoding the thesis (upstreams
  converging on a nexus node). Reuse `<Brand>`; don't introduce a raster logo.
- **Honesty over decoration.** The Dashboard mesh topology (`components/
mesh-topology.tsx`) renders upstreams as "configured" (muted), **never** a
  green "online" dot — live aggregation is Phase 2.2 and faking status would
  mislead. When 2.2 lands, swap the `Dot` variant per real state; the geometry
  already supports it.
- **Chrome.** `AppShell` provides the sidebar + header and a skip link to
  `#main`. The mobile nav is a Radix `Dialog` drawer (`components/mobile-nav.tsx`)
  that mirrors the same `navItems()`. Add new routes to `navItems()` in
  `app-shell.tsx` so both surfaces stay in sync.
- **Theme.** Defaults to the OS preference (`system`), user-overridable via the
  header toggle. The toggle keys off `resolvedTheme` so the icon is correct even
  while following the system.
- **Form hygiene (Web Interface Guidelines).** Every text input sets
  `autoComplete`, and protocol/identifier inputs also set `spellCheck={false}`
  and `inputMode` where applicable. Destructive actions confirm first. Headings
  keep a strict hierarchy and get `text-wrap: balance` from the base layer.
- **Frontend perf (Vercel React best practices).** Fetch independent lists with
  `Promise.all` (see `Dashboard.tsx`). Define sub-components at module scope,
  never inside another component. Prefer functional `setState`. Render
  conditionals with ternaries, not `&&`. Hoist static objects/JSX out of
  components.

## Feature development workflow

When building a new feature pillar (one spanning multiple packages and
introducing new domain concepts), follow this loop:

1. **Design doc first.** Write or expand a `docs/design/phase-N-<topic>.md`
   covering the data model, API surface, scope/permission rules, and explicit
   out-of-scope items (title with phase, `> Status:` line, sectioned). Commit it
   before the implementation. See `docs/README.md` for the doc-type split
   (prd / design / research / adr).
2. **Then implement.** Work inward from the dependency boundary: `core` (domain
   types + ports) → `shared` (zod schemas) → `server` (storage + routes) →
   `sdk-ts` (client methods) → `apps/web` (UI). Build each package before moving
   to the one that depends on it (composite project references need `dist`).
3. **Then verify.** `pnpm -r typecheck`, the relevant `pnpm --filter … build`,
   and extend `scripts/smoke.mjs` for the new endpoints.
4. **Update this file and the roadmap** so the next contributor knows what
   landed and where the docs live.

## Sensitive areas — read docs first

Before touching these, read the linked design doc (`docs/README.md` indexes all):

- **Authentication & roles** → `docs/design/phase-1-auth.md`
- **MCP connections & credentials** → `docs/design/phase-2.1-credentials.md`
- **MCP registry, proxy & profiles** → `docs/design/phase-2.2-registry.md`
- **callable-function scripts (research)** → `docs/research/phase-2.3-sandbox.md`
- **Profile concept & install flow** → `docs/design/profiles.md`
- **Layering & storage contract** → `docs/architecture.md`
- **Stack rationale** → `docs/adr/0001-initial-stack.md`

## MCP management & credentials (Phase 2.1)

Full design in `docs/design/phase-2.1-credentials.md`. Summary for daily work:

- **Credential ≠ PAT.** A `PersonalAccessToken` authenticates a user _into_
  Harness Nexus. A `Credential` authenticates Harness Nexus _out to_ an upstream MCP
  server. Don't conflate them.
- **A credential is a pure named secret** (`{ name, secret, scope }`) — no `kind`.
  The name is the handle used in `${cred:NAME}` placeholders.
- **Credential secrets are AES-256-GCM encrypted at rest**
  (`packages/server/src/infra/crypto.ts`). Key material:
  `CREDENTIAL_ENCRYPTION_KEY` env var, falling back to `JWT_SECRET`. The
  plaintext is **never** returned by the API — responses carry a masked
  `secretPreview` only. Decryption happens solely at resolve time.
- **Credential injection is by placeholder, not bindings.** A credential's
  secret is referenced by name as `${cred:NAME}` inside any transport string
  field (url, command, args, env values, header values). The
  `resolvePlaceholders` helper (`packages/shared/src/utils/placeholders.ts`)
  scans and substitutes at resolve time — proxy mode at connect time (2.2),
  direct mode at install time (3.3). There is no `credentialBindings` map.
- **MCP mode (`proxy` | `direct`)** (Phase 3.1): `proxy` — Harness Nexus dials;
  SSE/HTTP only. `direct` — the tool dials; SSE/HTTP/stdio. stdio forces
  `direct` (`409 STDIO_REQUIRES_DIRECT`). The registry only pools `proxy` rows.
- **Scope model (same for credentials and mcp-servers):** `global` is readable
  by any authenticated user but admin-only to mutate; `personal` is owner-only
  for all operations. The instance-level `requireAuth`/`requireAdmin` guards are
  the first gate; per-record ownership checks (owner-or-admin) layer on top.
  Not-found returns `404` (not `403`) to avoid leaking existence.
- **Profiles** (`docs/design/phase-2.2-registry.md`) bundle MCP servers; an agent
  tool connects via `?profile=<id>` and sees only that profile's aggregated tools.

## MCP registry, proxy & profiles (Phase 2.2)

Full design in `docs/design/phase-2.2-registry.md`. Summary for daily work:

- **`McpRegistry`** (`packages/server/src/mcp/registry.ts`) owns a pool of live
  `Client` connections to every `proxied: true` upstream. It is built in
  `mountMcpProxy` and decorated on the instance as `app.mcpRegistry`.
  `reload()` re-reads the config and reconciles the pool; the mcp-servers route
  handlers call it fire-and-forget after any mutation.
- **Aggregation is namespaced.** Tools surface as `<server-name>__<tool-name>`
  (double underscore) to avoid collisions; `callTool` splits the namespace and
  routes to the owning client. Unreachable upstreams are marked `error` and
  skipped — they never block startup or tool listing.
- **`${cred:NAME}` placeholders are resolved at connect time**, not at config
  time. The registry calls `resolvePlaceholders` with a name→plaintext lookup
  (which decrypts via the instance's `credentialEncryptionKey`) to substitute
  placeholders in header values and the URL when dialing a proxy upstream.
- **Proxy mounts** (`packages/server/src/mcp/proxy.ts`): Streamable HTTP at
  `/mcp` and legacy SSE at `/mcp/sse` + `/mcp/sse/messages`. Both are PAT-gated
  via a `preHandler` (the root `onRequest` hook sets `req.user`) and require a
  `?profile=<id>` visible to the caller. Raw Node streams are handed to the SDK
  transport via `reply.hijack()`.
- **Profile routing is explicit.** `/mcp?profile=<id>` exposes only the MCP
  servers in that profile's entries (`kind === 'mcp'`, `resourceId` =
  `McpServer.id` in 2.2). A profile entry the caller can't see →
  `403 PROFILE_ENTRY_NOT_ACCESSIBLE`.
- **Status endpoint** `GET /api/mcp-servers/status` returns live
  `{ id, status, toolCount }[]` (`connecting | connected | error | disconnected`)
  from the registry; it drives the Dashboard mesh dots (`online` → `bg-ok`) and
  the MCP Management row status/tool-count badges (2.4).
- **Name clash:** the SDK's `McpServer` class is imported as `SdkMcpServer` in
  `proxy.ts` to avoid colliding with the domain `McpServer` interface.
- **Not yet built (2.3+):** callable-function scripts, the stdio bridge entry,
  per-PAT profile binding, tool-level authorization.

## proxy MCP connect & tool inspection (Phase 2.4)

Full design in `docs/design/phase-2.4-connect-tools.md`. Summary for daily work:

- **Incremental connect semantics.** Phase 2.2's startup auto-pooling is
  unchanged and `/mcp` aggregation is untouched. 2.4 adds an operator control
  surface on top of the existing pool — it does NOT make connect lazy.
- **4 public registry methods** (`McpRegistry`): `connectServer(id)` (force a
  re-dial — the main use is reconnecting a server stuck at `error` after a
  credential/config fix, since `reload()` is fire-and-forget),
  `disconnectServer(id)` (drops a live connection but KEEPS the pool entry as
  `disconnected` so the next unrelated `reload()` doesn't silently re-add it),
  `listServerTools(id)` (cached tool list in ORIGINAL, un-namespaced names —
  distinct from the namespaced `listTools()` the proxy uses),
  `refreshServerTools(id)` (re-pull). `connectServer` re-reads the latest config
  from the store so edits since startup are honored.
- **`McpServerStatus` gained `toolCount`** (additive; the Dashboard ignores it,
  the management row badge reads it). `McpServerStatus` is defined in BOTH the
  registry and the SDK (`packages/sdk-ts`) — keep them in sync.
- **4 routes** (`modules/mcp-servers.ts`): `POST :id/connect`, `:id/disconnect`,
  `GET :id/tools`, `POST :id/tools/refresh`. proxy-only (direct →
  `409 NOT_PROXY_MODE`); reuse `requireAuth` + `ownsOrAdmin` 404-leak-prevention.
  Registry errors are `RegistryError` (registry-local, `kind: not_found |
not_proxy | not_connected`) mapped to HTTP by `mapRegistryError` in the route —
  the registry stays free of HTTP concerns (architecture rule #4).
- **`McpToolInfo`** lives in `packages/shared` (NOT `core` — tool inspection is a
  runtime/transient shape read from the pool, not a persisted domain entity).
- **Connect is best-effort.** `connectServer` resolves with the resulting status
  (possibly `error` + `detail`) rather than throwing on upstream failure; only
  config-level problems (deleted / switched to direct) throw.
- **Web** (`apps/web/src/pages/McpManagement.tsx`): statuses polled on a 5s
  `setInterval` (cleared on unmount); row status badge uses state-encoded colors
  per the Signal system (`connected`→`bg-ok`, `error`→`bg-danger`, `connecting`→
  `bg-warn`, `disconnected`→muted — `--signal` is NOT used); connected rows show
  a tool-count badge + expand into a `Collapsible` tool panel (per-tool
  `inputSchema` params + Refresh). Direct rows show a neutral hint, no controls.
  Sub-components live at module scope (React perf rule).

## Resource management (Phase 4.2–4.3)

Full design in `docs/design/phase-4-web-ui.md`. Summary for daily work:

- **The shared Resource backend is built** (Phase 4.2): a single `resources`
  table with a `kind` discriminator, real `ResourceRepository` impls in both
  SQLite and memory drivers (the old `memoryResourceStub` is deleted), and
  `/api/resources` CRUD. Scope model is identical to credentials & mcp-servers
  (global admin-mutate, personal owner-only, 404 not-found to avoid leaking
  existence).
- **Kind availability is gated by a route-layer allowlist**
  (`AVAILABLE_KINDS` in `packages/server/src/modules/resources.ts`), NOT the zod
  schema. The schema is kind-agnostic on purpose. `sub_agent`, `rule`,
  `command`, `hook`, and `skill` all ship; only `mcp` returns `409
KIND_NOT_AVAILABLE` (MCP servers are managed separately via `/api/mcp-servers`).
  **To enable a new kind, add it to the allowlist** — no schema/storage change
  needed.
- **`kind` and `scope` are immutable post-create** (PATCH → `409
RESOURCE_IMMUTABLE`); mutate-by-recreate instead.
- **`key` uniqueness is per (key, scope, owner)**, enforced read-then-write in
  the route (`409 RESOURCE_KEY_TAKEN`), not a DB constraint (avoids a composite
  unique index over nullable `owner_id`). The `key` is the `kind:key` handle
  profiles reference.
- **Sub-agent/rule editors produce `source: { type: 'inline', content }`**
  (markdown) only. `command` (4.4) and `hook` (4.5) are also single-file
  inline. **`skill` (4.6) added the `inline-bundle` `ResourceSource` variant**
  for multi-file skills (SKILL.md + `references/` + `scripts/`; ~42% of real
  skills are multi-file) — single-file skills reuse `inline`. A bundle must
  contain `SKILL.md` at root (`409 SKILL_BUNDLE_MISSING_SKILL_MD`) and paths are
  validated for traversal safety (`400`). The external git/tarball/local variants
  are accepted by the schema but not exercised by an editor.
- **`skill` plugin source (Phase 7.1)** — a sixth `ResourceSource` variant
  `{ type: 'plugin', source, plugin, version? }` mirrors the CC marketplace
  `source` kinds (github/url/git-subdir/npm). `validateSkillResource` accepts
  `inline`/`inline-bundle`/`plugin` and still rejects `git`/`tarball`/`local`
  for skills (`409 INVALID_SKILL_SOURCE` — `plugin` is the correct external-skill
  representation; it preserves the plugin namespace). Trust/provenance ride on
  the existing `labels` field (no migration): `resolveTrustTier` (in
  `packages/shared/src/trust.ts`) stamps `labels.trust` = `builtin`/`trusted`/
  `community` (the 4 `TRUSTED_REPOS` ⇒ `trusted`), plus `labels.pin` (sha/version)
  and `labels.provenance`. A `SkillSource` port (`packages/core/src/ports/
skill-source.ts`, mirroring Hermes's ABC) shapes future adapters — 7.1 ships
  one no-op impl; real fetchers are 7.2+.
- **Hooks (4.5)** store a `hooks.json` document in `source.inline.content`
  (event→command map). The **event × target support matrix** lives in
  `packages/shared/src/hooks.ts` (`HOOK_EVENTS`, `HOOK_SUPPORT`). Hermes is
  `null` in the matrix (different hook model — Python plugins); a hook targeting
  Hermes is rejected (`409 TARGET_NO_DECLARATIVE_HOOKS`). An event unsupported by
  any declared target is rejected (`409 HOOK_EVENT_UNSUPPORTED`). The web editor
  offers only events supported by the chosen targets. **To add an event or
  target**, edit the matrix — no other change needed.

## Marketplace fetch (Phase 7.2)

Full design in `docs/design/phase-7.2-marketplace-fetch.md`. Summary for daily
work:

- **This is the server's ONLY outbound HTTP path.** All marketplace browsing
  goes through one allowlisted fetch surface; no other module may make
  outbound requests. Bounded by `MARKETPLACE_ALLOWLIST` (which catalogs) and a
  per-fetch timeout (how long).
- **`SkillCatalogService`** (`packages/server/src/infra/source-fetchers/
catalog-service.ts`) owns a lazy-TTL cache (`Map<id, {catalog, expiresAt}>`,
  expired-on-read; no `setTimeout`) and a per-key in-flight dedup (mirrors
  `McpRegistry.reloadPromise`). It fetches via an injectable `MarketplaceFetcher`
  (default `globalThis.fetch`; fixture reader when `MARKETPLACE_FIXTURE_PATH`
  is set for tests). Decorated on the instance as `app.skillCatalog`.
- **Allowlist** (`app.marketplaceAllowlist: MarketplaceEntry[]`) is parsed at
  boot from `MARKETPLACE_ALLOWLIST` (default
  `claude-plugins-official=anthropics/claude-plugins-official`). Two token
  forms: `name=owner/repo` (→ GitHub raw URL) or `name=url` (verbatim).
- **Routes** (`packages/server/src/modules/skills.ts`):
  `GET /api/skills/marketplaces` (list ids, no fetch) +
  `GET /api/skills/marketplaces/:id/plugins` (fetch+cache, `?category=&q=`
  filters). Non-allowlisted id → `404 MARKETPLACE_NOT_ALLOWED` (not 403, to
  avoid leaking which ids are configured). Any authenticated user may browse;
  saving a skill resource from an entry still goes through the normal
  `/api/resources` scope rules.
- **Catalog parsing**: `marketplace.json`'s string relative-path `source`
  entries (`"./plugins/foo"`, ~30/257 of the live catalog) are dropped during
  per-entry validation — they only make sense inside the marketplace repo and
  cannot form a standalone-installable spec. The 3 object kinds (`git-subdir`/
  `url`/`github`) are kept; `github` carries `commit`+`sha` (aliases).
- **Config** (3 env keys): `MARKETPLACE_ALLOWLIST`, `MARKETPLACE_FETCH_TTL_MS`
  (1h), `MARKETPLACE_FETCH_TIMEOUT_MS` (10s); plus `MARKETPLACE_FIXTURE_PATH`
  for tests.
- **Hub UI (Phase 7.3)** — the `/skills/hub` page (`apps/web/src/pages/
SkillHub.tsx`) browses a marketplace, filters by `category` / free text, and
  saves an entry as a `plugin`-source skill resource via the 7.1 variant. Trust
  is computed **client-side** for display (`resolveTrustTier`, re-exported via
  the SDK); the server recomputes authoritatively at save time. The trust badge
  uses **neutral** Badge variants (`default` for trusted, `secondary` for
  community) — `--signal` is reserved for liveness per the Signal system. A
  `text-warn` callout appears when saving a community source with no pin. See
  `docs/design/phase-7.3-hub-ui.md`.

## Multi-source skill search (Phase 7.4)

Full design in `docs/design/phase-7.4-multi-source.md`. Summary for daily work:

- **`SkillSearchRouter`** (`packages/server/src/infra/source-fetchers/
search-router.ts`) dispatches a query to all registered `SkillSource`
  adapters in parallel, with a **per-source timeout** (`Promise.race`, default
  30s — a slow source can't block the response). Results merge with **dedupe
  by `identifier`** (not name — cross-source collisions keep the higher-trust
  copy). Partial-results-first: a slow/erroring/rate-limited source contributes
  nothing and surfaces in `timedOut` / `errored`; the search never throws.
- **4 adapters** (`infra/source-fetchers/{github,well-known,url,marketplace}-source.ts`):
  `GitHubSource` (recursive-tree API per tap, 1h tree cache, optional
  `GITHUB_TOKEN`, 403/429 → empty), `WellKnownSource` (`/.well-known/skills/
index.json`, URL-query only), `UrlSource` (fetch-only, `search` no-op),
  `MarketplaceSource` (wraps 7.2's `SkillCatalogService`, reuses its cache).
  Each adapter precomputes `extra.pluginSource` so the hub saves without
  reverse-engineering the identifier. **skills.sh / browse.sh deferred**;
  **clawhub / lobehub / hermes-index skipped** (verified: distrusted or wrong
  artifact class).
- **`GET /api/skills/search?q=&limit=`** (`modules/skills.ts`) returns
  `{results: SkillMeta[], timedOut: string[], errored: string[]}`. `q` required
  (400 if absent). Browse-without-query stays on 7.2's
  `/api/skills/marketplaces/:id/plugins`.
- **Hub dual-mode** (`apps/web/src/pages/SkillHub.tsx`): empty search box →
  7.2/7.3 marketplace browse; non-empty → `/api/skills/search`. Results carry a
  per-row source badge. A `text-muted-foreground` notice appears if any source
  timed out.
- **Config** (4 env keys): `GITHUB_TOKEN`, `SKILL_GITHUB_TAPS` (default the 4
  `TRUSTED_REPOS`), `SKILL_SEARCH_TIMEOUT_MS` (30s), `SKILL_DISABLED_SOURCES`
  (test mode).

## Authentication & authorization (permission interceptors)

Full design in `docs/design/phase-1-auth.md` — read it before touching auth. Summary for daily work:

- **Two roles only:** `admin` and `user`. Each user has exactly one role
  (`User.role`, not an array). Branch all access decisions on this field.
- **Two credential channels**, both via `Authorization: Bearer <credential>`:
  - **JWT access token** (primary, for the web UI) — signed with `JWT_SECRET`,
    verified statelessly by `jose`. Lifetime `JWT_ACCESS_TTL` (default `7d`).
  - **PAT** — `hnpat_<base64url(32)>`, stored as sha256. For CLI/automation.
- **Backend interceptors** (`packages/server/src/plugins/auth.ts`):
  - `onRequest` (registered on the **root** instance, not inside a child plugin
    context — Fastify hooks added in `app.register()` only apply to that scope)
    resolves either channel into `req.user = { id, role } | null`.
  - `app.requireAuth` / `app.requireAdmin` are **per-route preHandlers**:
    `{ preHandler: [app.requireAdmin] }`. 401 when anonymous, 403 when non-admin.
- **Frontend interceptors** (`apps/web/src/guards.tsx`):
  - `<RequireAuth>` redirects to `/login` when unauthenticated.
  - `<RequireAdmin>` renders a 403 view for non-admins.
  - The SDK wrapper logs out on any 401 response (`withAuthGuard` in `auth.tsx`).
- **Registration switch:** `SystemSettings.allowRegistration` (default open) gates
  `POST /api/auth/register`. `POST /api/users` (admin) bypasses it. The first user
  to register becomes the bootstrap admin. Admin toggles via
  `PUT /api/settings/registration`.
- **Safety rails:** last-admin protection (no deleting/demoting the final admin,
  409 `LAST_ADMIN`) and no self-delete (409 `NO_SELF_DELETE`). Disabled users'
  tokens are rejected by a fresh user lookup on each protected request.
- **Global vs personal scoping** (future): resources/profiles/MCP servers carry
  `scope: 'global' | 'personal'` and `ownerId`. The role check above is the
  _instance-level_ gate; per-resource ownership checks layer on top when those
  modules land.

## Required environment

`JWT_SECRET` is **required** (≥16 chars) — the server refuses to boot without it.
For local dev: `JWT_SECRET="$(openssl rand -base64 48)"`. For an ephemeral run
without SQLite, also set `STORAGE_DRIVER=memory`.

## Current status & roadmap

Phase 1 (auth), Phase 2.1 (MCP connection config + credentials), and Phase 2.2
(MCP registry, proxy & profiles) are implemented: users, two roles, JWT + PAT
auth, the registration switch, front- and back-end interceptors, the SQLite
driver (with migrations), the web UI, the encrypted credential store, MCP client
connection CRUD, the live `McpRegistry` aggregation, the `/mcp` (Streamable
HTTP) + `/mcp/sse` proxy with PAT + profile routing, Profile CRUD, the proxy
MCP connect/disconnect + tool-inspection control surface (Phase 2.4), the PAT
management UI (Phase 4.1), the shared Resource backend + sub-agent/rule/command
editors (Phase 4.2–4.4), the hook editor + event/target support matrix (Phase
4.5), the skill editor with multi-file bundles (Phase 4.6 — Phase 4 complete),
the `plugin` skill source variant + trust/provenance labels + `SkillSource`
port (Phase 7.1), the marketplace allowlist fetch + `SkillCatalogService`
cache + `/api/skills/marketplaces` browse API (Phase 7.2), the `/skills/hub`
browse + save-as-skill UI (Phase 7.3), and the multi-source `SkillSearchRouter`

- 4 adapters (github/well-known/url/marketplace) + `/api/skills/search`
  (Phase 7.4 — **Phase 7 complete**). **Phase 3** is partly done: 3.1
  (`McpServer.mode` + stdio-in-direct) and 3.2 (`Profile.target`, immutable) are
  shipped; the install pipeline (3.3+) is restructured around the ECC
  adapter-factory pattern (target adapter per tool + plan/apply + install-state
  ledger), with priority **Hermes → Claude Code → Codex**. `zcode` is in the
  `AgentTarget` enum but has no install adapter (no reproducible reference).
  See `docs/roadmap.md` for what remains. Still NOT done: the install pipeline,
  the stdio bridge entry, ECC/Superpower **import** adapters, the ACP bridge,
  Channels, LLM-WIKI, memory/notes. **Phase 2.3 (callable-function scripts) is
  on hold** — not currently planned. When you add the first real logic for a
  pillar, also add tests (vitest, not yet wired) and update the relevant `docs/`
  file.

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
  cli/         `hnx` one-click install tool (fetches profiles from a server via the SDK)
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
6. **The CLI fetches profiles from a server.** `packages/cli` resolves a profile
   via `@harness-nexus/sdk` against a running Harness Nexus server and installs
   it into a target Agent tool. It does **not** read local manifests — a profile
   is a reference bundle (its `entries` point at server-side resources by id),
   so the resource bodies and the aggregated `/mcp` endpoint both require the
   server. This replaces an earlier "must run standalone" rule that was written
   before the reference-style profile model landed.

## Git discipline — branch always, merge explicitly, push only on request

- **No direct commits to `main`.** Every unit of work lands on a short-lived branch
  (`feat/…`, `fix/…`, `docs/…`, `chore/…`) and is merged back with an explicit merge
  commit (`git merge --no-ff <branch>`), mirroring the standard open-source PR flow
  (branch → reviewable commits → merge). Never build on top of an unmerged branch
  unless intended.
- **Verify before merging:** typecheck + the relevant tests/smoke for the touched
  surfaces. Unverified code must not reach `main`.
- **Never push without an explicit user request.** `git push` — and any outward
  publish (`npm publish`, `gh pr create`, `gh release`) — happens ONLY when the user
  asks for it in the current session. Committing/merging locally is fine. This
  overrides any workflow text that says "merge main and push".

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

### Releasing to npm

Five packages publish in lockstep (`@harness-nexus/{core,shared,mcp-runtime,sdk,cli}`):
bump `version` in all five manifests, push, then run the `release` workflow
(GitHub Actions → release → Run workflow). It publishes via **OIDC trusted
publishing** — zero npm credentials in GitHub (per-package trusted publisher
registered on npmjs.com: sinrimin/harness-nexus + `release.yml`). pnpm itself
doesn't support tokenless publishing, so the workflow `pnpm pack`s each package
(which substitutes `workspace:` versions) and `npm publish`es the tarballs with
`--tag latest` (npm ≥ 12 demands an explicit tag for prereleases; pre-1.0 the
alphas ARE latest so `npx` works out of the box). Manual channel from a dev
machine: `npm_config_registry=https://registry.npmjs.org/ pnpm -r publish` with
a granular bypass-2FA token in `~/.npmrc` — a machine whose `~/.npmrc` defaults
to a registry mirror MUST override the registry explicitly or auth silently
targets the mirror.

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
- **Brand.** The mark (hexagonal ribbon), wordmark, and favicon are inline SVG
  (`components/brand-mark.tsx`, `public/favicon.svg`); the full logo asset is
  `docs/assets/logo.svg` (used by the README headers). The mark carries its own
  brand blues via `--brand-{bright,mid,deep}` tokens (deep navy is lifted in
  dark theme) — separate from the UI's `--signal` accent. Reuse `<Brand>`;
  don't introduce a raster logo.
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

## Web UI i18n (en / zh-CN)

The web UI is fully internationalized with a **zero-dependency, compile-time-checked**
system in `apps/web/src/i18n/`. Rules for daily work:

- **Never hardcode user-visible strings in pages.** Add them to a namespace file
  under `src/i18n/strings/<page>.ts`, which holds the English `en` object and the
  Chinese `zh` object SIDE BY SIDE, with `const zh: typeof en = { ... }` — the
  annotation makes a missing/mismatched key a compile error. The aggregator
  (`strings/index.ts`) zips them into the two runtime dictionaries and derives
  the `TranslationKey` dot-path union that `t()` is typed against, so a typo'd
  key also fails `tsc`.
- **Usage:** `const { t, lang } = useI18n();` (from `@/i18n`) in every component
  that renders text — including module-scope sub-components. `t('ns.key',
{ name })` interpolates `{name}` placeholders. Never call `t()` at module
  scope; module-scope tables may hold `TranslationKey`s resolved at render.
- **Dates** must pass `dateLocale(lang)` instead of `undefined` to
  `toLocaleDateString`/`toLocaleString`.
- **Language choice** persists in `localStorage` (`hnx.lang`), first visit
  follows `navigator.language`, `<html lang>` is kept in sync; the header
  toggle is `components/language-toggle.tsx`.
- **What stays English in both locales:** wire/protocol values rendered from
  data in mono badges (transport types, status enums, hook events, resource
  kinds, AgentTarget values), `${cred:...}` placeholders, code/`<pre>` contents,
  product names (Harness Nexus, Claude Code, MCP). Scope/role values are
  data-mapped via `common.scopeGlobal/scopePersonal/roleAdmin/roleUser`.
- **Terminology** (keep consistent): profile→配置集, credential→凭据, access
  token→访问令牌, machine→机器, daemon→守护进程, deploy→部署, job→作业, agent
  instance→代理实例, inventory→清单, dial site→拨号端 (server-/client-dialed→服务端/
  客户端拨号), scope→作用域, skill→技能, hub→技能中心, marketplace→市场. Chinese
  copy uses full-width punctuation and a half-width space between CJK and
  Latin/numbers.
- `index.css` `--font-sans`/`--font-mono` carry the CJK fallback chain (IBM Plex
  has no CJK glyphs) — don't remove it.

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
- **Client daemon, machines, realtime protocol, MCP shim, ACP chat (Phase 8)**
  → `docs/design/phase-8-client.md` · C1: `docs/design/phase-8-c1.md`

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
  scans and substitutes at resolve time — server-side at connect time (2.2) for
  server-dialed rows, server-side at config-fetch time (8 C2, resolved values
  then live in shim memory only) for client-dialed rows. There is no
  `credentialBindings` map.
- **MCP dial site (`auto` | `client` | `server`)** (Phase 8 C2 — replaces the
  3.1 proxy/direct `mode`): `server` — the platform dials (SSE/HTTP) and serves
  it via the `/mcp` outlet; `client` — the `hnx mcp serve` shim dials on the
  user's machine (SSE/HTTP/**stdio**; every referenced credential must be
  `distributable`); `auto` — derived by `resolveDialSite`
  (`packages/shared/src/dial-site.ts`): client iff all referenced credentials
  are distributable (or none), else server. stdio can never be server-dialed
  (`409 STDIO_REQUIRES_CLIENT`); the registry pools exactly the
  resolves-to-server rows. Credential `distributable`: personal always true;
  global is an admin opt-in, default false (locked globals are outlet-only).
- **Scope model (same for credentials and mcp-servers):** `global` is readable
  by any authenticated user but admin-only to mutate; `personal` is owner-only
  for all operations. The instance-level `requireAuth`/`requireAdmin` guards are
  the first gate; per-record ownership checks (owner-or-admin) layer on top.
  Not-found returns `404` (not `403`) to avoid leaking existence.
- **Profiles** (`docs/design/phase-2.2-registry.md`) bundle MCP servers; an agent
  tool connects via `?profile=<id>` and sees only that profile's aggregated tools.

## MCP registry, proxy & profiles (Phase 2.2)

Full design in `docs/design/phase-2.2-registry.md`. Summary for daily work:

- **`McpRegistry`** (`packages/server/src/mcp/registry.ts`) owns the pool of
  live `Client` connections to exactly the **server-dialed** upstreams (dial
  sites derived per `shared/dial-site.ts`; Phase 8 C2 narrowed the pool from
  "all proxy-mode rows" to this set). Transport-facing work lives in
  **`packages/mcp-runtime`** (`UpstreamPool` — dialing, namespacing, tool
  routing, stdio support), shared with the `hnx mcp serve` shim. It is built in
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
  placeholders in header values and the URL when dialing a server-side upstream.
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
- **Not yet built (2.3+):** callable-function scripts, per-PAT profile binding,
  tool-level authorization. (The stdio bridge entry was RESOLVED by Phase 8 C2 —
  the `hnx mcp serve` shim IS the stdio entry.)

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

## Marketplace emitter for Claude Code (Phase 3.5)

Full design in `docs/design/phase-3.5-marketplace-emitter.md`; empirical
ground truth in `docs/research/phase-3.5-marketplace-emitter-spike.md`.
Summary for daily work:

- **The preferred install path for claude-code targets.** The server EMITS a
  CC-native plugin marketplace; Claude Code owns install/update/uninstall via
  `archive` (zip) plugin sources — no client-side writes, no install-state
  ledger on this path (contrast the 3.3/3.4 adapter pipeline for Hermes etc.,
  which now has `hnx uninstall` — see below).
  User flow: `claude plugin marketplace add
<PUBLIC_BASE_URL>/api/marketplace/<emit-token>/marketplace.json` →
  `claude plugin install <profile>@harness-nexus-<username>`.
- **Auth is emit-token-in-path, not headers.** Claude's plugin flow can't
  reliably send Authorization headers (spike-verified: `extraKnownMarketplaces`
  headers only apply on some internal refresh paths), so both routes resolve
  the token from the URL. The token must carry the `marketplace` scope —
  created via `POST /api/pats {kind:'marketplace'}` (stored as
  `scopes:['marketplace']`, the reserved scopes field's first use); such tokens
  are REJECTED by the REST API auth hook (blast radius = the emitter URL only),
  and general API PATs are rejected by the emitter. Unknown/revoked token →
  `404 MARKETPLACE_NOT_FOUND` (no existence leak). The routes sit OUTSIDE
  `requireAuth` and set `req.user` themselves (`modules/marketplace.ts`).
  The create response carries `marketplaceUrl` + a ready-to-paste `addCommand`
  (the server knows `PUBLIC_BASE_URL`), shown once in the Tokens page reveal
  dialog. The request logger masks `/api/marketplace/<token>/` as
  `/api/marketplace/[token]/` (custom pino serializer in `app.ts`).
- **Two routes**: `GET /api/marketplace/:token/marketplace.json` (one
  marketplace per user, name `harness-nexus-<username>` — CC rejects
  name/URL remixing, so uniqueness matters) and `GET
/api/marketplace/:token/archives/:profileId.zip` (built on the fly by
  `MarketplaceEmitter`, `server/src/marketplace/emitter.ts`, decorated as
  `app.marketplaceEmitter`). Only `target === 'claude-code'` + visible
  profiles appear.
- **Zip layout is claude-native**: `.claude-plugin/plugin.json` (warnings
  ride the description — the only post-install channel), `.mcp.json` (Phase 8
  C2 `emitMode: 'client'` default: ONE stdio `hnx mcp serve --profile <id>
--server <base>` entry — no PAT env var, no inlined credentials;
  `EMITTER_MODE=server` keeps the pre-C2 output: the aggregated
  `/mcp?profile=<id>` endpoint + a `${HN_PAT_<SLUG>}` env placeholder — the
  no-`hnx` fallback), `skills/` (skills + rules wrapped as skills —
  CC plugins have no always-on rules), `commands/`, `agents/`,
  `hooks/hooks.json` (filtered by `HOOK_SUPPORT['claude-code']`).
- **Profile entries gained a second REST arm** (3.5): `{ resourceId, kind }`
  for every non-mcp resource kind, alongside 2.2's `{ mcpServerId }`.
  `resolveEntries` validates visibility for both; violation → `409
ENTRY_TARGET_NOT_ACCESSIBLE`. The web profile editor picks BOTH kinds
  (MCP checkboxes + per-kind resource sections) and offers `codex` as a
  target.
- **`hnx uninstall --target <t> [--out] [--apply]`** reverses an adapter-path
  install from the ledger. `applyInstall` snapshots each destination's
  pre-install content into the ledger (`previousContent`); uninstall restores
  snapshots / deletes created files in reverse order, keeps user post-install
  edits as `*.hnx.bak`, prunes empty dirs, and removes the ledger. Upgrade =
  re-run `hnx install --apply` (plans are idempotent overwrites).
- **Config**: `PUBLIC_BASE_URL` (default `http://localhost:8080`) — MUST be
  the public HTTPS origin in production: Claude Code enforces `https://` +
  non-loopback on archive URLs, and requires CLI ≥2.1.224 for `archive`
  sources. Dev workaround: LAN IP + self-signed CA + `NODE_EXTRA_CA_CERTS`.
- **`archive` source kind added to `marketplaceSourceSchema`** (shared) —
  emit and parse share one schema; `marketplacePluginToResourceSource`
  returns `null` for archive entries (no faithful plugin-source mapping), and
  the hub UI hides "Save as skill" for those rows.

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
  (`McpServer.mode` + stdio-in-direct), 3.2 (`Profile.target`, immutable), 3.3
  (install pipeline skeleton: adapter factory + plan/apply + install-state
  ledger + `hnx install` CLI), 3.4 (Hermes adapter), and 3.5 (the Claude Code
  **marketplace emitter** — profiles served as a native CC plugin marketplace
  over HTTP, plus the `{resourceId, kind}` profile-entry arm) are shipped.
  Remaining in Phase 3: the ECC/Superpower import adapters and the local-write
  CC fallback adapter. 3.6 (Codex), 3.7 (cross-target import), 3.8's "other
  agents" half (→ the Phase 8 **T-wave**; T1 = deepseek, shipped), the stdio
  bridge entry, and the ACP bridge are **absorbed into Phase 8** (see below).
  Channels, LLM-WIKI, memory/notes remain unplanned.
  `zcode` is in the `AgentTarget` enum but has no install adapter (no
  reproducible reference). See `docs/roadmap.md` for what remains.
  **Phase 8 — the Harness Nexus client & agent orchestration — is scoped,
  direction-locked, and C1–C5 are shipped (2026-09):** machines + on-demand
  daemon over Socket.IO/WSS, client-side MCP serving via per-session stdio
  shims (proxy/direct deleted; dial site derived from credential
  distributability + admin override; global creds non-distributable by default
  with server `/mcp` as their sole outlet), inventory/diff/import, remote
  deploy jobs, gated ACP chat, then orchestration (C6, undesigned). Read
  `docs/prd/phase-8-client.md` + `docs/design/phase-8-client.md` first, then
  `docs/design/phase-8-c1.md` for the shipped C1 details: `Machine` +
  `MachineRepository` (migration `0006`), machine PATs (`scopes:
['machine-ctl']`, rejected by the REST auth hook — realtime-only blast
  radius), realtime v0 in `packages/server/src/plugins/realtime.ts`
  (fastify-socket.io; `/ctl` daemon auth + `machine:hello` + `machine:<id>`
  rooms, `/app` browser push with `user:<id>`/`admins` rooms +
  `machine:status`; pure `MachinePresence` in `src/realtime/presence.ts`;
  decorated as `app.realtime`), `/api/machines` CRUD in `modules/machines.ts`
  (enroll returns the machine token ONCE; delete force-drops sockets + revokes
  the PAT), SDK machines methods, `hnx enroll`/`hnx daemon` (config at
  `~/.hnx/config.json`, 0600), the web Machines page + `/app` singleton in
  `apps/web/src/realtime.ts` (vite proxies `/socket.io` with `ws: true`).
  `packages/acp-bridge` is DELETED. C2 (`docs/design/phase-8-c2.md`):
  `McpServer.mode` → `dialSite` + `Credential.distributable` (migration
  `0007`), pure derivation in `shared/src/dial-site.ts`, NEW
  `packages/mcp-runtime` (`UpstreamPool`, stdio included, shared by the
  server registry and the shim), `GET /api/client/mcp-config` in
  `modules/client-config.ts` (the ONE REST surface a machine PAT unlocks;
  resolved transports for client-dialed only — secret-leak tested),
  `hnx mcp serve` (cli `src/mcp/serve.ts`, low-level `Server`, JSON schemas
  pass through, outlet dialed as a passthrough upstream), install adapters
  emit one baked-path shim entry (Hermes simplified; **Codex adapter shipped**
  — skills/prompts + TOML `[mcp_servers]` merge), emitter `EMITTER_MODE`
  (`client` default / `server` fallback). C3
  (`docs/design/phase-8-c3.md`) — inventory/diff/import: daemon per-target
  scanners in `packages/cli/src/inventory/` (claude-code/codex/hermes;
  platform origin from the install ledger + `harness-nexus[-*]` MCP names,
  never guessed from content), snapshots over `/ctl`
  (`inventory:scan|report|collect|payload`, auto-report after hello,
  capability `inventory`), `machine_inventory` storage (migration `0008`,
  latest per machine+target), `InventoryCoordinator` waiters
  (`src/realtime/inventory.ts`, exposed as `app.realtime.inventory`), pure
  `diffInventory` in `shared/diff-inventory.ts` (MCP arm is deliberately
  coarse; hook entries are skipped — no scanner), and
  `modules/inventory.ts` (`GET /inventory`, `POST /inventory/scan` —
  online+capability gated with a synchronous await, `GET /inventory/diff`,
  `POST /inventory/import` — collect → reuse-or-create → profile; MCP items
  become `McpServer` rows, never resources; **env/header values are redacted
  daemon-side** to `${cred:<KEY>}` before upload; re-import of identical
  bodies is a full reuse). The MachineDetail web page (`/machines/:id`,
  drill-down from Machines rows — no nav entry) drives scan/diff/import.
  C4 (`docs/design/phase-8-c4.md`) — jobs/remote deploy: `JobService`
  (`server/src/jobs/service.ts`, decorated `app.realtime.jobs`) —
  `queued → dispatched → running → succeeded | failed`, queued-only cancel,
  disconnect/ack-timeout recovery requeues with attempts+1 (≥
  `JOB_MAX_ATTEMPTS` ⇒ `failed JOB_ABANDONED`), terminal states ignore stale
  replay; machine online ⇒ `dispatchPending` drains the queue;
  `AgentInstance` (one per machine+profile, upserted on redeploy — the
  addressable unit for C5/C6; migration `0009`); `POST/GET
/api/machines/:id/jobs` + `POST /api/jobs/:id/cancel` + `GET
/api/machines/:id/agents` (`modules/jobs.ts`; deploy to claude-code →
  `409 TARGET_NOT_DEPLOYABLE` — that target rides the 3.5 emitter); `GET
/api/client/deploy-bundle` in `modules/client-config.ts` — machine PAT REST
  exception #2 (the resolved `ResolvedProfile` bundle); the daemon's
  `job:dispatch` handler (`cli/src/daemon/jobs.ts`) reuses the UNCHANGED 3.3
  pipeline with `job:progress`/`job:result` reporting; `/app` `job:update`
  push; MachineDetail Deployments card. C5
  (`docs/design/phase-8-c5.md`) — ACP chat: `AcSession` audit rows (migration
  `0010`, NO FKs — rows survive machine deletion), the `chat:*` protocol + ACP
  dialect schemas in `shared/realtime.ts` (semantic `ChatStreamEvent` stream +
  verbatim `optionId`), `ChatService` (`server/src/realtime/chat.ts`,
  `app.realtime.chat`) — gating order AgentInstance→remoteChatEnabled→online→
  capability→cap, opener joined to `chan:<sid>` AT OPEN (failure pushes must
  reach the browser), ready/permission watchdogs (`CHAT_READY_TIMEOUT_MS`,
  `CHAT_PERMISSION_TIMEOUT_MS`), busy gate, teardown on disconnect/delete/
  shutdown ("no resume"); the daemon's session manager
  (`cli/src/daemon/chat.ts` + `daemon/acp/`) — per-target ACP adapter
  subprocess table (`@zed-industries/claude-agent-acp` / `codex-acp` /
  hermes `acp_adapter`; env override `HN_ACP_COMMAND_<TARGET>` — also how
  tests point at `packages/cli/test/fixtures/acp-agent.mjs`), a hand-rolled
  JSON-RPC/stdio client (no new dep), ACP↔semantic mapping (`user_message_chunk`
  dropped — the browser echoes), one prompt in flight (races resync via
  `session_status`), SIGTERM→SIGKILL on close/disconnect; `/app` browser
  handlers (`chat:session.open|message.send|turn.cancel|permission.respond|
session.close`) + `/api/agent-instances/:id/sessions`; web `/chat` page
  (fold-style reducer, permission cards render from payload options,
  `--signal` marks the live turn only) + MachineDetail remote-chat toggle
  (confirm-first). Chat is owner-ONLY (admins excluded by design).
  **T1 — DeepSeek Harness (dsh) target onboarding — is shipped (2026-09,
  the first of the T-wave; supersedes the 3.8 "other agents" bucket):**
  `deepseek` is a first-class `AgentTarget` (profile enum additive; the
  supported-harnesses list user-facing docs name is **Claude Code, Codex,
  DeepSeek Harness** — hermes keeps working unlisted). Ground truth
  `docs/research/phase-8-t1-deepseek-harness.md` (pinned to dsh
  `v0.1.2-rc.1`): home is `~/.dsh` (`$DSH_HOME`); the HOME-level
  `cordis.patch.yml` applies to every profile AND hot-reloads live — it is
  the MCP integration seam; skills are Agent-Skills format under
  `~/.dsh/skills/` but dsh REQUIRES frontmatter `name`+`description`
  (kebab-case names) — the CLI adapter (`install/adapters/deepseek.ts`)
  SYNTHESIZES/repairs frontmatter; commands are flat `skills/<slug>.md`
  (dsh's `/name` slash surface IS the skill surface); MCP is a per-profile
  MARKED region (`# BEGIN/END harness-nexus:<slug>`) in the home patch
  mounting `@deepseek-ai/dsh-mcp-client` (stdio = the `hnx mcp serve` shim)
  — re-plans replace only that region (idempotent; other profiles' regions
  and user rows byte-preserved); rule/sub_agent/hook are skipped with
  warnings (`HOOK_SUPPORT['deepseek'] = null` — dsh's CC/Codex hook
  BRIDGES are opt-in per-profile pnpm packages an install cannot wire).
  C3 scanner (`inventory/scanners/deepseek.ts`) maps bundles→skill /
  flat→command / patch rows→mcp keyed by `serverName`; C5 ACP row is
  `['dsh', '--profile', 'acp']` (dsh on PATH + configured provider; env
  override `HN_ACP_COMMAND_DEEPSEEK`); C4-deployable (`DEPLOYABLE_TARGETS`).
  **Registry resilience fix shipped with T1** (surfaced by its smoke): a
  stdio `auto` row referencing a MISSING credential (the C3-import
  `${cred:KEY}` shape) derives server-dial and used to CRASH the
  fire-and-forget reload — `serverDialedDefinitions` now skips unresolvable
  rows with a warning and `connectServer` maps them to `409 not_dialable`
  (`server/test/registry-resilience.test.ts`).
  **Release infrastructure shipped (2026-09):** the five `@harness-nexus/*`
  packages are on npm (`0.1.0-alpha.2`; `latest` = alpha by design — `npx`
  must work pre-1.0; `packages/cli/README.md` is the npm landing page), with
  GitHub Actions CI on every push/PR (`ci.yml`, Node 20) and an OIDC
  trusted-publishing release workflow (`release.yml`, manual dispatch, no npm
  token stored). See "Releasing to npm" under Common commands. Remaining:
  C6 (orchestration). **Phase 9 — harness runtime lifecycle — is designed
  (2026-09), not yet implemented:** managing the harness software itself on
  machines (runtime inventory: bin/version/install-method; `harness`-type
  install/upgrade/pin jobs on the C4 pipeline; `RuntimeConfig` provider/model
  push referencing distributable credentials; redacted config viewing). Read
  `docs/research/phase-9-harness-runtime.md` + `docs/design/phase-9-harness-runtime.md`
  first — waves W1–W4 land independently. Local verification-rig notes
  (machine container lifecycle, JWT minting, the FAKE dsh shim that must be
  removed before W1/W2 runtime probing) live in `docs/dev/test-rig.md` —
  **git-ignored on purpose** (they carry this box's IPs/deployment layout);
  recreate locally if missing. Model shift decided with the
  user: inventory is **Agent-first** (runtime detection primary, items nested
  under the Agent, "not installed" instead of empty lists, default state
  captureable as a profile) and **chat keys off the detected Agent** via
  auto-registered `source: 'detected'` instances — not off deploy records.
  **Phase 2.3
  (callable-function scripts) is on hold** — not currently planned. When you
  add real logic for a pillar, also add tests and update the relevant `docs/`
  file. Vitest is wired in `@harness-nexus/shared`, `@harness-nexus/server`, and
  `@harness-nexus/cli` (`test/` dirs, excluded from build tsconfigs;
  `pnpm --filter … run test`);
  throwaway E2E scripts live in `scripts/smoke*.mjs` / `scripts/test-*.mjs`.

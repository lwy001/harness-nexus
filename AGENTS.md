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
- **Run the CI-parity gate before pushing:** CI (`.github/workflows/ci.yml`) is
  `pnpm -r build` + `pnpm -r typecheck` + `pnpm -r test` on **Node 20** — the
  documented engine floor. A dev box on a newer Node masks floor-only paths
  (e.g. `zlib.zstd*` exists ≥22.15; a zstd-absent test guard once errored only
  in CI). `task verify` (Taskfile) runs the same quartet with a Node 20
  toolchain from `/opt/node-v20.20.2-linux-x64/bin` (override via `NODE20_BIN`);
  without `task`, prepend that bin dir to PATH and run the three `pnpm -r`
  commands yourself. Green locally ⇒ green in CI.
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

Five packages publish in lockstep (`@harness-nexus/{core,shared,mcp-runtime,sdk,cli}`).
**The flow is tag-driven (2026-09-11 onward):**

1. Bump `version` in all five manifests on a branch, merge to main — after the
   CI-parity gate (`task verify`, Node 20) ran green.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — pushing the tag triggers the
   `release` workflow. The tag MUST equal the manifests' version (the workflow
   guards it and fails on mismatch); the tag is the release record.
3. Each publish SKIPS versions already on npm, so re-running the same tag or
   retrying a partially failed run is a no-op for what already landed.
   Manual dispatch from main (`workflow_dispatch`) remains the fallback — it
   publishes whatever the manifests say, unguarded by any tag.

Publishing uses **OIDC trusted publishing** — zero npm credentials in GitHub
(per-package trusted publisher registered on npmjs.com: sinrimin/harness-nexus +
`release.yml`). pnpm itself doesn't support tokenless publishing, so the workflow
`pnpm pack`s each package (which substitutes `workspace:` versions) and
`npm publish`es the tarballs with `--tag latest` (npm ≥ 12 demands an explicit
tag for prereleases; pre-1.0 the alphas ARE latest so `npx` works out of the
box). Manual channel from a dev machine:
`npm_config_registry=https://registry.npmjs.org/ pnpm -r publish` with a granular
bypass-2FA token in `~/.npmrc` — a machine whose `~/.npmrc` defaults to a
registry mirror MUST override the registry explicitly or auth silently targets
the mirror.

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

## Agent-first inventory & detected agents (Phase 9 W1)

Full design in `docs/design/phase-9-harness-runtime.md` (W1 shipped; W2–W4
designed). Summary for daily work:

- **The Agent (installed harness runtime) is the primary inventory object.**
  `RUNTIME_TARGETS = [claude-code, codex, deepseek]` (shared; hermes is not
  runtime-managed). The daemon probes them once per scan cycle
  (`probeRuntimes`, `packages/cli/src/inventory/runtime.ts` — PATH walk +
  `~/.local/bin` fallback for the claude native launcher, `<bin> --version`
  with a 5s per-probe timeout, parallel, realpath-based method classification)
  and folds the resulting `runtimes: RuntimeInfo[]` into EVERY
  `inventory:report` (the daemon now advertises the `runtime` capability;
  older daemons simply omit the arm).
- **Per-row storage, not a new table:** the server picks the snapshot
  target's entry out of the array and stores it on the `machine_inventory`
  row (`runtime` column, migration `0011`). `GET /api/machines/:id/inventory`
  rows carry `runtime: RuntimeInfo | null` (null = daemon doesn't probe /
  target not runtime-managed — DISTINCT from `installed: false`).
- **`AgentInstance.source: 'deploy' | 'detected'`** (migration `0011` also
  made `profileId`/`jobId` nullable — detected rows carry neither). The
  `DetectedInstanceSync` service (`server/src/realtime/runtime-instances.ts`,
  run fire-and-forget from the report handler) upserts a detected row when a
  report shows an installed runtime and NO deploy row owns the target; two
  consecutive not-installed reports remove it (in-memory hysteresis); a null
  arm is no signal at all. A later deploy (`JobService.registerInstance`)
  upgrades the detected row to `source: 'deploy'` in place. The agentInstances
  repo save is keyed by `id` — identity resolution belongs to the callers.
- **Chat keys off any AgentInstance** (no C5 code change): detected instances
  are chatable, which closes the emitter-installed claude-code gap. Their
  `directory` is the snapshot's agent home (the chat cwd).
- **Capture-as-profile:** `POST /api/machines/:id/inventory/capture
{target, profileName}` — the C3 collect+import core (`collectAndBundle`,
  shared with the import route) with ALL importable items of the latest
  snapshot; zero importables bundle a zero-entry profile (an Agent's default
  state is captureable). MachineDetail renders per-AGENT cards (runtime
  status line, not-installed state, capture form per card).

## Harness install/upgrade/pin jobs (Phase 9 W2)

Extends the section above (read it first). Full design in
`docs/design/phase-9-harness-runtime.md` §4.2/§9. Summary for daily work:

- **`type: 'harness'` jobs** ride the unchanged C4 pipeline (queue/replay/
  `job:update` push) but never create AgentInstances. `POST
/api/machines/:id/jobs` now takes a `type`-discriminated union
  (`createMachineJobSchema`); a body WITHOUT `type` is a deploy (pre-W2 SDK
  compat). Harness create is OWNER-ONLY (admin on a foreign machine → 403
  `MACHINE_OWNER_ONLY`) and soft-gated on the daemon's `harness` capability
  when online (offline may queue). Payload: `{type, action:
install|upgrade|pin, target: RuntimeTarget, version?}` — `pin` requires a
  version; W3 added `apply-config` (below) — `channel` never landed: CC
  version-less installs track the `stable` dist-tag instead.
- **The daemon executor is `cli/src/daemon/runtime.ts`** (`runHarnessJob`,
  dispatched from `daemon/jobs.ts`). npm is the only install channel
  (`HARNESS_PACKAGES` table); the ONE native path is `claude update` for an
  upgrade of an already-native claude-code install (pinning native refuses).
  Installs inherit the daemon env (proxy/registry pass-through), get 10 min
  per command (SIGTERM→SIGKILL), and stream a throttled stdout/stderr tail
  into `job:progress`. On success it merges `DISABLE_AUTOUPDATER=1` into
  `~/.claude/settings.json` (claude-code only; merge-preserving, 0600),
  RE-PROBES the target, reports the landing version in `job:result.data`
  (`harnessResultDataSchema`, optional `warning`), and auto-reports that
  target's inventory (Agent card + detected sync update without a rescan).
- **Tests never touch the network**: a fake `npm` shim on PATH records argv
  and writes a bin that prints the "installed" version
  (`cli/test/runtime-job.test.ts`, smoke `[9 W2]`). Known accepted race: the
  connect-time full report can overwrite a just-finished job's auto-report;
  the next scan self-heals.

## Provider config push (Phase 9 W3)

Extends the sections above. Full design in `docs/design/phase-9-harness-runtime.md`
§4.3/§9 (W3 notes) — ground truth in `docs/research/phase-9-harness-runtime.md` §8
(source-verified against dsh@0.1.2-rc.1 and codex-rs main). Summary for daily work:

- **`RuntimeConfig`** (core domain + `RuntimeConfigRepository` port, migration
  `0012`, sqlite/memory drivers, machine-delete cascade) is ONE provider spec
  per (machine, target): `{providerLabel, baseUrl?, api, model,
credentialName, extra?}` — never a secret; it names a credential that MUST
  be distributable (dial-site rules: unknown/foreign-personal → 404,
  non-distributable → 409 `CREDENTIAL_NOT_DISTRIBUTABLE`).
- **REST** (`modules/runtime-config.ts`): `GET` is owner-or-admin 404-hiding
  (echoes `credentialName`, never a secret); `PUT
/api/machines/:id/runtime-config/:target` is owner-only, validates per-target
  policy (`RUNTIME_API_SUPPORT` + deepseek-requires-baseUrl via
  `runtimeSpecUnsupportedReason` in shared), upserts the row, and queues
  `{type:'harness', action:'apply-config', target}`. A bare apply-config body
  at `POST …/jobs` → 409 `USE_RUNTIME_CONFIG_ENDPOINT`. Soft-gated on the
  daemon's **`runtime-config`** capability when online (W2 daemons advertise
  `harness` without the writer).
- **The secret never rides the job.** The daemon fetches the resolved
  `{spec, secret}` at EXECUTION time from `GET /api/client/runtime-config`
  (machine-PAT REST exception #3 — the tightest one; non-machine callers get
  a flat 404). Requeue after a credential rotation picks up the new value.
- **Writers** (`cli/src/daemon/runtime-config.ts`, dispatched from
  `daemon/jobs.ts`; all files 0600, merge-preserving, idempotent):
  - claude-code → `~/.claude/settings.json`: `env.ANTHROPIC_AUTH_TOKEN`,
    `env.ANTHROPIC_BASE_URL` (a baseUrl-less re-apply REMOVES ours), top-level
    `model`.
  - codex → `~/.codex/config.toml` root keys `model` + `model_provider` via
    `mergeTomlRootKeys` (top-level region only — appended root keys would land
    inside the last table) + `[model_providers.harness_nexus]` with
    `requires_openai_auth = true` and NO `wire_api` (current codex REMOVED
    `wire_api="chat"` — Responses-only; gateways must be Responses-compatible);
    `~/.codex/auth.json` merged to apikey mode with `OPENAI_API_KEY`.
  - deepseek → THREE slots: (a) a marked region in `~/.dsh/settings.yaml`
    with the `llm-pi-ai` namespace (the provider route) and
    `agent-default-model` (the default selection); (b) an id-targeted CONFIG
    OVERRIDE `- id: acp` in the home `cordis.patch.yml` — the dsh-acp-app
    composition PINS `provider: deepseek-official` on the acp plugin and a
    plugin's explicit config beats the settings default, so CHAT needs the
    override (verified: fresh acp sessions then select our route); (c) the
    key into **`~/.dsh/.env`** (`HARNESS_NEXUS_API_KEY`) — dsh's NATIVE
    user-env credential layer, read on every launch (user shells AND ACP
    spawns; no wrapper/snippet). Do NOT `- insert:` these plugins — the
    composition already mounts them and a second insert double-registers
    (crashes `--profile acp`). The writer refuses hand-managed namespace
    sections/acp overrides, retires legacy W3 regions, and absorbs `[]`/
    `{}` placeholder bases. **dsh's plugin tree needs Node ≥22.15** —
    deepseek jobs carry a result `warning` on older daemons (chat fails
    there).
- **Web** (MachineDetail): a Provider-config sub-form per Agent card
  (prefilled by GET; credential picker lists distributable credentials only;
  api select offers only the target's flavors — single-flavor targets render
  a fixed badge; confirm-first). Strings in `strings/machineDetail.ts` (en/zh).
- The W3 build also fixed a W2 bug: the executor defaulted `homeDir` to
  `undefined`, so production daemons never wrote `DISABLE_AUTOUPDATER`;
  `runHarnessJob` now defaults to `os.homedir()`.

## Redacted config viewer (Phase 9 W4)

Extends the section above. Full design in `docs/design/phase-9-harness-runtime.md`
§5/§6/§9 (W4 notes). Summary for daily work:

- **A live round-trip, never cached**: `GET /api/machines/:id/runtimes/:target/config`
  (owner-or-admin, 404-hiding) emits `runtime:config.get` over `/ctl`, the
  daemon reads the target's NATIVE config files, MASKS them, and replies
  `runtime:config` (inventory-style requestId waiters in
  `ConfigViewerCoordinator`, `server/src/realtime/config-viewer.ts`;
  disconnect/revoke fails waiters). Gates: offline → 409 `MACHINE_OFFLINE`,
  missing `runtime-config-view` capability → 409 (W3 daemons lack the reader),
  timeout → 504 `VIEW_TIMEOUT`. Config: `RUNTIME_CONFIG_VIEW_TIMEOUT_MS`.
- **Masking is daemon-side, before upload** (`cli/src/daemon/config-view.ts`):
  key-name-aware JSON walk + UNANCHORED TOML/YAML line masking (catches
  inline maps too) + quoted-pair scrub as the broken-JSON fallback; `.env`
  files are masked WHOLESALE (credential storage by construction). Files
  > 128 KiB or binary are skipped with a placeholder; paths are display paths
  > (`~/.codex/auth.json`). `~/.dsh/.credentials.yaml` is never read. Masked
  > values render as the literal `${redacted}`; the reply lists what was
  > hidden in `redacted[]` (`"<display-path>:<key>"`).
- **Web**: a "View config" button per Agent card opens a right-side Drawer
  (`components/ui/drawer.tsx` — Dialog primitives composed as a sheet, the
  go-to for tall read-only content) with mono `<pre>` blocks and a muted
  masked-count note. Strings in `strings/machineDetail.ts` (en/zh).
- Daemon `0.8.0-p9w4` advertises `runtime-config-view` alongside the W3 set.

## Modal containers & portal chat (Phase 9 W5+W6)

Full design in `docs/design/phase-9-portal-ui.md`; portal rendering study in
`docs/research/phase-9-portal-chat-ui.md` (the `~/acp-ref/portal/` half of the
C5 reference — the session list IS cwd-grouped there, which this wave ports).
Summary for daily work:

- **W5 — every create/edit flow opens in a modal, never an inline Card below
  the list.** One shared shell, `components/ui/form-dialog.tsx` (Dialog
  wrapper; sizes `sm|md|lg|xl`; scrollable content; optional footer).
  Converted: Resources (ResourceEditor re-shelled), Profiles, Credentials,
  McpManagement (incl. `ImportJsonDialog` rebuilt on the shared wrapper —
  the raw radix import is GONE), Machines (enroll), Users. Create-only flows
  stay create-only; pages own the `creating`/`editing` open flag and render
  the form component conditionally (Resources is the reference pattern).
- **W6 — chat is Agent cards → session page.** `/chat` renders one card per
  AgentInstance grouped by machine (blocked states ON the card, not hidden);
  `/chat/agents/:agentId` is the session page (`AppShell variant="full"` —
  viewport-locked, no max-width/padding): LEFT the session list (since W7 the
  AGENT'S OWN native sessions, grouped by cwd — group = basename + full-path
  tooltip, groups by newest session, rows show `title ?? untitled` +
  relative time; row click = RESUME), RIGHT the portal-style row stream +
  composer. The pre-W7 `AcSession`-row rail (open/closed states, no replay)
  is GONE — see the W7 section.
- **New sessions pick a directory first.** `Machine.baseWorkspace` (nullable,
  migration `0013`) is the root; `GET /api/machines/:id/workspace?path=`
  lists ONE level of subdirectories through the daemon (`workspace:list`
  over `/ctl`, `WorkspaceCoordinator` waiters, capability `workspace`;
  server-side resolve+prefix containment, hidden `.*` skipped, symlinks
  excluded, ≤512). Picker = `components/chat/dir-picker.tsx` (lazy tree;
  offers the owner an inline set-base-workspace form when unset; first click
  on a collapsed folder EXPANDS, second SELECTS). `chat:session.open` accepts
  `directory` → validated (`WORKSPACE_NOT_SET` / `WORKSPACE_INVALID`) before
  the gates, and passed as `chatSessionStart.cwd`. Containment applies ONLY
  to new sessions — a W7 `resume` arm passes the native cwd through verbatim.
- **Rich tool cards need the enriched wire**: `acpToolCallView` carries
  `toolName` (from the update or `_meta.claudeCode.toolName`), `rawInput`
  (dropped past 32 KiB), structured `content` (diff/content/terminal), and
  `output` (rawOutput, ≤100k). Daemon-side normalization lives in
  `cli/src/daemon/chat.ts` (`toolCallView`/`buildView`): `readTool`-style
  kinds fold to spec short forms, unknown statuses are dropped
  field-by-field (never a whole-view fallback). Permission cards get the
  arguments preview for free.
- **The stream is a row sequence, not bubbles** (`components/chat/fold.ts`,
  ported from the reference): user rows, assistant STEPS (split by tool
  calls; streaming caret on the live last block; interrupted marker), tool
  rows with lifecycle (upsert by callId), system notes, turn tails
  (duration · tokens · cancelled). Rendering: `chat-stream.tsx`
  (stick-to-bottom + ResizeObserver + jump button), `markdown-text.tsx`
  (react-markdown + remark-gfm + rehype-highlight; hljs palette hand-rolled
  from Signal tokens in `index.css`, light+dark), disclosure tool cards with
  a three-tier registry (`toolName` → ACP kind → generic IN/OUT card) behind
  an error boundary, and the Block family (`blocks.tsx`: Read/Diff/Terminal/
  Search/Io/Todo, 8-line head-tail caps, copy buttons). Permissions stay a
  separate slice rendered inline from payload options.
- New web deps: `react-markdown`, `remark-gfm`, `rehype-highlight`
  (self-hosted, no CDN). Old `pages/Chat.tsx` machine/agent selector UI is
  REPLACED (the page is now the cards grid); `pages/AgentSession.tsx` is the
  session page; MachineDetail's Chat link goes straight to
  `/chat/agents/:id`, and its header carries the base-workspace field.
- Daemon `0.9.0-p9w6` advertises `workspace` alongside the W4 set. The
  fixture agent gained a `show-tools` arm for card fixtures.

## Native agent sessions — list + resume, no platform store (Phase 9 W7)

Full design + ground truth in `docs/design/phase-9-w7-native-sessions.md`.
Supersedes the C5 "no resume" boundary and the W6 AcSession-row session list.
Summary for daily work:

- **The platform persists NOTHING session-shaped.** The `AcSession` audit
  table is deleted end-to-end (core type + port + `UnitOfWork.acSessions` +
  both drivers + migration **0014** `DROP TABLE ac_sessions`). `ChatService`
  is purely in-memory live-channel state. "Close" is re-framed as
  **disconnect** — `chat:session.close` keeps its wire name but only kills
  the channel + subprocess; the agent's own session survives.
- **The session list is the agent's OWN**, fetched live through the daemon:
  `GET /api/agent-instances/:id/sessions` → `{agent, supported, sessions:
NativeSessionView[]}` riding `sessions:list` over `/ctl` (capability
  **`sessions`**, `SessionsCoordinator` waiters, gates mirror the workspace
  route incl. error-arm-before-timeout; `SESSIONS_TIMEOUT_MS` default 30s).
  Daemon strategy (`cli/src/daemon/sessions.ts`): claude-code/codex spawn a
  short-lived adapter + `session/list` (claude-agent-acp 0.23 returns full
  SessionInfo; codex-acp 0.16 same, auth-gated); deepseek does a pure file
  scan of `~/.dsh/sessions` (no spawn); hermes/zcode/generic →
  `supported:false`.
- **Resume picks the method from the ADVERTISED capability**
  (`chat:session.open {resume:{sessionId,cwd}}` → `chatSessionStart.resume`):
  prefer `session/load` (claude/codex REPLAY their history as
  session/updates), fall back `session/resume` (dsh — restores without
  replay, demands an exact cwd match, rejects subagent/active sessions).
  The resume cwd came from the daemon's own listing, so NO baseWorkspace
  containment applies.
- **History is ONE wire shape, three producers**: `chat:history
{sessionId, items}` where `HistoryItem = {type:'user', blocks} |
{type:'event', event}` — user blocks + ORDINARY stream events, so the
  browser folds history through the same reducer (`fold` action `history`
  rebuilds from fresh; idempotent). Producers: (a) the load-replay capture
  (the daemon buffers notifications DURING `session/load` — `user_message_chunk`
  becomes a user item there instead of being dropped; a synthetic
  `turn_result` is appended if none arrived); (b) dsh's transcript file
  (`cli/src/daemon/dsh-sessions.ts` — MULTI-FRAME zstd: scan magic
  `28 B5 2F FD`, decode slices — Node's one-shot/stream decoders stop after
  frame 1; the `session` header entry carries fields at the TOP level, no
  `data` wrapper, unlike every other entry; real user turns are the
  `agent/inbox/spliced` inserts, `user/message` echoes + runtime-context
  entries are noise); (c) the per-channel history ring (forwarded prompts +
  mapped events, ≤2000) replayed on `chat:session.resync` (server sends it
  on rejoin AND after every ready — fixes the page-refresh-loses-transcript
  wart; double-push is safe because history ingestion resets first).
- `chat:session.ready` gained `nativeSessionId` (server remembers it, the
  rail highlights the row backing the open channel). zstd needs Node ≥22.15
  — below it dsh listing/history degrade gracefully (error note / empty
  history), never crash.
- Daemon `0.10.0-p9w7` advertises `sessions`. The fixture agent gained
  `session/list` + `session/load`-with-replay arms (`FIXTURE_ACP_NO_LOAD=1`
  → the dsh-shaped resume-only capability set).
- **Failed establishment MUST kill the adapter** (leak regression, rig-found):
  a failed resume (dsh validates the session's PINNED `(provider, model)`
  against the LIVE catalog at resume — a provider-config change orphans old
  sessions; cwd mismatch / "already active" / startup-race giveup likewise)
  emits `ready{error}` and the catch kills the connection — otherwise every
  failed click leaks a live adapter process parented to the daemon forever.
  The dsh listing ANNOTATES those sessions up front: the transcript's
  `request/header` pins the model, our own W3 managed region in
  `~/.dsh/settings.yaml` is the current catalog, mismatches carry
  `model` + `staleReason: 'model-missing'` (`nativeSessionView` optional
  fields) and the rail mutes them with a "pinned model no longer configured"
  hint instead of offering a guaranteed failure.
- **dsh LIVE token streaming rides the transcript file, not the protocol**
  (post-W7 addendum, branch `feat/p9-w7-dsh-streaming-tail`; full design in
  `docs/design/phase-9-w7-native-sessions.md` § "dsh live streaming"):
  `@deepseek-ai/dsh-acp` only emits COMMITTED updates (verified 0.1.2-rc.1
  AND 0.1.5-rc.1 — zero pushes during generation), but dsh persists every
  LLM chunk as a session event through a ~100–300ms write-behind window, so
  `TranscriptTail` (`cli/src/daemon/dsh-sessions.ts`) polls the session's
  `session.jsonl.zstd` and maps new frames via `createDshLiveMapper()`.
  Shapes verified against dsh 0.1.2-rc.1 source: deltas land as packed
  `text-chunks`/`reasoning-chunks`/`tool-call-chunks` rows (runs ≥ `MIN_RUN=3`)
  OR verbatim `assistant/chunk` events (shorter runs) — BOTH must map.
  Semantics mirror dsh's own in-process bridge: a `stepsWithDeltas` set keyed
  `"turn:step"` so a committed `assistant/message` for an already-streamed
  step carries only usage, while an unstreamed step falls back to full blocks.
  While the tail is live the wire's committed text chunks are SUPPRESSED
  (redundant by construction); tools/usage still flow (dedup by `toolCallId`
  / field-merge). `ensureTail` attaches at ready AND each prompt (a new
  session's file materializes lazily — the first attach of a never-wire-
  rendered session replays from byte 0 to recover pre-attach deltas; a
  resumed session skips to EOF). `runPrompt` waits ≤600ms for the
  transcript's `turn/end` row before emitting `turn_result` (the final
  write-behind batch lands AFTER the wire settles; a post-turn_result delta
  would open a new fold bubble). A bounded undecodable frame = corruption:
  the tail stops, suppression lifts, committed-only takes over. No zstd / no
  file → committed-only (old behavior). Daemon `0.10.1-p9w7`.
- **W7.1 — the in-process dsh event tap is the PRIMARY streaming source;
  the file tail is the fallback** (SHIPPED 2026-09-10, daemon
  `0.11.0-p9w7.1`, branch `feat/p9-w7.1-dsh-tap`; design + rig results in
  `docs/design/phase-9-w7.1-dsh-event-tap.md` incl. §Post-ship notes):
  the daemon insert-mounts a ZERO-DEP cordis plugin at spawn
  (`dsh --patch ~/.hnx/dsh-tap.patch.yml`, rendered per boot by
  `writeTapPatch` — never written into `~/.dsh`; plugin =
  `cli/src/daemon/dsh-tap/index.mjs`, build-copied into
  `dist/daemon/dsh-tap/`), which forwards the in-process `session/event`
  bus verbatim over a per-channel localhost JSON-line socket
  (`TapListener`, `cli/src/daemon/dsh-tap-listener.ts`: ephemeral port,
  one-time token, reject-on-mismatch). The handshake races the spawn via
  `Promise.all` — hello within 3s ⇒ the tap IS the source (SAME
  `createDshLiveMapper` instance semantics, wire committed chunks
  suppressed, `turn_result` settled from the tap's `turn/end`, subagent
  sessions filtered by id); otherwise (old dsh, plugin failure,
  `HN_DISABLE_DSH_TAP=1` A/B switch) `ensureTail` streams exactly as in
  W7. A tap that DIES mid-session leaves that session committed-only
  (`tapDead` — a fresh tail mapper would double-render streamed steps).
  Rig A/B: tap = 107 deltas / 1ms median gap on the count-1..25 turn vs
  tail's 3–4 batches / ~212ms+ gap; leak scan zero.

## Chat Sender/composer (Phase 9 W8)

Full design + post-ship notes in `docs/design/phase-9-w8-sender.md`.
Summary for daily work:

- **`<Composer>`** (`apps/web/src/components/chat/composer.tsx`) replaced
  AgentSession's inline Textarea+Button strip with a card: one
  `rounded-xl border` card (focus-within ring) holding an autogrow
  textarea (1 row → 224px clamp, then internal scroll; Enter sends /
  Shift+Enter newline, `isComposing` guards IME) over a toolbar row
  (context meter + circular send/stop, right-aligned; left slots stay
  empty for the deferred controls). It is PRESENTATIONAL — the page owns
  `draft`/`send()`/`cancelTurn()`.
- **The send control is the page's PRIMARY action** (`bg-primary`), NOT
  `--signal` — the live-turn indicator keeps the view's single signal
  spend. Stop during a turn swaps to an outline round button
  (destructive on hover, no confirm). Both are icon-only:
  `title`/`aria-label` from `chat.sendAria`/`chat.stopAria`
  (`chat.send`/`chat.stop` text keys are RETIRED).
- **Context meter** reads the fold's `conversation.usage`
  (`contextUsed`/`contextSize`): mono `nums` text + 64px `h-1` bar,
  neutral → `--warn` fill past 80% → `--danger` past 95%, renders
  NOTHING when the adapter reports no occupancy (codex today). dsh AND
  claude-code feed it live (the `@agentclientprotocol` wrapper reports
  occupancy — found during the rig E2E, see the design's post-ship note).
- **Deferred on purpose** (each needs a wire arm first — the design doc
  enumerates them): "+" attach (needs an image PromptBlock variant),
  permission-mode chip (needs a `chat:session.open` mode arm), model
  selector (per-channel override or change-model=new-session UX; interim
  read-only runtime-config badge possible), effort selector.

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
  (`docs/design/phase-8-c5.md`) — ACP chat: the `chat:*` protocol + ACP
  dialect schemas in `shared/realtime.ts` (semantic `ChatStreamEvent` stream +
  verbatim `optionId`), `ChatService` (`server/src/realtime/chat.ts`,
  `app.realtime.chat`) — gating order AgentInstance→remoteChatEnabled→online→
  capability→cap, opener joined to `chan:<sid>` AT OPEN (failure pushes must
  reach the browser), ready/permission watchdogs (`CHAT_READY_TIMEOUT_MS`,
  `CHAT_PERMISSION_TIMEOUT_MS`), busy gate, teardown on disconnect/delete/
  shutdown (the C5 `AcSession` audit rows + "no resume" boundary were
  REPLACED by Phase 9 W7 — the platform persists nothing session-shaped,
  list/resume/history are the agent's own); the daemon's session manager
  (`cli/src/daemon/chat.ts` + `daemon/acp/`) — per-target ACP adapter
  subprocess table (`@agentclientprotocol/claude-agent-acp` / `codex-acp` /
  hermes `acp_adapter`; the claude-code row was switched 2026-09 from
  `@zed-industries/claude-agent-acp` 0.23.x, which never requested thinking on
  gateway/unknown models → chat showed no thought stream; the official
  ACP-project wrapper streams `agent_thought_chunk` by default, advertises
  `loadSession`+`list`/`resume` in shapes the daemon already detects, and
  returns full SessionInfo — rig-verified E2E; env override
  `HN_ACP_COMMAND_<TARGET>` — also how
  tests point at `packages/cli/test/fixtures/acp-agent.mjs`), a hand-rolled
  JSON-RPC/stdio client (no new dep), ACP↔semantic mapping (`user_message_chunk`
  dropped — the browser echoes), one prompt in flight (races resync via
  `session_status`), SIGTERM→SIGKILL on close/disconnect; `/app` browser
  handlers (`chat:session.open|message.send|turn.cancel|permission.respond|
session.close`) + `/api/agent-instances/:id/sessions`; web `/chat` page
  (fold-style reducer, permission cards render from payload options,
  `--signal` marks the live turn only) + MachineDetail remote-chat toggle
  (confirm-first). Chat is owner-ONLY (admins excluded by design).
  **Channel budget (redesigned post-W8, see the C5 design doc's § "Channel
  budget redesign"):** TWO budgets per machine — `CHAT_MAX_SESSIONS_PER_MACHINE`
  (total channels, default 12) and `CHAT_MAX_ACTIVE_SESSIONS_PER_MACHINE`
  (mid-turn sessions, default 5, enforced at PROMPT time → `MACHINE_BUSY`; the
  web restores the draft on a bounce). A full total budget EVICTS the oldest
  non-busy channel (`closed {reason:'evicted'}` + a dedicated web note) instead
  of rejecting; `SESSION_LIMIT_REACHED` only survives for all-busy. Visibility:
  session-listing rows carry server-computed `open`/`openChannelId`; the rail
  marks such rows 已打开 and clicking REJOINS the channel (fallback: fresh
  resume if it died) — which is why the daemon's dsh listing no longer hides
  sessions with live channels (`liveNativeIds`/`ChatRegistry` deleted).
  **Channel lifecycle (hardened post-W8 — three coupled defects, see the C5
  design doc's § "Channel lifecycle hardening"):** a channel dies with its
  daemon socket. (a) The
  session page **leaves before entering** — `openChannel` closes the previous
  channel BEFORE issuing the open (skipped when rejoining the same channel) and
  closes on unmount; closing only after a successful open meant a rejected open
  leaked the old slot and wedged every later click behind `SESSION_LIMIT_REACHED`.
  (b) The daemon records ids closed **during** establishment
  (`closedBeforeReady`) and the start handler aborts at two checkpoints — a
  close racing the spawn used to be dropped, leaving an orphan adapter. (c) The
  server reaps a machine's channels on **every** `/ctl` connection, not only on
  the offline transition: a newly connected daemon owns zero channels by
  construction, and a fast daemon restart could skip the offline reap — that is
  what wedged a machine until the server itself restarted.
  **Viewer-scoped channels (round 2, same doc § "Viewer-scoped channels"):**
  a /app socket disconnect closes the user's channels whose room is empty
  (`onViewerGone`; a mid-turn channel defers via `closeWhenIdle` so an
  abandoned generation still finishes). Listing rows are SYNTHESIZED for live
  channels with no native row yet (claude-code writes a transcript only on the
  first message). The claude resume dialect needs BOTH `loadSession` locations
  (`deriveSessionCaps`: result root = Zed adapters, nested in
  `agentCapabilities` = the official wrapper — reading only the root made
  claude resume with NO replay). The dsh listing requires a real user turn
  (`agent/inbox/spliced`): fresh sprees write config-preamble transcripts and
  the `-32605` retry race leaves orphans (the "two unnamed sessions").
  Adapter kills signal the whole process GROUP (`detached` spawn + negative
  pid; signaling the child alone orphaned the vendor binary).
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
  **dsh's ACP adapter speaks a DIFFERENT update dialect than the Zed
  adapters** (verified 2026-09-10): chunks carry `content` (not
  `contentBlock`), tool calls spread fields FLAT on the update (no
  `toolCallUpdate` wrapper), and usage reports context occupancy
  (`used`/`size` → mapped to `contextUsed`/`contextSize`). The daemon's
  `mapAcpUpdate` handles BOTH dialects — extend it, never replace one with
  the other (see the T1 research note § ACP).
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
  C6 (orchestration). **Phase 9 — harness runtime lifecycle — W1 through
  W8 are SHIPPED (2026-09, see the sections above): Agent-first inventory
  with the runtime probe arm, detected AgentInstances (chatable),
  capture-as-profile, `harness`-type install/upgrade/pin jobs, `RuntimeConfig`
  provider/model push, redacted config viewing, modal containers + the
  portal-style chat UI (W5+W6), native agent sessions — list + resume
  with NO platform session store (W7) — the in-process dsh event tap
  streaming source with the file tail as fallback (W7.1), and the card-style
  chat Sender/composer (W8).** Remaining in P9: none scoped; C6
  (orchestration) and hermes native sessions are the open follow-ups.
  Read `docs/research/phase-9-harness-runtime.md` +
  `docs/design/phase-9-harness-runtime.md` (W1–W4) and
  `docs/design/phase-9-portal-ui.md` (W5+W6) +
  `docs/design/phase-9-w7-native-sessions.md` (W7) +
  `docs/design/phase-9-w7.1-dsh-event-tap.md` (W7.1) first. Local
  verification-rig notes
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

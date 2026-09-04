# Roadmap

Phased so each milestone is independently useful. ✅ done, 🚧 in-progress, ⏳ not
started. Doc links point at the PRD (`docs/prd/`) and design (`docs/design/`).

## Phase 0 — Foundation

- ✅ Monorepo layout, tooling, configs
- ✅ Domain model + storage ports (`UnitOfWork`)
- ✅ Server boot path (Fastify + storage factory + health routes)

## Phase 1 — Users, roles & authentication

- ✅ SQLite storage + migrations
- ✅ Users / roles (admin, user) / registration switch + bootstrap admin
- ✅ JWT access tokens + PAT (`hnpat_…`)
- ✅ Front- and back-end permission interceptors
- ✅ Web auth UI (login, register, dashboard, users, settings)
- PRD: `docs/prd/phase-1-auth.md` · Design: `docs/design/phase-1-auth.md`

## Phase 2.1 — MCP connection config & credentials

- ✅ Credential store (AES-256-GCM at rest, masked previews)
- ✅ MCP client connection CRUD (SSE / Streamable HTTP; stdio via direct mode)
- ✅ `${cred:NAME}` placeholder injection (url/command/args/env/headers)
- ✅ MCP mode: `proxy` (server dials) / `direct` (tool dials); stdio forces direct
- ✅ Scope model: global (admin-mutate) / personal (owner-only)
- PRD: `docs/prd/phase-2.1-credentials.md` · Design: `docs/design/phase-2.1-credentials.md`

## Phase 2.2 — MCP registry, proxy & profiles

- ✅ `McpRegistry`: pooled upstream connections, namespaced tool aggregation
- ✅ `${cred:NAME}` placeholders resolved into real values at connect time
- ✅ Proxy re-exposure: `/mcp` (Streamable HTTP) + `/mcp/sse` (SSE)
- ✅ Profile CRUD + explicit profile routing (`?profile=<id>`, PAT-gated)
- ✅ Live connection status (`GET /api/mcp-servers/status`) + dashboard mesh
- PRD: `docs/prd/phase-2.2-registry.md` · Design: `docs/design/phase-2.2-registry.md`

## Phase 2.3 — Callable-function scripts ⏸️ on hold

> **Status: on hold.** Not currently planned for development. The original
> Phase 4 line item "Callable-function script editor + test-run (with 2.3)" is
> removed until this phase resumes.

- ⏸️ Admin-authored JS wrapping vendor APIs as MCP tools, run in a sandbox
- ⏸️ `isolated-vm` executor + host-injected allowlisted `ctx.fetch`
- ⏸️ `ToolSource` abstraction (CallableRegistry alongside McpRegistry)
- ⏸️ Profile entries for callable-functions; management UI
- PRD: `docs/prd/phase-2.3-callable-functions.md` · Research: `docs/research/phase-2.3-sandbox.md`

## Phase 2.4 — proxy MCP connect & tool inspection

- ✅ Per-row live connection status + tool-count badge on the MCP Management page
  (state-encoded colors per the Signal system; status polled on an interval)
- ✅ Explicit Connect/Disconnect buttons for proxy servers (incremental — startup
  auto-pooling from 2.2 is unchanged; Connect is for forcing a reconnect after a
  fix, Disconnect drops a live connection on demand)
- ✅ Expandable tool-inspection panel: lists the upstream's tools (original names)
  with description + `inputSchema` parameters, plus a Refresh button
- ✅ Direct rows show a neutral "dialed by the tool" hint, no connect controls
- PRD: `docs/prd/phase-2.4-connect-tools.md` · Design: `docs/design/phase-2.4-connect-tools.md`

## Phase 3 — Install pipeline (Pillars #2 & #3)

> **Restructured** around the ECC adapter-factory pattern + plan/apply.
> Priority: **Hermes → Claude Code → Codex**. ZCode is out of install scope
> (no reproducible reference; retained in the enum but unsupported).
>
> **Direction decided — "Harness Nexus client" unification (2026-09):** the
> `hnx` CLI, the Phase 5 ACP bridge, machine registration, client-side MCP
> serving, and remote deploy fold into one Harness Nexus client program, under
> the broader repositioning of Harness Nexus as an **agent orchestration
> platform** (control plane = server/web, data plane = client). See **Phase 8**
> below — PRD `docs/prd/phase-8-client.md`, design
> `docs/design/phase-8-client.md`. Consequences for this phase: 3.6 and 3.7 are
> absorbed into Phase 8 (C2 and C3 respectively); the local-write CC fallback
> adapter stays deferred.

- ✅ 3.1 — `McpServer.mode` (proxy/direct) + stdio re-enabled in direct mode; "MCP Connections" → "MCP Management"; removed `proxied` (mode alone decides pooling)
- ✅ 3.2 — `Profile.target` (single, immutable) + target-narrowed creation form + `TARGET_IMMUTABLE`; `codex` added to the enum, `zcode` retained-but-unsupported
- ✅ 3.3 — Install pipeline skeleton: target adapter factory + registry + plan/apply separation + install-state ledger + `hnx install` CLI (dry-run default). No real target adapter yet.
- ✅ 3.4 — **Hermes adapter** (priority 1). Python plugin bundle + `config.yaml` `mcp_servers:` merge + `AGENTS.md` rules; `${HN_PAT_*}` env placeholders.
- ✅ 3.5 — **Marketplace emitter** (priority 2; re-planned). Serve each user's claude-code profiles as a native CC plugin marketplace over HTTP — `claude plugin marketplace add <PUBLIC_BASE_URL>/api/marketplace/<PAT>/marketplace.json` + archive-source zips; claude owns install/update/uninstall. Profile entries gained the `{resourceId, kind}` resource arm. The local-write CC adapter is demoted to an old-CLI (<2.1.224) / airgapped fallback — deferred behind the emitter.
- ➡️ 3.6 — **Codex adapter** → absorbed into Phase 8 (C2): under the client
  stdio unification every target emits one stdio shim entry, which makes the
  Codex adapter the trivial case (TOML `config.toml` stdio entry).
- ➡️ 3.7 — Cross-target profile import → absorbed into Phase 8 (C3): the
  daemon's inventory scan + diff + one-click import generalizes it
- ⏳ 3.8 — Other well-known agents (optional) + ECC/Superpower import adapters
- PRD: `docs/prd/phase-3-install.md` · Design: `docs/design/phase-3-install.md` · Design 3.5: `docs/design/phase-3.5-marketplace-emitter.md`
- Research: `docs/research/phase-3-ecc-install-patterns.md` (adapter factory + plan/apply + install-state; Codex ground-truth) · `docs/research/phase-3-plugin-targets.md` (per-target formats; CC/Hermes detail, ZCode superseded) · `docs/research/phase-3.5-marketplace-emitter-spike.md` (empirical CC marketplace protocol constraints)

## Phase 4 — Resource management & PAT UI

- ✅ 4.1 — PAT management UI (list / create-once / revoke); backend ready
- ✅ 4.2 — Sub-agent management: **shared Resource backend** (SQLite v5
  `resources` table, dual-driver repos replacing `memoryResourceStub`,
  `/api/resources` CRUD, zod schema, SDK methods) + resource browser + sub-agent
  markdown editor
- ✅ 4.3 — Rule management (rule markdown editor on the 4.2 backend)
- ✅ 4.4 — Command management: slash-command editor (single-file markdown;
  `commands/<name>.md` per target). Mirrors 4.2/4.3 — `AVAILABLE_KINDS` + editor
  variant only.
- ✅ 4.5 — Hook management: structured event→command editor emitting
  `hooks.json` + event/target support matrix (`packages/shared/src/hooks.ts`,
  shared with Phase 3.2). Hermes excluded (different hook model); events
  validated against the matrix. Research: `docs/research/phase-4.5-hooks.md`
- ✅ 4.6 — Skill management (local): **inline skills + multi-file bundles**.
  New `ResourceSource` `inline-bundle` variant (SKILL.md + `references/` +
  `scripts/`; ~42% of real skills are multi-file). Single-file skills reuse
  `inline`. External references / hub search are Phase 7.
- PRD: `docs/prd/phase-4-web-ui.md` · Design: `docs/design/phase-4-web-ui.md`
- Order: **by difficulty** — command (4.4) → hook (4.5) → skill (4.6). External
  skill references / hub search are split out into Phase 7.

## Phase 5 — ACP bridge

- ➡️ Absorbed into Phase 8 (C1 daemon + control channel, C5 ACP chat). The
  `packages/acp-bridge` skeleton is deleted when C1 lands.

## Phase 6 — Platform features

- ➡️ stdio bridge entry → resolved by Phase 8 (C2): the per-session
  `hnx mcp serve` stdio shim IS the stdio entry; no server-side spawning of
  local processes ever happens.
- ⏳ Chat-tool Channels (route external chats to controlled agents) — adjacent
  to Phase 8's C6 orchestration
- ⏳ LLM-WIKI knowledge base
- ⏳ Global memory / notes

## Phase 7 — Skill multi-source & plugin references

Split by "independently verifiable + increasing difficulty + outbound network
last". 7.1 is the zero-outbound foundation; 7.2 opens the first server-side
outbound path (isolated in its own PR); 7.3 closes the UX loop; 7.4 is the
large, least-certain multi-source block (can stop partway).

| #       | Sub-phase                   | Status | Carries                                                                                                                                                                                                                                                                                | Depends on | Outbound?                         |
| ------- | --------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------- |
| **7.1** | plugin source + trust model | ✅     | `ResourceSource` `plugin` variant (CC marketplace 4 source kinds); trust tiers (`builtin`/`trusted`/`community`) + provenance pin (`content_hash`); `SkillSource` port (abstract, one no-op `inspect`); flip `validateSkillResource` + smoke                                           | Phase 4.6  | **none** (store spec only)        |
| **7.2** | marketplace allowlist fetch | ✅     | server's first outbound path: `GET /api/skills/marketplaces/:id/plugins` (fetch + cache + timeout `marketplace.json`); `MARKETPLACE_ALLOWLIST` config; trust by repo owner; "save marketplace entry as skill resource"                                                                 | 7.1        | **yes** (allowlisted GitHub raw)  |
| **7.3** | hub search UI               | ✅     | web marketplace browser (category filter + search + trust badge) → "save as skill resource" → reuses 7.1 `plugin` source storage; install-warning UX (trust tier + missing-pin warning)                                                                                                | 7.2        | no (calls 7.2 endpoint)           |
| **7.4** | Hermes-style multi-source   | ✅     | 4 `SkillSource` adapters (github/well-known/url/marketplace-wrapper); parallel search + per-source timeout + merge dedupe (identifier key, trust-rank); `/api/skills/search`; hub page dual-mode (browse + search); skills-sh/browse-sh deferred, clawhub/lobehub/hermes-index skipped | 7.1, 7.3   | **yes** (github/well-known fetch) |

- PRD: `docs/prd/phase-7-skills.md` · Design 7.1: `docs/design/phase-7.1-plugin-source.md`
  · Design 7.2: `docs/design/phase-7.2-marketplace-fetch.md`
  · Design 7.3: `docs/design/phase-7.3-hub-ui.md`
  · Design 7.4: `docs/design/phase-7.4-multi-source.md`
  · Research:
  `docs/research/phase-4.4-skills.md`
- **Research corrections carried into the PRD** (ground-truth verified):
  Hermes has **10** adapters (not 9 — `OptionalSkillSource` is the `official`
  source); trust is **4** tiers internally (the 4th, `agent-created`, is
  off-by-default and not surfaced); the live CC `marketplace.json` has **4**
  source kinds (`url`/`git-subdir`/string-path/`github`) and **no `npm`**;
  `category` is the filter axis (243/257 entries), not `tags` (3) or `metadata`.
- Out of scope: content security scanning (Hermes `skills_guard.py` model) —
  Harness Nexus stores references, the target tool executes.

## Phase 8 — Harness Nexus client & agent orchestration 🚧 (C1 shipped)

> Repositioning: from asset-integration platform to **agent orchestration
> platform**. Control plane (server + web) / data plane (one `hnx` client
> program per enrolled machine). Decisions locked in the PRD; protocol, data
> model, and per-phase plan in the design doc.

| #         | Sub-phase                     | Delivers                                                                                                                            | Absorbs / impacts                         |
| --------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **C1** ✅ | daemon + machine registration | `hnx daemon` + `Machine` entity + enrollment (machine PAT) + WSS control channel (Socket.IO `/ctl`)                                 | Phase 5 (half); deletes `acp-bridge`      |
| C2        | client MCP serving            | stdio shims (`hnx mcp serve`), credential distributability + dial-site routing, `/mcp` outlet narrowing, emitter client mode        | 2.1 `mode`, 2.2 pooling, 3.5 emitter, 3.6 |
| C3        | inventory + diff + import     | per-target scans, profile diff, one-click import into resources + profile                                                           | 3.7                                       |
| C4        | remote deploy                 | job abstraction (queue/dispatch/replay) over the 3.3 pipeline + Agent instances                                                     | reuses 3.3                                |
| C5        | ACP chat                      | chat + agent control over `/app`↔`/ctl` routing, daemon-side semantic↔ACP adapters, web chat UI (remote chat gated, off by default) | Phase 5 (other half)                      |
| C6        | orchestration                 | deliberately undesigned until C1–C5 land                                                                                            | Phase 6 Channels (adjacent)               |

- Key locked decisions: global-scope credentials non-distributable by default
  (server `/mcp` is their sole outlet); daemon is on-demand and MCP **never**
  depends on it; agents consume MCP uniformly as stdio shims (proxy/direct
  deleted, dial site derived + admin override); realtime = Socket.IO over WSS
  with one **bidirectional namespace per role** — `/app` (browser: UI push +
  chat + agent control) and `/ctl` (daemon: management + routed interactive
  traffic; daemon adapts semantics ↔ agent protocol) — plus `domain:verb`
  event names, room addressing, and session-per-channel isolation; the channel
  pattern is the substrate for future file-management / web-terminal
  extensions.
- PRD: `docs/prd/phase-8-client.md` · Design: `docs/design/phase-8-client.md` ·
  Design C1: `docs/design/phase-8-c1.md`
- ✅ **C1 shipped (2026-09, branch `phase-8-c1`)**: `Machine` entity + repos +
  SQLite migration `0006`; machine PATs (`scopes: ['machine-ctl']`) rejected by
  the REST hook (realtime-only blast radius); realtime v0 — `fastify-socket.io`
  with `/ctl` (daemon auth, `machine:hello`, rooms) + `/app` (JWT/PAT push,
  `user:<id>`/`admins` rooms, `machine:status`), pure `MachinePresence` state
  machine; `/api/machines` CRUD (enroll token shown once, delete force-drops
  sockets + revokes); SDK machines methods; `hnx enroll` / `hnx daemon`
  (config in `~/.hnx/config.json` 0600); Machines web page with live presence;
  `acp-bridge` package deleted.

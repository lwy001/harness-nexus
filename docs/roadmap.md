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
- ➡️ 3.8 — "Other well-known agents" half → superseded by the **Phase 8
  T-wave** (T1 = DeepSeek Harness, explicitly prioritized ahead of the rest);
  ECC/Superpower import adapters remain here, pending
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

## Phase 8 — Harness Nexus client & agent orchestration 🚧 (C1–C5, T1 shipped)

> Repositioning: from asset-integration platform to **agent orchestration
> platform**. Control plane (server + web) / data plane (one `hnx` client
> program per enrolled machine). Decisions locked in the PRD; protocol, data
> model, and per-phase plan in the design doc.
>
> **T-wave (target onboarding)**: adding a harness as a supported target
> spans install adapter + inventory scanner + ACP chat row + remote deploy —
> all but the first are Phase 8 surfaces, so onboarding lives here. The
> supported-harnesses list (one-click install + ACP chat): **Claude Code,
> Codex, DeepSeek Harness** — the user-facing docs mention only these three
> for now (hermes keeps working unlisted).

| #         | Sub-phase                     | Delivers                                                                                                                                                                                                           | Absorbs / impacts                              |
| --------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| **C1** ✅ | daemon + machine registration | `hnx daemon` + `Machine` entity + enrollment (machine PAT) + WSS control channel (Socket.IO `/ctl`)                                                                                                                | Phase 5 (half); deletes `acp-bridge`           |
| **C2** ✅ | client MCP serving            | stdio shims (`hnx mcp serve`), credential distributability + dial-site routing, `/mcp` outlet narrowing, emitter client mode                                                                                       | 2.1 `mode`, 2.2 pooling, 3.5 emitter, 3.6      |
| **C3** ✅ | inventory + diff + import     | per-target scans, profile diff, one-click import into resources + profile                                                                                                                                          | 3.7                                            |
| **C4** ✅ | remote deploy                 | job abstraction (queue/dispatch/replay) over the 3.3 pipeline + Agent instances                                                                                                                                    | reuses 3.3                                     |
| **C5** ✅ | ACP chat                      | `chat:*` over `/app`↔`/ctl` (semantic stream + ACP payload dialect), daemon ACP adapter subprocesses (claude-code/codex/hermes), permission watchdog, AcSession audit, web `/chat` UI (owner-only, off by default) | Phase 5 (other half)                           |
| **T1** ✅ | DeepSeek Harness onboarding   | `deepseek` `AgentTarget`: install adapter (`~/.dsh` skills + home `cordis.patch.yml` MCP rows via the `hnx mcp serve` shim), C3 scanner, C5 ACP row (`dsh --profile acp`), C4-deployable                           | supersedes 3.8 "other agents"; priority: first |
| C6        | orchestration                 | deliberately undesigned until C1–C5 land                                                                                                                                                                           | Phase 6 Channels (adjacent)                    |

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
  Design C1: `docs/design/phase-8-c1.md` · Design C2: `docs/design/phase-8-c2.md` ·
  Design C3: `docs/design/phase-8-c3.md` · Design C4: `docs/design/phase-8-c4.md`
- ✅ **C1 shipped (2026-09, branch `phase-8-c1`)**: `Machine` entity + repos +
  SQLite migration `0006`; machine PATs (`scopes: ['machine-ctl']`) rejected by
  the REST hook (realtime-only blast radius); realtime v0 — `fastify-socket.io`
  with `/ctl` (daemon auth, `machine:hello`, rooms) + `/app` (JWT/PAT push,
  `user:<id>`/`admins` rooms, `machine:status`), pure `MachinePresence` state
  machine; `/api/machines` CRUD (enroll token shown once, delete force-drops
  sockets + revokes); SDK machines methods; `hnx enroll` / `hnx daemon`
  (config in `~/.hnx/config.json` 0600); Machines web page with live presence;
  `acp-bridge` package deleted.
- ✅ **C2 shipped (2026-09, branch `phase-8-c2`)**: `McpServer.mode` deleted →
  `dialSite: auto|client|server` (migration `0007` folds proxy→auto,
  direct→client); `Credential.distributable` (personal always true, global
  admin opt-in); pure dial-site derivation in `shared/dial-site.ts`; NEW
  `packages/mcp-runtime` (`UpstreamPool` — SSE/HTTP/**stdio** dialing +
  namespacing + passthrough, shared by the server registry and the shim);
  `/api/client/mcp-config` (machine-PAT exception; resolved transports for
  client-dialed only, secret-leak tested); registry pools exactly the
  server-dialed set (`/mcp` outlet contract unchanged); `409
STDIO_REQUIRES_CLIENT` / `409 CREDENTIAL_NOT_DISTRIBUTABLE` /
  `NOT_SERVER_DIALED`; `hnx mcp serve` stdio shim (low-level `Server`, JSON
  schemas pass through); install adapters emit ONE baked-path shim entry
  (Hermes simplified, install-time secret inlining gone) + **Codex adapter**
  (skills/prompts/TOML `[mcp_servers]` merge — 3.6 delivered); emitter
  `emitMode: client` default (stdio entry, no PAT env var) with `server`
  fallback (`EMITTER_MODE`); web dial-site/distributable forms.
- ✅ **C3 shipped (2026-09, branch `phase-8-c3`)**: daemon per-target scanners
  (claude-code `~/.claude` + `~/.claude.json`, codex `~/.codex` incl. TOML
  `[mcp_servers]` parse, hermes plugins/config.yaml/AGENTS.md) reporting
  normalized snapshots over `/ctl` (`inventory:scan|report|collect|payload`,
  auto-report after every hello, capability `inventory`); `machine_inventory`
  storage (migration `0008`, latest per machine+target, cascades on machine
  delete); `InventoryCoordinator` request/response waiters; pure
  `diffInventory` in shared (coarse MCP arm, hook entries skipped);
  `/api/machines/:id/inventory` + `/scan` + `/diff` + `/import` — import =
  collect → reuse-or-create (identical body reuses ⇒ idempotent re-import) →
  MCP items become `McpServer` rows with daemon-side env/header redaction to
  `${cred:<KEY>}` placeholders → a new personal profile owned by the machine's
  owner; `/app` `inventory:updated` push; MachineDetail web page (inventory
  tables, diff view, import wizard) linked from Machines rows; SDK inventory
  methods; vitest wired into the CLI package.
- ✅ **C4 shipped (2026-09, branch `phase-8-c4`)**: `Job` state machine
  (`queued → dispatched → running → succeeded | failed`, queued-only cancel;
  disconnect / ack-timeout-sweep recovery requeues with `attempts+1`, ≥
  `JOB_MAX_ATTEMPTS` ⇒ `failed JOB_ABANDONED`; terminal states ignore stale
  replay) in `JobService` (`app.realtime.jobs`); `AgentInstance` upserted per
  (machine, profile) on deploy success — the C5/C6 addressable unit;
  migration `0009` + both drivers; `/api/machines/:id/jobs` (POST deploy —
  soft `deploy`-capability gate when online, `409 TARGET_NOT_DEPLOYABLE` for
  claude-code which stays on the 3.5 emitter path) + jobs list + cancel +
  `/api/machines/:id/agents`; `GET /api/client/deploy-bundle` (machine PAT
  REST exception #2 — the resolved bundle the daemon's executor fetches);
  daemon `job:dispatch` handler reusing the UNCHANGED 3.3 pipeline
  (plan/apply/ledger, `job:progress` per phase); `/app` `job:update` push;
  MachineDetail Deployments card (deploy form, live jobs table, agent
  instances). C3's interactive scan/import stay direct request/response —
  jobs are for replayable fire-and-forget work.
- ✅ **T1 shipped (2026-09, branch `phase-8-t1-deepseek`)**: `deepseek`
  `AgentTarget` end to end. Research pinned to dsh `v0.1.2-rc.1`
  (`~/.dsh` home; home-level `cordis.patch.yml` applies to EVERY profile and
  hot-reloads live; Agent-Skills format with MANDATORY frontmatter
  name+description, kebab-case; `dsh-mcp-client` stdio rows; native
  `dsh --profile acp`). CLI adapter (`install/adapters/deepseek.ts`):
  skills → `~/.dsh/skills/<slug>/` with frontmatter synthesis, commands →
  flat `skills/<slug>.md` (the `/name` surface), MCP → per-profile MARKED
  region in the home patch (idempotent replace, other profiles' regions and
  user rows untouched), rule/sub_agent/hook skipped with warnings; C3
  scanner (bundles→skill, flat→command, patch rows keyed by `serverName`);
  C5 ACP row `['dsh', '--profile', 'acp']` (`HN_ACP_COMMAND_DEEPSEEK`
  override); C4-deployable; web target pickers. `HOOK_SUPPORT['deepseek']
= null` (the CC/Codex hook BRIDGES are opt-in per-profile packages).
  Surfaced + fixed a latent registry crash: stdio `auto` + missing
  credential (the C3-import `${cred:KEY}` shape) derives server-dial and
  crashed the fire-and-forget reload — now skipped with a warning
  (`registry-resilience.test.ts`). Supported harnesses (install + ACP):
  Claude Code, Codex, DeepSeek Harness.

## Release & CI infrastructure (2026-09)

Cross-cutting (not a numbered phase):

- ✅ **npm alpha shipped** — `@harness-nexus/{core,shared,mcp-runtime,sdk,cli}`
  @ `0.1.0-alpha.2`, public, `latest` = alpha by design (young tool, `npx`
  must work out of the box). Manifest prep: `files` allowlists, `exports`
  maps, `publishConfig.access`, `prepublishOnly` build guards,
  `packages/cli/README.md` as the npm landing page.
- ✅ **`ci.yml`** — install → build → typecheck → test on every push + PR
  (Node 20, the engine floor). First run green on `f37e746`.
- ✅ **`release.yml`** — manual workflow_dispatch publishing via **OIDC
  trusted publishing** (per-package trusted publisher registered on npmjs.com;
  zero npm credentials in GitHub). Encoded gotchas: pnpm lacks tokenless
  publishing → `pnpm pack` (workspace-version substitution) then
  `npm publish <tarball> --tag latest`; node ≥ 22.22.2 for npm@latest; npm ≥ 12
  requires an explicit `--tag` for prerelease versions.
- Manual channel (dev machine): granular bypass-2FA token + IP allowlist,
  `npm_config_registry=https://registry.npmjs.org/ pnpm -r publish`.
- Release procedure: bump the five manifests → push → run the workflow.

## Phase 9 — Harness runtime lifecycle 🚧 W1–W7 shipped (2026-09)

Manage the **harness software itself** on machines — presence, version,
install/upgrade, and the LLM provider/model configuration it runs with — the
piece users asked for after Phase 8 shipped artifact management only
("一键部署/升级 claude code / codex / dsh 软件本体，扫描 bin 与版本，可查看配置").

- Research: `docs/research/phase-9-harness-runtime.md` · Design:
  `docs/design/phase-9-harness-runtime.md` (both 2026-09). Rides the Phase 8
  machine/daemon/job infrastructure.
- Waves:
  - **W1 Agent-first inventory — SHIPPED (2026-09)** — `runtimes` arm folded
    into every inventory report (bin path, `--version`, install method;
    daemon `runtime` capability), Agent cards with items nested under them +
    "not installed" states (MachineDetail), `AgentInstance
(source: 'detected')` auto-registration with two-report hysteresis and
    deploy-precedence so **any detected Agent is chatable** (closes the
    emitter-installed claude-code gap), and capture-as-profile
    (`POST /api/machines/:id/inventory/capture`, zero-entry profiles allowed).
  - **W2 Install / upgrade / pin jobs — SHIPPED (2026-09)** — `type:
'harness'` jobs on the C4 pipeline (owner-only, `harness`-capability
    gated); daemon executor with npm command table + `claude update` for
    native CC upgrades + `DISABLE_AUTOUPDATER` settings merge; post-install
    re-probe auto-report; Agent-card Install/Upgrade/pin controls.
  - **W3 Provider config push — SHIPPED (2026-09)** — `RuntimeConfig` entity
    (migration `0012`, per machine × target) referencing a distributable
    credential; `PUT /api/machines/:id/runtime-config/:target` queues an
    `apply-config` harness job; the daemon fetches the resolved `{spec,
secret}` bundle at execution time (machine-PAT REST exception #3) and
    writes each harness's native slots merge-preservingly (CC `settings.json`
    env + model, codex `config.toml` root keys + provider section with
    `requires_openai_auth` + `auth.json` apikey, dsh provider+default-model
    patch rows + `~/.dsh/.env` — dsh's own user-env credential layer). §11
    open questions resolved with source-verified facts (research §8): codex
    removed `wire_api="chat"` (Responses-only), CC version-less installs
    track `@stable`.
  - **W4 Redacted config viewer — SHIPPED (2026-09)** — daemon-side
    `runtime:config.get` with key-name-aware masking (JSON walk, unanchored
    TOML/YAML line masking, wholesale `.env` masking, broken-JSON fallback;
    masked before upload, display paths only) over the inventory-style
    coordinator; `GET /api/machines/:id/runtimes/:target/config` (live
    round-trip, `runtime-config-view` capability gate); right-side Drawer in
    MachineDetail. "Re-scan after apply" dropped as a no-op (config files
    aren't scanned artifacts — the View button is the fresh read).
  - **W5 Modal containers — SHIPPED (2026-09)** — the shared `FormDialog`
    shell; every create flow (Profiles/Credentials/Mcp/Machines/Users,
    Resources re-shelled) opens in a modal instead of an inline Card. Also
    fixed the dev-only vite proxy swallowing `/mcp-servers`. Design:
    `docs/design/phase-9-portal-ui.md` §W5.
  - **W6 Portal chat — SHIPPED (2026-09)** — chat rebuilt as Agent cards →
    session page (`/chat/agents/:id`): left session list grouped by
    workspace cwd, right the portal-reference row stream (assistant steps,
    lifecycle tool rows, disclosure cards with Read/Diff/Terminal/Search/Io
    bodies, markdown + code highlight, turn tails, stick-to-bottom scroll).
    New sessions pick a subdirectory of the machine's `baseWorkspace`
    (migration `0013`; daemon-routed `workspace:list` picker; `directory` on
    `chat:session.open`); the `acpToolCallView` wire carries
    toolName/rawInput/content/output.
    Research: `docs/research/phase-9-portal-chat-ui.md` · Design:
    `docs/design/phase-9-portal-ui.md` §W6.
  - **W7 Native agent sessions — SHIPPED (2026-09)** — the platform
    persists NOTHING session-shaped (`ac_sessions` dropped, migration
    `0014`; ChatService is live-channel-only; "close" is now disconnect).
    The session rail lists the AGENT'S OWN store live (`sessions:list` over
    /ctl, capability `sessions`; claude-code/codex via adapter
    `session/list`, dsh via a multi-frame-zstd file scan of
    `~/.dsh/sessions`); row click resumes (`session/load` with replay for
    claude/codex, `session/resume` + transcript-parse for dsh) and history
    ships as `chat:history` — user blocks + ordinary events, folded through
    the same reducer; a per-channel ring replays on page-refresh rejoin.
    Design + adapter ground truth: `docs/design/phase-9-w7-native-sessions.md`.
    W7.1 addendum (SHIPPED): the in-process dsh event tap — spawn-time
    `--patch` insert of a zero-dep cordis plugin streaming the
    `session/event` bus over localhost JSON-lines — is the PRIMARY dsh
    streaming source (rig A/B: 107 deltas / 1ms median gap vs the tail's
    3–4 batches), with the transcript tail as fallback and
    `HN_DISABLE_DSH_TAP=1` as the A/B switch. Design:
    `docs/design/phase-9-w7.1-dsh-event-tap.md`.
  - **W8 Sender (composer) upgrade — SHIPPED (2026-09)** — the chat
    composer became a card-style two-row input (autogrow textarea +
    toolbar with a context-usage meter and a circular send/stop toggle),
    feature-shaped after the reference composer but styled per Signal;
    zero wire changes. The new `@agentclientprotocol` claude wrapper
    reports context occupancy too, so the meter is live for claude-code
    as well as dsh. Attach / permission-mode chip / model and effort
    selectors remain deferred stubs (each needs a wire arm first).
    Design + post-ship notes: `docs/design/phase-9-w8-sender.md`.
    **Shipped with it: the chat channel lifecycle hardening + budget
    redesign** (the W8 rig pass exposed three coupled defects — a page
    that never released the channel it left, a daemon that dropped
    closes racing the establishment, and a server that could not reap a
    restarted daemon's ghost channels; a full cap made sessions look
    empty). The budget itself was then redesigned per user feedback:
    12 total / 5 active per machine, eviction of the oldest non-busy
    channel instead of rejection, MACHINE_BUSY at prompt time, and
    open-channel visibility (listing `open`/`openChannelId` + rail rejoin
    instead of hidden rows). See the C5 design doc § "Channel lifecycle
    hardening" and § "Channel budget redesign".
- Non-goals v1: session-level model overrides, harness uninstall, zcode/hermes
  runtimes, managed-settings hierarchies. hermes native sessions remain an
  open follow-up (adapter surface unverified).

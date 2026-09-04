# Design: Phase 8 — Harness Nexus client (machines, MCP shim, realtime, ACP)

> Status: planned — written before implementation (2026-09). PRD:
> `docs/prd/phase-8-client.md` (decisions locked there are not re-litigated
> here). Absorbs Phase 5, 3.6, 3.7 and Phase 6's stdio bridge entry.

## What Phase 8 is

A control-plane / data-plane split. The server + web UI are the control plane;
a single client program (`hnx`, growing the existing CLI package) on each
enrolled machine is the data plane:

```
                       CONTROL PLANE                        DATA PLANE (per machine)
             ┌────────────────────────────────┐   WSS (Socket.IO)   ┌────────────────────────────┐
 browser ────►│ Fastify │  /api/*  REST        │◄──────────────────►│ hnx daemon (on-demand)     │
 (JWT/PAT;    │         │  /mcp    outlet      │ daemon → /ctl,/acp │  • heartbeat / jobs        │
  mutations)  │         │  socket.io /ctl      │ browser → /app,/acp│  • inventory scans         │
 browser ────►│         │  socket.io /app      │                    │  • ACP session manager     │
 (JWT/PAT;    │         │  socket.io /acp      │                    ├────────────────────────────┤
  live+chat)  │         │  Machine/Job/…       │                    │ hnx mcp serve (per process)│
             │         │  mcp-runtime         │                    │  ← stdio → agent tools     │
             └────────────────────────────────┘                    │  → dials distributable     │
                       ▲ platform tools +                         │    upstreams (memory creds)│
                       └─ non-distributable creds                     + platform /mcp (PAT)     │
                           pooled & exposed at /mcp                    (never touches the daemon)│
```

Layering rules are unchanged: `core` stays pure (new domain types + ports),
zod schemas in `shared`, sockets/routes in `server`, client code in `cli`.

## Package layout

| Package        | Change                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/cli` | Grows into the client: `src/daemon/` (socket client, `/ctl` + `/acp` handlers), `src/mcp-shim/` (C2), target scanners (C3). Keeps the 3.3 install pipeline unchanged as the job executor (C4). |
| `acp-bridge`   | **Deleted in C1** — its concerns move into `hnx daemon`.                                                          |
| `mcp-runtime`  | **New in C2**: `McpRegistry` extracted from `server/src/mcp/registry.ts`, made transport-agnostic (injectable `configProvider` + `secretResolver` instead of `UnitOfWork` + encryption key). Used by BOTH the server's `/mcp` and the client shim. |
| `packages/server` | `src/plugins/realtime.ts` (socket.io attach + per-namespace auth), `src/modules/machines.ts` / `agents.ts` / `jobs.ts` / `client-config.ts`. |
| `packages/shared` | `src/realtime.ts` — zod schemas for every envelope/event (single source for server, daemon, web).             |
| `packages/core`   | Domain: `Machine`, `AgentInstance`, `Job`, `AcSession` + repository ports.                                     |
| `apps/web`       | socket.io-client + Machines / machine-detail / jobs / chat pages.                                              |

New deps: `socket.io` (server), `socket.io-client` (cli, web). The server also
serves Socket.IO over the same HTTP port (`path: /socket.io` default) so TLS and
`PUBLIC_BASE_URL` are reused as-is.

## Data model

New domain entities (`packages/core/src/domain/`); scope model follows the
existing convention (personal = owner-only; admin sees everything, and
owner-only mutation questions do not arise — machines are always personal).

```ts
Machine {
  id, ownerId,
  name,                    // user-assigned
  hostname, os, arch,      // reported at hello (informational)
  daemonVersion, capabilities: string[],   // e.g. ['mcp-shim','deploy','acp']
  remoteChatEnabled: boolean,              // default FALSE — gates /acp (C5)
  enrollmentPatId,                          // the machine PAT bound to this machine
  enrolledAt, lastSeenAt,
}   // online/offline is DERIVED from socket presence, never stored as truth

AgentInstance {
  id, machineId, ownerId,
  target: AgentTarget,     // 'claude-code' | 'codex' | 'hermes' | ...
  name,                    // e.g. "claude @ ~/work/proj"
  profileId?,              // applied profile, if any (reported by daemon)
  directory?,              // working directory / install location
  status: 'ready' | 'unknown',
  createdAt,
}

Job {
  id, machineId, ownerId,
  type: 'deploy' | 'import' | 'scan',
  status: 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'cancelled',
  payload: unknown,        // zod-validated per type
  result?: unknown, error?: string,
  createdAt, updatedAt,
}

AcSession { id, agentInstanceId, ownerId, openedAt, closedAt?, closeReason? }
```

Inventory snapshots: `MachineRepository.saveInventory(machineId, target, snapshot)`
keeps only the **latest** per `(machine, target)` (JSON blob + `collectedAt`) —
no history table in v1.

Storage: extend `UnitOfWork` with `machines`, `agentInstances`, `jobs`,
`acSessions` ports; implement in BOTH drivers + register in `factory.ts`
(architecture rule #3). SQLite migration `0006` adds `machines`,
`agent_instances`, `jobs`, `ac_sessions`, `machine_inventory`.

PAT extension (reuses Phase 1 + 3.5 precedent): a `machine` kind PAT carries
`scopes: ['machine-ctl']` and is linked to its `Machine` row via
`enrollmentPatId`. The REST auth hook rejects `machine`-scoped tokens (blast
radius = realtime only), exactly as it rejects `marketplace` tokens.

## Realtime protocol (Socket.IO over WSS)

### Connections & auth

| Client  | Namespaces      | Handshake `auth`                      | Verified by                                                                |
| ------- | --------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| daemon  | `/ctl` + `/acp` | `{ token: <machine PAT>, machineId }` | PAT valid + kind `machine` + `machineId` matches the PAT's machine + not revoked |
| browser | `/app` + `/acp` | `{ token: <JWT or PAT> }`             | existing bearer logic (same channel set as REST); per-event ownership checks |

A client's namespaces multiplex over **one** engine.io/WSS connection. `/acp`
is the only namespace both roles join; its middleware accepts either auth kind
and binds `{ role: 'daemon' | 'browser', …identity }` to the socket — every
`/acp` handler re-checks role + ownership.
Protocol version rides the `machine:hello` ack (`proto: 1`); breaking changes
bump namespace names (`/v2/ctl`), never silently mutate events.

### Isolation model (the four layers)

1. **Namespace = traffic class + client role + policy boundary.** Three
   namespaces: `/ctl` (machine management — daemon-only, machine PAT), `/app`
   (browser UI live data — browser-only, JWT/PAT), and `/acp` (interactive
   agent traffic — the one namespace both roles join). Each has its own
   middleware chain: `/acp` additionally checks `machine.remoteChatEnabled` and
   owner-only access; future rate limits attach per namespace without touching
   the others.
2. **Event names are namespaced by domain prefix**, `<domain>:<verb>` —
   `machine:hello`, `job:dispatch`, `acp:rpc`. Only whitelisted handlers are
   registered; anything else gets no handler (and thus no ack → sender timeout).
   Every registered handler validates its payload with the shared zod schema;
   malformed → ack error `proto:invalid`.
3. **Rooms are the only addressing mechanism.** Server→daemon: room
   `machine:<machineId>`. Server→browsers: room `acp:session:<sessionId>` (all
   viewers of one conversation). No broadcast-to-all ever.
4. **Envelope addressing + identity binding.** Every payload carries the ids it
   concerns (`machineId` / `jobId` / `sessionId`), and the server re-verifies
   them against the socket's identity: a daemon may only report its own
   machine's jobs; a browser may only rpc into sessions it can see (owner).

**Multiple channels per agent.** One `AgentInstance` may have N concurrent
conversation channels (two browser conversations, a second viewer on the same
one, …). Each channel = one `AcSession` = one `sessionId` = one daemon-side
agent subprocess = one room. Cross-talk is impossible by construction (every
`acp:*` event carries `sessionId`; rooms scope delivery). MCP serving is NOT a
channel on this bus — shims are independent per-process stdio servers and never
touch the daemon or the socket (MCP and ACP share only the PAT and server URL).

### Event catalog

`/ctl` (daemon ↔ server):

| Event              | Dir    | Payload                                             | Ack                       |
| ------------------ | ------ | --------------------------------------------------- | ------------------------- |
| `machine:hello`    | C → S  | `{ daemonVersion, os, arch, hostname, capabilities }` | `{ proto, machineId }` — also updates Machine metadata; on success the server replays queued jobs as `job:dispatch` |
| `job:dispatch`     | S → C  | `{ job: Job }` (full record incl. `payload`)        | ack = daemon accepted (delivery, not completion) |
| `job:progress`     | C → S  | `{ jobId, phase, message?, percent? }`              | —                         |
| `job:result`       | C → S  | `{ jobId, ok, error?, data? }` (terminal)           | ack = recorded            |
| `inventory:report` | C → S  | `{ target, snapshot }` (C3)                         | ack = stored              |
| `config:invalidate`| S → C  | `{ profileId? }` (advisory cache push, optional)    | —                         |

`/app` (server → browser UI push; browsers join `user:<userId>` on connect —
admins additionally join `admins` for fleet-wide presence; **pure push in v1**,
no browser→server events):

| Event            | Dir   | Payload                                            | Notes                                                       |
| ---------------- | ----- | -------------------------------------------------- | ----------------------------------------------------------- |
| `machine:status` | S → B | `{ machineId, online, lastSeenAt, daemonVersion? }` | on daemon connect/disconnect (`online` = socket presence)   |
| `job:update`     | S → B | `{ job: Job }`                                     | on dispatch / progress (coalesced ~1s) / terminal           |
| `agent:update`   | S → B | `{ machineId, agent: AgentInstance }`              | on registration/changes (C4)                                |

`/acp` (browser + daemon ↔ server; server routes, never originates content):

| Event               | Dir           | Payload                                          | Notes                                                        |
| ------------------- | ------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| `acp:session.open`  | browser → S   | `{ agentInstanceId }`                            | ack `{ sessionId }`; server checks machine online + remoteChatEnabled + owner; persists AcSession; emits `acp:session.start` to `machine:<id>` |
| `acp:session.start` | S → daemon    | `{ sessionId, agentInstanceId }`                 | ack = spawned; daemon spawns the ACP subprocess for that instance |
| `acp:session.ready` | daemon → S    | `{ sessionId, agentInfo }`                       | server joins browser sockets into `acp:session:<sid>`        |
| `acp:rpc`           | both → S      | `{ sessionId, body }` — `body` = one JSON-RPC frame (ACP) | browser→daemon: server emits to `machine:<id>`; daemon→browser: server emits to `acp:session:<sid>` |
| `acp:session.close` | both → S      | `{ sessionId, reason }`                          | terminal; daemon kills subprocess, room torn down            |
| `acp:session.closed`| S → both      | `{ sessionId, reason }`                          | confirmation + fan-out to other viewers                      |

ACP bodies are **framed JSON-RPC passthrough** in v1: the server routes and
persists (audit) without semantic understanding, so ACP protocol evolution does
not require platform changes. The browser renders method-aware UI
(`session/request_permission` etc.) from the method name. Semantic
interception (platform-side tool approval) remains possible later — translate
specific methods into dedicated events — without changing the framing.

### Division of labor: REST vs sockets, and the browser's boundary

Durable mutations (enroll/revoke machines, create jobs, profiles, resources)
stay on **REST** — one auth/validation/audit surface. Sockets carry what REST
cannot: **server push** (`/app`) and **streams** (`/acp`). The browser
**never connects to a daemon** — the platform is the sole routing point
between `/app`/`/acp` and `machine:<id>` rooms, which is also what keeps
ownership checks and session audit centralized. Browser JWT expiry
mid-connection: the server drops the socket on auth failure, and the web
client re-reads its token on every Socket.IO reconnect attempt (fresh JWT
after re-login) — a token refresh needs no extra protocol support in v1.

### Reliability & limits

- **Job delivery is push + replay**: dispatches carry an ack timeout; un-acked
  jobs stay `queued` and are replayed after the next successful `machine:hello`
  (jobs are idempotent by `jobId`; the 3.3 pipeline's plans are idempotent
  overwrites). No lost-dispatch window.
- **ACP has no resume in v1**: on daemon disconnect the server marks all its
  sessions closed (`reason: 'connection-lost'`) and notifies viewers.
- Socket.IO built-in ping/pong is the heartbeat; presence = socket in
  `machine:<id>` room; `lastSeenAt` updated on every packet. Machine status is
  honest by construction (no daemon ⇒ offline).
- `maxHttpBufferSize` set explicitly (default proposal: 8 MiB) — bounds ACP
  payloads; configurable via env.
- All event schemas live in `packages/shared/src/realtime.ts`; server, daemon,
  and web import the same definitions.

## MCP serving model (C2)

### Shim process model

The "client MCP proxy" is **not a server** — it is a set of per-session
aggregator processes:

```
agent tool ──stdio──► hnx mcp serve --profile <id> [--server <url>]   (spawned by the tool)
                        ├── dials distributable upstreams directly (${cred:NAME} resolved in memory)
                        └── dials platform /mcp?profile=<id> (PAT)   (server-side tools + locked creds)
```

- Spawned by the agent tool per session; dies with it; upstream connections
  release naturally. **No TCP listener, no port allocation, no daemon
  dependency, no "daemon down ⇒ MCP dead" failure mode.**
- One stdio entry per profile in every target's config (`.mcp.json`,
  `config.toml`, Hermes `mcp_servers`) — stdio is every target's greatest
  common denominator, which is what deletes the proxy/direct split and makes
  stdio-only targets (Codex) first-class.
- Install paths **bake the absolute path** of `hnx` into the stdio entry
  (GUI-launched tools lack PATH). Known edge: the 3.5 emitter's zips are
  machine-independent and cannot bake a path — that flow requires `hnx` on PATH
  (documented; the HTTP/PAT emitter mode remains the no-`hnx` fallback).
- Config is fetched at shim start ⇒ changes apply on the next agent session
  (consistent with how tools snapshot MCP tool lists today).
- Accepted trade-off: concurrently running tools each dial upstreams
  independently (N tools = N upstream connections). Fine on single-user dev
  machines; a "share connections with a running daemon if present" hybrid
  broker is a future option, not v1.

### Dial-site routing (derived, not configured)

Per profile entry referencing an `McpServer`:

1. `McpServer.dialSite` (new field): `'auto' | 'client' | 'server'`, default
   `'auto'`.
2. `auto` → **client** iff the server's transport config references no
   credential, or every referenced credential is distributable; else **server**.
   (`Credential` gains `distributable: boolean` — forced `false` for global
   scope unless an admin opts in; personal scope is implicitly distributable.)
3. `'server'` override exists because reachability is not only a credential
   question — e.g. upstreams only the platform's VPC can reach must be dialed
   server-side even with distributable creds.
4. Server-side pooling condition (2.2's `mode === 'proxy'`) becomes
   "resolves to server". The platform `/mcp?profile=<id>` outlet exposes
   exactly the server-dialed set (+ future platform-hosted tools); the shim
  merges its locally-dialed set with the outlet's namespaced tools into one
  stdio view. Each upstream is dialed by exactly one side — no duplication.

### Config fetch & secret flow

`GET /api/client/mcp-config?profile=<id>` (machine PAT or user PAT; profile
visibility rules apply) →

```json
{ "profileId": "…",
  "platform": { "baseUrl": "https://…", "profileId": "…" },   // shim dials /mcp if any entry is server-dialed
  "servers": [ { "id": "…", "name": "…", "transport": { …resolved… } } ] }
```

`transport` carries **resolved** values (placeholders substituted) for
client-dialed servers only — i.e. the response contains plaintext secrets only
for credentials whose distributability explicitly permits it, over TLS,
authenticated. Server-dialed servers are listed by name but return **no
transport** (the shim needs nothing to use them — they arrive via the outlet).
Unit tests assert non-distributable plaintext never appears in any response.

### Migration & deprecation

- `McpServer.mode` is dropped (SQLite migration folds `proxy`→`auto`,
  `direct`→`client`); `409 STDIO_REQUIRES_DIRECT` and install-time
  `${cred:NAME}` resolution disappear — the 3.3 adapters emit one stdio entry
  per profile instead.
- The server `/mcp`, registry pooling, and the 2.4 connect surface keep
  working throughout; their role narrows to the outlet. The 2.4 status surface
  becomes per-machine (shims report their locally-dialed liveness with
  inventory/scan jobs; the server-side pool reports server-dialed rows).
- Emitter: `emitMode: 'client' | 'server'` (default flips to `client` once C2
  ships; `'server'` keeps today's HTTP + `${HN_PAT_*}` output as the
  no-`hnx` fallback).

## Jobs & remote deploy (C4)

Job lifecycle: `queued → dispatched → running → succeeded | failed | cancelled`
(persisted; `dispatched` entries older than the ack timeout revert to
`queued`). A deploy job's payload `{ target, profileId, name, directory? }`
reuses the **unchanged** 3.3 pipeline (resolver → adapter → plan → apply →
ledger) inside the daemon; `job:progress` maps to plan/apply phases. On
success the daemon reports the created `AgentInstance` in `job:result.data`,
and the server registers it. `hnx install` remains as the manual local path —
same code, different trigger.

## Inventory, diff & import (C3)

- Daemon scanners per target read the same ground-truth locations the 3.3
  adapters write (CC `~/.claude` plugins/skills/agents/`mcpServers`; Codex
  `~/.codex`; Hermes plugin dirs) and report a **normalized** snapshot:
  `{ target, agents: [{ name, directory, profileApplied?, items:
  [{ kind, name, source-ish descriptor }] }] }` via `inventory:report`
  (triggered by a `scan` job or daemon start).
- The server stores the latest snapshot and computes **diffs against a
  profile** (`GET /api/machines/:id/inventory/diff?profile=<id>`): profile
  entries missing on the machine / machine artifacts missing from the profile
  / both. Profile truth lives server-side — diff logic is pure and testable.
- **Import** = an `import` job carrying a selected subset of the snapshot: the
  daemon uploads artifact bodies; the server creates `Resource`s (reusing the
  4.2 backend and 3.5's `{resourceId, kind}` entry arm) and bundles them into
  a new profile. No new permission surface — ordinary resource/profile rules.

## ACP chat (C5)

Routing: browser ↔ server (`/acp`) ↔ daemon (`machine:<id>` room) ↔ local
agent subprocess (ACP over stdio). Prerequisite research: a per-target
**ACP adapter matrix** (which agents speak ACP natively, which need a wrapper
process, e.g. community ACP adapters) — C5 starts with that research doc.
Gating: `machine.remoteChatEnabled` (default off) + owner-only + per-session
`AcSession` rows retained as audit. The daemon's session manager owns
subprocess lifecycle (spawn on `acp:session.start`, kill on close/disconnect,
cap concurrent sessions per machine).

## Security model

- **Enrollment is explicit consent** (`hnx enroll` is interactive; the response
  token is shown once, 3.5-reveal-dialog style) and revocable per machine
  (deleting a machine revokes its PAT ⇒ realtime access dies immediately).
- **Machine PAT blast radius**: REST API rejects `machine`-scoped tokens; a
  leaked machine token reaches only the realtime channel of its own machine.
- **ACP is a remote-code-execution surface by design.** Remote chat off by
  default, owner-only, session audit rows, concurrent-session cap, message
  size cap. These are load-bearing, not decorations.
- **Secrets**: resolved upstream secrets exist only in shim process memory;
  the sole at-rest client secret is hnx's own token file (0600; OS keychain
  later). Non-distributable credentials never appear in any client-visible
  response — asserted by tests.
- Server-side request-log masking extends to socket frames (tokens/URLs in
  payloads never logged raw).

## Web UI

- **Machines** page: list with honest online/offline via `/app`
  `machine:status` push (online → `bg-ok` per the 2.4 mesh precedent; never
  faked), daemon version, capabilities, remote-chat toggle (confirm-first),
  revoke.
- **Machine detail**: agent instances, latest inventory per target,
  profile diff view, "import to platform" flow.
- **Create agent**: target + profile + machine wizard → deploy job with live
  progress via `/app` `job:update` push.
- **Jobs**: per-machine job list with status/progress.
- **Chat** (C5): session list + conversation view; permission prompts render
  from ACP method names. All new routes register in `navItems()`.
- Signal system rules apply unchanged (`--signal` stays reserved for liveness).

## Development plan (C1–C6)

Each phase lands independently verifiable; build order follows the dependency
chain, and each phase's docs update (this file + roadmap) happens with it.

**C1 — daemon + machine registration.**
core (Machine, ports) → shared (PAT kind, `realtime.ts` v0: hello/dispatch
shapes) → server (`realtime.ts` plugin with `/ctl` + `/app`, `modules/machines.ts`,
repos + migration, REST-hook machine-token rejection) → cli (`hnx enroll`,
`hnx daemon`, socket client) → web (socket.io-client `/app` feed + Machines
page). Delete `acp-bridge`.
Verify: schema unit tests, presence tests, smoke enroll → online → revoke →
offline.

**C2 — client MCP serving.**
core/shared (`Credential.distributable`, `McpServer.dialSite`, mode removal,
migration) → `mcp-runtime` extraction (server first, shim second) → server
(`client-config.ts` module + secret-leak tests, outlet narrowing, emitter
`emitMode`) → cli (`hnx mcp serve` + stdio entry emission in install
adapters; Codex adapter lands here as the trivial case) → web (config UI for
the two new fields; per-machine status view). Verify: routing-derivation unit
tests, shim E2E vs fixture upstreams, emitter zip snapshot tests.

**C3 — inventory + diff + import.**
shared (snapshot schema) → server (inventory storage + diff endpoint + import
job handler) → cli (scanners) → web (machine detail + import wizard). Verify:
diff unit tests (pure), report→diff→import smoke.

**C4 — remote deploy.**
server (job dispatch/replay, AgentInstance registration) → cli (job executor
wrapping the 3.3 pipeline) → web (create-agent wizard + jobs view). Verify:
dispatch→progress→result smoke incl. offline-queue replay.

**C5 — ACP chat.**
research (adapter matrix) → shared (`/acp` schemas) → server (`/acp` routing +
gating + session persistence) → cli (session manager + subprocess spawn) →
web (chat UI). Verify: session open→rpc round-trip smoke against a fixture
agent; gating tests (remote chat off ⇒ refused).

**C6 — orchestration.** Not designed. C1–C5 deliver its substrate: machines
(placement), AgentInstances (addressable units), AcSessions (invocation +
observation channels).

## Verification (overall)

- `pnpm -r typecheck` + per-package builds after each phase (composite
  references need `dist` in dependency order: core → shared → server/cli/web).
- Vitest: `shared/realtime` schemas, routing derivation, diff logic, auth
  middleware, secret-leak assertions. Existing 2.2/2.4/3.3 tests must stay
  green through the C2 migration (the outlet keeps the old `/mcp` contract).
- `scripts/smoke.mjs` grows one block per phase (see plan above).

## Out of scope (explicit)

- Session resume; offline/keychain config cache; hybrid connection broker;
  multi-user machines; machine-to-machine features; orchestration design;
  platform-hosted tools themselves (outlet only); content scanning.

## Open questions

- C5: exact per-target ACP process wiring (native vs wrapper adapters) —
  resolved by the C5 research doc before implementation.
- C2: emitter default flip timing (`server` → `client`) — decide at C2 ship
  based on `hnx` install base; the flag makes either default cheap.
- Whether `config:invalidate` (advisory push) earns its complexity once shims
  are the only config consumers (they re-fetch per session anyway) — likely
  dropped in implementation.

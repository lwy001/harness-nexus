# PRD: Phase 8 — Harness Nexus client & Agent orchestration

> Status: scoped (2026-09), implementation not started. Sub-phases C1–C6.
> Technical design: `docs/design/phase-8-client.md` (read together with this).
> Absorbs: Phase 5 (ACP bridge), 3.6 (Codex adapter — largely trivialized by the
> stdio unification), 3.7 (cross-target import), and Phase 6's stdio bridge entry.

## Problem Statement

Harness Nexus today is an **asset-integration platform**: it stores MCP server
definitions, resources, and profiles, and a human installs them by running
`hnx install` on some machine. Three gaps separate that from what users actually
operate day to day:

1. **The platform cannot see the machines it serves.** There is no machine
   registry, no liveness, and no remote management. Every change is a manual CLI
   invocation on a box the platform knows nothing about; drift between a
   machine's real state and its profiles is invisible.
2. **Agent instances are invisible.** The platform manages assets but not
   agents. It cannot answer "which agents run on my laptop, which profile each
   has, and what differs between what's installed and what the profile says".
   Importing an existing agent's plugins/tools back into the platform (Phase 3.7)
   was never built.
3. **There is no interaction path — hence no orchestration substrate.** Once
   installed, an agent is unreachable from the platform: no chat, no ACP, no way
   to drive it. The MCP story is also split-brained: server-side `proxy` mode
   (needs server-reachable upstreams; stdio impossible) vs `direct` mode
   (resolved secrets written into local config files; per-target formats).

## Solution — vision shift and a control/data-plane split

Harness Nexus becomes an **agent orchestration platform**. The server + web UI
are the **control plane** (users, config, profiles, credentials, machines, jobs,
orchestration logic); a single **Harness Nexus client** program (`hnx`) on each
enrolled machine is the **data plane** (MCP serving, deploy execution, inventory
scanning, ACP bridging). Everything before orchestration is substrate
engineering for it:

| Sub-phase | Delivers                                                                                                       | Absorbs / impacts                            |
| --------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **C1**    | Client unification + machine registration: `hnx daemon`, `Machine` entity + enrollment, WSS control channel      | Phase 5 (half), deletes `packages/acp-bridge` |
| **C2**    | Client MCP serving: stdio shims, credential-distribution policy, dial-site routing, platform `/mcp` narrowing    | 2.1 `mode`, 2.2 pooling, 3.5 emitter, 3.6     |
| **C3**    | Inventory reporting + profile diff + one-click import                                                          | 3.7                                          |
| **C4**    | Platform-driven remote deploy (job abstraction over the 3.3 pipeline) + Agent instances                         | reuses 3.3                                   |
| **C5**    | ACP chat: bridge sessions + web chat UI                                                                        | Phase 5 (other half)                         |
| **C6**    | Orchestration — deliberately undesigned; C1–C5 are its substrate                                               | Phase 6 Channels (adjacent)                  |

Four decisions are **locked** from the design discussion (rationale in the
design doc):

1. **Credential distribution policy.** Global-scope credentials are
   **non-distributable by default** (admin opt-in per credential); personal-scope
   credentials are always distributable to the owner's own machines. The
   server-side `/mcp` endpoint is the **sole outlet** for non-distributable
   upstreams.
2. **Server `/mcp` is kept permanently, with a narrowed role**: the unified
   platform-side outlet for platform-hosted MCP tools (a future feature; the
   natural home if Phase 2.3 revives) and for upstreams whose credentials must
   not leave the server.
3. **The client daemon is on-demand.** No service installation requirement in
   v1. Daemon down = machine honestly shows offline, queued jobs wait, ACP
   unavailable. **MCP never depends on the daemon** (see #4).
4. **Agents consume MCP uniformly as stdio.** Each agent-tool process spawns a
   per-session shim (`hnx mcp serve --profile <id>`); the shim dials upstreams
   (or the platform `/mcp`) and speaks stdio to the agent. The
   `proxy`/`direct` mode distinction is deleted; dial site is derived from
   credential distributability with an admin override. Consequences: no client
   TCP listener, no port/security surface, stdio-only targets (Codex) become
   first-class, and resolved secrets exist only in process memory — never on
   disk.

**Realtime channel requirement.** Both the client daemon AND the web frontend
talk to the platform over **Socket.IO/WSS**, one bidirectional namespace per
role: `/app` carries everything browser-side — live status/job push, agent
chat messages, and agent control commands (model, thinking level, permission
mode) — and `/ctl` carries daemon-side management plus the interactive traffic
the platform routes down to machines (the daemon adapts it to each agent's
protocol; the platform never learns agent protocols). A strict `domain:verb`
event convention, room-based addressing, and per-session channel isolation
cover agents with multiple concurrent channels, and the channel pattern is the
substrate for future interactive features (channel-based file management, web
terminal). Browsers only ever connect to the platform (never to a daemon);
durable mutations stay on REST. The protocol is specified ahead of
implementation in the design doc so server, daemon, and web share one schema
set from day one.

## User Stories

### C1 — machine registration

- As a user, I run `hnx enroll --server <url>` on my laptop once; the machine
  appears in the Machines page with an honest online/offline indicator, and I
  can revoke it at any time (which kills its credential).
- As the platform, I know which machines exist, who owns them, whether each is
  connected right now, and what the daemon version/capabilities are.

### C2 — client MCP serving

- As a user, I install a profile and the target tool's MCP config gets **one
  stdio entry** (`hnx mcp serve --profile <id>`); no PAT or upstream secret is
  written into any target config file.
- As an admin, credentials I mark non-distributable never leave the server;
  tools that need them flow through the platform `/mcp` outlet.
- As a user on a laptop, stdio and localhost/LAN upstreams work — the platform
  server no longer needs to reach them.

### C3 — inventory, diff, import

- As a user, I open a machine's page and see each agent target's installed
  plugins/tools/skills and whether a platform profile is applied.
- As a user, I see a diff ("installed vs profile") and can one-click import the
  machine's artifacts into the platform as resources bundled into a new profile.

### C4 — remote deploy (Agent instances)

- As a user, I pick target + profile + machine in the web UI and click deploy;
  the machine's daemon runs the existing install pipeline and reports progress;
  on success an Agent instance is registered.
- As the platform, jobs are persisted, queued when the machine is offline, and
  delivered on reconnect.

### C5 — ACP chat

- As a user with remote chat explicitly enabled for a machine, I open a chat
  with one of its Agent instances from the web UI and converse with the local
  agent over ACP; sessions are logged and each concurrent conversation is an
  isolated channel.
- As a user mid-conversation, I can switch the agent's model / thinking level
  / permission mode from the chat header; the change is applied to the local
  agent and the new state is pushed back to every viewer.

## Implementation Decisions

- **Machine identity = a dedicated PAT** (kind `machine`, scopes
  `['machine-ctl']`), issued once at enrollment, revocable per machine.
  Machine tokens are **rejected by the REST API auth hook** (blast radius = the
  realtime channel only), mirroring the 3.5 `marketplace` token pattern.
- **Remote chat is off by default** and gated per machine. Conversing with an
  agent drives tool execution on the host — this is the highest-risk surface in
  the platform and is treated as such (consent, gating, session audit).
- **The only long-lived local secret is hnx's own credential file**
  (`~/.hnx/`, 0600; OS keychain later). Resolved upstream secrets are
  memory-only inside the shim.
- **Emitter output gains a client-proxy mode**: `.mcp.json` entries become
  stdio shims instead of `<PUBLIC_BASE_URL>/mcp` + `${HN_PAT_*}` placeholders.
  The HTTP/PAT form remains as a compatibility mode (machines without `hnx`).
- **Phase 2.4's status surface becomes per-machine**: upstream liveness is
  observed where it is dialed (shim reports; server-side pool reports for
  server-dialed upstreams).

## Testing Decisions

- Realtime envelope schemas live in `packages/shared` and get unit tests for
  parse-reject behavior; the server enforces them on receipt.
- Routing derivation (distributable → client-dial; override; fallback to
  platform outlet) is pure and unit-tested, including the "must never leave the
  server" assertions on the config-fetch API.
- Each sub-phase extends `scripts/smoke.mjs` (C1: enroll → online → revoke; C2:
  shim end-to-end against a fixture upstream; C3: report → diff → import; C4:
  dispatch → progress → result; C5: session open → rpc round-trip).

## Out of Scope (v1)

- ACP session resume after reconnect (v1: session closes; user reopens).
- Offline config caching on the client (needs OS keychain; later).
- Shared connection broker when multiple agent tools run concurrently (each
  shim dials independently in v1).
- Multi-user-per-machine and machine sharing between users.
- Orchestration (C6) design — intentionally deferred until C1–C5 land.
- Platform-hosted MCP tools themselves (the `/mcp` outlet is prepared by C2;
  hosting tools is a separate future phase — Phase 2.3's natural home).
- Channel-based file management and web terminal — the channel/room/envelope
  pattern is explicitly designed to carry them (own gating flags + audit), but
  they are not scheduled in C1–C6.

## Further Notes

- The existing server-side `/mcp`, registry pooling, and 2.4 connect surface
  keep working throughout; C2 narrows their role rather than deleting them
  (migration path in the design doc).
- `packages/acp-bridge` is deleted in C1; its concerns move into `hnx`.

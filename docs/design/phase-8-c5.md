# Design: Phase 8 C5 — ACP chat (remote conversation with a deployed agent)

> Status: **implemented** (branch `phase-8-c5`). Parent design:
> `docs/design/phase-8-client.md` § "ACP chat (C5)" + § "Realtime protocol"
> (the `/app`↔`/ctl` interactive rows). Research:
> `docs/research/phase-8-c5-acp-web-demo.md` — the web-demo study (permission
> round-trip, session-op pitfalls, fold/StreamBuffer) **and the completed
> adapter matrix** (claude-code/codex via official Zed ACP adapters, hermes
> native `acp_adapter`, zcode deferred).
> Verification: shared 49 / cli 13 / server 53 tests (chat integration 11:
> full round-trip incl. permission respond + timeout watchdog, busy gate,
> re-join, spawn-failed, ready-timeout, session cap, disconnect teardown,
> user/daemon close, gating matrix, existence hiding); smoke `[8 C5]` with
> the REAL daemon dist + fixture ACP agent — 266/266 overall; SQLite
> migration `0010` + audit rows retained past machine deletion verified.

## Scope

C5 makes a deployed `AgentInstance` conversational from the browser:

```
browser /app ──chat:*──▶ server (routing+gating+audit) ──chat:*──▶ daemon /ctl
                                                                │ spawn + ACP
                                                                ▼
                                                   local agent subprocess (stdio)
```

The platform never learns agent protocols. The daemon is the adaptation edge:
it spawns a per-target **ACP adapter subprocess** (newline-delimited JSON-RPC
2.0 over stdio), drives the ACP client side (`initialize` → `session/new` →
`session/prompt` …), and maps ACP `session/update` notifications onto a
small, stable **semantic stream** the browser renders. Everything the server
does is: ownership/gating checks, room fan-out (`chan:<sessionId>`), AcSession
audit rows, and the permission-request timeout.

1. **`AcSession` model** (`core/domain/ac-session.ts`, migration `0010`):
   `{id, agentInstanceId, machineId, ownerId, openedAt, closedAt?, closeReason?}`
   — one row per conversation channel, retained as **audit** (no FKs, rows
   survive machine deletion, closed with `machine-deleted` instead of
   cascade-deleted — the deliberate asymmetry vs jobs/inventory).
   `AcSessionRepository`: `findById` / `listByAgentInstance` /
   `listOpenByMachine` / `save`. UnitOfWork gains `acSessions`.
2. **Chat wire protocol** (`shared/src/realtime.ts`, C5 section): ACP-dialect
   block schemas (content blocks for prompts, tool-call views, permission
   options with verbatim `optionId`) + the semantic `chatStreamEventSchema`
   union + every `chat:*` event envelope (below).
3. **Server `ChatService`** (`server/src/realtime/chat.ts`, decorated
   `app.realtime.chat`, same pattern as `JobService`): session registry,
   gating, routing, permission watchdog, teardown on daemon disconnect /
   machine delete / revoke.
4. **Daemon session manager** (`cli/src/daemon/chat.ts` + `daemon/acp/`):
   minimal JSON-RPC stdio client, per-target adapter command table with env
   overrides, ACP↔semantic mapping, subprocess lifecycle (SIGTERM → SIGKILL
   on close/disconnect), permission + cancel handling.
5. **Web**: `/chat` page (agent picker → session list → conversation pane with
   streaming, tool rows, permission cards, stop button); MachineDetail gains
   the remote-chat toggle (confirm-first; PATCH endpoint exists since C1).
6. **SDK**: `updateMachine` (PATCH) + `listAgentSessions`.
7. **Config**: `CHAT_MAX_SESSIONS_PER_MACHINE` (3),
   `CHAT_PERMISSION_TIMEOUT_MS` (60s), `CHAT_READY_TIMEOUT_MS` (30s).
   Daemon: `DAEMON_CAPABILITIES += 'chat'`, version `0.4.0-c5`.

## Wire protocol (normative)

### `/app` browser ↔ server

| Event                     | Dir | Payload                                                 | Ack                                                                                                                                                          |
| ------------------------- | --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat:session.open`       | B→S | `{agentInstanceId, sessionId?}`                         | `{sessionId}`; errors: `AGENT_INSTANCE_NOT_FOUND`, `SESSION_NOT_FOUND`, `REMOTE_CHAT_DISABLED`, `MACHINE_OFFLINE`, `DAEMON_NO_CHAT`, `SESSION_LIMIT_REACHED` |
| `chat:message.send`       | B→S | `{sessionId, content: string \| PromptBlock[]}`         | `{accepted}`; errors: `SESSION_NOT_FOUND`, `SESSION_NOT_READY` (pre-ready), `SESSION_BUSY`                                                                   |
| `chat:turn.cancel`        | B→S | `{sessionId}`                                           | `{accepted}` (idempotent — cancelling an idle turn is a no-op)                                                                                               |
| `chat:permission.respond` | B→S | `{sessionId, requestId, optionId?}`                     | `{accepted}`; absent `optionId` = cancelled                                                                                                                  |
| `chat:session.close`      | B→S | `{sessionId, reason?}`                                  | `{closed: true}`                                                                                                                                             |
| `chat:session.ready`      | S→B | `{sessionId, agentInfo?}` (to `chan:<sid>`)             | —                                                                                                                                                            |
| `chat:session.failed`     | S→B | `{sessionId, error}`                                    | —                                                                                                                                                            |
| `chat:session.closed`     | S→B | `{sessionId, reason}`                                   | —                                                                                                                                                            |
| `chat:event`              | S→B | `{sessionId, event: ChatStreamEvent}` (to `chan:<sid>`) | —                                                                                                                                                            |

- `open` **without** `sessionId` always creates a new channel (new AcSession +
  daemon subprocess). `open` **with** an open `sessionId` is an idempotent
  **re-join** (page refresh path): returns the same id, joins the socket to
  `chan:<sid>`, spawns nothing. Only the session owner may join (admins are
  explicitly NOT granted chat — talking to an agent executes code on the
  user's machine; documented non-goal).
- `SESSION_BUSY` is a server-side gate on the last known turn state
  (`session_status` events feed it); the daemon independently drops prompts
  that race past the gate and re-emits `active` to resync. One prompt in
  flight per session (the demo's follow-up queue is deferred).

### `/ctl` server ↔ daemon

| Event                     | Dir | Payload                                     | Notes                                                                                   |
| ------------------------- | --- | ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `chat:session.start`      | S→C | `{sessionId, agentInstanceId, target, cwd}` | ack `{accepted}`; spawn + `initialize` + `session/new`, then `ready` or `failed`        |
| `chat:session.ready`      | C→S | `{sessionId, agentInfo?, error?}`           | `error` ⇒ server closes the row (`spawn-failed`) + notifies the room                    |
| `chat:message.send`       | S→C | `{sessionId, prompt: PromptBlock[]}`        | daemon sends `session/prompt`; string content normalized to a text block server-side    |
| `chat:turn.cancel`        | S→C | `{sessionId}`                               | daemon sends `session/cancel`                                                           |
| `chat:permission.respond` | S→C | `{sessionId, requestId, optionId?}`         | forwarded verbatim; absent optionId ⇒ ACP `RequestPermissionOutcome::cancelled`         |
| `chat:session.close`      | S→C | `{sessionId, reason?}`                      | daemon `session/close` (3s) then kill; room torn down                                   |
| `chat:event`              | C→S | `{sessionId, event: ChatStreamEvent}`       | validated, then fanned out to `chan:<sid>`; ack `{accepted}`                            |
| `chat:session.closed`     | C→S | `{sessionId, reason}`                       | daemon-initiated (agent process exited / fatal) ⇒ server closes the row + notifies room |

### The semantic stream (`ChatStreamEvent`)

```ts
{ kind: 'message_delta', delta }                       // ACP agent_message_chunk
{ kind: 'thought_delta', delta }                       // ACP agent_thought_chunk
{ kind: 'tool_call', call: { toolCallId, title?, kind?, status?, locations? } } // tool_call(+_update), upsert by id
{ kind: 'usage', inputTokens?, outputTokens? }
{ kind: 'permission_request', requestId, toolCall, options[] } // options carry verbatim optionId
{ kind: 'permission_resolved', requestId, outcome: 'selected'|'cancelled'|'timeout', optionId? } // server-emitted
{ kind: 'turn_result', stopReason: 'end_turn'|'cancelled'|'max_tokens'|'refusal' }
{ kind: 'session_status', state: 'active'|'idle' }
{ kind: 'raw', method, params }                        // escape hatch (unmapped ACP updates)
```

Produced by the daemon (except `permission_resolved`, which the server emits
so every viewer's card settles). Live `user_message_chunk` updates are
dropped daemon-side (the browser echoes optimistically; there is no replay in
v1). This is the parent doc's semantic stream with the demo's pragmatic ACP
mapping: stable UI kinds, protocol churn confined to the edge.

## Server behavior (ChatService)

- **Gating order on open** (create path): AgentInstance exists + owned →
  machine exists + `remoteChatEnabled` (else `REMOTE_CHAT_DISABLED`) → online
  (else `MACHINE_OFFLINE`) → daemon capability `chat` (else `DAEMON_NO_CHAT`)
  → open-session count < cap (else `SESSION_LIMIT_REACHED`). Then: persist the
  AcSession row (`closedAt: null`), track it as `starting`, **join the opener's
  socket to `chan:<sid>` immediately** (implementation refinement of the plan:
  failure pushes must reach the browser even though the agent never came up),
  emit `chat:session.start` to `machine:<id>`, arm the **ready watchdog**
  (`CHAT_READY_TIMEOUT_MS` ⇒ close `spawn-timeout` + notify room).
- **`onReady`**: clears the watchdog; `error` ⇒ close `spawn-failed` +
  `chat:session.failed` to the room; success ⇒ mark `ready`, verify the opener
  socket is still connected (if the opener left before the agent came up,
  nobody is watching — close `connection-lost` instead of running a subprocess
  unattended), emit `chat:session.ready`.
- **`onChatEvent`**: session must belong to the reporting daemon's machine and
  be open → relay to `chan:<sid>`. `permission_request` additionally arms the
  **permission watchdog** (`CHAT_PERMISSION_TIMEOUT_MS`): on fire, forward a
  cancelled respond to the daemon and emit `permission_resolved
{outcome:'timeout'}` to the room. `session_status` feeds the busy gate.
- **Message send**: owner + open + not busy → normalize `string` →
  `[{type:'text', text}]`, forward to the machine room. (Machine offline ⇒
  `SESSION_NOT_FOUND`-style closure already happened via disconnect teardown,
  so no separate offline branch.)
- **Teardown**: daemon disconnect ⇒ close every open session of that machine
  (`connection-lost`, the "ACP has no resume in v1" rule), notify rooms;
  machine delete / revoke ⇒ same with `machine-deleted`; daemon-reported
  `chat:session.closed` ⇒ close with its reason. Closing = row update +
  room notification + `chat:session.close` to the daemon (skipped when the
  daemon is already gone).
- **Audit**: every open/close writes the AcSession row; `closeReason` ∈
  `user | spawn-failed | spawn-timeout | connection-lost | machine-deleted |
agent-exited | server-shutdown`. Rows survive machine deletion (no FKs);
  note the listing route (`GET /api/agent-instances/:id/sessions`) 404s once
  the agent row itself is cascade-deleted — retention is for the record, and
  the rows remain queryable at the storage layer.

## Daemon behavior

- **Adapter command table** (`daemon/acp/adapters.ts`):
  `claude-code → npx -y @agentclientprotocol/claude-agent-acp` (switched
  2026-09 from `@zed-industries/claude-agent-acp` 0.23.x — that wrapper never
  requested thinking on gateway/unknown models, so chat showed no thought
  stream; the official ACP-project wrapper streams `agent_thought_chunk` by
  default, rig-verified), `codex → npx -y
@zed-industries/codex-acp`, `hermes → python3 -m acp_adapter`, `zcode →
null`. Env override `HN_ACP_COMMAND_<TARGET>` (`-`→`_`, upper) replaces the
  whole command line (split on whitespace) — the hook tests and the smoke
  fixture agent (a ~120-line Node script speaking ACP v1 over stdio) use
  exactly this.
- **ACP client** (`daemon/acp/agent-connection.ts`): hand-rolled minimal
  JSON-RPC 2.0 client over the child's stdin/stdout — id correlation with
  per-request timeouts, notification fan-out, one request handler slot
  (`session/request_permission`). No new npm dependency (wire format is 3
  message shapes; the fixture agent proves compatibility).
- **Session manager** (`daemon/chat.ts`): per-session state
  `{acpSessionId, proc, busy, permissionWaiters}`.
  - `start` → spawn (cwd from the server payload, defaulting to the agent
    home) → `initialize {protocolVersion: 1}` → `initialized` →
    `session/new {cwd}` → `chat:session.ready {agentInfo}`. Spawn/initialize
    failure ⇒ `ready {error}` (server closes the channel).
  - `message.send` → `session:prompt`-map: emit `session_status active`,
    send `session/prompt`, resolve ⇒ `turn_result` + `session_status idle`.
    Busy race ⇒ drop + re-emit `active`.
  - `session/request_permission` from the agent ⇒ `chat:event
permission_request`; the server's respond (or timeout-cancel) resolves it
    with `selected {optionId}` / `cancelled` — `optionId` verbatim (demo
    pitfall #1).
  - `turn.cancel` → `session/cancel` (idempotent; resolve ⇒ `cancelled`).
  - `close`/socket-disconnect/exit ⇒ `session/close` best-effort (3s), then
    SIGTERM, 3s SIGKILL; child exit ⇒ `chat:session.closed {reason:
'agent-exited'}`.
  - Mapping (`mapAcpUpdate`): `agent_message_chunk`→`message_delta` (text
    blocks concatenated per chunk), `agent_thought_chunk`→`thought_delta`,
    `tool_call`/`tool_call_update`→`tool_call`, `usage_update`→`usage`,
    everything else → `raw {method:'session/update', params}`.

## Web

- `/chat` route (nav "Chat"): left rail = machine picker → that machine's
  AgentInstances (only online + chat-enabled machines enable the "New
  session" action); session list per agent (REST + live status); conversation
  pane. Conversation state is a pure `useReducer` fold (demo's fold.ts
  semantics, simplified: append deltas into the current block, upsert tool
  rows by id, `turn_result` sweeps running steps, `permission_resolved`
  settles the card). No StreamBuffer in v1 — socket.io coalescing plus React
  batching held up in the demo's own load profile; revisit if chunk floods
  render poorly.
- Permission cards render **from the payload's options** (never hardcoded
  allow/deny), send `optionId` verbatim, and auto-settle on
  `permission_resolved`/`turn_result`.
- MachineDetail: agents card gains a "Chat" action (deep-links `/chat`);
  remote-chat toggle with a confirm dialog (it is a remote-code-execution
  switch — the copy says so).
- Signal system: agent text uses default foregrounds; the live-turn spinner
  and the "agent active" status line use `--signal` (that is the view's one
  live thing); status colors (`bg-ok` idle etc.) are NOT used for chat
  liveness — `--signal` marks the live stream, muted marks closed.

## Security notes (load-bearing)

- Chat is **owner-only** (admins excluded by design — a chat turn executes
  tools on the owner's machine), gated by `machine.remoteChatEnabled`
  (default off, owner-toggled, confirm-first in the UI), machine online, and
  the daemon advertising `chat`.
- AcSession rows are the audit trail (who opened what channel when, why it
  closed) — retained past machine deletion (no FK, no cascade).
- The permission watchdog guarantees no dangling agent-side waiter: every
  `request_permission` gets an answer (selected / user-cancelled / timeout).
- Payload bounds: `maxHttpBufferSize` (8 MiB default) bounds frames; zod
  bounds prompt content (≤ 32k chars / ≤ 16 blocks), deltas ≤ 100k, options
  ≤ 8. `raw.method` ≤ 64 chars. The daemon never trusts server-sent paths —
  it only ever spawns from its own command table / env overrides.
- No fs/terminal/elicitation handlers are implemented daemon-side; agents
  that request them get a JSON-RPC method-not-found error and degrade.

## Out of scope (explicit, with rationale)

- `agent:control.apply` / `agent:state` (model, thinking level, permission
  mode): needs per-adapter capability matrices + `session/set_mode` /
  `set_config_option` negotiation — deferred to a C5.x/C6 slice; the parent
  doc's catalog row remains the target.
- Session resume/replay (`session/load`), session listing from the agent —
  v1 channels die with the daemon connection ("no resume" rule).
  **SUPERSEDED by Phase 9 W7** (`docs/design/phase-9-w7-native-sessions.md`):
  sessions are the agent's OWN — the platform persists nothing
  session-shaped, the rail lists the native store live, resume rides
  `session/load`/`session/resume`, and history ships as `chat:history`.
- Follow-up queue while a turn runs (server rejects with `SESSION_BUSY`;
  the UI disables send while active).
- Image/audio prompt blocks, `resource` blocks (schemas reserved, UI
  text-only), fs/terminal/elicitation channels, per-agent project cwd
  selection (v1 uses the agent home from `AgentInstance.directory`), message
  history persistence (rows are audit, not transcripts — content is never
  stored server-side), rate limiting beyond the session cap.

## Tasks (dependency order)

1. **core** — `domain/ac-session.ts` + `AcSessionRepository` port +
   UnitOfWork arm.
2. **shared** — ACP dialect + `chat:*` schemas in `realtime.ts`; unit tests
   (valid/invalid shapes, block normalization).
3. **server storage** — migration `0010` (no FKs) + sqlite/memory repos.
4. **server chat** — `ChatService` + realtime wiring (`/app` handlers:
   open/send/cancel/respond/close; `/ctl` handlers: ready/event/closed;
   disconnect teardown; machine-delete hook) + config keys.
5. **server routes** — `GET /api/agent-instances/:id/sessions` (owner-only,
   404-hiding) + app.ts wiring.
6. **cli** — `daemon/acp/` (connection + adapter table) + `daemon/chat.ts` +
   capability bump; fixture agent `packages/cli/test/fixtures/acp-agent.mjs`;
   unit tests (mapping pure fns + full round-trip vs the fixture through a
   fake socket).
7. **sdk + web** — `updateMachine` / `listAgentSessions` + `/chat` page +
   MachineDetail toggle/chat link + navItems.
8. **verify** — server integration `chat.test.ts` (fake daemon + fake
   browser): open→ready→send→delta→permission→respond→turn_result;
   re-open idempotent join; gating matrix (disabled/offline/no-cap/limit/
   busy); permission timeout; ready timeout; disconnect teardown; daemon
   close; owner-only. Smoke `[8 C5]`: REAL daemon dist + fixture agent via
   `HN_ACP_COMMAND_HERMES` — enroll → enable chat → deploy (C4 flow) →
   browser socket round-trip → close; gating assert first (disabled ⇒
   refused). `pnpm -r typecheck`, per-package builds, full smoke suite.

## Channel lifecycle hardening (post-W8 rig findings, 2026-09)

Chat channels are bounded by `CHAT_MAX_SESSIONS_PER_MACHINE` (3) and a channel
dies with its daemon socket. Three defects around that budget surfaced while
verifying W8 on the rig — each compounded the next, and together they produced
the observed symptom ("I click a session and the pane is empty"):

1. **The session page never released the channel it left.** A row hop called
   `chat:session.open` without closing the previous channel; the SPA socket
   survives navigation, and server teardown keys on the browser socket, so
   every hop leaked a slot. Three hops then filled the cap and every further
   open answered `SESSION_LIMIT_REACHED` — the page rendered an error strip
   over an empty stream. Fix: `openChannel` now **leaves before entering**
   (closes the previous channel before issuing the open, skipping the close
   when the target is a rejoin of the same channel), and the page closes its
   channel on unmount. Closing first also self-heals a full cap instead of
   deadlocking behind it — the old "close only after a successful open" shape
   skipped the close on the error path, so a rejected open left the previous
   channel live forever.

2. **A close that raced the establishment was dropped by the daemon.** With
   the page fixed, hops were still leaking adapter processes: `chat:session.close`
   looked up `sessions.get(id)`, found nothing (the spawn/establish takes
   seconds; the daemon had not registered the session yet), and did nothing —
   then the establishment finished and registered an orphan with no channel
   left to ever close it. Fix: the daemon records ids closed before
   registration (`closedBeforeReady`, consumed with `Set.delete`) and the start
   handler checks at two checkpoints (before the spawn, and immediately before
   registration — no await sits between that check and the `sessions.set`, so
   nothing can interleave). An aborted establishment kills the connection and
   emits no `ready`.

3. **A daemon restart wedged chat on its machine until the server restarted.**
   The server closes a machine's channels when it goes offline, but that reap
   is keyed on the offline→online *transition*, and a fast daemon restart
   registers the new socket before the old disconnect is processed — so the
   machine never "went offline" and the dead connection's channels kept their
   slots forever. Fix: the `/ctl` connection handler reaps the machine's live
   channels on **every** connection. The invariant that makes it correct: a
   newly connected daemon owns zero channels by construction (the daemon tears
   every session down in its socket `disconnect` handler), so any channel still
   live for that machine belongs to a connection that is gone.

Rig verification (post-fix): five rapid row hops (1.5s apart, well inside the
establishment window) hold the adapter count at 1 (a transient 2 during the
SIGTERM grace) and settle at exactly 1 = the live channel; the wire shows the
`close, open` alternation; a `kill -9` daemon restart mid-channel leaves the
page honestly closed with no cap error and a fresh resume succeeds — no server
restart needed. Regression tests: `server/test/chat.test.ts` ("a daemon
RECONNECT reaps …"), `cli/test/chat.test.ts` ("a close arriving DURING
establishment aborts it and kills the adapter", via the fixture's new
`FIXTURE_DELAY_NEW_MS` knob + a pid-file liveness assert).

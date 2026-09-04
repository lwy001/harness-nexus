# Research: Phase 8 C5 — ACP web-demo reference (web-vibecoding-demo)

> Status: **reference studied** (2026-09). Local copy: `/home/ubuntu/acp-ref/`
> (extracted from `/home/ubuntu/web-demo.7z`, 83 entries). This note distills
> what the demo teaches for C5 (ACP chat) and the future file-management /
> web-terminal channels. Parent design: `docs/design/phase-8-client.md`
> § "ACP chat (C5)".

## What it is

A minimal but complete "browser vibe-coding" loop from an internal demo
project, trimmed to three features: chat with an agent (streaming, tool-call
visualization, permission approval, session management), a web terminal
(xterm.js ↔ node-pty), and file management (file tree + Monaco + git diff).

```
browser (React)  ↔ socket.io '/'    Portal (Node :8090)          — dumb router + local fs/PTY gateway
Portal           ↔ socket.io /proxy acp-bridge (DSH plugin)      — maps DSH ↔ ACP, one agent per channel
```

Key source files (worth re-reading when implementing C5):

| File | Role |
| --- | --- |
| `acp-bridge/src/bridge.js` (660) | session lifecycle (new/load/fork/close/delete), prompt single-flight + followup queue, cancel watchdog, permission round-trip, reconnect registration |
| `acp-bridge/src/updates.js` (133) | **pure** DSH session-event → ACP `session/update` mapping — a working first row for our C5 adapter matrix |
| `acp-bridge/src/portal-client.js` (107) | socket.io back-connection; first-connect vs reconnect distinction |
| `portal/server.js` (631) | channel registry, envelope routing by `channelId` room, `/api/fs/*` gateway, `/terminal` PTY namespace |
| `portal/src/hooks/useAcpConnection.ts` (1352) | browser-side: all ACP message consumption, session ops with 90s timeout, optimistic insert reconciliation |
| `portal/src/model/fold.ts` (304) | pure fold reducer: update stream → conversation rows (O(1) hot path) |
| `portal/workspace-fs.js` (227) | path clamping (resolve + containment + symlink realpath), git status/diff |

## Protocol anatomy (envelope)

Every WS message is `{ type, channelId, payload, timestamp }`; `type` IS the
socket.io event name. Two families, exactly our `domain:verb` split:

- **control-plane** — `control.register` (agent online; capabilities gate the
  UI: `sessionCapabilities.{list,fork,delete}` show/hide buttons),
  `control.session_register` (`{sessionId, cwd}` — Portal tracks cwd for
  IDE/terminal), `control.session_status` (`active|idle` — turn-level
  busy/idle, sent on `turn/start`/`turn/end`), `control.permission_request` /
  `control.permission_response` / `control.permission_audit`,
  `control.proxy_status` / `control.agent_status` (Portal-generated on bridge
  connect/disconnect), `control.agent_restart`.
- **data-plane** — `acp` envelopes `{jsonrpc:'2.0', method, params}`:
  `session/{new,list,load,fork,prompt,cancel,close,delete,set_mode,
  set_config_option}` down, `session/update` up (streaming).

`session/update` shapes actually consumed by the frontend:
`user_message_chunk | agent_message_chunk | agent_thought_chunk | tool_call |
tool_call_update | available_commands_update | plan | usage_update`
(plus `current_mode_update | config_option_update | session_info_update` in
the standard). Tool name rides `_meta.claudeCode.toolName`; tool kind
(`read|edit|execute|search|fetch|other`) is derived by regex from the name.

**Request/response correlation is method-name + single-flight** — no
correlationId. One session op at a time with a 90s timer; the reply is the
same method with either a result object or `{error}`. Simple, and adequate
because ops are strictly serialized (see pitfalls).

## What C5 should adopt (candidate decisions)

1. **ACP as the chat payload dialect.** The demo's pragmatic middle is what
   our "daemon as adaptation edge" actually wants: browser and server speak
   **ACP-shaped payloads** (the de-facto standard — Zed's
   agent-client-protocol: ContentBlocks, `session/update` family,
   `requestPermission` options), and each daemon-side adapter maps
   agent-native events → ACP updates. `updates.js` is exactly this for DSH —
   the first proven row of our adapter matrix. Our envelope/auth/rooms stay
   as designed (`chat:*` events carrying ACP-shaped params).
2. **Turn-level status as a control event** — their `control.session_status
   active|idle` maps 1:1 to our planned `agent:state`; the UI's "generating"
   hinge is exactly this, and the demo shows what breaks when it's missing
   (see cancel watchdog).
3. **Permission round-trip semantics** (load-bearing):
   - `optionId` must be passed through VERBATIM (`allow_always | allow |
     reject`); any transformation counts as rejection.
   - 60s timeout ⇒ settle as `cancelled` (never leave a dangling waiter);
     agent-side abort signal also settles.
   - Every decision emits an audit event (`permission_audit`) — matches our
     AcSession audit requirement.
4. **Registration on EVERY (re)connect** — `control.register` +
   `control.session_register` are resent after socket.io auto-reconnect, or
   Portal/frontend think the agent is dead. (We already do this for
   `machine:hello`; chat session state needs the same treatment.)
5. **Session-op mutual exclusion + prompt single-flight**:
   - new/load/fork/close are serialized through a session-op promise chain;
     a prompt arriving mid-switch waits for it (else it lands on the OLD
     agent, which the switch then disposes — killing the turn).
   - Prompt while running: same session ⇒ `followup` queue; different
     session ⇒ reject (switching would kill the running turn).
   - "Load current session" is allowed while running (replay-only, no agent
     swap); loading a DIFFERENT session is not.
6. **Cancel watchdog**: upstream abort can hang; 60s after cancel with no
   `turn/end` ⇒ force-rebuild the agent (resume last session) and **re-emit
   idle** — otherwise every later prompt latches and the UI spins forever.
7. **Optimistic session insert + reconciliation**: `session/new`'s backing
   store lags (the new session isn't listed by `session/list` immediately);
   the frontend inserts optimistically from the response and keeps pending
   entries during list reconciliation.
8. **Streaming UI model** (web): fold reducer — pure, deterministic, O(1)
   append (concat into last block / upsert tool node by callId), plus a
   100ms StreamBuffer to batch chunk floods. Directly reusable in our chat
   page. Notable rules: tool row settles the current text step (no flicker);
   `turn_settled` sweeps ALL running steps/tools (idempotent tail); live
   `user_message_chunk` is suppressed (frontend echoes optimistically) but
   included during replay.
9. **fs/terminal gateway boundaries** (for our future channels): path
   clamping = resolve + containment + symlink realpath on EVERY op; terminal
   cwd clamped to workspace; PTY killed on socket disconnect; single PTY per
   socket; terminal data base64 over WS.

## What we do differently (locked, non-negotiable)

| Demo | Harness Nexus Phase 8 |
| --- | --- |
| Single user, every endpoint unauthenticated | JWT/PAT auth; machine PAT blast radius; chat additionally gated by `machine.remoteChatEnabled` (off by default), owner-only, AcSession audit rows, concurrent-session cap |
| Portal = dumb router; browser understands ACP fully | Server stays the routing/authorization point; daemon is the protocol-adaptation edge; browser consumes ACP-shaped payloads over our `chat:*` events |
| channelId in every envelope, room = channelId | Explicit ids in envelopes + identity binding; rooms are addressing only (`chan:<sessionId>`) |
| `onAny` passthrough on both sides | Whitelisted handlers only, every payload zod-validated (our isolation model) |
| One agent process per bridge connection | Daemon hosts a session manager with N sessions; AgentInstance rows make agents addressable platform-side |
| fs/terminal on the Portal itself (host machine) | fs/terminal must ride the daemon on the USER's machine via `/ctl` routing — never the server |

## Pitfall checklist (verbatim-critical, from their AGENTS.md + code)

- permission `optionId` passthrough; any field mangling = rejection.
- reconnect MUST resend register + session_register.
- session switch vs prompt mutual exclusion (adopt kills running turns).
- cancel needs a watchdog; after rebuild, re-emit `idle` or the UI hangs.
- optimistic session insert after `session/new` (store lags).
- request/response has no id — strict single-flight is what makes it safe.
- live user-message suppression vs replay inclusion (avoid double render).
- tool-call blocks in assistant messages are ignored — the dedicated
  `tool/call` event is the single source of truth.
- output ordering: updates are serialized through an `outputTail` promise
  chain so `session/prompt`'s ack never races ahead of the final chunks.
- DSH specifics that will generalize: static system-prompt overlay (template
  variables fail in headless mode), per-channel session registry file
  (multi-instance sharing one DSH_HOME), `trimToClosedPrefix` for fork seeds
  (events must be a closed prefix).

## Impact on the C5 plan

- The prerequisite "per-target ACP adapter matrix" now has one filled row:
  **DSH → ACP via bridge plugin (proven by this demo's `updates.js`/`bridge.js`)**.
  Remaining rows to research: Claude Code (native ACP adapters exist in the
  Zed ecosystem), Codex (community adapters), Hermes (wrapper needed; hooks
  model differs), zcode (unknown).
- C5's daemon session manager should be modeled on `bridge.js`'s state machine
  (inflight ctl, sessionOp chain, pendingToolCalls, permissionWaiter, timers
  set with unified disposal) — but multiplexed per session instead of one
  agent per connection.
- The web chat UI can port fold.ts + StreamBuffer nearly verbatim.
- Permission UI renders from `options` (server-declared), never hardcoded
  allow/reject — matches the "permission prompts render from ACP method
  names" line in the parent design.
- Envelope validation: we add zod schemas for the ACP shapes we accept
  (session/update family + permission options), keeping the
  whitelisted-handler isolation rule.

## Out of scope of this note

- Running the demo here (needs `dsh` + an LLM gateway; not reproducible in
  this environment). Findings are from source reading, which the thorough
  AGENTS.md in the demo corroborates.
- Multi-agent orchestration (their source project had it; trimmed out).

# Design: Phase 9 W7 — native agent sessions (list + resume, no platform session store)

> Status: **SHIPPED 2026-09** (branch `feat/p9-w7-native-sessions`).
> Post-ship ground-truth corrections folded into §Ground truth: dsh's
> `session` header entry carries its fields at the TOP level (no `data`
> wrapper), and Node's zstd APIs (sync AND stream) stop after the first
> frame of a multi-frame file — both caught by the smoke run.
> Post-ship fixes (`fix/p9w7-resume-leak-stale-model`, rig-found): a failed
> establishment now KILLS the adapter in the catch (every failed resume used
> to leak a live `dsh --profile acp` child of the daemon); the dsh listing
> flags stale-model sessions (`staleReason: 'model-missing'` — dsh validates
> the session's pinned route against the live provider catalog at resume, so
> a provider-config change orphans old sessions; the transcript's
> `request/header` pins the model, our W3 settings region is the catalog).
> Post-ship addendum — **dsh LIVE token streaming** (branch
> `feat/p9-w7-dsh-streaming-tail`): see §"dsh live streaming" at the end.
> User directive (verbatim intent): 会话不落到平台 —— 会话列表也不需要，所以也
> 不存在“关闭”一说；就使用各家自带的 resume 以及会话列表。
> Supersedes the C5 "no resume" boundary (`docs/design/phase-8-c5.md` §
> lifecycle) and the W6 session-list source (AcSession rows).
> References: `docs/design/phase-8-c5.md` (chat transport — unchanged),
> `docs/design/phase-9-portal-ui.md` (W6 session page — the surface W7 rewire),
> `AGENTS.md` § T1 (dsh ACP dialect).

## Problem

W6's session model is platform-centric: every channel writes an `AcSession`
audit row (`cwd`, derived `title`), the session rail lists those rows, and
"close session" is a first-class action with terminal semantics. That model is
wrong on three counts:

1. **The conversation belongs to the agent, not the platform.** Claude Code,
   Codex, and dsh all persist their own sessions on the user's machine and can
   resume them. The platform storing a parallel copy (even metadata) creates a
   second source of truth that drifts (sessions the user runs in their own
   terminal never appear; platform rows outlive the real session).
2. **"Close" is a fiction.** Killing the channel kills a subprocess, not the
   agent's session. With native resume, there is nothing platform-side to close.
3. **No resume means half a product.** Refreshing the page or reconnecting the
   daemon strands a conversation the agent could perfectly well continue.

W7 flips the model: the platform is a **live channel + renderer**; the session
list, the transcript, and the resume mechanics are the agent's own, read
through the daemon on demand. Nothing session-shaped persists server-side.

## Ground truth (researched on the rig, 2026-09-10)

The ACP spec (as bundled with dsh's SDK) standardizes the surface:
`agentCapabilities.sessionCapabilities = {list?, load?, resume?, close?, fork?}`
and `session/list → {sessions: SessionInfo[], nextCursor?}` with
`SessionInfo = {sessionId, cwd, title?, updatedAt?}`.
**`session/load` = load with replay** (the agent re-emits prior turns as
`session/update`s); **`session/resume` = resume without replay**. Both take the
session's original `cwd`.

| target      | adapter (rig-pinned)                              | caps                                                                          | list returns                                                                           | resume                                                                                                                                                                  |
| ----------- | ------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code | `@zed-industries/claude-agent-acp` 0.23.1         | `fork,list,resume,close` + legacy `loadSession:true`                          | `{sessionId, cwd, title, updatedAt}` (title = SDK summary; reads `~/.claude/projects`) | `session/load` **replays full history** as `session/update` (incl. `user_message_chunk`)                                                                                |
| codex       | `@zed-industries/codex-acp` 0.16.0 (Rust)         | `list,resume,close` + `loadSession:true` (auth-gated until codex auth exists) | SessionInfo (adapter-owned storage)                                                    | `session/load` (replay per spec)                                                                                                                                        |
| deepseek    | `dsh-acp` 0.1.2-rc.1 (native `dsh --profile acp`) | `close,list,resume` — **no `load`**                                           | `{sessionId, cwd}` ONLY (sorted newest-first, root sessions only, active excluded)     | `session/resume {sessionId, cwd}` — **cwd must match** (physical-directory check), rejects subagent/non-root/active; **restores the log without replaying old updates** |
| hermes      | `acp_adapter`                                     | unverified                                                                    | —                                                                                      | W7 ships **unsupported** (graceful empty list)                                                                                                                          |

### dsh transcript format (the no-replay workaround)

dsh persists every session at
`~/.dsh/sessions/<cwd-slug>/<uuid>/session.jsonl.zstd`:

- **Multi-frame zstd** — one frame per write batch. Node's one-shot AND stream
  zstd decoders stop after the first frame; the reader must scan the frame
  magic (`28 B5 2F FD`), slice, and decode each frame separately
  (`zlib.zstdDecompressSync`, Node ≥ 22.15 — machines running dsh already
  require ≥ 22.15).
- Entry types that matter (all others skipped):
  - `session` header `{id, createdAt, cwd, delegationDepth}` — root sessions
    are `delegationDepth === 0` with no `parentSession`.
  - `session/title {title}` — dsh's own derived title (usually early in the log).
  - `agent/inbox/spliced {inserted: [{content, role, id, source:{kind:'user'}}]}` —
    **the real user inputs**; their `id`s distinguish genuine turns from the
    synthesized runtime-context `user/message` entries.
  - `assistant/message {turn, step, message:{content blocks}}` — one COMPLETE
    message per step: `reasoning` / `text` blocks (full text) and `tool-call`
    blocks (superseded by the two below).
  - `tool/call {callId, name, arguments(JSON string)}` and
    `tool/result {message:{source:{callId}, content:[{content:[{text}]}]}}` —
    the tool lifecycle pair.
  - `turn/start` / `turn/end {reason:{kind}}` — turn boundaries.

## Model change — the platform stops persisting sessions

- **`AcSession` is deleted end-to-end**: core domain type + port +
  `UnitOfWork.acSessions`, sqlite + memory repos, the shared `acSessionViewSchema`,
  and migration **0014 `DROP TABLE ac_sessions`** (destructive by design — the
  table was audit-only metadata; the directive says sessions don't land on the
  platform). W1's detected-instance sync, the chat gates, and everything else
  that reads agent instances is untouched.
- `ChatService` becomes purely in-memory live-channel state: routing, gating
  order, permission watchdogs, and channel caps are unchanged. The boot sweep /
  orphaned-row closes / `machine-deleted` row settles all disappear (no rows).
- **"Close" is re-framed as "disconnect"**: the `chat:session.close` event
  keeps its name (wire compat) but means _drop this channel + subprocess_ —
  never any session finality. UI copy follows (断开, with a hint that the
  conversation stays with the agent). Machine deletion / daemon disconnect
  still tear channels down the same way.

## Session list — native, daemon-routed

- **REST**: `GET /api/agent-instances/:id/sessions` is **redefined** to
  `{agent, supported, sessions: NativeSessionView[]}` with
  `NativeSessionView = {sessionId, cwd, title?, updatedAt?}`. Still
  owner-or-admin with 404-hiding (chat itself stays owner-only).
- **/ctl**: server → daemon `sessions:list {requestId, target}`; daemon →
  server `sessions:list:result {requestId, sessions?, supported?, error?}`.
  New capability **`sessions`**; daemon version `0.10.0-p9w7`. Gates mirror
  the W6 workspace route exactly (error-arm BEFORE timeout):
  offline → `409 MACHINE_OFFLINE`, missing capability → `409 DAEMON_NO_SESSIONS`,
  daemon error → `502 DAEMON_SESSIONS_FAILED`, silence → `504 SESSIONS_TIMEOUT`
  (`SESSIONS_TIMEOUT_MS`, default 30s — an `npx` adapter spawn is slow cold).
- **Daemon strategy per target**:
  - claude-code / codex — spawn a short-lived adapter (the same command row as
    chat), `initialize`, `session/list`, kill. The adapter IS the vendor's
    session list; no storage-format coupling.
  - deepseek — **pure file scan** of `~/.dsh/sessions` (no adapter spawn, no
    auth): root sessions only, `cwd`/`createdAt` from the header frame, `title`
    from the `session/title` entry (bounded read — stop after the title or
    ~64 KiB), `updatedAt` from stat mtime, ids currently live in this daemon
    excluded. zstd unavailable (Node < 22.15) → `supported: true, sessions: []`
    plus an `error` note surfaced as a rail hint.
  - hermes / zcode / generic — `supported: false` (the rail explains; hermes
    support is a follow-up once its adapter's surface is verified).

## Resume

- Browser clicks a native session row → `chat:session.open {agentInstanceId,
resume: {sessionId, cwd}}` (the values came from the daemon's own listing —
  ground truth, not client input to validate against the workspace root).
- Server: the SAME gating order as a new session (owner → remote-chat → online
  → chat capability → channel cap). The baseWorkspace containment check
  applies ONLY to the `directory` (new-session) arm; a resume passes the native
  `cwd` through verbatim (dsh enforces its own match — a mismatch surfaces as
  a channel error, the rail re-lists).
- `chat:session.start` gains `resume?: {sessionId, cwd}`. The daemon spawns the
  adapter at that cwd and picks the method from the **advertised capabilities**
  (dialect-free, future-proof): prefer `session/load` (replay for free), fall
  back to `session/resume`. Neither → channel error ("adapter supports no
  resume").

## History — one wire shape, three producers

New daemon→server push, relayed to the channel room exactly like `chat:event`:

```
chat:history {sessionId, items: HistoryItem[]}   // ≤ 2000 items, daemon-side bound
HistoryItem = {type:'user', blocks: PromptBlock[]} | {type:'event', event: ChatStreamEvent}
```

Expressing history as **user blocks + ordinary stream events** (not a parallel
row model) means the browser folds it through the EXISTING reducer — one
rendering path for live and history.

1. **claude-code / codex (`session/load` replay)**: the daemon attaches its
   notification handler in _capture_ mode before calling `session/load`
   (claude's adapter replays BEFORE the load response resolves), maps captured
   `session/update`s with the existing `mapAcpUpdate` — except
   `user_message_chunk`, which becomes a `user` item instead of being dropped —
   and appends a synthetic `turn_result` if none arrived.
2. **dsh (`session/resume` + transcript parse)**: the daemon reads
   `session.jsonl.zstd` for that id and maps: spliced-inserted user inputs →
   `user` items; `assistant/message` blocks → `thought_delta`/`message_delta`
   events (full text); `tool/call`+`tool/result` → two `tool_call` events
   (parsed `rawInput`, output text, terminal status); `turn/end` →
   `turn_result`; usage chunks → `usage`. zstd unavailable → empty history +
   a rail/stream note (the session still resumes and continues).
3. **Live rejoin (refresh)**: the daemon keeps a bounded per-channel ring
   (synthesized `user` items for prompts it forwarded + the mapped stream
   events it emitted, last ~1000). `chat:session.resync {sessionId}`
   (server → daemon, sent when `chat:session.open` re-joins a live channel)
   re-emits `chat:history`. This also fixes the W6 wart where a page refresh
   wiped the visible transcript.

`chat:session.ready` gains `nativeSessionId` (the agent's own session id) —
the server remembers it on the live channel (re-push on rejoin) and the
browser uses it to highlight the rail row backing the open channel.

## Web

- The left rail lists **native sessions** (same cwd grouping, newest-first,
  relative time) and re-lists after every channel open/disconnect. Row click =
  resume. The live channel of this browser is highlighted via
  `nativeSessionId`; rows carry no open/closed state anymore (that concept is
  gone). Unsupported / offline / old-daemon each get a muted rail hint.
- New-session flow (DirPicker + baseWorkspace) is unchanged; resume bypasses
  the picker (the native cwd is authoritative).
- The "关闭会话" button becomes "断开" (`chat.disconnect`) — channel-only
  semantics, sessions never disappear from the rail because they were closed.
- The fold gains `{type:'history', items}`: rebuild from a fresh state — user
  items append user rows (no live-turn side effects), events fold sequentially
  through the existing event switch. Idempotent (a resync re-ingest resets
  first).

## Privacy

Transcripts still never persist platform-side (stronger than before: there is
no table to write them to). History transits the same authenticated
owner-only channel that live events already use, produced on demand from the
user's own machine.

## Test & verification plan

- **shared**: history-item + native-session schema bounds.
- **cli**: dsh transcript→history mapping (injectable frame decoder; a real
  zstd roundtrip test `skipIf` Node < 22.15); fixture agent
  (`test/fixtures/acp-agent.mjs`) gains `session/list` + `session/load`-with-
  replay arms; resume flow (load vs resume pick from advertised caps), resync
  ring, sessions:list per-target dispatch.
- **server**: sessions route gates (fake-daemon pattern from
  `test/workspace.test.ts`), open-with-resume passthrough + containment
  skip, `chat:history` relay, `nativeSessionId` on ready/rejoin.
- **smoke `[9 W7]`**: fixture-adapter list → open new → turn → disconnect →
  list shows the native session → resume → history present → continue turn.
- Rig: real claude-code list/resume (auth permitting), dsh list + resume with
  the zstd history (the rig's node is 22.23).

## Out of scope

- Surfacing `session/delete` / `session/fork`.
- hermes native sessions (unverified adapter surface).
- Cross-agent session import/export; editing or annotating history.
- Multi-viewer history fanout beyond the rejoin resync (single re-syncing
  viewer per channel).
- Pagination (`nextCursor`) — first page per cwd group is enough for the rail.

## dsh live streaming (post-ship addendum — `feat/p9-w7-dsh-streaming-tail`)

**The gap.** dsh's official ACP adapter (`@deepseek-ai/dsh-acp`) surfaces only
COMMITTED updates: a whole reasoning/text block arrives as ONE
`agent_message_chunk` when the turn ends; during generation the protocol
carries nothing (rig-verified with a timing probe on 0.1.2-rc.1, and by
pulling 0.1.5-rc.1 — same design). Every external ACP client inherits this;
dsh's own in-process bridges stream by subscribing the session event bus,
which an external client cannot reach. The ONE externally visible surface
that carries token batches live is the transcript file.

**Ground truth (verified against dsh 0.1.2-rc.1 source — the exact rig
version — via a reference source package of the engine loop, the JSONL
persistence codec, and dsh's own bridge mapper):**

- The engine appends one `assistant/chunk` session event PER LLM chunk
  (`data = { turn, step, chunk }`; chunk types `block-start | text-delta |
reasoning-delta | tool-call-delta | block-end | usage | finish`); a step
  ends with a committed `assistant/message` (`{ turn, step, message, usage? }`).
- Persistence coalesces via a bounded write-behind window (~100–300ms
  cadence) into one zstd frame per batch (append + fsync). A run of ≥3
  (`MIN_RUN`) seq-contiguous same-block deltas packs into ONE row —
  `text-chunks` / `reasoning-chunks` (`data = { turn, step, index, dt,
texts }`, texts NOT joined — token boundaries are data) / `tool-call-chunks`;
  shorter or split runs stay VERBATIM `assistant/chunk` events. **A reader
  must map both shapes** — skipping either silently drops content.
- dsh's own bridge maps these to ACP with a stateful `stepsWithDeltas` set
  keyed `"turn:step"`: committed messages for steps whose deltas already went
  out carry ONLY usage (re-sending the block would double-render); steps with
  no streamed deltas fall back to the complete blocks.

**The implementation** (all daemon-side, `packages/cli`):

- `TranscriptTail` (`daemon/dsh-sessions.ts`) polls the session's
  `session.jsonl.zstd` for appended bytes (default 250ms), splits new zstd
  frames, buffers a torn trailing frame until its remaining bytes land, and
  maps entries through `createDshLiveMapper()` — our mirror of the reference
  semantics: both delta shapes → `message_delta`/`thought_delta`; the
  `turn:step` committed dedup with full-block fallback; tools from
  `tool/call`/`tool/result` rows; usage from the commit (`inputTokens`/
  `outputTokens` — the wire's ctx-occupancy `usage_update` keeps flowing and
  the fold field-merges the two).
- **Wire suppression:** while the tail is live, the adapter's committed
  `agent_message_chunk`/`agent_thought_chunk` are dropped — the tail streams
  the same content AND its fallback covers commits, so the wire copy is
  always redundant; tools/usage still flow (idempotent by `toolCallId` /
  field-merged). A BOUNDED frame that fails to decode is mid-file corruption:
  the tail stops (`onFatal`), suppression lifts, and the committed path takes
  over (a partially streamed message may render once more — rare, never
  silent loss).
- **Attach lifecycle:** `ensureTail` runs at session ready AND at each prompt
  (a NEW session's file materializes lazily — it appears when the first
  prompt's user event flushes). A late attach may miss the turn's first
  batches, so the FIRST attach for a new session (never wire-rendered text —
  `wireTextEmitted`/`tailReplayEligible` flags) replays from BYTE 0,
  recovering them; a resumed session's file pre-exists with rendered history,
  so its tail skips to EOF. Concurrent attaches dedupe per native session id.
- **Turn-end ordering:** the wire settles when the agent idles, but the final
  write-behind batch (last deltas + commit + `turn/end` row) can land a beat
  LATER — a delta arriving after `turn_result` would open a NEW fold step
  (post-turn bubble). `runPrompt` therefore drains, then waits (≤600ms, 50ms
  steps) for the transcript's `turn/end` row before emitting `turn_result`.
  Rig-measured: the final batch lands ~34ms after the wire settles, so the
  common cost is one extra poll tick.
- **Degradation:** no zstd binding (Node < 22.15) or no file → no tail →
  committed-only streaming (the pre-addendum behavior) — suppression is keyed
  off a LIVE tail, never a pending attach, so it can never be active without
  the tail.

**Verification.** Unit: mapper semantics (both shapes, dedup, fallback,
ignores), tail (partial-frame recovery, settle signal, fatal, byte-0 replay
via the fixture seam). Rig (real dsh 0.1.2-rc.1 + deepseek-v4-flash):
progressive deltas precede `turn_result` with no duplicated text; tool turns
keep ONE stable callId across the dual sources; resume shows history and its
new turn streams without replaying pre-resume content; zero leaked
`dsh --profile acp` processes after repeated open/close. Daemon
`0.10.1-p9w7`.

**Upstream note.** dsh-acp could stream natively by mapping the same bus
events its own bridges consume (the reference implementation is the proof of
concept); until then the file tail is the only external streaming surface and
keeps working regardless — it depends only on the documented persistence
format, not the adapter.

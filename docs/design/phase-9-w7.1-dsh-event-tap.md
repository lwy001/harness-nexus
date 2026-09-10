# Design: Phase 9 W7.1 — dsh in-process event tap (streaming source upgrade)

> Status: **DESIGNED 2026-09-10, not implemented** — pick up with the
> implementation plan in §Rollout.
> Predecessor: `docs/design/phase-9-w7-native-sessions.md` § "dsh live
> streaming" (the transcript-file tail, SHIPPED as daemon `0.10.1-p9w7` —
> becomes the FALLBACK when this lands).
> User intent (verbatim): 总感觉扫文件不是一个长久之计，我们能不能也添加类似
> 插件进 DSH，在合适的时机添加进去 — i.e. mirror the reference project's
> in-process plugin approach instead of tailing the transcript file.
> References: dsh source at `~/acp-ref/dsh` (checked out at tag
> `dsh-v0.1.2-rc.1` = the rig's installed version; index in
> `~/acp-ref/README.md`); the reference bridge excerpts at
> `~/acp-ref/dsh-streaming-ref/` (engine loop / chunk-rows codec / its
> `updates.js` mapper — the semantics W7 already mirrors).

## Problem

W7's dsh streaming reads the transcript FILE. That works (rig-verified) but
couples us to the persistence encoding (multi-frame zstd, `MIN_RUN=3` packed
rows vs verbatim events, torn-frame buffering) and costs a write-behind
window (~100–300ms) + a 250ms poll interval per delta, plus a settle wait at
turn end. The reference project streams by subscribing dsh's in-process
session event bus (`ctx.on('session/event')`) from a cordis plugin — zero
latency, uniform event shapes, no encoding concerns. An external ACP client
cannot reach that bus… but we don't have to be external: **the daemon is the
process parent** of every chat adapter, and dsh has an official spawn-time
overlay for extra plugins.

## Spike results (verified on the rig, 2026-09-10 — all green)

1. `dsh --patch <path>` exists: "extra patch-list overlay applied after the
   profile layer (**repeatable**)" (`dsh --help`).
2. Path-based plugin mounts: a patch yml of `- insert:\n  - id: hnx-tap\n
   name: /abs/path/index.mjs` composes into `--profile acp --dump-config`
   (87 → 88 entries). NOTE: patch entries are id-targeted — a bare
   `- id: <new>` errors with `entry "<id>" not found`; NEW rows require the
   `- insert:` directive.
3. The plugin actually loads and runs at boot: a test plugin's `apply(ctx)`
   executed in a one-shot `dsh --profile headless --patch … "reply with just
   the word ok"` run (task completed, dispose marker written).
4. The bus subscription works: the same plugin counted **22 `session/event`
   deliveries** during that one short task — the streaming raw material,
   in-process, zero latency.
5. Constraint: dsh's stdio belongs to the ACP JSON-RPC protocol — the tap
   must NOT write to stdout/stderr protocol content; it talks to the daemon
   over its own localhost socket.

## Architecture

```
hnx daemon (chat session start, target deepseek)
  ├─ TapListener: node:net server on 127.0.0.1:0 (ephemeral port)
  │    env: HNX_TAP_PORT=<port> HNX_TAP_TOKEN=<one-time random>
  └─ spawn: dsh --profile acp --patch <tapDir>/patch.yml   ← assets shipped inside the hnx npm package
                │
                └─ dsh process
                     └─ hnx-tap plugin (zero-dep .mjs, insert-mounted)
                          ctx.on('session/event') ──▶ TCP JSON-lines ──▶ TapListener
                                                                       │ filter by acpSessionId
                                                                       ▼
                                                    createDshLiveMapper (SAME semantics as the tail)
                                                                       │
                                                    wire committed chunks suppressed (unchanged)
```

**Priority chain (purely additive — worst case equals today's behavior):**

1. Tap handshake within 3s of spawn → tap is the streaming source; do NOT
   attach a TranscriptTail at all.
2. No handshake (old dsh, `--patch` unsupported, plugin load failure,
   `HN_DISABLE_DSH_TAP=1` A/B switch) → today's `ensureTail` file tail,
   unchanged.
3. Neither → committed-only (pre-W7-addendum behavior).

## Components

### 1. The tap plugin — `packages/cli` ships it, path-mounted at spawn

- Files: `src/daemon/dsh-tap/index.mjs` (hand-written ESM, **zero deps**,
  never imports from `@harness-nexus/*`) and `src/daemon/dsh-tap/patch.yml`
  (`- insert:` entry pointing at `index.mjs` by ABSOLUTE path is impossible
  in a static file — so `patch.yml` is a TEMPLATE and the daemon renders it
  next to the plugin at boot, or simpler: the daemon writes a tiny per-boot
  patch yml into the hnx config dir (`~/.hnx/dsh-tap.patch.yml`) referencing
  the package-absolute plugin path. Decide during implementation; the spike
  proved the shape).
- Plugin body (~60 lines): `export const name = 'harness-nexus-tap'`;
  `export function apply(ctx)` reads `HNX_TAP_PORT`/`HNX_TAP_TOKEN` from
  env, `node:net.connect(127.0.0.1, port)`, first line
  `{"type":"hello","token":…,"pid":…}`, then one JSON line per bus event:
  `{"type":"event","sessionId":<session.id>,"event":<session event verbatim>}`.
  Forward ALL sessions' events (the DAEMON filters) — the plugin stays dumb.
  Reconnect with a small backoff while the process lives; `ctx.effect`
  disposal closes the socket. No config surface.
- Bus event shape = the verbatim session events W7 already maps
  (`{type:'assistant/chunk', seq, time, data:{turn, step, chunk}}` etc.) —
  persistence packing (`text-chunks` rows) NEVER appears on the bus, so the
  tap path exercises only the simple half of the existing mapper.

### 2. Packaging — assets must ride inside `dist/`

The rig overlay procedure copies ONLY `packages/*/dist`, and npm `files`
ships `dist` — so the tap assets must land in `dist/daemon/dsh-tap/` at
build time (a `node -e "fs.cpSync(...)"` step appended to the cli build
script; tsc won't emit `.mjs`/`.yml` verbatim). Runtime resolution from
`dist/daemon/chat.js`: `new URL('./dsh-tap/', import.meta.url)` — works in
the repo dev tree, the npm install, AND the container overlay.

### 3. Daemon side — `TapListener` + spawn composition

- New `packages/cli/src/daemon/dsh-tap-listener.ts`: net server, token check
  on the hello line (mismatch → destroy socket), buffered JSON-line parsing,
  `onEvent(sessionId, event)` callback, `close()`.
- `chat.ts` (deepseek arm only): create listener BEFORE `AcpAgentConnection.
  start` (the child needs the env); append `['--patch', <rendered yml>]` to
  the resolved dsh argv (the fixture agent must tolerate the extra argv —
  verify; it likely ignores argv entirely); race handshake vs 3s timeout;
  on handshake: feed events through the SAME `createDshLiveMapper` instance
  (one per session), filter `sessionId === acpSessionId`, suppression keys
  off the tap exactly as it keys off the tail today; on timeout: fall
  through to `ensureTail` (the existing replay-eligibility logic applies
  unchanged — a tap session never attached the tail, so `wireTextEmitted`
  semantics carry over).
- Turn-end ordering: keep the settle pattern but source it from the tap —
  after the wire settles, wait (≤600ms) for the tap's `turn/end` for this
  turn before emitting `turn_result` (typically instant on the bus).
- Teardown: close listener + socket with the session (add to `teardown`).

### 4. What does NOT change

- The wire suppression rule, the mapper semantics, the history ring, resync,
  resume flows, `TranscriptTail` itself (stays as fallback + still parses
  resume history), the server/web — **zero** server or web changes, no new
  daemon capability, no schema changes. Daemon version bump only.

## Edge cases to handle

- **Subagent sessions**: bus events carry the emitting session's id — the
  daemon filters to `acpSessionId`, so subagent noise (parentSession/
  delegationDepth sessions in the same process) never renders.
- **dsh upgraded, cordis API broke**: plugin throws/never connects → 3s
  timeout → file tail. Feature-detect, never fatal. The tap depends only on
  `apply(ctx)`/`ctx.on`/`ctx.effect` — the same surface the reference bridge
  uses in production.
- **Two chat channels on one machine**: one dsh process per channel (C5
  model), each with its own listener/port/token — no cross-talk.
- **Fixture agent (tests)**: `HN_ACP_COMMAND_DEEPSEEK` overrides the command;
  appended `--patch` argv must be ignored by the fixture (it reads JSON-RPC
  on stdin and ignores argv — confirm; if not, strip unknown flags there).
- **Do NOT write the patch into `~/.dsh` persistent config** — spawn-time
  `--patch` only. The home `cordis.patch.yml` is the user's surface (W3
  manages its marked region) and applies to every profile; our overlay must
  stay scoped to the processes we spawn.

## Test plan

- **Unit (plugin)**: import `index.mjs` in a test, call `apply(fakeCtx)`
  with a stub `ctx` (`on`/`effect` recorded); assert handshake + event
  forwarding against a local net server; assert token mismatch → server
  destroys; assert dispose closes.
- **Unit (listener + integration via fixture)**: fixture agent gains a
  "tap-speaker" mode (or the daemon's listener is tested directly): a
  spawned node process connects per `HNX_TAP_PORT` env and replays canned
  bus events → assert deltas stream, wire committed chunks suppressed,
  turn/end settles turn_result, fallback engages when the tap never
  connects (existing tail tests already cover path 2).
- **Rig E2E (A/B)**: re-run the archived streaming probe
  (`~/acp-ref/rig-stream-probe.mjs` — same three-turn assertions: count /
  tool / post-resume) with the tap live; then with `HN_DISABLE_DSH_TAP=1`
  to prove the tail fallback still passes; compare first-delta latency tap
  vs tail (expect the write-behind window + poll interval to disappear);
  leak-scan `dsh --profile acp` after the run.

## Rollout (implementation order for the new session)

1. Tap assets + build copy step + runtime path resolution (verify `dist/
   daemon/dsh-tap/` survives npm pack and the container overlay).
2. `dsh-tap-listener.ts` + `chat.ts` spawn composition + fallback chain +
   settle-from-tap.
3. Fixture tolerance for `--patch` argv + the two unit-test layers.
4. Local gates: `pnpm -r typecheck`, cli tests, build.
5. Rig: overlay per `docs/dev/test-rig.md` (git-ignored, on this machine),
   daemon restart, probe A/B, leak scan. NEVER push without the user's ask.
6. Docs: this file → Status SHIPPED + post-ship notes; AGENTS.md W7 section
   addendum; `docs/dev/test-rig.md` entry; DAEMON_VERSION bump
   (`0.11.0-p9w7.1`); branch `feat/p9-w7.1-dsh-tap` → `git merge --no-ff`.

## Out of scope

- Upstreaming native streaming to `@deepseek-ai/dsh-acp` (its
  `packages/acp/acp/src/updates.ts` self-describes as "derived from
  committed DSH session events" — the exact gap; a separate issue, for which
  the reference mapper is the proof of concept).
- Taps for claude-code/codex (their adapters already stream token-level).
- Removing `TranscriptTail` (it remains the fallback and the resume-history
  parser).
- Any persistent mutation of the user's `~/.dsh` (spawn-time overlay only).

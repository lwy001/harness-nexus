# Design: Phase 9 W11 — Adapter process lifecycle & session truth

> Status: **B (channel snapshot + tab bar + one-click cleanup) SHIPPED
> 2026-09-14** (server+web only, daemon untouched — see §B and the post-ship
> notes); A/C/D/E designed, not yet implemented. Trigger: three rig incidents
> in one day (see §1) exposed that adapter processes are the least governed
> object in the stack and that the session rail cannot answer "which of these
> are actually alive". Predecessors: C5's channel lifecycle notes and the W7
> "failed establishment kills the adapter" fix — this wave generalizes them
> from "close paths are correct" to "processes are ACCOUNTED for".

## Problem inventory (each with evidence)

- **D1 — Daemon hard-death orphans every adapter.** Adapters spawn
  `detached: true` (own process group — required for correct teardown,
  `agent-connection.ts:141`). Graceful shutdown tears channels down via
  `socket.close()` → the chat `disconnect` handler (`chat.ts:705`) →
  `teardown` → `conn.kill()`. But SIGKILL / OOM / a Node panic skips every
  handler: the detached groups reparent to init and run forever. Nothing
  sweeps them on the next boot — no pid ledger exists. Rig proof: 24 orphaned
  `codex-acp` processes reaped manually (2026-09-14, test-rig.md), plus 4 more
  from a single later experiment. Each is a full agent runtime holding memory
  and, for codex/claude, an open upstream session.
- **D2 — The rail's `open` state goes stale and lies by omission.** Rows are
  stamped `open`/`openChannelId` from the server's channel table at LISTING
  time (`modules/jobs.ts` sessions route). The page refreshes only on mount,
  on own-channel ready/closed, and on the manual button
  (`AgentSession.tsx:179-181,230,245`) — no polling, no push. A channel
  closed in another tab, evicted, or ended by `onViewerGone` leaves its row
  saying 已打开 until a manual refresh. Conversely a `closeWhenIdle` channel
  (viewer left mid-turn) shows 已打开 with nobody viewing — technically true
  (an adapter IS running) but indistinguishable from "someone is chatting".
- **D3 — Channel truth ≠ process truth, and only the former is visible.**
  The server's in-memory table is the sole liveness surface; there is no way
  to ask the MACHINE "which adapter processes are running" (the user's exact
  question — answerable today only by scanning `/proc`). A wedged adapter
  (alive but stuck, e.g. the pre-fix permission hang) shows as a healthy
  ready channel forever.
- **D4 — Every rail refresh respawns a listing adapter.** `sessions:list`
  for codex/claude spawns a short-lived ACP adapter per call (W7). With npx
  indirection that is ~2s of process churn per refresh per agent — which is
  exactly why the rail does not poll today, which is why D2 exists.
- **D5 — A transient network blip kills every channel on the machine.** The
  daemon treats ANY `/ctl` `disconnect` as final (`chat.ts:705`) while
  Socket.IO would have reconnected within ~1s; the server independently reaps
  its table on the offline transition. Surviving blips is cheap (grace
  window) and removes a whole class of "why did my channel close" surprises.

## Principles

1. **The daemon is the only process authority on its machine.** The server's
   channel table is a cache of CHAT channels, never a claim about processes.
   Process truth is asked from the daemon or not at all.
2. **Every spawned process group is ledgered before the spawn returns.** A
   crash may orphan a process, but never an UNACCOUNTED one.
3. **Never kill or count by process name.** The same machine legitimately
   runs user-initiated `codex`/`claude`/`dsh`. Only pgids WE created (via the
   ledger) are ours to reap.
4. **Push first, poll second.** Channel-state changes reach the browser as
   pushes; polling exists only as a backstop where push cannot (native
   session lists, which cost a daemon round-trip).

## A. Adapter ledger & boot sweep (daemon) — kills D1

`~/.hnx/adapters/` holds one JSON file per live adapter
(`<wireSessionId>.json`), written synchronously at spawn BEFORE
`AcpAgentConnection.start` returns, removed in `teardown` after the kill is
issued:

```
{ pgid, target, command, wireSessionId, nativeSessionId?, startedAt }
```

- **Boot sweep:** on daemon start, before `machine:hello`, iterate the
  ledger; for every entry whose `kill(-pgid, 0)` still succeeds (group alive)
  send SIGTERM → (3s, unref'd) SIGKILL, then delete the file. The sweep is
  safe by construction: pgids in the ledger were created by a previous daemon
  instance of the same user; pid reuse across daemon restarts is bounded by
  the sweep running before any new adapter is spawned.
- **Periodic audit (60s, unref'd interval):** ledger entries whose group is
  gone are file-deleted (crash cleanup); sessions map entries with a dead
  group are torn down (`onExit` already covers most, this is the backstop).
- **Ledger survives nothing else:** it is not a session store, not synced to
  the server, and carries no secrets (command line only — the credential
  lives in the machine's native config, never in argv/env of the adapter).

Tests (cli): sweep reaps a fake pgid recorded in the ledger; teardown removes
the file; a ledger entry with a dead pgid is dropped without signaling.

## B. Channel snapshot push + tab bar + one-click cleanup (server → web) — kills D2

> **SHIPPED 2026-09-14** — server+web only (daemon untouched). What follows
> is the as-built record; the tab bar and the cleanup button were added on
> user request during the design review.

The server emits `chat:channels` to the owner's `user:<id>` /app room
whenever the channel table changes for them (open, ready, closed, evicted,
busy flip) — a full per-user snapshot (small: ≤ dozen channels):

```
{ channels: [{ sessionId (wire), agentInstanceId, machineId, target,
               phase: 'starting'|'ready', busy, deferred,
               nativeSessionId?, openedAt }] }
```

- Emitted from `ChatService` at open / ready / every `closeInternal` / the
  `session_status` busy flip, and once on `/app` connect. A page that mounted
  LATER (SPA navigation — the socket survives it, so the connect-time push
  predates the mount) catches up via `chat:channels.sync`, whose ACK carries
  the same snapshot (rig-found: without it the tab bar rendered empty until
  the next table change).
- Schemas `chatChannelViewSchema` / `chatChannelsPushSchema` /
  `chatChannelsSyncRequestSchema` / `chatChannelsCloseAllRequestSchema` in
  shared; all additive, old clients ignore.
- **Tab bar** (`components/chat/channel-tabs.tsx` + `useChatChannels`):
  rendered at the top of BOTH chat pages (cards + session), hidden when the
  user has no live channels. One tab per channel: target badge (CC/CODE/DSH
  mono), native-id label, spinner while starting, a pulsing dot while busy,
  收尾中 when deferred. Click ACTIVATES: same agent → in-page rejoin; other
  agent → SPA route + `?ch=<wireId>` rejoin (dead-on-arrival falls back
  through the existing resume path). Tab × closes that one channel.
- **NO open path closes other channels.** The pre-tab leave-before-enter
  (free the budget slot before the next open is judged) is retired — the
  server has evicted-at-cap since the post-W8 budget redesign, so slot
  juggling is obsolete. New sessions, rail resumes, tab switches, and the
  rejoin fallback all keep every other channel live; a FAILED open leaves
  the pane on the previous channel with the error banner. (User-found rig
  regression: the first pass only exempted tab clicks, so new-session and
  rail-resume opens still closed the previous tab, and a dead rejoin target
  took the old channel down through its fallback.)
- **Page exit no longer auto-closes the channel.** The W6 unmount-close
  existed because nothing else would free an abandoned channel; with the tab
  bar the live set is visible, individually closable, and bounded (machine
  budget + eviction + viewer-gone on real socket loss). A FULL page reload
  still drops idle channels (socket dies → onViewerGone) — by design.
- **一键清理**: `chat:channels.closeAll` (owner-only). Idle channels close
  now; busy ones flip to `closeWhenIdle` and close when the turn ends (an
  abandoned generation still finishes and persists natively). The ACK
  carries `{closed, deferred}` for the toast. Confirm-first.
- Rail rows overlay the push truth by native id OVER the listing's
  moment-in-time `open` stamps (the listing is still the row source —
  titles/cwd/updatedAt cost a daemon round-trip; the overlay only keeps
  `open`/`openChannelId` current between refreshes).

Tests: server — snapshot on open/ready/close, fresh-connect push,
`channels.sync` ack, closeAll idle/deferred split (24+1 cases in
`server/test/chat.test.ts`); shared — schema round-trips. Rig E2E:
two concurrent channels across agents (CC + CODE tabs), tab-click switch
with rejoin, cleanup zeroing the table with adapters reaped (SIGTERM grace,
no orphans).

## C. Adapter report — kills D3

One new `/ctl` request/reply pair, inventory-style waiters
(`AdapterReportCoordinator`, mirroring `SessionsCoordinator`):

- Daemon → `chat:adapters:result`: `{ adapters: [{ wireSessionId, target,
pgid, nativeSessionId?, startedAt, command }] }` straight from the live
  sessions map (NOT the ledger — the report is what the RUNNING daemon owns).
- REST: `GET /api/machines/:id/adapters` (owner-or-admin, 404-hiding, gates:
  online + `chat` capability; 30s timeout → 504, same shape as the sessions
  route). SDK method + MachineDetail "适配器进程" panel: one row per adapter
  (target, native session, uptime, a kill button per row → reuses
  `chat:session.close` semantics: teardown + ledger removal).
- The rail does NOT call this per row (it would respawn nothing but still
  cost a round-trip); the panel is on-demand from the machine page. The chat
  page's per-agent header may show a count badge fed from the same push in B
  (channels count) — process count stays on the machine page.

Tests (server): route gates + coordinator error-arm-before-timeout; (cli)
result schema shape.

## D. Listing TTL cache (daemon) — kills D4

`sessions:list` for the adapter-listed targets (codex/claude) caches the
listing per (machine,target) for `SESSIONS_CACHE_TTL_MS` (default 15s) in the
daemon. A cache hit answers without spawning; `?refresh=1` (the rail's manual
refresh button) bypasses it. dsh's file-scan path is cheap enough to cache
under the same TTL for uniformity. This is what makes occasional slow-poll
refreshes (native rows DO change when the agent writes) affordable; combined
with B, the rail is correct between refreshes without paying anything.

Tests (cli): hit serves cached rows without spawn; bypass respawns.

## E. Disconnect grace window — kills D5

- Daemon: on `/ctl` `disconnect`, arm a `TEARDOWN_GRACE_MS` (default 8000)
  timer instead of tearing down immediately; `connect` cancels it. Mid-grace
  prompts continue against the local adapter (the turn survives the blip;
  events emitted while disconnected are dropped by Socket.IO — same as
  today's last-second behavior, and the history ring resyncs the viewer via
  `chat:session.resync` on rejoin).
- Server: presence already debounces offline; `onMachineOffline` stays as the
  hard backstop — if the daemon really died, its grace timers died with it,
  the server reaps the table, and the ledger sweep (A) collects the
  processes on the next boot.
- Deliberate close paths are unchanged (SIGTERM shutdown closes the socket
  and does NOT wait the grace — `stop()` flushes teardown synchronously).

Tests (cli): disconnect+reconnect within grace keeps sessions; past grace
tears down. (server) unchanged behavior.

## F. Spawn hardening (P2, optional) — trims the tree

Today every spawn is `npx -y <pkg>` (sh → npm → wrapper → vendor binary). The
cache in `~/.npm/_npx` makes repeat spawns network-free, so the remaining
cost is process-tree depth and npm startup (~0.5–1s). F resolves each
adapter's REAL entrypoint once (per daemon run), caches
`~/.hnx/adapters/resolve-<target>.json`, and spawns it directly (still
detached, still one group). `HN_ACP_COMMAND_<TARGET>` keeps precedence and
disables caching for that target. Deferred until A–E land; the win is
latency, not correctness.

## Out of scope

- Multi-viewer presence (who exactly has the page open) — single-user
  channels today; the 其他窗口 state is inferred from wire id, not socket
  identity.
- Adapter health pings — ACP has no liveness method; a wedged-but-alive
  adapter is detectable only by its consequences (turn timeout, manual
  kill from C's panel).
- Server-side process enforcement (the server ordering reaps over /ctl) —
  the daemon owns processes; the server never trusts itself on this.
- Cross-machine anything (each daemon is self-contained by design).

## Plan (implementation order)

1. **S1 = A** (daemon-local, no wire change) — ledger + sweep + audit + tests.
2. **S2 = B** (shared schema + server push + web merge) — the visible fix.
3. **S3 = C** (coordinator + route + SDK + MachineDetail panel).
4. **S4 = D** (listing cache) then **S5 = E** (grace window; touches both
   sides — ship behind env kill-switches: `HN_TEARDOWN_GRACE_MS=0` restores
   today's behavior).
5. **F** optional follow-up.

Each slice is independently shippable; S1 and S2 together eliminate the
orphan class and the stale-已打开 class — the two things actually observed
on the rig.

## Post-ship notes (B, 2026-09-14)

- **The SPA-mount catch-up was missing on the first pass** (rig-found): the
  connect-time push predates SPA navigation, so a page mounted on an existing
  socket saw an empty tab bar until the next table change. `chat:channels.sync`
  (ack = snapshot) on hook mount is the fix.
- **The E2E accidentally demonstrated D5 live**: a transient daemon `/ctl`
  flap (transport close → reconnect) reaped both test channels mid-session —
  exactly the blip-kills-all-channels defect the grace-window slice (E)
  addresses. The claude tab recovered transparently through the rejoin's
  SESSION_NOT_FOUND → fresh-resume fallback, which is the designed behavior.
- **The tab bar's busy dot is deliberately muted** (pulsing current-color
  opacity, not `--signal`): the session page already spends the single
  signal accent on the live-turn indicator — a second signal-colored liveness
  dot per tab would double-spend it.
- The `deferred` flag (收尾中) rides the snapshot, not the rail: a channel
  whose viewer left mid-turn shows as a tab finishing in the background —
  the rail row beneath it stays plain 已打开 (the overlay keys on presence,
  not viewer identity).

## Post-ship fix — channel liveness is USER-scoped (2026-09-14, same day)

User-found with two browser windows on one account: window A's full-page
refresh closed every channel, yanking the tabs out of window B. Root cause:
the tab bar is USER-scoped (every window shows every live channel), but
liveness was still ROOM-scoped (C5 round 2's `onViewerGone` closed channels
whose channel-room went empty) — a window merely displaying the tabs was not
a viewer, so the opening window carried the channels alone.

`onViewerGone` now closes idle channels only when the user's LAST `/app
socket disconnects (busy ones still defer); the ready-path opener-dead check
follows the same rule (any window of the user counts as watching). Because a
starting channel can now survive its opener's refresh mid-spawn, rejoining a
`starting`channel re-attaches (ack`phase: 'starting'`, join, wait for the
real ready push) instead of bouncing `SESSION_NOT_FOUND`into a duplicate
fresh resume.`ChatIO.channelSockets`was replaced by`userSockets`.

This supersedes C5's "Viewer-scoped channels" room-membership rule — the
per-channel room still governs EVENT delivery (a window only receives a
channel's stream after opening/rejoining it there), but it no longer governs
liveness. Two viewer-gone tests were re-based accordingly; two regression
tests cover the two-window survival and the starting rejoin.

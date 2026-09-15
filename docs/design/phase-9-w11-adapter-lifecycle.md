# Design: Phase 9 W11 — Adapter process lifecycle & session truth

> Status: **A (adapter pid ledger + boot sweep + audit), B (channel
> snapshot + tab bar + one-click cleanup, 2026-09-14), E (disconnect grace
> + reconnect reconcile), and C (adapter report + machine panel) ALL
> SHIPPED 2026-09-14/15** (daemon `0.15.0-p9w11`; see the sections and
> their as-built/post-ship notes, including B's same-day
> user-scoped-liveness fix and E's no-debounce correction);
> D designed, not yet implemented (cost-only), **re-prioritized by the
> §"Re-evaluation" after the B post-ship fixes** (E expanded with a
> reconnect-reconcile handshake, new D6 idle-pressure decision point,
> D ↓). Trigger: three rig incidents
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
  (Demonstrated live TWICE during the B E2E — see the post-ship notes.)
- **D6 — Idle channels can now outlive any natural cleanup (NEW, raised by
  the 2026-09-14 liveness change).** User-scoped liveness + the tab model
  mean an idle channel stays alive while ANY window of the user is connected
  — which, for a user who keeps the app open in a pinned tab, is
  indefinitely. Every idle channel is a full adapter process (memory on the
  machine, an open upstream session). The total budget (12/machine) caps the
  worst case, and eviction prefers idle victims, so this is a pressure
  question, not a leak — but the platform currently has no "you left 9 idle
  agents running" story beyond the budget. See the re-evaluation section for
  the decision point.

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

> **SHIPPED 2026-09-15** (`packages/cli/src/daemon/adapter-ledger.ts`, daemon
> `0.13.0-p9w11`, no wire change). What follows is the design plus the
> as-built notes where implementation diverged or hardened it.

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

### As-built notes (2026-09-15)

- **The entry is written INSIDE `start`, not merely "before it returns"**:
  `AcpAgentConnection.start` grew an `onSpawned(pgid)` callback invoked right
  after the detached spawn and BEFORE the initialize await, and `chat.ts`
  writes the entry there — a hard death DURING establishment (the widest
  window: up to 20s of initialize timeout) still leaves a sweepable record.
  A throwing callback KILLS the spawn and fails the start (Principle 2: an
  unledgered adapter is worse than a closed channel). After registration the
  entry is re-written with the `nativeSessionId` (what slice C's report and
  post-mortem forensics key off).
- **Kill paths never unlink — removal belongs to the audit/sweep only**
  (deliberate deviation from the line above): unlinking at teardown loses
  accounting if the daemon hard-dies inside the SIGTERM→SIGKILL grace (the
  unref'd SIGKILL timer dies with the process); leaving the file lets the
  next boot's sweep finish the reap. Cost: ≤ one audit period (60s) of
  stale file after a normal close.
- **A pre-existing leak was found and closed while implementing**: a
  timed-out/failed `initialize` used to leave the spawned group alive —
  `chat.ts` only owns the connection AFTER `start` resolves, so its catch
  could not kill it. `start` now kills on any initialize rejection before
  rethrowing (this also covers `sessions.ts`' short-lived listing spawns).
- **EPERM counts as not-ours**: `kill(-pgid, 0)` returning EPERM (the pid
  was reused by a foreign-owned process) makes every caller drop the file
  WITHOUT signaling — Principle 3 enforced at the syscall boundary.
- Junk housekeeping: torn `.json` writes and stranded `.json.tmp` files are
  removed by the same audit/sweep pass; `writeAdapterLedgerEntry` is an
  atomic tmp+rename, rejects unsafe wire session ids (path traversal), and
  the reader re-validates every field.
- `attachChatHandlers` gained `auditIntervalMs` (default 60s, 0 disables —
  test knob); the audit lives next to the sessions map it backstops. One
  daemon per (user, home): a second daemon's boot sweep would reap the
  first's live adapters (concurrent daemons on one home are already
  unsupported).

Tests (cli): sweep reaps a REAL detached group recorded in the ledger and
the process actually dies; a dead-pgid entry is dropped without counting as
reaped; audit keeps live entries; junk/`.tmp` housekeeping; traversal-safe
writes; the entry exists BEFORE establishment completes (fixture-delayed
`session/new`, pgid === the spawned process); registration enriches with
the native id and close defers removal to the audit; a failed establishment
leaves no residue once the group dies.

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
  budget + eviction + viewer-gone). A full page reload drops idle channels
  only when it was the user's LAST connected window — see the user-scoped
  liveness post-ship fix below.
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

> **SHIPPED 2026-09-15** (daemon `0.15.0-p9w11`; see the as-built notes at
> the end of the section).

One new `/ctl` request/reply pair, inventory-style waiters
(`AdapterReportCoordinator`, mirroring `SessionsCoordinator`):

- Daemon → `chat:adapters:result`: `{ adapters: [{ wireSessionId, target,
pgid, nativeSessionId?, startedAt, command }] }` straight from the live
  sessions map (NOT the ledger — the report is what the RUNNING daemon owns).
- REST: `GET /api/machines/:id/adapters` (owner-or-admin, 404-hiding, gates:
  online + `chat` capability; 30s timeout → 504, same shape as the sessions
  route). SDK method + MachineDetail "适配器进程" panel: one row per adapter
  (target, native session, uptime, a kill button per row → reuses
  `chat:session.close` semantics: teardown + ledger removal). Since B, the
  per-channel kill also exists as the tab-bar × for the owner; the panel's
  kill remains the OPERATOR path (and the only one for a channel the tab
  bar cannot reach).
- The rail does NOT call this per row (it would respawn nothing but still
  cost a round-trip); the panel is on-demand from the machine page. The chat
  page's per-agent header may show a count badge fed from the same push in B
  (channels count) — process count stays on the machine page.

### As-built notes (2026-09-15)

- Wire: `adapters:report {requestId}` → `adapters:report:result
  {adapters | error}` (`adapterProcessViewSchema` in shared; `pgid` is
  `int().min(0)` — 0 = unknown, always real for a live session). The
  daemon answers INSTANTLY from the sessions map (no spawn); `DaemonSession`
  gained `command` + `startedAt` for it.
- REST mirrors the sessions route exactly: `GET /api/machines/:id/adapters`
  (owner-or-admin 404-hiding; online → 409 `MACHINE_OFFLINE`; `chat`
  capability → 409 `DAEMON_NO_CHAT`; error-arm → 502; timeout → 504
  `ADAPTERS_TIMEOUT` — a pre-W11 daemon simply never answers, 30s default,
  `ADAPTERS_REPORT_TIMEOUT_MS`). The operator kill is
  `POST /api/machines/:id/adapters/:sessionId/close` → `ChatService
  .forceCloseSession` (closeInternal + notifyDaemon; the ROUTE gates
  owner-or-admin — chat itself stays owner-only). 404 `ADAPTER_NOT_FOUND`
  for a dead id. SDK: `listMachineAdapters` / `closeMachineAdapter`.
- The kill's "teardown + ledger removal" from the original text above is
  superseded by the W11 A as-built rule: kill paths never unlink — the
  daemon teardown rides `chat:session.close` and the 60s audit drops the
  ledger entry once the group is gone.
- Panel (`MachineDetail` 适配器进程 card): on-demand fetch when online +
  `chat` (auto once, 刷新 re-fetches; muted hint otherwise), one row per
  adapter — target badge, native session id (mono, truncated), uptime
  (`startedAt` → relative), PGID (`nums`), 终止 button (confirm-first).
  Neutral Signal styling; process count stays on the machine page.
- **Found while testing**: the /ctl connection handler registered presence
  AFTER an `await` (findById + touchLastSeen) — a socket dying inside that
  window was never counted off (its disconnect handler ran before
  `connected()` registered it), leaving the machine showing online forever.
  Presence now registers synchronously at handler entry (the deleted-machine
  corner may flicker online for a beat before the force-disconnect lands).
  Also fixed a suite daemon leak ('user disconnect' test never closed it —
  the first true-offline assertion in the file exposed it).

Tests (server): route happy path, gates (foreign 404 / no-capability 409 /
offline 409), pre-W11 timeout → 504, operator kill (daemon gets the close,
viewer gets `closed{reason:'operator'}`, second kill 404). (cli) the report
answers from the live map (pgid > 0, native id, command, startedAt) and
empties after close; malformed request → `proto:invalid`.

## D. Listing TTL cache (daemon) — kills D4

`sessions:list` for the adapter-listed targets (codex/claude) caches the
listing per (machine,target) for `SESSIONS_CACHE_TTL_MS` (default 15s) in the
daemon. A cache hit answers without spawning; `?refresh=1` (the rail's manual
refresh button) bypasses it. dsh's file-scan path is cheap enough to cache
under the same TTL for uniformity. This is what makes occasional slow-poll
refreshes (native rows DO change when the agent writes) affordable; combined
with B, the rail is correct between refreshes without paying anything.

Tests (cli): hit serves cached rows without spawn; bypass respawns.

## E. Disconnect grace window + reconnect reconcile — kills D5

> **SHIPPED 2026-09-15** (daemon `0.14.0-p9w11`, server `ReconnectGuard`).
> The original text below is kept; the as-built notes at the end record
> where reality forced changes — most importantly the "presence already
> debounces offline" premise was FALSE (socket-level presence reaps
> instantly), so the server-side reap had to be delayed too or the daemon's
> grace was pointless.

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
- **Reconnect reconcile (added in the 2026-09-14 re-evaluation — the grace
  window alone has a gap):** the post-W8 hardening reaps the server's
  channel table on EVERY `/ctl` connection. A daemon that grace-KEPT its
  sessions and reconnects after the server already marked the machine
  offline therefore holds adapters no server row knows about — unjoinable
  (`SESSION_NOT_FOUND`), invisible to the tab bar, and nothing ever closes
  them. Fix: on `/ctl` connection (after `machine:hello`), the server sends
  `chat:reconcile { sessionIds: [...] }` — its live rows for that machine —
  and the daemon tears down any of its sessions NOT in the list. This also
  covers the server-restart case (empty table → daemon empties its map) and
  subsumes the current reap-on-reconnect as the row-side half of the same
  handshake. (Not re-adopting rows from the daemon side deliberately:
  rebuilding server state from the client inverts the ownership Principle 1.)
- Deliberate close paths are unchanged (SIGTERM shutdown closes the socket
  and does NOT wait the grace — `stop()` flushes teardown synchronously;
  the grace timer must be cancelled/ignored on shutdown).

### As-built notes (2026-09-15)

- **The server had NO offline debounce.** `MachinePresence` flips offline
  the instant the last `/ctl` socket drops and the disconnect handler reaped
  chat rows right there — a daemon-side grace alone would have changed
  nothing (rows died before any reconnect). `ReconnectGuard`
  (`server/src/realtime/reconnect.ts`, wired into the realtime plugin) owns
  BOTH halves: `onWentOffline` arms a delayed reap
  (`CHAT_RECONNECT_GRACE_MS`, default 8000; 0 restores pre-W11) and
  `onCtlConnect` cancels it and runs the handshake — `chat:reconcile
{sessionIds}` → daemon acks `{held}` → `retainOnly` closes rows the
  daemon does not hold (ghosts of a restart/hard-death, and stale rows
  whose daemon-side close event was lost inside a blip).
- **Deliberate closes bypass the grace on BOTH sides.** The daemon treats
  reason `'io client disconnect'` (its own `stop()`) as immediate; the
  server treats `'client namespace disconnect'` / `'io server disconnect'`
  the same — a daemon that deliberately closed already tore its sessions
  down, so waiting only delays cleanup. Kill-switches:
  `HN_TEARDOWN_GRACE_MS=0` (daemon) and `CHAT_RECONNECT_GRACE_MS=0`
  (server) restore the pre-W11 behavior exactly.
- **Reconcile covers establishments IN FLIGHT.** The daemon tracks starts
  from `chat:session.start` to registration (`inFlightStarts`): an unlisted
  in-flight start is flagged into `closedBeforeReady` (it aborts at its
  checkpoint — no orphan), while a LISTED one is reported as held so the
  server does not close its row through a ghost-race. Without this, a blip
  landing mid-spawn either leaked an unjoinable adapter or killed a channel
  that was legitimately coming up.
- **No/invalid ack falls back THROUGH the grace** (pre-W11 daemons have no
  handler): the ack wait is `min(5000, grace)` and a timeout routes into
  the same delayed reap — an instant reap there would defeat the window for
  a socket that merely blipped a second time. For a genuine old daemon this
  only means ghost rows close a few seconds later.
- The old blind reap-on-every-`/ctl`-connect is GONE, replaced by
  reconcile-on-connect — the ghost-flush property is preserved (a fresh
  daemon acks `held: []`, so leftover rows close), but a grace-KEEPING
  daemon's rows now survive the reconnect.

Tests (cli): a blip within the grace keeps the channel (a later prompt
works); past the grace everything tears down; a deliberate close and the
`=0` kill-switch tear down immediately; reconcile drops unlisted sessions,
keeps listed ones, and acks held — including the in-flight both ways.
(server) rows survive a transport blip inside the window and reap past it;
a reconnect's reconcile keeps held rows; the no-ack fallback reaps through
the grace.

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

## Plan (implementation order — re-prioritized 2026-09-14, see below)

1. **S1 = A** (daemon-local, no wire change) — **SHIPPED 2026-09-15**
   (`adapter-ledger.ts`: spawn-time entry via `onSpawned`, boot sweep in
   `runDaemon`, 60s audit, initialize-failure kill; daemon `0.13.0-p9w11`).
2. **S2 = B** — **SHIPPED** (snapshot push + tab bar + cleanup, plus the
   mount-sync / opens-keep-channels / user-scoped-liveness fixes).
3. **S3 = E** (grace window + reconnect reconcile) — **SHIPPED
   2026-09-15** (kill-switches `HN_TEARDOWN_GRACE_MS=0` daemon-side and
   `CHAT_RECONNECT_GRACE_MS=0` server-side restore the pre-W11 behavior).
4. **S4 = C** (adapter report + MachineDetail panel) — **SHIPPED
   2026-09-15** (daemon `0.15.0-p9w11`; also hardened synchronous presence
   registration on /ctl connect).
5. **S5 = D** (listing TTL cache) — demoted: the push overlay made stale
   LISTINGS matter less (only titles/updatedAt), so this is now a pure
   cost optimization.
6. **F** optional follow-up.

Each slice is independently shippable; S1 (orphans), S3 (blip reap), and
S4 (process visibility) are shipped — no observed defect class remains open
in W11 (D is cost work; D6 is a decision point).

## Re-evaluation (2026-09-14, after the B post-ship fixes)

What the four same-day fixes (tab bar, mount sync, opens-keep-channels,
user-scoped liveness) changed about the REMAINING design:

- **A ledger/sweep — priority UP, design unchanged.** Channels now persist
  across page exits and window refreshes by design, so a machine routinely
  holds more concurrent adapters than before; a daemon hard-death orphans
  more of them at once. The ledger/boot-sweep design needs no revision (it
  keys on pgids, orthogonal to channel lifetime).
- **E grace window — scope EXPANDED (reconnect reconcile).** The grace
  window alone leaves a leak: a daemon that grace-kept sessions and
  reconnects after the server already reaped the table holds unjoinable,
  invisible adapters forever. The reconcile handshake (server announces its
  live rows on `/ctl` connect; the daemon drops everything unlisted) closes
  it and also cleans up the server-restart case. See §E.
- **D6 idle-channel pressure — NEW decision point.** Options: (a) do
  nothing beyond the budget (12 adapters/machine max, idle-first eviction)
  — honest, but a machine can sit at 12 idle agents; (b) an idle TTL
  (`CHAT_IDLE_TTL_MS`, close idle channels after N minutes of no turn,
  default OFF) — bounded memory, but closes a tab the user may still want;
  (c) tab-bar idle-age display + a "close idle" variant of 一键清理 — keeps
  every closure explicit, adds no server policy. **Recommendation: (c)
  first (pure UI, no surprise closures), (b) as an operator knob shipped
  default-off alongside it.** Revisit after real multi-session usage.
- **D listing cache — priority DOWN** (the overlay made listing staleness
  cosmetic), **C — unchanged**, **F — unchanged (P2)**.
- No changes required in the SHIPPED B code from this re-evaluation; the
  doc's B section and post-ship notes were corrected where the
  user-scoped-liveness fix had obsoleted them (the "full page reload drops
  idle channels" line).

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

`onViewerGone` now closes idle channels only when the user's LAST `/app`
socket disconnects (busy ones still defer); the ready-path opener-dead check
follows the same rule (any window of the user counts as watching). Because a
starting channel can now survive its opener's refresh mid-spawn, rejoining a
`starting` channel re-attaches (ack `phase: 'starting'`, join, wait for the
real ready push) instead of bouncing `SESSION_NOT_FOUND` into a duplicate
fresh resume. `ChatIO.channelSockets` was replaced by `userSockets`.

This supersedes C5's "Viewer-scoped channels" room-membership rule — the
per-channel room still governs EVENT delivery (a window only receives a
channel's stream after opening/rejoining it there), but it no longer governs
liveness. Two viewer-gone tests were re-based accordingly; two regression
tests cover the two-window survival and the starting rejoin.

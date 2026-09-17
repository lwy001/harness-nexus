# Phase 9 W14 — Plan / todo panel + subagent & permission verification

> Status: SHIPPED 2026-09-17 (branch `feat/p9-w14-plan-todo`, daemon
> `0.19.0-p9w14`). Ground truth:
> [`docs/research/phase-9-w14-w15-plan-commands.md`](../research/phase-9-w14-w15-plan-commands.md)
> (adapter-source-verified: claude wrapper 0.78.0, codex-acp 0.16.0,
> opencode 1.18.x, dsh-acp 0.1.2-rc.1, ACP SDK 1.4.0).

## 1. Problem

The ACP `plan` session update carries the agent's todo/task list as a
full-replace snapshot. claude-agent-acp (since its task-list migration) emits
TodoWrite and TaskCreate/TaskUpdate/TaskList **exclusively** as `plan` updates
— the tool calls are suppressed — so the portal chat shows NOTHING while the
agent works through a todo list. codex-acp emits the same `plan` update from
its `update_plan` tool. Our daemon maps both to the `raw` fallback and the
web fold drops them.

Second half of the wave (verification, not new surface): confirm the
**subagent** path (claude's `Task` tool card — the ONE subagent surface that
still rides an ordinary tool call) and the **user confirmation** path
(`session/request_permission` → permission card → respond) behave correctly
end-to-end on the rig, across the targets that support them.

## 2. Surface

### 2.1 Wire (`packages/shared/src/realtime.ts`)

Additive stream kind on `chatStreamEventSchema`:

```ts
export const planEntryStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
export const planEntrySchema = z.object({
  content: z.string().min(1).max(512),
  status: planEntryStatusSchema,
  priority: z.enum(['high', 'medium', 'low']).optional(),
});
// chatStreamEventSchema +=
z.object({ kind: z.literal('plan'), entries: z.array(planEntrySchema).max(128) });
```

Full REPLACE semantics (ACP's own contract: every update carries the complete
list). An empty `entries` array is legal (= plan cleared) and the UI hides on
it. Because it rides the ordinary stream it flows through the history ring
and `session/load` replay capture for free — a resync converges to the last
snapshot.

### 2.2 Daemon (`packages/cli/src/daemon/chat.ts`)

One new arm in `mapAcpUpdate` (stateless — no merge needed, unlike
`session_config`): `case 'plan'` → validate/clamp entries (≤128, content
≤512 chars, drop malformed rows) → `{kind:'plan', entries}`. Same mapping
covers the live path, the load-capture path, and (nothing to do) the dsh
transcript path — dsh never emits plans.

`DAEMON_VERSION` → `0.19.0-p9w14`. No new capability (the update arrives
unasked), no `/ctl` method, no storage.

### 2.3 Web

- `apps/web/src/realtime.ts`: mirror types (`PlanEntry`, `plan` arm).
- `fold.ts`: `FoldState.plan: PlanEntry[]` (last-wins in `applyEvent`;
  fresh in `createFoldState`; history rebuild converges through replay).
- **`components/chat/todo-panel.tsx`** — the portal-reference TodoPanel,
  restyled to Signal: a single card rendered ABOVE the composer inside the
  existing `max-w-3xl` column. Hidden when `entries.length === 0`. Collapsed
  by default; header = `ListTodoIcon` + title + progress summary
  (`已完成 N · 进行中 N · 待办 N`, zero-count segments omitted) + chevron;
  expanded = one row per entry — status glyph + single-line ellipsis text
  (`title` carries the full content), max-height with internal scroll.
  Status colors follow the established state encoding (`--ok` completed,
  `--warn` in-progress, muted dashed pending); `--signal` stays reserved for
  the live-turn indicator.
- The W6 `TodoCard` (registry key `TodoWrite`) STAYS — any adapter that still
  surfaces a todo tool as a tool call keeps its inline checklist card.

### 2.4 Out of scope

- Draft subagent sessions (ACP PR #1992, `subagent_spawned` + child-stream
  rerouting behind a client capability): NOT advertised — unstable draft, and
  our single-channel fold would fold child output into the main transcript.
  Subagents remain the `Task` tool card. Revisit when the SDK ships it stable.
- `session_info_update` (claude goal `_meta`), `compaction_*`, unstable
  `plan_update`/`plan_removed` — stay `raw`.
- Editing/creating plan entries from the UI (no ACP request exists).

## 3. Verification scope (the wave's second deliverable)

Rig E2E on the live machine (`docs/dev/test-rig.md`, git-ignored):

1. **claude-code todo**: a multi-step prompt → TodoPanel appears above the
   composer, entries flip pending → in_progress (activeForm text) →
   completed; collapse/expand works; a resumed session replays to the final
   snapshot (panel present on open).
2. **claude-code subagent**: a prompt that spawns a subagent (`Task` tool) →
   TaskCard renders with the prompt body, completes with the result summary;
   subagent output does NOT leak into the main message stream.
3. **Permissions**: claude-code (a Bash command needing approval) and
   opencode (an edit in default permission mode) → permission card renders
   with the adapter's own option set → allow → tool proceeds; reject path
   settles the card. dsh documents no requests (trusted-client design —
   unchanged finding).
4. **codex plan**: a planning prompt triggers codex's `update_plan` tool →
   the same panel renders.

## 4. Tests

- `packages/cli/test/chat.test.ts`: `mapAcpUpdate` plan cases (happy path,
  content clamp, malformed-row drop, empty array passes as cleared) + a
  fixture round-trip (new `show-plan` prompt arm in the fixture agent:
  pending snapshot → progress snapshot → completion snapshot + message +
  end_turn).
- Fold behavior is covered by the daemon wire contract + manual rig pass
  (the web has no component test harness; the fold's plan arm mirrors
  `session_config`'s state-only merge).

## 5. Rig results (2026-09-17, daemon `0.19.0-p9w14`)

- **codex plan E2E ✓** — the `update_plan` tool fires on a "make a plan then
  execute" prompt; `plan` snapshots flow end-to-end and the web TodoPanel
  renders, converges live, and settles at `已完成 3 3/3` (zero-count segments
  omitted). Browser-verified collapsed + expanded.
- **claude task-list lane DORMANT today** — CLI 2.1.263 headless sessions
  expose NEITHER TodoWrite NOR TaskCreate/TaskUpdate to the model (verified
  by having the model list its tools verbatim: Agent/Bash/Cron*/Edit/
  EnterPlanMode/… only). The wrapper's TodoWrite/Task*→plan conversion
  therefore has no producer on this rig right now; the wire + panel are
  ready for when the CLI ships task tools to SDK sessions. The subagent
  tool is `Agent` (ex-`Task`) and still rides an ordinary tool_call → the
  existing TaskCard.
  > **CORRECTED 9 W14.1** (see `phase-9-w14.1-claude-ground-truth.md`):
  > right symptom, wrong cause — portal sessions run the SDK-BUNDLED CLI
  > 2.1.270 (not the native 2.1.263), and ≥2.1.233 ships the Task tools
  > disabled by default. The daemon's claude adapter now sets
  > `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`; TaskCreate fires and plan snapshots
  > flow E2E. The lane is LIVE.
- **Permissions ✓** — claude-code (options allow-once / allow-with-updates /
  reject → allow-once → tool proceeds → clean turn end) and opencode
  (once / always / reject → allow_once → clean end). The browser permission
  card (codex, its own three-option set) approved and the turn completed.
- Side capture: `available_commands_update` observed live from claude (incl.
  `deep-research`) and codex (`review` with `input.hint`) — the W15 input.

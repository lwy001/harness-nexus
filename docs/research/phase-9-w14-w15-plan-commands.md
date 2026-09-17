# Research — ACP plan (todo) & available commands across the shipped adapters

> Status: verified 2026-09-17 against adapter SOURCES (the `/tmp/acp-research`
> copies) + `@agentclientprotocol/sdk@1.4.0` type declarations (npm tarball).
> Ground truth for W14 (plan / todo display, subagent & permission
> verification) and W15 (slash commands).

## Why

The portal chat currently drops two ACP session-update kinds on the floor:
`plan` and `available_commands_update` both fall into the daemon's `raw`
fallback (`mapAcpUpdate` default arm) and the web fold ignores every `raw`
event except `hnx/prompt-error`. Result: Claude Code's todo list is COMPLETELY
INVISIBLE (the wrapper no longer emits TodoWrite as a tool call), and no agent
surfaces its slash commands. This doc verifies what each adapter actually
emits before W14/W15 build the display.

## The ACP 1.4.0 wire shapes (SDK `types.gen.d.ts`)

```ts
// session/update — full REPLACE snapshot; the client replaces the whole plan.
{ sessionUpdate: "plan", entries: PlanEntry[] }
PlanEntry = {
  content: string                        // human-readable task description
  priority: "high" | "medium" | "low"
  status: "pending" | "in_progress" | "completed"
  _meta?: ...
}
// Doc note (verbatim): "When updating a plan, the agent must send a complete
// list of all entries with their current status."

// session/update — the agent's slash-command catalog.
{ sessionUpdate: "available_commands_update", availableCommands: AvailableCommand[] }
AvailableCommand = {
  name: string            // NO leading slash (e.g. "init"); MCP ones "mcp:foo"
  description: string
  input?: { hint: string } | null   // unstructured: "text typed after the name"
}
```

There is NO dedicated command-invocation RPC — a command runs as an ordinary
`session/prompt` whose text is `/name rest-of-line` (the
`UnstructuredCommandInput` doc: "All text that was typed after the command
name is provided as input"). The full 1.4.0 sessionUpdate union (for
completeness): `user_message_chunk | agent_message_chunk |
agent_thought_chunk | tool_call | tool_call_update | plan | plan_update*
| plan_removed* | available_commands_update | current_mode_update |
config_option_update | session_info_update | usage_update |
compaction_update | compaction_summary_chunk` (`*` = UNSTABLE draft kinds —
no shipped adapter uses them; they keep falling to `raw`).

## Adapter matrix (source-verified)

| surface                     | claude-code (`@agentclientprotocol/claude-agent-acp` 0.78.0)                                                                                                                                                                                                      | codex (`codex-acp` 0.16.0)                                                                                                           | opencode (1.18.x)                                                                                                                                                       | dsh (`dsh-acp` 0.1.2-rc.1)                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `plan` entries              | ✅ **TodoWrite → plan** (`tools.ts planEntries`) AND **TaskCreate/TaskUpdate/TaskList → plan** (`taskStateToPlanEntries`, accumulated per session)                                                                                                                | ✅ `update_plan` tool → `PlanEntry[]` (`thread.rs update_plan`)                                                                      | ❌ (no plan emission anywhere in `src/acp/`)                                                                                                                            | ❌                                                               |
| `available_commands_update` | ✅ after `session/new`, `load`, `resume` (setTimeout after the response; "after replay so it doesn't interleave with history"); MCP commands renamed `mcp:<name>`; terminal-bound + a static unsupported list (`clear`, `cost`, `todos`, `login`, …) filtered OUT | ✅ on thread start (+200ms): `review`, `review-branch`, `review-commit`, `init`, `compact`, `logout`; review ones carry `input.hint` | ✅ on session ops: from `Command.Info` (includes `command/*.md` custom commands — i.e. platform-deployed commands surface here); `{name, description}` only, NO `input` | ❌ (emits only message/thought/tool/config_option/usage updates) |
| command invocation          | prompt `/name args` (CLI parses slash)                                                                                                                                                                                                                            | prompt `/name args` ("User prompts, including slash commands like /init, /review, /compact")                                         | prompt `/name args` — `detectSlashCommand` matches `availableCommands` by name, routes to its internal `session.command`                                                | n/a (no commands)                                                |
| subagents                   | `Task` (the subagent-spawner tool) still emits an ordinary `tool_call` → the portal's TaskCard. TodoWrite + TaskCreate/TaskUpdate/TaskList/TaskGet are the ones SUPPRESSED in favor of plan snapshots (`isTaskTool`/`shouldEmitToolCall`, acp-agent.ts:9232)      | n/a                                                                                                                                  | n/a                                                                                                                                                                     | n/a                                                              |
| permissions                 | ✅ `session/request_permission`                                                                                                                                                                                                                                   | ✅                                                                                                                                   | ✅                                                                                                                                                                      | ❌ never (trusted-programmatic-clients design; W9 research)      |

### claude-code detail (the load-bearing finding)

`acp-agent.ts` streaming switch: `chunk.name === "TodoWrite"` with
`Array.isArray(chunk.input?.todos)` produces a `plan` update INSTEAD of a
tool_call; `isTaskTool(name)` (TaskCreate/TaskUpdate/TaskList/TaskGet — the
SDK-era task list, NOT the subagent `Task` tool) is suppressed the same way,
with the plan snapshot emitted at tool_result time. Consequences:

1. The W6 `TodoCard` (registry key `TodoWrite`) is DEAD for claude-code — the
   tool call never arrives. The portal's todo display must ride the `plan`
   update. (The card stays as a fallback for any adapter that still emits
   TodoWrite as a tool call.)
2. `in_progress` entries carry the agent's `activeForm` text (e.g. "Analyzing
   dependencies…") instead of the static content — display verbatim.
3. During `session/load` replay the same mapping runs, so history replay
   naturally ends at the final plan snapshot — a last-wins panel converges
   without extra plumbing.

### Draft subagent sessions — deliberately NOT adopted

claude-agent-acp carries a draft implementation of ACP PR #1992
(`acp-subagents.ts` / `native-subagents.ts`): when the CLIENT advertises
`capabilities.subagents`, it emits `subagent_spawned` / `subagent_state_update`
and REWRITES child updates to the child's own sessionId. Our daemon does not
advertise it (initialize sends `clientCapabilities: {}`) and W14 will keep it
that way: the draft is unstable, and our single-channel fold has no concept of
a second session stream — routed child output would corrupt the main
transcript. Subagents keep surfacing as `Task` tool cards (verified path
above); W14's subagent work is rig VERIFICATION of that path, not the draft.

## Portal reference (`~/acp-ref/portal`, the C5 reference half)

- **TodoPanel** (`components/stream/TodoPanel.tsx`): a strip ABOVE the input
  area; empty list renders nothing; collapsed by default (header: icon +
  title + progress summary + chevron); expanded = per-entry status glyph +
  single-line ellipsis, capped + internal scroll. Data = last-wins plan
  snapshot (`useAcpConnection` `case 'plan'` → `setPlan(entries)`); replay
  converges ("会话打开即恢复面板").
- **Commands** (`commands.ts` + `ChatInput.tsx`): palette opens when the draft
  starts with `/` (not while a turn runs); first word after `/` is the filter
  (name OR description substring); ↑/↓ cycle, Esc closes, Enter on a BARE
  command selects + fills `/name `, Enter WITH args sends as a normal prompt.
  The portal ALSO ships a hardcoded fallback table — we deliberately DON'T
  (data-driven honesty: an agent that never pushed commands shows no palette;
  same rule as dsh's absent selectors).

## Bounds chosen for our wire (daemon-side clamp)

- plan: ≤128 entries kept, `content` clamped to 512 chars, unknown `status`
  dropped entry-wise, `priority` passed through when present (display may ignore).
- commands: ≤64 rows, `name` ≤128, `description` clamped 512, `input.hint`
  clamped 256. Names ride VERBATIM (the web adds the `/`); MCP `mcp:*` names
  keep their prefix.

## What this rules in / out

- W14 renders ONE todo/plan panel fed by the `plan` snapshot — no per-update
  transcript rows (full-replace semantics make rows a lie about the model).
- opencode gets NO plan panel (honest absence); its todo tool (if a model uses
  one) surfaces as an ordinary tool card.
- dsh shows neither panel nor palette — no fallbacks.
- `session_info_update` (claude goal `_meta`) and `compaction_*` stay `raw` —
  out of scope for both waves.

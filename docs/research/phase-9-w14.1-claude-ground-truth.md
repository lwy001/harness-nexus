# Research — claude-code Ask User / plan lane ground truth (Phase 9 W14.1)

> Status: COMPLETE (2026-09-17) — source-verified + rig-probed
> Feeds: `docs/design/phase-9-w14.1-claude-elicitation.md`, the W14 plan-lane
> revival (adapter env), and the W14 section corrections in AGENTS.md.

## 0. Why this doc exists

Post-W14 review challenged two conclusions: (a) "claude task-lane dormant on
CLI 2.1.263" and (b) "Ask User is OFF only because we send
`clientCapabilities: {}`". Re-verification (adapter sources pinned to the
versions we actually run, plus live probes against the rig machine container)
**corrected the causal chain behind (a)**, **confirmed (b) and made it
precise** (including the real wire method name), and produced an immediately
actionable fix for the plan lane.

## 1. Three layers, kept separate

"Can the agent ask the user a question" decomposes into three layers, and
statements about one layer do not transfer to another:

1. **Native** — does the CLI/TUI have an ask-user surface at all?
2. **ACP adapter** — does the adapter we spawn bridge that surface onto the
   ACP elicitation protocol?
3. **Portal wiring** — do WE advertise the capability and handle the request?

| target | native | ACP adapter (our version) | portal wiring |
| --- | --- | --- | --- |
| claude-code | ✅ `AskUserQuestion` tool | ✅ wrapper 0.78.0 fully bridges (form mode) | ❌ missing (this wave adds it) |
| codex | ✅ `request_user_input` (collaboration-mode gated) | ❌ codex-acp 0.16.0 logs `EventMsg::RequestUserInput` as `warn!("Unexpected event")` — unimplemented; only MCP **tool-approval** elicitations are converted to `request_permission` (`thread.rs` `mcp_elicitation`), every other form/url elicitation is auto-declined | permission cards ✅; general asking ❌ |
| opencode | ✅ `question` tool (newer versions; **1.18.31 — our pin — has no such tool**) | ❌ zero elicitation references in `src/acp/` at 1.18.31 AND on current `dev` | ❌ |
| deepseek | ✅ Ask User plugins (`dsh-tool-ask-user`) | ❌ zero elicitation references in dsh-acp 0.1.2-rc.1 | ❌ |

Bottom line: **claude-code is the only target where wiring elicitation in the
portal buys anything today.**

## 2. Which claude CLI actually runs in portal chat — and what tools it has

The wrapper (`@agentclientprotocol/claude-agent-acp` 0.78.0, resolved by the
daemon via `npx -y`, cached at `~/.npm/_npx/…`) depends on
`@anthropic-ai/claude-agent-sdk` **0.3.270**, whose platform packages
(`claude-agent-sdk-linux-x64`) **bundle their own `claude` binary**. Portal
sessions therefore run the SDK-bundled CLI, not the machine's native install:

| binary | version | headless `-p` init tool array (our gateway model) |
| --- | --- | --- |
| native (`claude` on PATH) | 2.1.263 | 26 tools — incl. `TaskCreate/TaskGet/TaskList/TaskUpdate`; **no** `TodoWrite`, **no** `AskUserQuestion` |
| SDK-bundled (what portal runs) | **2.1.270** (2026-09-12 build) | 22 tools — the Task suite is **gone** too |

Model-level YES/NO probes through the exact portal path (initialize with
`elicitation.form` advertised → `session/new` → `session/prompt`), answers
from the model itself:

| tool | default | with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` |
| --- | --- | --- |
| `TaskCreate` | **NO** | **YES** |
| `TodoWrite` | NO (replaced by the Task suite) | NO |
| `AskUserQuestion` | **YES** (fires; tool call observed) | YES |

Upstream context: v2.1.233 disabled the Todo/task tools by default (per-model
efficiency cut; the opt-in env is the documented escape hatch);
[#23874](https://github.com/anthropics/claude-code/issues/23874) tracks
headless unavailability, [#80401](https://github.com/anthropics/claude-code/issues/80401)
found a remote kill-switch (`tengu_vellum_ash`) that can withdraw them
mid-session. [#77994](https://github.com/anthropics/claude-code/issues/77994)
removed `AskUserQuestion` from bare `-p` after 2.1.185 — **that removal does
NOT apply to the SDK path** (probe-verified: the tool fires under the SDK).
[#48216](https://github.com/anthropics/claude-code/issues/48216) is
`--channels`-specific and does not concern us.

### Plan-lane consequence (W14 correction)

W14's "claude task-lane dormant on CLI 2.1.263" was **right about the symptom,
wrong about the cause**: the portal runs 2.1.270 (SDK-bundled), whose default
injection drops the Task suite for every model. The fix is one env var in the
daemon's claude-code adapter spawn: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`
(shipped as branch `fix/p9-w14.1-claude-todo-env`). Probe-verified with the
env set: `TaskCreate` fires and **full-snapshot plan updates flow**
(`alpha pending → +beta → alpha completed`), exactly what the W14 daemon arm
and web TodoPanel consume.

## 3. The elicitation wire — captured, not guessed

An earlier sketch assumed the request method was `session/create_elicitation`.
**Wrong.** Raw capture from a live wrapper session (claude model calling
`AskUserQuestion`, client advertising `elicitation.form`):

```json
{"jsonrpc":"2.0","id":0,"method":"elicitation/create","params":{
  "mode":"form",
  "sessionId":"113f48fd-…",
  "toolCallId":"call_178ba3c92da746a5b322b78d",
  "message":"Which color do you prefer?",
  "requestedSchema":{
    "type":"object",
    "required":["question_0"],
    "properties":{
      "question_0":{
        "type":"string","title":"Color",
        "oneOf":[{"const":"Red","title":"Red","description":"Choose the color red"},
                 {"const":"Blue","title":"Blue","description":"Choose the color blue"}]},
      "question_0_custom":{
        "type":"string","title":"Other",
        "description":"Type your own answer, or add a note…",
        "_meta":{"_askUserQuestionCustomAnswer":{"questionId":"question_0","isCustomAnswer":true}}}}}}}
```

Facts that shape the implementation:

- The method is a **top-level `elicitation/create`** JSON-RPC request (agent →
  client), `mode:"form"`, carrying `sessionId`, optional `toolCallId`,
  `message`, and a JSON-Schema-ish `requestedSchema`.
- AskUserQuestion questions become `question_N` enum properties
  (`oneOf`/`const` + title/description) plus a `question_N_custom` free-text
  property — i.e. **enum-with-custom is the canonical claude shape**.
- The response is `{action:'accept', content:{…}} | {action:'decline'} |
  {action:'cancel'}`; `content` values are keyed by property name (verbatim).
  The wrapper folds an accept back into the tool's `updatedInput`
  (`elicitation.ts` `applyAskElicitationResponse`); decline/cancel settle as
  a denied/aborted tool use.
- The wrapper's gate (`acp-agent.ts` ~7076/7917): AskUserQuestion reaches the
  client ONLY when initialize advertised `clientCapabilities.elicitation.form`
  — otherwise the wrapper puts `AskUserQuestion` in `disallowedTools` and the
  model never sees the tool (today's portal state). The wrapper also forwards
  **MCP-server** elicitations (`onElicitation`) through the same surface when
  form support is advertised.
- ACP SDK 1.4.0 ships the full elicitation schema family
  (`ElicitationPropertySchema`, oneOf const options, format hints, form/url
  modes) — see `types.gen.d.ts`; protocol-repo RFC:
  [elicitation.mdx](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/elicitation.mdx).

## 4. Probe methodology (reproducible)

- Tool-array dumps: `claude -p "…" --output-format stream-json --verbose
  --max-turns 1` in the machine container, parsing the `system/init` message
  (native binary and SDK-bundled binary side by side).
- YES/NO + behavioral probes: a throwaway ACP client
  (`initialize` with `elicitation:{form:{}}` → `initialized` → `session/new`
  → `session/prompt` with ContentBlock arrays) speaking to the wrapper the
  same way the daemon does. NOTE: the `initialized` notification is REQUIRED
  before the wrapper will issue client-directed requests — a probe without it
  stalls at the tool call.

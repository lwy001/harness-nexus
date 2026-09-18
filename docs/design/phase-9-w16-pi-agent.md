# Design: Phase 9 W16 — pi agent onboarding (runtime + self-developed ACP bridge)

> Status: **SHIPPED 2026-09-17** (daemon `0.22.0-p9w16`). External ground
> truth: [`docs/research/phase-9-w16-pi-agent.md`](../research/phase-9-w16-pi-agent.md)
> (pi.dev docs + npm manifests); §9 below records the rig E2E and the
> live-captured dialect. User decisions locked: **full T-wave surface**, and
> the C5 chat bridge is **SELF-DEVELOPED in-daemon** — svkozak/pi-acp and
> victor-software-house/pi-acp (both MIT) are dialect REFERENCES only, no
> runtime dependency on them.

## 1. Scope

pi (`@earendil-works/pi-coding-agent`; bin `pi`; Node ≥22.19) joins as the
fifth runtime-managed Agent with the full surface: probe → install/upgrade/
pin jobs → W3 provider push → W4 redacted viewer → W7 native-sessions rail →
C5 chat over the self-developed bridge → C3 inventory scan → profile deploy
(skills + prompt-templates; the honest partials per the research doc).

Server changes are near-zero (schema-driven, the W12 property); the work is
daemon-side plus registries.

## 2. Key architecture — the bridge is an in-daemon ACP façade

`chat.ts` is deliberately decoupled from adapter internals. It drives every
connection through a narrow duck-typed surface — `request(method, params,
timeoutMs)`, `setNotificationHandler`, `setPermissionHandler` +
`respondPermission`, `setElicitationHandler` + `respondElicitation`,
`onExit`, `kill`, `isGroupAlive`, `pgid` — and speaks PURE ACP method names
on it (`session/new|load|prompt|cancel|set_mode|set_config_option|close`;
every notification arrives as `session/update` with an ACP `sessionUpdate`
arm; chat.ts:1366+ is the dispatch). Permission/elicitation handlers simply
never fire for pi (it has neither — honest absence).

Therefore the bridge is a **translation class, not a subprocess**:
`PiRpcConnection` (new, `packages/cli/src/daemon/acp/pi-connection.ts`)
implements the SAME surface but speaks pi's RPC dialect on the wire — ACP
requests in → pi commands out; pi events in → ACP `session/update`
notifications out. Exactly what svkozak/pi-acp does as a separate process,
but in-process: zero third-party runtime deps, zero extra process to reap,
and the whole mapping is unit-testable against a fixture.

- Extract the surface chat.ts uses into an exported `AgentConnection`
  interface (`agent-connection.ts`); `AcpAgentConnection` and
  `PiRpcConnection` both implement it; `DaemonSession.conn` (:108) widens
  to it.
- Branch point = the connection factory at chat.ts:428 (where
  `resolveAcpCommand` runs today): `target === 'pi'` → `PiRpcConnection`
  with its own command resolver — default `['pi', '--mode', 'rpc']`,
  override `HN_ACP_COMMAND_PI` (fixtures, pinned installs; same
  convention as the ACP table).
- Process conventions identical to AcpAgentConnection: detached spawn +
  process group, adapter pid ledger entry written inside `start`,
  SIGTERM→SIGKILL on kill, spawn killed when startup probing fails.
- **Line codec**: pi REQUIRES splitting on `\n` only — Node `readline`
  also splits on U+2028/U+2029, which are legal inside JSON strings
  (pi docs call this out explicitly). PiRpcConnection gets its own line
  reader (split `\n`, strip optional trailing `\r`).

### 2.1 Request translation (ACP in → pi out)

| ACP request                         | pi command(s)                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/new {cwd}`                 | spawn in cwd → `get_state` (+ `get_session_stats`) for the session id | Respond ACP-shaped: `{sessionId, modes: [], configOptions, loadSession: true, promptCapabilities: {image: true}}`. `configOptions` synthesized from `get_available_models` (a `model` select — values are `provider/id` refs) + `get_available_thinking_levels` (`thought_level`) + current values from `get_state`; `loadSession: true` makes the daemon's `deriveSessionCaps` prefer `session/load` on resume (session/resume stays unimplemented — unreachable). |
| `session/load {sessionId}`          | `switch_session`                                                      | Then SYNTHESIZE the replay: parse the session file (S4's parser), emit `user_message_chunk` / `agent_message_chunk` (+ `tool_call`) `session/update`s, THEN resolve — mirrors claude's replay-on-load; the daemon's `wireCapture` path collects them into history.                                                                                                                                                                                                  |
| `session/prompt {prompt}`           | `prompt {message, images?}`                                           | Flatten blocks: `text` → concatenated message, `resource_link` → text marker (dsh-like), `image` → `images` (exact pi image format verified on the rig). **HOLD the ACP response until `agent_settled` / abort** — pi acknowledges `{success:true}` immediately, ACP semantics resolve at turn end (same class as the W7 dsh `turn_result` wait); reject on `extension_error` / failed turn.                                                                        |
| `session/cancel`                    | `abort`                                                               | pi responds once idle → forward.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session/set_config_option` (model) | `set_model`                                                           | Values `harness-nexus/<id>` after the S6.4 rewrite narrows the picker.                                                                                                                                                                                                                                                                                                                                                                                              |
| (thought_level option)              | `set_thinking_level`                                                  | pi levels `off…max` map directly.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `session/set_mode`                  | —                                                                     | pi has no modes; the selector does not render (`modes: []`, data-driven honesty).                                                                                                                                                                                                                                                                                                                                                                                   |
| `session/close`                     | `abort`, then exit                                                    | chat.ts kills the group anyway.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

After `session/new`, the façade also pushes one
`available_commands_update` from `get_commands` — the W15 `/` palette
lights up for free.

### 2.2 Event translation (pi event → `session/update`)

| pi event | ACP notification |
| --- |
| `message_update` `text_start/delta/end` | `agent_message_chunk {content:{type:'text'}}` (per `contentIndex`; delta-only, façade assembles) |
| `message_update` `thinking_*` | `agent_thought_chunk` (pi HAS thinking deltas — better than svkozak's MVP, which drops them) |
| `message_update` `toolcall_*` | folded into the tool card's `rawInput` |
| `tool_execution_start {toolCallId, tool}` | `tool_call {toolCallId, title}` |
| `tool_execution_update {partialResult}` | `tool_call_update {content}` |
| `tool_execution_end {result}` | `tool_call_update {content, status}` |
| `bash_execution_update {id, delta}` | `tool_call(_update)` keyed by the bash id (terminal-shaped content) |
| `message_end {usage}` | `usage_update` — `contextSize` only when the model's `contextWindow` is known from our pushed `models.json` (else omit: the composer meter hides, codex-parity honesty) |
| model change / `get_state` | `config_option_update` (model current value) |
| `agent_settled` / abort response | releases the held `session/prompt` response `{stopReason}` |
| `extension_error` | existing system-note error path |

`steer`/`follow_up` are deliberately NOT mapped in v1 — one prompt in
flight is already the daemon's rule; mid-turn sends queue at the busy gate.

## 3. Slices (each a commit on `feat/p9-w16-pi-agent`)

- **S0 — this design doc** (repo convention: committed before code).
- **S1 — shared registries.** `schemas/profile.ts` `AgentTarget` += `'pi'`;
  `schemas/inventory.ts` `RUNTIME_TARGETS`/`SCANNABLE_TARGETS` += `'pi'`;
  `hooks.ts` `HOOK_SUPPORT['pi'] = null`; `schemas/runtime-config.ts`
  `RUNTIME_API_SUPPORT['pi'] = ['anthropic','openai-chat',
'openai-responses']` (first target with all three) and
  `runtimeSpecUnsupportedReason`: pi requires a `baseUrl` (the writer
  always defines the `harness-nexus` provider; there is no built-in
  endpoint to ride). shared schema tests. Adding to `RUNTIME_TARGETS`
  lights up the server PUT route + the web provider form automatically.
- **S2 — runtime arm.** `inventory/runtime.ts` `RUNTIME_PROBES` +=
  `{target:'pi', bin:'pi'}`; `daemon/runtime.ts`
  `HARNESS_PACKAGES['pi'] = '@earendil-works/pi-coding-agent'` + a
  `piNodeWarning()` result warning when the daemon Node < 22.19 (dsh's
  ≥22.15 precedent at runtime.ts:126/235). Detected-instance sync and the
  Agent card are free.
- **S3 — W3 writer + W4 viewer files.** `applyPiConfig` in
  `daemon/runtime-config.ts`:
  `~/.pi/agent/models.json` → `providers['harness-nexus'] = { baseUrl, api
(mapped: anthropic→anthropic-messages, openai-chat→openai-completions,
openai-responses→openai-responses), apiKey: '!cat
~/.pi/agent/harness-nexus.key', models: [{id: model}, ...extras] }` —
  merge-preserving strict JSON (refuse on parse failure without touching);
  `~/.pi/agent/settings.json` → `defaultProvider: 'harness-nexus'`,
  `defaultModel`, `enabledModels: unique([model, ...extras])` (the W10/W13
  switchable set; id format — bare vs `provider/id` — is open
  verification V1 below);
  `~/.pi/agent/harness-nexus.key` 0600, RAW secret, no trailing newline
  (`!cat` reads verbatim). A baseUrl-less re-apply REMOVES ours (provider
  entry + settings keys + key file), mirroring claude/opencode.
  `daemon/config-view.ts` `TARGET_CONFIG_FILES['pi']` = settings.json,
  models.json, trust.json, **auth.json (wholesale — the user's /login
  store)**, **harness-nexus.key (wholesale)**. Writer/viewer unit tests
  over tmp homes.
- **S4 — W7 sessions arm.** `piListSessions`: pure file scan of
  `~/.pi/agent/sessions/--<cwd-path>--/<timestamp>_<uuid>.jsonl` — header
  `{type:'session', version, id, timestamp, cwd}` for identity/recency,
  last `session_info.name` for the title, no zstd (cheaper than dsh).
  `daemon/sessions.ts` arm `target === 'pi'` → the scan (no spawn).
  History producer = leaf-chain walk of `message` entries → `HistoryItem`s
  (the SAME parser is reused by the bridge's load replay — one parser,
  two callers). Tests over fixture JSONL files.
- **S5 — deploy + scan.** `DEPLOYABLE_TARGETS` += `'pi'`
  (server `modules/jobs.ts:33`); `install/adapters/pi.ts` — skills →
  `~/.pi/agent/skills/<slug>/SKILL.md` (+ bundle files); commands →
  prompt-template files (exact template dir is open verification V2;
  fallback: a settings `prompts` array entry); mcp/sub_agents/hooks/rules
  SKIPPED with warnings (rules: pi loads `AGENTS.md` from the project cwd
  — no home-level rules file; mcp: extension-based, no declarative
  surface); `inventory/scanners/pi.ts` — skills (READ frontmatter `name`:
  pi allows name ≠ dirname), templates; no mcp arm; `scan.ts` registry.
  Web pick lists: `Profiles.tsx` / `Resources.tsx` `TARGETS` += `'pi'`;
  `machineDetail.noDeployable` string (en/zh). CLI tests + smoke line.
- **S6 — the bridge (largest slice, three commits).**
  - S6.1 `AgentConnection` interface extraction + `PiRpcConnection`
    skeleton (spawn / ledger / kill / `\n`-only codec / `get_state`
    startup probe).
  - S6.2 translation core — pure exported mappers (`mapPiEvent`,
    `flattenPrompt`, response-hold state machine) + unit tests.
  - S6.3 chat.ts factory branch + `DaemonSession.conn` widening +
    integration tests.
  - S6.4 W13 rewrite rule for pi in `daemon/model-options.ts`: model
    options filtered to `harness-nexus/<id>`-prefixed values (opencode
    pattern, same provider id literal — hoist a shared `PI_PROVIDER_ID`
    if it reads better); empty intersection → row untouched; applied at
    all four admission points (the existing call sites cover the façade
    for free since it emits the same ACP shapes).
  - S6.5 fixture `test/fixtures/pi-rpc-agent.mjs` — a fake pi speaking
    the RPC dialect: scripted `message_update` delta streams, tool
    executions, `agent_settled`, abort, a session file for load replay;
    pointed at via `HN_ACP_COMMAND_PI`.
- **S7 — web residue.** Nothing beyond S5's lists expected (flavors
  select, Agent cards, viewer are schema-driven). Verify only.
- **S8 — gate + rig E2E + docs + merge.** Rig (machine container Node
  22.23 ✓): install job → Agent card; provider push → inspect
  models.json/settings.json/key file, terminal `/model` shows
  `harness-nexus`; viewer masked (auth.json + key wholesale); rail lists
  real pi sessions; chat E2E — real turn with thought stream + tool cards
  - model selector + `/` palette, cancel mid-turn, rejoin/resync history,
    adapter panel row, kill + leak scan. AGENTS.md W16 section, roadmap
    SHIPPED, docs/README design entry. Daemon `0.22.0-p9w16`.

## 4. Out of scope (explicit)

- **MCP install for pi** — no declarative surface (extension ecosystem);
  skip-with-warning; revisit if pi ships first-party config (issue #563).
- **Permissions / elicitation for pi** — pi has neither on the RPC wire;
  the cards never fire and we do not fake them. Documented, not worked
  around.
- `extension_ui_request` sub-protocol; ACP `fs/*`/`terminal/*` delegation
  (svkozak skips these too); `steer`/`follow_up` mapping; pi packages
  (`pi install`) management; subagents.
- zcode; hermes runtime (CANCELLED 2026-09-17).

## 5. Test strategy — never touches the network

Fixture pi (`pi-rpc-agent.mjs`) for dialect behavior; tmp-home writer
tests; JSONL session fixtures for the parser; the existing suites to
extend: shared schema tests, cli runtime-config/chat/sessions/model-options
tests, server chat relay (target-agnostic, no new cases expected), smoke
line for the scanner/deploy surfaces.

## 6. Open verifications (all settled on the rig, §9)

- **V1 model id format — SETTLED**: `get_available_models` returns objects
  `{id, provider, name, api, baseUrl, …}` and refs are `provider/id`
  (`harness-nexus/deepseek-v4-flash`); settings `defaultModel` stays a BARE
  id with `defaultProvider` naming ours. Both verified live.
- **V2 prompt-template dir — SETTLED from docs**: `~/.pi/agent/prompts/*.md`,
  filename = the `/name` command (adapter + scanner shipped on it).
- **V3 baseUrl — SETTLED**: pi takes the gateway base VERBATIM (Ark's
  `/api/coding/v3` worked headless with NO `/v1` normalization — unlike the
  opencode AI-SDK case).
- **V4 `images` format — still open**: no image turn was exercised on the
  rig; the façade forwards base64 strings as-is pending one live test.
- **V5 dialect — SETTLED by live capture** (§9): response payloads nest
  under `data`; message deltas ride `assistantMessageEvent`. Live
  `tool_execution_*` events were NOT exercised (the rig turn answered in
  plain text) — those arms ride the documented shapes plus defensive picks,
  covered by the fixture.

## 7. Risks

- **Pre-1.0 churn** (0.85.x, one org/package rename already): the
  `HN_ACP_COMMAND_PI` override + exact-version pin jobs are the escape
  hatches; expect dialect-drift repairs as maintenance (the posture we
  already hold for dsh RCs). svkozak's own note: "expect minor breaking
  changes", pi ≥0.80.4 required.
- **Node ≥22.19** — the highest floor yet; result warnings + rail note.
- **Response-hold timing** (`agent_settled` vs `turn_end` vs abort) —
  the fixture covers all three paths.
- **trust.json**: RPC mode silently IGNORES untrusted project `.pi`
  resources in the chat cwd (`AGENTS.md` context files still load) —
  documented honest behavior; pre-seeding trust for baseWorkspace is a
  possible follow-up, NOT v1.

## 8. Effort

S1–S5 ≈ 1 day · S6 ≈ 1.5–2 days · S7–S8 ≈ 0.5 day · **total ≈ 3–4 days**.

## 9. Rig results (2026-09-17, daemon `0.22.0-p9w16`)

All green end to end against REAL pi:

- **Install**: harness job `install pi` → `succeeded, version 0.85.1,
/usr/local/bin/pi, npm`. Detected-instance sync registered the pi Agent
  (`source: 'detected'`) with no rescan.
- **Provider push**: apply-config wrote `~/.pi/agent/models.json` (provider
  `harness-nexus`, `api: openai-completions`, `apiKey: !cat "<abs path>"`,
  models default-leading), `settings.json` (defaults + `enabledModels`),
  and the 0600 raw key (46 bytes, no newline) — byte-identical to the
  design. Headless `pi -p` through the Ark gateway answered `PONG`
  (V3: baseUrl verbatim; `!cat` key resolution works for TUI + headless).
- **Real dialect captured** (docker-exec probe of `pi --mode rpc`):
  responses `{id, type:'response', command, success, data}` (payload under
  `data`; bare acks carry none); `message_update` carries
  `assistantMessageEvent {type:'text_delta'|'thinking_delta',
contentIndex, delta}`; `message_end.message.usage` uses
  `{input, output}`; `get_session_stats.data.sessionId/sessionFile`;
  `get_commands.data.commands`; `agent_settled` ends the turn; user
  messages also produce `message_start/end` pairs (no usage — dropped).
  The façade + fixture were aligned the same day (commit f29e5da).
- **Chat E2E** (over `/app`): open → READY with `agentName: pi`, a real
  pi UUID `nativeSessionId`, `promptCapabilities.image`; `session_config`
  showed exactly the W13-configured set
  (`harness-nexus/deepseek-v4-flash` + `harness-nexus/doubao-seed-code-1-6`);
  the W15 catalog arrived (pi's built-in `llama` command); a prompt
  streamed `W`+`16`+`OK` deltas → usage → `turn_result end_turn` → idle.
- **Model switch**: `chat:config.set {kind:'option', configId:'model',
value:'harness-nexus/doubao-seed-code-1-6'}` → accepted, the push
  confirmed `currentValue` switched, and the next turn answered on doubao.
- **Sessions rail**: `GET /api/agent-instances/:id/sessions` listed the
  real store (4 files) with `model` (from `model_change`) and `cwd` (from
  the header).
- **Viewer**: settings/models shown; `models.json …apiKey` masked by key
  name; `auth.json` + `harness-nexus.key` wholesale `${redacted}`.
- **Leak scan**: no orphan `--mode rpc` processes after the turns.
- **Resume — rig-found fix (2026-09-18)**: rail clicks failed at first
  with `Cannot read properties of undefined (reading 'startsWith')` —
  `switch_session` takes **`sessionPath`** (the session FILE's absolute
  path), not an id (docs "RPC mode"; verified by probe). `establishLoad`
  now resolves id → path via `piFindSessionFile` (throwing an honest
  "not found" for foreign ids), switches with the path, and treats a
  `cancelled:true` reply as failure. E2E after the fix: READY carried the
  RESUMED session's nativeSessionId, the transcript replayed (4 items),
  and a follow-up question about the earlier turn answered from the
  resumed context ("RPCOK").

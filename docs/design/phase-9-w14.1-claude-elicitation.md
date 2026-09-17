# Design — Ask User for claude-code channels: ACP elicitation wiring (Phase 9 W14.1)

> Status: IMPLEMENTED 2026-09-17 (rig E2E results in §7)
> Research/ground truth: `docs/research/phase-9-w14.1-claude-ground-truth.md`
> Companion fix (merged first): `fix/p9-w14.1-claude-todo-env` — the claude
> plan/todo lane revival via `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`.

## 1. Problem

claude-code's `AskUserQuestion` (and MCP-server elicitations mounted under
claude) are fully bridged by the ACP wrapper, but the portal never sees them:
our daemon's `initialize` sends `clientCapabilities: {}`, so the wrapper adds
`AskUserQuestion` to `disallowedTools` (the model never gets the tool) and
would not forward MCP elicitations either. Every other target has NO adapter-
side elicitation bridge (research §1), so this wave wires the client side
once and claude is the only producer — deliberately not per-target gating.

## 2. Wire (packages/shared `realtime.ts`)

Two stream events + one request/response pair, mirroring the permission
lifecycle exactly:

```ts
// stream: daemon → server → browser (and into the daemon history ring, so a
// resync re-shows the card; the daemon-side pending map survives resync)
{ kind: 'elicitation_request', requestId, message ≤2048,
  fields: ElicitationField[] ≤16,        // MAY be empty — see §3
  toolCallId? }
{ kind: 'elicitation_resolved', requestId,
  outcome: 'accepted' | 'declined' | 'cancelled' | 'timeout' }

// browser → server → daemon (verbatim forward both hops):
{ sessionId, requestId, action: 'accept' | 'decline' | 'cancel',
  values?: Record<string, string | number | boolean | string[]> }  // accept only
```

`ElicitationField` is OUR bounded rendering hint, extracted daemon-side —
never the raw JSON schema on the wire:

```ts
{ name ≤128, type: 'text'|'number'|'integer'|'boolean'|'enum'|'multi',
  title? ≤256, description? ≤1024, placeholder? ≤256, required?,
  options?: { value ≤1024, label? ≤256, description? ≤1024 }[] ≤32 }
```

- accept → daemon answers the adapter `elicitation/create` JSON-RPC request
  with `{action:'accept', content: values ?? {}}` (values keyed by field
  name, verbatim — the wrapper folds them into the tool input).
- decline → `{action:'decline'}`; cancel → `{action:'cancel'}`.

## 3. Daemon (`packages/cli/src/daemon/`)

- **`agent-connection.ts`**: initialize now advertises
  `clientCapabilities: { elicitation: { form: {} } }` (globally — other
  adapters ignore it). Incoming `elicitation/create` requests (top-level
  method, NOT the `session/request` envelope) dispatch to a new
  `setElicitationHandler`; `respondElicitation(jsonrpcId, response)` answers.
  Unhandled agent-side requests are still dropped as before.
- **`chat.ts`**: `DaemonSession.elicitations` map (requestId →
  {jsonrpcId, timer}), mirroring `permissions`. The handler mints a UUID
  requestId, arms a 75s backstop timer (cancel + `elicitation_resolved
  timeout` — the server watchdog is the primary), and emits
  `elicitation_request` with `takeElicitationView(params)`:
  - `message` clamped to 2048 (missing → `''`).
  - `toolCallId` passed through when a string (≤256).
  - `requestedSchema.properties` (≤16 entries) reduced per property:
    `oneOf`/`enum` consts → `enum` options (string entries, or objects'
    `const` + `title`/`description`); `type:'array'` + `items` consts →
    `multi`; `type:'number'|'integer'|'boolean'|'string'` → the matching
    kind (options win over `type` for strings); `required[]` membership →
    `required:true`; title/description/placeholder clamped.
  - Structurally unusable properties (nested `object`, no type + no options)
    are DROPPED. An EMPTY field list is valid and surfaces as a message-only
    card (decline/cancel available, no accept) — the user still sees that the
    agent asked, and the agent still gets an answer.
- Teardown (`closeInternal`) clears elicitation timers like permission's.
- `DAEMON_VERSION` → `0.21.0-p9w14.1`.

## 4. Server (`packages/server/src/realtime/chat.ts` + `plugins/realtime.ts`)

- `onStream` arms an elicitation watchdog per `elicitation_request` — same
  policy and same timeout value as permissions (`CHAT_PERMISSION_TIMEOUT_MS`):
  timeout ⇒ `chat:elicitation.respond {action:'cancel'}` to the daemon +
  `elicitation_resolved timeout` to the channel. One config knob for both is
  deliberate (both are "the agent waits on a human" latencies).
- `onElicitationRespond(ownerId, sessionId, requestId, action, values)`:
  owner gate → clear watchdog → forward verbatim to the daemon → emit
  `elicitation_resolved` (`accepted`/`declined`/`cancelled`). Unknown ids →
  `ELICITATION_NOT_FOUND` (404-style, mirroring permission's 404-ism).
- `/app` registers `chat:elicitation.respond` (validated by the shared
  request schema, ack `{accepted:true}` / `{error:code}`).
- Session teardown clears `elicitationTimers`.

## 5. Web (`apps/web`)

- `realtime.ts` hand-mirrors the new event/field types.
- `fold.ts`: `elicitations: ElicitationCardState[]` slice
  (`{requestId, message, fields, toolCallId?, settled}`), arms mirror the
  permission pair (request upserts by requestId, resolved sets `settled`).
- **`components/chat/elicitation-cards.tsx`** renders unsettled cards inline
  next to `PermissionCards` (same warn-tone card chrome — a pending question
  is a decision). Per field: `enum` → radio rows (label + description),
  `multi` → checkbox rows, `boolean` → checkbox, `number`/`integer` → number
  input, `text` → text input (`autoComplete="off"`, `spellCheck={false}` —
  protocol-ish inputs). Answer submits when every `required` field has a
  value; Decline/Cancel always available. Settled cards vanish (the answer
  lands in the following assistant message — no settled-remnant line, unlike
  permissions whose choice has no other visible trace).
- Strings in `i18n/strings/chat.ts` (en/zh).

## 6. Fixture + tests

- `fixtures/acp-agent.mjs`: prompt containing `ask-user` sends a real
  `elicitation/create` request (enum + text + boolean + integer fields,
  `question_0` required), waits for the response, and echoes
  `elicitation answered: <json>` as the turn's message — exercising the full
  request/response round trip.
- shared: schema accept/reject cases (field types, value union, caps).
- cli: `takeElicitationView` unit cases (oneOf consts, string enum, array→
  multi, required, clamps, drops) + fixture round-trip integration
  (event → `chat:elicitation.respond` accept → echoed answer).
- server: relay + respond routing + watchdog timeout (mirrors the permission
  tests).

## 7. Rig results (2026-09-17, daemon `0.21.0-p9w14.1`)

- claude-code: prompt asking the agent to question the user → the card
  renders (enum radio + custom text + note/boolean fields), answering
  `Red` continues the turn with the selection echoed by the model; decline
  settles as a denied tool use. The MCP-elicitation path was not exercised
  (no MCP server mounted under the chat adapter on the rig).
- Plan lane (env fix, same deploy): a "create todos alpha/beta" turn lights
  the TodoPanel and marks entries off as the model completes them.
- codex / opencode / dsh: unchanged — no elicitation producers (research §1).

## Out of scope

- **url-mode elicitation is NOT advertised** (`elicitation.url` absent): the
  wrapper would then send `elicitation/create {mode:'url'}` + a
  `session/complete_elicitation` notification — an OAuth-jump class of UI we
  do not want in the portal. If ever needed, advertise + render a link card.
- codex / opencode / dsh ask-user: blocked adapter-side (research §1) —
  revisit when codex-acp implements `EventMsg::RequestUserInput` or opencode
  adds a bridge.
- Numeric `minimum`/`maximum`, string `format`/`pattern` hints: fields render
  as plain inputs; validation stays adapter-side (it owns the schema).
- Nested-object properties: dropped by the reducer (§3) — the message-only
  card is the honest fallback.

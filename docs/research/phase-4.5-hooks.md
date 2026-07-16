# Phase 4.5 research: Hook events & the per-target support matrix

> Status: research complete. PRD: `docs/prd/phase-4-web-ui.md` (§4.5). Design:
> to be written into `docs/design/phase-4-web-ui.md` before implementation.

This answers the open question gating the Hook management sub-phase: what is the
canonical hook event set, and which events does each target tool (Claude Code,
ZCode, Hermes) support? The result is a **fixed event × target matrix** that
lands in `packages/shared` and drives both the 4.5 hook editor and the Phase 3.2
install writer.

## TL;DR

- **Claude Code** has a large event set (~30 events across session/turn/tool/
  notification/lifecycle categories).
- **ZCode** supports exactly **7 events** (a strict subset of CC's tool/session
  events). Any other event name is unsupported.
- **Hermes** does **not** use the CC `hooks.json` event→command model at all —
  its hooks are Python plugins (`plugin.yaml` + entry points) registered with a
  `PluginManager`. There is no event-name interop; a Hermes hook is code, not a
  declarative event binding.
- **Conclusion:** model our hook resource as a `hooks.json`-shape document (the
  CC/ZCode interop format), validate events against a per-target matrix, and
  treat Hermes as **unsupported for declarative hooks** (a Hermes hook = a Python
  plugin, which is a different resource shape entirely — out of scope for 4.5).

## The three target models

### Claude Code (~30 events)

Source of truth: [hooks reference](https://code.claude.com/docs/en/hooks).
Verified by reading the official doc (July 2026). Events fall into cadences:

- **once per session:** `SessionStart`, `SessionEnd`
- **once per turn:** `UserPromptSubmit`, `UserPromptExpansion`, `Stop`,
  `StopFailure`, `PreCompact`, `PostCompact`
- **on every tool call:** `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
  `PostToolBatch`, `PermissionRequest`, `PermissionDenied`
- **setup/lifecycle:** `Setup`, `InstructionsLoaded`
- **subagents/teams:** `SubagentStart`, `SubagentStop`, `TaskCreated`,
  `TaskCompleted`, `TeammateIdle`
- **environment/files:** `ConfigChange`, `CwdChanged`, `FileChanged`,
  `WorktreeCreate`, `WorktreeRemove`
- **display/IO:** `MessageDisplay`, `Notification`, `Elicitation`,
  `ElicitationResult`

Hook types: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Matchers are
regex/exact against tool names (for tool events) or other fields.

### ZCode (exactly 7 events — strict subset of CC)

Source of truth: the built-in `zcode-guide` plugin's `diagnosing-hooks/SKILL.md`
on this machine (Z.ai-authored, authoritative). Verified locally.

The **seven** supported events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop`.

> "Events such as `Notification`, `SubagentStop`, and `PreCompact` are **not**
> supported." Matcher is a case-sensitive regex. Two hook types: `command`
> (shell) and `process` (exec vector). Plugin hooks run with no extra trust gate.
> This matches Phase 3 research (`docs/research/phase-3-plugin-targets.md`).

### Hermes (Python plugins — different model)

Source: `~/.hermes/hermes-agent/` (read-only). Hermes hooks are **not** the CC
`hooks.json` model. They are:

1. **Python plugins** under `~/.hermes/plugins/<name>/` with `plugin.yaml` +
   Python entry points, registered via a `PluginManager`. A "hook" is code that
   subscribes to lifecycle events in-process.
2. (config-layer shell hooks exist but are a separate, simpler mechanism.)

There is **no event-name interop** with CC/ZCode. A Hermes hook can't be
expressed as a `hooks.json` event→command binding, and vice versa. **For 4.5,
Hermes is out of scope for declarative hooks** — a Hermes hook is a Python
plugin (a different resource shape). If/when we support it, it's a separate
`kind` or a Phase 7+ concern.

## The event × target matrix

Canonical events (the union we validate against), with per-target support. `✓`
= the event fires in that tool; `✗` = unsupported (the writer drops it for that
target with a reason).

| Event                 | Claude Code | ZCode | Hermes  |
| --------------------- | ----------- | ----- | ------- |
| `SessionStart`        | ✓           | ✓     | — (n/a) |
| `UserPromptSubmit`    | ✓           | ✓     | —       |
| `PreToolUse`          | ✓           | ✓     | —       |
| `PostToolUse`         | ✓           | ✓     | —       |
| `PostToolUseFailure`  | ✓           | ✓     | —       |
| `PermissionRequest`   | ✓           | ✓     | —       |
| `Stop`                | ✓           | ✓     | —       |
| `SessionEnd`          | ✓           | ✗     | —       |
| `PreCompact`          | ✓           | ✗     | —       |
| `PostCompact`         | ✓           | ✗     | —       |
| `Notification`        | ✓           | ✗     | —       |
| `SubagentStart`       | ✓           | ✗     | —       |
| `SubagentStop`        | ✓           | ✗     | —       |
| `UserPromptExpansion` | ✓           | ✗     | —       |
| `PostToolBatch`       | ✓           | ✗     | —       |
| `PermissionDenied`    | ✓           | ✗     | —       |
| (other CC events)     | ✓           | ✗     | —       |

**Hermes column is uniformly "—"** because its hook model is structurally
different (Python plugins, not declarative event bindings). Don't model it as
"unsupported events"; model it as "different resource kind."

### Matrix shape for code

A map `Record<AgentTarget, ReadonlySet<HookEvent> | null>` where `null` means
"this target doesn't use the declarative hooks.json model at all" (Hermes).
Lives in `packages/shared/src/hooks.ts`:

```ts
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'UserPromptExpansion',
  'PostToolBatch',
  'PermissionDenied',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

// null = target uses a different hook model (not declarative hooks.json).
export const HOOK_SUPPORT: Record<AgentTarget, ReadonlySet<HookEvent> | null> = {
  'claude-code': new Set(HOOK_EVENTS),
  zcode: new Set([
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'Stop',
  ]),
  hermes: null,
  generic: new Set(HOOK_EVENTS), // assume permissive for 'generic'
};
```

## Hook resource shape (for 4.5)

A hook resource stores a **`hooks.json` document** (the CC/ZCode interop
format) as `source: { type: 'inline', content: <JSON string> }`. The content is
the `{ hooks: { <Event>: [{ matcher?, hooks: [...] }] } }` shape both CC and
ZCode consume. The editor is a structured event→handler form that emits valid
`hooks.json`, not a freeform textarea (too easy to produce invalid JSON).

**Validation at save time:** parse the JSON, and for each event key, check it
against `HOOK_SUPPORT` for each of the resource's `targets`. An event unsupported
by _all_ declared targets is a hard error (`409 HOOK_EVENT_UNSUPPORTED`). An
event unsupported by _some_ targets is a soft warning surfaced in the UI ("this
hook will be dropped for ZCode") but still saved (the install writer filters per
target).

## Open risks & decisions

1. **Hook handler types.** CC supports 5 (`command`/`http`/`mcp_tool`/`prompt`/
   `agent`); ZCode supports 2 (`command`/`process`). 4.5's editor should offer
   `command` (universal) first; `process` (ZCode) and the CC-only types are
   later refinements. Don't over-build the handler editor initially.
2. **`process` vs `command`.** ZCode's `process` type (exec vector) has no CC
   equivalent; CC's shell form is `command`. The editor maps a "command" entry
   to `command` for CC and either `command` or `process` for ZCode. Keep it
   simple: emit `command` (shell) for both in 4.5; `process` is a ZCode nicety
   for later.
3. **Matcher semantics differ subtly** (CC v2.1.195+ hyphen rules; ZCode is
   case-sensitive regex always). The editor shouldn't try to abstract this —
   surface "matcher is a regex against the tool name" and let the author own it.
4. **Hermes.** Out of scope for 4.5 (different model). A Hermes target on a hook
   resource should be rejected at save (`409 TARGET_NO_DECLARATIVE_HOOKS`) rather
   than silently ignored.

## Sources

- Claude Code: [hooks reference](https://code.claude.com/docs/en/hooks) (read in
  full, July 2026 — the authoritative event list + schemas).
- ZCode: built-in `zcode-guide` plugin, `diagnosing-hooks/SKILL.md` (on-disk,
  this machine) — the 7-event list + matcher/handler semantics.
- Hermes: `~/.hermes/hermes-agent/` (read-only) — Python `PluginManager` model,
  no `hooks.json` event interop.
- Phase 3 research: `docs/research/phase-3-plugin-targets.md` (ZCode hook
  narrowing, plugin hook formats).

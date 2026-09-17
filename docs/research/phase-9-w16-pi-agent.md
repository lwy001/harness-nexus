# Research: Phase 9 W16 — pi agent onboarding feasibility

> Status: **verified against the official docs (2026-09-17)** —
> [pi.dev/docs/latest](https://pi.dev/docs/latest) (installation, settings,
> custom-provider, models, sessions, session-format, skills, security, rpc)
> plus the npm registry manifests. NOT rig-verified — this is a feasibility
> study for a candidate T-wave target, requested by the user; nothing is
> scheduled. pi is Mario Zechner's (badlogic) minimal terminal coding
> harness, now maintained by **Earendil Works**; it also powers OpenClaw.

## 0. Verdict up front

| Platform surface | Feasibility | Note |
| --- | --- | --- |
| W1 probe + W2 install/upgrade/pin | **cheap** | npm arm verbatim; `pi --version`; **Node ≥22.19 engine** (highest yet) |
| W3 provider push | **cheap** | `models.json` + `settings.json`, both documented JSON; pi's `api` enum covers ALL THREE of our provider api kinds — first perfect 1:1 target |
| W4 redacted viewer | **cheap** | all-JSON config files; `auth.json` wholesale-redacted, key file wholesale |
| W7 native-sessions rail | **cheap** | plain JSONL file scan (no zstd, unlike dsh); header carries id/timestamp/cwd |
| C5 ACP chat | **the cost center** | pi has **NO native ACP**; needs a daemon-side ACP↔pi-RPC bridge (new dialect class) or a young third-party adapter |
| Profile deploy (install adapter) | **partial** | skills + prompt-templates fit; **MCP has NO declarative surface** (extension-based), sub-agents/hooks are TS code |
| C3 inventory scan | **partial** | skills/templates scannable; no MCP arm |
| Hooks | **n/a** | `HOOK_SUPPORT['pi'] = null` (extensions are TS modules, like hermes/codex class) |

Biggest structural risks: pre-1.0 churn (0.55.3 → 0.85.1 in ~4 months, one
org/package rename already happened) and the chat bridge being ours to own.

## 1. Identity & maturity

- Canonical npm: **`@earendil-works/pi-coding-agent`** — 0.85.1 (published
  12 days before this note), ~1.88M weekly downloads, MIT, repo
  `earendil-works/pi` (ex `badlogic/pi-mono`).
- The original **`@mariozechner/pi-coding-agent` is DEPRECATED** (last
  0.73.1, ~4 months stale) with the author's pointer: "please use
  `@earendil-works/pi-coding-agent` instead going forward". We must pin the
  earendil name and never the old one.
- Monorepo packages in lockstep (`pi-ai`, `pi-agent-core`, `pi-tui`, …);
  docs at pi.dev; engine `node >=22.19.0` (registry manifest), bin **`pi`**.
- Movement: very active, pre-1.0, breaking changes land in minors. An
  onboarding wave must pin exact versions and expect follow-up repairs
  (same posture we already hold for dsh release candidates).

## 2. Install & version (W1/W2)

- `npm install -g @earendil-works/pi-coding-agent` — plain npm channel,
  no platform-binary postinstall, no native self-update command (upgrade =
  `npm update -g`), so `HARNESS_PACKAGES['pi'] = '@earendil-works/pi-coding-agent'`
  covers install/upgrade/pin uniformly, exactly like codex/opencode.
- `pi --version` prints the version — feeds the standard W1 probe
  (`bin: 'pi'`, PATH walk; no known-path fallback needed beyond PATH).
- **Node ≥22.19** — above dsh's 22.15 floor and our Node 20 CI floor.
  The rig daemon runs 22.23 (fine); older daemons get the dsh-style result
  `warning` on install jobs ("pi needs Node ≥22.19").

## 3. Home & config layout (W3 writer / W4 viewer)

Home = **`~/.pi/agent/`** (override: `PI_CODING_AGENT_DIR`). Everything the
platform would touch is JSON:

- **`settings.json`** (global; project `.pi/settings.json` merges
  recursively, arrays replace). Fields we care about: `defaultProvider`,
  `defaultModel`, `defaultThinkingLevel`, `enabledModels` (string[] — the
  model picker set, our W10/W13 switchable-list hook), plus resource arrays
  `skills`/`prompts`/`extensions`/`packages` with glob + `!exclusion` +
  `+path`/`-path` syntax (paths resolve against the settings file's dir).
- **`models.json`** — custom/override providers. Schema: top-level
  `providers` map; each provider `{ baseUrl, api, apiKey?, headers?,
  authHeader?, models?, modelOverrides? }`; each model `{ id, name?,
  api?, reasoning?, input?, contextWindow?, maxTokens?, cost?, compat? }`.
  - Overriding a BUILT-IN provider (e.g. `anthropic`) with `baseUrl` only
    keeps its built-in models and existing auth; adding `models` MERGES by
    `id` (same id replaces, new ids append). This is a cleaner write target
    than opencode's provider map.
  - `api` values: `anthropic-messages`, `openai-completions`,
    `openai-responses`, `google-generative-ai`, and more. **Our three
    provider api kinds map 1:1** (`anthropic`, `openai-chat`,
    `openai-responses`) — pi is the first target supporting all three, so
    `PROVIDER_API_SUPPORT['pi']` can be the full set with no flavor
    filtering.
  - **`apiKey` value resolution**: literal, `$VAR`/`${VAR}` env
    interpolation, and **`!command`** (stdout becomes the value, resolved
    per request). That gives the opencode-style secret pattern without
    extension: raw key in a 0600 file + `apiKey: "!cat
    ~/.pi/agent/harness-nexus.key"` in models.json. (Escapes: `$$`, `$!`.)
  - Reloads whenever `/model` opens — no restart needed after a push.
- **`auth.json`** — the user's own `/login` (OAuth/API-key) store. We NEVER
  write it (same decision as opencode's `auth.json`); W4 redacts it
  wholesale.
- **`trust.json`** — per-directory project-trust decisions (§6). No
  secrets; viewer can show it masked as ordinary JSON.

W3 writer sketch: merge-preserving writes of (a) `models.json`
`providers["harness-nexus"]` (or a baseUrl-only built-in override when the
user picks a built-in provider id) with our model rows, and (b)
`settings.json` `defaultProvider`/`defaultModel` (+ `enabledModels` =
`unique([model, ...extras])`, the dsh-style multi-model set). A
baseUrl-less re-apply removes ours, mirroring claude/opencode semantics.
JSON only — no TOML/YAML writers needed.

## 4. ACP & chat (C5) — no native ACP

The docs tree (quickstart, usage, providers, settings, sessions,
extensions, skills, prompt-templates, themes, packages, models,
custom-provider, sdk, **rpc**, json, tui, session-format, …) contains **no
ACP page**. Integration is via pi's own **RPC mode**:

- `pi --mode rpc` — LF-delimited JSONL over stdio (docs explicitly warn
  against Node `readline`: it splits on U+2028/U+2029, which are legal
  inside JSON strings — our hand-rolled line reader must split on `\n`
  only).
- Commands (stdin): `prompt` (message, images, `streamingBehavior:
  steer|followUp`), `steer`, `follow_up`, `abort`, `new_session`,
  `switch_session`, `set_model`, `cycle_model`, `get_available_models`,
  `set_thinking_level`, `get_state`, `get_messages`, `get_entries`
  (history, `since` cursor), `get_commands` (slash commands — would light
  up the W15 palette), `get_session_stats`, `fork`/`clone`,
  `set_session_name`, `compact`, `bash`/`abort_bash`.
- Events (stdout): `agent_start/end/settled`, `turn_start/end`,
  `message_start/update/end` (deltas: `text_*`, `thinking_*`,
  `toolcall_*`, assemble via `contentIndex`; `message_end.message` is
  authoritative), `tool_execution_start/update/end` (by `toolCallId`),
  `bash_execution_update`, `compaction_*`, `extension_error`, and the
  `extension_ui_request` → `extension_ui_response` dialog sub-protocol
  (`select`/`confirm`/`input`/`editor`).
- Launch flags: `--provider`, `--model provider/id[:thinking]`, `--name`,
  `--session <id|path>`, `--no-session`, `--session-dir`.

**Options for the C5 row:**

1. **Write our own ACP↔RPC bridge** (recommended if we onboard). The
   daemon already owns two dialect classes (standard ACP + dsh's divergent
   dialect); this is a third — a `PiRpcConnection` speaking pi's JSONL
   instead of ACP JSON-RPC, mapped onto the same semantic stream
   (`message_update` deltas → text/thinking chunks, `tool_execution_*` →
   tool cards, `turn_end` → turn tail, `get_available_models`/`set_model`
   → W9 model selector, `get_commands` → W15 palette, `get_entries` →
   history). Comparable in size to the T1 dsh mapping work.
2. **Third-party adapter** — `pi-acp` on npm (user deepstereo, **0.0.33**,
   ~1 month old; the svkozak/pi-acp lineage spawns `pi --mode rpc` and
   bridges ACP JSON-RPC over stdio; the victor-software-house fork embeds
   the pi SDK in-process). Also `@frmhd/pi-sdk-acp-adapter` (0.2.0). All
   pre-1.0, community, chasing a pre-1.0 core — fine as REFERENCE
   implementations for dialect shapes, risky as a hard dependency our
   chat path rides on. If we want a quick demand test before committing
   to option 1, `pi-acp` behind `HN_ACP_COMMAND_PI` is the cheapest probe
   (the env override already exists for exactly this).

**Permissions: none to map.** pi's security model is full-user-permissions
by design — no per-tool allowlist, no approval request in RPC mode (the
only dialog-ish channel is `extension_ui_request`, extension-driven). Our
portal permission cards would simply never fire for pi; the honest UI
state is "no permission gating" (note it in the design doc; the
`--tools`/`--exclude-tools` CLI flags can constrain the tool set at spawn
if we ever want a locked-down mode).

## 5. Native sessions (W7 rail) — file scan, like dsh but simpler

- Storage: **`~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`**
  where `<path>` is the cwd with `/`, `\`, `:` replaced by `-` (leading
  separator stripped). Session id = UUID by default (overridable). Plain
  JSONL — no compression, no multi-frame decode.
- First line is a header: `{type:"session", version:3, id, timestamp, cwd,
  parentSession?}` — id + creation time + cwd all right there (dsh needed
  per-entry digging; pi is cleaner). `version` 1/2/3 with auto-migrate.
- Entries: `id` (8-char hex typical), `parentId`, ISO `timestamp`, and
  types `message` (roles system/user/assistant/toolResult/bashExecution/
  custom/branchSummary/compactionSummary), `model_change`,
  `thinking_level_change`, `session_info` (`name` — the display title),
  `label`, `compaction`, `branch_summary`, `custom`. Tree-shaped (id/
  parentId); the active leaf is the current position.
- Listing = scan the sessions dir (per-cwd grouping falls out of the
  folder name; alternatively parse header `cwd`), title = last
  `session_info.name` (else untitled), mtime for recency. History for the
  resync replay = walk the active leaf chain of `message` entries → our
  `HistoryItem` user/event shapes.
- Resume: `pi --session <id|path>` (partials accepted) at spawn, or
  `switch_session` over RPC mid-connection. Both fit the W7
  method-from-capability pattern; no adapter spawn needed for LISTING
  (pure file scan — the dsh arm, minus zstd).

## 6. Security & trust model (chat cwd interplay)

- Tools run with the pi process's full user permissions; **no built-in
  sandbox and no tool allowlist** — upstream explicitly declines a partial
  in-process sandbox ("easy to misunderstand as a security boundary").
- The one gate is **project trust**: project-level resources
  (`.pi/settings.json`, extensions, skills, prompts, themes) load only
  after a trust decision (`~/.pi/agent/trust.json`, closest parent wins,
  global `defaultProjectTrust: "ask" | "always" | "never"`). `AGENTS.md`
  and bare `.pi` dirs load regardless.
- **RPC/-p/json modes never prompt**: with no saved decision, `"ask"` and
  `"never"` silently IGNORE protected project resources. Our chat daemon
  spawns `--mode rpc` in the session cwd → user-level resources always
  load, project `.pi` resources may silently not. Honest rail/config note
  at implementation time (or pre-seed `trust.json` for the base workspace
  — decision for the design doc).

## 7. Skills, templates, packages (deploy adapter + C3 scanner)

- **Skills = Agent Skills standard** (agentskills.io): `SKILL.md` with
  frontmatter `name` (≤64, kebab-case) + `description` (≤1024, required),
  optional `license`/`compatibility`/`metadata`/`allowed-tools`/
  `disable-model-invocation`. pi tolerates name ≠ directory name (unlike
  the strict standard). Progressive disclosure via system-prompt index +
  on-demand read; explicit `/skill:name` invocation.
- Load locations: user **`~/.pi/agent/skills/`** and **`~/.agents/skills/`**
  (the cross-harness standard dir — nice interop story), project
  `.pi/skills/` + `.agents/skills/` (trust-gated), plus settings `skills`
  array and packages' `skills/` dirs. **Our profile adapter writes
  `~/.pi/agent/skills/`** — same shape as the opencode adapter. C3 scanner
  reads it back (SKILL.md present ⇒ skill; the dir-name≠name wrinkle means
  the scanner should read frontmatter `name`, not the folder).
- **Prompt templates** = pi's commands analog (user-invocable `/name`
  bodies). Distributed via packages and a settings `prompts` array; exact
  user-level template directory not captured in this pass — verify at
  implementation (minor; adapter can also emit a settings `prompts`
  entry).
- **Extensions** = TypeScript modules (tools, sub-agents, permission
  gates, MCP clients, UI). NOT declarative — the platform cannot install
  or scan them beyond listing; sub-agents and hooks ride here → both
  SKIPPED by a deploy adapter (warning rows), `HOOK_SUPPORT['pi'] = null`.
- **MCP: no built-in declarative surface.** No `mcpServers` settings key;
  MCP is added by community extensions reading an `mcp.json` convention
  (e.g. `pi-mcp-extension`; upstream issue #563 tracks an official
  example). A profile's MCP entries therefore CANNOT be installed for pi
  the way they can for every other target — skip-with-warning is the only
  honest behavior today. Revisit if/when pi ships first-party MCP config.
- pi **packages** (`pi install`, npm/git sources into `~/.pi/agent/npm|git`)
  bundle skills/templates/extensions/themes — out of scope for us (we
  already have our own profile bundling), but the dirs are scanner-relevant
  provenance markers if we ever distinguish them.

## 8. What an onboarding wave would look like (if green-lit)

Zero new platform concepts — the W12 opencode shape applies almost
verbatim: `pi` joins `AgentTarget` + `RUNTIME_TARGETS` + `SCANNABLE_
TARGETS`; `HARNESS_PACKAGES['pi']`; probe bin `pi`; `PROVIDER_API_SUPPORT
['pi'] = ['anthropic', 'openai-chat', 'openai-responses']`;
`HOOK_SUPPORT['pi'] = null`; `TARGET_CONFIG_FILES['pi']` = settings.json,
models.json, auth.json (wholesale), key file (wholesale), trust.json.
Suggested slicing:

- **Slice A (cheap, no chat): probe + jobs + W3 writer + W4 viewer + W7
  sessions rail + C3 scanner + DEPLOYABLE adapter (skills/templates).**
- **Slice B (the cost center): the `PiRpcConnection` chat dialect** —
  delta/tool/turn mapping, history via `get_entries`, model selector via
  `get_available_models`/`set_model`, palette via `get_commands`,
  `--session`/`switch_session` resume. Optionally preceded by a cheap
  `HN_ACP_COMMAND_PI=pi-acp` demand probe on the rig.

Open items to verify at implementation time (NOT blockers): exact
user-level prompt-template directory; whether a home-level `AGENTS.md`
(applied globally) is read — pi's rules loading is cwd-ancestor based, so
rules likely deploy as project-level or get skipped like dsh's;
`extension_ui_request` surfacing (skip initially).

## 9. Sources

- pi.dev docs — installation, settings, custom-provider, models
  (models.json), providers, sessions, session-format, skills, security,
  rpc, packages; npm registry manifests for
  `@earendil-works/pi-coding-agent` (0.85.1, engines ≥22.19.0) and the
  deprecated `@mariozechner/pi-coding-agent` (0.73.1).
- Community ACP bridges: `pi-acp` (npm, deepstereo, 0.0.33),
  svkozak/pi-acp, victor-software-house/pi-acp (SDK-embedding fork),
  `@frmhd/pi-sdk-acp-adapter` — dialect references only.
- Upstream issues: earendil-works/pi #563 (official MCP extension
  example), #1900 (`PI_CODING_AGENT_DIR` in examples).

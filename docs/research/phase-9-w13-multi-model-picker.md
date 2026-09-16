# Research: Phase 9 W13 — multi-model configuration (making the model dropdown meaningful)

> Status: **research only — verified at source level 2026-09-16, nothing
> implemented yet.** Verified against: `agentclientprotocol/claude-agent-acp`
> `v0.76.0` + main (`src/session-model.ts`, `src/acp-agent.ts`),
> `zed-industries/codex-acp` 0.16.0 (`src/thread.rs`) +
> `openai/codex` `rust-v0.137.0` `codex-rs/models-manager`, and `sst/opencode`
> main (`packages/opencode/src/acp/{config-option,service}.ts`). dsh needs no
> new work — W10 already shipped its multi-model list
> (`docs/design/phase-9-w10-llm-providers.md` §6).

## 0. The problem

The W9 session-config model selector lists whatever the ADAPTER advertises.
Under a W3 gateway push, everything except our pushed default is the agent's
own built-in catalog (claude SDK model infos / codex remote presets / opencode
models.dev full table) — model ids the gateway does not serve, i.e. dead
entries in the dropdown. W10's `RuntimeConfigSpec.models` extras exist in
storage and UI (the collapsible checkbox list) but currently land only in the
dsh writer. Question: per target, can the dropdown show ONLY the models we
configured?

Answer up front: **yes, on all four targets, without a single new platform
concept** — one writer key (claude-code), one daemon-side option rewrite
(codex/opencode), one server hint on the open wire (codex). dsh is done.

## 1. Per-target ground truth

### 1.1 claude-code — NATIVE allowlist, writer-side fix

`@agentclientprotocol/claude-agent-acp` builds its `model` configOption from
the SDK model list **restricted by the `availableModels` settings allowlist**
(`applyAvailableModelsAllowlist`, `src/session-model.ts`; applied in
`acp-agent.ts` at session start from `settingsManager.getSettings()`):

- `~/.claude/settings.json` top-level `availableModels: string[]`. Documented
  Claude Code semantics (model-config: "restrict model selection"); the
  wrapper applies it itself, so it works even where the CLI's own UI never
  runs.
- The `default` row always survives the allowlist (docs semantics; it resolves
  to the effective default — with our `model` push, that IS our model).
- **Unknown ids are synthesized verbatim**: an allowlist entry that matches no
  SDK model becomes `{ value: <raw id>, displayName: <raw id> }` and is passed
  to `setModel` as-is — exactly what gateway model ids (`doubao-seed-1.6`,
  …) need. No SDK match required.
- `session/set_config_option` validates the value against the option list /
  `currentValue` / fuzzy-resolve — with the allowlist in place the list IS our
  models, so our values pass by construction.
- Resume edge: a session pinned to an out-of-list model reports it as a
  verbatim `currentValue` entry and re-asserting `currentValue` is explicitly
  allowed (out-of-picker handling in the set path).
- Side effect (intended): `availableModels` also constrains the machine's
  terminal `/model` picker — consistent with a platform-managed route.
- Also present but not needed: `CLAUDE_MODEL_CONFIG` env (JSON
  `{modelOverrides, availableModels}`) and `ANTHROPIC_CUSTOM_MODEL_OPTION`.

**Fix**: the W3 claude writer (`applyClaudeConfig`) already merges
`~/.claude/settings.json`; add
`availableModels: unique([spec.model, ...(spec.models ?? [])])` beside
`model`. Caveat: synthesized entries carry no SDK capability flags, so the
effort/thought_level option stays hidden for non-claude ids — same as today,
no regression.

### 1.2 codex — no config seam; daemon-side list rewrite (sets accept raw ids)

`codex-acp` 0.16.0 (`src/thread.rs`):

- Option list = `models_manager.list_models()` — codex-rs `models-manager`
  pulls a REMOTE catalog (auth-gated endpoint, `models_cache.json` cache, TTL
  300s), filtered by auth mode + `show_in_picker`. The current model gets a
  verbatim entry appended when no preset matches it (that is the one usable
  row users see today).
- `config.toml` can only override model METADATA (`model_context_window`,
  `model_supports_reasoning_summaries`, … — `with_config_overrides`); **there
  is no allowlist setting**. The picker list is not configurable.
- **`session/set_config_option {configId:'model'}` does NOT validate the value
  against the list**: `handle_set_config_model` looks the id up in the presets
  and, on miss, uses the RAW STRING as the model (effort keeps the current
  config for raw strings). Arbitrary gateway ids are accepted.

**Fix**: rewrite the `model` option's list on OUR wire only (see §2) — sets
still flow through unchanged as raw ids.

### 1.3 opencode — filter by our provider prefix; sets validated but ours exist

opencode main (`packages/opencode/src/acp/`):

- `configOptions` = **every provider in the snapshot × its models**
  (`Object.values(snapshot.providers)`), value `providerID/modelID` (optional
  `/variant`); the models.dev built-ins are all in there — the huge noise.
- `set_config_option` IS validated: `parseSelectedModel` requires the
  `(providerID, modelID)` pair to exist in the registry, else
  `ACPError.InvalidModelError`. **But our W12 writer's
  `provider['harness-nexus'].models` map (default + extras) is part of the
  registry** — every `harness-nexus/*` value is selectable and valid.

**Fix**: daemon-side filter keeping only `harness-nexus/*` entries in the
`model` option. Self-contained — no server knowledge needed, and W10 extras
are already persisted into the models map by the W12 writer.

### 1.4 deepseek (dsh) — already shipped

W10: the dsh writer emits `unique([model, ...models])` into the provider's
`models:` list; dsh's session model picker reads that live catalog natively.
Nothing to do.

## 2. Recommended implementation surface (W13)

Three converging moves on existing W9/W10 surfaces — **zero schema, storage,
or web changes** (the selectors already render whatever options arrive):

1. **claude writer** (`packages/cli/src/daemon/runtime-config.ts`,
   `applyClaudeConfig`): write `availableModels` next to `model` in the
   settings.json merge. Always write it when a spec exists (even a single
   model — the built-ins are dead entries under a gateway); a baseUrl-less
   spec keeps the same semantics.
2. **daemon option rewrite** (`packages/cli/src/daemon/chat.ts`): both arms
   that admit adapter options — the establishment capture
   (`takeSessionConfig`) and the `config_option_update` push
   (`takeConfigOptions` call site) — pass the result through a per-target
   `rewriteModelOptions(options, target, modelSet?)`:
   - `opencode`: keep only `harness-nexus/`-prefixed values in the `model`
     option (keep `currentValue` verbatim if it is out-of-list, mirroring the
     adapters' own out-of-picker semantics; if the filter empties the list,
     leave the option untouched — a hand-managed opencode install).
   - `codex`: keep only the server-provided set (§2.3) plus `currentValue`.
   - `claude-code` / `deepseek`: untouched (writer / native already
     converge).
   - Rewriting the PUSH path too is load-bearing: the adapter re-emits the
     full option list after every set, which would reintroduce the noise
     mid-session otherwise. The rewrite only shapes OUR wire; adapter state
     is untouched, and `chat:config.set` passes through unchanged (values
     already valid per §1).
3. **codex model-set hint** (server → daemon): the codex writer does not
   persist extras anywhere (single root `model`), so the daemon cannot
   discover them from config files. `ChatService.open` already knows
   `agentInstance → (machineId, target)`; look up the stored `RuntimeConfig`
   and attach an optional `modelOptions: string[]`
   (`unique([model, ...models])`) to the `chat:session.open` payload
   (`shared/realtime.ts` schema, optional field — pre-W13 daemons ignore it).
   Rejected alternative: daemon reads back `config.toml` — extras are not in
   it.

Web: nothing. The extras picker already exists (W10 checkbox list on
MachineDetail); the session selector renders the filtered list.

## 3. Risks & boundaries

- `availableModels` constrains the machine's local terminal picker too — the
  documented Claude Code semantics; intended for a platform-managed machine,
  but worth a note in the W13 design (an operator hand-running claude on the
  machine loses the built-in rows while a spec is applied).
- Synthesized claude entries carry no capability metadata → effort selector
  hidden for non-claude ids (status quo for gateway models; no regression).
- The model ids themselves must be servable by the gateway — unchanged W10
  semantics: extras come from the endpoint's own `/models` fetch (server-side
  discovery), the user picks them.
- opencode filter depends on our provider id constant `harness-nexus` (same
  id the W12 writer uses — single source it in shared if W13 proceeds).
- Adapter versions drift: codex-acp's "raw id accepted" and opencode's
  registry validation are current-source behavior; both were checked at the
  versions we actually run (0.16.0 / opencode 1.18.31-era main).

## 4. Estimate

- claude writer + tests: ~0.5 day
- daemon rewrite (both arms, per-target, + tests): ~1 day
- server open-hint + shared schema + tests: ~0.5 day

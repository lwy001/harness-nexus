# Design: Phase 9 W13 — multi-model picker (only usable models in the dropdown)

> Status: **in development (2026-09-16).** Implements the feasibility
> verdict of [`../research/phase-9-w13-multi-model-picker.md`](../research/phase-9-w13-multi-model-picker.md)
> (source-verified per adapter). Goal: the session-config model selector
> lists ONLY models the platform configured — the pushed default plus the W10
> `models` extras — instead of the agent's own built-in catalog, which is
> dead entries under a gateway route. Zero web changes, zero storage/entity
> changes; one optional wire field, one writer key, one daemon-side rewrite.

## 1. Per-target mechanism

| Target      | Mechanism                                                                                                                                                                                                                                                                                                                                            | Where                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| claude-code | W3 writer adds `availableModels: unique([model, ...extras])` to `~/.claude/settings.json`; the ACP wrapper applies the allowlist itself and synthesizes unknown ids verbatim (`applyAvailableModelsAllowlist`).                                                                                                                                      | `cli/src/daemon/runtime-config.ts`                                |
| codex       | Daemon rewrites the `model` option list on OUR wire; `session/set_config_option` accepts raw ids (no list validation), so the set path is untouched. The model set rides `chat:session.start` (`modelOptions`), because the codex writer persists only the single root `model`.                                                                      | `cli/src/daemon/model-options.ts` + `server/src/realtime/chat.ts` |
| opencode    | Same daemon rewrite; allowed values are `modelOptions` mapped to `${OPENCODE_PROVIDER_ID}/${id}` — those exist in the provider registry (the W12 writer's `models` map), so `set` stays valid (`parseSelectedModel` requires registry existence).                                                                                                    | `cli/src/daemon/model-options.ts`                                 |
| deepseek    | Daemon FLATTENS dsh's nested grouped options (its `options: [{group, name, options: […]}]` shape failed the flat wire schema, so dsh showed NO model selector at all — rig-found) and intersects on `["harness-nexus","<id>"]` JSON tuples, dropping the built-in `deepseek-official` group. Extras still come from the W10 `models:` catalog write. | `cli/src/daemon/chat.ts` + `model-options.ts`                     |

## 2. Wire change (server → daemon)

`chatSessionStartEventSchema` (shared/realtime.ts) gains
`modelOptions?: string[]` (≤32 ids). ChatService.open resolves the agent's
stored `RuntimeConfig` (`uow.runtimeConfigs.findByMachineAndTarget`) and
sends `unique([spec.model, ...(spec.models ?? [])])` — the stored `models` is
extras-only (PUT normalizes), the prepend is the caller's job, same as the
writers. Field omitted when no row exists (or the target is not
runtime-managed — hermes/zcode). Old daemons strip the unknown key
(zod non-strict) — no compatibility break.

## 3. Daemon rewrite (`cli/src/daemon/model-options.ts`)

Pure functions, applied at every point adapter options enter our wire:

- establishment responses (`takeSessionConfig` results, all three arms),
- the live `config_option_update` push (which REPLACES the whole list — the
  rewrite must be idempotent, and re-applying after a set is what keeps the
  noise from coming back),
- the `session/load` capture path's history items (belt-and-braces — the
  response snapshot is last-wins anyway, but a resync replay should not flash
  an unfiltered list).

Rules (only `category === 'model'` select rows are touched):

- claude-code / deepseek / everything else: identity.
- codex: BUILD the list from `modelOptions` (bare ids) — keep the adapter's
  entry when a value exists in its list (preserves display names), else
  synthesize `{value, name: value}`. Building, not filtering, is load-bearing:
  codex only ever advertises its remote presets plus the CURRENT model as a
  verbatim entry, so configured extras never appear in its own list — an
  intersection filter silently dropped every extra beyond the current model
  (rig-found on 0.16.0). Raw ids are genuinely selectable on set (no list
  validation). No `modelOptions` → identity (old server / no stored config).
- opencode: INTERSECT with `modelOptions.map(id => `${OPENCODE_PROVIDER_ID}/${id}`)`
  — set validates against the provider registry, so only values the adapter
  itself offers are certain to be selectable. Empty intersection → the row
  stays untouched: a hand-managed install (or a provider the config no longer
  describes), where the full list is the honest state. No `modelOptions` →
  identity.
- `currentValue` not represented in the resulting list is appended as a
  verbatim entry — mirrors the adapters' own out-of-picker semantics (e.g. a
  resumed session running a model outside our set).

`chat:config.set` is deliberately untouched: values forward verbatim and the
optimistic merge matches by option id; the rewrite only narrows entries and
never invents a VALUE the platform didn't configure (synthesized entries carry
exactly the configured ids).

`OPENCODE_PROVIDER_ID = 'harness-nexus'` is exported from
`shared/src/schemas/runtime-config.ts` (single source; the W12 writer's
module-private const adopts it).

## 4. Decisions & trade-offs

- **claude `availableModels` is always written while a spec exists** — even
  for a single model. Under a gateway the built-ins are dead entries, and
  this matches dsh/opencode behavior (their catalogs are exactly the pushed
  set). The key is platform-owned: re-apply overwrites a user's own
  `availableModels` array. Side effect (documented Claude Code semantics):
  the machine's TERMINAL `/model` picker narrows too — intended for a
  platform-managed machine, but an operator hand-running claude there loses
  the built-in rows while a spec is applied. The wrapper always keeps a
  `Default` row (resolves to the pushed `model`).
- Synthesized claude entries carry no SDK capability metadata → the effort
  selector stays hidden for non-claude ids (status quo for gateway models,
  no regression).
- Whether a model id is actually servable remains W10 semantics: extras come
  from the endpoint's own `/models` discovery and are user-picked.
- Fallback matrix: old server + new daemon (no hint) → full list (honest
  fallback); new server + old daemon (field stripped) → full list (status
  quo). No new daemon capability — the soft-gates don't change.

## 5. Out of scope

- dsh (done in W10); web changes (selectors already render whatever arrives);
  schema/storage migrations; per-PAT or per-profile model sets;
  `modelOverrides` / `ANTHROPIC_CUSTOM_MODEL_OPTION` arms of the wrapper;
  restricting codex's own terminal model picker (no config seam exists —
  daemon-side filtering is wire-only by design).

## 6. Verification

- Unit: shared schema (field presence/absence), server open payload
  (`modelOptions` from a seeded row; omitted without one),
  `model-options.ts` matrix, claude writer goldens (single/extras/idempotent).
- Integration: chat.test.ts round-trip with the fixture agent driven as
  `codex` + `modelOptions` — filtered ready snapshot, filtered re-push.
- Rig E2E: apply configs with one extra per target; claude settings.json
  shows `availableModels`; all three pickers show only our models; page
  refresh (resync) keeps the filtered list.

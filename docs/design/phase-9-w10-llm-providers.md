# Phase 9 W10 — LLM provider management

> Status: shipped (2026-09-11). Extends the W3 provider-config push — read the
> W3 section of `docs/design/phase-9-harness-runtime.md` §4.3 first.

## 1. Problem

W3's provider-config form makes the machine owner hand-assemble the whole spec
(label + api flavor + base URL + model + credential) on every machine. In
practice the same gateway (with its key and endpoint) is reused across
machines, and the model id is copy-pasted blind — the platform never knows
which models the endpoint actually serves.

The open-source [cc-switch](https://github.com/farion1231/cc-switch) tool
established the UX this wave ports: a provider is a reusable
**name + api kind + endpoint + key**, and a one-click **获取模型** button
discovers the model list from the endpoint's models API (`/v1/models`) instead
of pasting ids by hand.

## 2. What shipped

1. **`LlmProvider` entity** (`global | personal` scope, like credentials): a
   named, reusable LLM route — `{ name, api kind, baseUrl?, credentialName }`.
   The API key still lives ONLY in the existing encrypted `Credential` store;
   the provider references it by name.
2. **Three api kinds** — `openai-chat`, `openai-responses`, `anthropic` — and
   a per-Agent support matrix so the machine page only offers providers the
   target can actually speak.
3. **Model-list discovery**: `POST /api/llm-providers/query-models` fetches
   the provider's model catalog server-side (the plaintext never leaves the
   server; the browser cannot do this — CORS + key exposure).
4. **Machine page provider-first flow**: pick a provider → pick (or fetch)
   the model → apply. Manual entry stays as a fallback arm.
5. **Multi-model** (the "顺便看看" question, ground truth in §6):
   `RuntimeConfigSpec.models` — an optional list of extra model ids beyond
   the default. Only dsh has a native home for it (its per-provider
   `models:` list); the dsh writer now writes them.

## 3. Data model

### 3.1 `LlmProvider` (new; migration `0015`)

```
core/domain/llm-provider.ts
{ id, name, api: 'openai-chat' | 'openai-responses' | 'anthropic',
  baseUrl: string | null,        // null = the kind's official endpoint
  credentialName: string,        // handle of a Credential carrying the API key
  scope: 'global' | 'personal', ownerId: string | null,
  createdAt, updatedAt }
```

SQLite table `llm_providers` (no FK — owners outlive rows the same way
credentials do). Name uniqueness is per `(name, scope, owner)`, enforced
read-then-write in the route (`409 PROVIDER_NAME_TAKEN`), mirroring the
resources `key` rule. Repository port + `UnitOfWork.llmProviders`, both
drivers implemented.

**Why reference a credential instead of storing the key?** The apply path's
invariant is "the plaintext leaves the server only inside the daemon's
machine-PAT bundle, only for a **distributable** credential". Reusing the
credential store keeps one encryption path, one distributability gate, and
rotation for free. The provider is the _route_, the credential stays the
_secret_.

### 3.2 Api kinds vs. W3 spec flavors

The W3 `RuntimeConfigSpec.api` enum stays `'anthropic-messages' | 'openai'`
(writers keyed on it are untouched). Providers use a FINER kind because
codex and dsh differ inside "openai":

| kind               | speaks                  | maps to spec api     |
| ------------------ | ----------------------- | -------------------- |
| `anthropic`        | Anthropic Messages      | `anthropic-messages` |
| `openai-chat`      | OpenAI Chat Completions | `openai`             |
| `openai-responses` | OpenAI Responses        | `openai`             |

**Per-Agent support matrix** (`PROVIDER_API_SUPPORT`, shared):

- `claude-code`: `anthropic` only.
- `codex`: `openai-responses` only (codex-rs removed `wire_api = "chat"` —
  gateways must be Responses-compatible; W3 research §8.2).
- `deepseek`: `anthropic` + `openai-chat` (pi-ai `KnownApi` is exactly
  `anthropic-messages | openai-completions`; W3 research §8.1).

The existing `runtimeSpecUnsupportedReason` gate still applies after mapping —
a provider can never smuggle an unsupported flavor onto a target.

### 3.3 `RuntimeConfigSpec` additions (additive, optional)

- `providerId?: string` — provenance only. Validated at PUT time (provider
  exists + visible to the caller, else `404 PROVIDER_NOT_FOUND`), echoed by
  the GET view so the machine form can pre-select the provider row. The spec
  stays a **snapshot**: deleting the provider later does not invalidate the
  stored row (the form falls back to manual prefill).
- `models?: string[]` — extra switchable model ids beyond the default
  `model` (≤16, deduped server-side). See §6.

Stored specs are a JSON column — no migration for either field.

## 4. API surface (`modules/llm-providers.ts`)

Scope model identical to credentials: `global` readable by any authenticated
user, admin-only to mutate; `personal` owner-only; 404 (not 403) hides
foreign rows. Not-found and foreign rows are indistinguishable.

| Route                                  | Behavior                                                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/llm-providers`              | create; `scope:'global'` requires admin; referenced credential must be visible to the caller (`404 CREDENTIAL_NOT_FOUND`); name taken → `409 PROVIDER_NAME_TAKEN`                                                                                                  |
| `GET /api/llm-providers`               | caller's personal + all globals                                                                                                                                                                                                                                    |
| `PATCH /api/llm-providers/:id`         | name/api/baseUrl/credentialName mutable; **scope immutable** (409 `PROVIDER_SCOPE_IMMUTABLE`); re-validates credential + name                                                                                                                                      |
| `DELETE /api/llm-providers/:id`        | owner-or-admin; stored runtime configs keep applying (snapshot semantics)                                                                                                                                                                                          |
| `POST /api/llm-providers/query-models` | body `{providerId}` **or** `{api, baseUrl?, credentialName}` (works before the provider is saved — the create dialog and the machine page's manual arm both use it). Resolves + decrypts the credential, fetches the model list, returns `{models: {id, name?}[]}` |

### Model-list fetching (`infra/provider-models.ts`)

Deliberate **outbound HTTP surface #2** (the marketplace fetch was #1 — that
allowlist rule is scoped to marketplace browsing). Precedent: the MCP
registry already dials user-configured upstream URLs. Bounds: `http(s)` only,
GET only, `PROVIDER_MODELS_TIMEOUT_MS` (default 10 s) via `AbortSignal.timeout`,
2 MiB response cap, results reduced to ids + display names, ≤1000 entries.

- **openai kinds**: `GET {base}/models`, `Authorization: Bearer <key>`.
  Default base `https://api.openai.com/v1`. Candidate URLs: if the configured
  base already ends with `/v1` → `{base}/models`; otherwise try
  `{base}/v1/models` first, then `{base}/models` (gateways exist in both
  shapes; a 404 advances to the next candidate).
- **anthropic**: `GET {base}/v1/models?limit=1000`, `x-api-key` +
  `anthropic-version: 2023-06-01`. Default base `https://api.anthropic.com`.
- Response shape `{data: [{id, display_name? | name?}]}` (a bare array at the
  root is tolerated for gateway quirkiness); mapped to `LlmModelInfo`, sorted
  by id, deduped.
- Failures: upstream non-2xx (after candidates) → `502 PROVIDER_MODELS_FAILED`;
  timeout → `504 PROVIDER_MODELS_TIMEOUT`. The URL builder
  (`providerModelsUrls`) is pure and lives in shared (unit-tested, no I/O).

The fetch is injectable (`{fetch}` option) and the route reads the timeout
from a decoration — tests never touch the network (`vi.stubGlobal('fetch', …)`).

## 5. Web

- **New page `/llm-providers`** (nav: 供应商 / Providers, `PlugZapIcon`),
  mirroring Credentials: table (name, api badge, baseUrl, credential, scope),
  FormDialog create/edit (name, api select of the three kinds, baseUrl,
  credential picker filtered to **distributable** credentials — every real
  consumer of a provider is an apply-config), and a per-row **获取模型**
  dialog listing the discovered ids.
- **MachineDetail `ProviderConfigForm`** is now provider-first:
  - Loads providers + filters by `PROVIDER_API_SUPPORT[target]`. Selecting
    one auto-fills `providerLabel` (provider name), api (mapped), baseUrl,
    credentialName; those render as a read-only summary (the only editable
    baseUrl case: deepseek requires one and the provider has none — then an
    input appears).
  - **Model field + 获取模型 button** — fetches via the selected provider
    (or explicit fields in manual mode), then offers the list as a Select;
    the input stays hand-editable.
  - **附加模型** (multi-model): after a fetch, a collapsible checkbox list
    of the remaining ids; only the dsh writer consumes them (hint says so).
  - **Manual arm** (fallback + pre-existing rows whose provider is gone):
    the full W3 field set, also with a fetch button (spec flavor maps
    `openai` → `openai-chat` for the query; the models endpoint is the same
    for both openai kinds).
  - Prefill: a stored `providerId` that still resolves selects that provider;
    otherwise manual mode with the stored spec fields.

## 6. Multi-model ground truth (research summary)

What each harness can ACTUALLY do with multiple models (sources:
`docs/research/phase-9-harness-runtime.md` §2/§3/§8, verified against
codex-rs + dsh 0.1.2-rc.1; `docs/research/phase-9-w9-composer-controls.md`):

- **dsh — natively multi-model per provider.** A route's `models:
PiAiModelProfile[]` list (only `id` required; context defaults at route
  level) IS the switchable set; dsh groups session model options by provider
  and pushes `config_option_update` on topology changes. W3 wrote exactly
  one entry; W10's writer writes `unique([model, ...models])`. The default
  selection stays `agent-default-model` + the acp override (`model`).
- **codex — single root `model` string.** Multiple `model_providers.*`
  blocks are legal but one is active; the session model picker reads codex's
  built-in presets (`models_manager`), not config.toml. `models` is ignored.
- **claude-code — one default via top-level `model`.** The documented
  multi-slot vocabulary (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,
HAIKU}_MODEL`) exists, but the wrapper's session picker reads SDK model
  infos, not settings.json. `models` is ignored.

So: machine-level default (W3, unchanged) + pre-seeded switchable set (dsh
only, W10) + in-session switching (W9 `configOptions`, orthogonal) is the
complete multi-model story this platform can express today.

## 7. Out of scope

- Per-provider convenience presets (logos, "official" catalogs) — cc-switch
  ships a static provider catalog; providers here are user data, not bundled
  content.
- Writing `ANTHROPIC_DEFAULT_*` alias slots for claude-code (the session
  picker wouldn't read them anyway).
- The claude wrapper's `providers/list|set|disable` routing surface
  (research W9 §"deferred").
- Provider health checks / latency probes; pricing data; per-profile model
  routing.
- `zcode`/`hermes` targets (not runtime-managed).

## 8. Verification

- `packages/shared/test/llm-provider.test.ts` — schemas, support matrix,
  kind→flavor mapping, URL candidates.
- `packages/server/test/llm-providers.test.ts` — CRUD scope rules, name
  clash, credential visibility, query-models (stubbed fetch) incl. timeout +
  upstream-error mapping; PUT runtime-config `providerId`/`models` validation.
- `packages/cli/test/runtime-config.test.ts` — dsh writer emits the deduped
  multi-model `models:` list.
- `scripts/smoke.mjs` — `[9 W10]` provider CRUD + provider-mode PUT.

## 9. Post-ship rig notes (2026-09-14)

- **codex-acp needs system `libssl.so.3`** — it is a native Rust binary; a
  `node:20-bookworm-slim` machine container has only Node's bundled OpenSSL,
  so every spawn died at the dynamic loader until `apt-get install libssl3`.
  The claude wrapper (pure Node) is unaffected. Ops fix + recurrence note in
  `docs/dev/test-rig.md` (machine-specific, git-ignored).
- **apply-config does not reach ALREADY-OPEN channels** (rig-found): a codex
  session opened under the OLD spec keeps its startup model — codex-acp
  reads `config.toml` once at spawn. Symptom: user fixes the provider, sends
  a message in the OLD session, the turn still fires the stale model id at
  the new gateway → 404 → the turn dies ("发了个消息就崩了"). Correct flow:
  apply the config, then open a NEW session. Related W9 boundary: codex's
  in-session model selector lists its built-in presets (not the gateway's
  catalog), so on a third-party gateway only the machine default is valid —
  switching in-session to a preset reproduces the same 404. A future
  improvement could mark/restart affected channels on apply-config, or pin
  the applied model as the selector's current value.
- **Volcengine Ark note**: the coding endpoint
  (`…/api/coding/v3`) DOES speak the OpenAI Responses protocol (codex works
  against it), while the general `/api/v3` surface 404s the coding-plan
  models — provider baseUrl should point at the CODING endpoint for
  coding-plan keys, and non-coding-plan models are rejected there with
  `UnsupportedModel`.

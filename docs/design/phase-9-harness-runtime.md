# Design: Phase 9 — Harness runtime lifecycle (install / upgrade / provider config)

> Status: **W1 + W2 shipped (2026-09), W3–W4 designed**. Ground truth:
> `docs/research/phase-9-harness-runtime.md`. Rides Phase 8's machines /
> daemon / jobs infrastructure (C1–C4); touches `shared` → `cli` → `server` →
> `sdk-ts` → `web` in that order.

## 1. Problem

The platform manages **profile artifacts** on machines but is blind to the
harness software itself. Users cannot see whether `claude` / `codex` / `dsh` is
installed (which binary, which version, installed how), cannot install or
upgrade it remotely, cannot push the LLM provider/model configuration it should
run with, and cannot view the harness's effective config from the UI.

## 2. Goals

1. **Agent-first inventory** — the _Agent_ (installed harness runtime) is the
   primary object: cards group by Agent, items nest under it, a target without
   a runtime says "not installed" instead of showing empty lists; an Agent in
   default state (no platform items) can be **captured as a profile**.
2. **Runtime inventory** — per machine × target: installed?, bin path, version,
   install method; refreshed by the same scan cycle as C3 inventory.
3. **One-click install / upgrade / pin** of claude-code, codex, deepseek on a
   machine, as C4-style jobs with progress and failure reporting.
4. **Provider config push** — set the LLM route (provider label, base URL, API
   flavor, model, API key) a harness uses, from a server-side entity that
   references a _distributable_ credential.
5. **Redacted config viewing** in the web UI — click a runtime, see the
   harness's effective config with secrets masked.
6. **Chat keys off the Agent, not the deploy record** — any detected runtime
   (including emitter-installed claude-code) is a chat target.

## 3. Non-goals (v1)

- Session-level model overrides, per-profile model routing.
- Uninstalling harness software (reversal = pin an older version; full removal
  stays manual — destructive and cheap to add later if asked).
- `zcode` / `hermes` runtime management (unlisted targets; the job table is
  extensible when they matter).
- Enterprise managed-settings hierarchies (Claude Code managed settings,
- OS packaging beyond npm + claude native + brew detection).
- ECC / Superpower import (still Phase 3) and orchestration (C6).

## 4. Data model

### 4.1 Runtime snapshot — an arm on the inventory payload (not a new table)

`packages/shared/src/schemas/inventory.ts` gains:

```ts
export const runtimeInfoSchema = z.object({
  target: scannableTargetSchema, // claude-code | codex | deepseek
  installed: z.boolean(),
  binPath: z.string().max(512).optional(),
  version: z.string().max(64).optional(), // raw `--version` output, trimmed
  installMethod: z.enum(['npm', 'native', 'brew', 'unknown']).optional(),
});
// InventoryReport payload += runtimes: z.array(runtimeInfoSchema).max(8)
```

- Produced by a `probeRuntimes()` helper in `packages/cli/src/inventory/` —
  PATH walk + known-location sniff + `<bin> --version` with a short timeout;
  method classification by path prefix (research §5.1). No config file
  contents in the snapshot.
- Stored inside the existing `machine_inventory` latest-row JSON (no
  migration); `GET /api/machines/:id/inventory` returns it alongside items.
- **Primacy:** `runtimes` becomes the grouping key of the MachineDetail
  inventory view — items render _under_ their Agent card; a target with
  `installed: false` renders a single "Agent not installed" state (plus the
  W2 install button) instead of an empty item list.

### 4.2 Runtime jobs — a new `Job.type` on the C4 pipeline

```ts
type: 'harness'
payload: {
  action: 'install' | 'upgrade' | 'pin' | 'apply-config'   // see 4.3
  target: 'claude-code' | 'codex' | 'deepseek'
  version?: string          // pin/upgrade target; omit = latest
  channel?: 'stable' | 'latest'   // claude-code only, optional
  config?: RuntimeConfigSpec      // apply-config only
}
```

Same lifecycle, requeue rules, `AgentInstance`-free (harness jobs do NOT create
agent instances), same `/app` `job:update` push. The daemon executor
(`packages/cli/src/daemon/runtime.ts`) maps action × target to commands:

| target      | install / pin                                                                                                            | upgrade                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| claude-code | npm: `npm i -g @anthropic-ai/claude-code@<v>`; native fallback: `curl -fsSL https://claude.ai/install.sh \| bash -s <v>` | npm `@latest` / `claude update` (native); writes `DISABLE_AUTOUPDATER` into settings `env` on first manage |
| codex       | `npm i -g @openai/codex@<v>`                                                                                             | `npm i -g @openai/codex@latest`                                                                            |
| deepseek    | `npm i -g @deepseek-ai/dsh@<v>`                                                                                          | `npm i -g @deepseek-ai/dsh@latest`                                                                         |

Installers spawn with the daemon's proxy/registry env forwarded, a generous
per-command timeout, and stream stdout tail into `job:progress` (last ~4 KB).

### 4.3 RuntimeConfig — server-side provider spec (new table, migration `0011`)

One row per (machine, target), owner-scoped, upserted via REST:

```ts
{
  id, machineId, ownerId, target,
  providerLabel: string,            // display only
  baseUrl?: string,                 // omit = provider default
  api: 'anthropic-messages' | 'openai',
  model: string,
  credentialName: string,           // Credential handle — MUST be distributable
  extra?: Record<string, unknown>,  // target-specific (e.g. codex wire_api)
  updatedAt
}
```

`apply-config` resolves the credential server-side (C4 deploy-bundle precedent)
and ships `{ spec, secret }` inside the job payload — same blast-radius rules as
the deploy bundle: machine-PAT-only REST surface, never logged, never returned.

Per-target native placement (daemon-side writer, all files 0600):

| target      | config write                                                                                                                                                                | key write                                                                                                      |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| claude-code | `~/.claude/settings.json`: `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, `model` (merge, preserve user keys)                                                        | same `env` block                                                                                               |
| codex       | `~/.codex/config.toml`: `model`, `model_providers.harness_nexus` block (`base_url`, `wire_api`, `env_key`)                                                                  | `~/.codex/auth.json` `{"auth_mode":"apikey","OPENAI_API_KEY":…}`                                               |
| dsh         | managed MARKED region in home `cordis.patch.yml` (extends the T1 region): `@deepseek-ai/dsh-llm-pi-ai` row with `providers.harness-nexus {api, baseURL, apiKeyEnv, models}` | `~/.dsh/env` (KEY=VALUE, 0600) — sourced by daemon-spawned dsh processes; user shells get a documented snippet |

Writers are **merge-preserving**: unknown/user keys survive; every write is
idempotent and re-runnable (upgrade = re-apply).

### 4.4 AgentInstance auto-registration (`source`)

`AgentInstance` gains an additive `source: 'deploy' | 'detected'` (migration
`0011`, same one as `RuntimeConfig`):

- **deploy** — today's rows (C4 upsert, `profileId` set).
- **detected** — upserted by the server whenever an inventory report shows an
  installed runtime for (machine, target) and no deploy row exists:
  `profileId: null`, `name: <target>` — the Agent in its current (possibly
  default) state. Two consecutive scans without the runtime remove the
  detected row (hysteresis against a flaky probe). A later deploy upgrades the
  row to `source: 'deploy'` in place.

**Chat re-gating** (C5 change): the gating chain drops its implicit
deploy-only assumption — `instance exists (any source) → remoteChatEnabled →
online → capability → cap` — and the session-open failure path (adapter
missing / no auth) stays the honest signal for an Agent that is installed but
not chat-ready. No wire-protocol change.

### 4.5 Capture-as-profile (default state → save as profile)

An Agent card action: **"Capture current state as profile"** — the C3
collect+import pipeline (reuse-or-create; MCP items become `McpServer` rows,
env/header values already redacted daemon-side) invoked **without** a diff
baseline. The Agent's default state becomes a named, deployable profile. The
existing diff view stays as the comparison tool; nothing about import
semantics changes.

## 5. Daemon protocol

- New capability string **`runtime`** advertised in `machine:hello`; routes gate
  on it exactly like `inventory` / `deploy`.
- `/ctl` events (shaped like the inventory pair):
  - `runtime:scan` → returns `RuntimeInfo[]` (also folded into every inventory
    report by the daemon, so one scan feeds both cards);
  - `runtime:config.get` → **redacted** effective config per target
    (`files: [{path, content}]` with secret-ish values masked by the daemon-side
    redactor extended from env/header masking to key-name-aware TOML/JSON/YAML
    value masking; plus a `redacted: string[]` list of what was hidden).
- Job dispatch (`job:dispatch` with `type: 'harness'`) handled by the runtime
  executor; progress/result via the existing `job:progress` / `job:result`.

## 6. REST surface (all owner-or-admin, 404-not-403 on foreign ids)

- `GET  /api/machines/:id/inventory` — now also carries `runtimes` (W1).
- `POST /api/machines/:id/jobs` — accepts `type: 'harness'` payloads
  (`deployJobPayloadSchema` widens to a discriminated union on `type`).
- `GET/PUT /api/machines/:id/runtime-config/:target` — read (never returns the
  secret — echoes `credentialName`) / upsert-apply (queues `apply-config`).
- `GET  /api/machines/:id/runtimes/:target/config` — proxied redacted view
  (asks the daemon, requires online + `runtime` capability).

## 7. Web UI (MachineDetail — no new nav entry)

The inventory view regroups per **Agent card** (claude-code / codex /
deepseek) — items nest under their Agent; a not-installed Agent shows a muted
"not installed" line with the install button. Each card:

- status line: installed version in `IBM Plex Mono` (`2.1.211`) + method badge
  (`npm`/`native`/`brew`), or a muted "not installed";
- **Install / Upgrade** button (confirm-first; optional version-pin input;
  Upgrade disabled when not installed) → creates the job, shows live status in
  the existing Deployments/jobs list;
- **Provider config** sub-form: base URL, api flavor, model, credential picker
  (distributable credentials only) → PUT queues apply-config;
- **View config** → drawer with the redacted files (mono, wrap), source
  `text-muted-foreground` note when values were masked.
- **Capture as profile** (confirm-first) → C3 import without a baseline;
  links to the created profile.

Signal discipline: no new colors; version/mono as data; the accent stays on
live links/focus only. All strings via `strings/machineDetail.ts` (en/zh,
full-width punctuation rules for zh).

## 8. Security rules

- `apply-config` requires the referenced credential to be `distributable`
  (global non-distributable → 409, mirroring dial-site rules).
- Secrets: resolved once server-side inside the job payload, written by the
  daemon only into the native slots above (0600), never into profile artifacts,
  never echoed by `config.get` (masked daemon-side before upload), never in
  job progress/result/logs.
- Harness jobs and runtime-config are owner-only (admins may view, not mutate —
  matches chat's owner-only stance for machine-touching actions).

## 9. Waves

- **W1 Agent-first inventory — SHIPPED (2026-09).** Implementation notes
  (deviations settled during the build):
  - The runtime arm rides the EXISTING `inventory:report` event as an optional
    `runtimes: RuntimeInfo[]` array (one probe pass per scan cycle, folded
    into every report — absent on daemons without the `runtime` capability);
    the server picks the snapshot target's entry and stores it as a per-row
    `runtime` column (migration `0011` alongside the agent_instances rework).
    The standalone `runtime:scan` event stays unimplemented — no W1 consumer;
    it lands with the wave that needs it.
  - `RUNTIME_TARGETS = [claude-code, codex, deepseek]` in shared (hermes
    unlisted — no runtime management); `probeRuntimes()` lives in
    `packages/cli/src/inventory/runtime.ts` (PATH walk + known-location
    fallback for the claude native launcher, `<bin> --version` with a 5 s
    per-probe timeout, parallel probes, realpath-based method classification
    with npm checked BEFORE the `~/.local` native guess so an npm prefix of
    `~/.local` can't masquerade as native).
  - Detected-instance sync (`server/src/realtime/runtime-instances.ts`) runs
    fire-and-forget after each report is persisted (never blocks the report
    path): `installed` + no deploy row for the target ⇒ upsert the
    `source: 'detected'` row (`directory` = the snapshot's agent home — the
    chat cwd); a null arm is NO signal (old daemons neither register nor
    remove); two consecutive not-installed reports remove the row (in-memory
    hysteresis counter). `JobService.registerInstance` upgrades a detected row
    to `source: 'deploy'` in place when a deploy lands for that target.
  - Chat re-gating needed NO code change — C5's chain already keys off any
    `AgentInstance`; detected instances simply exist now (covered by
    `server/test/runtime-instances.test.ts` opening a channel against a
    detected claude-code instance).
  - Capture-as-profile is `POST /api/machines/:id/inventory/capture`
    (`{target, profileName}`) — the C3 collect+import core
    (`collectAndBundle`, now shared by both routes) with the item list derived
    server-side from the latest snapshot's importables; zero importables
    bundle a zero-entry profile ("default state" capture). MachineDetail
    regroups per Agent card (runtime status line: version + method badge or
    muted "not installed"; not-installed Agents stop rendering empty item
    tables) with the capture form on every card.
  - Verified by: unit/integration tests (probe fixtures incl. a hanging bin,
    sync hysteresis/deploy-precedence, capture idempotence, detected-instance
    chat), smoke `[9 W1]` (fake bins on a fixture PATH), and the docker rig.
- **W2 Install/upgrade/pin jobs — SHIPPED (2026-09).** Implementation notes
  (deviations settled during the build):
  - npm is the ONLY install channel (`npm i -g <pkg>@<version|latest>` — the
    daemon host always runs Node ≥20); the design's claude-native-installer
    fallback is unnecessary there. The one native path kept: `claude update`
    for an UPGRADE of an already-native claude-code install (npm over it
    would shadow, not upgrade); PINNING a native install refuses with a clear
    error. Managed claude-code machines get `env.DISABLE_AUTOUPDATER='1'`
    merged into `~/.claude/settings.json` (merge-preserving, 0600; an
    unreadable settings file is a non-fatal `warning` on the job result).
  - `channel` is NOT in the W2 payload (CC stable/latest stays a W3 open
    question, §11). `apply-config` joins the payload union in W3.
  - The REST body is a `type`-discriminated union (`createMachineJobSchema`);
    a body WITHOUT `type` defaults to deploy (every pre-W2 SDK caller).
    Harness create is OWNER-ONLY (admin on a foreign machine → 403
    `MACHINE_OWNER_ONLY`) and soft-gated on the daemon's **`harness`**
    capability when online — NOT `runtime`: W1 daemons already advertise
    `runtime` without the executor (they settle harness jobs as unsupported),
    so the executor gets its own tag (`0.6.0-p9w2` advertises both). Harness
    jobs never create AgentInstances.
  - The daemon executor (`cli/src/daemon/runtime.ts`) inherits the daemon's
    env (proxy/registry pass-through), a 10-min per-command timeout with
    SIGTERM→SIGKILL, streams a throttled stdout/stderr tail (last ~4 KB, last
    line per progress event) into `job:progress`, re-probes the target on
    success, reports the landing version in `job:result.data`
    (`harnessResultDataSchema`), and AUTO-REPORTS the target's inventory
    (one report feeds the Agent card + the detected-instance sync).
  - Known race (accepted): a harness job's auto-report can be overwritten by
    the daemon's still-in-flight connect-time full report (probe latency);
    the next scan self-heals. Real flows (scan → see not-installed →
    install) don't hit it.
  - Verified by: unit/integration (fake-`npm` shim on PATH — argv, tail on
    failure, native-upgrade path, settings merge; route gates incl.
    owner-only + capability + payload union; harness round-trip with no
    AgentInstance side effects), smoke `[9 W2]`, and the docker rig.
- **W3 Provider config — SHIPPED (2026-09).** Implementation notes
  (deviations and §11 resolutions settled during the build):
  - `RuntimeConfig` rides migration `0012` exactly as modeled (one row per
    machine × target, `spec` JSON, `UNIQUE (machine_id, target)`), with a
    `RuntimeConfigRepository` port + sqlite/memory drivers and a machine-delete
    cascade. REST: `GET/PUT /api/machines/:id/runtime-config/:target` (GET
    owner-or-admin 404-hiding; PUT owner-only 403 `MACHINE_OWNER_ONLY`,
    queues `{type:'harness',action:'apply-config',target}` — a bare
    apply-config body at `POST …/jobs` is refused 409
    `USE_RUNTIME_CONFIG_ENDPOINT`). Route policy from `shared`
    (`runtimeSpecUnsupportedReason`): api flavor per target
    (`RUNTIME_API_SUPPORT`: claude-code=anthropic-messages, codex=openai,
    deepseek=both) and deepseek REQUIRES a baseUrl. Credential gates mirror
    dial-site rules: unknown/foreign-personal → 404, non-distributable → 409.
  - **The secret never rides the job.** The persisted payload names only the
    target; the daemon fetches the resolved `{spec, secret}` bundle at
    EXECUTION time from `GET /api/client/runtime-config?target=` (machine-PAT
    REST exception #3, the TIGHTEST one — non-machine callers get a flat 404).
    Execution-time resolution means a requeued job after a credential rotation
    picks up the new value (deploy-bundle semantics, not a frozen snapshot).
  - Soft capability gate on the new **`runtime-config`** tag (W2 daemons
    advertise `harness` without the writer; they would settle the job as
    `harness payload invalid`). Daemon `0.7.0-p9w3` advertises both.
  - Per-target writers (`packages/cli/src/daemon/runtime-config.ts`, all
    files 0600, merge-preserving, idempotent): **claude-code** merges
    `env.ANTHROPIC_AUTH_TOKEN` + `env.ANTHROPIC_BASE_URL` (a baseUrl-less
    re-apply REMOVES ours — the platform owns the route) + top-level `model`
    into `~/.claude/settings.json`. **codex** sets root keys `model` +
    `model_provider` via `mergeTomlRootKeys` (top-level region only),
    replaces `[model_providers.harness_nexus]` (name/base_url/
    `requires_openai_auth = true`, NO `wire_api` — see below), and merges
    `~/.codex/auth.json` to apikey mode with `OPENAI_API_KEY`. **dsh** writes
    a `harness-nexus:provider` marked region in the home patch with TWO
    insert rows — `@deepseek-ai/dsh-llm-pi-ai` (providers.harness-nexus:
    displayName/api/baseURL/apiKeyEnv/models[{id}]) AND
    `@deepseek-ai/dsh-agent-default-model` (provider/model — mounting a route
    alone doesn't select it) — plus the key into `~/.dsh/.env` (see §11).
  - §11 resolutions (all verified against sources): **dsh key channel is
    `~/.dsh/.env`** (NOT `~/.dsh/env` as drafted) — dsh's native user-env
    credential layer (`dsh-credentials-local`: process env >
    `~/.dsh/.credentials.yaml` > `./.env` > `~/.dsh/.env`), read on EVERY
    launch including user shells — no wrapper, no shell snippet, no daemon
    ACP env injection needed; the env name `HARNESS_NEXUS_API_KEY` avoids the
    bootstrap-only blocklist (`DSH_*`, proxy vars). **claude-code
    version-less installs/upgrades track the `stable` npm dist-tag**
    (`CHANNEL_TAG` in the executor; `latest`/`next` exist but move a managed
    fleet too fast) — no payload `channel` field. **Multiple claude
    binaries**: first-found stands (W1 behavior), and the card already
    surfaces `binPath`. **codex keys: auth.json wins** —
    `requires_openai_auth = true` + apikey-mode auth.json is the built-in
    provider's own pairing (bearer to the custom base_url; no env_key, no env
    persistence mechanism to invent). And a discovery beyond the question:
    **current codex REMOVED `wire_api = "chat"`** (source: codex-rs
    `model-provider-info/src/lib.rs`, discussion #7782) — every route speaks
    Responses, so the emitter writes no `wire_api` and gateways must be
    Responses-compatible; `extra.wireApi` was dropped from the spec.
  - W2 fix riding along: the executor was called without `opts`, so
    production daemons never wrote `DISABLE_AUTOUPDATER`
    (`homeDir !== undefined` guard skipped it — tests/smoke always passed a
    fixture HOME and masked it); `runHarnessJob` now defaults `homeDir` to
    `os.homedir()`.
  - Verified by: unit/integration (writer fixtures with planted user content
    — merge preservation, idempotence, 0600, unset-removes-ours; route gates
    incl. owner-only/distributable/flavor/baseUrl/machine-PAT-only bundle +
    credential rotation; payload union), smoke `[9 W3]` (a REAL daemon dist
    fetches the bundle over REST and writes a fixture HOME), and the docker
    rig (codex + deepseek apply jobs succeeded; files verified in the
    container; `dsh --version` still boots with the patch rows; UI form
    prefilled per Agent card).
- **W4 Config viewer + drift** — `runtime:config.get` redaction, drawer,
  re-scan after apply. Fold anything learned about dsh env ergonomics.

Each wave lands independently (branch → tests → smoke section `[9]` → docs).

## 10. Testing

- Unit: version-string parsers, path→method classification, TOML/JSON/YAML
  merge writers + redactor (fixture configs with planted secrets), job payload
  schema union.
- Integration: runtime executor against a fake `npm` shim on PATH (records
  argv, prints canned version) — no network in tests.
- Smoke (`scripts/smoke.mjs [9]`): enroll → scan (runtimes present) →
  harness-install dsh@`<pin>` → poll job → runtime row shows version →
  apply-config (fixture credential) → redacted config view masks the key.

## 11. Open questions (resolved at W3 — decisions recorded in §9's W3 notes)

- ~~dsh `apiKeyEnv` for user-typed shells~~ → `~/.dsh/.env`, dsh's own
  user-env credential layer (no wrapper/snippet).
- ~~Claude Code `stable` vs `latest` default~~ → `stable` dist-tag.
- ~~Detected-instance lifecycle edge cases (multiple claude binaries)~~ →
  keep first-found; the card surfaces `binPath`.
- ~~codex custom-provider keys without `env_key`~~ → auth.json via
  `requires_openai_auth = true`; `wire_api = "chat"` was REMOVED upstream
  (Responses-only).

# Design: Phase 9 — Harness runtime lifecycle (install / upgrade / provider config)

> Status: **designed** (2026-09), not yet implemented. Ground truth:
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

1. **Runtime inventory** — per machine × target: installed?, bin path, version,
   install method; refreshed by the same scan cycle as C3 inventory.
2. **One-click install / upgrade / pin** of claude-code, codex, deepseek on a
   machine, as C4-style jobs with progress and failure reporting.
3. **Provider config push** — set the LLM route (provider label, base URL, API
   flavor, model, API key) a harness uses, from a server-side entity that
   references a *distributable* credential.
4. **Redacted config viewing** in the web UI — click a runtime, see the
   harness's effective config with secrets masked.

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
  target: scannableTargetSchema,          // claude-code | codex | deepseek
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

| target | install / pin | upgrade |
| --- | --- | --- |
| claude-code | npm: `npm i -g @anthropic-ai/claude-code@<v>`; native fallback: `curl -fsSL https://claude.ai/install.sh \| bash -s <v>` | npm `@latest` / `claude update` (native); writes `DISABLE_AUTOUPDATER` into settings `env` on first manage |
| codex | `npm i -g @openai/codex@<v>` | `npm i -g @openai/codex@latest` |
| deepseek | `npm i -g @deepseek-ai/dsh@<v>` | `npm i -g @deepseek-ai/dsh@latest` |

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

| target | config write | key write |
| --- | --- | --- |
| claude-code | `~/.claude/settings.json`: `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_AUTH_TOKEN`, `model` (merge, preserve user keys) | same `env` block |
| codex | `~/.codex/config.toml`: `model`, `model_providers.harness_nexus` block (`base_url`, `wire_api`, `env_key`) | `~/.codex/auth.json` `{"auth_mode":"apikey","OPENAI_API_KEY":…}` |
| dsh | managed MARKED region in home `cordis.patch.yml` (extends the T1 region): `@deepseek-ai/dsh-llm-pi-ai` row with `providers.harness-nexus {api, baseURL, apiKeyEnv, models}` | `~/.dsh/env` (KEY=VALUE, 0600) — sourced by daemon-spawned dsh processes; user shells get a documented snippet |

Writers are **merge-preserving**: unknown/user keys survive; every write is
idempotent and re-runnable (upgrade = re-apply).

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

A **Runtimes card** per target (claude-code / codex / deepseek):

- status line: installed version in `IBM Plex Mono` (`2.1.211`) + method badge
  (`npm`/`native`/`brew`), or a muted "not installed";
- **Install / Upgrade** button (confirm-first; optional version-pin input;
  Upgrade disabled when not installed) → creates the job, shows live status in
  the existing Deployments/jobs list;
- **Provider config** sub-form: base URL, api flavor, model, credential picker
  (distributable credentials only) → PUT queues apply-config;
- **View config** → drawer with the redacted files (mono, wrap), source
  `text-muted-foreground` note when values were masked.

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

- **W1 Runtime inventory** — shared schema + daemon probe + inventory arm +
  Runtimes card (version/method display only). Verify with the docker machine.
- **W2 Install/upgrade/pin jobs** — job type, daemon executor, REST widening,
  job UI affordance. Verify: install dsh@pin into the docker machine, upgrade.
- **W3 Provider config** — RuntimeConfig table + apply-config writers + form.
  Verify: point codex at a gateway, redacted view shows the block.
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

## 11. Open questions (resolve at W3)

- dsh `apiKeyEnv` for user-typed shells: `~/.dsh/env` + documented shell snippet
  vs a `dsh` wrapper script on PATH — decide after watching the acp-ref pattern.
- Claude Code `stable` vs `latest` default channel for managed installs
  (proposal: `stable`).
- Whether codex custom-provider keys can consistently avoid `env_key` (auth.json
  per provider) — verify against current codex behavior in W3 spike.

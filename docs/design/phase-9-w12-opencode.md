# Design: Phase 9 W12 — OpenCode runtime onboarding

> Status: **SHIPPED 2026-09-16** (daemon `0.17.0-p9w12`). External ground
> truth in [`docs/research/phase-9-w12-opencode.md`](../research/phase-9-w12-opencode.md).
> Scope decided with the user: **opencode only** (hermes runtime support
> later CANCELLED with the user, 2026-09-17 — dropped, not deferred),
> **full surface** (probe + install/upgrade/pin jobs + W3
> provider push + W4 redacted viewer + ACP chat + C3 scan).

## Problem

`RUNTIME_TARGETS` covered claude-code/codex/deepseek only. OpenCode (SST's
terminal agent) is a first-class citizen of the same class — npm-installable,
native ACP, JSON config — but the platform could not add it to a machine,
push a provider route to it, or chat with it. W12 gives it the standard
runtime surface with ZERO new platform concepts: every gate is
schema-driven and every UI surface lights up from the runtime arm alone.

## Non-goals (v1)

- opencode **profile install adapter** (deploy axis) — not a `DEPLOYABLE_TARGET`;
  plugins are TS code, there is no declarative hooks surface to install into.
- **Native sessions rail** — no `session/list` over ACP; the rail answers
  `supported:false` (the sessions handler's generic fall-through — no code).
- **hooks** — `HOOK_SUPPORT['opencode'] = null` (route rejects with
  `TARGET_NO_DECLARATIVE_HOOKS`, same class as hermes/codex/deepseek).
- `~/.local/share/opencode/auth.json` — the user's own `/connect` store;
  never read or written.
- **JSONC tolerance** — an unparseable (commented) global `opencode.json`
  fails the apply-config job with an explicit error; we never guess.

## 1. Axes and registries touched

| Axis / registry        | File                                                    | Change                                                                                                                                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AgentTarget`          | `shared/schemas/profile.ts` + `core/domain/resource.ts` | `+= 'opencode'` (chat + inventory need the target id)                                                                                                                                                                                                                                           |
| `RuntimeTarget`        | `shared/schemas/inventory.ts`                           | `RUNTIME_TARGETS += 'opencode'`                                                                                                                                                                                                                                                                 |
| `RUNTIME_API_SUPPORT`  | `shared/schemas/runtime-config.ts`                      | `opencode: ['anthropic-messages', 'openai']`                                                                                                                                                                                                                                                    |
| `PROVIDER_API_SUPPORT` | `shared/schemas/llm-provider.ts`                        | `opencode: ['anthropic', 'openai-chat']` — `openai-responses` is deliberately excluded: the spec snapshot carries only the coarse flavor, so the writer could not pick `@ai-sdk/openai` vs `@ai-sdk/openai-compatible` deterministically (the models.dev built-in already covers OpenAI proper) |
| `HOOK_SUPPORT`         | `shared/schemas/hooks.ts`                               | `opencode: null`                                                                                                                                                                                                                                                                                |
| `SCANNABLE_TARGETS`    | `shared/schemas/inventory.ts`                           | `+= 'opencode'`                                                                                                                                                                                                                                                                                 |
| Probe                  | `cli/inventory/runtime.ts`                              | `RUNTIME_PROBES += { target: 'opencode', bin: 'opencode' }`                                                                                                                                                                                                                                     |
| Harness packages       | `cli/daemon/runtime.ts`                                 | `HARNESS_PACKAGES['opencode'] = 'opencode-ai'` (npm channel, `latest` tag; no native self-update exception)                                                                                                                                                                                     |
| ACP row                | `cli/daemon/acp/adapters.ts`                            | `opencode: ['opencode', 'acp']` (native ACP; `HN_ACP_COMMAND_OPENCODE` override)                                                                                                                                                                                                                |
| W3 writer              | `cli/daemon/runtime-config.ts`                          | `applyOpencodeConfig` + dispatch case                                                                                                                                                                                                                                                           |
| W4 viewer              | `cli/daemon/config-view.ts`                             | `TARGET_CONFIG_FILES['opencode']`                                                                                                                                                                                                                                                               |
| C3 scanner             | `cli/inventory/scanners/opencode.ts` (new)              | registered in `scan.ts`                                                                                                                                                                                                                                                                         |

Server: **zero code** (jobs/routes are schema-driven). Storage: no
migrations (`machine_inventory.runtime` is a JSON column; job payloads are
JSON). Web: `targetBadge` gains `OC`; everything else (Agent card,
install/upgrade/pin, provider form, view-config) renders from the runtime
arm automatically. Profile/resource target pick lists deliberately
UNCHANGED (no install adapter).

## 2. W2 — install/upgrade/pin

Rides the unchanged harness job pipeline. `opencode` uses the default npm
arm (`npm install -g opencode-ai@<latest-or-version>`) — no native path,
no `CHANNEL_TAG` row, no post-install warning hooks. Detection: the probe
row (`bin: 'opencode'`) flows through every `inventory:report`, so a
post-install re-probe auto-registers the detected AgentInstance (W1 sync)
and the Agent card appears without a rescan.

## 3. W3 — provider config push (`applyOpencodeConfig`)

Two slots, both merge-preserving and idempotent:

1. **`~/.config/opencode/opencode.json`** — read (if present, `JSON.parse`;
   failure → job error, file untouched), then write:
   - top-level `model` = `"harness-nexus/<model>"` (the active route; W10
     `models` extras become sibling keys in the provider's `models` map so
     the in-session model picker can switch them — same multi-model story
     as dsh's switchable set),
   - `provider['harness-nexus']` = `{ npm, name: 'Harness Nexus',
options: { baseURL?, apiKey: '{file:~/.config/opencode/harness-nexus.key}' },
models: { <default>: {}, …extras } }`.
   - `npm` maps from the provider kind: `anthropic` → `@ai-sdk/anthropic`,
     `openai-chat` → `@ai-sdk/openai-compatible` (see PROVIDER_API_SUPPORT
     for the responses exclusion). `baseURL` is **`/v1`-normalized**
     (`opencodeSdkBaseURL`, rig-found: the AI SDK appends only the method
     path, and a `/v1`-less gateway base fails the gateway's pre-routing
     auth check as "Unauthorized" — NOT a 404). A **baseUrl-less re-apply
     REMOVES our `baseURL`** (the claude-code `ANTHROPIC_BASE_URL`
     semantic — stale endpoints must not linger). Only OUR provider block
     + `model` key are touched.
2. **`~/.config/opencode/harness-nexus.key`** — the secret, 0600, RAW
   (no trailing newline — opencode reads the `{file:…}` target verbatim, a
   `\n` rides the key and the gateway rejects it). The config references
   it via `{file:…}` substitution, which EVERY opencode invocation
   resolves (TUI, ACP, headless) — unlike `{env:…}`, which only sees
   opencode's own process env. The secret therefore never rides in the
   JSON (the W4 viewer still masks any that do) and never depends on our
   spawn environment.

## 4. W4 — redacted viewer

`TARGET_CONFIG_FILES['opencode'] = ['.config/opencode/opencode.json',
'.config/opencode/harness-nexus.key']`. The JSON file walks the standard
key-name-aware masking (`apiKey`-shaped keys). The key file is a BARE
secret — no key names for the line-level rules — so the viewer
**wholesale-redacts it** (same treatment as `.env`): an explicit path
check, not an extension heuristic.

## 5. C3 — scanner (`~/.config/opencode`)

- `mcp` block of `opencode.json` → `mcp` items (local stdio
  `command`/`args`/`env` — env values redacted daemon-side to
  `${cred:<KEY>}`; remote `url` → http transport).
- `command/*.md` → `command` items (frontmatter `description`).
- `agent/*.md` → `sub_agent` items.
- `skill/<name>/SKILL.md` → `skill` items when the dir exists (older
  installs: absent, skipped cleanly).
- `platformMarkers`: `mcp` keys matching platform MCP names — unchanged
  pattern.

## 6. Chat

`resolveAcpCommand('opencode')` = `['opencode', 'acp']` (native ACP —
officially documented, Zed-registry listed). Standard dialect flows
through the UNMODIFIED `mapAcpUpdate` (rig-verified: message chunks,
thought chunks, usage with context occupancy). Gate order, channel
budget, W11 lifecycle all apply unchanged — chat needs no opencode code
beyond the command row. If a future dialect drift appears, EXTEND
`mapAcpUpdate` per the dsh precedent, never replace the standard arm.

## 7. Tests

- cli: writer goldens (fresh home / merge-preserving user keys / JSONC
  refusal / baseUrl removal / extras list), viewer key-file
  wholesale-redact, scanner fixture home, harness command mapping
  (`opencode-ai@latest` / `@<version>`), ACP default row.
- shared: `runtimeTargetSchema`/`agentTargetSchema` accept `'opencode'`;
  matrix rows present (`RUNTIME_API_SUPPORT`, `PROVIDER_API_SUPPORT`,
  `HOOK_SUPPORT` null).
- server: harness job schema accepts target `opencode` (generic
  schema-driven path gets one regression test).

## 8. Rig E2E (acceptance)

1. Daemon overlay `0.17.0-p9w12` → machine reports the runtime arm
   (not-installed card visible).
2. Install via the UI harness job → card flips to installed with version;
   detected AgentInstance appears; `/chat` lists the opencode agent.
3. Provider config push (credential + model) → `opencode.json` +
   key file land; 查看配置 shows masked JSON + wholesale-redacted key.
4. `opencode acp` chat turn on the pushed route — stream + usage OK.
5. Rail: "不支持原生会话" (honest `supported:false`).

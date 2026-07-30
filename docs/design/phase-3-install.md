# Install pipeline & target-tool profiles (Phase 3)

> Status: **3.1 ✅ shipped** (McpServer.mode + stdio-in-direct + rename),
> **3.2 ✅ shipped** (Profile.target immutable install target), **3.3+ not
> started.** This revision restructures the install pipeline around the ECC
> adapter-factory pattern and re-prioritizes targets (Hermes → Claude Code →
> Codex). PRD: `docs/prd/phase-3-install.md`. Research:
> `docs/research/phase-3-ecc-install-patterns.md` (the adapter pattern evidence
> base) + `docs/research/phase-3-plugin-targets.md` (per-target formats).

## What Phase 3 adds

Three coupled changes:

1. **MCP Management** ✅ — `McpServer.mode` (`proxy` | `direct`); stdio
   re-enabled, gated to `direct`. "MCP Connections" → "MCP Management".
2. **Target-bound profiles** ✅ — `Profile.target` (immutable) declares the
   single Agent tool a profile is shaped for; the creation form narrows offered
   resources/hook events by it.
3. **Install pipeline** ⏳ — `hnx install` resolves a profile, a **target
   adapter** (one per target, ECC-style factory) plans file operations, and an
   apply step materializes them into the target's native format. Priority order:
   **Hermes → Claude Code → Codex**.

> **What changed in this revision (vs. the prior draft):**
> - **ZCode is out of install scope.** No reference material is reproducible;
>   ECC has zero ZCode support. `zcode` stays in the `AgentTarget` enum
>   (non-breaking) but has no adapter — `hnx install --target zcode` →
>   `409 TARGET_UNSUPPORTED`.
> - **Codex is in.** A new first-class target (TOML config, JSON manifest with
>   a unique `interface` block, stdio-only MCP).
> - **Architecture follows ECC.** The old "TargetWriter interface" + "CC+ZCode
>   share a writer" model is replaced by an **adapter factory + plan/apply +
>   install-state ledger**. Each target gets its own adapter. See
>   `docs/research/phase-3-ecc-install-patterns.md`.
> - **Priority is Hermes-first.** Hermes ships before Claude Code (it was
>   previously last/lowest-confidence) because it is the most-needed target,
>   despite needing `hermes_cli/` schema verification first.

The dependency boundary is unchanged: `core` → `shared` → `server` → `sdk-ts`
→ `cli` (adapters + installer) → `apps/web`.

## Part 1 — McpServer.mode & the stdio re-enable ✅ shipped (3.1)

Implemented. `McpServer` (`core/src/domain/user.ts:56`) carries `mode: 'proxy'
| 'direct'`. **No `proxied` field** — mode is the only pooling signal; the
registry filters `list({ mode: 'proxy' })` directly (`registry.ts:111`).

| mode     | `sse` | `streamable-http` |            `stdio`             |
| -------- | :---: | :---------------: | :----------------------------: |
| `proxy`  |  ✅   |        ✅         | ❌ `409 STDIO_REQUIRES_DIRECT` |
| `direct` |  ✅   |        ✅         |               ✅               |

The registry only dials `mode === 'proxy'` rows. A `direct` row is never opened
by Harness Nexus — it is emitted verbatim into a target's plugin at install
time. `mode` lives on `McpServer` (migration v2), enforced at the route layer
(`STDIO_REQUIRES_DIRECT` via `requiresDirect()`).

## Part 2 — Profile.target ✅ shipped (3.2)

Implemented. `Profile.target: AgentTarget` (`core/src/domain/profile.ts:23`) is
required at create, immutable after (PATCH `target` → `409 TARGET_IMMUTABLE`).
The zod schemas mirror this (`shared/schemas/profile.ts`); migration v5 added
the `profiles.target` column (`DEFAULT 'generic'`).

`AgentTarget` is currently `'claude-code' | 'zcode' | 'hermes' | 'codex' |
'generic'`, defined in **two** places kept in sync manually (`core/domain/
resource.ts` + `shared/schemas/profile.ts`) — `shared` deliberately does not
depend on `core`. Priority order: hermes → claude-code → codex. `zcode` is
retained but unsupported (no adapter); `generic` is a placeholder.

## Part 3 — Hook support matrix (reuse existing)

> **Already built — do not recreate.** Phase 4.5 landed the matrix in
> `packages/shared/src/hooks.ts`. `HOOK_EVENTS`, `HOOK_SUPPORT` (keyed by
> `AgentTarget`), and `DECLARATIVE_HOOK_TARGETS` are the single source of truth
> for the hook-event side. `hermes` and `codex` are both `null` (structurally
> different hook models — Python plugins / TOML config respectively), so a
> declarative `hooks.json` resource cannot target them.

A per-artifact compatibility matrix — `(resourceKind, fromTarget, toTarget) →
portable | convertible | unsupported(reason)` — is net-new and lands with the
cross-target import phase (3.7). It will live in a new
`packages/shared/src/target-compat.ts`.

## Part 4 — Install pipeline & target adapters (core rewrite)

This part adopts the ECC pattern wholesale. Read
`docs/research/phase-3-ecc-install-patterns.md` for the evidence base.

### Architecture

```
hnx install --profile <id> --server <url> --token <pat> [--target <t>] [--apply] [--out <dir>]
   │
   ▼
ProfileResolver  ── (SDK fetch from server) ──▶ ResolvedProfile
   │                                             (Profile + fetched artifacts:
   │                                              skill bodies, hook configs,
   │                                              McpServer rows for MCP entries)
   ▼
TargetAdapter (registry lookup by target)  ──▶ planOperations()
   │                                            returns InstallPlan — NO writes
   ├── HermesAdapter      (plugin.yaml YAML + config.yaml mcp_servers YAML)
   ├── ClaudeCodeAdapter  (.claude-plugin/plugin.json + .mcp.json JSON)
   └── CodexAdapter       (.codex-plugin/plugin.json + config.toml TOML)
   │
   ▼
[ --apply ]  Installer.materialize(plan)  ──▶ write files + install-state ledger
   (default: dry-run, print plan)          ──▶ harness-nexus-install-state.json
```

The key ECC lesson: **plan and apply are separate.** The default `hnx install`
run is a dry-run that prints what would happen; `--apply` materializes. The
plan is the unit the user reviews before any file is touched.

### Target adapter factory

Each adapter is produced by a factory from a small config (mirrors ECC's
`createInstallTargetAdapter`). A minimal adapter is a ~10-line config; adapters
needing format transformation override `planOperations`.

```ts
// packages/cli/src/install/types.ts
export interface Operation {
  kind: 'copy-file' | 'merge-json' | 'merge-toml' | 'merge-yaml';
  sourcePath: string;        // resolved profile artifact
  destinationPath: string;   // target-native path
  mergePayload?: unknown;    // for merge-* operations
}

export interface InstallPlan {
  adapter: { id: string; target: AgentTarget; kind: 'home' | 'project' };
  targetRoot: string;        // where files land (e.g. ~/.hermes, ~/.codex)
  installStatePath: string;  // ledger location
  operations: Operation[];
  sensitive: boolean;        // true if any op carries decrypted direct-mode creds
}

export interface TargetAdapter {
  readonly target: AgentTarget;
  readonly nativeRoot: string;       // '.hermes' | '.codex' | '.claude-plugin'
  resolveRoot(input: ResolveInput): string;
  planOperations(resolved: ResolvedProfile, input: ResolveInput): InstallPlan;
  validate(input: ResolveInput): ValidationIssue[];
}

export function createTargetAdapter(config: AdapterConfig): TargetAdapter { /* … */ }
```

```ts
// packages/cli/src/install/adapters/hermes.ts — minimal shape
export const hermesAdapter = createTargetAdapter({
  target: 'hermes',
  kind: 'home',
  rootSegments: ['.hermes'],
  nativeRoot: '.hermes',
  // planOperations overridden to emit YAML plugin.yaml + config.yaml
});
```

### Foreign-platform path filtering

A profile's resources are target-agnostic in storage. The adapter filters out
anything that does not belong to its target at plan time (ECC's
`isForeignPlatformPath` pattern). One resolved profile feeds N targets without
per-target duplication.

### MCP emission — proxy default, direct escape hatch

**Confirmed decision: proxy is the default; direct is the escape hatch for
offline / no-server installs.** For each `kind === 'mcp'` entry, branch on the
referenced `McpServer.mode`:

- **proxy entries collapse into one** aggregated endpoint
  `/mcp?profile=<id>` with `${user_config.PAT}` (the product thesis). No upstream
  secret is shipped. Per-format emission:
  - Hermes: YAML `mcp_servers:` block in `config.yaml`
  - Claude Code: JSON `mcpServers` in `.mcp.json`
  - Codex: TOML `[mcp_servers.*]` in `config.toml` — **stdio-only, refuses `url`**
- **direct entries are written verbatim** (transport included: stdio command /
  HTTP url). `${cred:NAME}` placeholders in transport string fields are resolved
  to decrypted plaintext at emit time (inlined into url/command/args/env/headers)
  and the output is flagged `sensitive`.

### install-state ledger

Every `--apply` writes `harness-nexus-install-state.json` in the target root,
recording the adapter, the request, the resolved plan, and every operation.
This is the surface that enables future `doctor` (drift detection), `repair`
(restore managed files), and `uninstall` (remove only managed files). The ledger
is written from day one (Phase 3.3) so the surface exists even before those
subcommands ship.

### Per-target format reference

| | Hermes (1st) | Claude Code (2nd) | Codex (3rd) |
| --- | --- | --- | --- |
| Manifest | `plugin.yaml` **YAML** | `.claude-plugin/plugin.json` **JSON** | `.codex-plugin/plugin.json` **JSON** (+`interface` block) |
| Config | `config.yaml` **YAML** | `.mcp.json` **JSON** | `config.toml` **TOML** |
| MCP block | `mcp_servers:` YAML | `mcpServers` JSON | `[mcp_servers.*]` TOML, **stdio-only** |
| Memory/rules | `AGENTS.md` auto-inject | wrap-as-skill (no auto-load) | `AGENTS.md` auto-inject |
| Hooks | `null` (Python model) | ~30 declarative events | config/prompts-based |
| Confidence | Medium (verify `hermes_cli/`) | High | High (via ECC) |

The format divergence (YAML / JSON / TOML) is exactly why each target gets its
own adapter rather than a shared "JSON-family" writer.

### CLI entry

```bash
hnx install --profile <id> --server <url> --token <pat> [--target <t>] [--apply] [--out <dir>]
```

- `--profile` resolves via the SDK against `--server` (a profile is a reference
  bundle — its entries point at server-side resources, and proxy-mode MCP needs
  the `/mcp` endpoint, so the server is required). No local-manifest path.
- `--target` overrides the profile's own `target` only for `generic` profiles;
  for a target-bound profile it must match (else `409 TARGET_MISMATCH`).
  `zcode` → `409 TARGET_UNSUPPORTED` (no adapter).
- Without `--apply`: dry-run, prints the plan. With `--apply`: writes files +
  ledger.
- `generic` install semantics are deferred (decided when 3.3 starts).
- Output root defaults to the target's native home (`~/.hermes`, `~/.codex`, …)
  for `kind: 'home'` adapters; `--out` overrides.

### What we take from ECC, and what we leave

**Take:** adapter factory + frozen adapter + overridable `planOperations`;
foreign-platform path filtering; plan/apply separation; install-state ledger;
format-aware config emitters; per-target independent adapters.

**Leave (ECC-specific):** ECC's three-layer declaration (modules/profiles/
components — we use Profile + Resource); ECC's content; ECC's Codex bash sidecar
— we unify Codex into one adapter with a TOML emitter (ECC splits it across a
Node adapter + bash script, which is the one rough edge to improve on).

## Part 5 — Cross-target import

Unchanged from prior design (lands in 3.7). Two-step endpoint:

```
POST /api/profiles/:id/import-from   { sourceProfileId }   → 200 CompatibilityReport
POST /api/profiles/:id/import-apply  { sourceProfileId, selectedEntryIds[] }  → 200 Profile
```

`CompatibilityReport` carries per-entry `portable | convertible | unsupported`
driven by the per-artifact compatibility matrix (3.7's net-new
`target-compat.ts`). `zcode` as a destination is universally `unsupported`
(no adapter).

## Part 6 — API surface (additions)

All under `/api`, same `{ error, message }` shape. Unchanged from 3.1/3.2 except
the install path is CLI-only (no server endpoint for install — the CLI resolves
locally or via SDK fetch):

| Method | Path | Auth | Notes |
| ------ | ---- | ---- | ----- |
| POST | `/api/mcp-servers` | `requireAuth`† | accepts `mode`; stdio requires `direct` |
| PATCH | `/api/mcp-servers/:id` | `requireAuth`‡ | mode change allowed if transport permits |
| POST | `/api/profiles` | `requireAuth`† | requires `target` |
| PATCH | `/api/profiles/:id` | `requireAuth`‡ | omits `target`; carrying it → `409 TARGET_IMMUTABLE` |
| POST | `/api/profiles/:id/import-from` | `requireAuth`‡ | owner-or-admin on both profiles |
| POST | `/api/profiles/:id/import-apply` | `requireAuth`‡ | owner-or-admin on both profiles |

† admin required iff `scope === 'global'`. ‡ ownership check on both profiles.

New error codes: `STDIO_REQUIRES_DIRECT` (409), `TARGET_IMMUTABLE` (409),
`TARGET_MISMATCH` (409), `TARGET_UNSUPPORTED` (409), `PROFILE_SOURCE_NOT_ACCESSIBLE` (404).

## Part 7 — Web UI

Follows the Signal design system. Status: the MCP Management rename + mode badge
(3.1) and the Profile target picker + target column badge (3.2) are shipped.
Remaining UI work tracks the install/import phases:
- **Install UX** (3.3+): a "Install" action on a profile that triggers the CLI
  (or an in-browser plan preview) — design deferred until the CLI shape is real.
- **Import flow** (3.7): "Import from profile…" → picker → compatibility report
  (green = portable, amber = convertible, red = unsupported) → confirm.
- Sub-agents are no longer "hidden for zcode" (zcode is unsupported wholesale);
  the target picker offers `hermes`, `claude-code`, `codex`, `generic`.

## Part 8 — Scope, permission, and security rules

- **MCP mode and profiles inherit the existing scope model.** No new scope concepts.
- **Direct-mode installs are sensitive.** If any emitted file carries a decrypted
  credential (a direct MCP entry whose `${cred:NAME}` resolved to plaintext), the
  CLI prints a warning and the output dir gets restrictive permissions (`0700`).
  Proxy-only installs carry only a `${user_config.PAT}` placeholder and are not
  sensitive.
- **The PAT in a proxy install is `${user_config.PAT}`**, not a literal — the
  tool prompts at enable time (CC → keychain). The CLI never writes a PAT to disk
  unless explicitly told to.
- **Import never silently drops.** Every unsupported entry appears in the report
  with a reason.

## Out of scope (deferred)

- ECC + Superpower **import** adapters (3.8+ — distinct from the install adapters).
- Hosted per-profile marketplace / registry.
- `doctor` / `repair` / `uninstall` subcommands (the ledger is written from 3.3
  to enable them later).
- Per-PAT profile binding and tool-level authorization (still from 2.2).
- The stdio bridge entry (Phase 6) — direct mode here is the _tool_ spawning
  stdio, not Harness Nexus.

## Suggested sub-phasing

- **3.1 ✅** — `mode` on McpServer + stdio-in-direct + rename + migration v2.
- **3.2 ✅** — `Profile.target` (immutable) + migration v5 + TARGET_IMMUTABLE.
- **3.3** — Install pipeline **skeleton**: adapter factory + registry + plan/apply
  + install-state ledger + `hnx install` CLI (dry-run default). Adapter interface
  + a stub adapter, but **no real target adapter yet**.
- **3.4** — **Hermes adapter** (priority 1; verify `hermes_cli/` schema first).
  YAML `plugin.yaml` + `config.yaml` `mcp_servers:`; proxy/direct MCP emission.
- **3.5** — **Claude Code adapter** (priority 2). JSON `.claude-plugin/plugin.json`
  + `.mcp.json`; rules-as-skill wrapping; ~30 hook events.
- **3.6** — **Codex adapter** (priority 3). JSON `.codex-plugin/plugin.json` (+`interface`)
  + TOML `config.toml`; stdio-only MCP; `AGENTS.md` marker-merge.
- **3.7** — Cross-target import (report + apply) + per-artifact compat matrix +
  UI.
- **3.8** — Other well-known agents (openclaw / kimi / qwen / etc., optional) +
  ECC/Superpower import adapters.

`zcode` is explicitly unsupported across all install phases (no adapter). It can
be revived if a reference surface re-emerges.

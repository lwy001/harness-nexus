# Phase 3 research: ECC install pipeline patterns

> Status: research complete. Extracts the reusable install-pipeline architecture
> from ECC (Enhanced Claude Code, `/home/ubuntu/workspace/ECC`) — a mature,
> harness-agnostic operator system that installs one source tree into 14 target
> Agent tools. This doc is the evidence base for the Phase 3 design rewrite
> (`docs/design/phase-3-install.md`), which adopts ECC's adapter factory + plan/
> apply + install-state model. All code excerpts are from the ECC repo as of the
> time of writing; verify before copying verbatim.

## Why ECC is the reference

ECC's explicit design philosophy (per `docs/ECC-2.0-REFERENCE-ARCHITECTURE.md`)
is that **treating any one agent harness as the canonical interface is a
non-goal** — the per-target adapter compliance matrix _is_ the product. That is
exactly Harness Nexus's thesis (consume upstream MCP once, re-expose aggregated
to every tool), which makes ECC's install layer the closest existing
implementation of what Phase 3 needs to build.

ECC is NOT copied wholesale. The transferable parts are the _patterns_
(architecture, adapter factory, plan/apply, install-state); ECC's specific
content (281 skills, 94 commands, its own module/profile/component declaration
layer) is out of scope — Harness Nexus has its own Resource model. We also
improve on ECC's one known rough edge (Codex's dual install path).

## Architecture overview — five layers

```
content        agents/ skills/ commands/ rules/ hooks/ mcp-configs/
               (the single source of truth — ECC's, not ours)
     │
declaration    manifests/install-{modules,profiles,components}.json
               modules (atomic, +deps/cost/stability) → profiles (named bundles)
               → components (user-facing family prefixes)
     │
resolution     scripts/lib/install-manifests.js — expand profiles+components
               into module IDs, resolve the dependency DAG (cycle detection),
               filter by target support
     │
target         scripts/lib/install-targets/*.js — 14 adapters behind registry.js
adapters       each turns selected modules (with source paths) into concrete
               file operations, applying namespacing/flattening/format rules
     │
execution      scripts/lib/install-executor.js + install/apply.js — materialize
               operations (copy-file / merge-json / link-rewrite), write
               install-state ledger
     │
operator       ecc.js CLI (plan/install/catalog/consult/doctor/repair/uninstall)
```

Harness Nexus maps onto this as: our `Profile` ≈ ECC's profile bundle; our
`Resource` entries ≈ ECC's modules; our per-target adapter ≈ ECC's install
target adapter. We do **not** adopt ECC's three-layer declaration system
(modules/profiles/components) — our Profile + Resource model is simpler and
already built (Phase 4.2–4.6).

## Pattern 1 — Target adapter factory (the load-bearing idea)

A target adapter is produced by `createInstallTargetAdapter(config)` in
`scripts/lib/install-targets/helpers.js`. A minimal adapter (Hermes, Codex) is a
~10-line config object:

```js
// scripts/lib/install-targets/hermes-home.js — the entire file
const { createInstallTargetAdapter } = require('./helpers');
module.exports = createInstallTargetAdapter({
  id: 'hermes-home',
  target: 'hermes',
  kind: 'home',                              // 'home' (~/.xxx) | 'project' (./.xxx)
  rootSegments: ['.hermes'],
  installStatePathSegments: ['ecc-install-state.json'],
  nativeRootRelativePath: '.hermes',
});
```

The factory supplies default behavior, all overridable:

| Method | Default | Purpose |
| --- | --- | --- |
| `supports(target)` | match by `target` or `id` | registry lookup |
| `resolveRoot(input)` | `<homeDir\|projectRoot>/<rootSegments>` | where files land |
| `getInstallStatePath(input)` | `<root>/<installStatePathSegments>` | ledger location |
| `planOperations(input)` | **the contract** — turn modules+paths into file ops, dropping foreign-platform paths | the per-target customization point |
| `validate(input)` | require homeDir / projectRoot | gate before planning |
| `supportsModule(module)` | `true` | per-module target gate |

Adapters needing transformation override `planOperations` (Claude remaps
`rules/**`→`rules/ecc/**`; Cursor flattens to `.mdc`; OpenCode requires a build
step). The factory returns `Object.freeze(adapter)` — adapters are immutable
records.

**Harness Nexus adoption:** `packages/cli/src/install/adapters/` holds one file
per target, each calling a local `createTargetAdapter(config)`. Hermes and
Codex start as near-minimal configs; Claude Code overrides `planOperations` for
its namespacing. Adding a target = one new file.

## Pattern 2 — Foreign-platform path filtering (one source → N targets)

A module's `paths` array can include every target's native directory. Each
adapter silently drops paths belonging to a different target via
`isForeignPlatformPath`:

```js
// scripts/lib/install-targets/helpers.js — the ownership map
const PLATFORM_SOURCE_PATH_OWNERS = Object.freeze({
  '.claude-plugin': 'claude', '.codex': 'codex', '.cursor': 'cursor',
  '.gemini': 'gemini', '.hermes': 'hermes', /* …9 more… */,
});

function isForeignPlatformPath(sourceRelativePath, adapterTarget) {
  const normalizedPath = normalizeRelativePath(sourceRelativePath);
  for (const [prefix, ownerTarget] of Object.entries(PLATFORM_SOURCE_PATH_OWNERS)) {
    if (normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)) {
      return ownerTarget !== adapterTarget;   // drop if owned by another target
    }
  }
  return false;
}
```

This is how one source feeds N targets without per-target duplication: a module
lists `.claude-plugin/...`, `.codex/...`, `.hermes/...` and each adapter keeps
only its own.

**Harness Nexus adoption:** our adapter base class uses the same filter. A
profile's resources are target-agnostic in storage; the adapter drops anything
that doesn't belong to its target at plan time.

## Pattern 3 — Plan / apply separation

Two entrypoints (`scripts/install-plan.js`, `scripts/install-apply.js`) feed one
resolver:

- **plan** = resolve request → operation list. **No filesystem writes.**
  Serializable, inspectable, dry-runnable.
- **apply** = materialize the plan's operations to disk + write the install-state
  ledger.

`applyInstallPlan` (`scripts/lib/install/apply.js:163`) loops operations of three
kinds:

| Operation | Action |
| --- | --- |
| `copy-file` / `copy-path` | `fs.copyFileSync` |
| `merge-json` | deep-merge into existing config, `fs.writeFileSync` — used for `.mcp.json`/`mcp.json` |
| markdown link rewrite | rewrite relative links under `rules/ecc` to installed location |

**Harness Nexus adoption:** `hnx install --profile <id>` defaults to **plan**
(dry-run, prints what would happen); `--apply` materializes. The plan is the
unit the user reviews before any file is touched — this is safer than the
original Phase 3 draft's "emit a directory and let the user copy it" approach.

## Pattern 4 — Format-aware config writers (one MCP source, N emitters)

MCP config is the format-divergence crux. ECC has **two writer families** from
one source-of-truth (`.mcp.json`):

1. **JSON targets** (Claude / Cursor / OpenCode) — `merge-json` operation does a
   `deepMergeJson` into the target's existing `.mcp.json`/`mcp.json`, preserving
   user servers.
2. **TOML target** (Codex) — `scripts/codex/merge-mcp-config.js` does add-only
   TOML text surgery: parse `[mcp_servers.*]`, append missing sections raw,
   preserve the file byte-for-byte otherwise. Builds server specs via
   `dlxServer()` which respects the **detected package manager**
   (`npx`/`pnpm dlx`/`bunx`/`yarn dlx`). **Codex MCP is stdio-only — it refuses
   `url` keys** (ECC issue #2224).

```jsonc
// ECC's single MCP source-of-truth: .mcp.json (abridged)
{ "mcpServers": { "chrome-devtools": { "command": "npx", "args": ["-y","chrome-devtools-mcp@latest"] } } }
```

**Harness Nexus adoption:** our proxy-mode MCP emission (single aggregated
`/mcp?profile=<id>` entry) and direct-mode emission (verbatim connection) each
have a per-format emitter: JSON for Claude, TOML for Codex, YAML for Hermes. The
adapter picks the emitter; the resolver hands it the same resolved MCP spec.

## Pattern 5 — install-state ledger (doctor / repair / uninstall)

Every apply writes a ledger (`schemas/install-state.schema.json`,
`schemaVersion: "ecc.install.v1"`) recording every operation:

```
{ schemaVersion, installedAt, lastValidatedAt,
  target: { id, root, installStatePath, kind },
  request,            // what was asked for
  resolution,         // selected/skipped modules
  source: { repoVersion, repoCommit, manifestVersion },
  operations: [...]   // the full op list — the replay log
}
```

This is what makes `doctor` (detect drift), `repair` (restore managed files),
and `uninstall` (remove only managed files) work idempotently. ECC validates it
with a **dependency-free hand-rolled validator** (supply-chain vetting requires
the validated bytes to be the installed bytes — no external Ajv in the runtime
closure).

**Harness Nexus adoption:** each install writes a `harness-nexus-install-state.json`
in the target root. Phase 3.3 ships plan + apply; doctor/repair/uninstall can
follow but the ledger is written from day one so the surface exists.

## Codex — concrete format (from ECC's `.codex-plugin/` + `.codex/`)

This is the target with zero prior research in Harness Nexus; ECC fills the gap
with ground-truth files:

| Aspect | Codex value |
| --- | --- |
| Manifest path | `.codex-plugin/plugin.json` |
| Manifest format | **JSON**, with a unique `interface` block (`displayName`, `brandColor`, `composerIcon`, `defaultPrompt`, `capabilities`, …) |
| `skills` field | **string path** `"./skills/"` (CC uses an array) |
| `mcpServers` field | **path reference** `"./.mcp.json"` (CC uses inline object) |
| Config format | **TOML** `config.toml` (`#:schema .../codex/config-schema.json`) — NOT JSON |
| MCP config | `[mcp_servers.*]` TOML sections; **stdio-only** (command/args; `url` refused) |
| Memory/rules | `AGENTS.md` at project root (auto-injected); `persistent_instructions` appended to every prompt |
| Prompts | `~/.codex/prompts/<name>.md` (generated from commands, YAML frontmatter stripped) |
| Adapter | minimal (`rootSegments: ['.codex']`) — heavy lifting is separate TOML mergers |

**The Codex dual-path lesson (improve, don't copy):** ECC installs Codex via
**two parallel paths** — the Node `codex-home` adapter (skills/rules) AND a
separate bash `scripts/sync-ecc-to-codex.sh` sidecar (AGENTS.md marker-merge,
TOML merge, prompt generation, git hooks). For a greenfield pipeline we fold
both into **one adapter with format-aware writers** (JSON manifest + TOML config
emitter), avoiding ECC's split-brain.

## Hermes — concrete format (from ECC adapter + prior research)

Confidence: medium. ECC's `hermes-home` adapter is minimal (`rootSegments:
['.hermes']`), and ECC treats Hermes as a first-class target (91 file mentions),
but the full `plugin.yaml` schema still needs verification against
`hermes_cli/plugins.py` before the Hermes adapter ships (Phase 3.4).

| Aspect | Hermes value |
| --- | --- |
| Manifest path | `plugin.yaml` (Python plugin) **and** lighter "Skill Bundle" (MD-only, closer analog) |
| Manifest format | **YAML** |
| Config format | **YAML** `config.yaml` `mcp_servers:` block — **no `.mcp.json`** for its own servers |
| MCP config | YAML map; HTTP (`url:`) or stdio (`command:`/`args:`) |
| Memory/rules | `AGENTS.md` / `.hermes.md` / `CLAUDE.md` — **all auto-injected** at project root |
| Skills | `~/.hermes/skills/<name>/` (SKILL.md-compatible) |
| Distribution | `hermes skills add <github-repo>`; Python entry-points; local folder drop-in |
| Hook model | structurally different (Python plugins) — declarative `hooks.json` does NOT apply; `HOOK_SUPPORT.hermes = null` |

## Claude Code — concrete format (reference target, high confidence)

Unchanged from prior research; included for the comparison table:

| Aspect | Claude Code value |
| --- | --- |
| Manifest path | `.claude-plugin/plugin.json` |
| Manifest format | **JSON** |
| MCP config | `.mcp.json` or manifest `mcpServers` (**JSON**); uses `${CLAUDE_PLUGIN_ROOT}`, `${user_config.*}` |
| Memory/rules | **cannot** auto-load `CLAUDE.md` from a plugin — wrap rules as a skill |
| Sub-agents | `agents/*.md` (frontmatter); `hooks`/`mcpServers`/`permissionMode` forbidden in plugin agents |
| Hook events | ~30 (full declarative set) |
| Install | `claude plugin install <name>@<marketplace>`; dev sideload `claude --plugin-dir` |

## ZCode — no reference (explicitly out of scope)

ECC has **zero references** to ZCode anywhere in its repo (grep confirmed). The
Harness Nexus prior research (`docs/research/phase-3-plugin-targets.md`) relied
on a single on-disk inspection that is no longer reproducible. **ZCode stays in
the `AgentTarget` enum (non-breaking) but is marked unsupported — no adapter, no
writer, `hnx install --target zcode` → `409 TARGET_UNSUPPORTED`.** It can be
revived if a reference surfaces.

## Target comparison matrix (the design input)

| Aspect | Hermes | Claude Code | Codex |
| --- | --- | --- | --- |
| Priority | **1st** | 2nd | 3rd |
| Confidence | Medium (verify `hermes_cli/`) | High | High (via ECC) |
| Manifest | `plugin.yaml` **YAML** | `.claude-plugin/plugin.json` **JSON** | `.codex-plugin/plugin.json` **JSON** (+`interface`) |
| Config | `config.yaml` **YAML** | `.mcp.json` **JSON** | `config.toml` **TOML** |
| MCP block | `mcp_servers:` YAML | `mcpServers` JSON | `[mcp_servers.*]` TOML, **stdio-only** |
| Memory | `AGENTS.md` auto-inject | wrap-as-skill (no auto-load) | `AGENTS.md` auto-inject |
| Hooks | `null` (Python model) | ~30 events | via config/prompts |
| MCP `url`? | ✅ | ✅ | ❌ (stdio-only) |

The format divergence (YAML / JSON / TOML) is exactly why each target gets its
**own adapter** rather than a shared "JSON-family" writer — Codex's TOML config
and unique manifest `interface` block make sharing with CC a conditional mess.

## What Harness Nexus takes, and what it leaves

**Take:**
- Target adapter factory (`createTargetAdapter(config)` + frozen adapter +
  overridable `planOperations`).
- Foreign-platform path filtering (one source feeds N targets).
- Plan/apply separation (dry-run by default, `--apply` to write).
- install-state ledger (written from day one for doctor/repair/uninstall).
- Format-aware config emitters (one MCP source, per-format writers).
- Per-target independent adapters (Hermes / CC / Codex each own their manifest +
  config format).

**Leave (ECC-specific, not our model):**
- ECC's three-layer declaration (modules/profiles/components) — we use Profile +
  Resource.
- ECC's 281 skills / 94 commands content.
- ECC's dependency-free validator requirement (we're not supply-chain-vetting
  the runtime closure the same way).
- ECC's Codex bash sidecar — we unify into one adapter.

## Sources (ECC repo, `/home/ubuntu/workspace/ECC`)

- `scripts/lib/install-targets/helpers.js` — `createInstallTargetAdapter`,
  `isForeignPlatformPath`, `PLATFORM_SOURCE_PATH_OWNERS`.
- `scripts/lib/install-targets/registry.js` — adapter registry + `planInstallTargetScaffold`.
- `scripts/lib/install-targets/{hermes,codex}-home.js` — minimal adapter examples.
- `scripts/lib/install/apply.js` — `applyInstallPlan`, operation kinds,
  `deepMergeJson`.
- `scripts/codex/merge-{codex,mcp}-config.js` — TOML add-only mergers.
- `schemas/install-state.schema.json` — ledger schema (`ecc.install.v1`).
- `manifests/install-modules.json` — module shape (`paths` + `targets` array).
- `.codex-plugin/plugin.json`, `.codex/config.toml` — Codex ground-truth format.
- `docs/ECC-2.0-REFERENCE-ARCHITECTURE.md` — "no canonical harness" philosophy.

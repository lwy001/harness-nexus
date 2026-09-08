# PRD: Phase 3 — Install pipeline & target-tool profiles

> Status: **3.1 ✅, 3.2 ✅ shipped; 3.3+ not started.** Research:
> `docs/research/phase-3-ecc-install-patterns.md` (adapter pattern evidence base)
>
> - `docs/research/phase-3-plugin-targets.md` (per-target formats). Technical
>   design: `docs/design/phase-3-install.md`.
>
> **Priority change (this revision):** Hermes is now the first install target
> (most needed), then Claude Code, then Codex. ZCode is out of install scope
> (no reproducible reference; retained in the enum but unsupported). The install
> architecture follows ECC's adapter factory + plan/apply model.

## Problem Statement

Phases 2.1–2.2 let users configure upstream MCP connections, aggregate them
through a proxy, and bundle them into profiles. But a profile is still just a
**server-side roster**: to actually use it, every Agent tool (Hermes, Claude
Code, Codex) must be configured by hand to point at the proxy, and any
skills / hooks / sub-agents / commands the user wants alongside have no home
here at all — they live as loose files each tool expects in its own format and
its own directory.

Meanwhile, every major Agent tool has shipped its own **plugin** concept that
bundles exactly those artifacts (skills, hooks, sub-agents, MCP servers,
commands) into one installable unit. The shape differs per tool (Hermes is
YAML + Python; Claude Code is JSON; Codex is JSON manifest + TOML config), but
the _intent_ is identical to our profile. There is no one-click path from "a
profile in Harness Nexus" to "a working plugin in my tool of choice."

Two structural gaps compound this:

1. **stdio MCP servers are unsupported.** Phase 2.1 refused stdio because
   Harness Nexus's server would have to spawn third-party subprocesses — too risky.
   Yet stdio is the most common transport for local tools (filesystem, shell,
   language runtimes). There is no way to include a stdio server in a profile.
2. **Profiles are target-agnostic**, so the moment a user wants a hook, there is
   no way to know whether the target tool even supports that hook event, or
   what format it expects.

## Solution

Make the profile a **target-bound, installable bundle**, and make the MCP
connection carry its own dialing strategy. Three changes:

1. **MCP Management** ✅ (rename of "MCP Connections"). Each `McpServer` declares a
   `mode` at creation: **`proxy`** (Harness Nexus dials the upstream and
   re-exposes it via `/mcp`; SSE / Streamable HTTP only) or **`direct`** (the
   target tool dials the upstream itself; SSE / Streamable HTTP **and stdio**).
   stdio forces `direct`, so Harness Nexus never spawns the subprocess — the tool
   does, locally. This re-opens stdio without weakening the server's trust
   boundary.
2. **Target-bound profiles** ✅. A `Profile` declares a single `target`
   (`claude-code` | `hermes` | `codex` | `zcode` | `generic`), chosen first at
   creation and immutable afterward. Resources are stored in that target's native
   shape. The creation UI narrows what it offers (hook events, sub-agent
   options) to what the target actually supports.
3. **Install pipeline** ⏳. `hnx install --profile <id> --target <t>` resolves
   the profile, a **target adapter** (one per target, ECC-style factory) plans
   file operations, and an apply step materializes them into the target's native
   format. Each target gets its own adapter (Hermes YAML, Claude Code JSON,
   Codex JSON+TOML). Plan and apply are separate — the default run is a dry-run.

Cross-target reuse is by **import**: create a new profile for a different
target, import from an existing profile, and the importer maps compatible
resources and flags the incompatible ones (a CC-only hook event, an MCP `url`
heading to stdio-only Codex) with explicit reasons, so nothing is silently
dropped.

## User Stories

### MCP Management & mode

1. As an admin, I want to register an MCP server in `direct` mode, so that the
   target tool dials it itself and Harness Nexus never touches the connection.
2. As a user, I want to register a **stdio** MCP server, so that I can bundle
   local tools (filesystem, shell) — Harness Nexus refuses to spawn the process,
   so it must be direct.
3. As a user, I want `proxy` mode to remain the simple default for cloud MCP
   servers, so that aggregation and credential centralization still work.
4. As a user, I want stdio automatically to force `direct` mode, so that I
   cannot accidentally ask the server to spawn a subprocess.
5. As a user, I want the "MCP Connections" page renamed to "MCP Management", so
   that the scope (manage connections of either mode) is clear.
6. As an operator, I want proxy-mode servers to keep flowing through the live
   registry, so that direct mode does not regress Phase 2.2 aggregation.

### Target-bound profiles

7. As a user, I want to pick a target when creating a profile, so that the form
   only offers resources and hook events that target actually supports.
8. As a user, I want the target chosen first, so that I am guided before filling
   in resources.
9. As a user, I want the target to be immutable after creation, so that stored
   resources cannot silently become incompatible.
10. As a user, I want to migrate to a different target by importing, so that I
    can reuse a profile across tools without a silent format conversion.
11. As a developer, I want the profile to know its target, so that the install
    pipeline can skip runtime guessing and pick the right writer immediately.

### Cross-target import

12. As a user, I want to import resources from another profile into a new
    target, so that I do not rebuild a bundle from scratch per tool.
13. As a user, I want incompatible resources flagged with a reason during
    import, so that nothing is dropped silently (e.g. "Codex MCP is stdio-only;
    an HTTP-url server cannot be imported", "Hermes uses Python hooks, not
    declarative hooks.json").
14. As a user, I want compatible resources auto-converted (e.g. an MCP server's
    config from JSON to YAML for Hermes, or to TOML for Codex), so that import
    is one click for the common case.
15. As a user, I want to choose which flagged resources to skip vs. still
    attempt, so that I keep control over partial compatibility.

### Install pipeline

16. As a user, I want `hnx install --profile <id> --target hermes` to install a
    working plugin into my Hermes setup, so that I can use the profile's tools
    and skills immediately.
17. As a user, I want `hnx install --profile <id> --target claude-code` to emit
    a working Claude Code plugin, so that I can load it.
18. As a user, I want `hnx install --profile <id> --target codex` to install a
    working Codex plugin (TOML config + JSON manifest), so that I can load it.
19. As a user, I want proxy-mode MCP entries to become a single aggregated
    entry pointing at `/mcp?profile=<id>` with my PAT, so that the tool sees the
    aggregated surface.
20. As a user, I want direct-mode MCP entries to be written verbatim into the
    plugin's MCP block (with stdio preserved), so that the tool dials them
    locally.
21. As a user, I want the CLI to fetch a profile from a running server by id,
    so that I install without hand-carrying a manifest. (A profile is a reference
    bundle — its entries point at server-side resources, and proxy-mode MCP needs
    the `/mcp` endpoint — so the server is required, not optional.)
22. As a user, I want `hnx install` to dry-run by default (show me the plan
    before writing anything), so that I can review what will change before
    committing to it.
23. As a developer, I want one adapter per target (Hermes / Claude Code / Codex
    each own their manifest + config format), so that the high-confidence path
    is not tangled with format-specific conditionals.

### Security

24. As an operator, I want direct-mode plugin bundles that carry decrypted
    upstream credentials to be treated as sensitive, so that secrets do not leak
    through a generated artifact.
25. As a user, I want proxy mode to avoid shipping any upstream secret, so that
    the bundle only carries a PAT (revocable, scoped).

## Implementation Decisions

- **`McpServer.mode`** ✅ (`proxy` | `direct`), defaulting to `proxy`. The
  create/update zod schemas accept `mode` and **now accept `stdio`** when
  `mode === 'direct'` (the Phase 2.1 stdio exclusion is lifted for direct mode).
  `stdio` + `proxy` is rejected (`409 STDIO_REQUIRES_DIRECT`).
- **Proxy-mode behavior is unchanged**: the registry still pools `mode ===
'proxy'` servers, dials them, aggregates tools, and re-exposes via `/mcp`.
  Direct-mode servers are invisible to the registry (never dialed by Harness
  Nexus) but still appear in MCP Management listings.
- **`Profile.target`** ✅ (required, immutable post-create). The create schema
  requires it; the update schema omits it (PATCH `target` → `409
TARGET_IMMUTABLE`).
- **Hook support matrix** is a fixed table (canonical event → per-target support
  flag) living in `packages/shared/src/hooks.ts`. Hermes and Codex are `null`
  (different hook models). The profile creation/import path consults it to
  validate hook entries.
- **Target adapters** (`packages/cli/src/install/adapters/`): one per target —
  `HermesAdapter`, `ClaudeCodeAdapter`, `CodexAdapter` — each produced by an
  ECC-style `createTargetAdapter` factory. An adapter takes a resolved profile +
  artifacts and returns an `InstallPlan` (a list of file operations, no writes).
  `zcode` has no adapter (`409 TARGET_UNSUPPORTED`).
- **MCP entry emission**: proxy → single MCP entry (`/mcp?profile=<id>` + bearer
  PAT), emitted per-target-format (YAML / JSON / TOML); direct → the connection
  verbatim, with any bound credential decrypted and inlined at install time (the
  output is then sensitive). Codex MCP is **stdio-only** (refuses `url`).
- **Plan/apply separation**: `hnx install` defaults to a dry-run (prints the
  plan); `--apply` writes files + an install-state ledger.
- **Import endpoint** `POST /api/profiles/:id/import-from` accepts a source
  profile id, returns a compatibility report, and (on confirm) copies compatible
  entries. Incompatible entries are listed with a reason code, not copied.
- **Rename**: "MCP Connections" → "MCP Management" across web nav, page headings,
  and copy.
- **Migration**: SQLite v2 adds `mcp_servers.mode`; v5 adds `profiles.target`
  (default `'generic'`).

## Testing Decisions

- HTTP smoke tests cover: creating a stdio MCP server in direct mode (success),
  stdio + proxy (409), profile create with target, PATCH target (409), the
  import compatibility report (compatible copied, incompatible flagged), and
  install planning (a profile → expected `InstallPlan` operation list) for each
  adapter.
- Adapter tests assert the planned file tree (manifest presence, MCP block shape
  per format, skill/command/hook layout) against fixtures.
- Tests assert external behavior (status codes, shapes, planned files) against a
  memory-driver server; no live tool boot required.

## Out of Scope

- ECC + Superpower **import** adapters (the `ProfileImport` field) — later
  sub-phase (3.8), distinct from the install adapters.
- The Hermes adapter's full fidelity — its `plugin.yaml` schema must be verified
  against `hermes_cli/` first, but Hermes ships **first** (priority 1), so this
  verification is the opening task of 3.4, not a reason to deprioritize it.
- Publishing per-profile marketplaces / a hosted registry — Phase 3 installs into
  the target's native home dirs; hosting is a later concern.
- Per-PAT profile binding and tool-level authorization (still deferred from 2.2).
- stdio **bridge** entry (Harness Nexus serving a local stdio tool through a
  daemon) — Phase 6; direct mode here is the tool spawning stdio itself.
- **ZCode** install support — no reproducible reference material; retained in the
  enum but unsupported.
- `doctor` / `repair` / `uninstall` subcommands — the install-state ledger is
  written from 3.3 to enable them later.

## Further Notes

- The install architecture is adapted from **ECC** (Enhanced Claude Code,
  `~/ECC`), a mature harness-agnostic operator system that
  installs one source tree into 14 targets. Its explicit philosophy — "treating
  any one agent harness as the canonical interface is a non-goal; the per-target
  adapter compliance matrix is the product" — mirrors Harness Nexus's thesis.
  Full pattern extraction: `docs/research/phase-3-ecc-install-patterns.md`.
- Each target's format diverges at the config level (Hermes YAML, Claude Code
  JSON, Codex TOML), which is why each gets its own adapter rather than a shared
  "JSON-family" writer. Codex is the most divergent: JSON manifest with a unique
  `interface` block + TOML config + stdio-only MCP.
  evidence in `docs/research/phase-3-plugin-targets.md`.
- Full technical design (data model, API surface, writer interface, hook
  matrix, migration) lives in `docs/design/phase-3-install.md`.

# PRD: Phase 3 — Install pipeline & target-tool profiles

> Status: not started. Research: `docs/research/phase-3-plugin-targets.md`.
> Technical design: `docs/design/phase-3-install.md`.

## Problem Statement

Phases 2.1–2.2 let users configure upstream MCP connections, aggregate them
through a proxy, and bundle them into profiles. But a profile is still just a
**server-side roster**: to actually use it, every Agent tool (Claude Code,
ZCode, Hermes) must be configured by hand to point at the proxy, and any
skills / hooks / sub-agents / commands the user wants alongside have no home
here at all — they live as loose files each tool expects in its own format and
its own directory.

Meanwhile, every major Agent tool has shipped its own **plugin** concept that
bundles exactly those artifacts (skills, hooks, sub-agents, MCP servers,
commands) into one installable unit. The shape differs per tool, but the
*intent* is identical to our profile. There is no one-click path from "a
profile in AgentNexus" to "a working plugin in my tool of choice."

Two structural gaps compound this:

1. **stdio MCP servers are unsupported.** Phase 2.1 refused stdio because
   AgentNexus's server would have to spawn third-party subprocesses — too risky.
   Yet stdio is the most common transport for local tools (filesystem, shell,
   language runtimes). There is no way to include a stdio server in a profile.
2. **Profiles are target-agnostic**, so the moment a user wants a hook, there is
   no way to know whether the target tool even supports that hook event, or
   what format it expects.

## Solution

Make the profile a **target-bound, installable bundle**, and make the MCP
connection carry its own dialing strategy. Three changes:

1. **MCP Management** (rename of "MCP Connections"). Each `McpServer` declares a
   `mode` at creation: **`proxy`** (AgentNexus dials the upstream and
   re-exposes it via `/mcp`; SSE / Streamable HTTP only) or **`direct`** (the
   target tool dials the upstream itself; SSE / Streamable HTTP **and stdio**).
   stdio forces `direct`, so AgentNexus never spawns the subprocess — the tool
   does, locally. This re-opens stdio without weakening the server's trust
   boundary.
2. **Target-bound profiles.** A `Profile` declares a single `target`
   (`claude-code` | `zcode` | `hermes` | `generic`), chosen first at creation and
   immutable afterward. Resources are stored in that target's native shape. The
   creation UI narrows what it offers (hook events, sub-agent options) to what
   the target actually supports.
3. **Install pipeline.** `anx install --profile <id> --target <t>` resolves the
   profile, runs a **target writer** that emits a plugin directory in the
   target's format, and an installer that places it. Claude Code and ZCode
   share a writer (ZCode is a narrowed Claude-Code format); Hermes has its own.

Cross-target reuse is by **import**: create a new profile for a different
target, import from an existing profile, and the importer maps compatible
resources and flags the incompatible ones (a CC-only hook event, a sub-agent
heading to ZCode's plugin-unsupported slot) with explicit reasons, so nothing
is silently dropped.

## User Stories

### MCP Management & mode

1. As an admin, I want to register an MCP server in `direct` mode, so that the
   target tool dials it itself and AgentNexus never touches the connection.
2. As a user, I want to register a **stdio** MCP server, so that I can bundle
   local tools (filesystem, shell) — AgentNexus refuses to spawn the process,
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
    import, so that nothing is dropped silently (e.g. "ZCode plugins do not
    execute sub-agents").
14. As a user, I want compatible resources auto-converted (e.g. an MCP server's
    config from JSON to YAML for Hermes), so that import is one click for the
    common case.
15. As a user, I want to choose which flagged resources to skip vs. still
    attempt, so that I keep control over partial compatibility.

### Install pipeline

16. As a user, I want `anx install --profile <id> --target claude-code` to emit
    a working plugin directory, so that I can load it in Claude Code.
17. As a user, I want the same Claude-Code plugin to also load in ZCode, so
    that I do not maintain two near-identical bundles.
18. As a user, I want proxy-mode MCP entries to become a single `.mcp.json`
    entry pointing at `/mcp?profile=<id>` with my PAT, so that the tool sees the
    aggregated surface.
19. As a user, I want direct-mode MCP entries to be written verbatim into the
    plugin's MCP block (with stdio preserved), so that the tool dials them
    locally.
20. As a user, I want the CLI to run standalone from a local manifest, so that
    it works without a running server (per AGENTS.md's CLI rule).
21. As a user, I want the CLI to fetch profiles from a running server via the
    SDK, so that I do not hand-carry a manifest.
22. As a developer, I want one writer per format family (CC/ZCode shared,
    Hermes separate), so that the high-confidence path is not tangled with the
    lower-confidence one.

### Security

23. As an operator, I want direct-mode plugin bundles that carry decrypted
    upstream credentials to be treated as sensitive, so that secrets do not leak
    through a generated artifact.
24. As a user, I want proxy mode to avoid shipping any upstream secret, so that
    the bundle only carries a PAT (revocable, scoped).

## Implementation Decisions

- **`McpServer.mode`** is added (`proxy` | `direct`), defaulting to `proxy`.
  The create/update zod schemas accept `mode` and **now accept `stdio`** when
  `mode === 'direct'` (the Phase 2.1 stdio exclusion is lifted for direct
  mode). `stdio` + `proxy` is rejected (`409 STDIO_REQUIRES_DIRECT`).
- **Proxy-mode behavior is unchanged**: the registry still pools `proxy` +
  `proxied: true` servers, dials them, aggregates tools, and re-exposes via
  `/mcp`. Direct-mode servers are invisible to the registry (they are never
  dialed by AgentNexus) but still appear in MCP Management listings.
- **`Profile.target`** is added (required, immutable post-create). The create
  schema requires it; the update schema omits it (PATCH `target` → `409
  TARGET_IMMUTABLE`).
- **Hook support matrix** is a fixed table (canonical event → per-target
  support flag) living in `packages/shared`. The profile creation/import path
  consults it to validate hook entries.
- **Target writers** (`packages/cli/src/writers/`): `ClaudeCodeWriter` (also
  emits the ZCode-narrowed output via a `narrowForZCode` pass), `HermesWriter`.
  A `Writer` interface takes a resolved profile + artifacts and returns a
  directory tree.
- **MCP entry emission**: proxy → single MCP entry (`/mcp?profile=<id>` +
  bearer PAT); direct → the connection verbatim, with any bound credential
  decrypted and inlined at install time (the bundle is then sensitive).
- **Import endpoint** `POST /api/profiles/:id/import-from` accepts a source
  profile id, returns a compatibility report, and (on confirm) copies
  compatible entries. Incompatible entries are listed with a reason code, not
  copied.
- **Rename**: "MCP Connections" → "MCP Management" across web nav, page
  headings, and copy.
- **Migration**: SQLite v4 adds `mcp_servers.mode` (default `'proxy'`) and
  `profiles.target` (default `'generic'` for existing rows).

## Testing Decisions

- HTTP smoke tests cover: creating a stdio MCP server in direct mode (success),
  stdio + proxy (409), profile create with target, PATCH target (409), the
  import compatibility report (compatible copied, incompatible flagged), and
  install emission (a profile → expected plugin directory tree) for the
  Claude-Code family.
- Writer tests assert the emitted directory tree (manifest presence, MCP block
  shape, skill/command/hook layout) against fixtures.
- Tests assert external behavior (status codes, shapes, emitted files) against
  a memory-driver server; no live tool boot required.

## Out of Scope

- ECC + Superpower import adapters (the `ProfileImport` field) — later sub-phase.
- The Hermes writer's full fidelity (its `plugin.yaml` schema must be verified
  against the repo first; ship the CC/ZCode writer ahead of it).
- Publishing per-profile marketplaces / a hosted registry — Phase 3 emits a
  local directory the user adds; hosting is a later concern.
- Per-PAT profile binding and tool-level authorization (still deferred from
  2.2).
- stdio **bridge** entry (AgentNexus serving a local stdio tool through a
  daemon) — Phase 6; direct mode here is the tool spawning stdio itself.
- Full resource module (skills/hooks/sub-agents/rules as first-class stored
  entities with their own CRUD). Phase 3 profiles reference them by id where
  they exist; a richer Resource editor arrives later.

## Further Notes

- The single biggest external finding driving this design: **Claude Code and
  ZCode share a plugin spec** (ZCode probes `.claude-plugin/plugin.json` as-is
  and expands `${CLAUDE_*}` variables), so one writer serves both. Hermes is a
  Python outlier (YAML `plugin.yaml`, YAML `config.yaml` mcp_servers). Full
  evidence in `docs/research/phase-3-plugin-targets.md`.
- Full technical design (data model, API surface, writer interface, hook
  matrix, migration) lives in `docs/design/phase-3-install.md`.

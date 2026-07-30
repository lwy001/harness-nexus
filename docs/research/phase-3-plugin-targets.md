# Phase 3 research: Profile → target-tool plugin installation

> Status: research complete (original scope). **See the newer
> `docs/research/phase-3-ecc-install-patterns.md` for the install-pipeline
> architecture** (adapter factory + plan/apply + install-state) and Codex's
> ground-truth format, which this earlier doc does not cover.
>
> **Priority revisions since this doc was written:**
> - **ZCode is out of install scope.** The ZCode findings here relied on a single
>   on-disk inspection that is no longer reproducible, and ECC (the new
>   reference) has zero ZCode support. `zcode` stays in the enum but has no
>   adapter (`409 TARGET_UNSUPPORTED`). The "CC+ZCode share a writer" thesis is
>   **superseded** — each target now gets its own adapter.
> - **Codex is in** (JSON manifest + TOML config + stdio-only MCP) — see the ECC
>   research doc, which has ground-truth files.
> - **Hermes is priority 1** (was last). Its format details below remain
>   medium-confidence pending `hermes_cli/` verification.
>
> Compares how Claude Code, ZCode, and Hermes package and install extensions
> (skills/hooks/sub-agents/MCP/commands), and maps our `Profile` concept onto
> each as an installable plugin. Retained for the per-target format detail;
> superseded on architecture by the ECC research doc.

## Goal

We already have a `Profile` (a named, versioned bundle of resources — MCP
servers, skills, hooks, sub-agents, rules, commands — plus optional third-party
imports). Phase 3 is the **install pipeline**: one command that materializes a
profile into a target Agent tool's config directories so the tool loads
everything the bundle carries. This doc answers: _what is the native "plugin"
concept of each target, what can a plugin bundle, and how do we emit one from a
profile?_

Scope is the three targets named in the PRD: **Claude Code**, **ZCode**,
**Hermes**. (`generic` exists in `agentTargetSchema` for future targets.)

## TL;DR — the single most important finding

**Claude Code and ZCode share an almost identical plugin spec.** ZCode probes
the same manifest paths as Claude Code (`.claude-plugin/plugin.json` is
recognized as-is), expands the same `${CLAUDE_*}` variables, and registers
Anthropic's own marketplace by default. **One Claude-Code-format plugin works
on both** with trivial tweaks (a `.zcode-plugin/plugin.json` twin and/or
`${ZCODE_*}` variables). Hermes is the outlier: it is a **Python** agent with
its own `plugin.yaml` + `config.yaml` conventions and only partially overlaps
(SKILL.md, AGENTS.md).

This means the install pipeline is **two writers**, not three:

```
Profile  ──▶  PluginWriter (claude-code)  ──▶  also-valid-for-zcode
         ──▶  PluginWriter (hermes)       ──▶  Python-style bundle
```

## How each target does "plugins" (side by side)

| Aspect               | Claude Code                                                          | ZCode                                                            | Hermes                                                                                   |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Engine               | Node/TypeScript                                                      | Node/TypeScript (GLM)                                            | **Python**                                                                               |
| Plugin concept       | "Plugin" (directory + manifest)                                      | "Plugin" (clone of CC)                                           | "Plugin" (folder + `plugin.yaml`, Python code) **and** "Skill Bundle" (lighter, MD-only) |
| Manifest path        | `.claude-plugin/plugin.json`                                         | `.zcode-plugin/plugin.json` (**also probes `.claude-plugin/`**)  | `plugin.yaml`                                                                            |
| Manifest format      | JSON                                                                 | JSON (identical schema)                                          | YAML                                                                                     |
| Marketplace          | git-based `marketplace.json`                                         | same, **+ Anthropic's marketplace registered by default**        | GitHub "taps" (`hermes skills add <repo>`); community hub                                |
| Bundle skills        | `skills/<name>/SKILL.md`                                             | same                                                             | `skills/<name>/SKILL.md` (SKILL.md-compatible)                                           |
| Bundle commands      | `commands/*.md`                                                      | same                                                             | dynamic, from skill dirs + "quick commands"                                              |
| Bundle hooks         | `hooks/hooks.json` (rich events)                                     | `hooks/hooks.json` (**7 events only**)                           | 3 hook systems; event hooks via config/code                                              |
| Bundle MCP servers   | `.mcp.json` / manifest `mcpServers`                                  | same                                                             | `mcp_servers:` in `config.yaml` (**YAML**, not JSON)                                     |
| Bundle sub-agents    | `agents/*.md` (frontmatter)                                          | manifest `agents` field **recorded but NOT executed**            | `delegate_task` runtime; Claude-format `.claude/agents/`                                 |
| Bundle rules/memory  | **cannot** (no CLAUDE.md auto-load)                                  | **cannot** (AGENTS.md is not a plugin field)                     | drop `AGENTS.md`/`.hermes.md` at project root                                            |
| Memory file          | `CLAUDE.md`                                                          | `AGENTS.md`                                                      | `.hermes.md` / `AGENTS.md` / `CLAUDE.md` (all auto-injected)                             |
| Variables            | `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${user_config.*}` | `${ZCODE_*}` **(still expands `${CLAUDE_*}`)**                   | n/a (Python)                                                                             |
| Headless install CLI | ✅ `claude plugin install …`                                         | ❓ UI-driven ("Get" button); no confirmed `zcode plugin install` | ✅ `hermes skills add`, Python entry-points                                              |
| Confidence           | **High** (official docs, authoritative)                              | **High** (built-in `zcode-guide` plugin + on-disk evidence)      | **Medium** (docs partly AI-generated; verify `plugin.yaml` schema in-repo)               |

## Target 1 — Claude Code (the reference target)

Source of truth: the official docs. A plugin is _a self-contained directory of
components_. Installation, manifest, and marketplace are all first-class and
headless-scriptable.

### Manifest — `.claude-plugin/plugin.json`

Only `plugin.json` lives in `.claude-plugin/`; everything else sits at the
plugin root. The manifest is **optional** (components auto-discovered), but
we will always emit one for explicitness.

```jsonc
{
  "name": "frontend-daily", // required, kebab-case, immutable
  "displayName": "Frontend Daily",
  "version": "1.2.0", // omit → uses git SHA (every push = update)
  "description": "Frontend toolchain profile",
  "author": { "name": "Harness Nexus" },
  "skills": "./skills", // dir | array | inline
  "commands": ["./commands"], // legacy; prefer skills/ for new plugins
  "agents": ["./agents/reviewer.md"],
  "hooks": "./hooks/hooks.json",
  "mcpServers": "./mcp-config.json", // or inline mcpServers object
  "userConfig": {
    // prompted at enable; sensitive → keychain
    "apiToken": { "type": "string", "sensitive": true, "description": "…" },
  },
  "defaultEnabled": true,
}
```

### What a plugin can bundle (and where)

| Artifact     | Location                             | Notes                                                                                                                           |
| ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Skills       | `skills/<name>/SKILL.md`             | MD + YAML frontmatter (`name`, `description`, …). Namespaced `plugin:skill`.                                                    |
| Commands     | `commands/*.md`                      | Filename = command name. "Use skills/ for new plugins."                                                                         |
| Sub-agents   | `agents/*.md`                        | Frontmatter (`name`, `description`, `model`, `tools`, …). **`hooks`/`mcpServers`/`permissionMode` forbidden in plugin agents.** |
| Hooks        | `hooks/hooks.json`                   | Full event set (~30 events: SessionStart, PreToolUse, PostToolUse, Stop, PreCompact, …).                                        |
| MCP servers  | `.mcp.json` or manifest `mcpServers` | **Declared in the plugin, NOT written into host's `~/.claude.json`.** Uses `${CLAUDE_PLUGIN_ROOT}`, `${user_config.KEY}`.       |
| Memory/rules | —                                    | **`CLAUDE.md` at plugin root is NOT loaded.** Wrap rules as a skill instead.                                                    |

### Install paths (on disk)

- Installed plugins cache: `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`
- Persistent data: `~/.claude/plugins/data/<plugin-id>/` (survives updates)
- Marketplace registry: `~/.claude/plugins/known_marketplaces.json`
- Enablement: `enabledPlugins` in the relevant `settings.json` (user/project/local)

### Install sources (all supported)

- Interactive: `/plugin install <name>@<marketplace>` then pick scope
- Headless: `claude plugin install <name>@<marketplace> [--scope user|project|local]`
- Dev sideload (one session): `claude --plugin-dir ./my-plugin` (or `.zip`, or `--plugin-url`)
- Marketplace add: `/plugin marketplace add owner/repo` (git), local dir, file, tarball
- `marketplace.json` `source` kinds: `github`, `url`, `git-subdir`, `npm`, relative path string

### Versioning / updates

Version resolution: `plugin.json.version` → marketplace entry `version` → git SHA
→ `unknown`. The version string is the **cache key** — bump it to push updates.
`claude plugin update <plugin>`; marketplaces default to `autoUpdate` (Anthropic
ones on, others off).

**Sources:** [plugins-reference](https://code.claude.com/docs/en/plugins-reference),
[plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
[discover-plugins](https://code.claude.com/docs/en/discover-plugins),
[settings](https://code.claude.com/docs/en/settings).

## Target 2 — ZCode (Claude-Code-compatible)

Source of truth: the built-in **`zcode-guide` plugin** (Z.ai-authored, the most
authoritative source — far more complete than the web docs) plus on-disk
inspection of `~/.zcode/`. **Verified on this machine.**

### The compatibility claim (four independent proofs)

1. **Manifest probe order**: `.zcode-plugin/plugin.json` → **`.claude-plugin/plugin.json`** → `.codex-plugin/plugin.json`. A CC plugin's manifest is recognized as-is.
2. **`known_marketplaces.json`** on disk contains `claude-plugins-official` → `{ "source": "github", "repo": "anthropics/claude-plugins-official" }`. Anthropic's marketplace is addable by default.
3. **`CLAUDE_*` variables expanded at runtime** (`${CLAUDE_PLUGIN_ROOT}` in plugin `.mcp.json` files, observed in `ios-simulator`).
4. **Identical artifact structure**: `skills/<name>/SKILL.md`, `commands/*.md`, `hooks/hooks.json`, `.mcp.json`, `cache/<mp>/<plugin>/<version>/`.

### Where ZCode is NARROWER than Claude Code (important for our writer)

| Component             | Claude Code             | ZCode                                                                                                                          | Impact on us                                                                                                  |
| --------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Sub-agents in plugins | `agents/*.md` loaded    | manifest `agents` **"recorded but not executed"**                                                                              | **Cannot ship working sub-agents via a ZCode plugin.** Fall back to user-scope `~/.zcode/agents/`.            |
| Hook events           | ~30                     | **7 only**: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Stop` | Filter the hooks we emit; drop unsupported events for ZCode.                                                  |
| Headless install      | `claude plugin install` | UI-driven ("Get" button on Discover tab); **no confirmed `zcode plugin install`**                                              | ZCode install may require the user to add our marketplace in the UI, or we write to user-scope dirs directly. |
| MCP schema strictness | lenient                 | **unknown key drops the whole server**                                                                                         | Validate aggressively before emitting.                                                                        |

### On-disk layout (user scope)

```
~/.zcode/
├── AGENTS.md                         # memory (NOT a plugin field)
├── cli/
│   ├── config.json                   # mcp.servers, hooks, plugins.enabledPlugins
│   └── plugins/
│       ├── known_marketplaces.json
│       ├── marketplaces/<mp>/marketplace.json
│       └── cache/<marketplace>/<plugin>/<version>/   # installed contents
├── skills/<name>/SKILL.md            # user-scope skills
├── agents/<name>.md                  # user sub-agents (the supported path)
└── server/                           # the runtime
```

Workspace: `<repo>/.zcode/config.json`, `<repo>/.zcode/skills/`, `<repo>/AGENTS.md`.

### MCP integration

Plugin servers are keyed **`plugin:<plugin>:<server>`** (base layer, overridable
by user/workspace config). Defined inline in `mcpServers` or via legacy
`.mcp.json`. **Template expansion is plugin-only** — config-file servers do NOT
expand `${...}`, so if we ever write directly to `config.json` we must use
absolute paths. All scopes auto-connect at session start.

### userConfig caveat

ZCode supports `userConfig` (referenced via `${user_config.KEY}`) but _"a
sensitive value cannot currently be entered in the interface or persisted"_ —
**no secure credential store yet.** For secrets we must inject resolved values
at install time rather than rely on prompted `userConfig`.

**Sources:** built-in `zcode-guide` plugin (on disk):
`~/.zcode/cli/plugins/cache/zcode-plugins-official/zcode-guide/0.1.0/skills/{zcode-configuration-guide,diagnosing-mcp,diagnosing-skills,diagnosing-commands,diagnosing-hooks,diagnosing-plugins}/SKILL.md`;
[docs.z.ai](https://docs.z.ai); [zai-org/zai-coding-plugins](https://github.com/zai-org/zai-coding-plugins).

## Target 3 — Hermes (the outlier — Python)

Source of truth: `hermes-agent.nousresearch.com/docs/` + the GitHub repo
`NousResearch/hermes-agent`. **Confidence: medium** — the docs site is large but
partly AI-generated; exact `plugin.yaml` schema must be verified against
`hermes_cli/plugins.py` in the repo before implementation.

### What it is

A **self-improving, Python-based** agent by Nous Research. Distinct from the
Hermes _LLM models_. It has skills, hooks (3 systems), sub-agents (`delegate_task`),
slash commands, context files, and MCP — but the packaging model differs from
CC/ZCode.

### Two packaging concepts

1. **Plugin** — a folder under `~/.hermes/plugins/<name>/` with `plugin.yaml` +
   Python code. Used for custom **tools** / lifecycle **hooks** / CLI commands
   via a `PluginManager`. Registration also via Python entry-points.
2. **Skill Bundle** (newer, mid-2026) — a lighter, **non-Python** set of skills
   - a triggering slash command. **This is the closer analog to our profile.**

### Manifest — `plugin.yaml` (inferred; verify in-repo)

Observed/common fields: `name`, `version`, `description`, `kind` (routes to
loader: `model-provider`/`web-search`/general), `entry_point` (Python). ⚠️ Full
schema not extracted — verify.

### What a bundle carries, and where

| Artifact     | Format                                                           | Location                    | Confidence              |
| ------------ | ---------------------------------------------------------------- | --------------------------- | ----------------------- |
| Skills       | `SKILL.md` (CC-compatible frontmatter)                           | `~/.hermes/skills/<name>/`  | High                    |
| Hooks        | event hooks via config + code                                    | config + `~/.hermes/`       | Medium (format partial) |
| MCP servers  | **YAML** `mcp_servers:` in `config.yaml`                         | `~/.hermes/config.yaml`     | High                    |
| Sub-agents   | `delegate_task` runtime; Claude-format `.claude/agents/*.md`     | runtime + `.claude/agents/` | High                    |
| Rules/memory | `AGENTS.md` / `.hermes.md` / `CLAUDE.md` (**all auto-injected**) | project root / global       | High                    |
| Commands     | dynamic from skill dirs + "quick commands"                       | user + project              | Medium                  |

### MCP integration

Hermes uses **YAML, not JSON**:

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  myserver:
    url: https://... # HTTP
  another:
    command: '...' # stdio
    args: [...]
```

There is **no `.mcp.json`** for Hermes's own servers (that file appears only
when registering Hermes _as a server inside another client_).

### Distribution

- Skills Hub: `hermes skills add <github-repo>`; community hub at
  `github.com/amanning3390/hermeshub`.
- Local folder drop-in → `~/.hermes/plugins/` or `~/.hermes/skills/`.
- Python package via entry-points.
- Tarball install: **unverified.**

### Why Hermes needs a separate writer

- Different language/runtime (Python vs Node), different manifest format (YAML
  `plugin.yaml` vs JSON `plugin.json`), different MCP config (YAML `config.yaml`
  vs JSON `.mcp.json`), different distribution (GitHub taps + Python
  entry-points vs git marketplaces). The CC-format plugin we emit for CC/ZCode
  **will not load** in Hermes.

**Sources:** [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent),
[Hermes docs](https://hermes-agent.nousresearch.com/docs/),
[plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins),
[skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
[mcp](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp),
[context-files](https://hermes-agent.nousresearch.com/docs/user-guide/features/context-files).

## Mapping our `Profile` onto a plugin

Our domain model (`packages/core/src/domain/profile.ts`):

```ts
Profile { id, name, description, version, scope, ownerId, entries: ProfileEntry[], imports? }
ProfileEntry { resourceId, kind: 'skill'|'hook'|'sub_agent'|'rule'|'mcp'|'command',
               pinnedVersion?, installOptions? }
```

Each `entry.kind` maps onto a plugin component:

| Our `ProfileEntry.kind` | Claude Code plugin component                 | ZCode                                                | Hermes                            |
| ----------------------- | -------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| `mcp`                   | `.mcp.json` / manifest `mcpServers`          | same (MCP block)                                     | `config.yaml` `mcp_servers:`      |
| `skill`                 | `skills/<name>/SKILL.md`                     | same                                                 | `~/.hermes/skills/<name>/`        |
| `command`               | `commands/*.md`                              | same                                                 | skill-dir command / quick command |
| `hook`                  | `hooks/hooks.json` (event-filtered)          | `hooks/hooks.json` (**7 events**)                    | config/code hooks                 |
| `sub_agent`             | `agents/*.md`                                | **not executable** → fall back to `~/.zcode/agents/` | `.claude/agents/*.md`             |
| `rule`                  | **wrap as a skill** (no CLAUDE.md auto-load) | **wrap as a skill**                                  | drop `AGENTS.md`                  |

### The MCP server split — the key architectural decision

A profile entry of `kind: 'mcp'` can resolve in **two ways**, and this is the
crux of Phase 3:

1. **MCP server definition** (the connection config from Phase 2.1) → write into
   the plugin's MCP block so the tool dials the upstream **directly**. This is
   the "standalone plugin" path: the generated plugin carries its own
   `.mcp.json` and needs nothing else.
2. **MCP server = our proxy** → the plugin's `.mcp.json` has a single entry
   pointing at our `/mcp?profile=<id>` endpoint with the user's PAT as a bearer
   header. The tool then sees the **aggregated** toolset, and we keep
   upstream connection management server-side (the central thesis of the
   product). **This is the preferred path** — it is what makes the profile more
   than a static bundle.

```jsonc
// .mcp.json in a profile-generated plugin (recommended: proxy mode)
{
  "mcpServers": {
    "harnessnexus-frontend-daily": {
      "type": "streamable-http",
      "url": "https://hnx.example.com/mcp?profile=<profileId>",
      "headers": { "Authorization": "Bearer ${user_config.PAT}" },
    },
  },
}
```

We should support both, selected per profile or per entry. Proxy mode is the
default; direct mode is the escape hatch for offline / no-server installs
(matches the CLI's "must run standalone" rule in AGENTS.md).

## Recommended install-pipeline architecture

```
hnx install --profile <id> [--target claude-code|zcode|hermes|generic]
   │
   ▼
ProfileResolver  ── (local manifest OR SDK fetch) ──▶ resolved Profile + artifacts
   │
   ▼
TargetWriter (one per target) ──▶ emits a plugin dir / config edits
   ├── ClaudeCodePluginWriter   (also valid for ZCode)
   ├── ZCodePluginWriter        (narrows CC output: 7 hook events, no plugin sub-agents, user-scope agents fallback)
   └── HermesPluginWriter       (YAML plugin.yaml, config.yaml mcp_servers, skill-bundle)
   │
   ▼
Installer (per target)
   ├── claude-code: `claude plugin marketplace add <dir|repo>` + `claude plugin install`
   ├── zcode:       add marketplace via UI (or write to ~/.zcode/ user-scope dirs directly)
   └── hermes:      `hermes skills add <repo>` (or drop into ~/.hermes/skills|plugins/)
```

### Why two writers, not a "generic" one

- **CC/ZCode output diverges from Hermes output** at the format level (JSON vs
  YAML, `.mcp.json` vs `config.yaml`). A single generic emitter would be a
  mess of conditionals.
- **CC → ZCode** is _narrowing_, not rewriting: emit CC-format, then strip
  unsupported hook events and move sub-agents to user-scope. A thin ZCode writer
  that post-processes the CC output (or shares an emitter with a target flag)
  is cleaner than two independent ones.
- **Hermes** is genuinely separate and lower-confidence; isolate it so its
  rough edges don't contaminate the high-confidence CC/ZCode path.

### Concrete emitted layout (CC/ZCode, proxy mode)

```
<profile>-bundle/
├── .claude-plugin/
│   └── plugin.json                 # name, version, description, userConfig{PAT}
├── .zcode-plugin/                  # twin (optional; CC manifest is auto-recognized)
│   └── plugin.json
├── .mcp.json                       # single entry → our proxy w/ ?profile=<id>
├── skills/
│   └── <name>/SKILL.md             # one per kind=skill entry
├── commands/
│   └── <name>.md                   # one per kind=command entry
├── agents/
│   └── <name>.md                   # one per kind=sub_agent entry (CC only; ZCode ignores)
├── hooks/
│   └── hooks.json                  # from kind=hook entries (event-filtered per target)
└── rules-as-skill/                 # kind=rule entries wrapped as a skill (CC/ZCode)
```

For standalone/direct mode, `.mcp.json` instead carries each profile MCP entry's
own connection (decrypted credential injected at install time, since the bundle
leaves our trust boundary).

## Open risks & decisions to confirm

1. **Proxy vs direct MCP mode as default.** Recommend **proxy** (it is the
   product thesis: one aggregated endpoint). Confirm direct mode is still wanted
   for the offline CLI path.
2. **Credential handling in direct mode.** If we emit `.mcp.json` with live
   upstream connections, decrypted secrets must be injected at install time and
   the bundle must be treated as sensitive. Lean on `userConfig{PAT}` in proxy
   mode to avoid shipping secrets at all.
3. **ZCode sub-agents.** Not loadable from a plugin today. Decision: skip
   sub-agents in ZCode plugins, or fall back to writing `~/.zcode/agents/*.md`
   directly (user-scope) and warn the user.
4. **ZCode headless install.** No confirmed `zcode plugin install`. Decision:
   document the UI "add marketplace" step, or write to user-scope dirs
   (`~/.zcode/skills|commands|agents/`) directly, bypassing the plugin system.
5. **Hermes confidence.** Verify `plugin.yaml` schema + hooks config against
   `hermes_cli/plugins.py` and the bundled skill
   `skills/autonomous-ai-agents/claude-code/SKILL.md` in the repo before writing
   the Hermes writer. Treat the Hermes writer as lower-priority / lagging CC+ZCode.
6. **Rules as skills.** Neither CC nor ZCode auto-loads a memory file from a
   plugin. We must wrap `kind=rule` content into a generated `SKILL.md`. Confirm
   that is acceptable vs. instructing users to paste rules into their
   `CLAUDE.md`/`AGENTS.md` manually.
7. **Marketplace hosting.** For `hnx install` to be one-click, the generated
   bundle should be installable from a marketplace we host (git repo) or a local
   dir. Decide whether Harness Nexus auto-publishes per-profile marketplace entries
   or only emits a local dir the user adds.

## Suggested sub-phasing

- **3.1 — CC/ZCode writer + proxy mode.** `hnx install --profile <id> --target
claude-code` emits the CC-format plugin dir above with a single proxy MCP
  entry. Verify it loads in both Claude Code and ZCode. No sub-agents/hooks yet.
- **3.2 — full artifact emission.** skills, commands, hooks (event-filtered),
  rules-as-skill, sub-agents (CC; ZCode fallback). Direct MCP mode as an option.
- **3.3 — Hermes writer.** After verifying `plugin.yaml`/`config.yaml` schemas
  in-repo; skill-bundle style first, Python plugin only if needed.
- **3.4 — ECC + Superpower import adapters** (the `ProfileImport` field).

## Sources

- Claude Code: [plugins-reference](https://code.claude.com/docs/en/plugins-reference),
  [plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces),
  [discover-plugins](https://code.claude.com/docs/en/discover-plugins),
  [settings](https://code.claude.com/docs/en/settings),
  [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
- ZCode: built-in `zcode-guide` plugin (on-disk, Z.ai-authored),
  [docs.z.ai](https://docs.z.ai),
  [zai-org/zai-coding-plugins](https://github.com/zai-org/zai-coding-plugins),
  [Anthropic marketplace registered in ZCode](https://github.com/anthropics/claude-plugins-official)
- Hermes: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent),
  [Hermes docs](https://hermes-agent.nousresearch.com/docs/),
  [plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins),
  [skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills),
  [mcp](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp)

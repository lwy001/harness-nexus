# Research: Phase 8 T1 — DeepSeek Harness (dsh) as an install target

> Status: **studied** (2026-09). Ground truth: the `deepseek-ai/deepseek-harness`
> repo at tag **`dsh-v0.1.2-rc.1`** (commit `a66e470`, sparse checkout of
> `docs/`, `apps/cli/`, `packages/`), cross-checked against the local ACP
> reference demo (`/home/ubuntu/acp-ref/` — a working DSH plugin, studied for
> C5 in `phase-8-c5-acp-web-demo.md`). dsh is a **developer preview** ("THERE
> WILL BE COMPATIBILITY-BREAKING CHANGES"), MIT, 214k+ stars. Re-verify the
> concrete paths below when bumping past 0.1.x. Parent design:
> `docs/design/phase-8-t1-deepseek.md`.

## What dsh is

DeepSeek Harness (`dsh`) — released 2026-08-13 as an open-source rival to
Claude Code's agent infrastructure. Not a single coding CLI but a
**composable harness**: an npm-distributed runtime
(`npx @deepseek-ai/dsh web`) whose every capability (skills, tools, LLM
providers, subagents, MCP, the web UI itself) is a **Cordis plugin** stacked
into _profiles_. A profile is a boot preset (`web`, `headless`, `sdk`,
`sdk-minimal`, `acp` ship as templates; custom ones are user-created).

The relevance to Harness Nexus: it is exactly the kind of agent home we
manage, with a file surface we can write declaratively.

## Home + composition model (executable ground truth)

- **Home**: `$DSH_HOME` env override, default **`~/.dsh`**
  (`packages/util/home-paths/src/index.ts`: `DSH_HOME_DIR_NAME = '.dsh'`).
- **Profiles** live at `$DSH_HOME/profiles/<name>/` — each has a
  `package.json` carrying the `dsh.profile` manifest (ordered `bundles` list,
  `patchReload: live|startup`) plus its own `cordis.patch.yml` and pnpm-managed
  `node_modules` (managed via `dsh plugin --profile <name> <pnpm args>`,
  pnpm must be on PATH).
- **Composition order** (`apps/cli/reference/README.md`): bundle patches (from
  `dsh.profile.bundles`) → profile `cordis.patch.yml` → **home-level
  `$DSH_HOME/cordis.patch.yml`** → `--patch` CLI overlays. Later layers win
  per row; a row patch **replaces the whole `config`** (no deep merge); new
  rows arrive via `insert` directives.
- **Hot reload**: with `patchReload: live` (the default for custom profiles),
  ordinary edits to the profile or **home** `cordis.patch.yml` take effect
  without a restart; only bundle membership changes need a restart.
  → **writing the home-level patch is our integration seam**: it applies to
  every profile on the machine and reloads live.

### cordis patch file format

A YAML **list**; each element is either a row override (matched by `id`) or an
`insert` directive adding rows (from the shipped docs + the demo's
`overlay.yml`):

```yaml
# override an existing row by id (replace-or-disable)
- id: headless-startup
  name: '@deepseek-ai/dsh-headless/startup'
  disabled: true
# config-only override
- id: system-prompt
  config:
    persona: >-
      ...
# add new rows — this is how third-party + MCP entries land
- insert:
    - id: mcp-github
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ['-y', '@modelcontextprotocol/server-github']
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
```

`name` resolves as a package name through the profile's node parent walk to a
maintained installation fallback — **in-box packages like
`@deepseek-ai/dsh-mcp-client` need no pnpm step** to be referenceable from a
patch row. (Out-of-tree plugins DO need `dsh plugin add` — that distribution
path, an npm package with `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`,
is what the acp-ref demo uses; it is NOT our path — we are local-write only.)

## Skill system (`packages/skill/`, `docs/subsystems/skills.md`)

dsh natively speaks the **Agent Skills** format:

- Discovery roots (rank order): `<projectRoot>/.dsh/skills` (100) →
  `<projectRoot>/.agents/skills` (200) → `Config.customSkillDirs` (300) →
  **`<dshHome>/skills` (400)** → `<agentsHome>/skills` (500) → bundled (600).
- Formats: directory bundles **`<name>/SKILL.md`** (+ sibling bundle files) or
  flat `<name>.md`. **No recursive nested discovery.** Chokidar-watched —
  new bundles appear live.
- **Frontmatter is mandatory**: YAML frontmatter with `name` + `description`
  required (`skill-filesystem/src/index.ts` rejects files without it —
  "ignored: missing YAML frontmatter" / "frontmatter requires name and
  description"); `whenToUse` optional; `disable-model-invocation` /
  `disable-user-invocation` booleans.
- Names must be **kebab-case** `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
- Skills are dual-invocable: the model sees a `skill` loader tool + catalog;
  **users invoke directly as `/name`** — i.e. dsh's slash-command surface IS
  the skill surface (there is no separate prompts directory).

## MCP (`packages/mcp/mcp-client/README.md`)

One patch row per server (`dsh-mcp-client` is the bridge; tools surface as
`mcp__<serverName>__<tool>`):

- `transport: stdio` → `command` / `args` / `env` / `cwd`
- `transport: streamable-http` → `url` / `headers`
- `serverName` constraint: `[A-Za-z0-9_-]{1,32}`, unique per scope.
- Reconnect/backoff defaults; startup failure is non-fatal by default
  (`failOnStartupError: false`) — a broken server never blocks boot.
- **stdio is our shape**: the `hnx mcp serve --profile <id> --server <base>`
  shim entry slots in exactly like the Codex TOML row.

## Hooks / subagents / rules

- **Hooks**: dsh itself has no declarative hook format — but it ships
  **bridge plugins** (`@deepseek-ai/dsh-hooks-claude-code`,
  `dsh-hooks-codex`) that run an _existing_ Claude-Code/Codex `hooks.json`
  during agent runs ("mount the matching bridge, point it at your existing
  hooks.json"). They are optional packages requiring per-profile opt-in
  (pnpm-managed) — NOT something a local-write install can wire reliably in
  v1. `HOOK_SUPPORT['deepseek'] = null` (same treatment as Hermes/Codex), with
  the bridge noted for a future phase.
- **Subagents**: a provider registry (`ctx.subagents`) with in-process / ACP /
  real-Codex / real-Claude-Code children — programmatic composition, no
  declarative file format. `sub_agent` resources: skipped, like Codex.
- **Rules**: no user-scope always-on rules file exists; the persona is a
  config row (`system-prompt` persona / per-agent persona). Overwriting a
  user's persona from an install would be destructive — `rule` resources:
  skipped with a warning, like Codex.

## ACP (`packages/acp/acp/README.md` — direct C5 relevance)

- **`dsh --profile acp`** starts a ready-to-use **ACP v1 server over stdio**
  (no options; stdout is pure protocol traffic; `authenticate` succeeds
  immediately).
- Surface: ACP v1 + `session/list` / `session/resume` / Streamable-HTTP MCP
  mounts; `session/new` **validates the absolute cwd**; **one prompt in
  flight per session**; `session/request_permission` with one-shot
  allow/reject options (`optionId` semantics standard); `session/cancel` /
  `$/cancel_request`; semantic `session/update` stream (messages, thoughts,
  generic tool lifecycle, usage). Unsupported: `session/load`, fork, delete,
  replay, elicitation, modes/commands/plans/terminals.
- This maps 1:1 onto our C5 daemon's ACP client contract — the adapter row is
  just a command line: `dsh --profile acp` (requires `dsh` on PATH and a
  configured provider route — same class of prerequisite as `codex` needing
  the Codex CLI or Hermes needing the `acp_adapter` extra). Env override hook:
  `HN_ACP_COMMAND_DEEPSEEK`.
- Sessions persist across process restarts (list/resume) — richer than our
  v1 "no resume" daemon model, but compatible: we simply never call resume.

## Version pin

Research + implementation target **`dsh-v0.1.2-rc.1`** (2026-09). The format
surface we depend on (`~/.dsh` home, home-level `cordis.patch.yml`,
`skills/<name>/SKILL.md`, `dsh-mcp-client` rows, `--profile acp`) is stable
across the 0.1.x line per the reference docs, but the project's own preview
warning stands — the adapter should fail loud (not corrupt) on unexpected
patch content, and the managed-block marker approach below keeps our writes
surgically reversible.

## Consequences for Harness Nexus (summary table)

| Surface        | dsh ground truth                                                | Our emission                                                                 |
| -------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| skills         | `~/.dsh/skills/<name>/SKILL.md` (+files), mandatory frontmatter | write bundle; synthesize `name`(slug)+`description` frontmatter when missing |
| commands       | skills are the `/name` surface                                  | flat `~/.dsh/skills/<name>.md` with frontmatter                              |
| mcp            | home `cordis.patch.yml` insert row, stdio supported             | managed `- insert:` block: `dsh-mcp-client` + the `hnx mcp serve` shim       |
| hooks          | bridges exist, opt-in packages                                  | skip (warning); `HOOK_SUPPORT: null`                                         |
| sub_agents     | programmatic providers                                          | skip (warning)                                                               |
| rules          | persona config only                                             | skip (warning)                                                               |
| chat (C5)      | `dsh --profile acp`                                             | ACP adapter table row                                                        |
| inventory (C3) | the three file surfaces above                                   | scanner: skills dir + home patch MCP rows                                    |

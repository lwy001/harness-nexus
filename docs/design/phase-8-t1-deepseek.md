# Design: Phase 8 T1 — DeepSeek Harness (dsh) target support

> Status: **planned** (branch `phase-8-t1-deepseek`). Research:
> `docs/research/phase-8-t1-deepseek-harness.md` (ground truth: dsh
> `v0.1.2-rc.1`). Numbering: target onboarding becomes a **T-wave inside
> Phase 8** — it lands on Phase 8 surfaces (C3 scanner, C4 deploy, C5 ACP row)
> plus the 3.x install pipeline; the roadmap's 3.8 "other agents" bucket is
> superseded by this wave (same absorption move as 3.6→C2). **T1 is pulled
> ahead of all other pending target work** (ECC/Superpower import, CC
> local-write fallback) by explicit priority decision. Supported-harnesses
> list (one-click install + ACP chat) after T1: **Claude Code, Codex,
> DeepSeek Harness** — user-facing docs mention only these three for now;
> existing adapters (hermes) keep working unlisted. Profile target range is
> otherwise unchanged (additive `deepseek` only). Parent: Phase 8 design
> `docs/design/phase-8-client.md`; adapter template: the Codex adapter (8 C2).

## Scope

Add `deepseek` as a first-class `AgentTarget` across the platform:

1. **shared** — `agentTargetSchema` += `'deepseek'` (kept in sync with
   `core/domain/resource.ts`, per the documented duplication rule);
   `HOOK_SUPPORT['deepseek'] = null` (hook bridges are opt-in packages —
   research § Hooks); `SCANNABLE_TARGETS` += `'deepseek'`.
2. **core** — `AgentTarget` union += `'deepseek'`.
3. **CLI install adapter** (`install/adapters/deepseek.ts`, registered in
   `registry.ts`) — target root `~/.dsh`, home kind:
   - **skills** → `~/.dsh/skills/<slug>/…` bundle files (inline + inline-bundle),
     with **frontmatter synthesis**: dsh rejects SKILL.md without YAML
     frontmatter `name` + `description`; the adapter guarantees both (slug
     from the resource name, description from the resource record), kebab-case
     per dsh's `^[a-z0-9]+(?:-[a-z0-9]+)*$`.
   - **commands** → flat `~/.dsh/skills/<slug>.md` (dsh's `/name` invocation
     surface IS the skill surface; frontmatter kept/synthesized, body
     unchanged — unlike Codex which strips it).
   - **mcp** → a **managed `- insert:` block** appended to the home-level
     `~/.dsh/cordis.patch.yml`: one `@deepseek-ai/dsh-mcp-client` row per
     profile, `transport: stdio`, `command` = the hnx executable,
     `args = [mcp, serve, --profile <id>, --server <base>]` (`HN_SERVER`
     resolution identical to the Codex adapter). The block sits between
     `# BEGIN/END harness-nexus (managed)` markers — re-planning replaces the
     block wholesale (idempotent overwrite semantics, like Codex's TOML
     section surgery); user content outside markers is preserved byte-for-byte.
   - **rule / sub_agent / hook** entries → skipped with warnings (research
     table; same policy as Codex).
4. **CLI inventory scanner** (`inventory/scanners/deepseek.ts`, added to
   `SCANNERS`) — scans `~/.dsh/skills` (bundles + flat files) and MCP rows
   from the home patch (tolerant text parse of `- insert:` rows whose
   `name === '@deepseek-ai/dsh-mcp-client'`; the parse handles the README
   field spellings, not arbitrary YAML — same tradeoff as the Codex TOML
   parser). Platform-origin detection reuses the ledger +
   `harness-nexus` serverName convention. **Import**: MCP items become
   `McpServer` rows (stdio arm), skills/commands become resources — the C3
   pipeline needs no target-specific changes.
5. **C5 ACP adapter row** (`daemon/acp/adapters.ts`) —
   `deepseek: ['dsh', '--profile', 'acp']` (dsh on PATH; provider must be
   configured on the machine — documented prerequisite; env override
   `HN_ACP_COMMAND_DEEPSEEK`).
6. **server** — `DEPLOYABLE_TARGETS` += `'deepseek'` (it has a local-write
   adapter; remote deploy rides the unchanged C4 job pipeline).
7. **web** — profile editor target list += `deepseek`; MachineDetail deploy
   filter += `deepseek`; resource-editor target checkboxes follow the Codex
   precedent (Codex is not listed there today — `deepseek` matches it; only
   the profile surface changes).
8. **Tests + smoke** — CLI unit tests for the adapter (skill frontmatter
   synthesis, command emission, managed-block replace-idempotence, skipped
   kinds, `outDir` override) and scanner additions in
   `packages/cli/test/inventory.test.ts`; smoke gains a `deepseek` install +
   inventory block mirroring the Codex one.

## Non-goals / explicit out-of-scope

- **dsh plugin-package distribution** (`dsh plugin --profile X add <pkg>` /
  `dsh.bundle.patch` manifests) — that path requires pnpm on the target
  machine and per-profile management; our local-write adapter achieves the
  same capability wiring through the home patch layer. Revisit only if dsh
  grows a marketplace surface worth emitting (like 3.5 did for Claude Code).
- **Hook bridges** (`dsh-hooks-claude-code`) — opt-in packages; would need
  per-profile pnpm. `HOOK_SUPPORT` stays `null`; revisit if bridges ever ship
  in-box.
- **Rules→persona writing** — replacing a user's `system-prompt` persona row
  from an installer is destructive; skipped.
- **`session/resume` chat semantics** — dsh ACP supports it; our v1 daemon
  contract is "no resume" and stays that way.
- **DSH_HOME env plumbing through the daemon** — the adapter resolves
  `~/.dsh` via the standard `homeDir` input (same as every adapter); jobs can
  still override the whole root with `payload.directory`.

## Task order

1. shared (enum + matrix + SCANNABLE_TARGETS) → core union — typecheck.
2. CLI adapter + registry + warnings plumbing — unit tests.
3. CLI scanner + registry — inventory tests.
4. ACP row + server DEPLOYABLE_TARGETS + web pickers.
5. `pnpm -r typecheck` + targeted builds + `pnpm format`.
6. smoke `[8 T1]` block; full suites green.
7. Docs: research/design status flip, roadmap (T-wave + priority note),
   AGENTS.md, `docs/README.md`, README supported-harnesses list; merge to main.

## Security notes

- No secrets in any emission: the MCP row carries the hnx command line only;
  credentials resolve server-side at the outlet, exactly like the Codex row.
- The managed-block markers bound our writes; anything outside them is
  untouched (and `hnx uninstall` restores pre-install snapshots from the
  ledger as always).
- Frontmatter synthesis never copies more than name/description
  (resource-scoped fields) into the target home.

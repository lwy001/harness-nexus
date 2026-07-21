# PRD: Phase 4 — Resource management & PAT UI

> Status: 4.1–4.6 implemented (Phase 4 complete). External skill references & hub
> search split to Phase 7. Technical
> design: `docs/design/phase-4-web-ui.md`.

## Problem Statement

Phases 1–2.2 built the management surfaces for _connections_ (MCP servers,
credentials, profiles, users). But the other half of Harness Nexus's second pillar
— **versioned resources (skills, hooks, sub-agents, rules, commands)** — has no
home at all. The `Resource` domain type and `ResourceRepository` port exist, but
the storage drivers return a no-op stub (`memoryResourceStub`), there is no
SQLite table, no `/api/resources` route, no zod schema, and no SDK methods. A
user who wants to manage a skill or a hook has nowhere to put it.

Two concrete gaps:

1. **Personal Access Tokens had no UI.** The `/api/pats` endpoints and SDK
   methods (`createPat` / `listPats` / `revokePat`) existed since Phase 1, but
   there was no page, no nav item, and no way to create or copy a token from the
   browser. ✅ Resolved by 4.1.
2. **Resources are unbuilt.** Beyond MCP servers (already managed in Phase 2.1),
   every other resource kind — `skill`, `hook`, `sub_agent`, `rule`, `command` —
   has no CRUD, no storage, and no editor. Profiles can reference resources by
   `kind:key`, but nothing produces those rows today.

> **Phase 2.3 (callable-function scripts) is on hold** and is no longer driving
> this phase. The original Phase 4 line item "Callable-function script editor +
> test-run (with 2.3)" is **removed from scope** until 2.3 resumes.

## Solution

Two kinds of work, sequenced by complexity:

1. **Low-complexity resource kinds (sub-agents, rules) ship first.** They are
   pure markdown text (a system prompt; a policy/guideline doc) and need only the
   `inline` source variant. **4.2 (sub-agents) carries the platform cost**: it
   lands the shared Resource backend (SQLite migration, dual-driver repos
   replacing the stub, `/api/resources` CRUD, zod schema, SDK methods, scope
   model) plus the resource browser and the sub-agent markdown editor. **4.3
   (rules)** layers a near-identical markdown editor on that backend.
2. **The remaining kinds ship by difficulty, local-only** (command → hook →
   skill):
   - **4.4 — Commands** are single-file markdown (`commands/<name>.md`), the
     same shape as sub-agent/rule — the easiest, no research needed.
   - **4.5 — Hooks** are a `hooks.json` event→command map, needing the event/
     target support matrix (shared with Phase 3.2).
   - **4.6 — Skills (local)** add a new `inline-bundle` `ResourceSource` variant
     for multi-file skills (SKILL.md + `references/` + `scripts/`); single-file
     skills reuse `inline`.
3. **External skill references & multi-source hub search are split to Phase 7.**
   The plugin/marketplace / Hermes-multi-source work (a `plugin` source variant,
   `SkillSource` adapters, trust tiers, hub browse UI) is a separate large phase.
   See `docs/research/phase-4.4-skills.md` and Phase 7 in the roadmap.

## Sub-phase breakdown

| #       | Sub-phase                | Status  | Carries                                                                                                             | Depends on |
| ------- | ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| **4.1** | PAT management UI        | ✅ done | self-service token list / create-once / revoke                                                                      | nothing    |
| **4.2** | Sub-agent management     | ✅ done | **shared Resource backend** (migration, repos, `/api/resources`, schema, SDK) + resource browser + sub-agent editor | nothing    |
| **4.3** | Rule management          | ✅ done | rule markdown editor                                                                                                | 4.2        |
| **4.4** | Command management       | ✅ done | slash-command editor (single-file `commands/<name>.md`)                                                             | 4.2        |
| **4.5** | Hook management          | ✅ done | hook editor (`hooks.json`: event → command map) + event/target support matrix                                       | 4.2        |
| **4.6** | Skill management (local) | ✅ done | inline skills + multi-file bundles (new `inline-bundle` `ResourceSource` variant) + skill editor                    | 4.2        |

> **External skill references & hub search split to Phase 7.** The plugin/
> marketplace / multi-source work (CC/ZCode marketplace `plugin` source,
> Hermes-style adapters, trust tiers, hub search UI) is a separate large phase —
> see Phase 7 in `docs/roadmap.md`. Research: `docs/research/phase-4.4-skills.md`.

Dependencies: 4.1 is fully independent (done). 4.3–4.6 each depend on 4.2's shared
backend. Order is **by difficulty**: command (4.4) → hook (4.5) → skill (4.6).
4.5 needs the hook event/target matrix (shared with Phase 3.2). 4.6 needs the
new `inline-bundle` `ResourceSource` variant.

## User Stories

### 4.1 — PAT management ✅

1. As a user, I want an "Access tokens" page reachable from the sidebar, so that
   I can manage my PATs without leaving the UI.
2. As a user, I want to create a PAT with a name and optional expiry, so that I
   can authenticate the CLI or automation against the server.
3. As a user, I want the raw token shown **exactly once** at creation with a
   copy button, so that I can save it (it is never recoverable afterward).
4. As a user, I want a clear warning that the token won't be shown again, so
   that I don't dismiss the modal before copying.
5. As a user, I want to list my PATs seeing name, prefix (`hnpat_…`), scopes,
   expiry, and last-used time, so that I can recognize each one.
6. As a user, I want to revoke a PAT, so that a leaked or retired token stops
   working.
7. As a user, I want revocation confirmed before it happens, so that I don't
   delete a token I rely on by accident.
8. As a user, I want to see only my own PATs (never another user's), so that
   tokens stay private.
9. As a non-admin, I want no admin escalation here (PATs are strictly personal),
   so that the scope model is unambiguous.

### 4.2 — Sub-agent management (shared Resource backend)

10. As a user, I want a "Resources" browser reachable from the sidebar, so that I
    can find managed resources in one place.
11. As a user, I want to filter the browser by kind and by scope (global /
    personal), so that I can narrow a long list.
12. As a user, I want to author a sub-agent (a system prompt + metadata) inline
    as markdown, so that profiles can include a specialized agent.
13. As a user, I want to create a personal sub-agent, so that my own profiles can
    reference it.
14. As an admin, I want to create a global sub-agent, so that all users' profiles
    can share it.
15. As a user, I want to edit and delete my own sub-agents, so that I can iterate
    and retire them.
16. As a non-admin, I want to be blocked from mutating global sub-agents, so that
    shared assets stay admin-controlled.
17. As a user, I want a "not found" (not "forbidden") when touching someone
    else's personal resource, so that existence isn't leaked.
18. As a developer, I want resources validated by a shared zod schema, so that
    server, SDK, and web agree on accepted shapes.

### 4.3 — Rule management

19. As a user, I want to author a rule (a guideline/policy doc) inline as
    markdown, so that profiles can carry project conventions.
20. As an admin, I want global rules, so that compliance guidance is shared.
21. As a user, I want the rule editor to reuse the same backend/browser as
    sub-agents, so that the surface stays consistent.

### 4.4 — Command management

> Slash commands are single-file markdown (`commands/<name>.md` per target, no
> subdirectory convention). Mirrors 4.2/4.3 exactly — `inline` source variant.

22. As a user, I want to author a slash command (markdown body, optionally with
    argument metadata), so that profiles can include custom commands.
23. As a user, I want commands scoped global or personal, so that they can be
    shared or kept private.
24. As an admin, I want global commands, so that org-wide commands are shared.

### 4.5 — Hook management

> A hook is a `hooks.json` mapping (event → command string); the command body is
> an external executable reference, not inline content. Single-file; needs the
> event/target support matrix (shared with Phase 3.2, not yet built).

25. As a user, I want to create a hook binding an event to a command, so that it
    runs at the right moment in the target tool.
26. As a user, I want the editor to show which hook events a target supports, so
    that I can't author a hook the target will ignore.
27. As a user, I want an unsupported event flagged with a reason, so that nothing
    is silently dropped.
28. As an admin, I want global hooks, so that an org-wide policy hook is shared.

### 4.6 — Skill management (local)

> Local skills only. Single-file skills reuse `inline`; **multi-file skills
> (SKILL.md + `references/` + `scripts/`, ~42% of real skills) use a new
> `inline-bundle` `ResourceSource` variant.** External references / hub search
> are Phase 7 — see `docs/research/phase-4.4-skills.md`.

29. As a user, I want to author a single-file skill inline (SKILL.md markdown),
    so that I don't need an external source for a simple skill.
30. As a user, I want to author a **multi-file skill** (SKILL.md + reference
    markdown + scripts), so that I can store a real-world skill with its
    supporting files.
31. As a user, I want the multi-file editor to manage a file tree (add/edit/remove
    files under the skill's directory), so that the bundle stays coherent.
32. As an admin, I want global skills, so that all users can share them.

## Implementation Decisions

### Shared Resource backend (lands in 4.2)

- **One `resources` table** with a `kind` discriminator column. The existing
  `Resource` domain interface already models all kinds on one shape; there is no
  per-kind table. SQLite migration **v5** adds it.
- **`ResourceRepository` gets real implementations** in both the SQLite driver
  and the in-memory driver, replacing the shared `memoryResourceStub`. The stub
  is deleted once both drivers implement it (the in-memory driver is the
  reference shape per AGENTS.md).
- **Scope model is identical to credentials & MCP servers:** `global` is readable
  by any authenticated user but admin-only to mutate; `personal` is owner-only
  for all operations. Instance-level `requireAuth`/`requireAdmin` first, then
  per-record owner-or-admin checks. Not-found → `404` (not `403`).
- **`ResourceSource`** is the four-variant union already in the domain
  (`git` / `tarball` / `local` / `inline`). 4.2 and 4.3 only exercise `inline`
  (markdown); the external-source variants are exercised by 4.4 (skills) and
  validated then.
- **API surface:** `/api/resources` (POST/GET) + `/api/resources/:id`
  (GET/PATCH/DELETE). `GET` accepts `?kind=&scope=&target=` filters mapping to
  `ResourceListFilter`.
- **Profile integration:** `ProfileEntry` already carries `kind` + `resourceId`
  - a `kind:key` indirection note (`packages/shared/src/schemas/profile.ts`).
    Resources created here become referenceable by `kind:key` from profiles.
    (Wiring a resource picker into the profile editor is a UI convenience that can
    land within 4.2/4.3 or shortly after; the data model already supports it.)
- **zod schemas** land in `packages/shared/src/schemas/resource.ts`
  (create/update shapes mirroring the domain), kept in sync with the core types.

### PAT UI (4.1) ✅

- Implemented: route `/tokens` + sidebar item (personal, all roles), create-once
  token reveal Dialog with copy + warning, list with prefix/scopes/expiry/
  last-used/created, confirmed revoke. Reuses the table/dropdown/badge patterns.

### Markdown editors (4.2 sub-agent, 4.3 rule, 4.4 command)

- Each gets a specialized form that swaps into the resource browser's
  create/edit path based on the selected `kind`. The shared fields (name,
  description, version, scope, targets, source) stay constant; the kind-specific
  body is a markdown textarea (`source: inline`).
- A **sub-agent** editor = system-prompt markdown + agent metadata.
- A **rule** editor = policy/guideline markdown + metadata.
- A **command** editor = slash-command markdown body + optional argument
  metadata. Single-file like sub-agent/rule.
- They differ mainly in copy and a few metadata fields; all three are pure
  single-file markdown.

### Hook editor (4.5)

- A **hook** is stored as `source: inline` holding a `hooks.json` body (event →
  command-string map). The command body is an external executable reference, not
  inline content — so the hook editor is a structured event→command form (or a
  JSON textarea), not a freeform markdown editor.
- Needs the **event/target support matrix** (shared with Phase 3.2) to validate
  that the chosen events are supported by the chosen `targets`. See cross-phase
  dependencies.

### Skill editor (4.6) — local only

- **Single-file skills** reuse `source: inline` (SKILL.md markdown) — same as
  sub-agent/rule/command.
- **Multi-file skills** use a new `ResourceSource` variant `inline-bundle`:
  `{ type: 'inline-bundle'; files: Record<relativePath, content> }`, where one
  key is `SKILL.md` and others are `references/*.md`, `scripts/*`, etc. This
  lands with 4.6 and touches core/shared/storage/SDK (discriminated-union
  extension). ~42% of real skills are multi-file, so this is not an edge case.
- The multi-file editor is a small file-tree UI (add/edit/remove files) on top
  of the bundle. **External references / hub search are out of scope here —
  Phase 7.**

### Naming / nav

- Top-level nav item **"Resources"** (`/resources`) lands in 4.2. The browser's
  `kind` filter is the entry point to each kind's editor.
- Top-level nav item **"Access tokens"** (`/tokens`) landed in 4.1.

## Sub-phase readiness

- **4.4 (command)** — ready now. Single-file markdown, mirrors 4.2/4.3; add
  `'command'` to `AVAILABLE_KINDS` + a command editor variant. No research or
  design doc needed.
- **4.5 (hook)** — needs the event/target support matrix (shared with Phase 3.2,
  not yet built). Once the matrix lands in `packages/shared`, the hook editor is
  straightforward. No design doc needed beyond the matrix.
- **4.6 (skill, local)** — needs the `inline-bundle` `ResourceSource` variant.
  This is a contained extension (one new union member); write the design for it
  inline in `docs/design/phase-4-web-ui.md` when 4.6 starts, no separate research
  needed (multi-file structure is already documented above).

## External skill references → Phase 7

The plugin/marketplace / multi-source work researched in
`docs/research/phase-4.4-skills.md` is **split into Phase 7** as a separate
large phase. Key conclusions carried over: skills bundle inside plugins (CC/ZCode)
but Hermes treats skills as first-class across heterogeneous sources; distribution
is clone-and-cache; a `plugin` `ResourceSource` variant + Hermes-style
`SkillSource` adapters + trust tiers + hub search belong there. See
`docs/roadmap.md` § Phase 7.

## Cross-phase dependencies

- **Hook-event/target support matrix (4.5 ↔ Phase 3.2).** Phase 3's PRD plans a
  fixed canonical-event → per-target-support table in `packages/shared`. That
  table does not exist yet (3.2 is not started). 4.5 needs it; building it as
  part of 4.5's research would pre-exist 3.2 and unblock both.
- **Install wiring (all of 4.x ↔ Phase 3).** Resources created here are stored
  and browsable immediately, but they only become _installable_ once the Phase 3
  writers emit them. Each sub-phase is independently useful: 4.x delivers
  management even if install isn't wired yet.
- **Profile entry selection.** Profiles already reference resources by
  `kind:key`; a resource picker in the profile editor is a natural follow-on but
  not required for 4.x to deliver value.

## Testing Decisions

- **PAT UI (4.1):** HTTP smoke tests already cover the `/api/pats` endpoints
  (Phase 1). No new backend tests; the work is frontend.
- **Resource backend (4.2):** extend `scripts/smoke.mjs` for personal/global
  resource creation, scope permission denials, global-mutate by non-admin (403),
  personal resource accessed by another user (404), and `kind`/`scope`/`target`
  list filtering. Use `kind: 'sub_agent'` as the representative kind.
- **Rule editor (4.3):** smoke tests assert a `kind: 'rule'` resource is created
  with an inline markdown body. Tests assert external behavior (status codes,
  shapes) against a memory-driver server.
- **4.4–4.6:** test plans are defined when each is researched/designed.

## Out of Scope

- **Callable-function script editor + test-run** — removed; gated on Phase 2.3
  resuming (currently on hold).
- **External skill references / plugin marketplace / multi-source hub search** —
  split to Phase 7 (see `docs/research/phase-4.4-skills.md`). Phase 4.6 ships
  local skills only (inline + inline-bundle).
- **Full install emission of non-MCP resources** — that is Phase 3's writer
  pipeline. 4.x stores and manages resources; install is separate.
- **A resource marketplace / hosted registry** — Phase 7 concern.
- **Per-PAT profile binding and tool-level authorization** — still deferred from
  2.2.
- **Resource versioning history / diffing** — `Resource.version` is a single
  field; full version history is a later enhancement.
- **Resource import from third-party harnesses (ECC/Superpower)** — Phase 3.6.

## Further Notes

- The shared Resource backend is the real foundation of this phase: it is what
  turns the `memoryResourceStub` into a working aggregate and lets Pillar #2
  (resources & profiles) hold non-MCP content. Sub-agents (4.2) are the vehicle
  because they are the simplest non-trivial kind (markdown system prompt), so the
  foundation lands with the least kind-specific noise.
- The `Resource` domain type, `ResourceRepository` port, and `ResourceListFilter`
  already exist in `packages/core` — 4.2 implements them, it does not redesign
  them.
- Technical design (table DDL, repo query shapes, API table, scope matrix,
  per-kind editor field sets) lives in `docs/design/phase-4-web-ui.md`, to be
  written before implementation.

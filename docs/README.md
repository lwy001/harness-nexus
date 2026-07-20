# AgentNexus documentation

Documentation is split by type so it's clear what each file is for.

| Folder                    | What it is                                                                                                                                                           | When to read it                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`prd/`](./prd)           | **Product requirements** (PRD) — the _why_ and _what_. User stories, scope, acceptance. Written in the [to-spec](https://github.com/mattflick/to-spec) PRD template. | To understand what a phase delivers and why, before diving into how.                     |
| [`design/`](./design)     | **Technical design** (the "how") — data models, API surfaces, internals, wiring. The development-plan docs.                                                          | Before changing a phase's implementation; the authoritative source for current behavior. |
| [`research/`](./research) | **Technical research** — option comparisons, spike notes, technology surveys done before a design.                                                                   | When weighing an approach for an upcoming phase.                                         |
| [`adr/`](./adr)           | **Architecture decision records** — irreversible cross-cutting choices.                                                                                              | When asking "why this stack/convention?".                                                |

Cross-cutting overviews live at the docs root: [`architecture.md`](./architecture.md)
(layering, storage contract, MCP transport) and [`roadmap.md`](./roadmap.md)
(phase status).

> Convention: each phase has a paired `prd/phase-N-<topic>.md` and
> `design/phase-N-<topic>.md`. The PRD is written/updated when the phase is
> scoped; the design doc is written **before** implementation (see the
> "Feature development workflow" section in the root `AGENTS.md`).

## Index by phase

### Phase 1 — Users, roles & authentication ✅

- PRD: [`prd/phase-1-auth.md`](./prd/phase-1-auth.md)
- Design: [`design/phase-1-auth.md`](./design/phase-1-auth.md)

### Phase 2.1 — MCP connection config & credentials ✅

- PRD: [`prd/phase-2.1-credentials.md`](./prd/phase-2.1-credentials.md)
- Design: [`design/phase-2.1-credentials.md`](./design/phase-2.1-credentials.md)

### Phase 2.2 — MCP registry, proxy & profiles ✅

- PRD: [`prd/phase-2.2-registry.md`](./prd/phase-2.2-registry.md)
- Design: [`design/phase-2.2-registry.md`](./design/phase-2.2-registry.md)

### Phase 2.3 — Callable-function scripts ⏸️ on hold

- PRD: [`prd/phase-2.3-callable-functions.md`](./prd/phase-2.3-callable-functions.md)
- Research: [`research/phase-2.3-sandbox.md`](./research/phase-2.3-sandbox.md)
- Design: _to be written before implementation_
- > Not currently planned for development.

### Phase 3 — Install pipeline ⏳

- Research: [`research/phase-3-plugin-targets.md`](./research/phase-3-plugin-targets.md) — how Claude Code, ZCode, and Hermes package extensions, and how a `Profile` maps onto each as a plugin.
- PRD: [`prd/phase-3-install.md`](./prd/phase-3-install.md)
- Design: [`design/phase-3-install.md`](./design/phase-3-install.md)

### Phase 4 — Resource management & PAT UI ✅ (4.1–4.6 done)

- PRD: [`prd/phase-4-web-ui.md`](./prd/phase-4-web-ui.md)
- Design: [`design/phase-4-web-ui.md`](./design/phase-4-web-ui.md)
- Research: [`research/phase-4.5-hooks.md`](./research/phase-4.5-hooks.md) — the hook event × target support matrix (CC ~30 events, ZCode 7, Hermes different model); lands in `packages/shared/src/hooks.ts`.
- All resource kinds shipped: sub-agent, rule, command (single-file inline), hook (hooks.json + event/target matrix), skill (inline + inline-bundle multi-file).

### Phase 5 — ACP bridge ⏳

- _PRD/design to be written._

### Phase 6 — Platform features ⏳

- _stdio bridge, Channels, LLM-WIKI, memory/notes._

### Phase 7 — Skill multi-source & plugin references 🚧 (7.1–7.2 done)

- PRD: [`prd/phase-7-skills.md`](./prd/phase-7-skills.md) — covers all four sub-phases (7.1–7.4); carries the research corrections (10 Hermes adapters, 4 trust tiers internally / 3 surfaced, CC has 4 live source kinds and no npm, `category` is the filter axis).
- Design 7.1: [`design/phase-7.1-plugin-source.md`](./design/phase-7.1-plugin-source.md) — `plugin` `ResourceSource` variant + trust/provenance labels + `SkillSource` port + validator/smoke flip. Zero outbound network.
- Design 7.2: [`design/phase-7.2-marketplace-fetch.md`](./design/phase-7.2-marketplace-fetch.md) — the server's first outbound HTTP path: `SkillCatalogService` (lazy TTL cache + in-flight dedup), `MARKETPLACE_ALLOWLIST`, `/api/skills/marketplaces/:id/plugins`, fixture-injection test mode.
- Research: [`research/phase-4.4-skills.md`](./research/phase-4.4-skills.md) — external skill sourcing: CC/ZCode marketplace plugin model + Hermes's `SkillSource` adapter model, trust tiers, provenance pinning.
- 7.2–7.4 designs to be written before each ships.

### Concept notes (design/)

- [`design/profiles.md`](./design/profiles.md) — the broader profile concept + intended CLI install flow (future).
- [`design/mcp-proxy-legacy.md`](./design/mcp-proxy-legacy.md) — original proxy concept sketch; superseded by `phase-2.2-registry.md`.

### Decisions (adr/)

- [`adr/0001-initial-stack.md`](./adr/0001-initial-stack.md) — stack rationale.

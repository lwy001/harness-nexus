# Harness Nexus documentation

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

### Phase 2.4 — proxy MCP connect & tool inspection ✅

- PRD: [`prd/phase-2.4-connect-tools.md`](./prd/phase-2.4-connect-tools.md)
- Design: [`design/phase-2.4-connect-tools.md`](./design/phase-2.4-connect-tools.md)

### Phase 3 — Install pipeline 🚧 (3.1, 3.2 done)

- Research: [`research/phase-3-ecc-install-patterns.md`](./research/phase-3-ecc-install-patterns.md) — the install-pipeline architecture extracted from ECC (adapter factory + plan/apply + install-state ledger; Codex ground-truth format).
- Research: [`research/phase-3-plugin-targets.md`](./research/phase-3-plugin-targets.md) — per-target plugin formats (Claude Code / Hermes; ZCode superseded). Superseded on architecture by the ECC doc above.
- Research: [`research/phase-3.5-marketplace-emitter-spike.md`](./research/phase-3.5-marketplace-emitter-spike.md) — empirical spike: Claude Code consumes a plain-HTTP `marketplace.json` + `archive` (zip) plugin sources; capability-URL auth; version/SSRF constraints. Basis for the 3.5 re-plan (marketplace emission preferred over adapter writes for claude-code).
- Design: [`design/phase-3.5-marketplace-emitter.md`](./design/phase-3.5-marketplace-emitter.md) — the emitter surface: PAT-in-path catalog + per-profile archive zips, plugin zip layout, MCP emission, config `PUBLIC_BASE_URL`.
- PRD: [`prd/phase-3-install.md`](./prd/phase-3-install.md)
- Design: [`design/phase-3-install.md`](./design/phase-3-install.md) — target adapter factory (one adapter per target: Hermes → Claude Code → Codex), plan/apply, install-state ledger. ZCode out of install scope.

### Phase 4 — Resource management & PAT UI ✅ (4.1–4.6 done)

- PRD: [`prd/phase-4-web-ui.md`](./prd/phase-4-web-ui.md)
- Design: [`design/phase-4-web-ui.md`](./design/phase-4-web-ui.md)
- Research: [`research/phase-4.5-hooks.md`](./research/phase-4.5-hooks.md) — the hook event × target support matrix (CC ~30 events, ZCode 7, Hermes different model); lands in `packages/shared/src/hooks.ts`.
- All resource kinds shipped: sub-agent, rule, command (single-file inline), hook (hooks.json + event/target matrix), skill (inline + inline-bundle multi-file).

### Phase 5 — ACP bridge ➡️ absorbed into Phase 8

- Delivered by Phase 8: C1 (daemon + control channel) and C5 (ACP chat). See the Phase 8 entries below.

### Phase 6 — Platform features ⏳

- stdio bridge entry → resolved by Phase 8 C2 (the stdio shim IS the entry). Remaining: Channels (adjacent to Phase 8 C6), LLM-WIKI, memory/notes.

### Phase 7 — Skill multi-source & plugin references ✅

- PRD: [`prd/phase-7-skills.md`](./prd/phase-7-skills.md) — covers all four sub-phases (7.1–7.4); carries the research corrections (10 Hermes adapters, 4 trust tiers internally / 3 surfaced, CC has 4 live source kinds and no npm, `category` is the filter axis).
- Design 7.1: [`design/phase-7.1-plugin-source.md`](./design/phase-7.1-plugin-source.md) — `plugin` `ResourceSource` variant + trust/provenance labels + `SkillSource` port + validator/smoke flip. Zero outbound network.
- Design 7.2: [`design/phase-7.2-marketplace-fetch.md`](./design/phase-7.2-marketplace-fetch.md) — the server's first outbound HTTP path: `SkillCatalogService` (lazy TTL cache + in-flight dedup), `MARKETPLACE_ALLOWLIST`, `/api/skills/marketplaces/:id/plugins`, fixture-injection test mode.
- Design 7.3: [`design/phase-7.3-hub-ui.md`](./design/phase-7.3-hub-ui.md) — the `/skills/hub` browse page: category/free-text filters, client-side trust badge (neutral variants, not `--signal`), inline save-as-skill dialog with install-warning UX.
- Design 7.4: [`design/phase-7.4-multi-source.md`](./design/phase-7.4-multi-source.md) — 4 `SkillSource` adapters (github/well-known/url/marketplace), `SkillSearchRouter` (per-source timeout + identifier dedupe + trust-rank), `/api/skills/search`, hub dual-mode (browse + cross-source search). skills.sh/browse.sh deferred; clawhub/lobehub/hermes-index skipped (verified).
- Research: [`research/phase-4.4-skills.md`](./research/phase-4.4-skills.md) — external skill sourcing: CC/ZCode marketplace plugin model + Hermes's `SkillSource` adapter model, trust tiers, provenance pinning.
- 7.2–7.4 designs to be written before each ships.

### Phase 8 — Harness Nexus client & agent orchestration 🚧 (C1–C3 shipped)

- PRD: [`prd/phase-8-client.md`](./prd/phase-8-client.md) — the vision shift (control plane / data plane), the four locked decisions (credential distributability, `/mcp` outlet narrowing, on-demand daemon, uniform stdio MCP), and the C1–C6 scope.
- Design: [`design/phase-8-client.md`](./design/phase-8-client.md) — data model (`Machine`/`AgentInstance`/`Job`/`AcSession`), the Socket.IO-over-WSS realtime protocol (bidirectional role namespaces `/ctl` daemon + `/app` browser, event catalog, rooms, isolation layers; daemon as protocol-adaptation edge), the MCP shim process model + dial-site routing derivation, jobs/deploy, inventory/diff/import, ACP chat, security model, and the per-phase development plan.
- Design C1: [`design/phase-8-c1.md`](./design/phase-8-c1.md) — the shipped C1 plan: machines storage + migration `0006`, machine PATs (`machine-ctl`, REST-rejected), realtime v0 (`/ctl` handshake/hello/presence + `/app` push), `/api/machines` CRUD, `hnx enroll`/`hnx daemon`, the Machines web page, and the verification matrix (unit + integration + smoke `[8 C1]`).
- Design C3: [`design/phase-8-c3.md`](./design/phase-8-c3.md) — the shipped C3 plan: daemon per-target scanners (claude-code/codex/hermes), normalized snapshots over `/ctl` (`inventory:scan|report|collect|payload`), latest-per-(machine,target) storage (migration `0008`), the pure profile diff, and one-click import (reuse-or-create resources + McpServer rows + a new profile) with daemon-side secret redaction.
- Design C4: [`design/phase-8-c4.md`](./design/phase-8-c4.md) — the C4 plan: the Job state machine (queue/dispatch/ack-timeout sweep/disconnect recovery with attempt caps), remote deploy reusing the unchanged 3.3 pipeline via a machine-PAT deploy-bundle fetch, AgentInstance upserts, and the MachineDetail deployments UI.
- Research C5: [`research/phase-8-c5-acp-web-demo.md`](./research/phase-8-c5-acp-web-demo.md) — the web-vibecoding-demo reference (browser ↔ portal ↔ acp-bridge → DSH): ACP as the chat payload dialect, permission `optionId` passthrough, session-op mutual exclusion, cancel watchdog, reconnect re-registration, the fold/StreamBuffer streaming model, and fs/terminal channel boundaries. First filled row of the C5 adapter matrix (DSH).
- Design C2: [`design/phase-8-c2.md`](./design/phase-8-c2.md) — the shipped C2 plan: the normative dial-site × distributability matrix, migration `0007`, the `mcp-runtime` `UpstreamPool` extraction (stdio included), the client-config API contract (machine-PAT exception + secret-leak rules), the `hnx mcp serve` stdio shim, install-adapter shim entries + the Codex adapter, and emitter `emitMode` (client default / server fallback).

### Concept notes (design/)

- [`design/profiles.md`](./design/profiles.md) — the broader profile concept + intended CLI install flow (future).
- [`design/mcp-proxy-legacy.md`](./design/mcp-proxy-legacy.md) — original proxy concept sketch; superseded by `phase-2.2-registry.md`.

### Decisions (adr/)

- [`adr/0001-initial-stack.md`](./adr/0001-initial-stack.md) — stack rationale.

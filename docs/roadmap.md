# Roadmap

Phased so each milestone is independently useful. ✅ done, 🚧 in-progress, ⏳ not
started. Doc links point at the PRD (`docs/prd/`) and design (`docs/design/`).

## Phase 0 — Foundation

- ✅ Monorepo layout, tooling, configs
- ✅ Domain model + storage ports (`UnitOfWork`)
- ✅ Server boot path (Fastify + storage factory + health routes)

## Phase 1 — Users, roles & authentication

- ✅ SQLite storage + migrations
- ✅ Users / roles (admin, user) / registration switch + bootstrap admin
- ✅ JWT access tokens + PAT (`anpat_…`)
- ✅ Front- and back-end permission interceptors
- ✅ Web auth UI (login, register, dashboard, users, settings)
- PRD: `docs/prd/phase-1-auth.md` · Design: `docs/design/phase-1-auth.md`

## Phase 2.1 — MCP connection config & credentials

- ✅ Credential store (AES-256-GCM at rest, masked previews)
- ✅ MCP client connection CRUD (SSE / Streamable HTTP; stdio via direct mode)
- ✅ `${cred:NAME}` placeholder injection (url/command/args/env/headers)
- ✅ MCP mode: `proxy` (server dials) / `direct` (tool dials); stdio forces direct
- ✅ Scope model: global (admin-mutate) / personal (owner-only)
- PRD: `docs/prd/phase-2.1-credentials.md` · Design: `docs/design/phase-2.1-credentials.md`

## Phase 2.2 — MCP registry, proxy & profiles

- ✅ `McpRegistry`: pooled upstream connections, namespaced tool aggregation
- ✅ `${cred:NAME}` placeholders resolved into real values at connect time
- ✅ Proxy re-exposure: `/mcp` (Streamable HTTP) + `/mcp/sse` (SSE)
- ✅ Profile CRUD + explicit profile routing (`?profile=<id>`, PAT-gated)
- ✅ Live connection status (`GET /api/mcp-servers/status`) + dashboard mesh
- PRD: `docs/prd/phase-2.2-registry.md` · Design: `docs/design/phase-2.2-registry.md`

## Phase 2.3 — Callable-function scripts ⏸️ on hold

> **Status: on hold.** Not currently planned for development. The original
> Phase 4 line item "Callable-function script editor + test-run (with 2.3)" is
> removed until this phase resumes.

- ⏸️ Admin-authored JS wrapping vendor APIs as MCP tools, run in a sandbox
- ⏸️ `isolated-vm` executor + host-injected allowlisted `ctx.fetch`
- ⏸️ `ToolSource` abstraction (CallableRegistry alongside McpRegistry)
- ⏸️ Profile entries for callable-functions; management UI
- PRD: `docs/prd/phase-2.3-callable-functions.md` · Research: `docs/research/phase-2.3-sandbox.md`

## Phase 3 — Install pipeline (Pillars #2 & #3)

- ✅ 3.1 — `McpServer.mode` (proxy/direct) + stdio re-enabled in direct mode; "MCP Connections" → "MCP Management"; removed `proxied` (mode alone decides pooling)
- ⏳ 3.2 — `Profile.target` (single, immutable) + target-narrowed creation form + hook compatibility matrix
- ⏳ 3.3 — Claude-Code writer (+ zcode narrowing) + `anx install` (local manifest + SDK) + proxy/direct MCP emission
- ⏳ 3.4 — Cross-target profile import with compatibility report
- ⏳ 3.5 — Hermes writer
- ⏳ 3.6 — ECC + Superpower import adapters
- PRD: `docs/prd/phase-3-install.md` · Design: `docs/design/phase-3-install.md`
- Research: `docs/research/phase-3-plugin-targets.md` (CC/ZCode share a plugin spec; Hermes is the Python outlier)

## Phase 4 — Resource management & PAT UI

- ✅ 4.1 — PAT management UI (list / create-once / revoke); backend ready
- ✅ 4.2 — Sub-agent management: **shared Resource backend** (SQLite v5
  `resources` table, dual-driver repos replacing `memoryResourceStub`,
  `/api/resources` CRUD, zod schema, SDK methods) + resource browser + sub-agent
  markdown editor
- ✅ 4.3 — Rule management (rule markdown editor on the 4.2 backend)
- ✅ 4.4 — Command management: slash-command editor (single-file markdown;
  `commands/<name>.md` per target). Mirrors 4.2/4.3 — `AVAILABLE_KINDS` + editor
  variant only.
- ⏳ 4.5 — Hook management: hook editor (`hooks.json`: event → command map) +
  event/target support matrix (shared with Phase 3.2). Single-file; needs the
  matrix.
- ⏳ 4.6 — Skill management (local): **inline skills + multi-file bundles**.
  Adds a new `ResourceSource` `inline-bundle` variant (SKILL.md + `references/`
  - `scripts/`) — 42% of real skills are multi-file. Single-file skills reuse
    the existing `inline` variant.
- PRD: `docs/prd/phase-4-web-ui.md` · Design: `docs/design/phase-4-web-ui.md`
- Order: **by difficulty** — command (4.4) → hook (4.5) → skill (4.6). External
  skill references / hub search are split out into Phase 7.

## Phase 5 — ACP bridge

- ⏳ `@agent-nexus/acp-bridge` daemon
- ⏳ Server-side remote push of profiles to a connected tool

## Phase 6 — Platform features

- ⏳ stdio bridge entry for local tools (behind allowlist + sandbox)
- ⏳ Chat-tool Channels (route external chats to controlled agents)
- ⏳ LLM-WIKI knowledge base
- ⏳ Global memory / notes

## Phase 7 — Skill multi-source & plugin references

- ⏳ External skill references: CC/ZCode marketplace `plugin` source spec
  (github/url/git-subdir/npm), resolution + pinning (sha/version)
- ⏳ Hermes-style multi-source adapters (skills.sh, direct URL, well-known
  index, custom taps) behind a `SkillSource` interface — research-backed by
  `docs/research/phase-4.4-skills.md`
- ⏳ Hub search UI (browse a marketplace's `marketplace.json`, pick skills)
- ⏳ Trust tiers (`builtin`/`trusted`/`community`) + provenance pin
  (`content_hash`, like Hermes `lock.json`) for install-warning UX
- PRD: _to be written_ · Research: `docs/research/phase-4.4-skills.md`
- Out of Phase 4.6 scope: outbound-network security model, content scanning
  (AgentNexus stores references; the target tool executes)

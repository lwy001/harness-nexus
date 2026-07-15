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

## Phase 2.3 — Callable-function scripts

- ⏳ Admin-authored JS wrapping vendor APIs as MCP tools, run in a sandbox
- ⏳ `isolated-vm` executor + host-injected allowlisted `ctx.fetch`
- ⏳ `ToolSource` abstraction (CallableRegistry alongside McpRegistry)
- ⏳ Profile entries for callable-functions; management UI
- PRD: `docs/prd/phase-2.3-callable-functions.md` · Research: `docs/research/phase-2.3-sandbox.md`

## Phase 3 — Install pipeline (Pillars #2 & #3)

- ⏳ `McpServer.mode` (proxy/direct) + stdio re-enabled in direct mode
- ⏳ "MCP Connections" → "MCP Management"
- ⏳ `Profile.target` (single, immutable) + target-narrowed creation form
- ⏳ Cross-target profile import with compatibility report
- ⏳ CLI `install` against local manifest
- ⏳ CLI `install` against running server (via SDK)
- ⏳ Target writers: claude-code (+ zcode narrowing) / hermes
- ⏳ ECC + Superpower import adapters
- PRD: `docs/prd/phase-3-install.md` · Design: `docs/design/phase-3-install.md`
- Research: `docs/research/phase-3-plugin-targets.md` (CC/ZCode share a plugin spec; Hermes is the Python outlier)

## Phase 4 — Web UI breadth

- ⏳ PAT management UI
- ⏳ Resource browsers (skills/hooks/rules/sub-agents) — global vs personal
- ⏳ Callable-function script editor + test-run (with 2.3)

## Phase 5 — ACP bridge

- ⏳ `@agent-nexus/acp-bridge` daemon
- ⏳ Server-side remote push of profiles to a connected tool

## Phase 6 — Platform features

- ⏳ stdio bridge entry for local tools (behind allowlist + sandbox)
- ⏳ Chat-tool Channels (route external chats to controlled agents)
- ⏳ LLM-WIKI knowledge base
- ⏳ Global memory / notes

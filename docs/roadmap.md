# Roadmap

Phased so each milestone is independently useful. Items marked 🚧 are
in-progress (skeleton only); ✅ are done; ⏳ are not started.

## Phase 0 — Foundation (this skeleton)
- ✅ Monorepo layout, tooling, configs
- ✅ Domain model + storage ports
- ✅ Server boot path (Fastify + storage factory + health routes)
- ✅ Auth hook (PAT verification) — 🚧 logic skeleton, no JWT yet

## Phase 1 — Core CRUD + storage
- ⏳ SQLite storage implementation + migrations
- ⏳ Users / roles / PAT issuance routes
- ⏳ Resource CRUD (global + personal scope)
- ⏳ Profile CRUD
- ⏳ MCP server registration + connection lifecycle

## Phase 2 — MCP proxy (Pillar #1)
- ⏳ `McpRegistry`: aggregate upstream tools/resources/prompts
- ⏳ Re-expose as streamable-http + SSE
- ⏳ stdio bridge entry for local tools

## Phase 3 — Install pipeline (Pillars #2 & #3)
- ⏳ CLI `install` against local manifest
- ⏳ CLI `install` against running server (via SDK)
- ⏳ Target writers: claude-code / zcode / hermes
- ⏳ ECC + Superpower import adapters

## Phase 4 — Web UI
- ⏳ Login + PAT management
- ⏳ Resource / profile browsers (global vs personal)
- ⏳ MCP server config UI

## Phase 5 — ACP bridge (Pillar: remote control)
- ⏳ `@agent-nexus/acp-bridge` daemon
- ⏳ Server-side remote push of profiles to a connected tool

## Phase 6 — Platform features
- ⏳ Chat-tool Channels (route external chats to controlled agents)
- ⏳ LLM-WIKI knowledge base
- ⏳ Global memory / notes

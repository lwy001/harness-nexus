# Architecture

Harness Nexus is a polyglot-friendly monorepo (all-TypeScript for now) that provides
a unified platform for managing Agent-tool assets across Claude Code, ZCode, and
Hermes. Four pillars:

1. **MCP proxy** — consume your MCP servers once, re-expose them to every tool.
2. **Resource & profile management** — versioned skills/hooks/sub-agents/rules/MCP
   definitions, bundled into installable profiles.
3. **Third-party harness import** — pull in ECC / Superpower release packages and
   fold them into profiles.
4. **Users, roles, and PAT** — global vs. personal scoping for resources and
   profiles, with personal access tokens for CLI/automation.

## Layering (enforced, not just convention)

```
apps/web ──────────────► @harness-nexus/sdk ──► HTTP ──► packages/server
                                                                  │
packages/cli ─┐                                                  ▼
              ├──► @harness-nexus/core  ◄──── packages/server (infra/storage/*)
packages/acp─┘        (domain + ports)            implements ports
```

- **`packages/core`** — pure domain types + repository _ports_ (interfaces). No
  I/O, no framework imports. This is what makes storage pluggable.
- **`packages/shared`** — zod schemas + cross-package utils. The single source of
  truth for request/manifest shapes.
- **`packages/server`** — Fastify HTTP API + MCP transport. Owns the concrete
  storage implementations (`infra/storage/sqlite`, `infra/storage/memory`).
- **`packages/sdk-ts`** — HTTP client used by the web UI and external scripts.
- **`packages/cli`** — install tool. Fetches profiles from a server via the SDK
  (a profile is a reference bundle; resource bodies and the aggregated `/mcp`
  endpoint both require the server).
- **`packages/acp-bridge`** — local daemon (roadmap).
- **`apps/web`** — React + TS + Vite SPA.

## Storage contract

A storage driver implements the `UnitOfWork` from core — every repository on it
(users, tokens, settings, credentials, mcpServers, profiles, and the still-stubbed
resources). Adding a new backend (e.g. Postgres) means: new folder under
`server/src/infra/storage/`, implement every repository, add a case in
`factory.ts`. Nothing else changes.

Default is SQLite (`better-sqlite3`, single file, WAL). Set
`STORAGE_DRIVER=memory` for ephemeral/test runs. Schema evolves via forward-only
migrations in `server/src/infra/storage/sqlite/migrations.ts` (v1 users/tokens/
settings, v2 credentials/mcp_servers, v3 profiles).

## MCP transport

The MCP proxy is decoupled from REST routes. A single `McpRegistry`
(`server/src/mcp/registry.ts`) backs multiple re-exposure transports — currently
Streamable HTTP (`/mcp`) and SSE (`/mcp/sse`) — so the same aggregated server can
be consumed by remote tools over HTTP. The registry dials configured upstreams as
a client (SSE / Streamable HTTP) and aggregates their tools under namespaced keys;
agent tools authenticate with a PAT and route through a profile. stdio is
unsupported (security). See `docs/design/phase-2.2-registry.md`.

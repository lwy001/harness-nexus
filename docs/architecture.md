# Architecture

AgentNexus is a polyglot-friendly monorepo (all-TypeScript for now) that provides
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
apps/web ──────────────► @agent-nexus/sdk ──► HTTP ──► packages/server
                                                                  │
packages/cli ─┐                                                  ▼
              ├──► @agent-nexus/core  ◄──── packages/server (infra/storage/*)
packages/acp─┘        (domain + ports)            implements ports
```

- **`packages/core`** — pure domain types + repository _ports_ (interfaces). No
  I/O, no framework imports. This is what makes storage pluggable.
- **`packages/shared`** — zod schemas + cross-package utils. The single source of
  truth for the profile/resource manifest shape.
- **`packages/server`** — Fastify HTTP API + MCP transport. Owns the concrete
  storage implementations (`infra/storage/sqlite`, `infra/storage/memory`).
- **`packages/sdk-ts`** — HTTP client used by the web UI and external scripts.
- **`packages/cli`** — standalone install tool. Must work without the server.
- **`packages/acp-bridge`** — local daemon (roadmap).
- **`apps/web`** — React + TS + Vite SPA.

## Storage contract

A storage driver implements `UnitOfWork` from core (five repositories). Adding a
new backend (e.g. Postgres) means: new folder under `server/src/infra/storage/`,
implement all five repos, add a case in `factory.ts`. Nothing else changes.

Default is SQLite (`better-sqlite3`, single file). Set `STORAGE_DRIVER=memory`
for ephemeral/test runs.

## MCP transport

The MCP proxy is decoupled from REST routes. One registry backs multiple
transports (stdio, SSE, streamable-http), so the same aggregated server can be
consumed by local tools (stdio) and remote ones (HTTP).

# Harness Nexus

> A unified management platform for the Agent tools you use across work, home, and
> servers — MCP servers, skills, hooks, sub-agents, rules, and profiles, in one
> place. Works with Claude Code, ZCode, and Hermes.

The directory is still named `mcp-proxy` for historical reasons; the project /
npm scope is **`harnessnexus`** (`@harness-nexus/*`).

## Four pillars

1. **MCP proxy** — register your MCP servers once; Harness Nexus connects to them as
   a client and re-exposes a single aggregated MCP server to every tool.
2. **Resources & profiles** — versioned skills/hooks/sub-agents/rules/MCP
   definitions, bundled into profiles that install into a target tool with one
   command (`hnx install`).
3. **Third-party harness import** — bring in ECC or Superpower release packages
   and compose them into your profiles.
4. **Users, roles, PATs** — global vs. personal resources/profiles, with personal
   access tokens for CLI and automation.

See [`docs/architecture.md`](docs/architecture.md) and
[`docs/roadmap.md`](docs/roadmap.md) for the full picture.

## Stack

Node.js + TypeScript · Fastify · React + Vite · pnpm workspaces · SQLite (default,
pluggable) · official MCP SDK.

## Repository layout

```
packages/
  core/        domain entities + repository ports (pure TS, no I/O)
  shared/      zod schemas + utils (single source of truth for manifest shapes)
  server/      Fastify API + MCP proxy + storage drivers (sqlite/memory)
  sdk-ts/      HTTP client SDK
  cli/         `hnx` one-click install tool
  acp-bridge/  local ACP <-> Harness Nexus daemon (roadmap)
apps/
  web/         React + TS + Vite admin UI
docs/          architecture, MCP proxy, profiles, roadmap, ADRs
```

## Quick start

```bash
pnpm install            # install workspace deps

# Required: a JWT secret to sign access tokens (≥16 chars)
export JWT_SECRET="$(openssl rand -base64 48)"

# Optional: ephemeral run without a database file
export STORAGE_DRIVER=memory

task dev                # start everything in watch mode (needs task: https://taskfile.dev)
# or, without task:
pnpm dev:server         # API on :7477
pnpm dev:web            # web UI on :5173
```

The first user to register becomes the admin. Manage users and the registration
switch from the web UI (`/admin/users`, `/admin/settings`).

**Phase 1** (users, two roles, JWT + PAT auth, registration switch, permission
interceptors, SQLite driver, web auth UI) is implemented. See
[`docs/auth.md`](docs/auth.md) and [`docs/roadmap.md`](docs/roadmap.md).

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
pnpm dev:server         # API on :8080
pnpm dev:web            # web UI on :5173
```

The first user to register becomes the admin. Manage users and the registration
switch from the web UI (`/admin/users`, `/admin/settings`).

**Phase 1** (users, two roles, JWT + PAT auth, registration switch, permission
interceptors, SQLite driver, web auth UI) is implemented. See
[`docs/auth.md`](docs/auth.md) and [`docs/roadmap.md`](docs/roadmap.md).

## Docker

`docker compose up --build` starts the whole stack as two containers:

- **`server`** — the Fastify API + MCP proxy (multi-stage image built from the
  root `Dockerfile`). SQLite is the default storage driver, persisted to a
  `/data` volume. Not published — only reachable from `web`.
- **`web`** — nginx serving the built SPA (`apps/web/Dockerfile`) and
  reverse-proxying `/api` + `/mcp` to `server`. This is the **only** exposed
  port.

The SPA calls same-origin (`apps/web/src/api.ts` defaults to `""`), so the
browser hits nginx and it forwards API/MCP traffic to the backend. No
`VITE_API_BASE_URL` needed.

```bash
# 1. Configure (copy + fill in the required JWT_SECRET)
cp .env.example .env
# edit .env: JWT_SECRET="$(openssl rand -base64 48)"

# 2. Build & run both containers
docker compose up --build -d          # web on http://<host>:15921, data in ./data/

# 3. Open the UI
open http://localhost:15921
```

The host port (default `15921`) is the left side of `ports: ["15921:80"]` in
`docker-compose.yml` — change it if 15921 is taken. The `web` service waits for
`server`'s `HEALTHCHECK` before starting, so there's no cold-start 502.

The MCP SSE transport (`/mcp/sse`) passes through nginx unbuffered with a 1h
read timeout (see `apps/web/nginx.conf`) — long-lived streams aren't cut.

Both images are **built entirely from CN mirrors** (TUNA for apt, npmmirror
for npm/pnpm) so builds need no proxy — convenient in CN networks. To use the
official registries instead, drop the two mirror `RUN`/`ENV` lines in each
Dockerfile's build stage. `JWT_SECRET` (≥16 chars) is required at runtime and
is never baked into either image.

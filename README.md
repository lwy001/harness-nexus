# Harness Nexus

English | [简体中文](README.zh-CN.md)

> A self-hosted control plane for your coding agents — MCP servers, skills,
> hooks, sub-agents, rules and profiles in one place, deployed to your own
> machines, with remote chat over ACP.

**⚠️ Early stage.** Harness Nexus is young software under active development:
features, APIs, and the wire protocol may change without notice, parts of the
roadmap are still unbuilt (see [Status](#status)), and the docs sometimes lag
the code. It is usable today for the workflows described below — but expect
rough edges, and don't put irreplaceable data in it yet.

## What it does

A control plane / data-plane split: the server + web UI manage everything,
while a small client (`hnx`) on each of your machines does the local work.

- **MCP, once** — register upstream MCP servers (with credentials, encrypted
  at rest); tools are aggregated behind one endpoint per profile. Agents on
  your machines consume them as local stdio MCP shims (`hnx mcp serve`).
- **Resources & profiles** — versioned skills / hooks / sub-agents / rules /
  MCP definitions, bundled into per-target profiles and deployed to a machine
  with one job. Supported harnesses: **Claude Code, Codex, and DeepSeek
  Harness (dsh)** — more targets are on the roadmap.
- **Machines & deploy** — enroll a machine with `hnx enroll`, keep its daemon
  connected over WSS, scan what's installed there, diff against a profile,
  one-click import back into the platform, and deploy profiles as replayable
  jobs.
- **Chat with a deployed agent** — talk to an agent instance from the browser
  over ACP (streaming replies, tool calls, permission prompts), executed on
  your machine, gated per machine and off by default.
- **Multi-user from day one** — JWT + personal access tokens, global vs.
  personal resources, admin/user roles.

## Status

| Area                                   | State                        |
| -------------------------------------- | ---------------------------- |
| Auth, users, roles, PATs               | ✅ shipped                   |
| MCP connections, credentials, proxy    | ✅ shipped                   |
| Resources & profile editors (web)      | ✅ shipped                   |
| Skill hub (browse/save/search sources) | ✅ shipped                   |
| Claude Code marketplace emitter        | ✅ shipped                   |
| `hnx` install / uninstall (local)      | ✅ shipped (codex, deepseek) |
| Machines, daemon, MCP shims            | ✅ shipped                   |
| Inventory / diff / import              | ✅ shipped                   |
| Remote deploy jobs                     | ✅ shipped                   |
| ACP chat                               | ✅ shipped                   |
| Orchestration (multi-agent)            | 🧪 undesigned                |
| Other import adapters (ECC/Superpower) | 🧪 planned                   |

The detailed plan lives in [`docs/roadmap.md`](docs/roadmap.md); each phase has
a paired PRD + design doc indexed in [`docs/README.md`](docs/README.md).

## Stack

Node.js ≥20 · TypeScript (strict) · Fastify · React + Vite · pnpm workspaces ·
SQLite (default, pluggable storage) · official MCP SDK · Socket.IO · zod.

## Repository layout

```
packages/
  core/          domain entities + repository ports (pure TS, no I/O)
  shared/        zod schemas + utils — single source of truth for wire shapes
  server/        Fastify API + MCP registry/proxy + realtime + storage drivers
  mcp-runtime/   UpstreamPool — shared by the server proxy and the stdio shim
  sdk-ts/        HTTP client SDK
  cli/           `hnx` — enroll/daemon/install/mcp-serve
apps/
  web/           React admin UI (Signal design system)
docs/            PRDs, designs, research, roadmap, ADRs
```

## Quick start (development)

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

## Docker

`docker compose up --build` starts the whole stack as two containers:

- **`server`** — the Fastify API + MCP proxy + realtime channel (multi-stage
  image from the root `Dockerfile`). SQLite persists to a `/data` volume.
  Not published — only reachable from `web`.
- **`web`** — nginx serving the built SPA (`apps/web/Dockerfile`) and
  reverse-proxying `/api`, `/mcp` and `/socket.io` (WebSocket) to `server`.
  The only exposed port.

```bash
# 1. Configure (copy + fill in the required JWT_SECRET)
cp .env.example .env
# edit .env: JWT_SECRET="$(openssl rand -base64 48)"

# 2. Build & run
docker compose up --build -d

# 3. Open the UI (bound to localhost by default — see ports: in docker-compose.yml)
open http://127.0.0.1:15922
```

By default the web port binds to `127.0.0.1` only. To expose it, change
`ports:` in `docker-compose.yml` and put TLS in front (a reverse proxy like
Caddy/nginx) — the API sends tokens in headers, so serve it over HTTPS before
opening it beyond localhost.

Both images build entirely from CN mirrors (TUNA for apt, npmmirror for npm) so
builds need no proxy; to use the official registries instead, drop the mirror
`RUN`/`ENV` lines in each Dockerfile's build stage. `JWT_SECRET` (≥16 chars)
is required at runtime and never baked into either image.

## Connecting a machine

On the machine you want to manage (can be the same host):

```bash
# one-time: install the client (Node.js ≥ 20)
npm install -g @harness-nexus/cli

# in the web UI: Machines → Enroll — shows a one-time token + machine id
hnx daemon --server https://your-instance --token <machine-token> --machine-id <machine-id>
```

The daemon reports presence, serves local stdio MCP shims to your agent tools,
executes deploy jobs, and hosts ACP chat subprocesses. Chat is disabled per
machine by default — enable it on the machine page (it runs tools on that
machine, owner-only).

## Security notes

This product stores and serves secrets (upstream credentials). Design choices
that matter: credential secrets are AES-256-GCM encrypted at rest and never
returned in full; tokens (PATs, machine enrollment) are shown exactly once;
machine tokens only reach the realtime channel, not the REST API; remote chat
is opt-in per machine, owner-only, with session audit rows; env/header values
are redacted before machine inventory is uploaded. Treat the instance (and its
`JWT_SECRET`) as root for everything connected to it.

## Documentation

[`docs/README.md`](docs/README.md) indexes everything: architecture
([`docs/architecture.md`](docs/architecture.md)), per-phase PRDs/designs,
research notes, and ADRs.

## License

[MIT](LICENSE)

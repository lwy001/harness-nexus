<p align="center">
  <img src="docs/assets/logo.svg" alt="Harness Nexus" width="380">
</p>

<p align="center">
  <em>A self-hosted control plane for your coding agents — MCP servers, skills,<br>
  hooks, sub-agents, rules and profiles in one place, deployed to your own<br>
  machines, with remote chat over ACP.</em>
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/sinrimin/harness-nexus/actions/workflows/ci.yml"><img src="https://github.com/sinrimin/harness-nexus/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  &nbsp;·&nbsp;
  <a href="https://www.npmjs.com/package/@harness-nexus/cli"><img src="https://img.shields.io/npm/v/@harness-nexus/cli" alt="npm @harness-nexus/cli"></a>
</p>

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
- **Manage the harnesses themselves** — install / upgrade / pin the agent
  runtimes (Claude Code, Codex, dsh) as remote jobs, push a default LLM
  provider & model config to a machine, and inspect each harness's native
  config files (redacted) without SSH.
- **Chat with your agents** — talk to any agent instance from the browser over
  ACP: streaming replies, rich tool-call cards, permission prompts, image and
  file attachments, per-session mode & model selectors. List and resume the
  agent's own native sessions; the platform stores nothing session-shaped.
  Runs on your machine; gated per machine, off by default.
- **Multi-user from day one** — JWT + personal access tokens, global vs.
  personal resources, admin/user roles.

## Status

| Area                                   | State                           |
| -------------------------------------- | ------------------------------- |
| Auth, users, roles, PATs               | ✅ shipped                      |
| MCP connections, credentials, proxy    | ✅ shipped                      |
| Resources & profile editors (web)      | ✅ shipped                      |
| Skill hub (browse/save/search sources) | ✅ shipped                      |
| Claude Code marketplace emitter        | ✅ shipped                      |
| `hnx` install / uninstall (local)      | ✅ shipped (codex, deepseek)    |
| Machines, daemon, MCP shims            | ✅ shipped                      |
| Inventory / diff / import              | ✅ shipped                      |
| Remote deploy jobs                     | ✅ shipped                      |
| Harness runtime mgmt (W1–W4)           | ✅ shipped                      |
| ACP chat: portal UI, sessions (W5–W9)  | ✅ shipped                      |
| LLM providers + model discovery (W10)  | ✅ shipped                      |
| Web UI languages (en / zh-CN)          | ✅ shipped                      |
| npm: `@harness-nexus/cli` published    | ✅ 0.1.0-alpha                  |
| Docker Hub images                      | 🔜 lands on the next vX.Y.Z tag |
| Orchestration (multi-agent)            | 🧪 undesigned                   |
| Other import adapters (ECC/Superpower) | 🧪 planned                      |

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

### CI & releases

Every push and PR runs CI (install → build → typecheck → test,
`.github/workflows/ci.yml`). Releases are **tag-driven**: bump the five
package versions (`packages/{core,shared,sdk-ts,mcp-runtime,cli}`), merge to
main, then `git tag vX.Y.Z && git push origin vX.Y.Z`. Pushing the tag runs
two workflows in lockstep:

- `release` — publishes the npm packages via OIDC trusted publishing (no npm
  token is stored in the repository); already-published versions are skipped,
  so re-running a tag is idempotent.
- `docker` — builds and pushes both images to Docker Hub
  (`sinrimin/harness-nexus-server` / `-web`, tagged `X.Y.Z` + `latest`) using
  environment secrets gated by the `release` environment.

## Docker

Two containers make up the stack:

- **`server`** — the Fastify API + MCP proxy + realtime channel (multi-stage
  image from the root `Dockerfile`). SQLite persists to a `/data` volume.
  No host ports — only reachable from `web`.
- **`web`** — nginx serving the built SPA (`apps/web/Dockerfile`) and
  reverse-proxying `/api`, `/mcp` and `/socket.io` (WebSocket) to `server`.
  The only exposed port.

Both images are published to Docker Hub on every release tag (linux/amd64),
so pulling beats building:

```bash
# 1. Configure (copy + fill in the required JWT_SECRET)
cp .env.example .env
# edit .env: JWT_SECRET="$(openssl rand -base64 48)"

# 2. Run from the published images…
docker compose pull && docker compose up -d
# …or build from source (compiles the whole workspace inside the image):
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
is opt-in per machine and owner-only, and the platform stores nothing
session-shaped — chat transcripts stay with the agent on your machine;
env/header values are redacted before machine inventory is uploaded. Treat the
instance (and its `JWT_SECRET`) as root for everything connected to it.

## Documentation

[`docs/README.md`](docs/README.md) indexes everything: architecture
([`docs/architecture.md`](docs/architecture.md)), per-phase PRDs/designs,
research notes, and ADRs.

## License

[MIT](LICENSE)

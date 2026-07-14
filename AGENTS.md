# AGENTS.md — AgentNexus workspace guide

This file orients future ZCode (and Claude Code) agents working in this repo.
Read it before making changes. The repo is a **skeleton** as of this writing —
most logic is TODO; respect the layering below while filling it in.

## What this project is

**AgentNexus** (`agentnexus`, npm scope `@agent-nexus/*`) is a unified management
platform for Agent-tool assets (Claude Code, ZCode, Hermes) across machines. Four
pillars:

1. **MCP proxy** — consume upstream MCP servers once, re-expose one aggregated
   server to every tool. (`packages/server/src/mcp/`)
2. **Resources & profiles** — versioned skills/hooks/sub-agents/rules/MCP defs,
   bundled into installable profiles. (`packages/core/src/domain/`)
3. **Third-party harness import** — ECC / Superpower release packages folded into
   profiles. (CLI adapters, TODO)
4. **Users, roles, PATs** — global vs. personal scoping + personal access tokens.
   (`packages/core/src/domain/user.ts`)

> The directory is still named `mcp-proxy` for historical reasons; the project
> name is `agentnexus`. Don't be confused by the path.

## Stack

Node.js ≥20 · TypeScript (strict) · Fastify · pnpm workspaces · zod ·
SQLite (`better-sqlite3`, default; pluggable) · official `@modelcontextprotocol/sdk` ·
React + Vite (web).

## Repository layout

```
packages/
  core/        domain entities + repository PORTS (pure TS — NO I/O, NO frameworks)
  shared/      zod schemas + utils — single source of truth for manifest shapes
  server/      Fastify API + MCP proxy + storage DRIVERS (sqlite/memory)
  sdk-ts/      HTTP client SDK
  cli/         `anx` one-click install tool (must run WITHOUT the server)
  acp-bridge/  local ACP <-> AgentNexus daemon (roadmap)
apps/web/      React + TS + Vite admin UI
docs/          architecture.md, mcp-proxy.md, profiles.md, roadmap.md, adr/
```

## Architecture rules (enforced — a regression if violated)

1. **`packages/core` stays pure.** Only domain types and repository _interfaces_
   (ports). Never import Fastify, the MCP SDK, `better-sqlite3`, or any storage
   driver here. Concrete repository implementations live ONLY under
   `packages/server/src/infra/storage/*`.
2. **Dependencies flow one way.** `server`, `cli`, `sdk-ts`, `acp-bridge`, `web`
   may depend on `core`/`shared`. `core` depends on nothing in this repo.
3. **Storage is pluggable via `UnitOfWork`** (`core/src/ports/repository.ts`).
   Adding a backend = new folder under `server/src/infra/storage/`, implement all
   five repositories, add a case in `server/src/infra/storage/factory.ts`. Nothing
   else changes. The in-memory driver (`memory/index.ts`) is the reference shape.
4. **MCP transport is decoupled from REST routes.** Keep aggregation in
   `server/src/mcp/` (registry, TODO) so the same registry can serve stdio, SSE,
   and streamable-http. Do not push MCP logic into route handlers.
5. **Manifest schemas live in `packages/shared`.** Server, web, and CLI must all
   validate via those zod schemas — keep them in sync with `core` domain types.
6. **The CLI must run standalone.** `packages/cli` can talk to a server via the
   SDK, but the common `install` path must work from a local manifest with no
   server running. Don't couple it to server availability.

## Common commands

The repo uses [Task](https://taskfile.dev) as a convenience wrapper around pnpm.
Either form works.

```bash
pnpm install                 # first-time setup
task dev          | pnpm dev               # all packages, watch mode (parallel)
task dev:server   | pnpm --filter @agent-nexus/server run dev   # API on :7477
task dev:web      | pnpm --filter @agent-nexus/web run dev      # UI on :5173
task build        | pnpm -r run build
task test         | pnpm -r run test
task typecheck    | pnpm -r run typecheck
task lint         | pnpm -r run lint
task format       | pnpm format
task clean        | pnpm clean
```

Run a single package by filter, e.g. `pnpm --filter @agent-nexus/core run build`.

To boot the server without SQLite set up: `STORAGE_DRIVER=memory pnpm dev:server`.

## Coding conventions

- **TypeScript strict**, ESM (`"type": "module"`), `moduleResolution: "Bundler"`,
  `verbatimModuleSyntax: true`. Shared flags in `tsconfig.base.json`.
- **Use `import type` for type-only imports** (required by `verbatimModuleSyntax`).
- **Relative imports inside a package use `.js` extensions** (e.g.
  `./domain/user.js`) — ESM output expects them even for TS sources.
- **Cross-package imports use the scoped name**, e.g.
  `import type { Resource } from '@agent-nexus/core'`.
- **Ports vs. implementations**: define interfaces in `core/src/ports/`,
  implement them in `server/src/infra/`. Route modules depend on the interface,
  never a concrete driver.
- **Errors**: throw `AppError` from `@agent-nexus/shared` for expected failures;
  Fastify maps `statusCode`/`code` to the response.
- **Formatting**: Prettier (single quotes, trailing comma `all`, 100 cols). Run
  `pnpm format` before committing.
- **Config from env**, with defaults, in `packages/server/src/config.ts`. Don't
  read `process.env` ad hoc inside modules.
- **Logging**: use the Fastify logger (`app.log` / `req.log`), not `console.*`
  (the CLI/bridge daemons may use `console` until they get a logger).

## Sensitive areas — read docs first

Before touching these, read the linked doc:

- **MCP proxy / registry** → `docs/mcp-proxy.md`
- **Profile model & install flow** → `docs/profiles.md`
- **Layering & storage contract** → `docs/architecture.md`
- **Stack rationale** → `docs/adr/0001-initial-stack.md`

## Authentication & authorization (permission interceptors)

Full design in `docs/auth.md` — read it before touching auth. Summary for daily work:

- **Two roles only:** `admin` and `user`. Each user has exactly one role
  (`User.role`, not an array). Branch all access decisions on this field.
- **Two credential channels**, both via `Authorization: Bearer <credential>`:
  - **JWT access token** (primary, for the web UI) — signed with `JWT_SECRET`,
    verified statelessly by `jose`. Lifetime `JWT_ACCESS_TTL` (default `7d`).
  - **PAT** — `anpat_<base64url(32)>`, stored as sha256. For CLI/automation.
- **Backend interceptors** (`packages/server/src/plugins/auth.ts`):
  - `onRequest` (registered on the **root** instance, not inside a child plugin
    context — Fastify hooks added in `app.register()` only apply to that scope)
    resolves either channel into `req.user = { id, role } | null`.
  - `app.requireAuth` / `app.requireAdmin` are **per-route preHandlers**:
    `{ preHandler: [app.requireAdmin] }`. 401 when anonymous, 403 when non-admin.
- **Frontend interceptors** (`apps/web/src/guards.tsx`):
  - `<RequireAuth>` redirects to `/login` when unauthenticated.
  - `<RequireAdmin>` renders a 403 view for non-admins.
  - The SDK wrapper logs out on any 401 response (`withAuthGuard` in `auth.tsx`).
- **Registration switch:** `SystemSettings.allowRegistration` (default open) gates
  `POST /api/auth/register`. `POST /api/users` (admin) bypasses it. The first user
  to register becomes the bootstrap admin. Admin toggles via
  `PUT /api/settings/registration`.
- **Safety rails:** last-admin protection (no deleting/demoting the final admin,
  409 `LAST_ADMIN`) and no self-delete (409 `NO_SELF_DELETE`). Disabled users'
  tokens are rejected by a fresh user lookup on each protected request.
- **Global vs personal scoping** (future): resources/profiles/MCP servers carry
  `scope: 'global' | 'personal'` and `ownerId`. The role check above is the
  _instance-level_ gate; per-resource ownership checks layer on top when those
  modules land.

## Required environment

`JWT_SECRET` is **required** (≥16 chars) — the server refuses to boot without it.
For local dev: `JWT_SECRET="$(openssl rand -base64 48)"`. For an ephemeral run
without SQLite, also set `STORAGE_DRIVER=memory`.

## Current status & roadmap

Phase 1 is implemented: users, two roles, JWT + PAT auth, the registration
switch, front- and back-end interceptors, the SQLite driver (with migrations),
and the web auth UI. See `docs/roadmap.md` for what remains. Still NOT done: MCP
registry/aggregation, CLI install writers, ECC/Superpower adapters, the ACP
bridge, Channels, LLM-WIKI, memory/notes. When you add the first real logic for
a pillar, also add tests (vitest, not yet wired) and update the relevant
`docs/` file.

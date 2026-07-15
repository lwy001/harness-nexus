# MCP registry, proxy & profiles (Phase 2.2)

> Status: implemented in Phase 2.2. Covers live MCP aggregation (the
> `McpRegistry`), proxy re-exposure via Streamable HTTP + SSE, Profile CRUD, and
> PAT+routed access so Agent tools can call aggregated tools end-to-end.

## What 2.2 adds on top of 2.1

Phase 2.1 (see `docs/phase-2.md`) delivered the *configuration layer*: how to
describe upstream MCP connections and their credentials. 2.2 makes those
descriptions *live* — it dials the configured servers, aggregates their tools,
and re-exposes a single MCP server endpoint that Agent tools authenticate to
with a PAT and route through a profile.

| Piece                  | 2.1 (done)              | 2.2 (this doc)                              |
| ---------------------- | ----------------------- | ------------------------------------------- |
| `McpServer` rows       | CRUD + storage          | read by the registry, dialed live           |
| `${cred:NAME}` placeholders | stored verbatim     | resolved into real values at connect time    |
| `Profile`              | domain + port only      | CRUD + scope rules + entry validation        |
| `mountMcpProxy`        | stub (logs + returns)   | mounts `/mcp` + `/mcp/sse`                   |
| Agent-tool access      | —                       | PAT auth → `?profile=<id>` → aggregated tools |

## Architecture overview

```
 Agent tool ──PAT──▶ /mcp?profile=<id> ──▶ McpProxyHandler
                         │                        │
                         │                  resolve profile entries
                         │                        │
                         ▼                        ▼
                   /api/profiles          McpRegistry (live connections)
                   (CRUD, UI)                   │
                                               ▼ dialed once, pooled
                                   upstream MCP servers (SSE / Streamable HTTP)
                                   with ${cred:NAME} placeholders resolved into real values
```

The registry owns a pool of live `Client` connections (one per `proxied: true`
`McpServer`). The proxy handler is a thin transport layer: it authenticates the
PAT (via the existing root auth hook that sets `req.user`), resolves the
requested profile, asks the registry for the aggregated tool/resource/prompt
lists (filtered to that profile's entries), and forwards each `tools/call` to
the owning upstream client.

## Profile routing model

**Explicit profile selection.** An Agent tool connects with:

```
GET /mcp?profile=<profileId>   (Authorization: Bearer anpat_…)
```

The proxy exposes **only** the MCP servers listed in that profile's entries
(where `kind === 'mcp'`). Servers not in the profile are invisible. This gives
clean isolation and matches the "profile organizes available MCP" intent.

- A profile's entries reference MCP servers by `resourceId`. For 2.2 the
  `resourceId` is the `McpServer.id` directly (the richer `kind:key` indirection
  arrives with the Resource module in a later phase).
- The caller's PAT user must be able to see every MCP server the profile
  references (global, or personal-owned). A profile entry referencing an
  inaccessible server is rejected at connect time with
  `403 PROFILE_ENTRY_NOT_ACCESSIBLE`.
- Profiles are discoverable via `GET /api/profiles` (PAT-authenticated) so an
  Agent tool can enumerate which profiles it may connect through.

## McpRegistry (`packages/server/src/mcp/registry.ts`)

Holds live connections and aggregates capabilities. Key design:

- **Lazy connect, pooled.** On first use (or `reload()`), a `Client` is created
  for each `proxied: true` `McpServer`, connected via
  `StreamableHTTPClientTransport` or `SSEClientTransport` (per `transport.type`).
  Connections are kept in a `Map<serverId, LiveConnection>`. Only `proxy`-mode
  servers are pooled; `direct`-mode servers (including all stdio) are never
  dialed by AgentNexus.
- **Placeholder resolution.** Before connecting, `${cred:NAME}` placeholders in
  the transport's header values and URL are resolved: each name →
  `credentials.findByName(name)` → `decryptSecret(credential.secret, key)` →
  substituted into the string. Uses `resolvePlaceholders`
  (`@agent-nexus/shared`) with the same `credentialEncryptionKey` decorated on
  the Fastify instance (2.1).
- **Aggregation.** `listTools(filterServerIds?)` merges tools from all (or a
  filtered subset of) upstreams. To avoid name collisions across upstreams, each
  tool is **namespaced** as `<server-name>__<tool-name>` (double underscore).
  `callTool(namespacedName, args)` splits, routes to the owning client, and
  returns the result. The namespace is documented in the tool description so
  Agent tools see the origin.
- **Health & reconnect.** Each connection has a status: `connecting |
  connected | error | disconnected`. `listTools()` best-effort skips errored
  upstreams (logged, not fatal). The registry does NOT block startup on upstream
  availability — a missing/unreachable upstream simply yields fewer tools.
  `reload()` re-reads the config table and reconciles the pool (connect new,
  disconnect removed).
- **Lifecycle.** Built once in `mountMcpProxy` from `app.uow.mcpServers`. The
  `mcp-servers` REST handlers fire-and-forget call `registry.reload()` after any
  mutation so new connections take effect. `shutdown()` closes everything and is
  called on app close.

## Proxy transport (`packages/server/src/mcp/proxy.ts`)

Replaces the stub. Mounts two endpoints, both PAT-gated:

- **`POST/GET /mcp`** — Streamable HTTP. Uses `StreamableHTTPServerTransport`
  with a `sessionIdGenerator` for session support. The SDK's
  `handleRequest(req.raw, reply.raw)` is wired via `reply.hijack()` so Fastify
  doesn't send its own response. A per-session high-level `McpServer` (SDK class)
  is created with `registerTool` calls for each aggregated tool, forwarding to
  the registry.
- **`GET /mcp/sse` + `POST /mcp/sse/messages`** — SSE (legacy compat). Per
  session `SSEServerTransport`, mapped by `sessionId`. Same forwarding logic.

Auth is enforced in a `preHandler` on these routes: the root `onRequest` hook
already resolves the PAT into `req.user`; a preHandler requires `req.user` and a
valid `?profile=<id>` visible to that user. Missing/invalid → `401` /
`403 PROFILE_NOT_ACCESSIBLE`.

> The proxy reads `req.user` (set by the existing PAT auth hook) — no separate
> auth code. The profile id comes from `req.query.profile`.

## Profile CRUD (`packages/server/src/modules/profiles.ts`)

New REST module, scope rules identical to credentials/mcp-servers:

| Method | Path                | Auth           | Notes                                            |
| ------ | ------------------- | -------------- | ------------------------------------------------ |
| POST   | `/api/profiles`     | `requireAuth`† | create; admin required iff `scope === 'global'`  |
| GET    | `/api/profiles`     | `requireAuth`  | list caller's personal + all global              |
| GET    | `/api/profiles/:id` | `requireAuth`‡ | detail with resolved entries                     |
| PATCH  | `/api/profiles/:id` | `requireAuth`‡ | update name/description/entries                  |
| DELETE | `/api/profiles/:id` | `requireAuth`‡ | delete; owner-or-admin                           |

† global scope requires admin. ‡ ownership check: owner (personal) or admin.

Entry validation on create/update: each entry with `kind === 'mcp'` must
reference an existing `McpServer` the caller can see; otherwise
`409 ENTRY_TARGET_NOT_ACCESSIBLE`.

## MCP server status

A new `GET /api/mcp-servers/status` returns `{ id, status }[]` from the live
registry (`connecting | connected | error | disconnected`). It drives the
Dashboard `MeshTopology` dots, which now reflect real connection state
(`connected` → `bg-ok` accent), replacing the Phase 2.1 "all configured" state.

## Web UI

New page following the Signal design system (see AGENTS.md "Web UI design
system"):

- **Profiles** (`/profiles`, `RequireAuth`) — table of personal + global
  profiles, scope Badge, inline create form (name/description/scope + a
  checkbox group of the caller's visible MCP servers as entries). Add to
  `navItems()` so desktop + mobile nav stay in sync.

The Dashboard `MeshTopology` (`components/mesh-topology.tsx`) swaps its `Dot`
variant per real connection state — the geometry already supports it (see the
file's header comment).

## stdio

Still unsupported. The registry defensively skips any `stdio` server it
encounters (logs a warning). The proxy does not bridge stdio in 2.2 — the
"stdio bridge entry for local tools" from the roadmap remains deferred.

## Out of scope (deferred)

- **2.3 — callable-function scripts**: admin-authored JS wrapping vendor APIs
  as MCP tools, executed in a sandbox.
- Profile import/export (ECC/Superpower `imports` field) — the field exists in
  the domain but no adapter is wired.
- `kind:key` resource indirection in profile entries — 2.2 uses `McpServer.id`
  directly; the richer Resource module arrives later.
- Per-PAT profile binding (PAT carries its profile) — 2.2 uses query-param
  selection instead; PAT-profile binding is a future hardening option.
- Tool-level authorization (restricting which tools a given PAT may call) —
  2.2 exposes all tools in the selected profile.

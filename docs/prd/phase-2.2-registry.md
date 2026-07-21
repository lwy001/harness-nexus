# PRD: Phase 2.2 — MCP registry, proxy & profiles

> Status: implemented. Technical design: `docs/design/phase-2.2-registry.md`.

## Problem Statement

Phase 2.1 lets users _describe_ upstream MCP connections, but nothing actually
dials them. Each coding tool (Claude Code, ZCode, Hermes) still has to manage its
own MCP server list and repeat the same connection config across machines. There
is no way for an agent tool to connect to Harness Nexus and get an aggregated set of
tools from multiple upstreams in a single connection. Users also need a way to
organize which upstreams a given connection should expose — not every tool should
see every server.

## Solution

A live `McpRegistry` that pools connections to every proxied upstream, resolves
their `${cred:NAME}` placeholders into real values, and aggregates their tools
under namespaced keys. A proxy endpoint (`/mcp` Streamable HTTP + `/mcp/sse` SSE)
re-exposes the aggregated surface as a single MCP server that agent tools
authenticate to with a PAT. **Profiles** let users bundle a chosen set of MCP
servers; an agent tool connects with `?profile=<id>` and sees only that profile's
aggregated tools, giving clean isolation.

## User Stories

1. As an agent tool, I want to connect to one MCP endpoint and receive tools from multiple upstreams, so that I don't configure each server separately.
2. As an agent tool, I want to authenticate with a PAT, so that I can connect non-interactively.
3. As an agent tool, I want to choose a profile via a query parameter, so that I get only the tools I need.
4. As a user, I want to create a profile that bundles specific MCP servers, so that an agent tool gets exactly that set.
5. As a user, I want to create a personal profile, so that my bundles are private.
6. As an admin, I want to create a global profile, so that everyone can connect through a shared bundle.
7. As a non-admin, I want to be blocked from creating global profiles, so that shared bundles stay admin-controlled.
8. As a user, I want a profile rejected if it references an MCP server I can't see, so that I don't build a broken bundle.
9. As a user, I want to list profiles available to me, so that I know which ones my agent tool can use.
10. As a user, I want to see the live connection status of each upstream, so that I know whether a bundle will actually work.
11. As an operator, I want an unreachable upstream marked as errored and skipped, so that one bad server doesn't break the whole aggregate.
12. As an operator, I want the registry to reconnect when I change a connection's config, so that edits take effect without a restart.
13. As an operator, I want the registry to disconnect removed servers, so that stale connections don't linger.
14. As a developer, I want tool names namespaced by origin, so that same-named tools from different upstreams don't collide.
15. As an agent tool, I want Streamable HTTP supported, so that I can use the modern transport.
16. As an agent tool, I want SSE supported, so that older clients still work.
17. As a user, I want a connection without a profile rejected, so that I understand the profile is required.
18. As a user, I want a connection to an inaccessible profile rejected, so that I can't see another user's bundle.
19. As a user, I want the dashboard mesh to show real connection states, so that it's honest rather than decorative.
20. As a developer, I want the registry decoupled from the HTTP routes, so that the same registry can serve multiple transports.

## Implementation Decisions

- **`McpRegistry`** (`server/src/mcp/registry.ts`) owns a pool of SDK `Client`
  connections (one per `proxied: true` upstream). Lazy connect; `reload()`
  reconciles the pool on config change; `shutdown()` on app close. Decorated as
  `app.mcpRegistry`.
- **Aggregation is namespaced:** tools surface as `<server-name>__<tool-name>`;
  `callTool` splits the namespace and routes to the owning client.
- **`${cred:NAME}` placeholders resolved at connect time:** the registry decrypts
  each referenced credential (looked up by name) and substitutes the plaintext
  into the transport's header values and URL.
- **Best-effort:** an errored upstream is skipped, never fatal. `getStatuses()`
  returns `connecting | connected | error | disconnected`.
- **Proxy mounts** (`server/src/mcp/proxy.ts`): `/mcp` (Streamable HTTP, with
  session id) and `/mcp/sse` + `/mcp/sse/messages` (legacy SSE). Both PAT-gated
  via a `preHandler` (the root `onRequest` hook sets `req.user`) requiring a
  `?profile=<id>` visible to the caller. Raw Node streams handed to the SDK
  transport via `reply.hijack()`. Per-session `SdkMcpServer` forwards
  `tools/call`.
- **Explicit profile routing:** `/mcp?profile=<id>` exposes only the MCP servers
  in that profile's entries (`kind === 'mcp'`; `resourceId` = `McpServer.id` in
  2.2). Inaccessible profile entry → `403 PROFILE_ENTRY_NOT_ACCESSIBLE`.
- **Profile CRUD** (`server/src/modules/profiles.ts`): scope rules identical to
  credentials/mcp-servers. Entry validation rejects inaccessible MCP servers
  (`409 ENTRY_TARGET_NOT_ACCESSIBLE`).
- **Auto-reload:** the mcp-servers REST handlers call `registry.reload()`
  fire-and-forget after mutations. `GET /api/mcp-servers/status` returns live
  states (drives the dashboard mesh).
- **Name clash:** the SDK's `McpServer` class is imported as `SdkMcpServer`.
- **Migration:** SQLite v3 adds the `profiles` table.

## Testing Decisions

- HTTP smoke tests cover: profile CRUD, entry validation (bad reference → 409),
  scope permission denials, profile detail, the status endpoint, `/mcp` without
  a profile (400), `/mcp` without auth (401), profile delete.
- Tests assert status codes and shapes (external behavior) against a
  memory-driver server.

## Out of Scope

- callable-function scripts (Phase 2.3).
- The stdio bridge entry for local tools.
- `kind:key` resource indirection in profile entries (2.2 uses `McpServer.id`).
- Per-PAT profile binding (2.2 uses query-param selection).
- Tool-level authorization (2.2 exposes all tools in the selected profile).
- Profile import/export (ECC/Superpower `imports` field).

## Further Notes

- Agent tools connect via `GET /api/profiles` (PAT-authenticated) to discover
  profiles, then `/mcp?profile=<id>` to use one.
- Full technical design (registry internals, proxy wiring, profile routing,
  API table) lives in `docs/design/phase-2.2-registry.md`.

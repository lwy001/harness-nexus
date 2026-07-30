# PRD: Phase 2.4 — proxy MCP connect & tool inspection

> Status: design approved, implementation in progress.
> Technical design: `docs/design/phase-2.4-connect-tools.md`.
> Builds on Phase 2.2 (`McpRegistry` pool, `listTools()`, `/api/mcp-servers/status`).

## Problem Statement

Phase 2.2 made Harness Nexus dial proxy-mode MCP servers and aggregate their
tools, but the management UI gives the operator no handle on the live
connection. The MCP Management page lists servers as static rows (name / mode /
transport / scope) with only a Delete action — there is **no connection status,
no way to connect/reconnect a flapping upstream, and no way to see what tools a
server actually exposes**. The only place connection state surfaces today is the
Dashboard mesh, as a small dot.

When a proxy server is `error` (bad credential, upstream down, transport
mismatch), the operator's only recourse is to edit the config and hope the
fire-and-forget `reload()` reconnects — they cannot verify the fix or inspect
whether the upstream even offers the expected tools without pointing a separate
MCP client at it.

## Solution

Add **per-server connect control + tool inspection** to the MCP Management
page, layered on the existing registry pool (no new storage, no migration):

1. **A Status column** shows live `connecting | connected | error | disconnected`
   per proxy row, kept fresh by a polling interval. Color encodes state only
   (Signal system rule); direct rows show a neutral "dialed by the tool" hint.
2. **A Connect button** on proxy rows that explicitly (re)dials the upstream —
   the primary value is forcing a reconnect after fixing a broken `error` server,
   since startup `reload()` is fire-and-forget. A matching **Disconnect** button
   drops a live connection on demand.
3. **A tool-count badge** (`N tools`) on connected rows, sourced from the cached
   tool list so it costs no extra request.
4. **An expandable row** that lists the upstream's actual tools with each tool's
   description and `inputSchema` parameters, plus a **Refresh** button to pull a
   fresh tool list on demand.

The connect semantics are **incremental, not lazy**: startup auto-connect
(Phase 2.2) stays as-is and `/mcp` aggregation is untouched. Connect/Disconnect
are an operator control surface on top of the existing pool, not a replacement
for auto-pooling.

## User Stories

1. As an operator, I want each proxy row to show its live connection status, so
   that I can see at a glance which upstreams are actually up.
2. As an operator, I want a Connect button, so that I can force a reconnect after
   fixing a broken (error) upstream without waiting for the next config change.
3. As an operator, I want a Disconnect button, so that I can take a live upstream
   offline on demand without deleting it.
4. As an operator, I want the row to expand and list the tools the upstream
   exposes, so that I can verify it offers what I expect before building a profile.
5. As an operator, I want each tool's description and input parameters shown, so
   that I understand what a tool does without reading the upstream's docs.
6. As an operator, I want a Refresh button on the tool list, so that I can pick up
   tools the upstream added after the connection was established.
7. As an operator, I want a tool-count badge on connected rows, so that I can scan
   the table for servers exposing zero tools (likely misconfigured).
8. As an operator, I want status to stay fresh, so that I notice when a connection
   drops or recovers without reloading the page.
9. As an operator, I want direct-mode rows to show no connect controls, so that
   the UI doesn't imply Harness Nexus can dial a server it never dials.
10. As a non-owner, I want connect/disconnect/tool actions on a personal server I
    don't own to be refused, so that scope isolation is preserved.
11. As an operator, I want a not-found server's existence hidden, so that I can't
    probe for other users' server ids.

## Implementation Decisions

- **Incremental connect semantics.** `McpRegistry`'s startup `reload()`
  auto-pooling is untouched. New `connectServer(id)` / `disconnectServer(id)`
  public methods add operator control on top; they do not replace auto-pooling
  and do not change `/mcp` aggregation behavior.
- **New registry methods** (`server/src/mcp/registry.ts`):
  `connectServer(id)`, `disconnectServer(id)`, `listServerTools(id)`,
  `refreshServerTools(id)`. The first two reuse existing `connectOne()` /
  `closeConnection()` internals; the last two read/refresh the per-connection
  tool cache. `listServerTools` returns **original** (un-namespaced) tool names
  — the UI shows a single server's tools, where the `<server>__` prefix is noise.
- **Status endpoint gains `toolCount`.** `GET /api/mcp-servers/status` already
  returns per-server status; it is extended to also return each connection's
  `tools.size` so the count badge needs no second request.
- **Four new routes** (`server/src/modules/mcp-servers.ts`):
  `POST /api/mcp-servers/:id/connect` · `POST /:id/disconnect` ·
  `GET /:id/tools` · `POST /:id/tools/refresh`. All reuse the existing
  `requireAuth` guard and `ownsOrAdmin` 404-not-found leak prevention. proxy-only
  (direct → `409 NOT_PROXY_MODE`).
- **`McpToolInfo` type** in `packages/shared` (not `core` — tool inspection is a
  runtime shape, not a persisted domain entity): `{ name, description?, inputSchema }`.
- **Tool list is cached at connect time** (already the case via `refreshTools`)
  and exposed read-only via `GET :id/tools`; the Refresh button hits the explicit
  `POST :id/tools/refresh` to re-pull from the upstream.
- **Web polling.** The page starts a `setInterval` (default 5s) to refresh
  statuses after the initial load; cleared on unmount. No WebSocket — consistent
  with the rest of the app, which is request-based.
- **UI component** uses `radix-ui`'s `Collapsible` primitive (already an installed
  dependency) for the expandable tool panel, via a thin shadcn-style wrapper.

## Testing Decisions

- Extend `scripts/smoke.mjs` to cover the four new endpoints against a
  memory-driver server: connect → status flips → tools non-empty → refresh →
  disconnect → status flips. Plus the permission/scope denials (direct-mode 409,
  not-owner 404-leak-prevention, not-found 404).
- Tests assert HTTP status codes and response shapes (external behavior), matching
  the existing smoke-test style.
- vitest is not yet wired; when it is, registry unit tests for
  `connectServer`/`disconnectServer`/`listServerTools` should follow.

## Out of Scope

- **Lazy/on-demand connect model** — proxy servers still auto-pool at startup;
  this phase only adds an operator control surface. (Ruled out in design to avoid
  changing `/mcp` aggregation semantics and `doReload`.)
- **Tool-level authorization** (restricting which tools a PAT may call) — a
  separate deferred item from Phase 2.2; unrelated to inspecting the tool list.
- **Tool invocation / test-run** from the UI — this phase only _inspects_ tool
  metadata (name/description/schema); it does not call tools.
- **direct-mode connect controls** — Harness Nexus never dials a direct server;
  direct rows show a neutral hint and no connect/expand controls.
- **Real-time push (WebSocket/SSE) for status** — polling is sufficient and
  matches the rest of the app.
- **Connection metrics / latency history** — out of scope; status + detail string
  is enough to diagnose.

## Further Notes

- No database migration: connection state and tool caches live entirely in the
  in-memory registry pool (`LiveConnection`).
- Full technical design (method signatures, route table, status→color mapping,
  polling lifecycle, component structure) lives in
  `docs/design/phase-2.4-connect-tools.md`.

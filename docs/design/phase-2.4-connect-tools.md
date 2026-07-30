# Design: Phase 2.4 — proxy MCP connect & tool inspection

> Status: design approved, implementation in progress.
> PRD: `docs/prd/phase-2.4-connect-tools.md`.
> Builds on Phase 2.2 (`McpRegistry` pool, `listTools()`, `/api/mcp-servers/status`).

The operator-facing control surface for proxy-mode MCP connections. Phase 2.2
already pools proxy upstreams, auto-connects them on startup/config-change, and
exposes a read-only `GET /api/mcp-servers/status`. This phase adds **explicit
per-server connect/disconnect** and **tool-list inspection** on top of that pool
— no storage change, no migration, no change to `/mcp` aggregation.

The guiding rule: **incremental, not lazy.** Startup auto-pooling stays exactly
as Phase 2.2 left it. Connect/Disconnect are an operator control surface for
forcing reconnects (e.g. after fixing a broken credential) and inspecting what
an upstream actually offers — they never gate whether `/mcp` aggregates a server.

## Architecture

```
McpRegistry pool (Phase 2.2, unchanged at startup)
  │
  │  + new public methods (read/act on the existing pool):
  │    connectServer(id)       → close+reconnect one entry; returns status
  │    disconnectServer(id)    → closeConnection but KEEP pool entry (disconnected)
  │    listServerTools(id)     → read conn.tools (original names, no <server>__ prefix)
  │    refreshServerTools(id)  → refreshTools(conn) then read
  ▼
GET  /api/mcp-servers/status      (extended: + toolCount per entry)
POST /api/mcp-servers/:id/connect
POST /api/mcp-servers/:id/disconnect
GET  /api/mcp-servers/:id/tools
POST /api/mcp-servers/:id/tools/refresh
  ▼
sdk-ts: connectMcpServer / disconnectMcpServer / listMcpServerTools / refreshMcpServerTools
  ▼
McpManagement.tsx
  - polling hook (setInterval 5s) keeps statuses fresh
  - per-row: status badge (color = state) + toolCount badge + Connect/Disconnect
  - Collapsible tool panel: name + description + inputSchema params + Refresh
```

## Layer 1 — shared: `McpToolInfo`

`McpToolInfo` lives in `packages/shared` (NOT `core`). Tool inspection is a
runtime/transient shape read out of the registry pool, not a persisted domain
entity — `core` must stay pure (no I/O, no framework imports), and this type
crosses the server↔sdk↔web boundary via `shared`, which is the single source of
truth for shapes that all three validate/serialize against.

```ts
// packages/shared/src/<mcp module>.ts
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
```

Shape-aligned with the registry's existing `AggregatedTool` (same fields), but
**semantically distinct**: `AggregatedTool` is the internal namespaced form the
proxy uses; `McpToolInfo` is the un-namespaced, externally-exposed form for a
single server's tools. Re-export from `packages/shared/src/index.ts`.

## Layer 2 — server registry: 4 public methods

All in `packages/server/src/mcp/registry.ts`. They expose the existing pool
internals through a narrow, well-named surface. The existing private
`connectOne()` / `closeConnection()` / `refreshTools()` become the
implementation; new public methods add the validation + return shaping.

### `McpServerStatus` gains `toolCount`

```ts
export interface McpServerStatus {
  id: string;
  name: string;
  status: ConnectionStatus;
  detail?: string;
  toolCount: number; // NEW — conn.tools.size (0 when not connected)
}
```

`getStatuses()` is updated to read `c.tools.size`. Existing Dashboard consumer
ignores the extra field (additive), so no web break.

### `connectServer(id): Promise<McpServerStatus>`

Force (re)connect of one proxy upstream. The key use case: a row is stuck at
`error` after the operator fixed the credential; this re-dials it.

```ts
async connectServer(id: string): Promise<McpServerStatus> {
  const conn = this.pool.get(id);
  if (conn) {
    // Idempotent reconnect: close the stale/duplicate entry first so we don't
    // leak a Client. (reload()'s sameServer check can't see this path.)
    await this.closeConnection(conn);
    this.pool.delete(id);
  }
  // connectOne reads fresh config from uow — but it takes a McpServer object,
  // not an id. Re-fetch the server config so a config change since startup is
  // honored. Throws if the server was deleted or switched to direct.
  const server = await this.uow.mcpServers.findById(id);
  if (!server) throw new NotFoundError(id);
  if (server.mode !== 'proxy') throw new NotProxyError(server);
  await this.connectOne(server); // existing private method, non-throwing internally
  return this.statusOf(id)!; // connectOne always inserts a pool entry
}
```

**Why re-fetch config:** `connectOne` takes a `McpServer` object. The registry
pool may hold a stale snapshot if the operator edited config between reloads.
Re-reading from `uow.mcpServers.findById(id)` ensures the latest transport /
credential placeholders are honored — and naturally produces the right error if
the server was deleted or switched to `direct` (no proxy re-dial).

**Error model:** `connectOne` is best-effort (catches internally, sets
`status='error'` + `detail`). So `connectServer` resolves with the resulting
status object even on failure — the operator sees `error` + `detail` rather than
a thrown 500. The route does NOT need to translate connect failures; it returns
the status object. `NotFound`/`NotProxy` are the only throws (config-level),
translated by the route to 404/409.

> Note: registry currently throws plain `Error`. To attach clean status codes
> (404/409) without coupling the registry to `AppError`, the new methods throw
> registry-local error subclasses (`RegistryNotFound`, `RegistryNotProxy`) and
> the route maps them to `AppError`. This keeps the registry free of HTTP
> concerns (per AGENTS.md architecture rule #4: "Decoupled from transport").
> Alternatively, throw `AppError` directly from the registry since the existing
> `profileEntriesFor` already throws plain Errors that aren't HTTP-mapped — but
> the subclass approach is cleaner. **Decision: registry-local subclasses,
> mapped in the route.**

### `disconnectServer(id): Promise<McpServerStatus>`

```ts
async disconnectServer(id: string): Promise<McpServerStatus> {
  const conn = this.pool.get(id);
  if (!conn) throw new NotFoundError(id);
  await this.closeConnection(conn); // sets status='disconnected', does NOT delete
  return this.statusOf(id)!;
}
```

**Critical: do NOT `this.pool.delete(id)`.** Deleting the entry would make the
row vanish from `getStatuses()` (the Dashboard mesh and the table's status column
read from there), and more importantly `doReload()` only reconciles entries it
sees vs. configured — a deleted-but-configured entry gets re-added (re-connected)
on the next unrelated mutation's `reload()`, silently undoing the disconnect.
Keeping the entry with `status='disconnected'` is the honest state: the server is
configured and pooled, just not currently connected. `doReload`'s
`sameServer` check treats it as unchanged and leaves it alone.

### `listServerTools(id): McpToolInfo[]`

Read-only snapshot of the cached tool list (original names, no namespace prefix):

```ts
listServerTools(id: string): McpToolInfo[] {
  const conn = this.pool.get(id);
  if (!conn) throw new NotFoundError(id);
  // Unconnected → empty array, NOT an error. The route returns []; the UI gates
  // the tool panel on status==='connected' so this is defense-in-depth.
  if (conn.status !== 'connected') return [];
  return [...conn.tools.values()].map((t) => ({
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    inputSchema: t.inputSchema,
  }));
}
```

This is **distinct from the existing `listTools(filterServerIds?)`**: that one
returns the _namespaced_ aggregated form for the proxy; this returns the
_un-namespaced_ per-server form for the UI. Both read the same underlying cache.

### `refreshServerTools(id): Promise<McpToolInfo[]>`

```ts
async refreshServerTools(id: string): Promise<McpToolInfo[]> {
  const conn = this.pool.get(id);
  if (!conn) throw new NotFoundError(id);
  if (conn.status !== 'connected') throw new NotConnectedError(id);
  await this.refreshTools(conn); // existing private: re-listTools, may set error
  return this.listServerTools(id);
}
```

`refreshTools` is best-effort (on failure sets `status='error'` + `detail`), so
the returned list may be empty with the connection now errored — the operator
sees the status flip. No throw on upstream failure; only config-level throws.

### Registry error subclasses + helpers

```ts
// registry-local, mapped by the route to HTTP — keeps registry HTTP-free
export class RegistryError extends Error {
  constructor(message: string, readonly kind: 'not_found' | 'not_proxy' | 'not_connected') {
    super(message);
    this.name = 'RegistryError';
  }
}

// internal: build one status entry (for the single-server return shape)
private statusOf(id: string): McpServerStatus | undefined { /* find in pool */ }
```

## Layer 3 — server routes

`packages/server/src/modules/mcp-servers.ts`. All four reuse the existing
`guard = { preHandler: [app.requireAuth] }` and the `ownsOrAdmin` pattern. The
owner check uses the **stored server record** (read before the registry call),
not the pool entry — so a not-found or not-owned server returns `404
MCP_SERVER_NOT_FOUND` before touching the registry (leak prevention, identical to
PATCH/DELETE).

| Method | Path                                 | Body | Returns                       | Errors                                              |
| ------ | ------------------------------------ | ---- | ----------------------------- | --------------------------------------------------- |
| POST   | `/api/mcp-servers/:id/connect`       | —    | `{ status: McpServerStatus }` | 404 not-found/not-owned; 409 `NOT_PROXY_MODE`       |
| POST   | `/api/mcp-servers/:id/disconnect`    | —    | `{ status: McpServerStatus }` | 404; (not-in-pool → treat as 404, no separate code) |
| GET    | `/api/mcp-servers/:id/tools`         | —    | `{ tools: McpToolInfo[] }`    | 404; (not connected → `[]`, not an error)           |
| POST   | `/api/mcp-servers/:id/tools/refresh` | —    | `{ tools: McpToolInfo[] }`    | 404; 409 `NOT_CONNECTED`                            |

```ts
// connect route — shape of all four (owner check first, then registry, map errors)
app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/connect', guard, async (req, reply) => {
  await assertProxyOwned(req); // 404 if missing/not-owned, 409 NOT_PROXY_MODE if direct
  try {
    const status = await app.mcpRegistry!.connectServer(req.params.id);
    return { status };
  } catch (e) {
    throw mapRegistryError(e); // RegistryError → AppError (404/409)
  }
});
```

`assertProxyOwned` reads the record via `uow.mcpServers.findById`, applies
`ownsOrAdmin` (404 on miss to avoid leaking existence), and rejects `mode !== 'proxy'`
with `409 NOT_PROXY_MODE`. A shared helper since all four routes need it (except
connect needs the proxy check; tools/refresh can rely on the pool — but routing
all four through the same owned-proxy assert keeps it consistent and avoids
leaking a direct server's existence via the tools endpoint too).

**`GET /api/mcp-servers/status`** (existing) is extended only in _return shape_ —
each entry gains `toolCount`. No new route.

## Layer 4 — sdk-ts

`packages/sdk-ts/src/index.ts`:

```ts
export interface McpServerStatus {
  id: string;
  name: string;
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  detail?: string;
  toolCount?: number; // NEW — absent on older servers; treat 0/undefined as "unknown"
}

// re-export from shared (already the pattern for other shared types)
export type { McpToolInfo } from '@harness-nexus/shared';

// four methods, same request() pattern as existing
async connectMcpServer(id: string): Promise<{ status: McpServerStatus }> {
  return this.request('POST', `/api/mcp-servers/${id}/connect`);
}
async disconnectMcpServer(id: string): Promise<{ status: McpServerStatus }> {
  return this.request('POST', `/api/mcp-servers/${id}/disconnect`);
}
async listMcpServerTools(id: string): Promise<McpToolInfo[]> {
  const res = await this.request('GET', `/api/mcp-servers/${id}/tools`);
  return res.tools;
}
async refreshMcpServerTools(id: string): Promise<McpToolInfo[]> {
  const res = await this.request('POST', `/api/mcp-servers/${id}/tools/refresh`);
  return res.tools;
}
```

## Layer 5 — web (`McpManagement.tsx`)

### 5a. Polling lifecycle

```ts
// module-scope constant
const STATUS_POLL_MS = 5000;

// in McpManagementPage
const [statuses, setStatuses] = useState<Map<string, McpServerStatus>>(new Map());

// mount: load servers + statuses together
useEffect(() => {
  void (async () => {
    const [servers, statusRes] = await Promise.all([
      withAuthGuard(() => api.listMcpServers(), logout),
      withAuthGuard(() => api.listMcpServerStatuses(), logout),
    ]);
    setItems(servers);
    setStatuses(new Map(statusRes.statuses.map((s) => [s.id, s])));
  })();
  // poll loop — statuses only (servers change via refresh())
  const timer = setInterval(() => {
    api
      .listMcpServerStatuses()
      .then((r) => setStatuses(new Map(r.statuses.map((s) => [s.id, s]))))
      .catch(() => {}); // swallow poll errors; next tick retries
  }, STATUS_POLL_MS);
  return () => clearInterval(timer);
}, [logout]);
```

`statuses` keyed by `id` for O(1) row lookup. Poll errors are swallowed (a failed
poll shouldn't toast; the next interval retries). The cleanup function clears the
interval on unmount.

### 5b. Status → color mapping (Signal system)

Color **encodes connection state only** (AGENTS.md "Signal"). `--signal` (cyan)
is reserved for liveness/links and is NOT used here. Map to the semantic palette:

| status         | color token      | meaning   |
| -------------- | ---------------- | --------- |
| `connected`    | `--ok` (green)   | live      |
| `error`        | `--danger` (red) | failed    |
| `connecting`   | `--warn` (amber) | transient |
| `disconnected` | muted (neutral)  | idle      |

Rendered as a `<Dot>` + label. The `Dot` uses the token class (`bg-ok` /
`bg-danger` / `bg-warn` / `bg-muted-foreground`), matching the Dashboard
`MeshTopology`'s existing `dotVariantFor` approach. The Badge wrapper stays a
neutral variant (`secondary`) — color comes from the dot, not the badge fill, so
we don't spend `--signal` or introduce a second decorative accent.

**direct rows** show a neutral Badge (`outline`, no dot): "dialed by the tool".

### 5c. Per-row actions

- **proxy row, not connected/connecting**: Connect button (outline, small).
  Clicking sets local "pending" state for that id (disables the button + shows a
  spinner), calls `connectMcpServer(id)`, then lets the poll pick up the new
  status (don't optimistically flip to connected — the upstream might fail).
- **proxy row, connected**: Disconnect item in the existing row `DropdownMenu`
  (alongside Delete), and the row becomes expandable.
- **proxy row, connecting**: Connect button disabled + spinner. Poll continues.
- **direct row**: no connect/expand controls; neutral status hint only.

### 5d. Tool inspection panel (Collapsible)

Wrap `radix-ui`'s `Collapsible` in a thin shadcn-style wrapper at
`apps/web/src/components/ui/collapsible.tsx` (matches the existing
`components/ui/dialog.tsx` convention; `radix-ui` is already a dependency).

```tsx
// apps/web/src/components/ui/collapsible.tsx
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';
export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleTrigger = CollapsiblePrimitive.Trigger;
export const CollapsibleContent = CollapsiblePrimitive.Content;
```

**Trigger** = the row's Name cell (when connected): name + a `ChevronRight`
(`rotate-90` when open). **Content** = `ToolList` (module-scope sub-component):

- On open, if no cached tools for this id, fetch `listMcpServerTools(id)` (lazy).
  If the server has been connected for a while, tools are already cached
  server-side; this is one cheap GET.
- Header row: "Tools (N)" + a Refresh button (`RefreshCw` icon; rotates while
  fetching via `animate-spin`). Refresh calls `refreshMcpServerTools(id)`.
- Each tool: `name` (mono) + `description` (muted) + a nested expandable for
  `inputSchema` parameters (property name, type, required flag). Reuse the same
  Collapsible primitive for the per-tool detail, or a simpler `<details>`-style
  toggle — keep it light.
- Empty tool list: muted "No tools exposed by this server".
- Per-tool state lives in a module-scope sub-component `ToolList({ serverId })`
  (defined at module scope, never inline — per the React perf rule).

### 5e. React perf (per vercel-react best practices)

- Sub-components (`StatusBadge`, `ConnectButton`, `ToolList`, `ToolRow`) defined
  at **module scope**, not inside `McpManagementPage`.
- Static config (the status→token map) hoisted to a module-scope `const`.
- Conditional rendering uses ternaries, not `&&`.
- Functional `setState` (`setStatuses((prev) => ...)`).
- The polling `setInterval` callback doesn't capture stale state (it only
  overwrites `statuses`, doesn't read it).

## Verification

- `pnpm -r typecheck`
- `pnpm --filter @harness-nexus/server build` · `@harness-nexus/sdk-ts` · `@harness-nexus/web`
- Extend `scripts/smoke.mjs`: register admin → create proxy server →
  `POST /:id/connect` → assert `status.status` in `{connected,error}` and
  `toolCount` present → `GET /:id/tools` → `POST /:id/tools/refresh` →
  `POST /:id/disconnect` → assert `disconnected`. Plus negative: create direct
  server → `POST /:id/connect` → 409 `NOT_PROXY_MODE`; not-owner → 404.

## Out of scope

(See PRD §Out of Scope.) Lazy connect model, tool-level authorization, tool
invocation, direct-mode controls, real-time push, connection metrics.

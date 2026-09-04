import type { FastifyInstance } from 'fastify';
import type { McpServer, DialSite, McpTransport } from '@harness-nexus/core';
import {
  AppError,
  createMcpServerSchema,
  requiresClient,
  resolveDialSite,
  transportPlaceholderNames,
  updateMcpServerSchema,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
  type McpToolInfo,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { RegistryError } from '../mcp/registry.js';

/**
 * MCP management — records of MCP servers, each with a `dialSite` (Phase 8
 * C2, replacing the 3.1 proxy/direct `mode`):
 *   server — the platform dials the upstream and serves it via the `/mcp`
 *            outlet (the only home for non-distributable credentials, and for
 *            upstreams only the platform's network reaches). Pooled.
 *   client — the `hnx mcp serve` shim dials it on the user's machine
 *            (stdio / SSE / HTTP; localhost + LAN reachable). Requires every
 *            referenced credential to be distributable.
 *   auto   — derived: client iff all referenced credentials are distributable
 *            (or none), else server. See `shared/dial-site.ts`.
 * stdio can only be dialed client-side — the platform never spawns processes
 * on the user's machine — enforced as 409 STDIO_REQUIRES_CLIENT here.
 *
 * Scope rules (see docs/design/phase-2.1-credentials.md) are identical to credentials:
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 */
export async function mcpServersRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/mcp-servers ----
  app.post('/api/mcp-servers', guard, async (req, reply) => {
    const input = createMcpServerSchema.parse(req.body) as CreateMcpServerInput;

    if (input.scope === 'global' && req.user!.role !== 'admin') {
      throw new AppError('Only admins can create global MCP servers', 403, 'FORBIDDEN');
    }
    // zod-inferred transport carries `| undefined` on optional fields; the domain
    // McpTransport does not (exactOptionalPropertyTypes). The shapes are identical
    // at runtime, so cast at this validated boundary.
    const transport = input.transport as McpTransport;
    await assertDialSite(transport, input.dialSite, app);

    const now = new Date().toISOString();
    const server: McpServer = {
      id: generateId(),
      name: input.name,
      transport,
      dialSite: input.dialSite,
      scope: input.scope,
      ownerId: input.scope === 'global' ? null : req.user!.id,
      createdAt: now,
      updatedAt: now,
    };
    await app.uow.mcpServers.save(server);
    void app.mcpRegistry?.reload();
    return reply.code(201).send({ mcpServer: server });
  });

  // ---- GET /api/mcp-servers ----
  app.get('/api/mcp-servers', guard, async (req) => {
    const [personal, global] = await Promise.all([
      app.uow.mcpServers.list({ scope: 'personal', ownerId: req.user!.id }),
      app.uow.mcpServers.list({ scope: 'global' }),
    ]);
    return { mcpServers: [...personal, ...global] };
  });

  // ---- GET /api/mcp-servers/status ----
  // Live connection states from the registry. Drives the Dashboard mesh dots
  // and the per-row status/tool-count badges (Phase 2.4).
  app.get('/api/mcp-servers/status', guard, async () => {
    return { statuses: app.mcpRegistry?.getStatuses() ?? [] };
  });

  // ---- Phase 2.4: per-server connect/disconnect + tool inspection ----
  // Operator control surface on top of the registry pool. proxy-only — a direct
  // server is never dialed by Harness Nexus, so these endpoints reject it with
  // 409 NOT_PROXY_MODE. Owner-or-admin check (404 on miss, leak prevention)
  // mirrors PATCH/DELETE.

  // POST /api/mcp-servers/:id/connect — force (re)connect one proxy upstream.
  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/connect', guard, async (req) => {
    await assertServerDialedOwned(req.params.id, req.user!.id, req.user!.role, app);
    try {
      const status = await app.mcpRegistry!.connectServer(req.params.id);
      return { status };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // POST /api/mcp-servers/:id/disconnect — drop a live connection on demand.
  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/disconnect', guard, async (req) => {
    await assertServerDialedOwned(req.params.id, req.user!.id, req.user!.role, app);
    try {
      const status = await app.mcpRegistry!.disconnectServer(req.params.id);
      return { status };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // GET /api/mcp-servers/:id/tools — cached tool list (original names).
  // Not connected → [] (not an error); the UI gates the panel on status.
  app.get<{ Params: { id: string } }>('/api/mcp-servers/:id/tools', guard, async (req) => {
    await assertServerDialedOwned(req.params.id, req.user!.id, req.user!.role, app);
    try {
      const tools = app.mcpRegistry!.listServerTools(req.params.id);
      return { tools };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // POST /api/mcp-servers/:id/tools/refresh — re-pull tools from the upstream.
  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/tools/refresh', guard, async (req) => {
    await assertServerDialedOwned(req.params.id, req.user!.id, req.user!.role, app);
    try {
      const tools: McpToolInfo[] = await app.mcpRegistry!.refreshServerTools(req.params.id);
      return { tools };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // ---- PATCH /api/mcp-servers/:id ----
  app.patch<{ Params: { id: string } }>('/api/mcp-servers/:id', guard, async (req) => {
    const input = updateMcpServerSchema.parse(req.body) as UpdateMcpServerInput;
    const existing = await app.uow.mcpServers.findById(req.params.id);
    if (!existing || !ownsOrAdmin(existing, req.user!.id, req.user!.role)) {
      throw new AppError('MCP server not found', 404, 'MCP_SERVER_NOT_FOUND');
    }

    const transport = (input.transport ?? existing.transport) as McpTransport;
    const dialSite: DialSite = input.dialSite ?? existing.dialSite;
    await assertDialSite(transport, dialSite, app);

    const next: McpServer = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.transport !== undefined ? { transport } : {}),
      ...(input.dialSite !== undefined ? { dialSite } : {}),
      updatedAt: new Date().toISOString(),
    };
    await app.uow.mcpServers.save(next);
    void app.mcpRegistry?.reload();
    return { mcpServer: next };
  });

  // ---- DELETE /api/mcp-servers/:id ----
  app.delete<{ Params: { id: string } }>('/api/mcp-servers/:id', guard, async (req) => {
    const existing = await app.uow.mcpServers.findById(req.params.id);
    if (!existing || !ownsOrAdmin(existing, req.user!.id, req.user!.role)) {
      throw new AppError('MCP server not found', 404, 'MCP_SERVER_NOT_FOUND');
    }
    await app.uow.mcpServers.delete(existing.id);
    void app.mcpRegistry?.reload();
    return { ok: true };
  });
}

/**
 * Enforce the dial-site rules at create/update (Phase 8 C2):
 *   1. stdio can only be dialed client-side — the platform never spawns a
 *      process on the user's machine. A stdio transport that would resolve to
 *      `server` (explicit override, or auto + non-distributable credential)
 *      is rejected with 409 STDIO_REQUIRES_CLIENT.
 *   2. An explicit `client` dial site must not reference a stored,
 *      non-distributable credential — the server would have to ship a secret
 *      it must not ship (409 CREDENTIAL_NOT_DISTRIBUTABLE). `auto` handles the
 *      same situation by silently routing to `server`; that is the derived
 *      default doing its job. Credentials not created yet are not checked
 *      (same as 2.1: a missing credential surfaces as a dial failure later).
 */
async function assertDialSite(
  transport: McpTransport,
  dialSite: DialSite,
  app: FastifyInstance,
): Promise<void> {
  const distributable = new Map<string, boolean>();
  for (const cred of await app.uow.credentials.list()) {
    if (!distributable.has(cred.name)) distributable.set(cred.name, cred.distributable);
  }
  const isDistributable = (name: string): boolean => distributable.get(name) === true;

  const resolved = resolveDialSite({ dialSite, transport }, isDistributable);
  if (requiresClient(transport) && resolved === 'server') {
    throw new AppError(
      'stdio upstreams can only be dialed by the client (mark the referenced credential distributable or use dialSite "client")',
      409,
      'STDIO_REQUIRES_CLIENT',
    );
  }
  if (dialSite === 'client') {
    const referenced = transportPlaceholderNames(transport).filter((n) => distributable.has(n));
    const offender = referenced.find((n) => !isDistributable(n));
    if (offender !== undefined) {
      throw new AppError(
        `dialSite "client" requires credential "${offender}" to be distributable (its plaintext would have to leave the server)`,
        409,
        'CREDENTIAL_NOT_DISTRIBUTABLE',
      );
    }
  }
}

/** A record is actionable by the caller iff they own it (personal) or are admin. */
function ownsOrAdmin(s: McpServer, userId: string, role: 'admin' | 'user'): boolean {
  return role === 'admin' || s.ownerId === userId;
}

/**
 * Phase 2.4 — guard for the connect/disconnect/tools routes. Reads the stored
 * record (NOT the pool entry) and applies owner-or-admin + dial-site checks
 * BEFORE touching the registry: a not-found/not-owned server returns 404
 * MCP_SERVER_NOT_FOUND (leak prevention, identical to PATCH/DELETE), and a
 * client-dialed server returns 409 NOT_SERVER_DIALED (the platform never
 * dials it — that is the shim's job).
 */
async function assertServerDialedOwned(
  id: string,
  userId: string,
  role: 'admin' | 'user',
  app: FastifyInstance,
): Promise<void> {
  const existing = await app.uow.mcpServers.findById(id);
  if (!existing || !ownsOrAdmin(existing, userId, role)) {
    throw new AppError('MCP server not found', 404, 'MCP_SERVER_NOT_FOUND');
  }
  const distributable = new Map<string, boolean>();
  for (const cred of await app.uow.credentials.list()) {
    if (!distributable.has(cred.name)) distributable.set(cred.name, cred.distributable);
  }
  const site = resolveDialSite(existing, (name) => distributable.get(name) === true);
  if (site !== 'server') {
    throw new AppError(
      `MCP server "${existing.name}" is dialed by the client, not the platform (dial site: ${site})`,
      409,
      'NOT_SERVER_DIALED',
    );
  }
}

/**
 * Map a registry `RegistryError` to an `AppError` with the right status code.
 * Rethrows non-registry errors untouched. Keeps the HTTP layer in the route and
 * the registry free of HTTP concerns (AGENTS.md architecture rule #4).
 */
function mapRegistryError(err: unknown): never {
  if (err instanceof RegistryError) {
    const status = err.kind === 'not_dialable' ? 409 : err.kind === 'not_connected' ? 409 : 404;
    const code =
      err.kind === 'not_dialable'
        ? 'NOT_SERVER_DIALED'
        : err.kind === 'not_connected'
          ? 'NOT_CONNECTED'
          : 'MCP_SERVER_NOT_FOUND';
    throw new AppError(err.message, status, code);
  }
  throw err;
}

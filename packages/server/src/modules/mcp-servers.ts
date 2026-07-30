import type { FastifyInstance } from 'fastify';
import type { McpServer, McpMode, McpTransport } from '@harness-nexus/core';
import {
  AppError,
  createMcpServerSchema,
  requiresDirect,
  updateMcpServerSchema,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
  type McpToolInfo,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { RegistryError } from '../mcp/registry.js';

/**
 * MCP management — records of MCP servers, each with a `mode` (Phase 3.1):
 *   proxy  — Harness Nexus dials the upstream (SSE / Streamable HTTP) and
 *            re-exposes it via `/mcp`; pooled by the registry automatically.
 *   direct — the target tool dials it itself (SSE / HTTP / stdio). Harness Nexus
 *            stores the connection + encrypted credentials only.
 * stdio forces `direct` (Harness Nexus never spawns the subprocess), enforced as
 * a 409 STDIO_REQUIRES_DIRECT here.
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
    assertDirectForTransport(transport, input.mode);

    const now = new Date().toISOString();
    const server: McpServer = {
      id: generateId(),
      name: input.name,
      transport,
      mode: input.mode,
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
    await assertProxyOwned(req.params.id, req.user!.id, req.user!.role, app);
    try {
      const status = await app.mcpRegistry!.connectServer(req.params.id);
      return { status };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // POST /api/mcp-servers/:id/disconnect — drop a live connection on demand.
  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/disconnect', guard, async (req) => {
    await assertProxyOwned(req.params.id, req.user!.id, req.user!.role, app);
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
    await assertProxyOwned(req.params.id, req.user!.id, req.user!.role, app);
    try {
      const tools = app.mcpRegistry!.listServerTools(req.params.id);
      return { tools };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // POST /api/mcp-servers/:id/tools/refresh — re-pull tools from the upstream.
  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/tools/refresh', guard, async (req) => {
    await assertProxyOwned(req.params.id, req.user!.id, req.user!.role, app);
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
    const mode: McpMode = input.mode ?? existing.mode;
    assertDirectForTransport(transport, mode);

    const next: McpServer = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.transport !== undefined ? { transport } : {}),
      ...(input.mode !== undefined ? { mode } : {}),
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
 * Enforce the mode × transport rule: stdio can only run in `direct` mode, since
 * Harness Nexus must never spawn a stdio subprocess (that's the target tool's job).
 * Throws 409 STDIO_REQUIRES_DIRECT otherwise.
 */
function assertDirectForTransport(transport: McpTransport, mode: McpMode): void {
  if (requiresDirect(transport) && mode !== 'direct') {
    throw new AppError(
      'stdio transport requires direct mode (Harness Nexus does not spawn stdio servers)',
      409,
      'STDIO_REQUIRES_DIRECT',
    );
  }
}

/** A record is actionable by the caller iff they own it (personal) or are admin. */
function ownsOrAdmin(s: McpServer, userId: string, role: 'admin' | 'user'): boolean {
  return role === 'admin' || s.ownerId === userId;
}

/**
 * Phase 2.4 — guard for the connect/disconnect/tools routes. Reads the stored
 * record (NOT the pool entry) and applies owner-or-admin + proxy-mode checks
 * BEFORE touching the registry: a not-found/not-owned server returns 404
 * MCP_SERVER_NOT_FOUND (leak prevention, identical to PATCH/DELETE), and a
 * direct server returns 409 NOT_PROXY_MODE (Harness Nexus never dials it).
 */
async function assertProxyOwned(
  id: string,
  userId: string,
  role: 'admin' | 'user',
  app: FastifyInstance,
): Promise<void> {
  const existing = await app.uow.mcpServers.findById(id);
  if (!existing || !ownsOrAdmin(existing, userId, role)) {
    throw new AppError('MCP server not found', 404, 'MCP_SERVER_NOT_FOUND');
  }
  if (existing.mode !== 'proxy') {
    throw new AppError(
      `MCP server "${existing.name}" is not in proxy mode (Harness Nexus does not dial direct servers)`,
      409,
      'NOT_PROXY_MODE',
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
    const status = err.kind === 'not_proxy' ? 409 : err.kind === 'not_connected' ? 409 : 404;
    const code =
      err.kind === 'not_proxy'
        ? 'NOT_PROXY_MODE'
        : err.kind === 'not_connected'
          ? 'NOT_CONNECTED'
          : 'MCP_SERVER_NOT_FOUND';
    throw new AppError(err.message, status, code);
  }
  throw err;
}

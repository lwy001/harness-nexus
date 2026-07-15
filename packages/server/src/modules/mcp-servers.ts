import type { FastifyInstance } from 'fastify';
import type { McpServer, McpMode, McpTransport } from '@agent-nexus/core';
import {
  AppError,
  createMcpServerSchema,
  requiresDirect,
  updateMcpServerSchema,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
} from '@agent-nexus/shared';
import { generateId } from '../infra/crypto.js';

/**
 * MCP management — records of MCP servers, each with a `mode` (Phase 3.1):
 *   proxy  — AgentNexus dials the upstream (SSE / Streamable HTTP) and
 *            re-exposes it via `/mcp`; pooled by the registry automatically.
 *   direct — the target tool dials it itself (SSE / HTTP / stdio). AgentNexus
 *            stores the connection + encrypted credentials only.
 * stdio forces `direct` (AgentNexus never spawns the subprocess), enforced as
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
  // Live connection states from the registry. Drives the Dashboard mesh dots.
  app.get('/api/mcp-servers/status', guard, async () => {
    return { statuses: app.mcpRegistry?.getStatuses() ?? [] };
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
 * AgentNexus must never spawn a stdio subprocess (that's the target tool's job).
 * Throws 409 STDIO_REQUIRES_DIRECT otherwise.
 */
function assertDirectForTransport(transport: McpTransport, mode: McpMode): void {
  if (requiresDirect(transport) && mode !== 'direct') {
    throw new AppError(
      'stdio transport requires direct mode (AgentNexus does not spawn stdio servers)',
      409,
      'STDIO_REQUIRES_DIRECT',
    );
  }
}

/** A record is actionable by the caller iff they own it (personal) or are admin. */
function ownsOrAdmin(s: McpServer, userId: string, role: 'admin' | 'user'): boolean {
  return role === 'admin' || s.ownerId === userId;
}

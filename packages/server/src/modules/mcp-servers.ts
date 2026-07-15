import type { FastifyInstance } from 'fastify';
import type { McpServer, McpTransport } from '@agent-nexus/core';
import {
  AppError,
  createMcpServerSchema,
  updateMcpServerSchema,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
} from '@agent-nexus/shared';
import { generateId } from '../infra/crypto.js';

/**
 * MCP client connection management — records of upstream MCP servers this
 * instance can connect to. 2.1 stores config only; the registry that dials
 * these connections lands in 2.2.
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
    await assertBindingsAccessible(app, transport, req.user!.id, req.user!.role);

    const now = new Date().toISOString();
    const server: McpServer = {
      id: generateId(),
      name: input.name,
      transport,
      proxied: input.proxied,
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
    if (input.transport) {
      await assertBindingsAccessible(app, transport, req.user!.id, req.user!.role);
    }

    const next: McpServer = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.transport !== undefined ? { transport } : {}),
      ...(input.proxied !== undefined ? { proxied: input.proxied } : {}),
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
 * Validate that every credential referenced by a transport's credentialBindings
 * is reachable by the owner: global credentials are reachable by anyone;
 * personal credentials must belong to the same user. stdio transports carry no
 * bindings and are skipped (and are rejected upstream by the zod schema).
 */
async function assertBindingsAccessible(
  app: FastifyInstance,
  transport: McpTransport,
  userId: string,
  role: 'admin' | 'user',
): Promise<void> {
  if (transport.type === 'stdio') return; // unreachable via zod; guard anyway.
  const bindings = transport.credentialBindings;
  if (!bindings) return;
  for (const credentialId of Object.values(bindings)) {
    const cred = await app.uow.credentials.findById(credentialId);
    if (!cred) {
      throw new AppError(
        `Credential ${credentialId} not found`,
        409,
        'CREDENTIAL_NOT_ACCESSIBLE',
      );
    }
    const accessible = cred.scope === 'global' || cred.ownerId === userId || role === 'admin';
    if (!accessible) {
      throw new AppError(
        `Credential ${credentialId} is not accessible`,
        409,
        'CREDENTIAL_NOT_ACCESSIBLE',
      );
    }
  }
}

/** A record is actionable by the caller iff they own it (personal) or are admin. */
function ownsOrAdmin(s: McpServer, userId: string, role: 'admin' | 'user'): boolean {
  return role === 'admin' || s.ownerId === userId;
}

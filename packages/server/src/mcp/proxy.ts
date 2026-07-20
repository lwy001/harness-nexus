/**
 * MCP proxy layer — Pillar #1 (Phase 2.2).
 *
 * Mounts the aggregated MCP server surface that Agent tools connect to. Two
 * transports are exposed off the same `McpRegistry`:
 *   - Streamable HTTP  → POST/GET /mcp
 *   - SSE (legacy)     → GET /mcp/sse + POST /mcp/sse/messages
 *
 * Auth: a PAT (Bearer anpat_…) is required, resolved into `req.user` by the
 * root auth hook. The `?profile=<id>` query param selects which profile's MCP
 * server entries are exposed (explicit profile routing — see docs/design/phase-2.2-registry.md).
 *
 * This file is the transport mount point only; aggregation lives in
 * `./registry.ts`. It is intentionally decoupled from the REST routes.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '@agent-nexus/shared';
import { McpRegistry } from './registry.js';

/** Session entry: one SDK server + its transport, per Agent-tool connection. */
interface Session {
  server: SdkMcpServer;
  transport: StreamableHTTPServerTransport | SSEServerTransport;
}

/** Request-scoped: the resolved upstream server ids for the chosen profile. */
interface ResolvedProfileRequest {
  resolvedServerIds: string[];
}

export async function mountMcpProxy(app: FastifyInstance): Promise<void> {
  const registry = new McpRegistry({
    uow: app.uow,
    encryptionKey: app.credentialEncryptionKey,
    logger: app.log,
  });
  app.decorate('mcpRegistry', registry);
  await registry.reload();

  const streamableSessions = new Map<string, Session>();
  const sseSessions = new Map<string, Session>();

  // ---- auth + profile preHandler (shared by both mounts) ----
  const gate = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    const profileId = (req.query as { profile?: string }).profile;
    if (!profileId) {
      throw new AppError('A profile query parameter is required', 400, 'PROFILE_REQUIRED');
    }
    try {
      const { serverIds } = await registry.profileEntriesFor(profileId, req.user.id, req.user.role);
      (req as FastifyRequest & ResolvedProfileRequest).resolvedServerIds = serverIds;
    } catch {
      throw new AppError(
        'Profile not found or references inaccessible MCP servers',
        403,
        'PROFILE_ENTRY_NOT_ACCESSIBLE',
      );
    }
  };

  // ===================== Streamable HTTP: /mcp =====================
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    preHandler: [gate],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? randomUUID();
      let session = streamableSessions.get(sessionId);
      if (!session) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
        });
        session = await buildSession(
          registry,
          transport,
          (req as FastifyRequest & ResolvedProfileRequest).resolvedServerIds,
        );
        streamableSessions.set(sessionId, session);
        transport.onclose = () => {
          streamableSessions.delete(sessionId);
        };
      }
      // Hand the raw Node streams to the SDK transport; Fastify must not send
      // its own response, so hijack the reply.
      reply.hijack();
      if (session.transport instanceof StreamableHTTPServerTransport) {
        await session.transport.handleRequest(req.raw, reply.raw, req.body);
      }
    },
  });

  // ===================== SSE: /mcp/sse =============================
  // Legacy SSE transport: GET opens the stream, POST /messages sends commands.
  app.route({
    method: ['GET'],
    url: '/mcp/sse',
    preHandler: [gate],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const sessionId = randomUUID();
      reply.hijack();
      const transport = new SSEServerTransport('/mcp/sse/messages', reply.raw);
      const session = await buildSession(
        registry,
        transport,
        (req as FastifyRequest & ResolvedProfileRequest).resolvedServerIds,
      );
      sseSessions.set(sessionId, session);
      await transport.start();
    },
  });

  app.route({
    method: ['POST'],
    url: '/mcp/sse/messages',
    preHandler: [gate],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const sessionId = (req.query as { sessionId?: string }).sessionId ?? '';
      const session = sseSessions.get(sessionId);
      if (!session || !(session.transport instanceof SSEServerTransport)) {
        throw new AppError('Unknown or expired SSE session', 400, 'SESSION_NOT_FOUND');
      }
      reply.hijack();
      await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
    },
  });

  // Clean up all pooled connections when the app closes.
  app.addHook('onClose', async () => {
    await Promise.all([
      ...[...streamableSessions.values()].map((s) => s.server.close().catch(() => {})),
      ...[...sseSessions.values()].map((s) => s.server.close().catch(() => {})),
      registry.shutdown(),
    ]);
  });

  app.log.info('MCP proxy mounted: /mcp (Streamable HTTP) + /mcp/sse (SSE)');
}

/**
 * Build a per-session SDK server wired to a transport, registering every
 * aggregated tool (filtered to the profile's MCP entries) with a forwarding
 * callback. Returns once the server has connected to the transport.
 */
async function buildSession(
  registry: McpRegistry,
  transport: StreamableHTTPServerTransport | SSEServerTransport,
  serverIds: string[],
): Promise<Session> {
  const server = new SdkMcpServer({ name: 'agent-nexus', version: '0.1.0' });
  for (const tool of registry.listTools(serverIds.length ? serverIds : undefined)) {
    const name = tool.name;
    server.registerTool(
      name,
      {
        ...(tool.description ? { description: tool.description } : {}),
      },
      async (args) => {
        const result = await registry.callTool(name, args as Record<string, unknown> | undefined);
        // The registry returns the upstream's raw CallToolResult; pass it through.
        return result as CallToolResult;
      },
    );
  }
  await server.connect(transport as Parameters<SdkMcpServer['connect']>[0]);
  return { server, transport };
}

// ---- Fastify type augmentation for the decorated registry ----
declare module 'fastify' {
  interface FastifyInstance {
    mcpRegistry: McpRegistry;
  }
}

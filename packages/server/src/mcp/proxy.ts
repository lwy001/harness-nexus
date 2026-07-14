import type { FastifyInstance } from 'fastify';

/**
 * MCP proxy layer — Pillar #1.
 *
 * AgentNexus connects to your MCP servers as a CLIENT (stdio/sse/streamable-http),
 * aggregates their tools/resources/prompts, and re-exposes a unified MCP SERVER
 * interface to your coding tools. This file is the transport mount point only;
 * the aggregation logic lives in `./registry.ts` (TODO) and uses the official
 * `@modelcontextprotocol/sdk` on both sides.
 *
 * The MCP transport is intentionally decoupled from the Fastify REST routes:
 * it can serve stdio, SSE, and streamable-http from the same registry without
 * touching the HTTP module layer.
 */
export async function mountMcpProxy(app: FastifyInstance): Promise<void> {
  // TODO: build a McpRegistry from app.uow.mcpServers (proxied === true), then
  //   - mount streamable-http under /mcp
  //   - mount SSE under /mcp/sse
  //   - expose a programmatic entry for a stdio bridge (used by acp-bridge)
  app.log.info('MCP proxy mount point registered (implementation pending)');
}

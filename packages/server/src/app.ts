import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';

import type { ServerConfig } from './config.js';
import { createStorage } from './infra/storage/index.js';
import { authPlugin } from './plugins/auth.js';
import { healthRoutes } from './modules/health.js';
import { mountMcpProxy } from './mcp/proxy.js';

/**
 * Build the Fastify instance. Wiring order matters:
 *   1. platform plugins (helmet/cors/sensible)
 *   2. storage (UnitOfWork) — bound before any module needs it
 *   3. auth (PAT/JWT) — decorates request with the current user
 *   4. route modules + MCP proxy transport
 */
export async function buildApp(config: ServerConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      transport: process.env.NODE_ENV === 'production' ? undefined : {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      },
    },
  });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(sensible);

  const uow = await createStorage(config);
  app.decorate('uow', uow);

  await app.register(authPlugin);

  await app.register(async (api) => {
    await healthRoutes(api);
    // TODO: register users / resources / profiles / mcp-servers route modules
  });

  await mountMcpProxy(app);

  return app;
}

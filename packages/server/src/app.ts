import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { isAppError } from '@agent-nexus/shared';

import type { ServerConfig } from './config.js';
import { createStorage } from './infra/storage/index.js';
import { createJwtService } from './infra/jwt.js';
import { registerAuthHook, requireAuth, requireAdmin } from './plugins/auth.js';
import { healthRoutes } from './modules/health.js';
import { authRoutes } from './modules/auth.js';
import { usersRoutes } from './modules/users.js';
import { patsRoutes } from './modules/pats.js';
import { settingsRoutes } from './modules/settings.js';
import { credentialsRoutes } from './modules/credentials.js';
import { mcpServersRoutes } from './modules/mcp-servers.js';
import { profilesRoutes } from './modules/profiles.js';
import { resourcesRoutes } from './modules/resources.js';
import { mountMcpProxy } from './mcp/proxy.js';

/**
 * Build the Fastify instance. Wiring order matters:
 *   1. platform plugins (helmet/cors/sensible)
 *   2. storage (UnitOfWork) + jwt + auth (PAT/JWT) + permission guards
 *   3. error handler (maps AppError → JSON)
 *   4. route modules + MCP proxy transport
 */
export async function buildApp(config: ServerConfig): Promise<FastifyInstance> {
  const isProd = process.env.NODE_ENV === 'production';
  const app = Fastify({
    logger: {
      level: config.logLevel,
      ...(isProd
        ? {}
        : {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }),
    },
  });

  await app.register(helmet);
  await app.register(cors, { origin: true });
  await app.register(sensible);

  // Decorations must exist before the auth plugin reads them.
  const uow = await createStorage(config);
  const jwt = createJwtService({
    secret: config.jwtSecret,
    issuer: config.jwtIssuer,
    accessTtl: config.jwtAccessTtl,
  });
  app.decorate('uow', uow);
  app.decorate('jwt', jwt);
  app.decorate('requireAuth', requireAuth);
  app.decorate('requireAdmin', requireAdmin);
  app.decorate('credentialEncryptionKey', config.credentialEncryptionKey);

  // Auth hook must be registered on the root instance (not inside a child
  // plugin context) so it applies to all routes. See plugins/auth.ts.
  registerAuthHook(app);

  // Error handler: AppError → its status/code; zod → 400; else 500.
  app.setErrorHandler((err, req, reply) => {
    if (isAppError(err)) {
      reply.code(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof Error && err.name === 'ZodError') {
      reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: (err as { issues?: unknown }).issues,
      });
      return;
    }
    req.log.error({ err }, 'unhandled error');
    reply.code(500).send({ error: 'INTERNAL', message: 'Internal server error' });
  });

  await app.register(async (api) => {
    await healthRoutes(api);
    await authRoutes(api);
    await settingsRoutes(api);
    await usersRoutes(api);
    await patsRoutes(api);
    await credentialsRoutes(api);
    await mcpServersRoutes(api);
    await profilesRoutes(api);
    await resourcesRoutes(api);
  });

  await mountMcpProxy(app);

  return app;
}

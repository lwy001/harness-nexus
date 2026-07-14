import type { FastifyInstance } from 'fastify';

/** Liveness/readiness routes — no auth. Keep these side-effect free. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    // TODO: probe storage connectivity
    return { status: 'ok' };
  });
}

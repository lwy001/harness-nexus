import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';

/**
 * Authentication plugin.
 *
 * Supports two credential kinds:
 *   - PAT:  `Authorization: Bearer anpat_<token>`  (personal access token)
 *   - JWT:  session tokens issued by the users module (TODO)
 *
 * On success, decorates `request.user` with the resolved user id and roles.
 * Unauthenticated requests pass through with `request.user = null`; individual
 * route modules enforce authorization (RBAC) via `requireAuth` / `requireRole`.
 */
export async function authPlugin(app: FastifyInstance): Promise<void> {
  // hash a PAT the same way it is stored
  const hashToken = (raw: string): string =>
    createHash('sha256').update(raw).digest('hex');

  app.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      req.user = null;
      return;
    }
    const raw = header.slice('Bearer '.length).trim();

    // PAT format: anpat_<opaque>. Anything else is treated as a (future) JWT.
    if (raw.startsWith('anpat_')) {
      const record = await app.uow.tokens.findByTokenHash(hashToken(raw));
      if (record && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())) {
        const user = await app.uow.users.findById(record.userId);
        if (user && user.status === 'active') {
          req.user = { id: user.id, roles: user.roles };
          // fire-and-forget usage tracking
          void app.uow.tokens.touchLastUsed(record.id, new Date().toISOString());
          return;
        }
      }
    }

    // TODO: JWT session-token verification

    req.user = null;
  });
}

// ---- shared types ----
declare module 'fastify' {
  interface FastifyInstance {
    // UnitOfWork is attached in buildApp; re-declared here would need core import.
    // See infra/storage/index.ts for the concrete decoration type.
  }
  interface FastifyRequest {
    user: { id: string; roles: string[] } | null;
  }
}

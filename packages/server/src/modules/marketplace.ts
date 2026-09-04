import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@harness-nexus/shared';
import type { Profile } from '@harness-nexus/core';
import { hashToken, PAT_PREFIX } from '../infra/crypto.js';

/**
 * Marketplace emitter routes (Phase 3.5) — the surface Claude Code consumes:
 *
 *   GET /api/marketplace/:token/marketplace.json
 *   GET /api/marketplace/:token/archives/:profileId.zip
 *
 * Auth is PAT-in-path, NOT the Authorization header: claude plugin flows send
 * no headers we can rely on (spike §4), so these routes sit outside
 * `requireAuth` and resolve the token themselves into `req.user`. Unknown or
 * revoked tokens answer 404 — indistinguishable from a nonexistent path, the
 * same no-existence-leak posture as the rest of the API.
 */
export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  // ---- GET /api/marketplace/:token/marketplace.json ----
  app.get<{ Params: { token: string } }>(
    '/api/marketplace/:token/marketplace.json',
    async (req, reply) => {
      const user = await resolveTokenUser(app, req);
      const catalog = await app.marketplaceEmitter.buildCatalog(
        user.id,
        user.username,
        req.params.token,
      );
      return reply.send(catalog);
    },
  );

  // ---- GET /api/marketplace/:token/archives/:file (<profileId>.zip) ----
  app.get<{ Params: { token: string; file: string } }>(
    '/api/marketplace/:token/archives/:file',
    async (req, reply) => {
      const user = await resolveTokenUser(app, req);
      const profileId = req.params.file.replace(/\.zip$/, '');
      const profile = await app.uow.profiles.findById(profileId);
      if (!profile || profile.target !== 'claude-code' || !visibleTo(profile, user.id, user.role)) {
        throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
      }
      const zip = await app.marketplaceEmitter.buildPluginZip(profile);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${profileId}.zip"`)
        .send(zip);
    },
  );
}

/**
 * Resolve the emit token embedded in the URL path into the requesting user.
 * Mirrors the auth plugin's PAT path (sha256 lookup + expiry + active check +
 * touchLastUsed) with one extra gate: only tokens carrying the `marketplace`
 * scope (created via `POST /api/pats {kind:'marketplace'}`) are accepted —
 * general API PATs are not URL-capability tokens and must not leak through
 * URLs into logs. Returns the full user row — the emitter needs `username`
 * for the marketplace name.
 */
async function resolveTokenUser(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ id: string; username: string; role: 'admin' | 'user' }> {
  const raw = req.params ? (req.params as { token: string }).token : '';
  if (!raw.startsWith(PAT_PREFIX)) {
    throw new AppError('Marketplace not found', 404, 'MARKETPLACE_NOT_FOUND');
  }
  const record = await app.uow.tokens.findByTokenHash(hashToken(raw));
  if (
    record &&
    record.scopes.includes('marketplace') &&
    (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())
  ) {
    const user = await app.uow.users.findById(record.userId);
    if (user && user.status === 'active') {
      req.user = { id: user.id, role: user.role };
      void app.uow.tokens.touchLastUsed(record.id, new Date().toISOString());
      return { id: user.id, username: user.username, role: user.role };
    }
  }
  throw new AppError('Marketplace not found', 404, 'MARKETPLACE_NOT_FOUND');
}

/** A profile is visible iff global, personal + owned, or admin. */
function visibleTo(p: Profile, userId: string, role: 'admin' | 'user'): boolean {
  return p.scope === 'global' || p.ownerId === userId || role === 'admin';
}

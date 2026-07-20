import type { FastifyInstance } from 'fastify';
import { AppError } from '@agent-nexus/shared';
import { resolveAllowlistId } from '../infra/source-fetchers/allowlist.js';

/**
 * Skill hub routes (Phase 7.2) — browse marketplace plugin catalogs.
 *
 * This is the server's only outbound-fetch surface. All fetches go through the
 * allowlist (parsed at boot from `MARKETPLACE_ALLOWLIST`) and the
 * `SkillCatalogService` cache. Scope: any authenticated user can browse —
 * marketplaces are public catalogs; saving a skill resource (7.3) still goes
 * through the normal `/api/resources` scope rules.
 */

export async function skillsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- GET /api/skills/marketplaces ----
  // List the configured allowlist (no fetch — cheap).
  app.get('/api/skills/marketplaces', guard, async () => {
    return { marketplaces: app.marketplaceAllowlist.map((e) => ({ id: e.id })) };
  });

  // ---- GET /api/skills/marketplaces/:id/plugins ----
  // Fetch (with cache) and return a marketplace's plugins. Optional `?category=`
  // and `?q=` filters narrow the list. Non-allowlisted id → 404 (not 403, to
  // avoid leaking which ids are configured). Fetch failure → 502.
  app.get<{ Params: { id: string } }>(
    '/api/skills/marketplaces/:id/plugins',
    guard,
    async (req) => {
      const id = req.params.id;
      const url = resolveAllowlistId(app.marketplaceAllowlist, id);
      if (!url) {
        throw new AppError(
          `Marketplace "${id}" is not in the allowlist`,
          404,
          'MARKETPLACE_NOT_ALLOWED',
        );
      }
      const q = req.query as { category?: string; q?: string };
      const plugins = await app.skillCatalog.listPlugins(id, url, {
        ...(q.category ? { category: q.category } : {}),
        ...(q.q ? { q: q.q } : {}),
      });
      return { plugins };
    },
  );
}

import type { FastifyInstance } from 'fastify';
import { AppError, createPatSchema, type CreatePatInput } from '@harness-nexus/shared';
import { generatePat, hashToken, patDisplayPrefix, generateId } from '../infra/crypto.js';

/** Personal access token management — each user manages their own. */
export async function patsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/pats ----
  app.post('/api/pats', guard, async (req, reply) => {
    const input = createPatSchema.parse(req.body) as CreatePatInput;
    const rawToken = generatePat();
    const now = new Date().toISOString();
    // A marketplace (emit) token carries the 'marketplace' scope tag — the
    // marketplace routes require it and the REST API rejects it, so its blast
    // radius is exactly the emitter URL.
    const scopes =
      input.kind === 'marketplace'
        ? Array.from(new Set([...(input.scopes ?? []), 'marketplace']))
        : (input.scopes ?? []);

    const pat = await app.uow.tokens.save({
      id: generateId(),
      userId: req.user!.id,
      name: input.name,
      tokenHash: hashToken(rawToken),
      prefix: patDisplayPrefix(rawToken),
      scopes,
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      createdAt: now,
    });

    // The raw token is returned exactly once. For marketplace tokens, also
    // return the ready-to-paste `claude plugin marketplace add` command — the
    // server is the only side that knows PUBLIC_BASE_URL.
    const marketplaceUrl =
      input.kind === 'marketplace'
        ? `${app.publicBaseUrl}/api/marketplace/${rawToken}/marketplace.json`
        : undefined;
    return reply.code(201).send({
      pat: stripSecret(pat),
      token: rawToken,
      ...(marketplaceUrl
        ? {
            marketplaceUrl,
            addCommand: `claude plugin marketplace add ${marketplaceUrl}`,
          }
        : {}),
    });
  });

  // ---- GET /api/pats ----
  app.get('/api/pats', guard, async (req) => {
    const pats = await app.uow.tokens.listByUser(req.user!.id);
    return { pats: pats.map(stripSecret) };
  });

  // ---- DELETE /api/pats/:id ----
  app.delete<{ Params: { id: string } }>('/api/pats/:id', guard, async (req) => {
    const pat = await app.uow.tokens.findById(req.params.id);
    if (!pat || pat.userId !== req.user!.id) {
      throw new AppError('Token not found', 404, 'PAT_NOT_FOUND');
    }
    await app.uow.tokens.delete(pat.id);
    return { ok: true };
  });
}

type PatView = Omit<import('@harness-nexus/core').PersonalAccessToken, 'tokenHash'>;
function stripSecret(pat: import('@harness-nexus/core').PersonalAccessToken): PatView {
  const { tokenHash: _omit, ...rest } = pat;
  return rest;
}

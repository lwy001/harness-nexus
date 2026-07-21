import type { FastifyInstance } from 'fastify';
import type { Credential } from '@harness-nexus/core';
import {
  AppError,
  createCredentialSchema,
  updateCredentialSchema,
  type CreateCredentialInput,
  type UpdateCredentialInput,
} from '@harness-nexus/shared';
import { generateId, encryptSecret, decryptSecret, maskSecret } from '../infra/crypto.js';
import { credentialView } from './serialize.js';

/**
 * Credential management — named secrets referenced by MCP transports via
 * `${cred:NAME}` placeholders. A credential is a pure name + secret + scope.
 *
 * Scope rules (see docs/design/phase-2.1-credentials.md):
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 */
export async function credentialsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const key = app.credentialEncryptionKey;

  // ---- POST /api/credentials ----
  app.post('/api/credentials', guard, async (req, reply) => {
    const input = createCredentialSchema.parse(req.body) as CreateCredentialInput;

    // global scope requires admin.
    if (input.scope === 'global' && req.user!.role !== 'admin') {
      throw new AppError('Only admins can create global credentials', 403, 'FORBIDDEN');
    }

    const now = new Date().toISOString();
    const credential: Credential = {
      id: generateId(),
      name: input.name,
      secret: encryptSecret(input.secret, key),
      scope: input.scope,
      ownerId: input.scope === 'global' ? null : req.user!.id,
      createdAt: now,
      updatedAt: now,
    };
    await app.uow.credentials.save(credential);
    return reply.code(201).send({
      credential: credentialView(credential, maskSecret(input.secret)),
    });
  });

  // ---- GET /api/credentials ----
  app.get('/api/credentials', guard, async (req) => {
    const [personal, global] = await Promise.all([
      app.uow.credentials.list({ scope: 'personal', ownerId: req.user!.id }),
      app.uow.credentials.list({ scope: 'global' }),
    ]);
    // Decrypt for masking only; the plaintext is not returned.
    const view = (c: Credential) => credentialView(c, maskSecret(decryptSecret(c.secret, key)));
    return { credentials: [...personal, ...global].map(view) };
  });

  // ---- PATCH /api/credentials/:id ----
  app.patch<{ Params: { id: string } }>('/api/credentials/:id', guard, async (req) => {
    const input = updateCredentialSchema.parse(req.body) as UpdateCredentialInput;
    const existing = await app.uow.credentials.findById(req.params.id);
    if (!existing || !ownsOrAdmin(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
    }

    const next: Credential = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.secret !== undefined ? { secret: encryptSecret(input.secret, key) } : {}),
      updatedAt: new Date().toISOString(),
    };
    await app.uow.credentials.save(next);
    const plaintext =
      input.secret !== undefined ? input.secret : decryptSecret(existing.secret, key);
    return { credential: credentialView(next, maskSecret(plaintext)) };
  });

  // ---- DELETE /api/credentials/:id ----
  app.delete<{ Params: { id: string } }>('/api/credentials/:id', guard, async (req) => {
    const existing = await app.uow.credentials.findById(req.params.id);
    if (!existing || !ownsOrAdmin(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
    }
    await app.uow.credentials.delete(existing.id);
    return { ok: true };
  });
}

/** A record is actionable by the caller iff they own it (personal) or are admin. */
function ownsOrAdmin(c: Credential, userId: string, role: 'admin' | 'user'): boolean {
  return role === 'admin' || c.ownerId === userId;
}

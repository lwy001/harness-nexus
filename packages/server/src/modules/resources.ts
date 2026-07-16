import type { FastifyInstance } from 'fastify';
import type { Resource, ResourceKind } from '@agent-nexus/core';
import {
  AppError,
  createResourceSchema,
  updateResourceSchema,
  type CreateResourceInput,
  type UpdateResourceInput,
} from '@agent-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { resourceView } from './serialize.js';

/**
 * Resource management — versioned assets (sub-agents, rules, …) referenced by
 * profiles via `kind:key`.
 *
 * Scope rules (identical to credentials & mcp-servers):
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 *
 * Kind availability is gated by an allowlist (AVAILABLE_KINDS) at the route
 * layer, not in the zod schema, so 4.4–4.6 can enable new kinds without touching
 * shared schemas. `kind` and `scope` are immutable post-create.
 */
export async function resourcesRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/resources ----
  app.post('/api/resources', guard, async (req, reply) => {
    const input = createResourceSchema.parse(req.body) as CreateResourceInput;

    if (input.scope === 'global' && req.user!.role !== 'admin') {
      throw new AppError('Only admins can create global resources', 403, 'FORBIDDEN');
    }
    assertKindAvailable(input.kind);

    const ownerId = input.scope === 'global' ? null : req.user!.id;
    const existing = await app.uow.resources.findByKey(
      input.key,
      input.scope,
      ownerId ?? undefined,
    );
    if (existing) {
      throw new AppError(
        `A resource with key "${input.key}" already exists in scope ${input.scope}`,
        409,
        'RESOURCE_KEY_TAKEN',
      );
    }

    const now = new Date().toISOString();
    // zod-inferred source/targets carry `| undefined` on optional fields; the
    // domain types do not (exactOptionalPropertyTypes). The shapes are identical
    // at runtime, so cast at this validated boundary (same pattern as mcp-servers
    // transport). Same for labels.
    const resource: Resource = {
      id: generateId(),
      key: input.key,
      kind: input.kind,
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      version: input.version,
      source: input.source as Resource['source'],
      scope: input.scope,
      ownerId,
      targets: input.targets,
      ...(input.labels ? { labels: input.labels as Record<string, string> } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await app.uow.resources.save(resource);
    return reply.code(201).send({ resource: resourceView(resource) });
  });

  // ---- GET /api/resources ----
  // Returns the caller's personal resources + all global resources. Query params
  // (kind/scope/target) narrow the set; scope=global|personal filters the halves.
  app.get('/api/resources', guard, async (req) => {
    const q = req.query as {
      kind?: ResourceKind;
      scope?: 'global' | 'personal';
      target?: Resource['targets'][number];
    };

    const wantPersonal = q.scope !== 'global';
    const wantGlobal = q.scope !== 'personal';

    const [personal, global] = await Promise.all([
      wantPersonal
        ? app.uow.resources.list({
            ...(q.kind ? { kind: q.kind } : {}),
            scope: 'personal',
            ownerId: req.user!.id,
            ...(q.target ? { target: q.target } : {}),
          })
        : Promise.resolve([]),
      wantGlobal
        ? app.uow.resources.list({
            ...(q.kind ? { kind: q.kind } : {}),
            scope: 'global',
            ...(q.target ? { target: q.target } : {}),
          })
        : Promise.resolve([]),
    ]);
    return { resources: [...personal, ...global].map(resourceView) };
  });

  // ---- GET /api/resources/:id ----
  app.get<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const resource = await app.uow.resources.findById(req.params.id);
    if (!resource || !ownsOrAdmin(resource, req.user!.id, req.user!.role)) {
      throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
    }
    return { resource: resourceView(resource) };
  });

  // ---- PATCH /api/resources/:id ----
  app.patch<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const input = updateResourceSchema.parse(req.body) as UpdateResourceInput;
    const existing = await app.uow.resources.findById(req.params.id);
    if (!existing || !ownsOrAdmin(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
    }

    // kind/scope are immutable; they are not in updateResourceSchema, but guard
    // against a future schema change leaking them through.
    if (
      (input as { kind?: unknown }).kind !== undefined &&
      (input as { kind?: unknown }).kind !== existing.kind
    ) {
      throw new AppError('Resource kind is immutable', 409, 'RESOURCE_IMMUTABLE');
    }

    // If the key changed, ensure the new key is free in this scope.
    if (input.key !== undefined && input.key !== existing.key) {
      const clash = await app.uow.resources.findByKey(
        input.key,
        existing.scope,
        existing.ownerId ?? undefined,
      );
      if (clash) {
        throw new AppError(
          `A resource with key "${input.key}" already exists in scope ${existing.scope}`,
          409,
          'RESOURCE_KEY_TAKEN',
        );
      }
    }

    const next: Resource = {
      ...existing,
      ...(input.key !== undefined ? { key: input.key } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      ...(input.source !== undefined ? { source: input.source as Resource['source'] } : {}),
      ...(input.targets !== undefined ? { targets: input.targets } : {}),
      ...(input.labels !== undefined ? { labels: input.labels as Record<string, string> } : {}),
      updatedAt: new Date().toISOString(),
    };
    await app.uow.resources.save(next);
    return { resource: resourceView(next) };
  });

  // ---- DELETE /api/resources/:id ----
  app.delete<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const existing = await app.uow.resources.findById(req.params.id);
    if (!existing || !ownsOrAdmin(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Resource not found', 404, 'RESOURCE_NOT_FOUND');
    }
    await app.uow.resources.delete(existing.id);
    return { ok: true };
  });
}

/** Resource kinds that have shipped. Add a kind here when its sub-phase lands. */
const AVAILABLE_KINDS: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  'sub_agent',
  'rule',
  'command',
]);

function assertKindAvailable(kind: ResourceKind): void {
  if (!AVAILABLE_KINDS.has(kind)) {
    throw new AppError(`Resource kind "${kind}" is not available yet`, 409, 'KIND_NOT_AVAILABLE');
  }
}

/** A record is actionable by the caller iff they own it (personal) or are admin. */
function ownsOrAdmin(r: Resource, userId: string, role: 'admin' | 'user'): boolean {
  return role === 'admin' || r.ownerId === userId;
}

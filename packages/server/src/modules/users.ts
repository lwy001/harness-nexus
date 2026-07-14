import type { FastifyInstance } from 'fastify';
import {
  AppError,
  createUserSchema,
  updateRoleSchema,
  type CreateUserInput,
  type UpdateRoleInput,
} from '@agent-nexus/shared';
import { hashPassword, generateId } from '../infra/crypto.js';
import { publicUser } from './serialize.js';

/** User administration — admin-only. Bypasses the registration switch. */
export async function usersRoutes(app: FastifyInstance): Promise<void> {
  const adminGuard = { preHandler: [app.requireAdmin] };

  // ---- POST /api/users ----
  app.post('/api/users', adminGuard, async (req, reply) => {
    const input = createUserSchema.parse(req.body) as CreateUserInput;

    if (await app.uow.users.findByUsername(input.username)) {
      throw new AppError('Username already exists', 409, 'USERNAME_TAKEN');
    }

    const now = new Date().toISOString();
    const user = await app.uow.users.save({
      id: generateId(),
      username: input.username,
      ...(input.email ? { email: input.email } : {}),
      passwordHash: await hashPassword(input.password),
      role: input.role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    return reply.code(201).send({ user: publicUser(user) });
  });

  // ---- GET /api/users ----
  app.get('/api/users', adminGuard, async () => {
    const users = await app.uow.users.list();
    return { users: users.map(publicUser) };
  });

  // ---- DELETE /api/users/:id ----
  app.delete<{ Params: { id: string } }>('/api/users/:id', adminGuard, async (req) => {
    const target = await app.uow.users.findById(req.params.id);
    if (!target) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

    if (target.id === req.user!.id) {
      throw new AppError('You cannot delete your own account', 409, 'NO_SELF_DELETE');
    }
    if (target.role === 'admin') {
      const adminCount = await app.uow.users.countByRole('admin');
      if (adminCount <= 1) {
        throw new AppError('Cannot delete the last admin', 409, 'LAST_ADMIN');
      }
    }
    await app.uow.users.delete(target.id);
    return { ok: true };
  });

  // ---- PATCH /api/users/:id/role ----
  app.patch<{ Params: { id: string } }>('/api/users/:id/role', adminGuard, async (req) => {
    const input = updateRoleSchema.parse(req.body) as UpdateRoleInput;
    const target = await app.uow.users.findById(req.params.id);
    if (!target) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

    // Demoting the last admin is blocked.
    if (target.role === 'admin' && input.role !== 'admin') {
      const adminCount = await app.uow.users.countByRole('admin');
      if (adminCount <= 1) {
        throw new AppError('Cannot demote the last admin', 409, 'LAST_ADMIN');
      }
    }

    const updated = await app.uow.users.save({
      ...target,
      role: input.role,
      updatedAt: new Date().toISOString(),
    });
    return { user: publicUser(updated) };
  });
}

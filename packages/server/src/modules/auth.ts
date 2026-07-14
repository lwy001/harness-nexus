import type { FastifyInstance } from 'fastify';
import {
  AppError,
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from '@agent-nexus/shared';
import { hashPassword, verifyPassword, generateId } from '../infra/crypto.js';
import { publicUser } from './serialize.js';

/** Auth routes: register (toggleable), login (JWT), me. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // ---- POST /api/auth/register ----
  app.post('/api/auth/register', async (req, reply) => {
    const input = registerSchema.parse(req.body) as RegisterInput;

    const settings = await app.uow.settings.get();
    if (!settings.allowRegistration) {
      throw new AppError('Registration is disabled', 403, 'REGISTRATION_DISABLED');
    }

    if (await app.uow.users.findByUsername(input.username)) {
      throw new AppError('Username already exists', 409, 'USERNAME_TAKEN');
    }

    const now = new Date().toISOString();
    const total = await app.uow.users.count();
    // First user becomes the bootstrap admin.
    const role = total === 0 ? 'admin' : 'user';

    const user = await app.uow.users.save({
      id: generateId(),
      username: input.username,
      ...(input.email ? { email: input.email } : {}),
      passwordHash: await hashPassword(input.password),
      role,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });

    const token = await app.jwt.signAccessToken(user);
    req.log.info({ userId: user.id, role }, 'user registered');
    return reply.code(201).send({ token, user: publicUser(user) });
  });

  // ---- POST /api/auth/login ----
  app.post('/api/auth/login', async (req, _reply) => {
    const input = loginSchema.parse(req.body) as LoginInput;
    const user = await app.uow.users.findByUsername(input.username);
    if (!user || !user.passwordHash) {
      throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') {
      throw new AppError('Account is disabled', 403, 'ACCOUNT_DISABLED');
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }
    const token = await app.jwt.signAccessToken(user);
    return { token, user: publicUser(user) };
  });

  // ---- GET /api/auth/me ----
  app.get('/api/auth/me', { preHandler: [app.requireAuth] }, async (req) => {
    const user = await app.uow.users.findById(req.user!.id);
    if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    return { user: publicUser(user) };
  });
}

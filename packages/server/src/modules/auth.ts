import type { FastifyInstance } from 'fastify';
import {
  AppError,
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from '@harness-nexus/shared';
import { hashPassword, verifyPassword, generateId } from '../infra/crypto.js';
import { publicUser } from './serialize.js';

/**
 * One argon2id hash computed at boot. Verifying an unknown username against
 * it keeps the login path's timing indistinguishable from a wrong password —
 * otherwise the early return enumerates accounts (#21).
 */
const dummyHashPromise = hashPassword('harness-nexus-timing-equalizer');

/** Auth routes: register (toggleable), login (JWT), me. */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  // #21: the bootstrap role pick (first user = admin) is check-then-act;
  // serializing registrations keeps two concurrent registers from both
  // reading count() === 0 and minting two admins.
  let registerQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = registerQueue.then(run, run);
    registerQueue = next.catch(() => {});
    return next;
  };

  // ---- POST /api/auth/register ----
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) =>
      enqueue(async () => {
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
      }),
  );

  // ---- POST /api/auth/login ----
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, _reply) => {
      const input = loginSchema.parse(req.body) as LoginInput;
      const user = await app.uow.users.findByUsername(input.username);
      if (!user || !user.passwordHash) {
        // Burn the same argon2 work a real verify would (#21).
        await verifyPassword(input.password, await dummyHashPromise);
        throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
      }
      if (!(await verifyPassword(input.password, user.passwordHash))) {
        throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
      }
      // Post-verification only: a disabled account's existence is revealed
      // solely to callers that already hold the password (#21).
      if (user.status !== 'active') {
        throw new AppError('Account is disabled', 403, 'ACCOUNT_DISABLED');
      }
      const token = await app.jwt.signAccessToken(user);
      return { token, user: publicUser(user) };
    },
  );

  // ---- GET /api/auth/me ----
  app.get('/api/auth/me', { preHandler: [app.requireAuth] }, async (req) => {
    const user = await app.uow.users.findById(req.user!.id);
    if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    return { user: publicUser(user) };
  });
}

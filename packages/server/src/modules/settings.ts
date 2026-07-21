import type { FastifyInstance } from 'fastify';
import { updateRegistrationSchema, type UpdateRegistrationInput } from '@harness-nexus/shared';

/** System settings — registration toggle. GET is public, PUT is admin-only. */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET is intentionally public: the register page needs it before login.
  app.get('/api/settings/registration', async () => {
    const settings = await app.uow.settings.get();
    return { allowRegistration: settings.allowRegistration };
  });

  app.put('/api/settings/registration', { preHandler: [app.requireAdmin] }, async (req) => {
    const input = updateRegistrationSchema.parse(req.body) as UpdateRegistrationInput;
    const settings = await app.uow.settings.save({
      allowRegistration: input.allowRegistration,
      updatedAt: new Date().toISOString(),
    });
    return { allowRegistration: settings.allowRegistration };
  });
}

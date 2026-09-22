import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_CHAT_PREWARM_SETTINGS,
  updateChatPrewarmSettingsSchema,
  updateRegistrationSchema,
  type ChatPrewarmSettingsInput,
  type UpdateRegistrationInput,
} from '@harness-nexus/shared';

/** System settings — registration toggle + chat pre-warm switches (Issue #3). */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // GET is intentionally public: the register page needs it before login.
  app.get('/api/settings/registration', async () => {
    const settings = await app.uow.settings.get();
    return { allowRegistration: settings.allowRegistration };
  });

  app.put('/api/settings/registration', { preHandler: [app.requireAdmin] }, async (req) => {
    const input = updateRegistrationSchema.parse(req.body) as UpdateRegistrationInput;
    const current = await app.uow.settings.get();
    const settings = await app.uow.settings.save({
      // Issue #3 — the aggregate save must not drop the pre-warm map.
      ...(current.chatPrewarm !== undefined ? { chatPrewarm: current.chatPrewarm } : {}),
      allowRegistration: input.allowRegistration,
      updatedAt: new Date().toISOString(),
    });
    return { allowRegistration: settings.allowRegistration };
  });

  // ---- Issue #3: per-target adapter pre-warm switches ----
  // GET needs auth (unlike registration) but not admin: the Settings page
  // renders for every signed-in user, and the map carries no secrets.
  app.get('/api/settings/chat-prewarm', { preHandler: [app.requireAuth] }, async () => {
    const settings = await app.uow.settings.get();
    return { chatPrewarm: settings.chatPrewarm ?? DEFAULT_CHAT_PREWARM_SETTINGS };
  });

  app.put('/api/settings/chat-prewarm', { preHandler: [app.requireAdmin] }, async (req) => {
    const input = updateChatPrewarmSettingsSchema.parse(req.body) as ChatPrewarmSettingsInput;
    const current = await app.uow.settings.get();
    const settings = await app.uow.settings.save({
      allowRegistration: current.allowRegistration,
      chatPrewarm: input,
      updatedAt: new Date().toISOString(),
    });
    return { chatPrewarm: settings.chatPrewarm ?? DEFAULT_CHAT_PREWARM_SETTINGS };
  });
}

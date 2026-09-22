import { z } from 'zod';

/**
 * Instance settings beyond the registration toggle (Issue #3). The zod layer
 * mirrors `core/domain/settings.ts`; keep the shapes in sync. `pi` and
 * `opencode` are deliberately absent — pi chats through the in-daemon RPC
 * façade (no adapter subprocess) and opencode is out of scope for now; the
 * wire mechanism is target-generic, so extending the enum later is additive.
 */
export const chatPrewarmSettingsSchema = z.object({
  'claude-code': z.boolean(),
  codex: z.boolean(),
  deepseek: z.boolean(),
});

export type ChatPrewarmSettingsInput = z.infer<typeof chatPrewarmSettingsSchema>;

/** PUT body — the full per-target map (replace semantics, like registration). */
export const updateChatPrewarmSettingsSchema = chatPrewarmSettingsSchema;

/** Applied when the stored row predates the feature (null column) — mirrors core. */
export const DEFAULT_CHAT_PREWARM_SETTINGS: ChatPrewarmSettingsInput = {
  'claude-code': false,
  codex: false,
  deepseek: true,
};

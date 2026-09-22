/**
 * System-wide settings — a single-row aggregate persisted in `system_settings`.
 * Phase 1 uses `allowRegistration`; later fields append here without a new table.
 */
export interface SystemSettings {
  /** When false, `POST /api/auth/register` is rejected; admins use POST /api/users. */
  allowRegistration: boolean;
  /**
   * Issue #3 — per-target adapter pre-warm switches (chat). Absent on rows
   * written before the feature: readers apply `DEFAULT_CHAT_PREWARM_SETTINGS`.
   */
  chatPrewarm?: ChatPrewarmSettings;
  updatedAt: string;
}

/**
 * Which Agent targets get a pre-warmed ACP adapter (booted to a completed
 * `initialize`, no session) while the user sits on a chat session page. The
 * switches are admin-managed instance settings; the daemon pool is keyed by
 * target and bounded by an idle TTL.
 */
export interface ChatPrewarmSettings {
  'claude-code': boolean;
  codex: boolean;
  deepseek: boolean;
}

export const DEFAULT_SYSTEM_SETTINGS: Pick<SystemSettings, 'allowRegistration'> = {
  allowRegistration: true,
};

/** Mirrors the zod default in `@harness-nexus/shared` (`schemas/settings.ts`). */
export const DEFAULT_CHAT_PREWARM_SETTINGS: ChatPrewarmSettings = {
  'claude-code': false,
  codex: false,
  deepseek: true,
};

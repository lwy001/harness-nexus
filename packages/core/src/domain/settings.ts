/**
 * System-wide settings — a single-row aggregate persisted in `system_settings`.
 * Phase 1 uses `allowRegistration`; later fields append here without a new table.
 */
export interface SystemSettings {
  /** When false, `POST /api/auth/register` is rejected; admins use POST /api/users. */
  allowRegistration: boolean;
  updatedAt: string;
}

export const DEFAULT_SYSTEM_SETTINGS: Pick<SystemSettings, 'allowRegistration'> = {
  allowRegistration: true,
};

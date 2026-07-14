import type { UnitOfWork } from '@agent-nexus/core';

/**
 * SQLite storage driver (default).
 *
 * Uses `better-sqlite3` (synchronous, single-file). Migrations live alongside
 * this file. Implementations are TODO; when adding them, ensure every method
 * matches the interface in core and that scope/owner filtering is correct.
 */
export function createSqliteUnitOfWork(_dbPath: string): UnitOfWork {
  // TODO: open DB, run migrations from ./migrations, then return real impls.
  // For now, delegate to the in-memory shape so the server boots pre-impl.
  throw new Error('SQLite driver not yet implemented — set STORAGE_DRIVER=memory');
}

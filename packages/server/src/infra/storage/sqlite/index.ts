import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UnitOfWork } from '@agent-nexus/core';
import { runMigrations } from './migrations.js';
import { sqliteUserRepository, sqlitePatRepository, sqliteSettingsRepository } from './repos.js';
import { memoryResourceProfileMcpStub } from '../stub-repos.js';

/**
 * SQLite storage driver (default).
 *
 * Opens a single connection (better-sqlite3 is synchronous), runs migrations,
 * and returns a UnitOfWork. Resources/profiles/mcpServers are still stubs in
 * Phase 1 — see ../stub-repos.ts.
 */
export function createSqliteUnitOfWork(dbPath: string): UnitOfWork {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  return {
    ...memoryResourceProfileMcpStub(),
    users: sqliteUserRepository(db),
    tokens: sqlitePatRepository(db),
    settings: sqliteSettingsRepository(db),
  };
}

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UnitOfWork } from '@agent-nexus/core';
import { runMigrations } from './migrations.js';
import {
  sqliteUserRepository,
  sqlitePatRepository,
  sqliteSettingsRepository,
  sqliteCredentialRepository,
  sqliteMcpServerRepository,
} from './repos.js';
import { memoryResourceProfileStub } from '../stub-repos.js';

/**
 * SQLite storage driver (default).
 *
 * Opens a single connection (better-sqlite3 is synchronous), runs migrations,
 * and returns a UnitOfWork. Resources/profiles are still stubs — see
 * ../stub-repos.ts.
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
    ...memoryResourceProfileStub(),
    users: sqliteUserRepository(db),
    tokens: sqlitePatRepository(db),
    settings: sqliteSettingsRepository(db),
    credentials: sqliteCredentialRepository(db),
    mcpServers: sqliteMcpServerRepository(db),
  };
}

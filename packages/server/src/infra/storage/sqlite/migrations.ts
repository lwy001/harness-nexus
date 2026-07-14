/**
 * SQLite schema migrations — append-only and idempotent.
 *
 * The runner tracks applied versions in `schema_version`. Only forward
 * migrations; no down/rollback in Phase 1.
 */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'initial schema (users, personal_access_tokens, system_settings)',
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '[]',
  expires_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pat_user_id ON personal_access_tokens(user_id);

CREATE TABLE IF NOT EXISTS system_settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  allow_registration INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
    `,
  },
  {
    version: 2,
    description: 'phase 2.1 — credentials and mcp_servers (connection config layer)',
    sql: `
CREATE TABLE IF NOT EXISTS credentials (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  secret     TEXT NOT NULL,
  kind       TEXT,
  scope      TEXT NOT NULL,
  owner_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_id);
CREATE INDEX IF NOT EXISTS idx_credentials_scope ON credentials(scope);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  transport  TEXT NOT NULL,
  proxied    INTEGER NOT NULL DEFAULT 0,
  scope      TEXT NOT NULL,
  owner_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers(owner_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope);
    `,
  },
] as const;

/**
 * Run all pending migrations inside a transaction. `versionAt(version)`
 * reflects the user_version pragma-style tracking via the schema_version table.
 */
export function runMigrations(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    });
    tx();
  }
}

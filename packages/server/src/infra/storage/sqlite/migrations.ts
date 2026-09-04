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
  mode       TEXT NOT NULL DEFAULT 'proxy',
  scope      TEXT NOT NULL,
  owner_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers(owner_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope);
    `,
  },
  {
    version: 3,
    description: 'phase 2.2 — profiles table',
    sql: `
CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  version     TEXT NOT NULL DEFAULT '1.0.0',
  scope       TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  entries     TEXT NOT NULL DEFAULT '[]',
  imports     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_profiles_scope ON profiles(scope);
    `,
  },
  {
    version: 4,
    description: 'phase 4.2 — resources table (sub_agent/rule/skill/hook/command/mcp)',
    sql: `
CREATE TABLE IF NOT EXISTS resources (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  version     TEXT NOT NULL DEFAULT '1.0.0',
  source      TEXT NOT NULL,
  scope       TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  targets     TEXT NOT NULL DEFAULT '[]',
  labels      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_id);
CREATE INDEX IF NOT EXISTS idx_resources_scope ON resources(scope);
CREATE INDEX IF NOT EXISTS idx_resources_kind  ON resources(kind);
    `,
  },
  {
    version: 5,
    description: 'phase 3.2 — profiles.target (immutable install target)',
    sql: `
ALTER TABLE profiles ADD COLUMN target TEXT NOT NULL DEFAULT 'generic';
    `,
  },
  {
    version: 6,
    description: 'phase 8 C1 — machines (enrolled via the Harness Nexus client)',
    sql: `
CREATE TABLE IF NOT EXISTS machines (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  hostname           TEXT,
  os                 TEXT,
  arch               TEXT,
  daemon_version     TEXT,
  capabilities       TEXT NOT NULL DEFAULT '[]',
  remote_chat_enabled INTEGER NOT NULL DEFAULT 0,
  enrollment_pat_id  TEXT NOT NULL,
  enrolled_at        TEXT NOT NULL,
  last_seen_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_machines_owner ON machines(owner_id);
CREATE INDEX IF NOT EXISTS idx_machines_pat   ON machines(enrollment_pat_id);
    `,
  },
  {
    version: 7,
    description:
      'phase 8 C2 — mcp_servers.mode → dial_site (proxy→auto, direct→client); credentials.distributable',
    sql: `
ALTER TABLE mcp_servers ADD COLUMN dial_site TEXT NOT NULL DEFAULT 'auto';
UPDATE mcp_servers SET dial_site = CASE WHEN mode = 'direct' THEN 'client' ELSE 'auto' END;
ALTER TABLE mcp_servers DROP COLUMN mode;

ALTER TABLE credentials ADD COLUMN distributable INTEGER NOT NULL DEFAULT 0;
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

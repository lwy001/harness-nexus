import type { Database } from 'better-sqlite3';
import type {
  User,
  Role,
  PersonalAccessToken,
  McpServer,
  McpTransport,
  Credential,
  CredentialKind,
  UserRepository,
  PersonalAccessTokenRepository,
  SystemSettingsRepository,
  McpServerRepository,
  CredentialRepository,
} from '@agent-nexus/core';
import { DEFAULT_SYSTEM_SETTINGS as DEFAULTS } from '@agent-nexus/core';

// ---- row shapes ----
interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string | null;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}
interface PatRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}
interface SettingsRow {
  id: number;
  allow_registration: number;
  updated_at: string;
}
interface CredentialRow {
  id: string;
  name: string;
  secret: string;
  kind: string | null;
  scope: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}
interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  proxied: number;
  scope: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---- mappers ----
const mapUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  ...(r.email ? { email: r.email } : {}),
  passwordHash: r.password_hash,
  role: r.role as Role,
  status: r.status as User['status'],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapPat = (r: PatRow): PersonalAccessToken => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  tokenHash: r.token_hash,
  prefix: r.prefix,
  scopes: JSON.parse(r.scopes) as string[],
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  createdAt: r.created_at,
});

const mapCredential = (r: CredentialRow): Credential => {
  const base: Credential = {
    id: r.id,
    name: r.name,
    secret: r.secret,
    scope: r.scope as Credential['scope'],
    ownerId: r.owner_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  return r.kind ? { ...base, kind: r.kind as CredentialKind } : base;
};

const mapMcpServer = (r: McpServerRow): McpServer => ({
  id: r.id,
  name: r.name,
  transport: JSON.parse(r.transport) as McpTransport,
  proxied: r.proxied === 1,
  scope: r.scope as McpServer['scope'],
  ownerId: r.owner_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

// ---- user repository ----
export function sqliteUserRepository(db: Database): UserRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
      return row ? mapUser(row) : null;
    },
    async findByUsername(username) {
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
        UserRow | undefined;
      return row ? mapUser(row) : null;
    },
    async list() {
      const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
      return rows.map(mapUser);
    },
    async count() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      return row.n;
    },
    async countByRole(role) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(role) as {
        n: number;
      };
      return row.n;
    },
    async save(user) {
      db.prepare(
        `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
         VALUES (@id, @username, @email, @password_hash, @role, @status, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           username      = excluded.username,
           email         = excluded.email,
           password_hash = excluded.password_hash,
           role          = excluded.role,
           status        = excluded.status,
           updated_at    = excluded.updated_at`,
      ).run({
        id: user.id,
        username: user.username,
        email: user.email ?? null,
        password_hash: user.passwordHash,
        role: user.role,
        status: user.status,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
      });
      return user;
    },
    async delete(id) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },
  };
}

// ---- PAT repository ----
export function sqlitePatRepository(db: Database): PersonalAccessTokenRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM personal_access_tokens WHERE id = ?').get(id) as
        PatRow | undefined;
      return row ? mapPat(row) : null;
    },
    async findByTokenHash(tokenHash) {
      const row = db
        .prepare('SELECT * FROM personal_access_tokens WHERE token_hash = ?')
        .get(tokenHash) as PatRow | undefined;
      return row ? mapPat(row) : null;
    },
    async listByUser(userId) {
      const rows = db
        .prepare('SELECT * FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at')
        .all(userId) as PatRow[];
      return rows.map(mapPat);
    },
    async save(token) {
      db.prepare(
        `INSERT INTO personal_access_tokens
           (id, user_id, name, token_hash, prefix, scopes, expires_at, last_used_at, created_at)
         VALUES (@id, @user_id, @name, @token_hash, @prefix, @scopes, @expires_at, @last_used_at, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name         = excluded.name,
           token_hash   = excluded.token_hash,
           scopes       = excluded.scopes,
           expires_at   = excluded.expires_at,
           last_used_at = excluded.last_used_at`,
      ).run({
        id: token.id,
        user_id: token.userId,
        name: token.name,
        token_hash: token.tokenHash,
        prefix: token.prefix,
        scopes: JSON.stringify(token.scopes),
        expires_at: token.expiresAt,
        last_used_at: token.lastUsedAt,
        created_at: token.createdAt,
      });
      return token;
    },
    async touchLastUsed(id, at) {
      db.prepare('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?').run(id, at);
    },
    async delete(id) {
      db.prepare('DELETE FROM personal_access_tokens WHERE id = ?').run(id);
    },
  };
}

// ---- system settings repository (single-row) ----
export function sqliteSettingsRepository(db: Database): SystemSettingsRepository {
  const ensureRow = (): SettingsRow => {
    const existing = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as
      SettingsRow | undefined;
    if (existing) return existing;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO system_settings (id, allow_registration, updated_at) VALUES (1, ?, ?)`,
    ).run(DEFAULTS.allowRegistration ? 1 : 0, now);
    return db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as SettingsRow;
  };

  return {
    async get() {
      const row = ensureRow();
      return {
        allowRegistration: row.allow_registration === 1,
        updatedAt: row.updated_at,
      };
    },
    async save(settings) {
      const now = settings.updatedAt;
      db.prepare(
        `UPDATE system_settings SET allow_registration = ?, updated_at = ? WHERE id = 1`,
      ).run(settings.allowRegistration ? 1 : 0, now);
      return { allowRegistration: settings.allowRegistration, updatedAt: now };
    },
  };
}

// ---- credential repository ----
export function sqliteCredentialRepository(db: Database): CredentialRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
        CredentialRow | undefined;
      return row ? mapCredential(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.scope) {
        where.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter?.ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = filter.ownerId;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM credentials ${clause} ORDER BY created_at`)
        .all(params) as CredentialRow[];
      return rows.map(mapCredential);
    },
    async save(credential) {
      db.prepare(
        `INSERT INTO credentials (id, name, secret, kind, scope, owner_id, created_at, updated_at)
         VALUES (@id, @name, @secret, @kind, @scope, @owner_id, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           secret     = excluded.secret,
           kind       = excluded.kind,
           scope      = excluded.scope,
           owner_id   = excluded.owner_id,
           updated_at = excluded.updated_at`,
      ).run({
        id: credential.id,
        name: credential.name,
        secret: credential.secret,
        kind: credential.kind ?? null,
        scope: credential.scope,
        owner_id: credential.ownerId,
        created_at: credential.createdAt,
        updated_at: credential.updatedAt,
      });
      return credential;
    },
    async delete(id) {
      db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    },
  };
}

// ---- mcp server repository ----
export function sqliteMcpServerRepository(db: Database): McpServerRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
        McpServerRow | undefined;
      return row ? mapMcpServer(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.scope) {
        where.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter?.ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = filter.ownerId;
      }
      if (filter?.proxied !== undefined) {
        where.push('proxied = @proxied');
        params.proxied = filter.proxied ? 1 : 0;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM mcp_servers ${clause} ORDER BY created_at`)
        .all(params) as McpServerRow[];
      return rows.map(mapMcpServer);
    },
    async save(server) {
      db.prepare(
        `INSERT INTO mcp_servers (id, name, transport, proxied, scope, owner_id, created_at, updated_at)
         VALUES (@id, @name, @transport, @proxied, @scope, @owner_id, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           transport  = excluded.transport,
           proxied    = excluded.proxied,
           scope      = excluded.scope,
           owner_id   = excluded.owner_id,
           updated_at = excluded.updated_at`,
      ).run({
        id: server.id,
        name: server.name,
        transport: JSON.stringify(server.transport),
        proxied: server.proxied ? 1 : 0,
        scope: server.scope,
        owner_id: server.ownerId,
        created_at: server.createdAt,
        updated_at: server.updatedAt,
      });
      return server;
    },
    async delete(id) {
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    },
  };
}

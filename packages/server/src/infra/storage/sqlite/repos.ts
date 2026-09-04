import type { Database } from 'better-sqlite3';
import type {
  User,
  Role,
  PersonalAccessToken,
  McpServer,
  McpTransport,
  Credential,
  Profile,
  ProfileEntry,
  ProfileImport,
  Resource,
  ResourceSource,
  AgentTarget,
  Machine,
  UserRepository,
  PersonalAccessTokenRepository,
  SystemSettingsRepository,
  McpServerRepository,
  CredentialRepository,
  ProfileRepository,
  ResourceRepository,
  MachineRepository,
} from '@harness-nexus/core';
import { DEFAULT_SYSTEM_SETTINGS as DEFAULTS } from '@harness-nexus/core';

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
  scope: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}
interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  mode: string;
  scope: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}
interface ProfileRow {
  id: string;
  name: string;
  description: string | null;
  version: string;
  target: string;
  scope: string;
  owner_id: string | null;
  entries: string;
  imports: string | null;
  created_at: string;
  updated_at: string;
}
interface ResourceRow {
  id: string;
  key: string;
  kind: string;
  name: string;
  description: string | null;
  version: string;
  source: string;
  scope: string;
  owner_id: string | null;
  targets: string;
  labels: string | null;
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

const mapCredential = (r: CredentialRow): Credential => ({
  id: r.id,
  name: r.name,
  secret: r.secret,
  scope: r.scope as Credential['scope'],
  ownerId: r.owner_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMcpServer = (r: McpServerRow): McpServer => ({
  id: r.id,
  name: r.name,
  transport: JSON.parse(r.transport) as McpTransport,
  mode: r.mode as McpServer['mode'],
  scope: r.scope as McpServer['scope'],
  ownerId: r.owner_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapProfile = (r: ProfileRow): Profile => {
  const base: Profile = {
    id: r.id,
    name: r.name,
    version: r.version,
    target: r.target as Profile['target'],
    scope: r.scope as Profile['scope'],
    ownerId: r.owner_id,
    entries: JSON.parse(r.entries) as ProfileEntry[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const decorated: Profile = {
    ...base,
    ...(r.description ? { description: r.description } : {}),
  };
  return r.imports
    ? { ...decorated, imports: JSON.parse(r.imports) as ProfileImport[] }
    : decorated;
};

const mapResource = (r: ResourceRow): Resource => {
  const base: Resource = {
    id: r.id,
    key: r.key,
    kind: r.kind as Resource['kind'],
    name: r.name,
    version: r.version,
    source: JSON.parse(r.source) as ResourceSource,
    scope: r.scope as Resource['scope'],
    ownerId: r.owner_id,
    targets: JSON.parse(r.targets) as AgentTarget[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const decorated: Resource = {
    ...base,
    ...(r.description ? { description: r.description } : {}),
  };
  return r.labels
    ? { ...decorated, labels: JSON.parse(r.labels) as Record<string, string> }
    : decorated;
};

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
    async findByName(name) {
      const row = db.prepare('SELECT * FROM credentials WHERE name = ?').get(name) as
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
        `INSERT INTO credentials (id, name, secret, scope, owner_id, created_at, updated_at)
         VALUES (@id, @name, @secret, @scope, @owner_id, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           secret     = excluded.secret,
           scope      = excluded.scope,
           owner_id   = excluded.owner_id,
           updated_at = excluded.updated_at`,
      ).run({
        id: credential.id,
        name: credential.name,
        secret: credential.secret,
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
      if (filter?.mode) {
        where.push('mode = @mode');
        params.mode = filter.mode;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM mcp_servers ${clause} ORDER BY created_at`)
        .all(params) as McpServerRow[];
      return rows.map(mapMcpServer);
    },
    async save(server) {
      db.prepare(
        `INSERT INTO mcp_servers (id, name, transport, mode, scope, owner_id, created_at, updated_at)
         VALUES (@id, @name, @transport, @mode, @scope, @owner_id, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           transport  = excluded.transport,
           mode       = excluded.mode,
           scope      = excluded.scope,
           owner_id   = excluded.owner_id,
           updated_at = excluded.updated_at`,
      ).run({
        id: server.id,
        name: server.name,
        transport: JSON.stringify(server.transport),
        mode: server.mode,
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

// ---- profile repository ----
export function sqliteProfileRepository(db: Database): ProfileRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as
        ProfileRow | undefined;
      return row ? mapProfile(row) : null;
    },
    async findByName(name, scope, ownerId) {
      const where = ['name = @name', 'scope = @scope'];
      const params: Record<string, unknown> = { name, scope };
      if (ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = ownerId;
      }
      const row = db.prepare(`SELECT * FROM profiles WHERE ${where.join(' AND ')}`).get(params) as
        ProfileRow | undefined;
      return row ? mapProfile(row) : null;
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
        .prepare(`SELECT * FROM profiles ${clause} ORDER BY created_at`)
        .all(params) as ProfileRow[];
      return rows.map(mapProfile);
    },
    async save(profile) {
      db.prepare(
        `INSERT INTO profiles (id, name, description, version, target, scope, owner_id, entries, imports, created_at, updated_at)
         VALUES (@id, @name, @description, @version, @target, @scope, @owner_id, @entries, @imports, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name        = excluded.name,
           description = excluded.description,
           version     = excluded.version,
           scope       = excluded.scope,
           owner_id    = excluded.owner_id,
           entries     = excluded.entries,
           imports     = excluded.imports,
           updated_at  = excluded.updated_at`,
      ).run({
        id: profile.id,
        name: profile.name,
        description: profile.description ?? null,
        version: profile.version,
        target: profile.target,
        scope: profile.scope,
        owner_id: profile.ownerId,
        entries: JSON.stringify(profile.entries),
        imports: profile.imports ? JSON.stringify(profile.imports) : null,
        created_at: profile.createdAt,
        updated_at: profile.updatedAt,
      });
      return profile;
    },
    async delete(id) {
      db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    },
  };
}

// ---- resource repository ----
export function sqliteResourceRepository(db: Database): ResourceRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as
        ResourceRow | undefined;
      return row ? mapResource(row) : null;
    },
    async findByKey(key, scope, ownerId) {
      const where = ['key = @key', 'scope = @scope'];
      const params: Record<string, unknown> = { key, scope };
      // personal rows are owner-scoped; global rows have NULL owner.
      if (scope === 'personal' && ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = ownerId;
      } else if (scope === 'global') {
        where.push('owner_id IS NULL');
      }
      const row = db.prepare(`SELECT * FROM resources WHERE ${where.join(' AND ')}`).get(params) as
        ResourceRow | undefined;
      return row ? mapResource(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.kind) {
        where.push('kind = @kind');
        params.kind = filter.kind;
      }
      if (filter?.scope) {
        where.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter?.ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = filter.ownerId;
      }
      if (filter?.target) {
        // targets is a JSON array; a LIKE match is sufficient at this scale.
        where.push('targets LIKE @target');
        params.target = `%"${filter.target}"%`;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM resources ${clause} ORDER BY created_at`)
        .all(params) as ResourceRow[];
      return rows.map(mapResource);
    },
    async save(resource) {
      db.prepare(
        `INSERT INTO resources
           (id, key, kind, name, description, version, source, scope, owner_id, targets, labels, created_at, updated_at)
         VALUES (@id, @key, @kind, @name, @description, @version, @source, @scope, @owner_id, @targets, @labels, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           key         = excluded.key,
           kind        = excluded.kind,
           name        = excluded.name,
           description = excluded.description,
           version     = excluded.version,
           source      = excluded.source,
           scope       = excluded.scope,
           owner_id    = excluded.owner_id,
           targets     = excluded.targets,
           labels      = excluded.labels,
           updated_at  = excluded.updated_at`,
      ).run({
        id: resource.id,
        key: resource.key,
        kind: resource.kind,
        name: resource.name,
        description: resource.description ?? null,
        version: resource.version,
        source: JSON.stringify(resource.source),
        scope: resource.scope,
        owner_id: resource.ownerId,
        targets: JSON.stringify(resource.targets),
        labels: resource.labels ? JSON.stringify(resource.labels) : null,
        created_at: resource.createdAt,
        updated_at: resource.updatedAt,
      });
      return resource;
    },
    async delete(id) {
      db.prepare('DELETE FROM resources WHERE id = ?').run(id);
    },
  };
}

// ---- machine repository (Phase 8 C1) ----

interface MachineRow {
  id: string;
  owner_id: string;
  name: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  daemon_version: string | null;
  capabilities: string;
  remote_chat_enabled: number;
  enrollment_pat_id: string;
  enrolled_at: string;
  last_seen_at: string | null;
}

function mapMachine(row: MachineRow): Machine {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    daemonVersion: row.daemon_version,
    capabilities: JSON.parse(row.capabilities) as string[],
    remoteChatEnabled: row.remote_chat_enabled === 1,
    enrollmentPatId: row.enrollment_pat_id,
    enrolledAt: row.enrolled_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function sqliteMachineRepository(db: Database): MachineRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as
        MachineRow | undefined;
      return row ? mapMachine(row) : null;
    },
    async findByEnrollmentPatId(patId) {
      const row = db.prepare('SELECT * FROM machines WHERE enrollment_pat_id = ?').get(patId) as
        MachineRow | undefined;
      return row ? mapMachine(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, string> = {};
      if (filter?.ownerId !== undefined) {
        where.push('owner_id = @owner_id');
        params.owner_id = filter.ownerId;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM machines ${clause} ORDER BY enrolled_at`)
        .all(params) as MachineRow[];
      return rows.map(mapMachine);
    },
    async save(machine) {
      db.prepare(
        `INSERT INTO machines
           (id, owner_id, name, hostname, os, arch, daemon_version, capabilities,
            remote_chat_enabled, enrollment_pat_id, enrolled_at, last_seen_at)
         VALUES (@id, @owner_id, @name, @hostname, @os, @arch, @daemon_version, @capabilities,
                 @remote_chat_enabled, @enrollment_pat_id, @enrolled_at, @last_seen_at)
         ON CONFLICT(id) DO UPDATE SET
           name                = excluded.name,
           hostname            = excluded.hostname,
           os                  = excluded.os,
           arch                = excluded.arch,
           daemon_version      = excluded.daemon_version,
           capabilities        = excluded.capabilities,
           remote_chat_enabled = excluded.remote_chat_enabled,
           last_seen_at        = excluded.last_seen_at`,
      ).run({
        id: machine.id,
        owner_id: machine.ownerId,
        name: machine.name,
        hostname: machine.hostname,
        os: machine.os,
        arch: machine.arch,
        daemon_version: machine.daemonVersion,
        capabilities: JSON.stringify(machine.capabilities),
        remote_chat_enabled: machine.remoteChatEnabled ? 1 : 0,
        enrollment_pat_id: machine.enrollmentPatId,
        enrolled_at: machine.enrolledAt,
        last_seen_at: machine.lastSeenAt,
      });
      return machine;
    },
    async delete(id) {
      db.prepare('DELETE FROM machines WHERE id = ?').run(id);
    },
  };
}

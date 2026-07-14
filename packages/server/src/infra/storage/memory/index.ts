import type {
  UnitOfWork,
  User,
  Role,
  PersonalAccessToken,
  SystemSettings,
  Credential,
  McpServer,
  UserRepository,
  PersonalAccessTokenRepository,
  SystemSettingsRepository,
  CredentialRepository,
  McpServerRepository,
} from '@agent-nexus/core';
import { DEFAULT_SYSTEM_SETTINGS } from '@agent-nexus/core';
import { memoryResourceProfileStub } from '../stub-repos.js';

/**
 * In-memory storage driver — used by tests and `STORAGE_DRIVER=memory`.
 * Fully functional for Phase 1 + 2.1 aggregates.
 */

export function createMemoryUnitOfWork(): UnitOfWork {
  const users = new Map<string, User>();
  const usernames = new Map<string, string>(); // username -> id
  const tokens = new Map<string, PersonalAccessToken>();
  const tokensByHash = new Map<string, string>(); // hash -> id
  const credentials = new Map<string, Credential>();
  const mcpServers = new Map<string, McpServer>();
  let settings: SystemSettings = {
    allowRegistration: DEFAULT_SYSTEM_SETTINGS.allowRegistration,
    updatedAt: new Date(0).toISOString(),
  };

  const userRepo: UserRepository = {
    async findById(id) {
      return users.get(id) ?? null;
    },
    async findByUsername(username) {
      const id = usernames.get(username);
      return id ? (users.get(id) ?? null) : null;
    },
    async list() {
      return [...users.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async count() {
      return users.size;
    },
    async countByRole(role: Role) {
      let n = 0;
      for (const u of users.values()) if (u.role === role) n++;
      return n;
    },
    async save(user) {
      users.set(user.id, user);
      usernames.set(user.username, user.id);
      return user;
    },
    async delete(id) {
      const u = users.get(id);
      if (u) usernames.delete(u.username);
      users.delete(id);
    },
  };

  const tokenRepo: PersonalAccessTokenRepository = {
    async findById(id) {
      return tokens.get(id) ?? null;
    },
    async findByTokenHash(hash) {
      const id = tokensByHash.get(hash);
      return id ? (tokens.get(id) ?? null) : null;
    },
    async listByUser(userId) {
      return [...tokens.values()].filter((t) => t.userId === userId);
    },
    async save(token) {
      tokens.set(token.id, token);
      tokensByHash.set(token.tokenHash, token.id);
      return token;
    },
    async touchLastUsed(id, at) {
      const t = tokens.get(id);
      if (t) tokens.set(id, { ...t, lastUsedAt: at });
    },
    async delete(id) {
      const t = tokens.get(id);
      if (t) tokensByHash.delete(t.tokenHash);
      tokens.delete(id);
    },
  };

  const settingsRepo: SystemSettingsRepository = {
    async get() {
      return settings;
    },
    async save(next) {
      settings = next;
      return next;
    },
  };

  const credentialRepo: CredentialRepository = {
    async findById(id) {
      return credentials.get(id) ?? null;
    },
    async list(filter) {
      return [...credentials.values()]
        .filter((c) => (filter?.scope ? c.scope === filter.scope : true))
        .filter((c) => (filter?.ownerId ? c.ownerId === filter.ownerId : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async save(credential) {
      credentials.set(credential.id, credential);
      return credential;
    },
    async delete(id) {
      credentials.delete(id);
    },
  };

  const mcpServerRepo: McpServerRepository = {
    async findById(id) {
      return mcpServers.get(id) ?? null;
    },
    async list(filter) {
      return [...mcpServers.values()]
        .filter((s) => (filter?.scope ? s.scope === filter.scope : true))
        .filter((s) => (filter?.ownerId ? s.ownerId === filter.ownerId : true))
        .filter((s) => (filter?.proxied !== undefined ? s.proxied === filter.proxied : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async save(server) {
      mcpServers.set(server.id, server);
      return server;
    },
    async delete(id) {
      mcpServers.delete(id);
    },
  };

  return {
    ...memoryResourceProfileStub(),
    users: userRepo,
    tokens: tokenRepo,
    settings: settingsRepo,
    credentials: credentialRepo,
    mcpServers: mcpServerRepo,
  };
}

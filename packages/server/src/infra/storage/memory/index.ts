import type {
  UnitOfWork,
  ResourceRepository,
  ProfileRepository,
  UserRepository,
  PersonalAccessTokenRepository,
  McpServerRepository,
} from '@agent-nexus/core';

/**
 * In-memory storage driver — used by tests and `STORAGE_DRIVER=memory`.
 * All repositories are trivially backed by Maps. Implementations are TODO;
 * the goal of this file is to fix the shape every driver must satisfy.
 */
export function createMemoryUnitOfWork(): UnitOfWork {
  const resources: ResourceRepository = {
    findById: async () => null,
    findByKey: async () => null,
    list: async () => [],
    save: async (r) => r,
    delete: async () => {},
  };

  const profiles: ProfileRepository = {
    findById: async () => null,
    findByName: async () => null,
    list: async () => [],
    save: async (p) => p,
    delete: async () => {},
  };

  const users: UserRepository = {
    findById: async () => null,
    findByUsername: async () => null,
    list: async () => [],
    save: async (u) => u,
    delete: async () => {},
  };

  const tokens: PersonalAccessTokenRepository = {
    findById: async () => null,
    findByTokenHash: async () => null,
    listByUser: async () => [],
    save: async (t) => t,
    touchLastUsed: async () => {},
    delete: async () => {},
  };

  const mcpServers: McpServerRepository = {
    findById: async () => null,
    list: async () => [],
    save: async (m) => m,
    delete: async () => {},
  };

  return { resources, profiles, users, tokens, mcpServers };
}

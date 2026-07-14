import type {
  UnitOfWork,
  ResourceRepository,
  ProfileRepository,
  McpServerRepository,
} from '@agent-nexus/core';

/**
 * No-op implementations for the Phase 1 aggregates that aren't built yet
 * (resources, profiles, mcpServers). Shared by the SQLite and memory drivers so
 * the UnitOfWork shape stays complete. Replace per-driver as those modules land.
 */
export function memoryResourceProfileMcpStub(): Pick<
  UnitOfWork,
  'resources' | 'profiles' | 'mcpServers'
> {
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

  const mcpServers: McpServerRepository = {
    findById: async () => null,
    list: async () => [],
    save: async (m) => m,
    delete: async () => {},
  };

  return { resources, profiles, mcpServers };
}

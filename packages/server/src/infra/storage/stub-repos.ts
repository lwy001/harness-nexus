import type {
  UnitOfWork,
  ResourceRepository,
  ProfileRepository,
} from '@agent-nexus/core';

/**
 * No-op implementations for the aggregates that aren't built yet
 * (resources, profiles). Shared by the SQLite and memory drivers so the
 * UnitOfWork shape stays complete. Replace per-driver as those modules land.
 */
export function memoryResourceProfileStub(): Pick<UnitOfWork, 'resources' | 'profiles'> {
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

  return { resources, profiles };
}

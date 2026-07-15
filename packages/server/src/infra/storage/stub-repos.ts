import type { UnitOfWork, ResourceRepository } from '@agent-nexus/core';

/**
 * No-op implementation for the `resources` aggregate, which isn't built yet.
 * Shared by the SQLite and memory drivers so the UnitOfWork shape stays
 * complete. Replace per-driver when the Resource module lands.
 */
export function memoryResourceStub(): Pick<UnitOfWork, 'resources'> {
  const resources: ResourceRepository = {
    findById: async () => null,
    findByKey: async () => null,
    list: async () => [],
    save: async (r) => r,
    delete: async () => {},
  };

  return { resources };
}

import { z } from 'zod';

/**
 * Zod schemas for the profile manifest — the portable description a profile
 * author writes and the CLI installs from. Kept in `shared` so server, web,
 * and CLI all validate against the same source of truth.
 *
 * These mirror the domain types in @agent-nexus/core; keep them in sync.
 */

export const resourceKindSchema = z.enum(['skill', 'hook', 'sub_agent', 'rule', 'mcp', 'command']);
export const agentTargetSchema = z.enum(['claude-code', 'zcode', 'hermes', 'generic']);

export const profileImportSchema = z.object({
  origin: z.enum(['ecc', 'superpower', 'custom']),
  source: z.string().min(1),
  checksum: z.string().optional(),
});

export const profileEntrySchema = z.object({
  resourceId: z.string().min(1),
  kind: resourceKindSchema,
  pinnedVersion: z.string().optional(),
  installOptions: z.record(z.string(), z.unknown()).optional(),
});

export const profileManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().min(1),
  entries: z.array(profileEntrySchema),
  imports: z.array(profileImportSchema).optional(),
});

export type ProfileManifest = z.infer<typeof profileManifestSchema>;

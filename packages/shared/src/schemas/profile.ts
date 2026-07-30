import { z } from 'zod';

/**
 * Zod schemas for the profile manifest — the portable description a profile
 * author writes and the CLI installs from. Kept in `shared` so server, web,
 * and CLI all validate against the same source of truth.
 *
 * These mirror the domain types in @harness-nexus/core; keep them in sync.
 */

export const resourceKindSchema = z.enum(['skill', 'hook', 'sub_agent', 'rule', 'mcp', 'command']);
// AgentTarget mirrors `AgentTarget` in @harness-nexus/core (`domain/resource.ts`).
// `shared` deliberately does NOT depend on `core` (see shared/src/trust.ts);
// the two definitions are kept in sync manually. Phase 3.2 records this as an
// accepted duplication rather than collapsing them (which would violate the
// layering rule). Update both together when a target is added.
export const agentTargetSchema = z.enum(['claude-code', 'zcode', 'hermes', 'generic']);
export type AgentTarget = z.infer<typeof agentTargetSchema>;

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
  /** Single target this profile is shaped for (Phase 3.2); required in a manifest. */
  target: agentTargetSchema,
  entries: z.array(profileEntrySchema),
  imports: z.array(profileImportSchema).optional(),
});

export type ProfileManifest = z.infer<typeof profileManifestSchema>;

// ---- REST request schemas (Phase 2.2) ----
// These are the shapes the profile CRUD endpoints accept. They are narrower
// than the manifest: 2.2 only supports MCP-server entries (kind === 'mcp'),
// where `mcpServerId` is the target McpServer.id directly. The richer
// kind:key Resource indirection arrives with the Resource module later.

const scopeSchema = z.enum(['global', 'personal']);

export const profileEntryInputSchema = z.object({
  /** The McpServer.id this entry includes (2.2 maps resourceId → McpServer.id). */
  mcpServerId: z.string().min(1),
  pinnedVersion: z.string().optional(),
});

export const createProfileSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(512).optional(),
  /** Single, immutable target this profile is shaped for (Phase 3.2). */
  target: agentTargetSchema,
  scope: scopeSchema,
  entries: z.array(profileEntryInputSchema).default([]),
});

// `target` is deliberately OMITTED from updates: it is immutable post-create
// (changing it would silently invalidate stored resources' target assumptions).
// zod objects strip unknown keys by default, so a PATCH body carrying `target`
// won't appear in the parsed result — the route handler inspects the RAW
// `req.body` with hasOwnProperty to detect it and reject with 409 TARGET_IMMUTABLE.
export const updateProfileSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().max(512).optional(),
  entries: z.array(profileEntryInputSchema).optional(),
});

export type ProfileEntryInput = z.infer<typeof profileEntryInputSchema>;
export type CreateProfileInput = z.infer<typeof createProfileSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

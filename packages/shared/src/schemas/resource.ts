import { z } from 'zod';
import { resourceKindSchema, agentTargetSchema } from './profile.js';

/**
 * Resource validation schemas — single source of truth for request shapes
 * across server, SDK, and web. See docs/design/phase-4-web-ui.md.
 *
 * These mirror the domain types in @agent-nexus/core; keep them in sync.
 *
 * The schemas are intentionally kind-agnostic (any `ResourceKind` is accepted
 * here). Which kinds are *currently available* is enforced at the route layer
 * via an allowlist (409 KIND_NOT_AVAILABLE), so 4.4–4.6 can enable new kinds
 * without touching this schema.
 *
 * `kind` and `scope` are immutable post-create — a resource's identity and
 * visibility don't change; mutate-by-recreate instead. PATCHing either is
 * rejected at the route layer (409 RESOURCE_IMMUTABLE).
 */

const scopeSchema = z.enum(['global', 'personal']);

/** Where a resource's bytes live. 4.2/4.3 editors only ever emit `inline`. */
const resourceSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().optional(),
    path: z.string().optional(),
  }),
  z.object({
    type: z.literal('tarball'),
    url: z.string().min(1),
    checksum: z.string().optional(),
  }),
  z.object({ type: z.literal('local'), path: z.string().min(1) }),
  z.object({ type: z.literal('inline'), content: z.string() }),
]);

export const createResourceSchema = z.object({
  key: z.string().min(1).max(128),
  kind: resourceKindSchema,
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  version: z.string().min(1).max(64).default('1.0.0'),
  source: resourceSourceSchema,
  scope: scopeSchema,
  targets: z.array(agentTargetSchema).default([]),
  labels: z.record(z.string(), z.string()).optional(),
});

// kind + scope deliberately omitted — immutable post-create.
export const updateResourceSchema = z.object({
  key: z.string().min(1).max(128).optional(),
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2048).optional(),
  version: z.string().min(1).max(64).optional(),
  source: resourceSourceSchema.optional(),
  targets: z.array(agentTargetSchema).optional(),
  labels: z.record(z.string(), z.string()).optional(),
});

export type CreateResourceInput = z.infer<typeof createResourceSchema>;
export type UpdateResourceInput = z.infer<typeof updateResourceSchema>;

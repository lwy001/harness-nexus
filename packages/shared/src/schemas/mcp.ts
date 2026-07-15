import { z } from 'zod';

/**
 * MCP connection & credential validation schemas — single source of truth for
 * request shapes across server, SDK, and web. See docs/design/phase-2.1-credentials.md.
 *
 * These mirror the domain types in @agent-nexus/core; keep them in sync.
 *
 * Note: stdio is deliberately NOT accepted by the create/update schemas even
 * though the domain McpTransport union keeps the variant. stdio is unsupported
 * in Phase 2.1 (see docs/design/phase-2.1-credentials.md "stdio policy").
 */

const scopeSchema = z.enum(['global', 'personal']);
const credentialKindSchema = z.enum(['bearer', 'api_key', 'basic', 'custom']);

// ---- credentials ----
export const createCredentialSchema = z.object({
  name: z.string().min(1).max(64),
  secret: z.string().min(1).max(8192),
  kind: credentialKindSchema.optional(),
  scope: scopeSchema,
});

export const updateCredentialSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  secret: z.string().min(1).max(8192).optional(),
  kind: credentialKindSchema.optional(),
});

// ---- transport (stdio excluded — unsupported in 2.1) ----
const headerBindingsBase = {
  headers: z.record(z.string(), z.string()).optional(),
  credentialBindings: z.record(z.string(), z.string()).optional(),
};

export const mcpTransportSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sse'), url: z.string().url(), ...headerBindingsBase }),
  z.object({
    type: z.literal('streamable-http'),
    url: z.string().url(),
    ...headerBindingsBase,
  }),
]);

// ---- mcp servers ----
export const createMcpServerSchema = z.object({
  name: z.string().min(1).max(64),
  transport: mcpTransportSchema,
  proxied: z.boolean().default(false),
  scope: scopeSchema,
});

export const updateMcpServerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  transport: mcpTransportSchema.optional(),
  proxied: z.boolean().optional(),
});

export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;

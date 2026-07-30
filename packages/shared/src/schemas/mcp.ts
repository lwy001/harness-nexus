import { z } from 'zod';

/**
 * MCP connection & credential validation schemas — single source of truth for
 * request shapes across server, SDK, and web. See docs/design/phase-2.1-credentials.md
 * (credentials + placeholder injection) and docs/design/phase-3-install.md
 * (Part 1, the mode × transport policy).
 *
 * These mirror the domain types in @harness-nexus/core; keep them in sync.
 *
 * Mode policy (Phase 3.1): every McpServer has a `mode`.
 *   - `proxy`  — Harness Nexus dials the upstream; only SSE / Streamable HTTP.
 *   - `direct` — the target tool dials it; SSE / Streamable HTTP **and stdio**.
 * stdio forces `direct` (409 STDIO_REQUIRES_DIRECT at the route layer).
 *
 * Credential injection (Phase 2.1): a credential's secret is referenced by name
 * via a `${cred:NAME}` placeholder inside any transport string field (url,
 * command, args, env values, header values). The placeholder is resolved to
 * the decrypted plaintext at connect time (proxy) / install time (direct).
 * See `utils/placeholders.ts`.
 */

const scopeSchema = z.enum(['global', 'personal']);
const mcpModeSchema = z.enum(['proxy', 'direct']);

// ---- credentials ----
// A credential is a pure named secret — no `kind`. The name is the handle used
// in `${cred:NAME}` placeholders.
export const createCredentialSchema = z.object({
  name: z.string().min(1).max(64),
  secret: z.string().min(1).max(8192),
  scope: scopeSchema,
});

export const updateCredentialSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  secret: z.string().min(1).max(8192).optional(),
});

// ---- transport ----
// Header values (and url) may carry `${cred:NAME}` placeholders, resolved at
// connect/install time. stdio accepts the same placeholders in command/args/env.
const headersBase = {
  headers: z.record(z.string(), z.string()).optional(),
};

export const stdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const mcpTransportSchema = z.discriminatedUnion('type', [
  stdioTransportSchema,
  z.object({ type: z.literal('sse'), url: z.string().url(), ...headersBase }),
  z.object({
    type: z.literal('streamable-http'),
    url: z.string().url(),
    ...headersBase,
  }),
]);

/** True iff the transport requires `mode: 'direct'` (stdio cannot be proxied). */
export function requiresDirect(transport: { type: 'stdio' | 'sse' | 'streamable-http' }): boolean {
  return transport.type === 'stdio';
}

// ---- mcp servers ----
// The stdio+proxy incompatibility is enforced in the route handler (AppError
// 409 STDIO_REQUIRES_DIRECT), not here, so the error carries the right code
// rather than a generic 400 validation error.
export const createMcpServerSchema = z.object({
  name: z.string().min(1).max(64),
  transport: mcpTransportSchema,
  mode: mcpModeSchema.default('proxy'),
  scope: scopeSchema,
});

export const updateMcpServerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  transport: mcpTransportSchema.optional(),
  mode: mcpModeSchema.optional(),
});

export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;

// ---- tool inspection (Phase 2.4) ----
// The externally-exposed shape of a single upstream's tool, read out of the
// McpRegistry pool (NOT persisted — transient, cached in-memory per connection).
// Distinct from the registry's internal AggregatedTool: this is the
// UN-namespaced per-server form surfaced to the UI (`GET /api/mcp-servers/:id/tools`).
// Defined in shared so server, SDK, and web all share one shape.
export const mcpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>;

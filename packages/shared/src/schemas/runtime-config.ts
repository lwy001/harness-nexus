import { z } from 'zod';
import { runtimeTargetSchema, type RuntimeTarget } from './inventory.js';

/**
 * Runtime provider-config schemas (Phase 9 W3) — the LLM route a harness
 * runtime should use. One spec per (machine, target), upserted over REST and
 * applied by the daemon into each harness's NATIVE config slots.
 * docs/design/phase-9-harness-runtime.md §4.3.
 *
 * The spec NEVER carries a secret — it references a distributable credential
 * by name. The plaintext is resolved server-side only for the daemon's
 * machine-PAT bundle fetch (`/api/client/runtime-config`), same blast-radius
 * rules as the deploy bundle.
 */

/**
 * The API flavor the provider endpoint speaks. How each harness consumes it:
 * claude-code always speaks Anthropic Messages (base URL + bearer token);
 * codex always speaks OpenAI (Responses-only in current builds); dsh's pi-ai
 * routes take either (`anthropic-messages` / `openai-completions`).
 */
export const providerApiSchema = z.enum(['anthropic-messages', 'openai']);
export type ProviderApi = z.infer<typeof providerApiSchema>;

/** Which api flavors each runtime target can be pointed at (form + route gate). */
export const RUNTIME_API_SUPPORT: Record<RuntimeTarget, readonly ProviderApi[]> = {
  'claude-code': ['anthropic-messages'],
  codex: ['openai'],
  deepseek: ['anthropic-messages', 'openai'],
};

export const runtimeConfigSpecSchema = z.object({
  /** Display label only — surfaces in the harness's own config UI. */
  providerLabel: z.string().min(1).max(64),
  /** Omit = the provider's default endpoint (Anthropic / OpenAI proper). */
  baseUrl: z.string().url().max(512).optional(),
  api: providerApiSchema,
  model: z.string().min(1).max(128),
  /** Handle of the distributable credential carrying the API key. */
  credentialName: z.string().min(1).max(64),
  /** Target-specific extras (kept schema-loose on purpose). */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type RuntimeConfigSpec = z.infer<typeof runtimeConfigSpecSchema>;

/** REST view of a stored runtime config — echoes `credentialName`, never a secret. */
export const runtimeConfigViewSchema = runtimeConfigSpecSchema.extend({
  machineId: z.string().min(1),
  target: runtimeTargetSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RuntimeConfigView = z.infer<typeof runtimeConfigViewSchema>;

/**
 * The daemon's resolved bundle (`GET /api/client/runtime-config?target=` —
 * machine PAT only). The plaintext exists in this response and in the daemon's
 * memory, nowhere else on the wire.
 */
export const runtimeConfigBundleSchema = z.object({
  target: runtimeTargetSchema,
  spec: runtimeConfigSpecSchema,
  secret: z.string().min(1),
});
export type RuntimeConfigBundle = z.infer<typeof runtimeConfigBundleSchema>;

/**
 * Route-level spec policy (the zod schema is kind-agnostic on purpose, like
 * AVAILABLE_KINDS in the resources route). Returns a rejection reason or null.
 *  - api flavor must be one the target speaks;
 *  - deepseek routes are NOT in the pi-ai catalog — they must name an endpoint.
 */
export function runtimeSpecUnsupportedReason(
  target: RuntimeTarget,
  spec: RuntimeConfigSpec,
): string | null {
  if (!RUNTIME_API_SUPPORT[target].includes(spec.api)) {
    return `target '${target}' cannot speak the '${spec.api}' API (supported: ${RUNTIME_API_SUPPORT[
      target
    ].join(', ')})`;
  }
  if (target === 'deepseek' && spec.baseUrl === undefined) {
    return "deepseek provider routes must set a baseUrl (dsh's route is not in the installed catalog, so it has no default endpoint)";
  }
  return null;
}

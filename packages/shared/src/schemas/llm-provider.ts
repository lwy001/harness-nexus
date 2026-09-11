import { z } from 'zod';
import type { RuntimeTarget } from './inventory.js';
import type { ProviderApi } from './runtime-config.js';

/**
 * LLM provider management (Phase 9 W10) — cc-switch-style reusable provider
 * routes for the W3 provider-config push. The provider is the ROUTE, never
 * the secret: the API key lives in the Credential store, referenced by name.
 * See docs/design/phase-9-w10-llm-providers.md.
 */

/**
 * The API kind the provider endpoint speaks — FINER-grained than the W3 spec
 * flavor, because the "openai" bucket splits at the wire: codex is
 * Responses-only (codex-rs removed chat), dsh's pi-ai speaks chat
 * completions (`openai-completions`) or Anthropic Messages.
 */
export const providerApiKindSchema = z.enum(['openai-chat', 'openai-responses', 'anthropic']);
export type ProviderApiKind = z.infer<typeof providerApiKindSchema>;

/**
 * Which provider api kinds each runtime target can be pointed at (machine
 * page filter + design §3.2):
 *   claude-code — Anthropic Messages only;
 *   codex       — Responses only;
 *   deepseek    — pi-ai KnownApi is anthropic-messages | openai-completions.
 */
export const PROVIDER_API_SUPPORT: Record<RuntimeTarget, readonly ProviderApiKind[]> = {
  'claude-code': ['anthropic'],
  codex: ['openai-responses'],
  deepseek: ['anthropic', 'openai-chat'],
};

/** Map a provider kind onto the W3 spec flavor (writers keyed on it stay untouched). */
export function providerApiToSpecApi(kind: ProviderApiKind): ProviderApi {
  return kind === 'anthropic' ? 'anthropic-messages' : 'openai';
}

/** Official endpoints used when a provider sets no baseUrl. */
export const PROVIDER_DEFAULT_BASE_URLS: Record<ProviderApiKind, string> = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

/**
 * Candidate models-list URLs for a kind + base, in try order (pure — unit
 * tested without I/O). cc-switch semantics: request the endpoint's
 * `/v1/models`. Gateways exist in both shapes, so an openai base without a
 * trailing `/v1` tries `{base}/v1/models` first, then bare `{base}/models`;
 * Anthropic's listing lives at `{base}/v1/models`.
 */
export function providerModelsUrls(api: ProviderApiKind, baseUrl?: string): string[] {
  const base = (baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[api]).replace(/\/+$/, '');
  if (api === 'anthropic') return [`${base}/v1/models?limit=1000`];
  return base.endsWith('/v1') ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
}

export const llmProviderCreateSchema = z.object({
  name: z.string().min(1).max(64),
  api: providerApiKindSchema,
  /** Omit = the kind's official endpoint. */
  baseUrl: z.string().url().max(512).optional(),
  /** Handle of the Credential carrying the API key. */
  credentialName: z.string().min(1).max(64),
  scope: z.enum(['global', 'personal']).default('personal'),
});
export type LlmProviderCreateInput = z.input<typeof llmProviderCreateSchema>;

/**
 * PATCH body — `scope` is deliberately absent (immutable, like a resource's
 * kind/scope); `baseUrl: null` clears the override. Mutate-by-recreate to
 * re-scope.
 */
export const llmProviderUpdateSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    api: providerApiKindSchema.optional(),
    baseUrl: z.string().url().max(512).nullable().optional(),
    credentialName: z.string().min(1).max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty update' });
export type LlmProviderUpdateInput = z.input<typeof llmProviderUpdateSchema>;

/** REST view — echoes `credentialName`, never a secret. */
export const llmProviderViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  api: providerApiKindSchema,
  baseUrl: z.string().url().max(512).nullable(),
  credentialName: z.string().min(1).max(64),
  scope: z.enum(['global', 'personal']),
  ownerId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LlmProviderView = z.infer<typeof llmProviderViewSchema>;

/** One discovered model id (cc-switch 获取模型). `name` is the display name when the endpoint offers one. */
export const llmModelInfoSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
});
export type LlmModelInfo = z.infer<typeof llmModelInfoSchema>;

export const PROVIDER_MODELS_MAX = 1000;

/**
 * Query body for model-list discovery: `{providerId}` (a stored row) OR
 * explicit `{api, baseUrl?, credentialName}` — the explicit arm serves the
 * create dialog and the machine page's manual mode BEFORE anything is saved.
 */
export const providerModelsQuerySchema = z
  .object({
    providerId: z.string().min(1).optional(),
    api: providerApiKindSchema.optional(),
    baseUrl: z.string().url().max(512).optional(),
    credentialName: z.string().min(1).max(64).optional(),
  })
  .refine(
    (v) => v.providerId !== undefined || (v.api !== undefined && v.credentialName !== undefined),
    { message: 'either providerId, or api + credentialName, is required' },
  );
export type ProviderModelsQueryInput = z.input<typeof providerModelsQuerySchema>;

export const providerModelsResultSchema = z.object({
  models: z.array(llmModelInfoSchema).max(PROVIDER_MODELS_MAX),
});
export type ProviderModelsResult = z.infer<typeof providerModelsResultSchema>;

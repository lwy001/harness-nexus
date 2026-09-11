import { describe, expect, it } from 'vitest';
import {
  llmProviderCreateSchema,
  llmProviderUpdateSchema,
  PROVIDER_API_SUPPORT,
  providerApiKindSchema,
  providerApiToSpecApi,
  providerModelsQuerySchema,
  providerModelsUrls,
  providerModelsResultSchema,
  PROVIDER_DEFAULT_BASE_URLS,
  runtimeConfigSpecSchema,
} from '../src/index.js';

/** Phase 9 W10 — provider kinds, the per-Agent support matrix, model-query URL shapes. */

const validProvider = {
  name: 'team-gateway',
  api: 'openai-responses',
  baseUrl: 'https://gw.example.com/v1',
  credentialName: 'gw-key',
};

describe('providerApiKindSchema + support matrix', () => {
  it('accepts exactly the three kinds', () => {
    for (const kind of ['openai-chat', 'openai-responses', 'anthropic']) {
      expect(providerApiKindSchema.safeParse(kind).success).toBe(true);
    }
    expect(providerApiKindSchema.safeParse('openai').success).toBe(false);
  });

  it('maps each Agent onto the kinds it can speak', () => {
    expect(PROVIDER_API_SUPPORT['claude-code']).toEqual(['anthropic']);
    expect(PROVIDER_API_SUPPORT.codex).toEqual(['openai-responses']);
    // pi-ai KnownApi is anthropic-messages | openai-completions — no Responses.
    expect(PROVIDER_API_SUPPORT.deepseek).toEqual(['anthropic', 'openai-chat']);
  });

  it('maps kinds onto the W3 spec flavors', () => {
    expect(providerApiToSpecApi('anthropic')).toBe('anthropic-messages');
    expect(providerApiToSpecApi('openai-chat')).toBe('openai');
    expect(providerApiToSpecApi('openai-responses')).toBe('openai');
  });
});

describe('llmProviderCreateSchema / updateSchema', () => {
  it('defaults scope to personal and accepts a baseUrl-less provider', () => {
    const parsed = llmProviderCreateSchema.parse({
      name: 'official',
      api: 'anthropic',
      credentialName: 'k',
    });
    expect(parsed.scope).toBe('personal');
  });

  it('rejects a malformed baseUrl', () => {
    expect(llmProviderCreateSchema.safeParse({ ...validProvider, baseUrl: 'nope' }).success).toBe(
      false,
    );
  });

  it('update accepts baseUrl:null (clear) but rejects an empty body', () => {
    expect(llmProviderUpdateSchema.safeParse({ baseUrl: null }).success).toBe(true);
    expect(llmProviderUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe('providerModelsUrls', () => {
  it('appends /models when the base already ends with /v1', () => {
    expect(providerModelsUrls('openai-chat', 'https://gw.example.com/v1')).toEqual([
      'https://gw.example.com/v1/models',
    ]);
  });

  it('tries /v1/models first on a bare base, then bare /models', () => {
    expect(providerModelsUrls('openai-responses', 'https://gw.example.com')).toEqual([
      'https://gw.example.com/v1/models',
      'https://gw.example.com/models',
    ]);
  });

  it('falls back to the official endpoints and normalizes trailing slashes', () => {
    expect(providerModelsUrls('anthropic')).toEqual([
      `${PROVIDER_DEFAULT_BASE_URLS.anthropic}/v1/models?limit=1000`,
    ]);
    expect(providerModelsUrls('openai-chat', 'https://api.openai.com/v1///')).toEqual([
      'https://api.openai.com/v1/models',
    ]);
  });
});

describe('providerModelsQuerySchema', () => {
  it('accepts a stored providerId OR explicit api + credentialName', () => {
    expect(providerModelsQuerySchema.safeParse({ providerId: 'p1' }).success).toBe(true);
    expect(
      providerModelsQuerySchema.safeParse({ api: 'anthropic', credentialName: 'k' }).success,
    ).toBe(true);
  });

  it('rejects a body with neither arm', () => {
    expect(providerModelsQuerySchema.safeParse({ api: 'anthropic' }).success).toBe(false);
    expect(providerModelsQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('runtimeConfigSpecSchema — W10 additions', () => {
  const base = {
    providerLabel: 'team gateway',
    api: 'openai',
    model: 'gw-large',
    credentialName: 'gw-key',
  };

  it('accepts optional providerId + models and stays valid without them', () => {
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, providerId: 'p1', models: ['a', 'b'] }).success,
    ).toBe(true);
    expect(runtimeConfigSpecSchema.safeParse(base).success).toBe(true);
  });

  it('bounds the models list', () => {
    expect(
      runtimeConfigSpecSchema.safeParse({ ...base, models: Array(17).fill('m') }).success,
    ).toBe(false);
    expect(runtimeConfigSpecSchema.safeParse({ ...base, models: [''] }).success).toBe(false);
  });

  it('caps the discovered model list result', () => {
    expect(providerModelsResultSchema.safeParse({ models: [] }).success).toBe(true);
    expect(providerModelsResultSchema.safeParse({ models: [{ id: '' }] }).success).toBe(false);
  });
});

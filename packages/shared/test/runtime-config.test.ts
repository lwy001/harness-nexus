import { describe, expect, it } from 'vitest';
import {
  createMachineJobSchema,
  harnessJobPayloadSchema,
  harnessResultDataSchema,
  runtimeConfigGetRequestSchema,
  runtimeConfigSpecSchema,
  runtimeConfigViewEventSchema,
  runtimeSpecUnsupportedReason,
  RUNTIME_API_SUPPORT,
} from '../src/index.js';

/** Phase 9 W3 — the provider-config spec, its per-target policy, and the apply-config job arm. */

const validSpec = {
  providerLabel: 'team gateway',
  baseUrl: 'https://gw.example.com/v1',
  api: 'openai',
  model: 'gpt-5',
  credentialName: 'gw-key',
};

describe('runtimeConfigSpecSchema', () => {
  it('accepts a full spec and a baseUrl-less one', () => {
    expect(runtimeConfigSpecSchema.safeParse(validSpec).success).toBe(true);
    expect(runtimeConfigSpecSchema.safeParse({ ...validSpec, baseUrl: undefined }).success).toBe(
      true,
    );
  });

  it('rejects a malformed baseUrl and empty required fields', () => {
    expect(runtimeConfigSpecSchema.safeParse({ ...validSpec, baseUrl: 'not-a-url' }).success).toBe(
      false,
    );
    expect(runtimeConfigSpecSchema.safeParse({ ...validSpec, model: '' }).success).toBe(false);
    expect(runtimeConfigSpecSchema.safeParse({ ...validSpec, credentialName: '' }).success).toBe(
      false,
    );
  });
});

describe('runtimeSpecUnsupportedReason', () => {
  it('bounds each target to the api flavors it speaks', () => {
    expect(RUNTIME_API_SUPPORT['claude-code']).toEqual(['anthropic-messages']);
    expect(RUNTIME_API_SUPPORT.codex).toEqual(['openai']);
    expect(RUNTIME_API_SUPPORT.deepseek).toContain('openai');
  });

  it('rejects flavor mismatches (claude-code cannot speak openai)', () => {
    expect(runtimeSpecUnsupportedReason('claude-code', { ...validSpec, api: 'openai' })).toContain(
      'cannot speak',
    );
    expect(
      runtimeSpecUnsupportedReason('codex', { ...validSpec, api: 'anthropic-messages' }),
    ).toContain('cannot speak');
  });

  it('demands a baseUrl for deepseek (its route is not in the pi-ai catalog)', () => {
    const spec = { ...validSpec, api: 'openai' as const, baseUrl: undefined };
    expect(runtimeSpecUnsupportedReason('deepseek', spec)).toContain('baseUrl');
    expect(runtimeSpecUnsupportedReason('deepseek', validSpec)).toBeNull();
    // claude-code/codex may omit it (provider default endpoint).
    expect(
      runtimeSpecUnsupportedReason('claude-code', {
        ...validSpec,
        baseUrl: undefined,
        api: 'anthropic-messages' as const,
      }),
    ).toBeNull();
    expect(runtimeSpecUnsupportedReason('codex', { ...validSpec, baseUrl: undefined })).toBeNull();
  });
});

describe('apply-config job arm', () => {
  it('accepts apply-config without a version; rejects it with one', () => {
    expect(
      harnessJobPayloadSchema.safeParse({
        type: 'harness',
        action: 'apply-config',
        target: 'codex',
      }).success,
    ).toBe(true);
    expect(
      harnessJobPayloadSchema.safeParse({
        type: 'harness',
        action: 'apply-config',
        target: 'codex',
        version: '1.0.0',
      }).success,
    ).toBe(false);
  });

  it('rides the REST job union (the route layer points callers at the PUT surface)', () => {
    const parsed = createMachineJobSchema.safeParse({
      type: 'harness',
      action: 'apply-config',
      target: 'deepseek',
    });
    expect(parsed.success).toBe(true);
  });

  it('result data carries the written files arm', () => {
    expect(
      harnessResultDataSchema.safeParse({
        target: 'codex',
        action: 'apply-config',
        files: ['~/.codex/config.toml', '~/.codex/auth.json'],
      }).success,
    ).toBe(true);
    // install results keep working unchanged
    expect(
      harnessResultDataSchema.safeParse({ target: 'codex', action: 'pin', version: '0.12.0' })
        .success,
    ).toBe(true);
  });
});

describe('runtime:config view events (W4)', () => {
  it('validates the request shape', () => {
    expect(
      runtimeConfigGetRequestSchema.safeParse({ requestId: 'r1', target: 'codex' }).success,
    ).toBe(true);
    expect(
      runtimeConfigGetRequestSchema.safeParse({ requestId: 'r1', target: 'hermes' }).success,
    ).toBe(false);
    expect(runtimeConfigGetRequestSchema.safeParse({ requestId: '' }).success).toBe(false);
  });

  it('validates the reply (files + redacted list, or the error arm)', () => {
    const ok = runtimeConfigViewEventSchema.safeParse({
      requestId: 'r1',
      target: 'codex',
      files: [
        { path: '~/.codex/auth.json', content: '{\\n  "OPENAI_API_KEY": "\\${redacted}"\\n}\\n' },
      ],
      redacted: ['~/.codex/auth.json:OPENAI_API_KEY'],
    });
    expect(ok.success).toBe(true);
    // redacted defaults to [] when absent
    const minimal = runtimeConfigViewEventSchema.parse({ requestId: 'r2', target: 'deepseek' });
    expect(minimal.redacted).toEqual([]);
    const errored = runtimeConfigViewEventSchema.safeParse({
      requestId: 'r3',
      target: 'codex',
      error: 'read failed',
    });
    expect(errored.success).toBe(true);
    // oversized content is rejected (the wire cap is the backstop)
    expect(
      runtimeConfigViewEventSchema.safeParse({
        requestId: 'r4',
        target: 'codex',
        files: [{ path: 'x', content: 'a'.repeat(131073) }],
      }).success,
    ).toBe(false);
  });
});

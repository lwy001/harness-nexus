import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyRuntimeConfig,
  mergeEnvLine,
  mergeTomlRootKeys,
  runApplyConfigJob,
} from '../src/daemon/runtime-config.js';

/**
 * Provider-config writers (Phase 9 W3) against fixture HOMEs with planted
 * USER content — the load-bearing property is merge preservation: everything
 * outside the platform's managed keys/regions survives byte-for-byte, and
 * re-applying is idempotent. Ground truth per target in the W3 research notes.
 */

let home: string;

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hnx-rc-'));
});
afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const spec = (over: Record<string, unknown> = {}): never =>
  ({
    providerLabel: 'team gateway',
    baseUrl: 'https://gw.example.com/v1',
    api: 'openai',
    model: 'gw-large',
    credentialName: 'gw-key',
    ...over,
  }) as never;

function writeRel(rel: string, content: string): string {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return file;
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

describe('mergeTomlRootKeys', () => {
  it('sets keys in an empty document', () => {
    expect(mergeTomlRootKeys('', { model: 'a', model_provider: 'b' })).toBe(
      'model = "a"\nmodel_provider = "b"\n',
    );
  });

  it('replaces existing top-level keys in place and preserves sections + comments', () => {
    const doc = [
      '# user comment',
      'model = "old"',
      '',
      '[profiles.work]',
      'model = "profile-model"',
      '',
      '[mcp_servers.user-thing]',
      'command = "keep"',
    ].join('\n');
    const out = mergeTomlRootKeys(doc, { model: 'new', model_provider: 'harness_nexus' });
    expect(out).toContain('# user comment');
    expect(out).toContain('model = "new"');
    expect(out).toContain('model_provider = "harness_nexus"');
    expect(out).toContain('[profiles.work]');
    expect(out).toContain('model = "profile-model"'); // section key untouched
    expect(out).toContain('command = "keep"');
    // root keys must precede the first section header
    expect(out.indexOf('model_provider =')).toBeLessThan(out.indexOf('[profiles.work]'));
  });

  it('inserts missing keys before the first section header when only sections exist', () => {
    const doc = '[servers.alpha]\nurl = "x"\n';
    const out = mergeTomlRootKeys(doc, { model: 'm' });
    expect(out.startsWith('model = "m"')).toBe(true);
    expect(out).toContain('[servers.alpha]');
  });
});

describe('mergeEnvLine', () => {
  it('appends to an empty file and replaces its own line while keeping others', () => {
    expect(mergeEnvLine('', 'K', 'v1')).toBe('K=v1\n');
    const doc = 'OTHER=1\n\nK=old\n# comment\n';
    const out = mergeEnvLine(doc, 'K', 'v2');
    expect(out).toBe('OTHER=1\n\nK=v2\n# comment\n');
  });
});

describe('applyRuntimeConfig — claude-code', () => {
  it('merges settings.json (user keys survive), 0600, idempotent', () => {
    const file = writeRel(
      '.claude/settings.json',
      JSON.stringify({ permissions: { allow: ['Bash'] }, env: { CUSTOM: 'keep' } }),
    );
    const { files } = applyRuntimeConfig(
      'claude-code',
      spec({ api: 'anthropic-messages' }),
      'sk-ant-secret',
      home,
    );
    expect(files).toEqual(['~/.claude/settings.json']);
    const first = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect((first.permissions as { allow: string[] }).allow).toEqual(['Bash']);
    expect((first.env as Record<string, string>).CUSTOM).toBe('keep');
    expect((first.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe('sk-ant-secret');
    expect((first.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe(
      'https://gw.example.com/v1',
    );
    expect(first.model).toBe('gw-large');
    expect(mode(file)).toBe(0o600);

    applyRuntimeConfig('claude-code', spec({ api: 'anthropic-messages' }), 'sk-ant-secret', home);
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(first, null, 2) + '\n');
  });

  it('a baseUrl-less re-apply REMOVES the managed base URL but keeps user env', () => {
    applyRuntimeConfig('claude-code', spec({ api: 'anthropic-messages' }), 'k', home);
    applyRuntimeConfig(
      'claude-code',
      spec({ api: 'anthropic-messages', baseUrl: undefined }),
      'k',
      home,
    );
    const settings = JSON.parse(readFileSync(path.join(home, '.claude/settings.json'), 'utf8')) as {
      env: Record<string, string>;
    };
    expect(settings.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(settings.env.CUSTOM).toBe('keep');
  });

  it('refuses to clobber an unparseable settings file', () => {
    const bad = mkdtempSync(path.join(tmpdir(), 'hnx-rc-bad-'));
    mkdirSync(path.join(bad, '.claude'), { recursive: true });
    writeFileSync(path.join(bad, '.claude/settings.json'), 'not json', 'utf8');
    expect(() => applyRuntimeConfig('claude-code', spec(), 'k', bad)).toThrow(/not valid JSON/);
    rmSync(bad, { recursive: true, force: true });
  });
});

describe('applyRuntimeConfig — codex', () => {
  it('writes root keys + provider section + auth.json merge-preservingly, idempotent', () => {
    const cfg = writeRel(
      '.codex/config.toml',
      '# my config\n[profiles.fast]\nmodel = "fast"\n\n[mcp_servers.mine]\ncommand = "keep"\n',
    );
    const { files } = applyRuntimeConfig('codex', spec(), 'sk-codex', home);
    expect(files).toEqual(['~/.codex/config.toml', '~/.codex/auth.json']);

    const toml = readFileSync(cfg, 'utf8');
    expect(toml).toContain('# my config');
    expect(toml).toContain('model = "gw-large"');
    expect(toml).toContain('model_provider = "harness_nexus"');
    expect(toml).toContain('[model_providers.harness_nexus]');
    expect(toml).toContain('base_url = "https://gw.example.com/v1"');
    expect(toml).toContain('requires_openai_auth = true');
    // wire_api deliberately absent: current codex removed `chat` — every route speaks Responses.
    expect(toml).not.toContain('wire_api');
    expect(toml).toContain('[mcp_servers.mine]');

    const authFile = path.join(home, '.codex/auth.json');
    writeRel('.codex/auth.json', JSON.stringify({ tokens: { id_token: 'user-login' } }));
    applyRuntimeConfig('codex', spec(), 'sk-codex-2', home);
    const auth = JSON.parse(readFileSync(authFile, 'utf8')) as Record<string, unknown>;
    expect(auth.auth_mode).toBe('apikey');
    expect(auth.OPENAI_API_KEY).toBe('sk-codex-2');
    expect((auth.tokens as { id_token: string }).id_token).toBe('user-login');
    expect(mode(authFile)).toBe(0o600);

    applyRuntimeConfig('codex', spec(), 'sk-codex-2', home);
    expect(readFileSync(cfg, 'utf8')).toBe(toml);
  });

  it('omits base_url when the spec has none (OpenAI proper + managed key)', () => {
    applyRuntimeConfig('codex', spec({ baseUrl: undefined }), 'k', home);
    const toml = readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
    expect(toml).not.toContain('base_url');
    expect(toml).toContain('requires_openai_auth = true');
  });
});

describe('applyRuntimeConfig — deepseek', () => {
  it('writes the settings layer (llm-pi-ai route + default-model) + ~/.dsh/.env', () => {
    // A pre-existing patch carrying the W3-era provider region (it crashed
    // the ACP profile by double-registering plugins) plus a user region.
    writeRel(
      '.dsh/cordis.patch.yml',
      [
        '# user rows',
        '- insert:',
        '    - id: user-row',
        "      name: '@deepseek-ai/dsh-something'",
        '# BEGIN harness-nexus:provider (managed) — rewritten by hnx; keep edits outside the markers',
        '- insert:',
        '    - id: hnx-llm',
        "      name: '@deepseek-ai/dsh-llm-pi-ai'",
        '# END harness-nexus:provider (managed)',
      ].join('\n') + '\n',
    );
    writeRel('.dsh/.env', 'DEEPSEEK_API_KEY=user-key\n');

    const { files } = applyRuntimeConfig(
      'deepseek',
      spec({ api: 'anthropic-messages' }),
      'sk-dsh',
      home,
    );
    // settings + .env always; the patch only appears because we retired the legacy region.
    expect(files).toEqual(['~/.dsh/cordis.patch.yml', '~/.dsh/settings.yaml', '~/.dsh/.env']);

    const settings = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    expect(settings).toContain('# BEGIN harness-nexus (managed)');
    expect(settings).toContain('llm-pi-ai:');
    expect(settings).toContain('providers:');
    expect(settings).toContain('harness-nexus:');
    expect(settings).toContain('displayName: "team gateway"');
    expect(settings).toContain('api: anthropic-messages');
    expect(settings).toContain('baseURL: "https://gw.example.com/v1"');
    expect(settings).toContain('apiKeyEnv: HARNESS_NEXUS_API_KEY');
    expect(settings).toContain('- id: "gw-large"');
    expect(settings).toContain('agent-default-model:');
    expect(settings).toContain('provider: harness-nexus');

    const patch = readFileSync(path.join(home, '.dsh/cordis.patch.yml'), 'utf8');
    expect(patch).toContain('# user rows');
    expect(patch).toContain('user-row');
    expect(patch).not.toContain('hnx-llm');
    expect(patch).not.toContain('harness-nexus:provider');

    const envDoc = readFileSync(path.join(home, '.dsh/.env'), 'utf8');
    expect(envDoc).toContain('DEEPSEEK_API_KEY=user-key');
    expect(envDoc).toContain('HARNESS_NEXUS_API_KEY=sk-dsh');
    expect(mode(path.join(home, '.dsh/.env'))).toBe(0o600);

    // Idempotent re-apply (both api flavors map); user settings outside markers survive.
    applyRuntimeConfig('deepseek', spec({ api: 'openai' }), 'sk-dsh', home);
    const settings2 = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    expect(settings2).toContain('api: openai-completions');
    expect((settings2.match(/BEGIN harness-nexus \(managed\)/g) ?? []).length).toBe(1);
    expect((settings2.match(/^llm-pi-ai:$/gm) ?? []).length).toBe(1);
  });

  it('refuses a hand-managed namespace section (duplicate keys would brick boot)', () => {
    const bad = mkdtempSync(path.join(tmpdir(), 'hnx-rc-dup-'));
    mkdirSync(path.join(bad, '.dsh'), { recursive: true });
    writeFileSync(
      path.join(bad, '.dsh/settings.yaml'),
      'llm-pi-ai:\n  providers:\n    mine: {}\n',
      'utf8',
    );
    expect(() => applyRuntimeConfig('deepseek', spec(), 'k', bad)).toThrow(/hand-managed/);
    expect(readFileSync(path.join(bad, '.dsh/settings.yaml'), 'utf8')).toBe(
      'llm-pi-ai:\n  providers:\n    mine: {}\n',
    );
    rmSync(bad, { recursive: true, force: true });
  });

  it('an emptied legacy patch normalizes to [] (an empty doc is a boot error)', () => {
    const only = mkdtempSync(path.join(tmpdir(), 'hnx-rc-only-'));
    mkdirSync(path.join(only, '.dsh'), { recursive: true });
    writeFileSync(
      path.join(only, '.dsh/cordis.patch.yml'),
      [
        '# BEGIN harness-nexus:provider (managed) — rewritten by hnx; keep edits outside the markers',
        '- insert:',
        '# END harness-nexus:provider (managed)',
      ].join('\n') + '\n',
      'utf8',
    );
    applyRuntimeConfig('deepseek', spec(), 'k', only);
    expect(readFileSync(path.join(only, '.dsh/cordis.patch.yml'), 'utf8')).toBe('[]\n');
    rmSync(only, { recursive: true, force: true });
  });

  it('refuses a baseUrl-less deepseek spec (no catalog default for our route)', () => {
    const before = readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8');
    expect(() => applyRuntimeConfig('deepseek', spec({ baseUrl: undefined }), 'k', home)).toThrow(
      /baseUrl/,
    );
    expect(readFileSync(path.join(home, '.dsh/settings.yaml'), 'utf8')).toBe(before);
  });
});

/** Minimal socket recorder (same trick as the W2 runtime-job tests). */
class FakeSocket extends EventEmitter {
  sent: { event: string; payload: unknown }[] = [];
  override emit(event: string, payload: unknown): boolean {
    this.sent.push({ event, payload });
    return true;
  }
  last<T = never>(event: string): { payload: T } | undefined {
    const hit = [...this.sent].reverse().find((e) => e.event === event);
    return hit as { payload: T } | undefined;
  }
}

describe('runApplyConfigJob', () => {
  it('settles a malformed payload as a failed job (never hangs the daemon)', async () => {
    const sock = new FakeSocket();
    await runApplyConfigJob(
      sock as never,
      { server: 'http://127.0.0.1:1', token: 'x' },
      { id: 'j1', payload: { type: 'harness', action: 'install', target: 'codex' } } as never,
      home,
    );
    const result = sock.last<{ ok: boolean; error?: string }>('job:result')!.payload;
    expect(result.ok).toBe(false);
    expect(result.error).toBe('harness payload invalid');
  });
});

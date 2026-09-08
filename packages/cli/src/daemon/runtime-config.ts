import { homedir } from 'node:os';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import {
  harnessJobPayloadSchema,
  harnessResultDataSchema,
  type JobView,
  type RuntimeConfigSpec,
} from '@harness-nexus/shared';
import { HarnessNexusClient } from '@harness-nexus/sdk';
import {
  mergeManagedPatchRegion,
  beginMarker,
  endMarker,
  DSH_PATCH_FILENAME,
} from '../install/adapters/deepseek.js';
import { mergeTomlSection } from '../install/adapters/codex.js';

/**
 * Provider-config apply (Phase 9 W3) — the daemon half of
 * docs/design/phase-9-harness-runtime.md §4.3.
 *
 * `apply-config` harness jobs fetch the resolved `{spec, secret}` bundle with
 * the machine PAT (execution-time resolution: a requeued job after a spec or
 * credential edit applies the CURRENT value) and write each harness's NATIVE
 * slots. All writes are merge-preserving and idempotent (re-apply = upgrade);
 * every touched file ends 0600. Ground truth per target:
 *
 *  - claude-code: `~/.claude/settings.json` — `env.ANTHROPIC_BASE_URL` (only
 *    while the spec sets one; a later unset REMOVES ours), `env.ANTHROPIC_AUTH_TOKEN`
 *    (the key), top-level `model` (base URL alone doesn't switch the model).
 *  - codex: `~/.codex/config.toml` — root keys `model` + `model_provider`, and
 *    the `[model_providers.harness_nexus]` block with `requires_openai_auth =
 *    true` (the built-in provider's own shape — auth comes from auth.json, no
 *    env var). `~/.codex/auth.json` — apikey mode with the key as
 *    `OPENAI_API_KEY`. `wire_api` is NOT set: current codex removed `chat`, so
 *    every route speaks Responses — gateways must be Responses-compatible.
 *  - deepseek: a managed region in the home `cordis.patch.yml` (sibling of the
 *    T1 MCP regions) mounting `@deepseek-ai/dsh-llm-pi-ai` with the provider
 *    route AND `@deepseek-ai/dsh-agent-default-model` pointing fresh agents at
 *    it (mounting a route alone doesn't select it). The key goes to
 *    `~/.dsh/.env` under `HARNESS_NEXUS_API_KEY` — dsh's own user-env
 *    credential layer, read on EVERY launch (user shells included; no wrapper
 *    or shell snippet needed). `apiKeyEnv` names it in the patch row.
 */

/** dsh resolves this name through process env > ~/.dsh/.credentials.yaml > ./.env > ~/.dsh/.env. */
const DSH_API_KEY_ENV = 'HARNESS_NEXUS_API_KEY';

/** codex provider id — also the `model_provider` root key value. */
const CODEX_PROVIDER_ID = 'harness_nexus';

const PROVIDER_REGION = 'provider';

function readJson(file: string): Record<string, unknown> {
  let raw = '{}';
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return {}; // absent file — nothing to merge
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `${file} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — fix or remove it and re-apply`,
    );
  }
}

function writeSecretFile(file: string, content: string): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, content, 'utf8');
  chmodSync(file, 0o600);
  return file;
}

/** Display path (`~/.codex/config.toml`) for job result data — never leaks the home dir. */
const display = (homeDir: string, file: string): string =>
  `~${file.startsWith(homeDir) ? file.slice(homeDir.length) : file}`;

// ---- claude-code ----

function applyClaudeConfig(spec: RuntimeConfigSpec, secret: string, homeDir: string): string[] {
  const dir = join(homeDir, '.claude');
  const file = join(dir, 'settings.json');
  const settings = readJson(file);
  const env: Record<string, string> = {
    ...((settings.env as Record<string, string> | undefined) ?? {}),
    ANTHROPIC_AUTH_TOKEN: secret,
  };
  if (spec.baseUrl !== undefined) env.ANTHROPIC_BASE_URL = spec.baseUrl;
  else delete env.ANTHROPIC_BASE_URL; // the platform owns the route — unset means revert to default
  writeSecretFile(file, `${JSON.stringify({ ...settings, env, model: spec.model }, null, 2)}\n`);
  return [display(homeDir, file)];
}

// ---- codex ----

/**
 * Set TOP-LEVEL `key = "value"` pairs in a TOML document, preserving every
 * other byte. Only the region before the first `[section]` header is ours to
 * edit (a `model` inside a section belongs to that section); missing keys are
 * appended to that region. JSON string escaping is valid TOML basic-string
 * escaping.
 */
export function mergeTomlRootKeys(existing: string, values: Record<string, string>): string {
  const headerRe = /^\s*\[/;
  const lines = existing.split('\n');
  const firstHeader = lines.findIndex((l) => headerRe.test(l));
  const topEnd = firstHeader === -1 ? lines.length : firstHeader;
  const top = lines.slice(0, topEnd);
  const rest = lines.slice(topEnd);

  const remaining = new Map(Object.entries(values));
  const rewritten: string[] = [];
  for (const line of top) {
    const key = /^(\s*[A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]?.trim();
    const hit = key !== undefined ? remaining.get(key) : undefined;
    if (key !== undefined && hit !== undefined) {
      rewritten.push(`${key} = ${JSON.stringify(hit)}`);
      remaining.delete(key);
    } else {
      rewritten.push(line);
    }
  }
  // Append missing keys at the end of the top-level region (before trailing
  // blank lines so a header below keeps its spacing).
  let insertAt = rewritten.length;
  while (insertAt > 0 && rewritten[insertAt - 1]!.trim() === '') insertAt--;
  rewritten.splice(
    insertAt,
    0,
    ...[...remaining.entries()].map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
  );

  const out = [...rewritten, ...rest].join('\n').replace(/\s+$/, '');
  return `${out}${out.length > 0 ? '\n' : ''}`;
}

function applyCodexConfig(spec: RuntimeConfigSpec, secret: string, homeDir: string): string[] {
  const dir = join(homeDir, '.codex');
  const cfgPath = join(dir, 'config.toml');
  let cfg = '';
  try {
    cfg = readFileSync(cfgPath, 'utf8');
  } catch {
    cfg = ''; // absent file — fresh document
  }
  const sectionBody = [
    `name = ${JSON.stringify(spec.providerLabel)}`,
    ...(spec.baseUrl !== undefined ? [`base_url = ${JSON.stringify(spec.baseUrl)}`] : []),
    'requires_openai_auth = true',
  ].join('\n');
  cfg = mergeTomlSection(
    mergeTomlRootKeys(cfg, { model: spec.model, model_provider: CODEX_PROVIDER_ID }),
    `model_providers.${CODEX_PROVIDER_ID}`,
    sectionBody,
  );
  writeSecretFile(cfgPath, cfg);

  const authPath = join(dir, 'auth.json');
  const auth = readJson(authPath);
  writeSecretFile(
    authPath,
    `${JSON.stringify({ ...auth, auth_mode: 'apikey', OPENAI_API_KEY: secret }, null, 2)}\n`,
  );
  return [display(homeDir, cfgPath), display(homeDir, authPath)];
}

// ---- deepseek ----

/** Replace (or append) one `KEY=VALUE` line in a dotenv document, preserving the rest. */
export function mergeEnvLine(existing: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  const base = re.test(existing)
    ? existing.replace(re, line)
    : existing.replace(/\s+$/, '') + (existing.trim().length > 0 ? '\n' : '') + line;
  return `${base.replace(/\s+$/, '')}\n`;
}

const DSH_API_MAP: Record<RuntimeConfigSpec['api'], string> = {
  // pi-ai KnownApi values (verified against the installed catalog types).
  'anthropic-messages': 'anthropic-messages',
  openai: 'openai-completions',
};

function applyDshConfig(spec: RuntimeConfigSpec, secret: string, homeDir: string): string[] {
  const dir = join(homeDir, '.dsh');
  const patchPath = join(dir, DSH_PATCH_FILENAME);
  let patch = '';
  try {
    patch = readFileSync(patchPath, 'utf8');
  } catch {
    patch = ''; // absent file — fresh document
  }
  const yq = JSON.stringify; // JSON quoting is valid YAML 1.2 double-quoting
  const block = [
    `${beginMarker(PROVIDER_REGION)} — rewritten by hnx; keep edits outside the markers`,
    `- insert:`,
    `    - id: hnx-llm`,
    `      name: '@deepseek-ai/dsh-llm-pi-ai'`,
    `      config:`,
    `        providers:`,
    `          harness-nexus:`,
    `            displayName: ${yq(spec.providerLabel)}`,
    `            api: ${DSH_API_MAP[spec.api]}`,
    `            baseURL: ${yq(spec.baseUrl!)}`,
    `            apiKeyEnv: ${DSH_API_KEY_ENV}`,
    `            models:`,
    `              - id: ${yq(spec.model)}`,
    `    - id: hnx-default-model`,
    `      name: '@deepseek-ai/dsh-agent-default-model'`,
    `      config:`,
    `        provider: harness-nexus`,
    `        model: ${yq(spec.model)}`,
    endMarker(PROVIDER_REGION),
  ].join('\n');
  writeSecretFile(patchPath, mergeManagedPatchRegion(patch, PROVIDER_REGION, block));

  const envPath = join(dir, '.env');
  let envDoc = '';
  try {
    envDoc = readFileSync(envPath, 'utf8');
  } catch {
    envDoc = '';
  }
  writeSecretFile(envPath, mergeEnvLine(envDoc, DSH_API_KEY_ENV, secret));
  return [display(homeDir, patchPath), display(homeDir, envPath)];
}

/** The per-target native writer — pure file surgery, no I/O beyond the harness homes. */
export function applyRuntimeConfig(
  target: 'claude-code' | 'codex' | 'deepseek',
  spec: RuntimeConfigSpec,
  secret: string,
  homeDir: string,
): { files: string[] } {
  switch (target) {
    case 'claude-code':
      return { files: applyClaudeConfig(spec, secret, homeDir) };
    case 'codex':
      return { files: applyCodexConfig(spec, secret, homeDir) };
    case 'deepseek':
      if (spec.baseUrl === undefined) {
        // The route gate rejects this server-side; the daemon double-checks so
        // a stale queued job fails honestly instead of writing a broken row.
        throw new Error('deepseek provider routes require a baseUrl');
      }
      return { files: applyDshConfig(spec, secret, homeDir) };
  }
}

/**
 * The `apply-config` harness job executor: fetch the resolved bundle with the
 * machine PAT (REST — the secret never rides the job), write the native slots,
 * settle via `job:result`. No runtime re-probe (config files aren't in the
 * snapshot); the redacted read-back viewer is W4.
 */
export async function runApplyConfigJob(
  socket: Socket,
  opts: { server: string; token: string },
  job: JobView,
  homeDir: string = homedir(),
): Promise<void> {
  const parsed = harnessJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success || parsed.data.action !== 'apply-config') {
    socket.emit('job:result', { jobId: job.id, ok: false, error: 'harness payload invalid' });
    return;
  }
  const target = parsed.data.target;
  const progress = (phase: string, message?: string): void => {
    socket.emit('job:progress', { jobId: job.id, phase, ...(message ? { message } : {}) });
  };
  progress('resolve', `fetching provider config for ${target}`);
  try {
    const client = new HarnessNexusClient({ baseUrl: opts.server, token: opts.token });
    const bundle = await client.getRuntimeConfigBundle(target);
    progress('apply', `writing ${target} config`);
    const { files } = applyRuntimeConfig(target, bundle.spec, bundle.secret, homeDir);
    const data = harnessResultDataSchema.parse({ target, action: 'apply-config', files });
    socket.emit('job:result', { jobId: job.id, ok: true, data });
  } catch (e) {
    socket.emit('job:result', {
      jobId: job.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_PATCHES,
  applyAdapterPatches,
  provisionAdapters,
} from '../src/daemon/acp/adapter-provision.js';
import { PINNED_ADAPTER_SPECS } from '../src/daemon/acp/adapters.js';

/**
 * Issue #2 — pinned adapter provisioning: install once into
 * `~/.hnx/acp-adapters` (staging + atomic rename), then keep an idempotent
 * patch set applied to the installed dist. The set-model patch is the
 * rig-validated skip of the redundant `setModel` re-assert on resume.
 */

const PATCH = ADAPTER_PATCHES.find((p) => p.id === 'skip-redundant-setmodel-on-resume')!;
const CLAUDE_MODEL_FILE = join(
  'node_modules',
  '@agentclientprotocol',
  'claude-agent-acp',
  'dist',
  'session-model.js',
);
const ANCHOR = '    const skipSetModel = resolvedFromInput === undefined ||';

/** Seed a (complete or partial) adapter store with the patch target file. */
function seedStore(dir: string, opts: { bins?: boolean; patched?: boolean } = {}): void {
  if (opts.bins !== false) {
    for (const s of PINNED_ADAPTER_SPECS) {
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.bin', s.bin), '#!/bin/sh\n');
    }
  }
  mkdirSync(join(dir, CLAUDE_MODEL_FILE, '..'), { recursive: true });
  writeFileSync(
    join(dir, CLAUDE_MODEL_FILE),
    opts.patched === true
      ? `code();\n${PATCH.replacement}\nmore();\n`
      : `code();\n${ANCHOR}\nmore();\n`,
  );
}

describe('applyAdapterPatches (issue #2)', () => {
  it('applies the anchor replace and becomes idempotent via the marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hnx-provision-'));
    seedStore(dir);
    const r1 = applyAdapterPatches(dir);
    expect(r1.applied).toEqual([PATCH.id]);
    const patched = readFileSync(join(dir, CLAUDE_MODEL_FILE), 'utf8');
    expect(patched).toContain(PATCH.marker);
    // The shape that matters: skip fires when the resumed model matches.
    expect(patched).toContain('const skipSetModel = resumedAlreadyRunning ||');
    const r2 = applyAdapterPatches(dir);
    expect(r2.already).toEqual([PATCH.id]);
    expect(r2.applied).toEqual([]);
  });

  it('counts a hand-patched file (marker, no anchor) as already patched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hnx-provision-'));
    seedStore(dir, { patched: true });
    const r = applyAdapterPatches(dir);
    expect(r.already).toEqual([PATCH.id]);
    expect(r.failed).toEqual([]);
  });

  it('reports — never throws — when the upstream anchor is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hnx-provision-'));
    mkdirSync(join(dir, CLAUDE_MODEL_FILE, '..'), { recursive: true });
    writeFileSync(join(dir, CLAUDE_MODEL_FILE), 'totally reshaped upstream code\n');
    const r = applyAdapterPatches(dir);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.reason).toContain('anchor not found');
  });
});

describe('provisionAdapters (issue #2)', () => {
  it('a complete store only re-checks patches — npm never runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    seedStore(join(home, '.hnx', 'acp-adapters'));
    const r = await provisionAdapters(home, {
      runNpm: () => {
        throw new Error('npm must not run when the store is complete');
      },
    });
    expect(r.installed).toBe(false);
    expect(r.applied).toEqual([PATCH.id]);
  });

  it('a fresh install lands patched and the staging dir is renamed away', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    const r = await provisionAdapters(home, {
      runNpm: async (args) => {
        const prefix = args[args.indexOf('--prefix') + 1]!;
        seedStore(prefix);
      },
    });
    expect(r.installed).toBe(true);
    expect(r.applied).toEqual([PATCH.id]);
    const store = join(home, '.hnx', 'acp-adapters');
    for (const s of PINNED_ADAPTER_SPECS) {
      expect(existsSync(join(store, 'node_modules', '.bin', s.bin))).toBe(true);
    }
    expect(readFileSync(join(store, CLAUDE_MODEL_FILE), 'utf8')).toContain(PATCH.marker);
    // No staging leftovers.
    const hnx = join(home, '.hnx');
    expect(readdir(hnx)).toEqual(['acp-adapters']);
  });

  it('an npm failure cleans the staging dir and reports the error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    const r = await provisionAdapters(home, {
      runNpm: async () => {
        throw new Error('npm install exited 1: network unreachable');
      },
    });
    expect(r.installed).toBe(false);
    expect(r.error).toContain('npm install exited 1');
    expect(existsSync(join(home, '.hnx', 'acp-adapters'))).toBe(false);
    expect(existsSync(join(home, '.hnx', 'acp-adapters.staging-' + String(process.pid)))).toBe(
      false,
    );
  });

  it('exports the version-pinned specs used for both install and npx fallback', () => {
    expect(PINNED_ADAPTER_SPECS).toContainEqual({
      spec: '@agentclientprotocol/claude-agent-acp@0.79.0',
      bin: 'claude-agent-acp',
    });
    expect(PINNED_ADAPTER_SPECS).toContainEqual({
      spec: '@zed-industries/codex-acp@0.16.0',
      bin: 'codex-acp',
    });
  });
});

function readdir(dir: string): string[] {
  return readdirSync(dir).filter((d) => !d.startsWith('acp-adapters.staging'));
}

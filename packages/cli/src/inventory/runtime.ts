import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { RuntimeInfo, RuntimeTarget } from '@harness-nexus/shared';

/**
 * Harness runtime probe (Phase 9 W1) — is the Agent's own software installed,
 * where, at which version, installed how? Kept in lockstep with
 * `RUNTIME_TARGETS` in shared (hermes is unlisted — no runtime management).
 *
 * Metadata only: the probe reads paths and `<bin> --version` output; it never
 * opens config files (those are W4's redacted viewer).
 */

interface RuntimeProbe {
  target: RuntimeTarget;
  bin: string;
  /** Locations a PATH walk misses (checked AFTER the PATH, so the user's PATH wins). */
  knownPaths: (homeDir: string) => string[];
}

export const RUNTIME_PROBES: readonly RuntimeProbe[] = [
  {
    target: 'claude-code',
    bin: 'claude',
    // Native install launcher (~/.local/bin) — the documented native location.
    knownPaths: (home) => [join(home, '.local', 'bin', 'claude')],
  },
  { target: 'codex', bin: 'codex', knownPaths: () => [] },
  { target: 'deepseek', bin: 'dsh', knownPaths: () => [] },
];

export interface ProbeOptions {
  /** Override `process.env.PATH` (tests inject fixture bins). */
  pathEnv?: string;
  homeDir?: string;
  /** Per-`<bin> --version` timeout. Default 5s (a hung binary must not stall a scan). */
  timeoutMs?: number;
}

/** Resolve a bare bin name to an executable path — PATH walk, then known locations. */
export async function findRuntimeBin(
  bin: string,
  opts: Pick<ProbeOptions, 'pathEnv' | 'homeDir'> = {},
): Promise<string | null> {
  const home = opts.homeDir ?? homedir();
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const candidates = [
    ...pathEnv
      .split(delimiter)
      .filter((p) => p.length > 0)
      .map((p) => join(p, bin)),
    ...RUNTIME_PROBES.find((r) => r.bin === bin)!.knownPaths(home),
  ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not there — keep walking
    }
  }
  return null;
}

/**
 * Classify the install method from the REAL bin path (research §5.1): prefix
 * sniff on the symlink-resolved path (npm/brew installs are symlinks into
 * their stores). Best effort — anything unrecognized is `unknown`, never a
 * guess. `npm` is checked first: a user npm-prefix of `~/.local` would
 * otherwise masquerade as the native claude launcher location.
 */
export function classifyInstallMethod(
  resolvedPath: string,
  homeDir: string,
): 'npm' | 'native' | 'brew' | 'unknown' {
  if (resolvedPath.includes('/node_modules/')) return 'npm';
  if (resolvedPath.includes('/Cellar/') || resolvedPath.startsWith('/opt/homebrew/')) return 'brew';
  // The native claude launcher lives in ~/.local/bin and points into ~/.local/share/claude.
  if (resolvedPath.startsWith(join(homeDir, '.local'))) return 'native';
  return 'unknown';
}

/** Run `<bin> --version`, trimmed to the first meaningful line. null = no answer in time. */
async function probeVersion(binPath: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binPath, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n')[0]?.trim() ?? '';
      resolve(line.length > 0 ? line.slice(0, 64) : null);
    });
  });
}

/** Probe one target. */
export async function probeRuntime(
  target: RuntimeTarget,
  opts: ProbeOptions = {},
): Promise<RuntimeInfo> {
  const probe = RUNTIME_PROBES.find((r) => r.target === target)!;
  const homeDir = opts.homeDir ?? homedir();
  const binPath = await findRuntimeBin(probe.bin, opts);
  if (binPath === null) return { target, installed: false };

  let resolved = binPath;
  try {
    resolved = await realpath(binPath);
  } catch {
    // keep the PATH-found path — classification falls back to `unknown`
  }
  const version = await probeVersion(binPath, opts.timeoutMs ?? 5000);
  return {
    target,
    installed: true,
    binPath,
    ...(version !== null ? { version } : {}),
    installMethod: classifyInstallMethod(resolved, homeDir),
  };
}

/** Probe every runtime target in parallel — one pass feeds the whole inventory report. */
export async function probeRuntimes(opts: ProbeOptions = {}): Promise<RuntimeInfo[]> {
  return Promise.all(RUNTIME_PROBES.map((r) => probeRuntime(r.target, opts)));
}

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Daemon configuration (~/.hnx/config.json, 0600). Written by `hnx enroll`,
 * read by `hnx daemon`. The machine token is a capability-scoped PAT
 * (scopes ['machine-ctl']) — REST-rejected, realtime-only — so this file is
 * the single local secret the client keeps (OS keychain later).
 */
export interface HnxDaemonConfig {
  server: string;
  /** Machine PAT (`hnpat_…`), issued once at enrollment. */
  token: string;
  machineId: string;
  machineName?: string;
}

export function daemonConfigPath(): string {
  return join(homedir(), '.hnx', 'config.json');
}

export function loadDaemonConfig(): HnxDaemonConfig | null {
  const path = daemonConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HnxDaemonConfig;
  } catch {
    return null;
  }
}

export function saveDaemonConfig(config: HnxDaemonConfig): void {
  mkdirSync(join(homedir(), '.hnx'), { recursive: true, mode: 0o700 });
  const path = daemonConfigPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on filesystems that ignore modes
  }
}

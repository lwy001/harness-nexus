/**
 * install-state ledger — a JSON record written on every `--apply`, enabling
 * future `doctor` (drift detection) / `repair` / `uninstall` (remove only
 * managed files). Mirrors ECC's `ecc.install.v1` ledger concept (see
 * `docs/research/phase-3-ecc-install-patterns.md` Pattern 5).
 *
 * Phase 3.3 only writes + reads the ledger; the doctor/repair/uninstall
 * subcommands come later.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { InstallPlan } from './types.js';

export const INSTALL_STATE_SCHEMA_VERSION = 'harness-nexus.install.v1';

export interface InstallState {
  schemaVersion: typeof INSTALL_STATE_SCHEMA_VERSION;
  installedAt: string;
  target: { id: string; target: string; kind: string; root: string };
  profile: { id: string; name: string; version: string };
  operations: InstallPlan['operations'];
}

/** Write the ledger to its path inside the target root. */
export function writeInstallState(
  plan: InstallPlan,
  state: Omit<InstallState, 'schemaVersion' | 'operations'>,
): void {
  const full: InstallState = {
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    ...state,
    operations: plan.operations,
  };
  fs.mkdirSync(path.dirname(plan.installStatePath), { recursive: true });
  fs.writeFileSync(plan.installStatePath, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
}

/** Read a previously-written ledger (returns null if absent). */
export function readInstallState(installStatePath: string): InstallState | null {
  if (!fs.existsSync(installStatePath)) return null;
  return JSON.parse(fs.readFileSync(installStatePath, 'utf8')) as InstallState;
}

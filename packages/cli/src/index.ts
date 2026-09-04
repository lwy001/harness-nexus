#!/usr/bin/env node
/**
 * `harness-nexus` / `hnx` — install tool (Phase 3.3).
 *
 * Fetches a profile from a Harness Nexus server via the SDK and installs it
 * into a target Agent tool's native layout through a target adapter. Plan and
 * apply are separate: a plain run is a dry-run that prints the plan; `--apply`
 * writes files + an install-state ledger.
 *
 * Usage:
 *   hnx install --profile <id> --server <url> --token <pat> [--target <t>] [--apply] [--out <dir>]
 *   hnx install --profile <id> ...            # dry-run: prints the plan, writes nothing
 *
 * A profile is a reference bundle (its entries point at server-side resources),
 * so the server is required — there is no local-manifest path.
 *
 * Design: `docs/design/phase-3-install.md`. Adapter pattern:
 * `docs/research/phase-3-ecc-install-patterns.md`.
 */
import { InstallError } from './errors.js';
import { applyInstall } from './install/installer.js';
import { planInstall } from './install/planner.js';
import { resolveProfile } from './install/resolver.js';
import { supportedTargets } from './install/registry.js';
import { getHermesPlanWarnings } from './install/adapters/hermes.js';
import { applyUninstall, planUninstall } from './install/uninstaller.js';
import type { InstallPlan } from './install/types.js';
import type { AgentTarget } from '@harness-nexus/core';

const HELP = `harness-nexus (hnx) — install profiles into Agent tools

Usage:
  hnx install --profile <id> --server <url> --token <pat> [options]
  hnx uninstall --target <t> [--out <dir>] [--apply]

Install options:
  --profile <id>     Profile to install (required)
  --server <url>     Harness Nexus server base URL (required)
  --token <pat>      PAT or JWT for authentication (required)
  --target <t>       Override target (default: the profile's own target)
  --apply            Write files (default: dry-run, prints the plan only)
  --out <dir>        Override the install root (default: the target's native home)

Uninstall options:
  --target <t>       Target whose ledger to reverse (required)
  --out <dir>        Same install-root override used at install time
  --apply            Actually remove/restore (default: dry-run, prints steps)
                      Files you edited after install are kept as *.hnx.bak

To upgrade an install, run the same 'hnx install --apply' again — the plan
rewrites its own entries (idempotent) and the ledger is refreshed.

Supported targets: ${supportedTargets().join(', ')}
(zcode is in the enum but has no install adapter.)

A plain run is a DRY-RUN — it prints the planned operations without writing.
Add --apply to materialize them.`;

interface InstallArgs {
  profile: string;
  server: string;
  token: string;
  target?: AgentTarget;
  apply: boolean;
  out?: string;
}

/** Minimal hand-written argv parser (zero runtime deps). `loose` skips the
 * install-only required-arg checks (uninstall needs just --target). */
function parseArgs(argv: string[], loose = false): InstallArgs {
  const args: InstallArgs = { profile: '', server: '', token: '', apply: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new InstallError(`Missing value for ${a}`, 'VALIDATION_FAILED');
      return v;
    };
    switch (a) {
      case '--profile':
        args.profile = next();
        break;
      case '--server':
        args.server = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--target':
        args.target = next() as AgentTarget;
        break;
      case '--out':
        args.out = next();
        break;
      case '--apply':
        args.apply = true;
        break;
      default:
        throw new InstallError(`Unknown argument: ${a}`, 'VALIDATION_FAILED');
    }
  }

  if (loose) return args;

  for (const [k, v] of [
    ['--profile', args.profile],
    ['--server', args.server],
    ['--token', args.token],
  ] as const) {
    if (!v) throw new InstallError(`Missing required argument ${k}`, 'VALIDATION_FAILED');
  }
  return args;
}

/** Print Hermes-specific post-install hints the adapter cannot perform itself. */
function printHermesHints(_plan: InstallPlan): void {
  const w = getHermesPlanWarnings();
  const lines = ['\nHermes post-install steps:'];
  if (w.needsPluginEnable) {
    lines.push(
      `  • Enable the plugin: add '${w.pluginSlug}' to the 'plugins.enabled' list in config.yaml`,
    );
  }
  if (w.patEnvKey) {
    lines.push(`  • Set the proxy MCP token: add '${w.patEnvKey}=<your-hn-pat>' to ~/.hermes/.env`);
  }
  if (w.skipped.length > 0) {
    lines.push(`  • Skipped (Hermes model incompatibility):`);
    for (const s of w.skipped) lines.push(`      - ${s}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

/** Render a plan for the dry-run preview. */
function formatPlan(plan: import('./install/types.js').InstallPlan): string {
  const lines = [
    `target:     ${plan.adapter.target} (${plan.adapter.kind})`,
    `root:       ${plan.targetRoot}`,
    `ledger:     ${plan.installStatePath}`,
    `sensitive:  ${plan.sensitive ? 'yes (direct-mode credentials inlined)' : 'no'}`,
    `operations: ${plan.operations.length}`,
    '',
  ];
  for (const [i, op] of plan.operations.entries()) {
    const tag =
      op.kind === 'copy-file'
        ? `copy  ${op.sourcePath}`
        : op.kind === 'write-file'
          ? `write ${op.content.length} bytes`
          : `merge ${JSON.stringify(op.mergePayload).length} bytes`;
    lines.push(`  [${i + 1}] ${op.kind.padEnd(10)} → ${op.destinationPath}`);
    lines.push(`       ${tag}`);
  }
  return lines.join('\n');
}

async function runInstall(args: InstallArgs): Promise<void> {
  const resolved = await resolveProfile({
    server: args.server,
    token: args.token,
    profileId: args.profile,
  });

  const plan = planInstall(resolved, {
    ...(args.target !== undefined ? { target: args.target } : {}),
    input: args.out ? { outDir: args.out } : {},
  });

  // eslint-disable-next-line no-console
  console.log(formatPlan(plan));

  // Target-specific install hints (Hermes needs manual steps the adapter can't do).
  if (plan.adapter.target === 'hermes') {
    printHermesHints(plan);
  }

  if (!args.apply) {
    // eslint-disable-next-line no-console
    console.log('\n(dry-run — no files written. Add --apply to materialize.)');
    return;
  }

  applyInstall(plan, {
    profileId: resolved.profile.id,
    profileName: resolved.profile.name,
    profileVersion: resolved.profile.version,
  });

  // eslint-disable-next-line no-console
  console.log(`\nInstalled ${plan.operations.length} operation(s) into ${plan.targetRoot}.`);
  if (plan.sensitive) {
    // eslint-disable-next-line no-console
    console.warn(
      'WARNING: this install carries decrypted direct-mode credentials (chmod 0700 applied).',
    );
  }
}

/** Render an uninstall plan for the dry-run preview. */
function formatUninstallPlan(plan: import('./install/uninstaller.js').UninstallPlan): string {
  const lines = [
    `target:     ${plan.profile.name} (installed ${plan.installedAt})`,
    `root:       ${plan.targetRoot}`,
    `steps:      ${plan.steps.length}`,
    '',
  ];
  for (const [i, s] of plan.steps.entries()) {
    const flag = s.conflicts ? ' [modified since install → .hnx.bak]' : s.exists ? '' : ' [already gone]';
    lines.push(`  [${i + 1}] ${s.action.padEnd(7)} ${s.destinationPath}${flag}`);
  }
  return lines.join('\n');
}

function runUninstall(args: { target?: string; apply: boolean; out?: string }): number {
  if (!args.target) {
    throw new InstallError('Missing required argument --target', 'VALIDATION_FAILED');
  }
  const plan = planUninstall({
    target: args.target as AgentTarget,
    input: args.out ? { outDir: args.out } : {},
  });
  if (!plan) {
    // eslint-disable-next-line no-console
    console.error(
      `hnx: no install-state ledger found for target '${args.target}' — nothing installed (or already uninstalled).`,
    );
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log(formatUninstallPlan(plan));
  if (!args.apply) {
    // eslint-disable-next-line no-console
    console.log('\n(dry-run — nothing removed. Add --apply to uninstall.)');
    return 0;
  }
  const touched = applyUninstall(plan);
  // eslint-disable-next-line no-console
  console.log(`\nUninstalled: ${touched} file(s) restored or removed.`);
  // eslint-disable-next-line no-console
  console.log('Reminder: manual steps from install (e.g. plugins.enabled, env vars) are yours to undo.');
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [, , subcommand, ...rest] = argv;

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return 0;
  }

  if (subcommand === 'install' || subcommand === 'uninstall') {
    if (rest.includes('-h') || rest.includes('--help')) {
      // eslint-disable-next-line no-console
      console.log(HELP);
      return 0;
    }
    try {
      if (subcommand === 'install') {
        const args = parseArgs(rest);
        await runInstall(args);
        return 0;
      }
      return runUninstall(parseArgs(rest, /* loose */ true));
    } catch (e) {
      if (e instanceof InstallError) {
        // eslint-disable-next-line no-console
        console.error(`hnx: ${e.code}: ${e.message}`);
        return 1;
      }
      // eslint-disable-next-line no-console
      console.error(`hnx: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }

  // eslint-disable-next-line no-console
  console.error(`hnx: unknown subcommand '${subcommand}'. Run 'hnx --help'.`);
  return 2;
}

main(process.argv).then((code) => process.exit(code));

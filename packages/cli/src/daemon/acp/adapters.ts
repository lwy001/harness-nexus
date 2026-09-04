import type { AgentTarget } from '@harness-nexus/shared';

/**
 * Per-target ACP adapter wiring (Phase 8 C5) — the adapter matrix from
 * docs/research/phase-8-c5-acp-web-demo.md, executable. Every adapter speaks
 * ACP v1 (JSON-RPC 2.0, newline-delimited) over stdio, so the daemon needs
 * only the command line per target.
 *
 * `HN_ACP_COMMAND_<TARGET>` (`-`→`_`, upper) replaces the whole command line
 * (split on whitespace) — the hook for pinned/local installs and for pointing
 * tests at a fixture agent.
 */
const DEFAULT_ACP_COMMANDS: Record<AgentTarget, readonly string[] | null> = {
  // Official Zed adapter, now powered by the Claude Agent SDK (bundles the CLI;
  // needs local Claude auth).
  'claude-code': ['npx', '-y', '@zed-industries/claude-agent-acp'],
  // Official Zed adapter wrapping the OpenAI Codex CLI (needs `codex` on PATH).
  codex: ['npx', '-y', '@zed-industries/codex-acp'],
  // Hermes ships a native ACP adapter as an install extra.
  hermes: ['python3', '-m', 'acp_adapter'],
  zcode: null, // no adapter exists (also no install adapter — 3.x)
  generic: null,
};

export interface AcpCommand {
  command: string;
  args: string[];
}

export function resolveAcpCommand(target: AgentTarget, env: NodeJS.ProcessEnv): AcpCommand | null {
  const override = env[`HN_ACP_COMMAND_${target.toUpperCase().replace(/-/g, '_')}`];
  if (override !== undefined && override.trim() !== '') {
    const parts = override.trim().split(/\s+/);
    return { command: parts[0]!, args: parts.slice(1) };
  }
  const def = DEFAULT_ACP_COMMANDS[target];
  return def === null ? null : { command: def[0]!, args: def.slice(1) };
}

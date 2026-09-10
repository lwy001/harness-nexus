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
  // The ACP project's official wrapper (took over from @zed-industries's
  // 0.23.x, which the daemon shipped until 2026-09). Reason for the swap,
  // rig-verified: the old wrapper never requests thinking on gateway/unknown
  // models (MAX_THINKING_TOKENS on the adapter env didn't help either), so
  // chat showed no thought stream; the official 0.76.0 streams
  // agent_thought_chunk by default, advertises loadSession + list/resume
  // (both caps shapes the daemon already detects), and returns full
  // SessionInfo. Same switch the stable reference CC bridge runs.
  'claude-code': ['npx', '-y', '@agentclientprotocol/claude-agent-acp'],
  // Official Zed adapter wrapping the OpenAI Codex CLI (needs `codex` on PATH).
  codex: ['npx', '-y', '@zed-industries/codex-acp'],
  // DeepSeek Harness ships a native ACP v1 profile (needs `dsh` on PATH and a
  // configured provider route — T1 research § ACP).
  deepseek: ['dsh', '--profile', 'acp'],
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

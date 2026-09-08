/**
 * Phase 9 W3 — the provider/model route ONE harness runtime on ONE machine
 * should use. Pure spec: the API key itself never lives here; the spec names
 * a distributable credential, resolved to plaintext only inside the daemon's
 * machine-PAT bundle fetch. Applied by the daemon into each harness's native
 * config slots (claude-code settings.json env, codex config.toml + auth.json,
 * dsh cordis patch + `~/.dsh/.env`). See docs/design/phase-9-harness-runtime.md §4.3.
 */

/** Plain mirror of `RuntimeConfigSpec` in shared (core stays framework-free). */
export interface RuntimeConfigSpecData {
  providerLabel: string;
  baseUrl: string | null;
  api: 'anthropic-messages' | 'openai';
  model: string;
  credentialName: string;
  extra: Record<string, unknown> | null;
}

export interface RuntimeConfig {
  id: string;
  machineId: string;
  ownerId: string;
  /** Runtime-managed target only (claude-code | codex | deepseek). */
  target: 'claude-code' | 'codex' | 'deepseek';
  spec: RuntimeConfigSpecData;
  createdAt: string;
  updatedAt: string;
}

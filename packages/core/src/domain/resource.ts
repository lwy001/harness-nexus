/**
 * Domain entities for AgentNexus.
 *
 * This package is intentionally pure: no `import` of Fastify, the MCP SDK, or any
 * storage driver is allowed here. Concrete repository implementations live in
 * `@agent-nexus/server` under `infra/storage/*`. See `ports/` for the contracts.
 *
 * NOTE: These types are skeleton placeholders. Fields will evolve as modules are
 * implemented; keep them aligned with `packages/shared/src/schemas/*`.
 */

/** The kinds of managed assets an Agent tool can consume. */
export type ResourceKind =
  | 'skill'
  | 'hook'
  | 'sub_agent'
  | 'rule'
  | 'mcp'
  | 'command';

/** Tools a resource/profile can be installed into. */
export type AgentTarget = 'claude-code' | 'zcode' | 'hermes' | 'generic';

/** Visibility/scope. `global` is admin-managed; `personal` is per-user. */
export type ResourceScope = 'global' | 'personal';

/**
 * A single installable asset (a skill, a hook script, an MCP server definition, …).
 * Binary/script contents are referenced by `source`, not embedded.
 */
export interface Resource {
  id: string;
  /** Stable identifier within the instance, e.g. "skill:docx". */
  key: string;
  kind: ResourceKind;
  name: string;
  description?: string;
  /** Version of the asset itself (semver-ish), independent of packaging. */
  version: string;
  /** Where the asset bytes live: a git ref, tarball URL, or local path. */
  source: ResourceSource;
  scope: ResourceScope;
  /** Owner user id; null for global resources. */
  ownerId: string | null;
  /** Target tools this resource is compatible with. */
  targets: AgentTarget[];
  labels?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export type ResourceSource =
  | { type: 'git'; url: string; ref?: string; path?: string }
  | { type: 'tarball'; url: string; checksum?: string }
  | { type: 'local'; path: string }
  | { type: 'inline'; content: string };

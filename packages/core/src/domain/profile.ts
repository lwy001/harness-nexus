import type { ResourceKind } from './resource.js';

/**
 * A Profile is a named, versioned bundle combining resources (MCP servers,
 * skills, hooks, sub-agents, rules) plus optional third-party harness packages
 * (e.g. ECC, Superpower). One-click install applies one or more profiles to a
 * target Agent tool.
 */
export interface Profile {
  id: string;
  /** Human-readable name, e.g. "Frontend Daily". */
  name: string;
  description?: string;
  /** Semver of the profile manifest itself. */
  version: string;
  scope: 'global' | 'personal';
  ownerId: string | null;
  entries: ProfileEntry[];
  /** Imported third-party harness release packages bundled into this profile. */
  imports?: ProfileImport[];
  createdAt: string;
  updatedAt: string;
}

/** A reference to a resource included in a profile, optionally pinned. */
export interface ProfileEntry {
  /** Either an internal Resource id or a `kind:key` reference. */
  resourceId: string;
  kind: ResourceKind;
  /** Optional version pin; omit to float to latest. */
  pinnedVersion?: string;
  /** Target-specific install overrides (e.g. an MCP server config fragment). */
  installOptions?: Record<string, unknown>;
}

/** A third-party harness package (ECC, Superpower, …) pulled into a profile. */
export interface ProfileImport {
  /** Origin kind, used to pick the right adapter. */
  origin: 'ecc' | 'superpower' | 'custom';
  /** Release artifact URL or local path. */
  source: string;
  /** Optional checksum for integrity verification. */
  checksum?: string;
}

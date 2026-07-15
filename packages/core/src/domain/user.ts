/** User and access-control entities. */

/**
 * The two roles. Phase 1 supports exactly these; authorization branches on this
 * single field. See docs/design/phase-1-auth.md.
 */
export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  email?: string;
  /** argon2id hash. Null only for future passwordless accounts. */
  passwordHash: string | null;
  /** Exactly one role per user (not an array). */
  role: Role;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

/**
 * Personal Access Token. The raw token is shown once at creation; only its
 * sha256 hash is stored. `prefix` (first chars) is kept for UI recognition.
 * Format: `anpat_<base64url(32 random bytes)>`.
 */
export interface PersonalAccessToken {
  id: string;
  userId: string;
  name: string;
  /** sha256 of the full `anpat_…` token. */
  tokenHash: string;
  /** First chars of the raw token, for display only. */
  prefix: string;
  /** Free-form scope tags; reserved for finer-grained checks beyond Phase 1. */
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * How an MCP server connection is dialed (Phase 3.1).
 *
 * - `proxy`  — AgentNexus dials the upstream and re-exposes it via `/mcp`.
 *              Only SSE / Streamable HTTP. Pooled by the registry; `proxied`
 *              drives whether it actually enters the pool.
 * - `direct` — the target tool dials the upstream itself. SSE / Streamable
 *              HTTP **and stdio**. AgentNexus stores the connection + encrypted
 *              credentials only; it never opens the connection. stdio forces
 *              this mode, so AgentNexus never spawns a subprocess.
 */
export type McpMode = 'proxy' | 'direct';

/** A registered MCP server that this instance consumes (as a client) or serves. */
export interface McpServer {
  id: string;
  name: string;
  /** Transport used to connect to the upstream MCP server. */
  transport: McpTransport;
  /**
   * Whether this instance dials it (proxy) or the tool does (direct). The
   * registry pools `proxy` rows only; `direct` rows are never dialed by
   * AgentNexus (the target tool dials them at install time).
   */
  mode: McpMode;
  scope: 'global' | 'personal';
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type McpTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'sse';
      url: string;
      /**
       * Static header values. Credential secrets are referenced as
       * `${cred:NAME}` placeholders here (and in `url`), resolved to the
       * decrypted plaintext at connect time (proxy) / install time (direct).
       */
      headers?: Record<string, string>;
    }
  | {
      type: 'streamable-http';
      url: string;
      /** Same placeholder semantics as `sse`. */
      headers?: Record<string, string>;
    };

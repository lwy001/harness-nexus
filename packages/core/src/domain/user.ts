/** User and access-control entities. Skeleton — fields will grow. */

export type Role = 'admin' | 'maintainer' | 'user';

export interface User {
  id: string;
  username: string;
  email?: string;
  /** Hashed, never plaintext. Hashing happens in the server layer. */
  passwordHash: string | null;
  roles: Role[];
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

/**
 * Personal Access Token. The raw token is shown once at creation; only its hash
 * is stored. `prefix` (first 8 chars) is kept for UI recognition.
 */
export interface PersonalAccessToken {
  id: string;
  userId: string;
  name: string;
  /** SHA-256 of the full token. */
  tokenHash: string;
  /** First characters of the raw token, for display only. */
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/** A registered MCP server that this instance consumes (as a client) or serves. */
export interface McpServer {
  id: string;
  name: string;
  /** Transport used to connect to the upstream MCP server. */
  transport: McpTransport;
  /** Whether this instance exposes it back out to Agent tools (proxy mode). */
  proxied: boolean;
  scope: 'global' | 'personal';
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type McpTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'streamable-http'; url: string; headers?: Record<string, string> };

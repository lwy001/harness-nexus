/**
 * A Credential is a reusable secret that AgentNexus injects into request
 * headers when connecting to an *upstream* MCP server (e.g. a Bearer token for
 * a hosted MCP, an API key for a vendor tool API).
 *
 * This is distinct from PersonalAccessToken, which authenticates a user *into*
 * AgentNexus. A Credential authenticates AgentNexus *out to* a third party.
 *
 * The `secret` field holds AES-256-GCM ciphertext (see server crypto module);
 * the plaintext is never returned by the API (responses carry a masked
 * preview instead). See docs/design/phase-2.1-credentials.md.
 */

export type CredentialKind = 'bearer' | 'api_key' | 'basic' | 'custom';

export interface Credential {
  id: string;
  name: string;
  /** AES-256-GCM ciphertext (base64). Plaintext is write-only at the API. */
  secret: string;
  kind?: CredentialKind;
  scope: 'global' | 'personal';
  /** null iff scope === 'global'; otherwise the owning user id. */
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

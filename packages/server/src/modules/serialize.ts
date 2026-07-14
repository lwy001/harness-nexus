import type { User, Credential } from '@agent-nexus/core';

/** Strip secrets from a user for API responses. */
export function publicUser(u: User): Omit<User, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}

/** Masked credential view — never exposes the ciphertext or plaintext. */
export interface CredentialView {
  id: string;
  name: string;
  kind?: Credential['kind'];
  secretPreview: string;
  scope: 'global' | 'personal';
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Build a masked credential view. `mask` receives the decrypted plaintext and
 * returns a recognition-only preview (e.g. `abc…xyz`); see `maskSecret` in
 * infra/crypto.ts. The ciphertext itself never leaves the route handler.
 */
export function credentialView(
  c: Credential,
  secretPreview: string,
): CredentialView {
  const { secret: _omit, kind, ...rest } = c;
  return { ...rest, ...(kind ? { kind } : {}), secretPreview };
}

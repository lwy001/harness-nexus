import { hash, verify } from '@node-rs/argon2';
import { randomBytes, createHash } from 'node:crypto';

/**
 * argon2id parameters (OWASP-recommended ballpark). We pass `algorithm: 2`
 * (Argon2id) as a literal because @node-rs/argon2 ships it as a `const enum`,
 * which can't be referenced under `verbatimModuleSyntax`.
 */
const ARGON2_OPTS = {
  algorithm: 2,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Hash a password with argon2id. */
export async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTS);
}

/** Verify a password against an argon2id hash; false on any failure. */
export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** Prefix for AgentNexus personal access tokens. */
export const PAT_PREFIX = 'anpat_';

/** Generate a new PAT. Returns the raw `anpat_…` value (shown to the user once). */
export function generatePat(): string {
  return PAT_PREFIX + randomBytes(32).toString('base64url');
}

/** sha256 of the raw PAT — what we persist and look up by. */
export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/** Stable random id (URL-safe). Used for all primary keys. */
export function generateId(): string {
  return randomBytes(16).toString('base64url');
}

/** The display prefix kept alongside the hash, for UI recognition. */
export function patDisplayPrefix(rawToken: string): string {
  return rawToken.slice(0, PAT_PREFIX.length + 6);
}

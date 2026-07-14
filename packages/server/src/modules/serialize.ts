import type { User } from '@agent-nexus/core';

/** Strip secrets from a user for API responses. */
export function publicUser(u: User): Omit<User, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}

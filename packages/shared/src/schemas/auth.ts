import { z } from 'zod';

/**
 * Auth/user validation schemas — the single source of truth for request shapes
 * across server, SDK, and web. See docs/auth.md for the rules.
 */

const USERNAME_RE = /^[\w.-]{3,32}$/;

export const roleSchema = z.enum(['admin', 'user']);

/** Password: 8–256 chars. Deliberately no complexity theater. */
export const passwordSchema = z.string().min(8).max(256);

export const usernameSchema = z.string().regex(USERNAME_RE, {
  message: 'username must be 3–32 chars of [A-Za-z0-9_.-]',
});

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const registerSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: z.string().email().optional(),
});

/** Admin-created user may carry an explicit role and optional preset password. */
export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: z.string().email().optional(),
  role: roleSchema.default('user'),
});

export const updateRoleSchema = z.object({
  role: roleSchema,
});

export const createPatSchema = z.object({
  name: z.string().min(1).max(64),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export const updateRegistrationSchema = z.object({
  allowRegistration: z.boolean(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
export type CreatePatInput = z.infer<typeof createPatSchema>;
export type UpdateRegistrationInput = z.infer<typeof updateRegistrationSchema>;

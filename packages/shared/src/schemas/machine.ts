import { z } from 'zod';

/**
 * Machine management request schemas (Phase 8 C1). See
 * docs/design/phase-8-client.md and docs/design/phase-8-c1.md.
 */

export const createMachineSchema = z.object({
  /** Display name for the machine (the daemon's hostname is a good default). */
  name: z.string().min(1).max(64),
});

export const updateMachineSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    /** Toggling remote chat on is a consent action — the web UI confirms first. */
    remoteChatEnabled: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.remoteChatEnabled !== undefined, {
    message: 'at least one of name / remoteChatEnabled is required',
  });

export type CreateMachineInput = z.infer<typeof createMachineSchema>;
export type UpdateMachineInput = z.infer<typeof updateMachineSchema>;

import { z } from 'zod';
import {
  inventoryArtifactSchema,
  inventoryItemKindSchema,
  inventorySnapshotSchema,
} from './schemas/inventory.js';
import { agentTargetSchema } from './schemas/profile.js';

/**
 * Realtime protocol v1 (Phase 8) — Socket.IO over WSS.
 *
 * One bidirectional namespace per client role: `/ctl` (daemon, machine PAT)
 * and `/app` (browser, JWT/PAT). Event names are `domain:verb`; only
 * whitelisted handlers are registered server-side, and every payload is
 * validated with the schemas below (single source for server, daemon, and
 * web). See docs/design/phase-8-client.md ("Realtime protocol").
 */

/** Wire protocol version; carried in the machine:hello ack. Breaking changes bump namespaces (`/v2/ctl`), not this silently. */
export const REALTIME_PROTO_VERSION = 1;

// ---- handshake (Socket.IO `auth` object, verified in namespace middleware) ----

/** `/ctl` — the daemon presents its machine PAT and the machine it claims to be. */
export const ctlHandshakeAuthSchema = z.object({
  token: z.string().min(1),
  machineId: z.string().min(1),
});

/** `/app` — the browser presents its JWT or api PAT. */
export const appHandshakeAuthSchema = z.object({
  token: z.string().min(1),
});

// ---- /ctl events (C1) ----

/** daemon → server, ack'd. Reports daemon identity; server persists it as Machine metadata. */
export const machineHelloSchema = z.object({
  daemonVersion: z.string().min(1).max(64),
  os: z.string().max(64).optional(),
  arch: z.string().max(32).optional(),
  hostname: z.string().max(255).optional(),
  capabilities: z.array(z.string().min(1).max(64)).max(32).default([]),
});

/** server → daemon ack for `machine:hello`. */
export const machineHelloAckSchema = z.object({
  proto: z.number().int().min(1),
  machineId: z.string().min(1),
});

/** Ack error shape for any malformed event (`proto:invalid`). */
export const protoErrorAckSchema = z.object({ error: z.string().min(1) });

// ---- /app events (C1) ----

/** server → browser: a machine's live presence changed. `online` is socket presence — never faked. */
export const machineStatusEventSchema = z.object({
  machineId: z.string().min(1),
  online: z.boolean(),
  lastSeenAt: z.string().datetime().nullable(),
  daemonVersion: z.string().nullable().optional(),
});

// ---- job envelopes (v0 — framing fixed in C1, handlers land in C4) ----

export const jobTypeSchema = z.enum(['deploy', 'import', 'scan']);
export const jobStatusSchema = z.enum([
  'queued',
  'dispatched',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

/** The `Job` wire shape shared by REST and `job:update` / `job:dispatch` events. */
export const jobViewSchema = z.object({
  id: z.string().min(1),
  machineId: z.string().min(1),
  ownerId: z.string().min(1),
  type: jobTypeSchema,
  status: jobStatusSchema,
  payload: z.unknown(),
  result: z.unknown().nullable().optional(),
  error: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** server → daemon: execute this job (ack = accepted, not completed). */
export const jobDispatchEventSchema = z.object({ job: jobViewSchema });

/** daemon → server: non-terminal progress. */
export const jobProgressEventSchema = z.object({
  jobId: z.string().min(1),
  phase: z.string().min(1).max(64),
  message: z.string().max(512).optional(),
  percent: z.number().min(0).max(100).optional(),
});

/** daemon → server: terminal result. */
export const jobResultEventSchema = z.object({
  jobId: z.string().min(1),
  ok: z.boolean(),
  error: z.string().max(1024).optional(),
  data: z.unknown().optional(),
});

// ---- /ctl inventory events (C3) ----

/** server → daemon: scan these targets and reply one `inventory:report` per target. */
export const inventoryScanRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  targets: z.array(agentTargetSchema).min(1).max(8),
});

/** daemon → server: a fresh snapshot. `requestId` present when answering a scan request. */
export const inventoryReportEventSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  snapshot: inventorySnapshotSchema,
});

/** server → daemon: upload bodies for these items (paths are re-derived by a fresh scan — never trusted from the server). */
export const inventoryCollectRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  target: agentTargetSchema,
  items: z
    .array(z.object({ kind: inventoryItemKindSchema, name: z.string().min(1).max(128) }))
    .min(1)
    .max(200),
});

/** daemon → server: collected bodies. MCP env/header VALUES are already `${cred:<KEY>}` placeholders. */
export const inventoryPayloadEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  items: z
    .array(
      z.object({
        kind: inventoryItemKindSchema,
        name: z.string().min(1).max(128),
        ok: z.boolean(),
        error: z.string().max(256).optional(),
        artifact: inventoryArtifactSchema.optional(),
      }),
    )
    .min(1)
    .max(200),
});

// ---- /app events (C3) ----

/** server → browser: a machine's latest snapshot for one target changed. */
export const inventoryUpdatedEventSchema = z.object({
  machineId: z.string().min(1),
  target: agentTargetSchema,
  reportedAt: z.string().datetime(),
});

export type CtlHandshakeAuth = z.infer<typeof ctlHandshakeAuthSchema>;
export type AppHandshakeAuth = z.infer<typeof appHandshakeAuthSchema>;
export type MachineHello = z.infer<typeof machineHelloSchema>;
export type MachineHelloAck = z.infer<typeof machineHelloAckSchema>;
export type MachineStatusEvent = z.infer<typeof machineStatusEventSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobView = z.infer<typeof jobViewSchema>;
export type JobDispatchEvent = z.infer<typeof jobDispatchEventSchema>;
export type JobProgressEvent = z.infer<typeof jobProgressEventSchema>;
export type JobResultEvent = z.infer<typeof jobResultEventSchema>;
export type InventoryScanRequest = z.infer<typeof inventoryScanRequestSchema>;
export type InventoryReportEvent = z.infer<typeof inventoryReportEventSchema>;
export type InventoryCollectRequest = z.infer<typeof inventoryCollectRequestSchema>;
export type InventoryPayloadEvent = z.infer<typeof inventoryPayloadEventSchema>;
export type InventoryUpdatedEvent = z.infer<typeof inventoryUpdatedEventSchema>;

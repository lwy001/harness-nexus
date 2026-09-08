import { z } from 'zod';
import {
  inventoryArtifactSchema,
  inventoryItemKindSchema,
  inventorySnapshotSchema,
  runtimeInfoSchema,
  runtimeTargetSchema,
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

// ---- job envelopes (C1 framing, C4 semantics) ----

export const jobTypeSchema = z.enum(['deploy', 'import', 'scan', 'harness']);
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
  /** Delivery attempts (disconnect/ack-timeout recoveries increment it; ≥ max ⇒ failed). */
  attempts: z.number().int().min(0).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/** `Job.payload` for `type: 'deploy'` (C4). */
export const deployJobPayloadSchema = z.object({
  profileId: z.string().min(1).max(64),
  /** Optional install-root override on the machine (maps to the planner's `outDir`). */
  directory: z.string().min(1).max(512).optional(),
});

/**
 * `Job.payload` for `type: 'harness'` (Phase 9 W2/W3) — install / upgrade /
 * pin the harness runtime itself, or apply its provider config. Omitting
 * `version` means the dist-tag default (claude-code `@stable`, others
 * `@latest`); `pin` exists precisely to pin, so it demands one. The secret
 * never rides the job: `apply-config` payloads name only the target — the
 * daemon fetches the resolved `{spec, secret}` bundle with its machine PAT at
 * execution time (requeue after a credential edit picks up the new value).
 */
export const harnessActionSchema = z.enum(['install', 'upgrade', 'pin', 'apply-config']);
export const harnessJobPayloadSchema = z
  .object({
    type: z.literal('harness'),
    action: harnessActionSchema,
    target: runtimeTargetSchema,
    /** npm version spec (bare semver or dist-tag); omit = channel default. */
    version: z.string().min(1).max(64).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === 'pin' && v.version === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'pin requires a version',
      });
    }
    if (v.action === 'apply-config' && v.version !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'apply-config takes no version',
      });
    }
  });

/** The REST body of `POST /api/machines/:id/jobs` — type-discriminated (W2);
 * a body without `type` is a deploy (the pre-W2 shape every SDK caller sends). */
export const createMachineJobSchema = z.preprocess(
  (v) => (typeof v === 'object' && v !== null && !('type' in v) ? { type: 'deploy', ...v } : v),
  z.union([deployJobPayloadSchema.extend({ type: z.literal('deploy') }), harnessJobPayloadSchema]),
);

/** What a daemon reports in `job:result.data` for a successful harness job (W2/W3). */
export const harnessResultDataSchema = z.object({
  target: runtimeTargetSchema,
  action: harnessActionSchema,
  version: z.string().max(64).optional(),
  binPath: z.string().max(512).optional(),
  installMethod: z.enum(['npm', 'native', 'brew', 'unknown']).optional(),
  /** apply-config only: the native config files written (display paths). */
  files: z.array(z.string().max(512)).max(8).optional(),
  /** Non-fatal follow-up note (e.g. settings.json left untouched). */
  warning: z.string().max(512).optional(),
});
export type HarnessResultData = z.infer<typeof harnessResultDataSchema>;

/** server → browser (/app): a job transitioned. */
export const jobUpdateEventSchema = z.object({ job: jobViewSchema });

/** What a daemon reports in `job:result.data` for a successful deploy (C4). */
export const deployResultDataSchema = z.object({
  name: z.string().min(1).max(128),
  directory: z.string().min(1).max(512),
  target: z.string().min(1).max(32),
  profileId: z.string().min(1).max(64),
  profileVersion: z.string().max(64).optional(),
});
export type DeployResultData = z.infer<typeof deployResultDataSchema>;

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

/**
 * daemon → server: a fresh snapshot. `requestId` present when answering a scan
 * request. `runtimes` (Phase 9 W1) carries the full runtime-probe result of the
 * scan cycle — the daemon folds it into every report (one probe feeds all
 * targets' rows). Absent on daemon builds without the `runtime` capability.
 */
export const inventoryReportEventSchema = z.object({
  requestId: z.string().min(1).max(64).optional(),
  runtimes: z.array(runtimeInfoSchema).max(8).optional(),
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

// ---- /ctl runtime config view events (Phase 9 W4) ----
//
// The redacted effective-config read-back: the server asks the daemon for a
// target's config files, the daemon MASKS secret-ish values (key-name-aware
// JSON walk + line masking for TOML/YAML; `.env` values are masked wholesale
// — the file exists to hold secrets) and replies. `path` values are display
// paths (`~/.codex/config.toml`) — the daemon's real home never leaks.

/** server → daemon: read + redact this target's effective config. */
export const runtimeConfigGetRequestSchema = z.object({
  requestId: z.string().min(1).max(64),
  target: runtimeTargetSchema,
});

/** daemon → server: the redacted view. `error` arm settles the waiter honestly. */
export const runtimeConfigViewEventSchema = z.object({
  requestId: z.string().min(1).max(64),
  target: runtimeTargetSchema,
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        content: z.string().max(131072),
      }),
    )
    .max(8)
    .optional(),
  /** What was hidden — `"<display-path>:<key>"` entries; empty iff nothing matched. */
  redacted: z.array(z.string().max(128)).max(64).default([]),
  error: z.string().max(512).optional(),
});
export type RuntimeConfigGetRequest = z.infer<typeof runtimeConfigGetRequestSchema>;
export type RuntimeConfigViewEvent = z.infer<typeof runtimeConfigViewEventSchema>;

// ---- /app events (C3) ----

/** server → browser: a machine's latest snapshot for one target changed. */
export const inventoryUpdatedEventSchema = z.object({
  machineId: z.string().min(1),
  target: agentTargetSchema,
  reportedAt: z.string().datetime(),
});

// ---- chat events / ACP dialect (C5) ----
//
// The browser speaks platform-semantic chat events; the daemon adapts them to
// each agent's protocol (ACP over stdio today — the adapter matrix lives in
// docs/research/phase-8-c5-acp-web-demo.md). These schemas are the SINGLE
// source for server, daemon, and web: every handler on either side validates
// with them (whitelisted-handler isolation rule).

export const acpToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

export const acpToolStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);

export const acpLocationSchema = z.object({
  path: z.string().min(1).max(1024),
  line: z.number().int().min(0).optional(),
  lineEnd: z.number().int().min(0).optional(),
});

/** Bounded view of an ACP ToolCallUpdate — enough for tool rows and permission cards. */
export const acpToolCallViewSchema = z.object({
  toolCallId: z.string().min(1).max(128),
  title: z.string().max(512).optional(),
  kind: acpToolKindSchema.optional(),
  status: acpToolStatusSchema.optional(),
  locations: z.array(acpLocationSchema).max(16).optional(),
});

/** ACP permission option — `optionId` is passed through VERBATIM in both directions. */
export const acpPermissionOptionSchema = z.object({
  optionId: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
});

/** Prompt content blocks the browser may send (text + file references in v1). */
export const promptBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(32000) }),
  z.object({
    type: z.literal('resource_link'),
    name: z.string().min(1).max(256),
    uri: z.string().min(1).max(2048),
  }),
]);

/**
 * The semantic chat stream (`chat:event` → `{ sessionId, event }`). Produced by
 * the daemon (mapped from ACP `session/update` etc.) plus `permission_resolved`
 * which the SERVER emits so every viewer's permission card settles. `raw` is
 * the escape hatch for unmapped protocol frames.
 */
export const chatStreamEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message_delta'), delta: z.string().min(0).max(100000) }),
  z.object({ kind: z.literal('thought_delta'), delta: z.string().min(0).max(100000) }),
  z.object({ kind: z.literal('tool_call'), call: acpToolCallViewSchema }),
  z.object({
    kind: z.literal('usage'),
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
  }),
  z.object({
    kind: z.literal('permission_request'),
    requestId: z.string().min(1).max(128),
    toolCall: acpToolCallViewSchema,
    options: z.array(acpPermissionOptionSchema).min(1).max(8),
  }),
  z.object({
    kind: z.literal('permission_resolved'),
    requestId: z.string().min(1).max(128),
    outcome: z.enum(['selected', 'cancelled', 'timeout']),
    optionId: z.string().min(1).max(128).optional(),
  }),
  z.object({
    kind: z.literal('turn_result'),
    stopReason: z.enum(['end_turn', 'cancelled', 'max_tokens', 'refusal']),
  }),
  z.object({ kind: z.literal('session_status'), state: z.enum(['active', 'idle']) }),
  z.object({ kind: z.literal('raw'), method: z.string().min(1).max(64), params: z.unknown() }),
]);

/** `chat:event` envelope — daemon→server and (relayed) server→browser share it. */
export const chatStreamEventEnvelopeSchema = z.object({
  sessionId: z.string().min(1).max(64),
  event: chatStreamEventSchema,
});

/** browser → server: create a channel (no `sessionId`) or idempotently re-join an open one. */
export const chatSessionOpenRequestSchema = z.object({
  agentInstanceId: z.string().min(1).max(64),
  sessionId: z.string().min(1).max(64).optional(),
});

/** server → daemon: spawn the agent subprocess for this channel. `cwd` defaults to the agent home. */
export const chatSessionStartEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  agentInstanceId: z.string().min(1).max(64),
  target: agentTargetSchema,
  cwd: z.string().min(1).max(1024),
});

/** daemon → server: subprocess + ACP handshake done (`error` ⇒ spawn/initialize failed). */
export const chatSessionReadyEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  agentName: z.string().max(128).optional(),
  agentVersion: z.string().max(64).optional(),
  error: z.string().max(512).optional(),
});

/** browser → server: send a turn prompt. */
export const chatMessageSendRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  content: z.union([z.string().min(1).max(32000), z.array(promptBlockSchema).min(1).max(16)]),
});

/** server → daemon: the normalized prompt blocks for `session/prompt`. */
export const chatPromptEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  prompt: z.array(promptBlockSchema).min(1).max(16),
});

/** browser → server and server → daemon: cancel the running turn (idempotent). */
export const chatTurnCancelEventSchema = z.object({ sessionId: z.string().min(1).max(64) });

/** browser → server: answer a permission request; absent `optionId` = cancelled. */
export const chatPermissionRespondRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  requestId: z.string().min(1).max(128),
  optionId: z.string().min(1).max(128).optional(),
});

/** server → daemon: forwarded permission decision (or timeout/user cancel). */
export const chatPermissionRespondEventSchema = chatPermissionRespondRequestSchema;

/** browser → server: close the channel. */
export const chatSessionCloseRequestSchema = z.object({
  sessionId: z.string().min(1).max(64),
  reason: z.string().max(128).optional(),
});

/** server → daemon: kill the subprocess for this channel. */
export const chatSessionCloseEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  reason: z.string().max(128).optional(),
});

/** daemon → server: the channel ended daemon-side (agent process exited / fatal). */
export const chatSessionClosedEventSchema = z.object({
  sessionId: z.string().min(1).max(64),
  reason: z.string().max(256),
});

/** REST view of an `AcSession` audit row (`GET /api/agent-instances/:id/sessions`). */
export const acSessionViewSchema = z.object({
  id: z.string().min(1),
  agentInstanceId: z.string().min(1),
  machineId: z.string().min(1),
  ownerId: z.string().min(1),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
  closeReason: z.string().nullable(),
});

/** server → browser lifecycle pushes (typed for the web client; server-constructed). */
export const chatSessionReadyPushSchema = z.object({
  sessionId: z.string().min(1),
  agentName: z.string().max(128).optional(),
  agentVersion: z.string().max(64).optional(),
});
export const chatSessionFailedPushSchema = z.object({
  sessionId: z.string().min(1),
  error: z.string().min(1).max(512),
});
export const chatSessionClosedPushSchema = z.object({
  sessionId: z.string().min(1),
  reason: z.string().min(1).max(256),
});

export type CtlHandshakeAuth = z.infer<typeof ctlHandshakeAuthSchema>;
export type AppHandshakeAuth = z.infer<typeof appHandshakeAuthSchema>;
export type MachineHello = z.infer<typeof machineHelloSchema>;
export type MachineHelloAck = z.infer<typeof machineHelloAckSchema>;
export type MachineStatusEvent = z.infer<typeof machineStatusEventSchema>;
export type JobType = z.infer<typeof jobTypeSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type JobView = z.infer<typeof jobViewSchema>;
export type DeployJobPayload = z.infer<typeof deployJobPayloadSchema>;
export type HarnessAction = z.infer<typeof harnessActionSchema>;
export type HarnessJobPayload = z.infer<typeof harnessJobPayloadSchema>;
export type CreateMachineJobInput = z.infer<typeof createMachineJobSchema>;
export type JobUpdateEvent = z.infer<typeof jobUpdateEventSchema>;
export type JobDispatchEvent = z.infer<typeof jobDispatchEventSchema>;
export type JobProgressEvent = z.infer<typeof jobProgressEventSchema>;
export type JobResultEvent = z.infer<typeof jobResultEventSchema>;
export type InventoryScanRequest = z.infer<typeof inventoryScanRequestSchema>;
export type InventoryReportEvent = z.infer<typeof inventoryReportEventSchema>;
export type InventoryCollectRequest = z.infer<typeof inventoryCollectRequestSchema>;
export type InventoryPayloadEvent = z.infer<typeof inventoryPayloadEventSchema>;
export type InventoryUpdatedEvent = z.infer<typeof inventoryUpdatedEventSchema>;
export type AcpToolKind = z.infer<typeof acpToolKindSchema>;
export type AcpToolStatus = z.infer<typeof acpToolStatusSchema>;
export type AcpToolCallView = z.infer<typeof acpToolCallViewSchema>;
export type AcpPermissionOption = z.infer<typeof acpPermissionOptionSchema>;
export type PromptBlock = z.infer<typeof promptBlockSchema>;
export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;
export type ChatStreamEventEnvelope = z.infer<typeof chatStreamEventEnvelopeSchema>;
export type ChatSessionOpenRequest = z.infer<typeof chatSessionOpenRequestSchema>;
export type ChatSessionStartEvent = z.infer<typeof chatSessionStartEventSchema>;
export type ChatSessionReadyEvent = z.infer<typeof chatSessionReadyEventSchema>;
export type ChatMessageSendRequest = z.infer<typeof chatMessageSendRequestSchema>;
export type ChatPromptEvent = z.infer<typeof chatPromptEventSchema>;
export type ChatTurnCancelEvent = z.infer<typeof chatTurnCancelEventSchema>;
export type ChatPermissionRespondRequest = z.infer<typeof chatPermissionRespondRequestSchema>;
export type ChatSessionCloseRequest = z.infer<typeof chatSessionCloseRequestSchema>;
export type ChatSessionClosedEvent = z.infer<typeof chatSessionClosedEventSchema>;
export type ChatSessionReadyPush = z.infer<typeof chatSessionReadyPushSchema>;
export type ChatSessionFailedPush = z.infer<typeof chatSessionFailedPushSchema>;
export type ChatSessionClosedPush = z.infer<typeof chatSessionClosedPushSchema>;
export type AcSessionView = z.infer<typeof acSessionViewSchema>;

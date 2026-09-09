import type { FastifyInstance } from 'fastify';
import socketIOPlugin from 'fastify-socket.io';
import type { Server, Socket } from 'socket.io';
import type { Machine, Role } from '@harness-nexus/core';
import {
  REALTIME_PROTO_VERSION,
  appHandshakeAuthSchema,
  ctlHandshakeAuthSchema,
  machineHelloSchema,
  inventoryReportEventSchema,
  inventoryPayloadEventSchema,
  runtimeConfigViewEventSchema,
  type InventoryUpdatedEvent,
  type MachineStatusEvent,
} from '@harness-nexus/shared';
import { jobProgressEventSchema, jobResultEventSchema, type JobView } from '@harness-nexus/shared';
import {
  chatMessageSendRequestSchema,
  chatPermissionRespondRequestSchema,
  chatSessionCloseRequestSchema,
  chatSessionClosedEventSchema,
  chatSessionOpenRequestSchema,
  chatSessionReadyEventSchema,
  chatStreamEventEnvelopeSchema,
  chatTurnCancelEventSchema,
  workspaceListEventSchema,
} from '@harness-nexus/shared';
import { hashToken, PAT_PREFIX, generateId } from '../infra/crypto.js';
import { MachinePresence } from '../realtime/presence.js';
import { InventoryCoordinator } from '../realtime/inventory.js';
import { ConfigViewerCoordinator } from '../realtime/config-viewer.js';
import { WorkspaceCoordinator } from '../realtime/workspace.js';
import { DetectedInstanceSync } from '../realtime/runtime-instances.js';
import { ChatService } from '../realtime/chat.js';
import { JobService } from '../jobs/service.js';

/**
 * Realtime channel (Phase 8) — Socket.IO attached to the Fastify HTTP server.
 *
 * One bidirectional namespace per client role (docs/design/phase-8-client.md):
 *   /ctl — daemon, authenticated by a machine PAT (scopes ['machine-ctl'])
 *          whose PAT record must map to the claimed machineId.
 *   /app — browser, authenticated by JWT or api PAT; joins `user:<id>`
 *          (+ `admins` for admins) and receives `machine:status` pushes.
 *
 * Machine tokens are rejected by the REST auth hook, so their blast radius is
 * exactly this channel.
 */

export interface RealtimeService {
  presence: MachinePresence;
  /** Scan/collect waiters for the inventory request/response flow (C3). */
  inventory: InventoryCoordinator;
  /** Job state machine (C4) — dispatch/recover driven by presence below. */
  jobs: JobService;
  /** Chat routing/gating/audit (C5) — /app ↔ /ctl with permission watchdogs. */
  chat: ChatService;
  /** Redacted config-view waiters (Phase 9 W4). */
  configView: ConfigViewerCoordinator;
  /** Workspace directory-listing waiters (Phase 9 W6 chat picker). */
  workspace: WorkspaceCoordinator;
  /** Push a machine's presence change to its owner (+ admins) on /app. */
  broadcastStatus(machine: Machine, online: boolean): void;
  /** Force-drop a machine's daemon sockets (revoke) and push offline if it was online. */
  disconnectMachine(machine: Machine): void;
}

export async function registerRealtime(
  app: FastifyInstance,
  opts: {
    maxHttpBufferSize: number;
    inventoryTimeoutMs: number;
    runtimeConfigViewTimeoutMs: number;
    workspaceListTimeoutMs: number;
    jobAckTimeoutMs: number;
    jobSweepIntervalMs: number;
    jobMaxAttempts: number;
    chatMaxSessionsPerMachine: number;
    chatPermissionTimeoutMs: number;
    chatReadyTimeoutMs: number;
  },
): Promise<void> {
  await app.register(socketIOPlugin, {
    cors: { origin: true },
    maxHttpBufferSize: opts.maxHttpBufferSize,
  });

  const ctl = app.io.of('/ctl');
  const appNs = app.io.of('/app');

  const presence = new MachinePresence();
  const inventory = new InventoryCoordinator(opts.inventoryTimeoutMs);
  const configView = new ConfigViewerCoordinator(opts.runtimeConfigViewTimeoutMs);
  const workspace = new WorkspaceCoordinator(opts.workspaceListTimeoutMs);
  const runtimeInstances = new DetectedInstanceSync(app.uow);
  const chat = new ChatService(
    {
      uow: app.uow,
      isOnline: (machineId) => presence.isOnline(machineId),
      io: {
        toCtl: (machineId, event, payload) => {
          ctl.to(`machine:${machineId}`).emit(event, payload);
        },
        toChannel: (sessionId, event, payload) => {
          appNs.to(`chan:${sessionId}`).emit(event, payload);
        },
        joinChannel: (socketId, sessionId) => {
          const socket = appNs.sockets.get(socketId);
          if (socket) void socket.join(`chan:${sessionId}`);
        },
        isAppSocketLive: (socketId) => appNs.sockets.has(socketId),
      },
    },
    {
      maxSessionsPerMachine: opts.chatMaxSessionsPerMachine,
      permissionTimeoutMs: opts.chatPermissionTimeoutMs,
      readyTimeoutMs: opts.chatReadyTimeoutMs,
    },
  );
  const jobs = new JobService(
    {
      uow: app.uow,
      isOnline: (machineId) => presence.isOnline(machineId),
      dispatch: (job: JobView) => {
        app.io.of('/ctl').to(`machine:${job.machineId}`).emit('job:dispatch', { job });
      },
      update: (job: JobView) => {
        appNs.to([`user:${job.ownerId}`, 'admins']).emit('job:update', { job });
      },
    },
    {
      ackTimeoutMs: opts.jobAckTimeoutMs,
      sweepIntervalMs: opts.jobSweepIntervalMs,
      maxAttempts: opts.jobMaxAttempts,
    },
  );

  const statusEvent = (machine: Machine, online: boolean): MachineStatusEvent => ({
    machineId: machine.id,
    online,
    lastSeenAt: machine.lastSeenAt,
    ...(machine.daemonVersion !== null ? { daemonVersion: machine.daemonVersion } : {}),
  });

  const realtime: RealtimeService = {
    presence,
    inventory,
    jobs,
    chat,
    configView,
    workspace,
    broadcastStatus(machine, online) {
      appNs
        .to([`user:${machine.ownerId}`, 'admins'])
        .emit('machine:status', statusEvent(machine, online));
    },
    disconnectMachine(machine) {
      const wasOnline = presence.forceOffline(machine.id);
      app.io.of('/ctl').in(`machine:${machine.id}`).disconnectSockets(true);
      void chat.onMachineDeleted(machine.id);
      runtimeInstances.forgetMachine(machine.id);
      if (wasOnline) realtime.broadcastStatus(machine, false);
    },
  };
  app.decorate('realtime', realtime);
  // Rows a previous server process left open can never resume (v1) — settle
  // them now so the UI's session list stops offering dead channels.
  void realtime.chat.sweepOrphanedSessions();

  const touchLastSeen = async (machine: Machine): Promise<Machine> => {
    const updated = { ...machine, lastSeenAt: new Date().toISOString() };
    await app.uow.machines.save(updated);
    return updated;
  };

  // ---- /ctl (daemon) ----

  app.io.of('/ctl').use(async (socket, next) => {
    const parsed = ctlHandshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) return next(new Error('invalid handshake'));
    const { token, machineId } = parsed.data;

    if (!token.startsWith(PAT_PREFIX)) return next(new Error('machine token required'));
    const record = await app.uow.tokens.findByTokenHash(hashToken(token));
    if (!record || !record.scopes.includes('machine-ctl')) {
      return next(new Error('invalid machine token'));
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
      return next(new Error('machine token expired'));
    }
    const user = await app.uow.users.findById(record.userId);
    if (!user || user.status !== 'active') return next(new Error('inactive user'));

    // The token must belong to exactly the machine it claims to be.
    const machine = await app.uow.machines.findByEnrollmentPatId(record.id);
    if (!machine || machine.id !== machineId) return next(new Error('machine mismatch'));

    socket.data.machineId = machine.id;
    next();
  });

  app.io.of('/ctl').on('connection', (socket: Socket) => {
    const machineId = socket.data.machineId as string;
    void socket.join(`machine:${machineId}`);

    void (async () => {
      const machine = await app.uow.machines.findById(machineId);
      if (!machine) {
        // Deleted between handshake and connection — drop immediately.
        socket.disconnect(true);
        return;
      }
      const updated = await touchLastSeen(machine);
      if (presence.connected(machineId, socket.id)) {
        realtime.broadcastStatus(updated, true);
        // The daemon is back — drain anything queued while it was offline.
        void realtime.jobs.dispatchPending(machineId);
      }
    })();

    socket.on('machine:hello', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = machineHelloSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      void (async () => {
        const machine = await app.uow.machines.findById(machineId);
        if (!machine) {
          socket.disconnect(true);
          return;
        }
        const hello = parsed.data;
        await touchLastSeen({
          ...machine,
          daemonVersion: hello.daemonVersion,
          hostname: hello.hostname ?? machine.hostname,
          os: hello.os ?? machine.os,
          arch: hello.arch ?? machine.arch,
          capabilities: hello.capabilities,
        });
        ack?.({ proto: REALTIME_PROTO_VERSION, machineId });
      })();
    });

    // C3 — daemon scan result: validate, persist (latest per machine+target),
    // resolve any pending scan waiter, and push the freshness signal to /app.
    // W1 — the event's `runtimes` arm drives the detected AgentInstance sync.
    socket.on('inventory:report', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = inventoryReportEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const snapshot = parsed.data.snapshot;
      void (async () => {
        const machine = await app.uow.machines.findById(machineId);
        if (!machine) {
          socket.disconnect(true);
          return;
        }
        const runtime = parsed.data.runtimes?.find((r) => r.target === snapshot.target) ?? null;
        const row = {
          id: generateId(),
          machineId,
          target: snapshot.target,
          daemonVersion: machine.daemonVersion,
          reportedAt: new Date().toISOString(),
          scannedAt: snapshot.scannedAt,
          agents: snapshot.agents,
          runtime,
        };
        await app.uow.inventories.save(row);
        inventory.onReport(machineId, row);
        const event: InventoryUpdatedEvent = {
          machineId,
          target: row.target,
          reportedAt: row.reportedAt,
        };
        app.io
          .of('/app')
          .to([`user:${machine.ownerId}`, 'admins'])
          .emit('inventory:updated', event);
        ack?.({ stored: true });
        // Detected-instance sync is idempotent and eventually consistent —
        // never block the report path (or its ack) on it.
        void runtimeInstances.onReport(machine, runtime, snapshot.agents[0]?.directory);
      })();
    });

    // C3 — collected artifact bodies for an import; resolve its waiter.
    socket.on('inventory:payload', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = inventoryPayloadEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const known = inventory.onPayload(parsed.data.requestId, parsed.data.items);
      ack?.(known ? { accepted: true } : { error: 'unknown-request' });
    });

    // 9 W4 — daemon reply for `runtime:config.get`: resolve the waiter; a
    // late/unknown id (already timed out) is dropped.
    socket.on('runtime:config', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = runtimeConfigViewEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const { requestId, ...view } = parsed.data;
      const known = configView.onView(requestId, view);
      ack?.(known ? { accepted: true } : { error: 'unknown-request' });
    });

    // 9 W6 — daemon reply for `workspace:list` (chat directory picker).
    socket.on('workspace:list', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = workspaceListEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const { requestId, ...evt } = parsed.data;
      const known = workspace.onList(requestId, evt);
      ack?.(known ? { accepted: true } : { error: 'unknown-request' });
    });

    // C4 — daemon job reporting. Progress accepts queued/dispatched/running;
    // result settles the job (terminal states ignore stale replay).
    socket.on('job:progress', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = jobProgressEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.({ accepted: true });
      void realtime.jobs.onProgress(machineId, parsed.data);
    });

    socket.on('job:result', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = jobResultEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.({ accepted: true });
      void realtime.jobs.onResult(machineId, parsed.data);
    });

    // C5 — daemon chat reporting. Ready closes the starting phase (or the
    // channel on spawn failure); events fan out to the channel room; a
    // daemon-side close settles the AcSession row.
    socket.on('chat:session.ready', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatSessionReadyEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.({ accepted: true });
      void realtime.chat.onReady(machineId, parsed.data);
    });

    socket.on('chat:event', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatStreamEventEnvelopeSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const accepted = realtime.chat.onStream(machineId, parsed.data.sessionId, parsed.data.event);
      ack?.(accepted.ok ? { accepted: true } : { error: 'unknown-session' });
    });

    socket.on('chat:session.closed', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatSessionClosedEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.({ closed: true });
      void realtime.chat.onDaemonClosed(machineId, parsed.data.sessionId, parsed.data.reason);
    });

    socket.on('disconnect', () => {
      const wentOffline = presence.disconnected(socket.id);
      if (wentOffline === null) return;
      inventory.failMachine(wentOffline);
      configView.failMachine(wentOffline);
      workspace.failMachine(wentOffline);
      void realtime.jobs.recoverMachine(wentOffline);
      // ACP has no resume in v1 — every open channel of the machine dies with
      // its daemon; viewers are notified via chat:session.closed.
      void realtime.chat.onMachineOffline(wentOffline);
      void (async () => {
        const machine = await app.uow.machines.findById(wentOffline);
        if (machine) {
          const updated = await touchLastSeen(machine);
          realtime.broadcastStatus(updated, false);
        }
      })();
    });
  });

  // ---- /app (browser) ----

  app.io.of('/app').use(async (socket, next) => {
    const parsed = appHandshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) return next(new Error('invalid handshake'));
    const token = parsed.data.token;

    let user: { id: string; role: Role } | null = null;
    if (!token.startsWith(PAT_PREFIX)) {
      try {
        const payload = await app.jwt.verifyAccessToken(token);
        const u = await app.uow.users.findById(payload.sub);
        if (u && u.status === 'active') user = { id: u.id, role: u.role };
      } catch {
        user = null;
      }
    } else {
      const record = await app.uow.tokens.findByTokenHash(hashToken(token));
      const usable =
        record &&
        (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()) &&
        !record.scopes.includes('marketplace') &&
        !record.scopes.includes('machine-ctl');
      if (usable) {
        const u = await app.uow.users.findById(record!.userId);
        if (u && u.status === 'active') user = { id: u.id, role: u.role };
      }
    }
    if (!user) return next(new Error('unauthorized'));

    socket.data.userId = user.id;
    socket.data.role = user.role;
    next();
  });

  app.io.of('/app').on('connection', (socket: Socket) => {
    void socket.join(`user:${socket.data.userId as string}`);
    if (socket.data.role === 'admin') void socket.join('admins');

    // C5 — interactive chat handlers. Every handler validates its payload and
    // re-verifies ownership against `socket.data.userId` (envelope identity
    // binding — a browser may only touch sessions it owns).
    socket.on('chat:session.open', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatSessionOpenRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const userId = socket.data.userId as string;
      void (async () => {
        const result = await realtime.chat.open(
          userId,
          parsed.data.agentInstanceId,
          parsed.data.sessionId,
          socket.id,
          parsed.data.directory,
        );
        if (!result.ok) {
          ack?.({ error: result.code });
          return;
        }
        // Re-joining an already-ready channel: join immediately. A fresh
        // channel joins on `chat:session.ready` (the opener would otherwise
        // sit in a room for an agent that may fail to spawn).
        if (result.joined) void socket.join(`chan:${result.sessionId}`);
        // `phase` lets the browser settle its pane from the ack alone — the
        // ready push can predate the caller's event listeners.
        ack?.({ sessionId: result.sessionId, phase: result.phase });
      })();
    });

    socket.on('chat:message.send', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatMessageSendRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const result = realtime.chat.onMessageSend(
        socket.data.userId as string,
        parsed.data.sessionId,
        parsed.data.content,
      );
      ack?.(result.ok ? { accepted: true } : { error: result.code });
    });

    socket.on('chat:turn.cancel', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatTurnCancelEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const result = realtime.chat.onTurnCancel(
        socket.data.userId as string,
        parsed.data.sessionId,
      );
      ack?.(result.ok ? { accepted: true } : { error: result.code });
    });

    socket.on('chat:permission.respond', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatPermissionRespondRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const result = realtime.chat.onPermissionRespond(
        socket.data.userId as string,
        parsed.data.sessionId,
        parsed.data.requestId,
        parsed.data.optionId,
      );
      ack?.(result.ok ? { accepted: true } : { error: result.code });
    });

    socket.on('chat:session.close', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatSessionCloseRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      void (async () => {
        const result = await realtime.chat.close(
          socket.data.userId as string,
          parsed.data.sessionId,
          parsed.data.reason,
        );
        ack?.(result.ok ? { closed: true } : { error: result.code });
      })();
    });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    realtime: RealtimeService;
    /** Decorated by fastify-socket.io at runtime; its bundled types are minimal. */
    io: Server;
  }
}

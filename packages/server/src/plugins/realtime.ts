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
  type InventoryUpdatedEvent,
  type MachineStatusEvent,
} from '@harness-nexus/shared';
import { jobProgressEventSchema, jobResultEventSchema, type JobView } from '@harness-nexus/shared';
import { hashToken, PAT_PREFIX, generateId } from '../infra/crypto.js';
import { MachinePresence } from '../realtime/presence.js';
import { InventoryCoordinator } from '../realtime/inventory.js';
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
    jobAckTimeoutMs: number;
    jobSweepIntervalMs: number;
    jobMaxAttempts: number;
  },
): Promise<void> {
  await app.register(socketIOPlugin, {
    cors: { origin: true },
    maxHttpBufferSize: opts.maxHttpBufferSize,
  });

  const presence = new MachinePresence();
  const inventory = new InventoryCoordinator(opts.inventoryTimeoutMs);
  const jobs = new JobService(
    {
      uow: app.uow,
      isOnline: (machineId) => presence.isOnline(machineId),
      dispatch: (job: JobView) => {
        app.io.of('/ctl').to(`machine:${job.machineId}`).emit('job:dispatch', { job });
      },
      update: (job: JobView) => {
        app.io
          .of('/app')
          .to([`user:${job.ownerId}`, 'admins'])
          .emit('job:update', { job });
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
    broadcastStatus(machine, online) {
      app.io
        .of('/app')
        .to([`user:${machine.ownerId}`, 'admins'])
        .emit('machine:status', statusEvent(machine, online));
    },
    disconnectMachine(machine) {
      const wasOnline = presence.forceOffline(machine.id);
      app.io.of('/ctl').in(`machine:${machine.id}`).disconnectSockets(true);
      if (wasOnline) realtime.broadcastStatus(machine, false);
    },
  };
  app.decorate('realtime', realtime);

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
        const row = {
          id: generateId(),
          machineId,
          target: snapshot.target,
          daemonVersion: machine.daemonVersion,
          reportedAt: new Date().toISOString(),
          scannedAt: snapshot.scannedAt,
          agents: snapshot.agents,
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

    socket.on('disconnect', () => {
      const wentOffline = presence.disconnected(socket.id);
      if (wentOffline === null) return;
      inventory.failMachine(wentOffline);
      void realtime.jobs.recoverMachine(wentOffline);
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
    // C1: push-only — no browser→server handlers registered. Unknown events
    // get no handler and no ack (sender times out), per the isolation model.
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    realtime: RealtimeService;
    /** Decorated by fastify-socket.io at runtime; its bundled types are minimal. */
    io: Server;
  }
}

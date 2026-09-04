import type { AcSession, UnitOfWork } from '@harness-nexus/core';
import type { ChatStreamEvent, PromptBlock } from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';

/**
 * Chat routing + gating + audit (Phase 8 C5). docs/design/phase-8-c5.md.
 *
 * The platform never learns agent protocols: this service checks ownership and
 * the remote-chat gates, fans the daemon's semantic stream out to the
 * `chan:<sessionId>` room, keeps `AcSession` rows as the audit trail, and
 * guarantees every permission request gets an answer (user decision or
 * timeout-cancel — never a dangling agent-side waiter). Sessions have NO
 * resume: a daemon disconnect closes every open channel of that machine
 * ('connection-lost') and a server restart closes all of them
 * ('server-shutdown' recovery sweep in `start()`).
 *
 * Transport-agnostic like JobService: realtime wires the emit/join callbacks
 * to /ctl rooms and /app channel rooms.
 */

export interface ChatIO {
  /** Send an event into the machine's /ctl room. */
  toCtl(machineId: string, event: string, payload: unknown): void;
  /** Send an event to every viewer of one channel (`chan:<sessionId>` on /app). */
  toChannel(sessionId: string, event: string, payload: unknown): void;
  /** Join a browser socket to a channel room (called when the agent is ready). */
  joinChannel(socketId: string, sessionId: string): void;
  /** Is that /app socket still connected? (Opener may vanish before ready.) */
  isAppSocketLive(socketId: string): boolean;
}

export interface ChatServiceDeps {
  uow: UnitOfWork;
  /** Is the machine's daemon connected right now? */
  isOnline: (machineId: string) => boolean;
  io: ChatIO;
}

export type ChatOpenResult =
  | { ok: true; sessionId: string; joined: boolean }
  | {
      ok: false;
      code:
        | 'AGENT_INSTANCE_NOT_FOUND'
        | 'SESSION_NOT_FOUND'
        | 'REMOTE_CHAT_DISABLED'
        | 'MACHINE_OFFLINE'
        | 'DAEMON_NO_CHAT'
        | 'SESSION_LIMIT_REACHED';
    };

export type ChatSimpleResult = { ok: true } | { ok: false; code: string };

interface LiveSession {
  sessionId: string;
  machineId: string;
  agentInstanceId: string;
  ownerId: string;
  phase: 'starting' | 'ready';
  /** Last reported turn state — the server-side SESSION_BUSY gate. */
  busy: boolean;
  /** Socket of the browser that opened the channel; joined on ready. */
  openerSocketId: string | null;
  readyTimer: NodeJS.Timeout | null;
  permissionTimers: Map<string, NodeJS.Timeout>;
}

export class ChatService {
  private live = new Map<string, LiveSession>();

  constructor(
    private readonly deps: ChatServiceDeps,
    private readonly opts: {
      maxSessionsPerMachine: number;
      permissionTimeoutMs: number;
      readyTimeoutMs: number;
    },
  ) {}

  /** Recovery sweep: rows left open by a server crash/restart cannot have live channels. */
  async start(): Promise<void> {
    // No machine list to iterate cheaply — close every open row.
    const machines = await this.deps.uow.machines.list();
    for (const machine of machines) {
      for (const row of await this.deps.uow.acSessions.listOpenByMachine(machine.id)) {
        await this.persistClose(row, 'server-shutdown');
      }
    }
  }

  /** Graceful shutdown: notify viewers, tell the daemons to kill subprocesses. */
  async stop(): Promise<void> {
    for (const session of [...this.live.values()]) {
      await this.closeInternal(session, 'server-shutdown', { notifyDaemon: true });
    }
  }

  /**
   * `chat:session.open`. Without `sessionId`: create a channel (gating order is
   * normative — see the design doc). With an open `sessionId`: idempotent
   * re-join (page refresh) — returns the same id, spawns nothing.
   */
  async open(
    ownerId: string,
    agentInstanceId: string,
    rejoinSessionId: string | undefined,
    openerSocketId: string,
  ): Promise<ChatOpenResult> {
    if (rejoinSessionId !== undefined) {
      const existing = this.live.get(rejoinSessionId);
      if (!existing || existing.ownerId !== ownerId || existing.phase === 'starting') {
        return { ok: false, code: 'SESSION_NOT_FOUND' };
      }
      return { ok: true, sessionId: existing.sessionId, joined: true };
    }

    const agent = await this.deps.uow.agentInstances.findById(agentInstanceId);
    if (!agent || agent.ownerId !== ownerId) return { ok: false, code: 'AGENT_INSTANCE_NOT_FOUND' };
    const machine = await this.deps.uow.machines.findById(agent.machineId);
    if (!machine) return { ok: false, code: 'AGENT_INSTANCE_NOT_FOUND' };
    if (!machine.remoteChatEnabled) return { ok: false, code: 'REMOTE_CHAT_DISABLED' };
    if (!this.deps.isOnline(machine.id)) return { ok: false, code: 'MACHINE_OFFLINE' };
    if (!machine.capabilities.includes('chat')) return { ok: false, code: 'DAEMON_NO_CHAT' };
    const openForMachine = [...this.live.values()].filter((s) => s.machineId === machine.id);
    if (openForMachine.length >= this.opts.maxSessionsPerMachine) {
      return { ok: false, code: 'SESSION_LIMIT_REACHED' };
    }

    const sessionId = generateId();
    const now = new Date().toISOString();
    await this.deps.uow.acSessions.save({
      id: sessionId,
      agentInstanceId: agent.id,
      machineId: machine.id,
      ownerId,
      openedAt: now,
      closedAt: null,
      closeReason: null,
    });
    // Join the opener NOW: spawn-failed / spawn-timeout notifications must
    // reach the browser even though the agent never came up.
    this.deps.io.joinChannel(openerSocketId, sessionId);
    const session: LiveSession = {
      sessionId,
      machineId: machine.id,
      agentInstanceId: agent.id,
      ownerId,
      phase: 'starting',
      busy: false,
      openerSocketId,
      readyTimer: null,
      permissionTimers: new Map(),
    };
    session.readyTimer = setTimeout(() => {
      void this.closeInternal(session, 'spawn-timeout', { notifyDaemon: true, failed: true });
    }, this.opts.readyTimeoutMs);
    this.live.set(sessionId, session);

    this.deps.io.toCtl(machine.id, 'chat:session.start', {
      sessionId,
      agentInstanceId: agent.id,
      target: agent.target,
      cwd: agent.directory,
    });
    return { ok: true, sessionId, joined: false };
  }

  /** Daemon's `chat:session.ready` — spawn+initialize+session/new done (or failed). */
  async onReady(
    machineId: string,
    evt: {
      sessionId: string;
      agentName?: string | undefined;
      agentVersion?: string | undefined;
      error?: string | undefined;
    },
  ): Promise<void> {
    const session = this.live.get(evt.sessionId);
    if (!session || session.machineId !== machineId || session.phase !== 'starting') return;

    if (evt.error !== undefined) {
      await this.closeInternal(session, 'spawn-failed', {
        notifyDaemon: false,
        failed: true,
        error: evt.error,
      });
      return;
    }
    if (session.readyTimer !== null) clearTimeout(session.readyTimer);
    session.readyTimer = null;
    session.phase = 'ready';

    // The opener joined at open(); if they disconnected before the agent came
    // up, nobody is watching — close instead of running an agent subprocess
    // unattended.
    const opener = session.openerSocketId;
    if (opener === null || !this.deps.io.isAppSocketLive(opener)) {
      await this.closeInternal(session, 'connection-lost', { notifyDaemon: true });
      return;
    }
    this.deps.io.toChannel(session.sessionId, 'chat:session.ready', {
      sessionId: session.sessionId,
      ...(evt.agentName !== undefined ? { agentName: evt.agentName } : {}),
      ...(evt.agentVersion !== undefined ? { agentVersion: evt.agentVersion } : {}),
    });
  }

  /** Daemon's `chat:event` — validate, arm permission watchdogs, relay to the room. */
  onStream(machineId: string, sessionId: string, event: ChatStreamEvent): { ok: boolean } {
    const session = this.live.get(sessionId);
    if (!session || session.machineId !== machineId) return { ok: false };

    if (event.kind === 'permission_request') {
      const { requestId } = event;
      session.permissionTimers.set(
        requestId,
        setTimeout(() => {
          session.permissionTimers.delete(requestId);
          // Timeout ⇒ answer the agent with cancelled and settle every viewer's card.
          this.deps.io.toCtl(session.machineId, 'chat:permission.respond', {
            sessionId,
            requestId,
          });
          this.deps.io.toChannel(sessionId, 'chat:event', {
            sessionId,
            event: { kind: 'permission_resolved', requestId, outcome: 'timeout' },
          });
        }, this.opts.permissionTimeoutMs),
      );
    } else if (event.kind === 'session_status') {
      session.busy = event.state === 'active';
    }
    this.deps.io.toChannel(sessionId, 'chat:event', { sessionId, event });
    return { ok: true };
  }

  /** Browser's `chat:message.send` — owner check, busy gate, prompt normalization. */
  onMessageSend(
    ownerId: string,
    sessionId: string,
    content: string | PromptBlock[],
  ): ChatSimpleResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (session.phase !== 'ready') return { ok: false, code: 'SESSION_NOT_READY' };
    if (session.busy) return { ok: false, code: 'SESSION_BUSY' };
    const prompt = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    this.deps.io.toCtl(session.machineId, 'chat:message.send', { sessionId, prompt });
    return { ok: true };
  }

  /** Browser's `chat:turn.cancel` — idempotent; the daemon resolves the turn as cancelled. */
  onTurnCancel(ownerId: string, sessionId: string): ChatSimpleResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    this.deps.io.toCtl(session.machineId, 'chat:turn.cancel', { sessionId });
    return { ok: true };
  }

  /** Browser's `chat:permission.respond` — forward verbatim (optionId is sacred). */
  onPermissionRespond(
    ownerId: string,
    sessionId: string,
    requestId: string,
    optionId: string | undefined,
  ): ChatSimpleResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    const timer = session.permissionTimers.get(requestId);
    if (timer === undefined) return { ok: false, code: 'PERMISSION_NOT_FOUND' };
    clearTimeout(timer);
    session.permissionTimers.delete(requestId);
    this.deps.io.toCtl(session.machineId, 'chat:permission.respond', {
      sessionId,
      requestId,
      ...(optionId !== undefined ? { optionId } : {}),
    });
    this.deps.io.toChannel(sessionId, 'chat:event', {
      sessionId,
      event: {
        kind: 'permission_resolved',
        requestId,
        outcome: optionId !== undefined ? 'selected' : 'cancelled',
        ...(optionId !== undefined ? { optionId } : {}),
      },
    });
    return { ok: true };
  }

  /** Browser's `chat:session.close`. */
  async close(
    ownerId: string,
    sessionId: string,
    reason: string | undefined,
  ): Promise<ChatSimpleResult> {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    await this.closeInternal(session, reason ?? 'user', { notifyDaemon: true });
    return { ok: true };
  }

  /** Daemon's `chat:session.closed` — the subprocess ended on its own. */
  async onDaemonClosed(machineId: string, sessionId: string, reason: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session || session.machineId !== machineId) return;
    await this.closeInternal(session, reason.slice(0, 256) || 'agent-exited', {
      notifyDaemon: false,
    });
  }

  /** Daemon went offline — every open channel of the machine dies ("no resume"). */
  async onMachineOffline(machineId: string): Promise<void> {
    for (const session of [...this.live.values()]) {
      if (session.machineId === machineId) {
        await this.closeInternal(session, 'connection-lost', { notifyDaemon: false });
      }
    }
  }

  /** Machine deleted / enrollment revoked — audit rows are retained, closed. */
  async onMachineDeleted(machineId: string): Promise<void> {
    await this.onMachineOffline(machineId);
    for (const row of await this.deps.uow.acSessions.listOpenByMachine(machineId)) {
      await this.persistClose(row, 'machine-deleted');
    }
  }

  private async closeInternal(
    session: LiveSession,
    reason: string,
    opts: { notifyDaemon: boolean; failed?: boolean; error?: string },
  ): Promise<void> {
    if (this.live.get(session.sessionId) !== session) return; // already closed
    this.live.delete(session.sessionId);
    if (session.readyTimer !== null) clearTimeout(session.readyTimer);
    for (const timer of session.permissionTimers.values()) clearTimeout(timer);
    session.permissionTimers.clear();

    if (opts.failed === true) {
      this.deps.io.toChannel(session.sessionId, 'chat:session.failed', {
        sessionId: session.sessionId,
        error: opts.error ?? reason,
      });
    }
    this.deps.io.toChannel(session.sessionId, 'chat:session.closed', {
      sessionId: session.sessionId,
      reason,
    });
    if (opts.notifyDaemon) {
      this.deps.io.toCtl(session.machineId, 'chat:session.close', {
        sessionId: session.sessionId,
        ...(reason !== '' ? { reason } : {}),
      });
    }

    const row = await this.deps.uow.acSessions.findById(session.sessionId);
    if (row) await this.persistClose(row, reason);
  }

  private async persistClose(row: AcSession, reason: string): Promise<void> {
    if (row.closedAt !== null) return;
    await this.deps.uow.acSessions.save({
      ...row,
      closedAt: new Date().toISOString(),
      closeReason: reason.slice(0, 256),
    });
  }
}

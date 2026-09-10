import { resolve as resolvePath } from 'node:path';
import type { UnitOfWork } from '@harness-nexus/core';
import type { ChatStreamEvent, PromptBlock } from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';

/**
 * Chat routing + gating (Phase 8 C5, reworked 9 W7). docs/design/phase-8-c5.md
 * + docs/design/phase-9-w7-native-sessions.md.
 *
 * The platform never learns agent protocols and — since W7 — never persists
 * anything session-shaped: the session list, transcript, and resume mechanics
 * are the agent's OWN, read through the daemon on demand. This service is the
 * LIVE channel only: ownership + remote-chat gates, fanning the daemon's
 * semantic stream out to the `chan:<sessionId>` room, history relay, and the
 * guarantee that every permission request gets an answer (user decision or
 * timeout-cancel — never a dangling agent-side waiter). Closing a channel
 * kills a subprocess, never a session — the agent's store keeps it and
 * `sessions:list` keeps offering it.
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
  | { ok: true; sessionId: string; joined: boolean; phase: 'starting' | 'ready' }
  | {
      ok: false;
      code:
        | 'AGENT_INSTANCE_NOT_FOUND'
        | 'SESSION_NOT_FOUND'
        | 'REMOTE_CHAT_DISABLED'
        | 'MACHINE_OFFLINE'
        | 'DAEMON_NO_CHAT'
        | 'SESSION_LIMIT_REACHED'
        | 'WORKSPACE_NOT_SET'
        | 'WORKSPACE_INVALID';
    };

export type ChatSimpleResult = { ok: true } | { ok: false; code: string };

/** A native-session resume arm as it travels browser → server → daemon (9 W7). */
export interface ChatResumeArm {
  sessionId: string;
  cwd: string;
}

interface LiveSession {
  sessionId: string;
  machineId: string;
  agentInstanceId: string;
  ownerId: string;
  phase: 'starting' | 'ready';
  /** Last reported turn state — the server-side SESSION_BUSY gate. */
  busy: boolean;
  /** When the channel was opened — the eviction order (oldest first). */
  openedAt: number;
  /** Reported agent identity — re-pushed to re-joining viewers. */
  agentName?: string | undefined;
  agentVersion?: string | undefined;
  /** The agent's OWN session id behind this channel (9 W7 row highlight). */
  nativeSessionId?: string | undefined;
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
      maxActiveSessionsPerMachine: number;
      permissionTimeoutMs: number;
      readyTimeoutMs: number;
    },
  ) {}

  /** Graceful shutdown: notify viewers, tell the daemons to kill subprocesses. */
  async stop(): Promise<void> {
    for (const session of [...this.live.values()]) {
      await this.closeInternal(session, 'server-shutdown', { notifyDaemon: true });
    }
  }

  /**
   * `chat:session.open`. Without `sessionId`: create a channel (gating order is
   * normative — see the design doc). With an open `sessionId`: idempotent
   * re-join (page refresh) — returns the same id, spawns nothing, and asks the
   * daemon to re-push the channel's history (9 W7).
   *
   * `directory` (9 W6) picks a NEW session's project working directory: it must
   * be the machine's baseWorkspace or a subdirectory of it. `resume` (9 W7)
   * continues the agent's OWN session instead — its `cwd` came from the
   * daemon's listing (ground truth) and passes through verbatim, so no
   * containment check applies (dsh enforces its own match).
   */
  async open(
    ownerId: string,
    agentInstanceId: string,
    rejoinSessionId: string | undefined,
    openerSocketId: string,
    directory: string | undefined,
    resume: ChatResumeArm | undefined,
  ): Promise<ChatOpenResult> {
    if (rejoinSessionId !== undefined) {
      const existing = this.live.get(rejoinSessionId);
      if (!existing || existing.ownerId !== ownerId || existing.phase === 'starting') {
        return { ok: false, code: 'SESSION_NOT_FOUND' };
      }
      // A re-join may be a page refresh whose listeners were attached after
      // the original ready push — re-push so every viewer settles.
      this.deps.io.toChannel(existing.sessionId, 'chat:session.ready', {
        sessionId: existing.sessionId,
        ...(existing.agentName !== undefined ? { agentName: existing.agentName } : {}),
        ...(existing.agentVersion !== undefined ? { agentVersion: existing.agentVersion } : {}),
        ...(existing.nativeSessionId !== undefined
          ? { nativeSessionId: existing.nativeSessionId }
          : {}),
      });
      // 9 W7 — the refreshed page lost its local fold; the daemon re-emits the
      // channel's history into the room.
      this.deps.io.toCtl(existing.machineId, 'chat:session.resync', {
        sessionId: existing.sessionId,
      });
      return {
        ok: true,
        sessionId: existing.sessionId,
        joined: true,
        phase: existing.phase,
      };
    }

    const agent = await this.deps.uow.agentInstances.findById(agentInstanceId);
    if (!agent || agent.ownerId !== ownerId) return { ok: false, code: 'AGENT_INSTANCE_NOT_FOUND' };
    const machine = await this.deps.uow.machines.findById(agent.machineId);
    if (!machine) return { ok: false, code: 'AGENT_INSTANCE_NOT_FOUND' };
    let cwd = agent.directory;
    if (resume !== undefined) {
      cwd = resume.cwd;
    } else if (directory !== undefined) {
      if (machine.baseWorkspace === null) return { ok: false, code: 'WORKSPACE_NOT_SET' };
      const root = resolvePath(machine.baseWorkspace);
      const wanted = resolvePath(directory);
      if (wanted !== root && !wanted.startsWith(root + '/')) {
        return { ok: false, code: 'WORKSPACE_INVALID' };
      }
      cwd = wanted;
    }
    if (!machine.remoteChatEnabled) return { ok: false, code: 'REMOTE_CHAT_DISABLED' };
    if (!this.deps.isOnline(machine.id)) return { ok: false, code: 'MACHINE_OFFLINE' };
    if (!machine.capabilities.includes('chat')) return { ok: false, code: 'DAEMON_NO_CHAT' };
    const openForMachine = [...this.live.values()].filter((s) => s.machineId === machine.id);
    if (openForMachine.length >= this.opts.maxSessionsPerMachine) {
      // Budget redesign (post-W8): a full TOTAL budget evicts instead of
      // rejecting — the OLDEST channel that is not mid-turn gives way (its
      // viewers see `chat:session.closed {reason:'evicted'}`). Only when every
      // channel is busy does the open actually bounce; with the active budget
      // (maxActiveSessionsPerMachine) strictly smaller than the total one,
      // that corner needs at least as many concurrent turns as the active
      // cap, i.e. real generation load on every slot.
      const victim = openForMachine
        .filter((s) => !s.busy)
        .sort((a, b) => a.openedAt - b.openedAt)[0];
      if (victim === undefined) return { ok: false, code: 'SESSION_LIMIT_REACHED' };
      await this.closeInternal(victim, 'evicted', { notifyDaemon: true });
    }

    const sessionId = generateId();
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
      openedAt: Date.now(),
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
      cwd,
      ...(resume !== undefined ? { resume } : {}),
    });
    return { ok: true, sessionId, joined: false, phase: 'starting' };
  }

  /** Daemon's `chat:session.ready` — spawn+initialize+session/new done (or failed). */
  async onReady(
    machineId: string,
    evt: {
      sessionId: string;
      agentName?: string | undefined;
      agentVersion?: string | undefined;
      nativeSessionId?: string | undefined;
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
    session.agentName = evt.agentName;
    session.agentVersion = evt.agentVersion;
    session.nativeSessionId = evt.nativeSessionId;

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
      ...(evt.nativeSessionId !== undefined ? { nativeSessionId: evt.nativeSessionId } : {}),
    });
    // Re-push the history AFTER ready as well: a browser that attached its
    // listeners between the daemon's direct history push and this moment
    // still catches this one (history ingestion rebuilds from scratch, so a
    // viewer that saw both is fine).
    this.deps.io.toCtl(session.machineId, 'chat:session.resync', {
      sessionId: session.sessionId,
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

  /** Daemon's `chat:history` (9 W7) — relay the transcript batch to the room. */
  onHistory(machineId: string, payload: { sessionId: string; items: unknown[] }): { ok: boolean } {
    const session = this.live.get(payload.sessionId);
    if (!session || session.machineId !== machineId) return { ok: false };
    this.deps.io.toChannel(payload.sessionId, 'chat:history', payload);
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
    // Active budget (post-W8 redesign): mid-turn sessions cost a second,
    // smaller per-machine budget — starting a turn while the machine already
    // has `maxActiveSessionsPerMachine` turns generating bounces here (this
    // session is idle, per the check above, so it is not double-counted).
    const activeOnMachine = [...this.live.values()].filter(
      (s) => s.machineId === session.machineId && s.busy,
    ).length;
    if (activeOnMachine >= this.opts.maxActiveSessionsPerMachine) {
      return { ok: false, code: 'MACHINE_BUSY' };
    }
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

  /**
   * Browser's `chat:session.close` — "disconnect the channel" since 9 W7: it
   * kills the subprocess, never the agent's session (the rail keeps it).
   */
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

  /** Daemon went offline — every open channel of the machine ends (the agent sessions survive). */
  async onMachineOffline(machineId: string): Promise<void> {
    for (const session of [...this.live.values()]) {
      if (session.machineId === machineId) {
        await this.closeInternal(session, 'connection-lost', { notifyDaemon: false });
      }
    }
  }

  /**
   * Live channels of an agent instance keyed by NATIVE session id — the
   * listing surface for "which sessions still hold a channel" (`open` /
   * `openChannelId` rows; a row click rejoins instead of resuming).
   */
  channelsByNativeId(agentInstanceId: string): Map<string, string> {
    const byNative = new Map<string, string>();
    for (const s of this.live.values()) {
      if (
        s.agentInstanceId === agentInstanceId &&
        s.phase === 'ready' &&
        s.nativeSessionId !== undefined &&
        !byNative.has(s.nativeSessionId)
      ) {
        byNative.set(s.nativeSessionId, s.sessionId);
      }
    }
    return byNative;
  }

  /** Machine deleted / enrollment revoked — channels end (nothing persisted remains). */
  async onMachineDeleted(machineId: string): Promise<void> {
    await this.onMachineOffline(machineId);
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
  }
}

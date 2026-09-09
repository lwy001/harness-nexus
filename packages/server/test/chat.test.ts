import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';
import { emitAck, once, testConfig, waitFor } from './helpers.js';

/**
 * Chat integration (Phase 8 C5) with a fake daemon on /ctl and a fake browser
 * on /app: open → start → ready → message round-trip, permission respond +
 * timeout watchdog, busy gate, re-join, spawn failure, ready-timeout, session
 * cap, disconnect teardown, user close, and the gating matrix.
 *
 * Chat timeouts come from testConfig overrides: permission 400ms (fast
 * watchdog test) and ready 2500ms (the vitest worker startup can starve the
 * fake daemon's reply beyond the default 800ms; the watchdog test still waits
 * past it). Cap is 2 open sessions per machine.
 */

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let machineId: string;
let machineToken: string;
let agentId: string;
let daemon: Socket;
let browser: Socket;

const authed = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

const openSession = async (
  sock: Socket,
  agentInstanceId: string,
  sessionId?: string,
): Promise<{ sessionId?: string; phase?: 'starting' | 'ready'; error?: string }> =>
  (await emitAck(sock, 'chat:session.open', {
    agentInstanceId,
    ...(sessionId !== undefined ? { sessionId } : {}),
  })) as { sessionId?: string; phase?: 'starting' | 'ready'; error?: string };

/** 9 W6 — open with a project `directory`. */
const openSessionDir = async (
  sock: Socket,
  agentInstanceId: string,
  directory: string,
): Promise<{ sessionId?: string; phase?: 'starting' | 'ready'; error?: string }> =>
  (await emitAck(sock, 'chat:session.open', {
    agentInstanceId,
    directory,
  })) as { sessionId?: string; phase?: 'starting' | 'ready'; error?: string };

/** Daemon-side ready reply for a start event. */
const readyFor = (sock: Socket, start: { sessionId: string }): void => {
  void sock.emit('chat:session.ready', {
    sessionId: start.sessionId,
    agentName: 'fixture-agent',
    agentVersion: '0.1.0',
  });
};

/** Collect `chat:event` payloads matching `pred` (events stream in order). */
const nextEvent = async (
  sock: Socket,
  pred: (e: ChatStreamEvent) => boolean,
  timeoutMs = 5000,
): Promise<ChatStreamEvent> => {
  const seen: ChatStreamEvent[] = [];
  const grabbed = new Promise<ChatStreamEvent>((resolve) => {
    const onEvent = (envelope: { event: ChatStreamEvent }): void => {
      if (pred(envelope.event)) {
        sock.off('chat:event', onEvent);
        resolve(envelope.event);
      } else {
        seen.push(envelope.event);
      }
    };
    sock.on('chat:event', onEvent);
  });
  const timer = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`no matching chat:event (${seen.length} others seen)`)),
      timeoutMs,
    ),
  );
  return Promise.race([grabbed, timer]);
};

beforeAll(async () => {
  app = await buildApp(testConfig({ chatReadyTimeoutMs: 2500 }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'chatter', password: 'hunter2hunter2' },
  });
  jwt = reg.json().token;

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: authed(jwt),
    payload: { name: 'chat-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  const now = new Date().toISOString();
  await app.uow.agentInstances.save({
    id: 'agent-chat-1',
    machineId,
    ownerId: (await app.uow.users.findByUsername('chatter'))!.id,
    target: 'hermes',
    profileId: 'profile-chat-1',
    profileVersion: '1.0.0',
    name: 'chat agent',
    directory: '/home/tester/.hermes',
    jobId: 'job-chat-1',
    createdAt: now,
    updatedAt: now,
  });
  agentId = 'agent-chat-1';

  browser = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
  await once(browser, 'connect');
}, 20000);

afterAll(async () => {
  daemon?.close();
  browser?.close();
  await app?.close();
});

async function connectDaemon(capabilities: string[]): Promise<Socket> {
  const sock = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  await once(sock, 'connect');
  await emitAck(sock, 'machine:hello', { daemonVersion: '0.4.0-test', capabilities });
  return sock;
}

describe('gating', () => {
  it('refuses while remote chat is disabled, machine offline, or daemon lacks chat', async () => {
    daemon = await connectDaemon(['inventory', 'chat']);

    let res = await openSession(browser, agentId);
    expect(res.error).toBe('REMOTE_CHAT_DISABLED');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { remoteChatEnabled: true },
    });
    expect(patch.json().machine.remoteChatEnabled).toBe(true);

    daemon.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
    res = await openSession(browser, agentId);
    expect(res.error).toBe('MACHINE_OFFLINE');

    daemon = await connectDaemon(['inventory']); // no 'chat'
    res = await openSession(browser, agentId);
    expect(res.error).toBe('DAEMON_NO_CHAT');

    daemon.close();
    daemon = await connectDaemon(['chat']);
  });

  it('a non-owner cannot even see the agent (existence hiding)', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'chatterother', password: 'hunter2hunter2' },
    });
    const other = io(`${baseUrl}/app`, {
      auth: { token: reg.json().token },
      transports: ['websocket'],
    });
    await once(other, 'connect');
    const res = await openSession(other, agentId);
    expect(res.error).toBe('AGENT_INSTANCE_NOT_FOUND');
    const rest = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: authed(reg.json().token),
    });
    expect(rest.statusCode).toBe(404);
    other.close();
  });
});

describe('rejoin + boot orphan sweep', () => {
  it('fresh open acks phase starting; a rejoin acks ready AND re-pushes ready', async () => {
    // Local socket — the lifecycle suite below reuses the gating suite's
    // shared `daemon`; closing it here would starve them.
    const d = await connectDaemon(['chat']);
    const startPromise = new Promise<{ sessionId: string }>((resolve) => {
      d.on('chat:session.start', (p: { sessionId: string }) => resolve(p));
    });
    const fresh = await openSession(browser, agentId);
    const start = await startPromise;
    expect(fresh.sessionId).toBe(start.sessionId);
    expect(fresh.phase).toBe('starting');

    readyFor(d, start);
    await once(browser, 'chat:session.ready');

    // Rejoin: ack says ready, and the ready push is re-delivered to the room.
    const gotPush = once(browser, 'chat:session.ready');
    const rejoin = await openSession(browser, agentId, start.sessionId);
    expect(rejoin.sessionId).toBe(start.sessionId);
    expect(rejoin.phase).toBe('ready');
    await gotPush;

    await emitAck(d, 'chat:session.closed', {
      sessionId: start.sessionId,
      reason: 'user',
    });
    await once(browser, 'chat:session.closed');
    d.close();
  }, 15000);

  it('sweepOrphanedSessions closes rows a previous server process left open', async () => {
    const now = new Date().toISOString();
    await app.uow.acSessions.save({
      id: 'orphan-1',
      agentInstanceId: agentId,
      machineId,
      ownerId: (await app.uow.users.findByUsername('chatter'))!.id,
      openedAt: now,
      closedAt: null,
      closeReason: null,
      cwd: null,
      title: null,
    });
    expect((await app.uow.acSessions.listOpen()).map((r) => r.id)).toContain('orphan-1');
    await app.realtime.chat.sweepOrphanedSessions();
    const row = await app.uow.acSessions.findById('orphan-1');
    expect(row?.closedAt).not.toBeNull();
    expect(row?.closeReason).toBe('server-restarted');
    expect((await app.uow.acSessions.listOpen()).map((r) => r.id)).not.toContain('orphan-1');
  });
});

describe('workspace directories (9 W6)', () => {
  it('validates the picked directory against the base workspace before anything else', async () => {
    // No base workspace configured yet.
    let res = await openSessionDir(browser, agentId, '/home/tester/work/proj-a');
    expect(res.error).toBe('WORKSPACE_NOT_SET');

    await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { baseWorkspace: '/home/tester/work' },
    });

    // Outside the root (even after resolution).
    res = await openSessionDir(browser, agentId, '/home/tester/elsewhere');
    expect(res.error).toBe('WORKSPACE_INVALID');
    res = await openSessionDir(browser, agentId, '/home/tester/work/../../etc');
    expect(res.error).toBe('WORKSPACE_INVALID');

    // A valid subdirectory: start carries it and the audit row records it.
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      res = await openSessionDir(browser, agentId, '/home/tester/work/proj-a/');
      expect(res.sessionId).toBeTruthy();
      const start = (await startPromise) as { sessionId: string; cwd: string };
      expect(start.cwd).toBe('/home/tester/work/proj-a');
      const row = await app.uow.acSessions.findById(res.sessionId!);
      expect(row?.cwd).toBe('/home/tester/work/proj-a');
      expect(row?.title).toBeNull();

      // The root itself is allowed.
      const rootStart = once(d, 'chat:session.start');
      const rootRes = await openSessionDir(browser, agentId, '/home/tester/work');
      const rootEvt = (await rootStart) as { cwd: string };
      expect(rootEvt.cwd).toBe('/home/tester/work');
      expect(rootRes.sessionId).toBeTruthy();

      await emitAck(d, 'chat:session.closed', { sessionId: res.sessionId!, reason: 'user' });
      await emitAck(d, 'chat:session.closed', { sessionId: rootRes.sessionId!, reason: 'user' });
    } finally {
      d.close();
    }
  }, 15000);

  it('derives the session title from the FIRST prompt only', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      const start = (await startPromise) as { sessionId: string };
      readyFor(d, start);
      await once(browser, 'chat:session.ready');

      await emitAck(browser, 'chat:message.send', {
        sessionId: res.sessionId,
        content: 'Fix the login bug\nand the signup one too',
      });
      // The title write is fire-and-forget — poll for it.
      const deadline = Date.now() + 5000;
      let row = await app.uow.acSessions.findById(res.sessionId!);
      while (row?.title == null && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
        row = await app.uow.acSessions.findById(res.sessionId!);
      }
      // First LINE, whitespace-collapsed — the second line never joins it.
      expect(row?.title).toBe('Fix the login bug');

      await emitAck(d, 'chat:session.closed', { sessionId: res.sessionId!, reason: 'user' });
    } finally {
      d.close();
    }
  }, 15000);
});

describe('session lifecycle', () => {
  it(
    'open → start → ready → prompt round-trip with streaming + permission',
    { timeout: 15000 },
    async () => {
      const startP = once(daemon, 'chat:session.start');
      const res = await openSession(browser, agentId);
      expect(res.sessionId).toBeTruthy();
      const sessionId = res.sessionId!;

      const start = (await startP) as { sessionId: string; target: string; cwd: string };
      expect(start.sessionId).toBe(sessionId);
      expect(start.target).toBe('hermes');
      expect(start.cwd).toBe('/home/tester/.hermes');

      const readyP = once(browser, 'chat:session.ready');
      readyFor(daemon, start);
      const ready = (await readyP) as { sessionId: string; agentName?: string };
      expect(ready.sessionId).toBe(sessionId);
      expect(ready.agentName).toBe('fixture-agent');

      // Prompt: browser → server → daemon (string normalized to a text block).
      const promptP = once(daemon, 'chat:message.send');
      const sendAck = await emitAck(browser, 'chat:message.send', {
        sessionId,
        content: 'hello agent',
      });
      expect(sendAck).toEqual({ accepted: true });
      const prompt = (await promptP) as { sessionId: string; prompt: unknown[] };
      expect(prompt.sessionId).toBe(sessionId);
      expect(prompt.prompt).toEqual([{ type: 'text', text: 'hello agent' }]);

      // Stream back: status → delta; the busy gate rejects a second prompt.
      // Listeners attach BEFORE the triggering emits — socket.io does not
      // buffer events for absent listeners.
      const activeP = nextEvent(browser, (e) => e.kind === 'session_status');
      const deltaP = nextEvent(browser, (e) => e.kind === 'message_delta');
      daemon.emit('chat:event', { sessionId, event: { kind: 'session_status', state: 'active' } });
      daemon.emit('chat:event', {
        sessionId,
        event: { kind: 'message_delta', delta: 'working on it' },
      });
      expect(await activeP).toEqual({ kind: 'session_status', state: 'active' });
      expect(await deltaP).toEqual({ kind: 'message_delta', delta: 'working on it' });

      const busy = await emitAck(browser, 'chat:message.send', {
        sessionId,
        content: 'too early',
      });
      expect(busy).toEqual({ error: 'SESSION_BUSY' });

      const permReqP = nextEvent(browser, (e) => e.kind === 'permission_request');
      daemon.emit('chat:event', {
        sessionId,
        event: {
          kind: 'permission_request',
          requestId: 'perm-1',
          toolCall: { toolCallId: 't1', title: 'run fixture tool', kind: 'execute' },
          options: [
            { optionId: 'allow_always', name: 'Allow', kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
      await permReqP;

      const respondP = once(daemon, 'chat:permission.respond');
      const resolvedP = nextEvent(browser, (e) => e.kind === 'permission_resolved');
      const respondAck = await emitAck(browser, 'chat:permission.respond', {
        sessionId,
        requestId: 'perm-1',
        optionId: 'allow_always',
      });
      expect(respondAck).toEqual({ accepted: true });
      const forwarded = (await respondP) as {
        sessionId: string;
        requestId: string;
        optionId?: string;
      };
      expect(forwarded.optionId).toBe('allow_always'); // verbatim, never rewritten
      expect(await resolvedP).toEqual({
        kind: 'permission_resolved',
        requestId: 'perm-1',
        outcome: 'selected',
        optionId: 'allow_always',
      });

      const idleP = nextEvent(browser, (e) => e.kind === 'session_status' && e.state === 'idle');
      daemon.emit('chat:event', {
        sessionId,
        event: { kind: 'turn_result', stopReason: 'end_turn' },
      });
      daemon.emit('chat:event', { sessionId, event: { kind: 'session_status', state: 'idle' } });
      await idleP;
      const secondPromptP = once(daemon, 'chat:message.send');
      const ok = await emitAck(browser, 'chat:message.send', { sessionId, content: 'again' });
      expect(ok).toEqual({ accepted: true });
      await secondPromptP;

      // Re-join: a second tab opens the SAME session and sees new events.
      const tab2 = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(tab2, 'connect');
      const rejoin = await openSession(tab2, agentId, sessionId);
      expect(rejoin.sessionId).toBe(sessionId);
      const tabsP = nextEvent(tab2, (e) => e.kind === 'message_delta' && e.delta === 'hi tabs');
      daemon.emit('chat:event', { sessionId, event: { kind: 'message_delta', delta: 'hi tabs' } });
      await tabsP;
      tab2.close();

      // Leave no live session behind — later tests depend on the cap budget.
      const selfClosedP = once(browser, 'chat:session.closed');
      await emitAck(browser, 'chat:session.close', { sessionId });
      await selfClosedP;
    },
  );

  it('permission timeout answers the daemon with cancelled and settles the card', async () => {
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(daemon, start);
    await readyP;

    daemon.emit('chat:event', {
      sessionId: start.sessionId,
      event: {
        kind: 'permission_request',
        requestId: 'perm-timeout',
        toolCall: { toolCallId: 't2' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      },
    });
    const cancelP = once(daemon, 'chat:permission.respond');
    const cancel = (await cancelP) as { requestId: string; optionId?: string };
    expect(cancel.requestId).toBe('perm-timeout');
    expect(cancel.optionId).toBeUndefined(); // cancelled
    const settled = await nextEvent(browser, (e) => e.kind === 'permission_resolved', 3000);
    expect(settled).toEqual({
      kind: 'permission_resolved',
      requestId: 'perm-timeout',
      outcome: 'timeout',
    });

    const closedP = once(browser, 'chat:session.closed');
    await emitAck(browser, 'chat:session.close', { sessionId: start.sessionId });
    await closedP;
  });

  it('spawn failure (ready with error) closes the channel as spawn-failed', async () => {
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const failedP = once(browser, 'chat:session.failed');
    const failedClosedP = once(browser, 'chat:session.closed');
    daemon.emit('chat:session.ready', {
      sessionId: start.sessionId,
      error: 'npx: command not found',
    });
    const failed = (await failedP) as {
      sessionId: string;
      error: string;
    };
    expect(failed.error).toContain('npx');
    await failedClosedP;
    const rows = await app.uow.acSessions.listByAgentInstance(agentId);
    const row = rows.find((r) => r.id === start.sessionId);
    expect(row?.closedAt).not.toBeNull();
    expect(row?.closeReason).toBe('spawn-failed');
  });

  it(
    'ready watchdog closes a channel the daemon never reports ready',
    { timeout: 10000 },
    async () => {
      const startP = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      await startP; // daemon stays silent on purpose
      const closed = (await once(browser, 'chat:session.closed', 6000)) as {
        sessionId: string;
        reason: string;
      };
      expect(closed.reason).toBe('spawn-timeout');
    },
  );

  it('caps concurrent open sessions per machine', async () => {
    // Live sessions from earlier tests are closed; open two fresh ones.
    for (let i = 0; i < 2; i++) {
      const startP = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      readyFor(daemon, start);
      await readyP;
    }
    const third = await openSession(browser, agentId);
    expect(third.error).toBe('SESSION_LIMIT_REACHED');
  });

  it(
    'daemon disconnect closes every open channel (no resume in v1)',
    { timeout: 10000 },
    async () => {
      daemon.close();
      const closed = (await once(browser, 'chat:session.closed', 6000)) as { reason: string };
      expect(closed.reason).toBe('connection-lost');
      const open = await app.uow.acSessions.listOpenByMachine(machineId);
      expect(open).toHaveLength(0);
    },
  );

  it('user close notifies the daemon and settles the row', async () => {
    daemon = await connectDaemon(['chat']);
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(daemon, start);
    await readyP;

    const daemonCloseP = once(daemon, 'chat:session.close');
    const selfClosedP = once(browser, 'chat:session.closed');
    const ack = await emitAck(browser, 'chat:session.close', { sessionId: start.sessionId });
    expect(ack).toEqual({ closed: true });
    const toDaemon = (await daemonCloseP) as { sessionId: string; reason?: string };
    expect(toDaemon.sessionId).toBe(start.sessionId);
    await selfClosedP;
    const rows = await app.uow.acSessions.listByAgentInstance(agentId);
    expect(rows.find((r) => r.id === start.sessionId)?.closeReason).toBe('user');
  });

  it('daemon-initiated close (agent exited) reaches the viewer', async () => {
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(daemon, start);
    await readyP;

    const closedP = once(browser, 'chat:session.closed');
    daemon.emit('chat:session.closed', { sessionId: start.sessionId, reason: 'agent-exited' });
    const closed = (await closedP) as { reason: string };
    expect(closed.reason).toBe('agent-exited');
  });
});

describe('REST surface', () => {
  it('lists the audit rows for the agent (owner)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: authed(jwt),
    });
    expect(res.statusCode).toBe(200);
    const sessions = res.json().sessions as { id: string; closedAt: string | null }[];
    expect(sessions.length).toBeGreaterThanOrEqual(4);
    expect(sessions.every((s) => s.closedAt !== null)).toBe(true); // all closed by now
  });
});

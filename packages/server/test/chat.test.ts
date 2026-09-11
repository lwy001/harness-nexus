import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';
import { emitAck, once, testConfig, waitFor } from './helpers.js';

/**
 * Chat integration (Phase 8 C5, reworked 9 W7) with a fake daemon on /ctl and
 * a fake browser on /app: open → start → ready → message round-trip,
 * permission respond + timeout watchdog, busy gate, re-join (+ history
 * resync), resume passthrough, spawn failure, ready-timeout, session cap,
 * disconnect teardown, user disconnect, and the gating matrix.
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

/** 9 W7 — open resuming the agent's OWN native session. */
const openSessionResume = async (
  sock: Socket,
  agentInstanceId: string,
  resume: { sessionId: string; cwd: string },
): Promise<{ sessionId?: string; phase?: 'starting' | 'ready'; error?: string }> =>
  (await emitAck(sock, 'chat:session.open', {
    agentInstanceId,
    resume,
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
}, 20000);

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

describe('rejoin (9 W7 — resync, no persisted rows)', () => {
  it('fresh open acks phase starting; a rejoin acks ready, re-pushes ready, and asks the daemon to resync history', async () => {
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
    const ready = (await once(browser, 'chat:session.ready')) as {
      nativeSessionId?: string;
    };
    // The daemon's ready carries the agent's own session id; the server
    // re-pushes ready (with it) and asks for a history resync.
    expect(ready.nativeSessionId).toBeUndefined(); // this fake daemon sends none

    const resyncP = once(d, 'chat:session.resync');
    const gotPush = once(browser, 'chat:session.ready');
    const rejoin = await openSession(browser, agentId, start.sessionId);
    expect(rejoin.sessionId).toBe(start.sessionId);
    expect(rejoin.phase).toBe('ready');
    await gotPush;
    const resync = (await resyncP) as { sessionId: string };
    expect(resync.sessionId).toBe(start.sessionId);

    await emitAck(d, 'chat:session.closed', {
      sessionId: start.sessionId,
      reason: 'user',
    });
    await once(browser, 'chat:session.closed');
    d.close();
  }, 15000);

  it('relays a daemon history batch to the channel room', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      const start = (await startPromise) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      d.emit('chat:session.ready', { sessionId: start.sessionId, nativeSessionId: 'native-7' });
      const ready = (await readyP) as { nativeSessionId?: string };
      expect(ready.nativeSessionId).toBe('native-7');

      const historyP = once(browser, 'chat:history');
      d.emit('chat:history', {
        sessionId: start.sessionId,
        items: [
          { type: 'user', blocks: [{ type: 'text', text: 'earlier question' }] },
          { type: 'event', event: { kind: 'message_delta', delta: 'earlier answer' } },
        ],
      });
      const history = (await historyP) as { sessionId: string; items: unknown[] };
      expect(history.sessionId).toBe(start.sessionId);
      expect(history.items).toHaveLength(2);

      await emitAck(d, 'chat:session.closed', { sessionId: start.sessionId, reason: 'user' });
      await once(browser, 'chat:session.closed');
    } finally {
      d.close();
    }
  }, 15000);
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

    // A valid subdirectory: start carries it.
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      res = await openSessionDir(browser, agentId, '/home/tester/work/proj-a/');
      expect(res.sessionId).toBeTruthy();
      const start = (await startPromise) as { sessionId: string; cwd: string };
      expect(start.cwd).toBe('/home/tester/work/proj-a');

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

  it('resume passes the native session + its cwd through VERBATIM (no containment)', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      // A cwd OUTSIDE the base workspace — legal on resume (it came from the
      // daemon's own listing; dsh enforces its own match).
      const res = await openSessionResume(browser, agentId, {
        sessionId: 'native-s-1',
        cwd: '/somewhere/else/entirely',
      });
      expect(res.sessionId).toBeTruthy();
      const start = (await startPromise) as {
        sessionId: string;
        cwd: string;
        resume?: { sessionId: string; cwd: string };
      };
      expect(start.cwd).toBe('/somewhere/else/entirely');
      expect(start.resume).toEqual({ sessionId: 'native-s-1', cwd: '/somewhere/else/entirely' });

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

  it(
    'a full TOTAL budget evicts the oldest non-busy channel instead of rejecting',
    { timeout: 15000 },
    async () => {
      // Helpers default the budget to 2 total / 1 active.
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const startP = once(daemon, 'chat:session.start');
        await openSession(browser, agentId);
        const start = (await startP) as { sessionId: string };
        const readyP = once(browser, 'chat:session.ready');
        readyFor(daemon, start);
        await readyP;
        ids.push(start.sessionId);
      }

      // Third open at cap: the OLDEST (idle) channel gives way — no rejection.
      const evictedP = once(browser, 'chat:session.closed');
      const startP = once(daemon, 'chat:session.start');
      const third = await openSession(browser, agentId);
      expect(third.error).toBeUndefined();
      const evicted = (await evictedP) as { sessionId: string; reason: string };
      expect(evicted.sessionId).toBe(ids[0]);
      expect(evicted.reason).toBe('evicted');
      const start3 = (await startP) as { sessionId: string };
      const ready3P = once(browser, 'chat:session.ready');
      readyFor(daemon, start3);
      await ready3P;

      // Leave the table clean for the tests below.
      await emitAck(browser, 'chat:session.close', { sessionId: ids[1]! });
      await emitAck(browser, 'chat:session.close', { sessionId: third.sessionId! });
    },
  );

  it(
    'a full budget where EVERY channel is mid-turn still rejects',
    { timeout: 15000 },
    async () => {
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const startP = once(daemon, 'chat:session.start');
        await openSession(browser, agentId);
        const start = (await startP) as { sessionId: string };
        const readyP = once(browser, 'chat:session.ready');
        readyFor(daemon, start);
        await readyP;
        ids.push(start.sessionId);
        // Mid-turn sessions are eviction-proof — mark both busy.
        daemon.emit('chat:event', {
          sessionId: start.sessionId,
          event: { kind: 'session_status', state: 'active' },
        });
      }
      const third = await openSession(browser, agentId);
      expect(third.error).toBe('SESSION_LIMIT_REACHED');
      for (const id of ids) {
        daemon.emit('chat:event', {
          sessionId: id,
          event: { kind: 'session_status', state: 'idle' },
        });
        await emitAck(browser, 'chat:session.close', { sessionId: id });
      }
    },
  );

  it(
    'an ACTIVE budget bounces a prompt on an otherwise idle channel',
    { timeout: 15000 },
    async () => {
      // Active cap is 1 (helpers): one generating session blocks every other.
      const startP1 = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      const s1 = (await startP1) as { sessionId: string };
      const ready1P = once(browser, 'chat:session.ready');
      readyFor(daemon, s1);
      await ready1P;
      daemon.emit('chat:event', {
        sessionId: s1.sessionId,
        event: { kind: 'session_status', state: 'active' },
      });

      const startP2 = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      const s2 = (await startP2) as { sessionId: string };
      const ready2P = once(browser, 'chat:session.ready');
      readyFor(daemon, s2);
      await ready2P;

      const bounced = await emitAck(browser, 'chat:message.send', {
        sessionId: s2.sessionId,
        content: 'should bounce',
      });
      expect(bounced).toEqual({ error: 'MACHINE_BUSY' });

      // The generating turn ends → the same prompt goes through.
      daemon.emit('chat:event', {
        sessionId: s1.sessionId,
        event: { kind: 'session_status', state: 'idle' },
      });
      const ok = await emitAck(browser, 'chat:message.send', {
        sessionId: s2.sessionId,
        content: 'goes through',
      });
      expect(ok).toEqual({ accepted: true });

      await emitAck(browser, 'chat:session.close', { sessionId: s1.sessionId });
      await emitAck(browser, 'chat:session.close', { sessionId: s2.sessionId });
    },
  );

  it(
    'the last viewer leaving (socket gone) closes an IDLE channel — the adapter dies',
    { timeout: 10000 },
    async () => {
      // A second viewer socket, so the file's shared `browser` stays alive.
      const viewer = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(viewer, 'connect');
      const startP = once(daemon, 'chat:session.start');
      await openSession(viewer, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(viewer, 'chat:session.ready');
      readyFor(daemon, start);
      await readyP;

      // Viewer drops (tab close / full refresh) with nobody else in the room:
      // the channel must close and TELL THE DAEMON (this teardown was missing —
      // adapters piled up on the machine until every later spawn timed out).
      const daemonCloseP = once(daemon, 'chat:session.close');
      viewer.close();
      const toDaemon = (await daemonCloseP) as { sessionId: string };
      expect(toDaemon.sessionId).toBe(start.sessionId);
    },
  );

  it(
    'the last viewer leaving MID-TURN closes the channel when the turn ends',
    { timeout: 15000 },
    async () => {
      const viewer = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(viewer, 'connect');
      const startP = once(daemon, 'chat:session.start');
      await openSession(viewer, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(viewer, 'chat:session.ready');
      readyFor(daemon, start);
      await readyP;
      daemon.emit('chat:event', {
        sessionId: start.sessionId,
        event: { kind: 'session_status', state: 'active' },
      });

      // Viewer drops while generating: NO close yet (the turn must finish and
      // persist), then the idle transition lands it.
      const daemonCloseP = once(daemon, 'chat:session.close');
      viewer.close();
      await new Promise((r) => setTimeout(r, 400));
      daemon.emit('chat:event', {
        sessionId: start.sessionId,
        event: { kind: 'turn_result', stopReason: 'end_turn' },
      });
      daemon.emit('chat:event', {
        sessionId: start.sessionId,
        event: { kind: 'session_status', state: 'idle' },
      });
      const toDaemon = (await daemonCloseP) as { sessionId: string };
      expect(toDaemon.sessionId).toBe(start.sessionId);
    },
  );

  it(
    'daemon disconnect closes every open channel (the native sessions survive)',
    { timeout: 10000 },
    async () => {
      // Self-sufficient: the budget tests above leave a clean table.
      const startP = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      readyFor(daemon, start);
      await readyP;

      daemon.close();
      const closed = (await once(browser, 'chat:session.closed', 6000)) as { reason: string };
      expect(closed.reason).toBe('connection-lost');
    },
  );

  it(
    'a daemon RECONNECT reaps the previous connection’s channels even when the machine never went offline',
    { timeout: 10000 },
    async () => {
      // The reconnect race: the replacement socket registers BEFORE the old
      // one's disconnect is processed, so presence never flips and the
      // offline-transition reap is skipped. The old channels are dead (the
      // daemon tears sessions down with its socket) yet they kept their slots
      // — every later open answered SESSION_LIMIT_REACHED until a server
      // restart. Reaping on connection is what makes a daemon restart
      // recoverable.
      // The daemon that came back is tracked locally so the test can close it:
      // a socket left connected here makes the suite's `app.close()` hang.
      const reconnected = await connectDaemon(['chat']);
      daemon = reconnected;
      const startP = once(reconnected, 'chat:session.start');
      await openSession(browser, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      readyFor(reconnected, start);
      await readyP;

      // The old socket stays connected on purpose (no offline transition).
      // The listener must be attached BEFORE the replacement connects: the reap
      // fires on connection, i.e. before `connectDaemon` even returns.
      const closedP = once(browser, 'chat:session.closed', 6000);
      const replacement = await connectDaemon(['chat']);
      const closed = (await closedP) as { reason: string };
      expect(closed.reason).toBe('connection-lost');

      try {
        // And the cap is free again — a fresh open is accepted.
        const startP2 = once(replacement, 'chat:session.start');
        const again = await openSession(browser, agentId);
        expect(again.error).toBeUndefined();
        const start2 = (await startP2) as { sessionId: string };
        const closed2P = once(browser, 'chat:session.closed');
        await emitAck(browser, 'chat:session.close', { sessionId: start2.sessionId });
        await closed2P;
      } finally {
        replacement.close();
        reconnected.close();
      }
    },
  );

  it('user disconnect notifies the daemon (channel-only — no session finality)', async () => {
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
  it('requires the sessions capability on the (online) daemon', async () => {
    // The full gating matrix lives in sessions-route.test.ts; here just the
    // shared daemon (online, 'chat' only) against the native listing.
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: authed(jwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_SESSIONS');
  });
});

describe('session config (9 W9 A)', () => {
  it(
    'ready carries promptCapabilities; config.set forwards to the daemon; session_config relays',
    { timeout: 15000 },
    async () => {
      // LOCAL daemon: reassigning the module-level var would orphan the
      // connection an earlier describe left for afterAll to close.
      const d = await connectDaemon(['chat']);
      try {
        const startP = once(d, 'chat:session.start');
        const res = await openSession(browser, agentId);
        const sessionId = res.sessionId!;
        const start = (await startP) as { sessionId: string };

        const readyP = once(browser, 'chat:session.ready');
        void d.emit('chat:session.ready', {
          sessionId: start.sessionId,
          agentName: 'fixture-agent',
          promptCapabilities: { image: true, embeddedContext: true },
        });
        const ready = (await readyP) as { promptCapabilities?: { image: boolean } };
        expect(ready.promptCapabilities).toEqual({ image: true, embeddedContext: true });

        // Mode arm — forwarded verbatim over /ctl.
        const modeP = once(d, 'chat:config.set');
        const modeAck = await emitAck(browser, 'chat:config.set', {
          sessionId,
          kind: 'mode',
          modeId: 'acceptEdits',
        });
        expect(modeAck).toEqual({ accepted: true });
        expect(await modeP).toEqual({ sessionId, kind: 'mode', modeId: 'acceptEdits' });

        // Option arm (empty value allowed — dsh provider-default reasoning).
        const optP = once(d, 'chat:config.set');
        const optAck = await emitAck(browser, 'chat:config.set', {
          sessionId,
          kind: 'option',
          configId: 'reasoning_effort',
          value: '',
        });
        expect(optAck).toEqual({ accepted: true });
        expect(await optP).toEqual({
          sessionId,
          kind: 'option',
          configId: 'reasoning_effort',
          value: '',
        });

        // The daemon's session_config snapshots relay to the channel room.
        const configP = nextEvent(browser, (e) => e.kind === 'session_config');
        void d.emit('chat:event', {
          sessionId,
          event: {
            kind: 'session_config',
            modes: { currentModeId: 'acceptEdits' },
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                currentValue: 'fx-opus',
                options: [{ value: 'fx-opus', name: 'Fixture Opus' }],
              },
            ],
          },
        });
        expect(await configP).toEqual({
          kind: 'session_config',
          modes: { currentModeId: 'acceptEdits' },
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'fx-opus',
              options: [{ value: 'fx-opus', name: 'Fixture Opus' }],
            },
          ],
        });

        // Ownership: a config.set for an unknown session bounces.
        const bad = await emitAck(browser, 'chat:config.set', {
          sessionId: 'nope',
          kind: 'mode',
          modeId: 'x',
        });
        expect(bad).toEqual({ error: 'SESSION_NOT_FOUND' });

        await emitAck(browser, 'chat:session.close', { sessionId, reason: 'user' });
      } finally {
        d.disconnect();
        await new Promise((r) => setTimeout(r, 150));
      }
    },
  );

  it('rejects config.set while the channel is still starting', { timeout: 15000 }, async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startP = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      const sessionId = res.sessionId!;
      await startP; // deliberately NO ready yet
      const early = await emitAck(browser, 'chat:config.set', {
        sessionId,
        kind: 'mode',
        modeId: 'acceptEdits',
      });
      expect(early).toEqual({ error: 'SESSION_NOT_READY' });
      await emitAck(browser, 'chat:session.close', { sessionId, reason: 'user' });
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  });
});

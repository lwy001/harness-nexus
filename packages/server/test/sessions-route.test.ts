import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Native session listing round-trip (Phase 9 W7): the REST route rides
 * `sessions:list` over /ctl to the daemon and returns the AGENT'S OWN
 * sessions — plus the gates (offline, capability, timeout, daemon error arm,
 * unsupported target, ownership).
 */

let app: FastifyInstance;
let baseUrl: string;
let ownerJwt: string;
let strangerJwt: string;
let machineId: string;
let machineToken: string;
let agentId: string;
let daemon: Socket;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = await buildApp(testConfig({ sessionsListTimeoutMs: 500 }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const [username, key] of [
    ['w7owner', 'ownerJwt'],
    ['w7stranger', 'strangerJwt'],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'hunter2hunter2' },
    });
    if (key === 'ownerJwt') ownerJwt = res.json().token;
    else strangerJwt = res.json().token;
  }
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: auth(ownerJwt),
    payload: { name: 'w7-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  const now = new Date().toISOString();
  const ownerId = (await app.uow.users.findByUsername('w7owner'))!.id;
  await app.uow.agentInstances.save({
    id: 'agent-w7-1',
    machineId,
    ownerId,
    target: 'claude-code',
    profileId: null,
    profileVersion: null,
    name: 'w7 agent',
    directory: '/home/w7/.claude',
    jobId: null,
    source: 'detected',
    createdAt: now,
    updatedAt: now,
  });
  agentId = 'agent-w7-1';
});

afterAll(async () => {
  daemon?.disconnect();
  await app.close();
});

/** Connect a fake daemon with the given capabilities + sessions responder. */
async function connectDaemon(
  capabilities: string[],
  respond: (target: string) => Record<string, unknown>,
): Promise<void> {
  daemon = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  await new Promise<void>((resolve) => {
    daemon.on('connect', () => {
      daemon.emit('machine:hello', { daemonVersion: 'test', capabilities }, () => resolve());
    });
  });
  daemon.on('sessions:list', (payload: { requestId: string; target: string }) => {
    daemon.emit('sessions:list:result', {
      requestId: payload.requestId,
      ...respond(payload.target),
    });
  });
}

describe('GET /api/agent-instances/:id/sessions (9 W7)', () => {
  it('404s for strangers and 409s while offline', async () => {
    const stranger = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(strangerJwt),
    });
    expect(stranger.statusCode).toBe(404);
    const offline = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error).toBe('MACHINE_OFFLINE');
  });

  it('409s when the daemon lacks the sessions capability', async () => {
    await connectDaemon(['chat'], () => ({ sessions: [] }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_SESSIONS');
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('round-trips the daemon listing (target rides the /ctl event)', async () => {
    await connectDaemon(['sessions'], (target) => ({
      sessions: [
        {
          sessionId: `native-${target}-1`,
          cwd: '/home/w7/projects/alpha',
          title: 'prior turn',
          updatedAt: '2026-09-10T00:00:00.000Z',
        },
      ],
    }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      agent: expect.objectContaining({ id: agentId }),
      supported: true,
      sessions: [
        {
          sessionId: 'native-claude-code-1',
          cwd: '/home/w7/projects/alpha',
          title: 'prior turn',
          updatedAt: '2026-09-10T00:00:00.000Z',
        },
      ],
    });
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('surfaces an unsupported target and maps the error/timeout arms', async () => {
    await connectDaemon(['sessions'], () => ({ supported: false }));
    const unsupported = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(unsupported.statusCode).toBe(200);
    expect(unsupported.json().supported).toBe(false);
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    await connectDaemon(['sessions'], () => ({ error: 'npx failed' }));
    const failed = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('DAEMON_SESSIONS_FAILED');
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    // Silent daemon → 504 (timeout 500ms via testConfig).
    await connectDaemon(['sessions'], () => ({ sessions: [] }));
    daemon.removeAllListeners('sessions:list');
    const timeout = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error).toBe('SESSIONS_TIMEOUT');
  });
});

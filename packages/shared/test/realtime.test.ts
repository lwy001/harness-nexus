import { describe, expect, it } from 'vitest';
import {
  appHandshakeAuthSchema,
  ctlHandshakeAuthSchema,
  jobDispatchEventSchema,
  jobProgressEventSchema,
  machineHelloAckSchema,
  machineHelloSchema,
  machineStatusEventSchema,
} from '../src/realtime.js';

describe('realtime handshake schemas', () => {
  it('accepts a /ctl handshake with token + machineId', () => {
    expect(ctlHandshakeAuthSchema.parse({ token: 'hnpat_x', machineId: 'm1' })).toEqual({
      token: 'hnpat_x',
      machineId: 'm1',
    });
  });

  it('rejects a /ctl handshake missing machineId', () => {
    expect(ctlHandshakeAuthSchema.safeParse({ token: 'hnpat_x' }).success).toBe(false);
  });

  it('accepts a /app handshake with just a token', () => {
    expect(appHandshakeAuthSchema.parse({ token: 'jwt-or-pat' })).toEqual({
      token: 'jwt-or-pat',
    });
  });
});

describe('machine:hello', () => {
  it('parses and defaults capabilities to []', () => {
    const parsed = machineHelloSchema.parse({ daemonVersion: '0.1.0' });
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.daemonVersion).toBe('0.1.0');
  });

  it('parses a full hello', () => {
    const parsed = machineHelloSchema.parse({
      daemonVersion: '0.1.0',
      os: 'linux',
      arch: 'x64',
      hostname: 'laptop',
      capabilities: ['deploy'],
    });
    expect(parsed.hostname).toBe('laptop');
    expect(parsed.capabilities).toEqual(['deploy']);
  });

  it('rejects an empty daemonVersion', () => {
    expect(machineHelloSchema.safeParse({ daemonVersion: '' }).success).toBe(false);
  });

  it('ack shape round-trips', () => {
    expect(machineHelloAckSchema.parse({ proto: 1, machineId: 'm1' })).toEqual({
      proto: 1,
      machineId: 'm1',
    });
  });
});

describe('machine:status push', () => {
  it('accepts online with a null lastSeenAt', () => {
    expect(
      machineStatusEventSchema.safeParse({ machineId: 'm1', online: true, lastSeenAt: null })
        .success,
    ).toBe(true);
  });

  it('rejects a missing online flag', () => {
    expect(machineStatusEventSchema.safeParse({ machineId: 'm1', lastSeenAt: null }).success).toBe(
      false,
    );
  });
});

describe('job envelopes (v0, handlers land in C4)', () => {
  const job = {
    id: 'j1',
    machineId: 'm1',
    ownerId: 'u1',
    type: 'deploy',
    status: 'queued',
    payload: { profileId: 'p1' },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  it('job:dispatch parses a full Job view', () => {
    expect(jobDispatchEventSchema.parse({ job })).toMatchObject({ job: { id: 'j1' } });
  });

  it('rejects an unknown job type', () => {
    expect(jobDispatchEventSchema.safeParse({ job: { ...job, type: 'nope' } }).success).toBe(false);
  });

  it('job progress percent stays within 0–100', () => {
    expect(
      jobProgressEventSchema.safeParse({ jobId: 'j1', phase: 'plan', percent: 150 }).success,
    ).toBe(false);
    expect(
      jobProgressEventSchema.safeParse({ jobId: 'j1', phase: 'plan', percent: 50 }).success,
    ).toBe(true);
  });
});

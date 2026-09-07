import { describe, expect, it } from 'vitest';
import {
  appHandshakeAuthSchema,
  chatMessageSendRequestSchema,
  chatPermissionRespondRequestSchema,
  chatSessionOpenRequestSchema,
  chatSessionStartEventSchema,
  chatStreamEventEnvelopeSchema,
  chatStreamEventSchema,
  ctlHandshakeAuthSchema,
  acpPermissionOptionSchema,
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

describe('chat stream schemas (C5)', () => {
  it('accepts every semantic event kind', () => {
    const events = [
      { kind: 'message_delta', delta: 'hello ' },
      { kind: 'thought_delta', delta: 'thinking…' },
      { kind: 'tool_call', call: { toolCallId: 't1', kind: 'edit', status: 'in_progress' } },
      { kind: 'usage', inputTokens: 10, outputTokens: 5 },
      {
        kind: 'permission_request',
        requestId: 'r1',
        toolCall: { toolCallId: 't1', title: 'run tool' },
        options: [
          { optionId: 'allow_always', name: 'Allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
      },
      {
        kind: 'permission_resolved',
        requestId: 'r1',
        outcome: 'selected',
        optionId: 'allow_always',
      },
      { kind: 'turn_result', stopReason: 'end_turn' },
      { kind: 'session_status', state: 'active' },
      { kind: 'raw', method: 'session/update', params: { sessionUpdate: 'plan' } },
    ];
    for (const event of events) {
      expect(chatStreamEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
  });

  it('rejects unknown kinds and bad enum values', () => {
    expect(chatStreamEventSchema.safeParse({ kind: 'nope' }).success).toBe(false);
    expect(
      chatStreamEventSchema.safeParse({ kind: 'turn_result', stopReason: 'crashed' }).success,
    ).toBe(false);
    expect(chatStreamEventSchema.safeParse({ kind: 'session_status', state: 'busy' }).success).toBe(
      false,
    );
  });

  it('validates the chat:event envelope wrapping an event', () => {
    expect(
      chatStreamEventEnvelopeSchema.safeParse({
        sessionId: 's1',
        event: { kind: 'turn_result', stopReason: 'cancelled' },
      }).success,
    ).toBe(true);
    expect(
      chatStreamEventEnvelopeSchema.safeParse({ sessionId: 's1', event: { kind: 'x' } }).success,
    ).toBe(false);
  });

  it('permission options keep optionId verbatim and cap the list', () => {
    const option = { optionId: 'weird id with spaces', name: 'x', kind: 'allow_once' };
    expect(acpPermissionOptionSchema.parse(option)).toEqual(option);
    const tooMany = {
      kind: 'permission_request' as const,
      requestId: 'r1',
      toolCall: { toolCallId: 't1' },
      options: Array.from({ length: 9 }, () => ({ ...option })),
    };
    expect(chatStreamEventSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('chat request schemas (C5)', () => {
  it('open accepts create and re-join forms', () => {
    expect(chatSessionOpenRequestSchema.parse({ agentInstanceId: 'a1' })).toEqual({
      agentInstanceId: 'a1',
    });
    expect(chatSessionOpenRequestSchema.parse({ agentInstanceId: 'a1', sessionId: 's1' })).toEqual({
      agentInstanceId: 'a1',
      sessionId: 's1',
    });
    expect(chatSessionOpenRequestSchema.safeParse({}).success).toBe(false);
  });

  it('message send accepts a string or block array', () => {
    expect(chatMessageSendRequestSchema.parse({ sessionId: 's1', content: 'hi' })).toEqual({
      sessionId: 's1',
      content: 'hi',
    });
    expect(
      chatMessageSendRequestSchema.safeParse({
        sessionId: 's1',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'resource_link', name: 'f', uri: 'file:///f' },
        ],
      }).success,
    ).toBe(true);
    expect(chatMessageSendRequestSchema.safeParse({ sessionId: 's1', content: '' }).success).toBe(
      false,
    );
    expect(chatMessageSendRequestSchema.safeParse({ sessionId: 's1', content: 42 }).success).toBe(
      false,
    );
  });

  it('permission respond treats missing optionId as cancel and keeps it verbatim', () => {
    expect(chatPermissionRespondRequestSchema.parse({ sessionId: 's1', requestId: 'r1' })).toEqual({
      sessionId: 's1',
      requestId: 'r1',
    });
    expect(
      chatPermissionRespondRequestSchema.parse({
        sessionId: 's1',
        requestId: 'r1',
        optionId: 'allow_always',
      }),
    ).toEqual({ sessionId: 's1', requestId: 'r1', optionId: 'allow_always' });
  });

  it('session start carries target and cwd', () => {
    expect(
      chatSessionStartEventSchema.safeParse({
        sessionId: 's1',
        agentInstanceId: 'a1',
        target: 'hermes',
        cwd: '/home/u/.hermes',
      }).success,
    ).toBe(true);
    expect(
      chatSessionStartEventSchema.safeParse({
        sessionId: 's1',
        agentInstanceId: 'a1',
        target: 'not-a-target',
        cwd: '/x',
      }).success,
    ).toBe(false);
  });
});

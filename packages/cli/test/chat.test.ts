import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachChatHandlers, mapAcpUpdate } from '../src/daemon/chat.js';
import { resolveAcpCommand } from '../src/daemon/acp/adapters.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';

/**
 * Chat session manager tests (Phase 8 C5): the pure ACP→semantic mapping, the
 * adapter command table, and a full round-trip against the fixture ACP agent
 * (test/fixtures/acp-agent.mjs) through a fake socket — the same path the
 * daemon takes in production.
 */

const FIXTURE = new URL('./fixtures/acp-agent.mjs', import.meta.url).pathname;

/** Minimal socket.io-client stand-in: records emits, lets tests deliver. */
class FakeSocket {
  emitted: { event: string; payload: unknown; ack?: (res: unknown) => void }[] = [];
  handlers = new Map<string, (payload: unknown, ack?: (res: unknown) => void) => void>();
  disconnected = false;

  emit(event: string, payload: unknown, ack?: (res: unknown) => void): boolean {
    if (ack !== undefined) this.emitted.push({ event, payload, ack });
    else this.emitted.push({ event, payload });
    return true;
  }

  on(event: string, handler: (payload: unknown, ack?: (res: unknown) => void) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  /** Test-side: deliver a server→daemon event. */
  receive(event: string, payload: unknown, ack?: (res: unknown) => void): void {
    this.handlers.get(event)?.(payload, ack);
  }

  eventsOf(kind: string): { payload: unknown }[] {
    return this.emitted.filter((e) => e.event === kind);
  }

  chatEvents(): ChatStreamEvent[] {
    return this.emitted
      .filter((e) => e.event === 'chat:event')
      .map((e) => (e.payload as { event: ChatStreamEvent }).event);
  }
}

describe('mapAcpUpdate', () => {
  // The daemon maps `session/update` params: { sessionId, update }.
  const map = (update: Record<string, unknown>): ChatStreamEvent | null => mapAcpUpdate({ update });

  it('maps message/thought chunks and tool calls', () => {
    expect(
      map({
        sessionUpdate: 'agent_message_chunk',
        contentBlock: { type: 'text', text: 'hello' },
      }),
    ).toEqual({ kind: 'message_delta', delta: 'hello' });
    expect(
      map({
        sessionUpdate: 'agent_thought_chunk',
        contentBlock: { type: 'text', text: 'hm' },
      }),
    ).toEqual({ kind: 'thought_delta', delta: 'hm' });
    expect(
      map({
        sessionUpdate: 'tool_call_update',
        toolCallUpdate: { toolCallId: 't1', kind: 'edit', status: 'completed' },
      }),
    ).toEqual({ kind: 'tool_call', call: { toolCallId: 't1', kind: 'edit', status: 'completed' } });
  });

  it('drops live user echo and wraps unknown updates as raw', () => {
    expect(
      map({ sessionUpdate: 'user_message_chunk', contentBlock: { type: 'text', text: 'x' } }),
    ).toBeNull();
    const raw = map({ sessionUpdate: 'plan', plan: [] });
    expect(raw).toEqual({
      kind: 'raw',
      method: 'session/update',
      params: { sessionUpdate: 'plan', plan: [] },
    });
  });

  it('maps usage defensively', () => {
    expect(
      map({ sessionUpdate: 'usage_update', usage: { inputTokens: 3, outputTokens: 4 } }),
    ).toEqual({ kind: 'usage', inputTokens: 3, outputTokens: 4 });
    expect(map({ sessionUpdate: 'usage_update' })).toEqual({ kind: 'usage' });
  });
});

describe('resolveAcpCommand', () => {
  it('defaults per target and honors env overrides', () => {
    expect(resolveAcpCommand('hermes', {})).toEqual({
      command: 'python3',
      args: ['-m', 'acp_adapter'],
    });
    expect(resolveAcpCommand('claude-code', {})).toMatchObject({ command: 'npx' });
    expect(resolveAcpCommand('zcode', {})).toBeNull();
    expect(
      resolveAcpCommand('claude-code', {
        HN_ACP_COMMAND_CLAUDE_CODE: 'node /tmp/adapter.js --flag',
      }),
    ).toEqual({ command: 'node', args: ['/tmp/adapter.js', '--flag'] });
    expect(resolveAcpCommand('hermes', { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}` })).toEqual({
      command: 'node',
      args: [FIXTURE],
    });
  });
});

describe('session round-trip vs the fixture agent', () => {
  const timers: NodeJS.Timeout[] = [];
  afterEach(() => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  });

  function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('start → ready → prompt → echo turn → permission turn → close', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-1',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { agentName?: string; error?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.agentName).toBe('fixture-agent');

    // Plain echo turn.
    const promptAck = vi.fn();
    socket.receive(
      'chat:message.send',
      { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
      promptAck,
    );
    expect(promptAck).toHaveBeenCalledWith({ accepted: true });
    const turn1 = await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    expect(turn1).toEqual({ kind: 'turn_result', stopReason: 'end_turn' });
    const deltas = socket.chatEvents().filter((e) => e.kind === 'message_delta');
    expect(deltas).toContainEqual({ kind: 'message_delta', delta: 'echo: hi' });
    expect(socket.chatEvents()).toContainEqual({ kind: 'session_status', state: 'idle' });

    // Permission turn: request surfaced, respond allow, verbatim optionId back.
    socket.receive('chat:message.send', {
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'please ask-permission now' }],
    });
    const perm = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'permission_request'),
    );
    if (perm.kind !== 'permission_request') throw new Error('not a permission event');
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow_always', 'reject_once']);
    const respondAck = vi.fn();
    socket.receive(
      'chat:permission.respond',
      { sessionId: 'sess-1', requestId: perm.requestId, optionId: 'allow_always' },
      respondAck,
    );
    expect(respondAck).toHaveBeenCalledWith({ accepted: true });
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta === 'permission granted: allow_always'),
    );

    // Close tears down (best-effort session/close + kill + closed event).
    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-1', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
    await waitFor(() => socket.eventsOf('chat:session.closed').length > 0);
    expect((socket.eventsOf('chat:session.closed')[0]!.payload as { reason: string }).reason).toBe(
      'user',
    );

    // A prompt for a closed session is unknown.
    const lateAck = vi.fn();
    socket.receive(
      'chat:message.send',
      { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
      lateAck,
    );
    expect(lateAck).toHaveBeenCalledWith({ error: 'unknown-session' });
  }, 15000);

  it('a prompt REJECTED with a protocol error ends the turn but keeps the channel', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-err',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload);

    socket.receive('chat:message.send', {
      sessionId: 'sess-err',
      prompt: [{ type: 'text', text: 'please error now' }],
    });
    const errEvent = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'raw' && e.method === 'hnx/prompt-error'),
    );
    expect((errEvent.params as { message: string }).message).toBe('Authentication required');
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'turn_result' && e.stopReason === 'end_turn'),
    );
    expect(socket.chatEvents()).toContainEqual({ kind: 'session_status', state: 'idle' });
    // The channel SURVIVES the errored turn (the old code tore it down).
    expect(socket.eventsOf('chat:session.closed')).toHaveLength(0);

    // …and the very next prompt still works (echo).
    socket.receive('chat:message.send', {
      sessionId: 'sess-err',
      prompt: [{ type: 'text', text: 'still alive?' }],
    });
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta === 'echo: still alive?'),
    );

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-err', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('start with an unavailable adapter reports spawn failure', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: 'definitely-not-a-command-12345', PATH: '/nonexistent' },
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-2',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toBeTruthy();
  }, 15000);
});

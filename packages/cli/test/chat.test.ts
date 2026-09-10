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

  it('speaks the dsh native dialect too (content object, flat tool_call, used/size)', () => {
    // dsh's ACP adapter: chunks carry `content` (not `contentBlock`)…
    expect(
      map({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: '收到' },
      }),
    ).toEqual({ kind: 'message_delta', delta: '收到' });
    expect(
      map({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'hm' },
      }),
    ).toEqual({ kind: 'thought_delta', delta: 'hm' });
    // …tool calls spread the fields FLAT on the update (no toolCallUpdate)…
    expect(
      map({
        sessionUpdate: 'tool_call',
        toolCallId: 'dsh-1',
        title: 'bash(npm test)',
        kind: 'other',
        status: 'in_progress',
        rawInput: { command: 'npm test' },
      }),
    ).toEqual({
      kind: 'tool_call',
      call: {
        toolCallId: 'dsh-1',
        title: 'bash(npm test)',
        kind: 'other',
        status: 'in_progress',
        rawInput: { command: 'npm test' },
      },
    });
    expect(
      map({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'dsh-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      }),
    ).toEqual({
      kind: 'tool_call',
      call: {
        toolCallId: 'dsh-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      },
    });
    // …and usage reports context occupancy (`used` of `size`).
    expect(map({ sessionUpdate: 'usage_update', used: 8469, size: 262144 })).toEqual({
      kind: 'usage',
      contextUsed: 8469,
      contextSize: 262144,
    });
  });
});

describe('toolCallView enrichment (9 W6)', () => {
  const map = (update: Record<string, unknown>): ChatStreamEvent | null => mapAcpUpdate({ update });

  it('carries toolName from the Claude _meta envelope', () => {
    const ev = mapAcpUpdate({
      update: {
        sessionUpdate: 'tool_call',
        toolCallUpdate: { toolCallId: 't1', title: 'src/app.ts', status: 'in_progress' },
      },
      _meta: { claudeCode: { toolName: 'Edit' } },
    });
    expect(ev).toEqual({
      kind: 'tool_call',
      call: {
        toolCallId: 't1',
        title: 'src/app.ts',
        toolName: 'Edit',
        status: 'in_progress',
      },
    });
  });

  it('normalizes readTool-style kinds and filters unknown statuses', () => {
    const ev = map({
      sessionUpdate: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 't2',
        kind: 'executeTool',
        status: 'weird-status',
        rawOutput: 'done',
      },
    });
    expect(ev).toEqual({
      kind: 'tool_call',
      call: { toolCallId: 't2', kind: 'execute', output: 'done' },
    });
  });

  it('passes structured diff content through', () => {
    const ev = map({
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 't3',
        content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }],
      },
    });
    expect(ev).toMatchObject({
      kind: 'tool_call',
      call: {
        toolCallId: 't3',
        content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }],
      },
    });
  });

  it('drops oversized rawInput (Write-style payloads) but keeps the rest', () => {
    const ev = map({
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 't4',
        toolName: 'Write',
        rawInput: { content: 'x'.repeat(40 * 1024) },
      },
    });
    expect(ev).toEqual({ kind: 'tool_call', call: { toolCallId: 't4', toolName: 'Write' } });
  });

  it('keeps bounded rawInput and truncates oversized output', () => {
    const ok = map({
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 't5',
        rawInput: { file_path: '/tmp/a.ts' },
        rawOutput: 'y'.repeat(100010),
      },
    });
    expect(ok).toMatchObject({
      kind: 'tool_call',
      call: {
        toolCallId: 't5',
        rawInput: { file_path: '/tmp/a.ts' },
        output: 'y'.repeat(100000),
      },
    });
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

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

describe('native sessions (9 W7): resume, history, resync', () => {
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

  it('resume via session/load captures the replay as chat:history, then ready carries the native id', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-r1',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
      resume: { sessionId: 'fx-native-1', cwd: '/tmp' },
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.nativeSessionId).toBe('fx-native-1');

    // History shipped BEFORE ready: the replayed user turn, the message, the
    // completed Read tool, and a synthetic turn_result so the fold settles.
    const history = socket.eventsOf('chat:history')[0]!.payload as {
      sessionId: string;
      items: { type: string; blocks?: unknown[]; event?: ChatStreamEvent }[];
    };
    expect(history.sessionId).toBe('sess-r1');
    const kinds = history.items.map((i) =>
      i.type === 'user' ? 'user' : (i.event!.kind as string),
    );
    expect(kinds).toEqual(['user', 'message_delta', 'tool_call', 'turn_result']);
    expect(history.items[0]!.blocks).toEqual([{ type: 'text', text: 'what did we conclude?' }]);
    const tool = history.items.find((i) => i.type === 'event' && i.event!.kind === 'tool_call')!
      .event as { call: { toolName?: string; status?: string; output?: string } };
    expect(tool.call.toolName).toBe('Read');
    expect(tool.call.status).toBe('completed');
    expect(tool.call.output).toBe('42');

    // A live turn on the resumed channel appends to the SAME ring.
    socket.receive('chat:message.send', {
      sessionId: 'sess-r1',
      prompt: [{ type: 'text', text: 'continue' }],
    });
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'message_delta' && e.delta === 'echo: continue'),
    );

    // Resync (page refresh): the ring replays — replay history + live turn.
    const resyncAck = vi.fn();
    socket.receive('chat:session.resync', { sessionId: 'sess-r1' }, resyncAck);
    expect(resyncAck).toHaveBeenCalledWith({ accepted: true });
    const batches = socket.eventsOf('chat:history') as unknown as {
      payload: { items: { type: string; blocks?: unknown[] }[] };
    }[];
    const last = batches[batches.length - 1]!.payload;
    const userTexts = last.items
      .filter((i) => i.type === 'user')
      .map((i) => (i.blocks![0] as { text: string }).text);
    expect(userTexts).toEqual(['what did we conclude?', 'continue']);

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-r1', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('resume-only adapters (the dsh shape) resume without replay and report the native id', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_ACP_NO_LOAD: '1' },
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-r2',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
      resume: { sessionId: 'fx-native-only', cwd: '/tmp' },
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.nativeSessionId).toBe('fx-native-only');
    // No transcript parser for hermes → no history batch.
    expect(socket.eventsOf('chat:history')).toHaveLength(0);

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-r2', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('liveNativeIds exposes the agent session ids for the dsh list exclusion', async () => {
    const socket = new FakeSocket();
    const registry = attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
    });
    expect(registry.liveNativeIds().size).toBe(0);

    socket.receive('chat:session.start', {
      sessionId: 'sess-r3',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(registry.liveNativeIds().size).toBe(1);

    socket.receive('chat:session.close', { sessionId: 'sess-r3', reason: 'user' });
    await waitFor(() => registry.liveNativeIds().size === 0);
  }, 15000);
});

describe('resume failure hygiene (9 W7 leak regression)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
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
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('a failed establishment surfaces the error AND kills the adapter process', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hnx-fx-pid-')), 'pids');
    writeFileSync(pidFile, '', 'utf8');

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_PID_FILE: pidFile },
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-fail',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
      resume: { sessionId: 'fx-native-fail', cwd: '/tmp' },
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toContain('no configured model');

    // The adapter process must be GONE (this was the leak: every failed
    // resume left a live dsh/npx adapter parented to the daemon forever).
    await waitFor(() => {
      const pids = readFileSync(pidFile, 'utf8')
        .split('\n')
        .map((l) => Number.parseInt(l, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      return pids.length > 0 && pids.every((p) => !alive(p)) ? true : undefined;
    });
  }, 15000);
});

// Node's zstd binding (needed to write real frames for the tail); absent on
// Node < 22.15 — those tests self-skip.
const maybeZstd = (await import('node:zlib')) as unknown as {
  zstdCompressSync?: (b: Buffer) => Buffer;
};

describe('dsh live streaming via transcript tail (9 W7)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
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

  it('streams token batches from the transcript while the turn runs, suppressing committed chunks', async () => {
    const zstd = maybeZstd.zstdCompressSync;
    if (zstd === undefined) return it.skip('needs Node >= 22.15 zstd') as never;

    const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-tail-'));
    const sid = 'fx-tail-1';
    const dir = join(home, '.dsh', 'sessions', '--tail--', sid);
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'session.jsonl.zstd');
    const frame = (entries: unknown[]): Buffer =>
      Buffer.concat(entries.map((e) => zstd(Buffer.from(`${JSON.stringify(e)}\n`))));
    writeFileSync(
      transcript,
      frame([{ type: 'session', cwd: '/tmp', createdAt: 1, delegationDepth: 0 }]),
    );

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_SESSION_ID: sid, FIXTURE_DELAY_PROMPT_MS: '1200' },
      homeDir: home,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-tail',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.nativeSessionId).toBe(sid);

    // The turn is in flight (the fixture waits FIXTURE_DELAY_PROMPT_MS) —
    // "dsh" appends token batches to the transcript DURING generation.
    setTimeout(() => {
      appendFileSync(
        transcript,
        frame([
          {
            type: 'text-chunks',
            seq0: 1,
            time0: 1,
            data: { turn: 1, step: 0, index: 0, dt: [1], texts: ['你好', '，'] },
          },
        ]),
      );
    }, 250);
    setTimeout(() => {
      appendFileSync(
        transcript,
        frame([
          {
            type: 'text-chunks',
            seq0: 3,
            time0: 2,
            data: { turn: 1, step: 0, index: 0, dt: [], texts: ['世界'] },
          },
          { type: 'turn/end', seq: 4, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        ]),
      );
    }, 600);

    socket.receive('chat:message.send', {
      sessionId: 'sess-tail',
      prompt: [{ type: 'text', text: 'say hi slowly' }],
    });
    const turnDone = await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    expect(turnDone).toBeDefined();

    // The streamed deltas arrived BEFORE the turn settled — and the fixture's
    // own committed `agent_message_chunk` echo ('echo: say hi slowly') was
    // SUPPRESSED (the tail already streamed this turn's text).
    const deltas = socket
      .chatEvents()
      .filter((e): e is { kind: 'message_delta'; delta: string } => e.kind === 'message_delta')
      .map((e) => e.delta);
    expect(deltas).toContain('你好，');
    expect(deltas).toContain('世界');
    expect(deltas.join('')).not.toContain('echo: say hi slowly');
    const turnIdx = socket.chatEvents().findIndex((e) => e.kind === 'turn_result');
    const lastDeltaIdx = socket
      .chatEvents()
      .findLastIndex((e) => e.kind === 'message_delta' && e.delta === '世界');
    expect(lastDeltaIdx).toBeLessThan(turnIdx);

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-tail', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('without a transcript (no tail) the committed chunks stream as before', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-notail-'));

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_SESSION_ID: 'fx-notail-1' },
      homeDir: home,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-nt',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    socket.receive('chat:message.send', {
      sessionId: 'sess-nt',
      prompt: [{ type: 'text', text: 'hi' }],
    });
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'message_delta' && e.delta === 'echo: hi'),
    );
    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-nt', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('a lazily-materialized transcript replays from byte 0 — pre-attach deltas are not lost', async () => {
    const zstd = maybeZstd.zstdCompressSync;
    if (zstd === undefined) return it.skip('needs Node >= 22.15 zstd') as never;

    const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-lazy-'));
    const sid = 'fx-lazy-1';
    const dir = join(home, '.dsh', 'sessions', '--lazy--', sid);
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'session.jsonl.zstd');
    const frame = (entries: unknown[]): Buffer =>
      Buffer.concat(entries.map((e) => zstd(Buffer.from(`${JSON.stringify(e)}\n`))));

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_SESSION_ID: sid, FIXTURE_DELAY_PROMPT_MS: '2500' },
      homeDir: home,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-lazy',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();

    // The prompt goes out while the transcript does NOT exist yet (dsh
    // materializes it lazily); the file then appears already holding the
    // turn's FIRST batch — written before any attach could see it.
    socket.receive('chat:message.send', {
      sessionId: 'sess-lazy',
      prompt: [{ type: 'text', text: 'lazy file' }],
    });
    setTimeout(() => {
      writeFileSync(
        transcript,
        frame([
          { type: 'session', cwd: '/tmp', createdAt: 1, delegationDepth: 0 },
          {
            type: 'text-chunks',
            seq0: 1,
            time0: 1,
            data: { turn: 1, step: 0, index: 0, dt: [1], texts: ['早到的批次'] },
          },
        ]),
      );
    }, 120);
    setTimeout(() => {
      appendFileSync(
        transcript,
        frame([
          {
            type: 'text-chunks',
            seq0: 3,
            time0: 2,
            data: { turn: 1, step: 0, index: 0, dt: [], texts: ['后到的批次'] },
          },
          { type: 'turn/end', seq: 4, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        ]),
      );
    }, 900);

    await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    const deltas = socket
      .chatEvents()
      .filter((e): e is { kind: 'message_delta'; delta: string } => e.kind === 'message_delta')
      .map((e) => e.delta);
    // BOTH batches streamed — the pre-attach one via the byte-0 replay — and
    // the wire's committed echo never doubled anything.
    expect(deltas).toContain('早到的批次');
    expect(deltas).toContain('后到的批次');
    expect(deltas.join('')).not.toContain('echo: lazy file');

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-lazy', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);
});

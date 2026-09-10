import { describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import {
  createDshLiveMapper,
  dshHistoryItems,
  dshListSessions,
  decodeTranscript,
  findTranscript,
  nativeZstd,
  scanSummary,
  splitZstdFrames,
  TranscriptTail,
} from '../src/daemon/dsh-sessions.js';

/**
 * dsh native session store tests (Phase 9 W7). The frame decoder is injected
 * everywhere so the logic runs on any Node; a real zstd round-trip is
 * additionally exercised when the running Node has the binding (≥ 22.15).
 */

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Build a concatenated "zstd" buffer whose frames are magic-prefixed JSONL. */
function fakeTranscript(entries: unknown[]): Buffer {
  return Buffer.concat(
    entries.map((e) => Buffer.concat([MAGIC, Buffer.from(`${JSON.stringify(e)}\n`)])),
  );
}

/** Test decoder: strips the 4-byte magic, returns the JSONL text. */
const stripMagic = (frame: Buffer): Buffer => frame.subarray(4);

describe('splitZstdFrames', () => {
  it('slices frames at every magic occurrence (a fresh session dir = 1 frame)', () => {
    const buf = Buffer.concat([
      MAGIC,
      Buffer.from('aaaa'),
      MAGIC,
      Buffer.from('bb'),
      MAGIC,
      Buffer.from('c'),
    ]);
    expect(splitZstdFrames(buf)).toHaveLength(3);
    expect(splitZstdFrames(buf)[1]!.subarray(4).toString()).toBe('bb');
    expect(splitZstdFrames(MAGIC)).toHaveLength(1);
    expect(splitZstdFrames(Buffer.alloc(0))).toHaveLength(0);
  });
});

describe('decodeTranscript', () => {
  it('parses every frame, skipping noise lines and undecodable frames', () => {
    const buf = Buffer.concat([
      fakeTranscript([{ type: 'session' }, { type: 'turn/start' }]),
      MAGIC, // a frame the decoder rejects (simulated below via a stub)
      Buffer.from('x'),
    ]);
    const boom = (frame: Buffer): Buffer => {
      if (frame.length <= 4) throw new Error('corrupt frame');
      return frame.subarray(4);
    };
    const entries = decodeTranscript(buf, boom);
    expect(entries.map((e) => e['type'])).toEqual(['session', 'turn/start']);
  });

  it('caps entries so a runaway transcript cannot exhaust memory', () => {
    const buf = fakeTranscript(Array.from({ length: 30 }, (_, i) => ({ seq: i })));
    expect(decodeTranscript(buf, stripMagic, 10)).toHaveLength(10);
  });
});

describe('scanSummary', () => {
  it('reads the header (cwd/createdAt/depth) and the derived title', () => {
    const buf = fakeTranscript([
      {
        type: 'session',
        id: 's1',
        cwd: '/root/projects/demo',
        createdAt: 1789008798907,
        delegationDepth: 0,
      },
      { type: 'session/title', data: { title: 'hi' } },
      { type: 'turn/start', data: {} },
    ]);
    const { header, title } = scanSummary(buf, stripMagic);
    expect(header).toMatchObject({
      id: 's1',
      cwd: '/root/projects/demo',
      createdAt: 1789008798907,
      delegationDepth: 0,
    });
    expect(title).toBe('hi');
  });
});

describe('dshListSessions', () => {
  const root = '~/.dsh/sessions';

  /** Fake store shaped like the disk: root → slug → session id → transcript. */
  function fsFor(
    store: Record<string, Record<string, Record<string, Buffer>>>,
    mtimeMs = 1_789_000_000_000,
  ) {
    const readdir = (p: string): string[] => {
      if (p === root) return Object.keys(store[root] ?? {});
      if (p.startsWith(`${root}/`))
        return Object.keys(store[root]?.[p.slice(root.length + 1)] ?? {});
      throw new Error('ENOENT');
    };
    return {
      readdir,
      readFile: (p: string) => {
        // p = <root>/<slug>/<id>/session.jsonl.zstd
        const rest = p.slice(root.length + 1).split('/');
        const buf = store[root]?.[rest[0]]?.[rest[1]];
        if (buf === undefined) throw new Error('ENOENT');
        return buf;
      },
      stat: () => ({ mtimeMs }),
    };
  }

  it('lists ROOT sessions newest-first, skipping subagents and live ids', () => {
    // NB: the header entry carries its fields at the TOP level (no `data`).
    const transcript = (header: Record<string, unknown>, extra: unknown[] = []): Buffer =>
      fakeTranscript([{ type: 'session', ...header }, ...extra]);
    const store = {
      [root]: {
        '--root-demo--': {
          'aaa-1': transcript({ cwd: '/root/demo', createdAt: 100, delegationDepth: 0 }, [
            { type: 'session/title', data: { title: 'first' } },
          ]),
          'bbb-2': transcript({ cwd: '/root/demo', createdAt: 200, delegationDepth: 0 }),
          'ccc-sub': transcript({ cwd: '/root/demo', createdAt: 300, delegationDepth: 1 }),
          'ddd-parent': transcript({
            cwd: '/root/demo',
            createdAt: 400,
            delegationDepth: 0,
            parentSession: 'aaa-1',
          }),
          'eee-broken': fakeTranscript([{ type: 'turn/start', data: {} }]),
        },
      },
    };
    const fs = fsFor(store);
    const out = dshListSessions(root, fs, stripMagic);
    expect(out.map((s) => s.sessionId)).toEqual(['bbb-2', 'aaa-1']);
    expect(out[0]).toMatchObject({ sessionId: 'bbb-2', cwd: '/root/demo', title: null });
    expect(out[1]).toMatchObject({ title: 'first', createdAt: new Date(100).toISOString() });
    // Post-W8: sessions with a live channel stay LISTED (the server marks them
    // `open`; the rail offers a rejoin) — no exclusion flag exists anymore.
  });

  it('returns an honest empty list when the store does not exist', () => {
    expect(
      dshListSessions(
        root,
        {
          readdir: () => {
            throw new Error('ENOENT');
          },
          readFile: () => {
            throw new Error('ENOENT');
          },
          stat: () => ({ mtimeMs: 0 }),
        },
        stripMagic,
      ),
    ).toEqual([]);
  });
});

describe('dshHistoryItems', () => {
  it('maps a two-turn transcript: real user inputs, complete blocks, tool pair, turn ends', () => {
    const entries = [
      { type: 'session', cwd: '/root/demo', createdAt: 1, delegationDepth: 0 },
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      {
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [
            {
              content: [{ type: 'text', text: 'hi' }],
              source: { kind: 'user' },
              role: 'user',
              id: 'u-1',
            },
          ],
        },
      },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], id: 'u-1' } },
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'Current runtime context…' }] },
      },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'just a greeting' },
              { type: 'text', text: 'Hi there!' },
            ],
          },
        },
      },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      {
        type: 'agent/inbox/spliced',
        data: {
          inserted: [
            {
              content: [{ type: 'text', text: 'list files' }],
              source: { kind: 'user' },
              role: 'user',
              id: 'u-2',
            },
          ],
        },
      },
      { type: 'turn/start', data: { turn: 2 } },
      {
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 1,
          message: {
            content: [
              { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
            ],
          },
        },
      },
      {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      },
      {
        type: 'tool/result',
        data: {
          message: {
            source: { kind: 'tool', callId: 'call-1' },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1',
                content: [{ type: 'text', text: 'a.txt\nb.txt' }],
              },
            ],
          },
        },
      },
      {
        type: 'assistant/chunk',
        data: {
          turn: 2,
          step: 1,
          chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 4 } },
        },
      },
      {
        type: 'assistant/message',
        data: { turn: 2, step: 2, message: { content: [{ type: 'text', text: 'Two files.' }] } },
      },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ];

    const items = dshHistoryItems(entries);
    const shape = items.map((i) => (i.type === 'user' ? 'user' : i.event.kind));
    expect(shape).toEqual([
      'user', // hi
      'thought_delta',
      'message_delta',
      'turn_result',
      'user', // list files
      'tool_call', // from the assistant/message tool-call block
      'tool_call', // from tool/call (same callId — the fold merges)
      'tool_call', // completed + output from tool/result
      'usage',
      'message_delta',
      'turn_result',
    ]);

    expect(items[0]).toEqual({ type: 'user', blocks: [{ type: 'text', text: 'hi' }] });
    const toolEvents = items.filter((i) => i.type === 'event' && i.event.kind === 'tool_call') as {
      event: {
        call: {
          toolCallId: string;
          status?: string;
          output?: string;
          rawInput?: Record<string, unknown>;
          toolName?: string;
        };
      };
    }[];
    const completed = toolEvents.find((e) => e.event.call.status === 'completed')!;
    expect(completed.event.call).toMatchObject({
      toolCallId: 'call-1',
      output: 'a.txt\nb.txt',
    });
    const started = toolEvents.find((e) => e.event.call.rawInput !== undefined)!;
    expect(started.event.call.rawInput).toEqual({ command: 'ls' });
    expect(started.event.call.toolName).toBe('bash');
    expect(
      items.filter(
        (i) =>
          i.type === 'event' &&
          i.event.kind === 'message_delta' &&
          i.event.delta.includes('runtime context'),
      ),
    ).toHaveLength(0); // synthesized context noise never leaks into history
  });

  it('maps a cancelled turn end', () => {
    const items = dshHistoryItems([{ type: 'turn/end', data: { reason: { kind: 'cancelled' } } }]);
    expect(items[0]).toEqual({
      type: 'event',
      event: { kind: 'turn_result', stopReason: 'cancelled' },
    });
  });
});

describe('real zstd round-trip (Node >= 22.15 only)', () => {
  const zstd = nativeZstd();
  const compress = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer })
    .zstdCompressSync;
  const maybe = zstd !== null && compress !== undefined ? it : it.skip;

  maybe('decodes a dsh-shaped multi-frame file through the native binding', () => {
    const entries = [
      { type: 'session', cwd: '/root/demo', createdAt: 1, delegationDepth: 0 },
      { type: 'session/title', data: { title: 'hello' } },
      {
        type: 'agent/inbox/spliced',
        data: {
          inserted: [
            {
              content: [{ type: 'text', text: 'ping' }],
              source: { kind: 'user' },
              role: 'user',
              id: 'u1',
            },
          ],
        },
      },
    ];
    const buf = Buffer.concat(entries.map((e) => compress(Buffer.from(`${JSON.stringify(e)}\n`))));
    const decoded = decodeTranscript(buf, zstd!);
    expect(decoded.map((e) => e['type'])).toEqual([
      'session',
      'session/title',
      'agent/inbox/spliced',
    ]);
    expect(scanSummary(buf, zstd!).title).toBe('hello');
  });
});

describe('createDshLiveMapper (reference semantics: dsh 0.1.2-rc.1 chunk-rows)', () => {
  const run = (...entries: unknown[]): { kind: string; delta?: string }[] => {
    const mapper = createDshLiveMapper();
    const events: { kind: string; delta?: string }[] = [];
    for (const entry of entries) {
      for (const e of mapper(entry as Record<string, unknown>)) {
        events.push(e as { kind: string; delta?: string });
      }
    }
    return events;
  };

  it('maps packed rows AND verbatim chunk events (MIN_RUN=3 fall-through)', () => {
    // A packed run…
    expect(
      run({
        type: 'text-chunks',
        seq0: 1,
        time0: 1,
        data: { turn: 1, step: 0, index: 0, dt: [1], texts: ['你好', '，'] },
      }),
    ).toEqual([{ kind: 'message_delta', delta: '你好，' }]);
    expect(
      run({
        type: 'reasoning-chunks',
        seq0: 3,
        time0: 2,
        data: { turn: 1, step: 0, index: 1, dt: [], texts: ['think'] },
      }),
    ).toEqual([{ kind: 'thought_delta', delta: 'think' }]);
    // …and the 1–2 member runs the codec stores verbatim.
    expect(
      run({
        type: 'assistant/chunk',
        seq: 5,
        time: 9,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'tail' } },
      }),
    ).toEqual([{ kind: 'message_delta', delta: 'tail' }]);
    expect(
      run({
        type: 'assistant/chunk',
        seq: 6,
        time: 10,
        data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 1, text: 'hmm' } },
      }),
    ).toEqual([{ kind: 'thought_delta', delta: 'hmm' }]);
  });

  it('committed message: usage only for streamed steps, full blocks otherwise', () => {
    const commit = (turn: number, step: number, text: string): unknown => ({
      type: 'assistant/message',
      seq: 9,
      time: 20,
      data: {
        turn,
        step,
        message: {
          content: [
            { type: 'reasoning', text: 'R' },
            { type: 'text', text },
          ],
        },
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    });
    const delta = (turn: number, step: number, text: string): unknown => ({
      type: 'text-chunks',
      seq0: 1,
      time0: 1,
      data: { turn, step, index: 0, dt: [], texts: [text] },
    });
    // Step WITH streamed deltas → no text re-send, usage rides through.
    expect(run(delta(1, 0, 'streamed '), commit(1, 0, 'streamed full'))).toEqual([
      { kind: 'message_delta', delta: 'streamed ' },
      { kind: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
    // Step the tail NEVER saw deltas for (late attach) → complete blocks.
    expect(run(commit(1, 1, 'never streamed'))).toEqual([
      { kind: 'thought_delta', delta: 'R' },
      { kind: 'message_delta', delta: 'never streamed' },
      { kind: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
    // A verbatim delta marks the step just like a packed row.
    expect(
      run(
        {
          type: 'assistant/chunk',
          seq: 2,
          time: 2,
          data: { turn: 2, step: 0, chunk: { type: 'text-delta', index: 0, text: 'v' } },
        },
        commit(2, 0, 'v full'),
      ),
    ).toEqual([
      { kind: 'message_delta', delta: 'v' },
      { kind: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
  });

  it('ignores non-text chunk variants, tool-call-chunks rows, and turn/user rows', () => {
    expect(
      run(
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 0, chunk: { type: 'usage', usage: { inputTokens: 1 } } },
        },
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
        },
        {
          type: 'assistant/chunk',
          data: { turn: 1, step: 0, chunk: { type: 'finish', reason: 'stop' } },
        },
        {
          type: 'tool-call-chunks',
          seq0: 1,
          time0: 1,
          data: { turn: 1, step: 0, index: 2, id: 'c1', dt: [], args: ['{"a":'] },
        },
        { type: 'turn/start', data: { turn: 2 } },
        {
          type: 'user/message',
          data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
        },
      ),
    ).toEqual([]);
    // Tools still map from their committed rows.
    expect(
      run({
        type: 'tool/call',
        data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
      }),
    ).toEqual([
      {
        kind: 'tool_call',
        call: {
          toolCallId: 'c1',
          toolName: 'bash',
          status: 'in_progress',
          rawInput: { command: 'ls' },
        },
      },
    ]);
  });
});

describe('TranscriptTail (dsh live streaming)', () => {
  /**
   * A decoder that behaves like real zstd for the cases the tail leans on: a
   * TRUNCATED frame throws (real frames carry a trailing checksum), a
   * complete frame round-trips its JSONL.
   */
  const checkedDecoder = (frame: Buffer): Buffer => {
    const body = frame.subarray(4);
    if (!body.toString('utf8').endsWith('\n')) throw new Error('torn frame');
    return body;
  };

  it('streams token batches as they are appended, recovering partial frames', async () => {
    const events: { kind: string; delta?: string }[] = [];
    // An appendable in-memory file the tail reads through the TailFs seam.
    let file = fakeTranscript([
      { type: 'session', cwd: '/root/demo', createdAt: 1, delegationDepth: 0 },
    ]);
    const fs = {
      size: () => file.length,
      readEnd: (_p: string, start: number) => file.subarray(start),
    };
    const tail = new TranscriptTail(
      '/x/session.jsonl.zstd',
      fs,
      checkedDecoder,
      (e) => events.push(e as { kind: string; delta?: string }),
      { intervalMs: 5 },
    );
    tail.start(); // skips existing bytes (the header)
    await new Promise((r) => setTimeout(r, 20));

    // A batch arrives mid-generation…
    file = Buffer.concat([
      file,
      fakeTranscript([
        {
          type: 'reasoning-chunks',
          seq0: 1,
          time0: 1,
          data: { turn: 1, step: 0, index: 1, dt: [1], texts: ['The ', 'user'] },
        },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    // …a frame cut MID-WRITE (its tail bytes missing)…
    const whole = fakeTranscript([
      {
        type: 'text-chunks',
        seq0: 3,
        time0: 2,
        data: { turn: 1, step: 0, index: 0, dt: [], texts: ['1\n2\n'] },
      },
    ]);
    file = Buffer.concat([file, whole.subarray(0, whole.length - 4)]);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([{ kind: 'thought_delta', delta: 'The user' }]); // partial held back
    // …the rest of the frame lands.
    file = Buffer.concat([file, whole.subarray(whole.length - 4)]);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([
      { kind: 'thought_delta', delta: 'The user' },
      { kind: 'message_delta', delta: '1\n2\n' },
    ]);

    // Tools + the commit's usage stream; the streamed step's commit does NOT
    // re-send its text; the unstreamed step's commit DOES (fallback).
    file = Buffer.concat([
      file,
      fakeTranscript([
        { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
        {
          type: 'tool/result',
          data: {
            message: {
              source: { kind: 'tool', callId: 'c1' },
              content: [
                { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }] },
              ],
            },
          },
        },
        {
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 0,
            message: { content: [{ type: 'text', text: 'committed full text' }] },
            usage: { inputTokens: 5, outputTokens: 2 },
          },
        },
        {
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 1,
            message: { content: [{ type: 'text', text: 'never streamed block' }] },
          },
        },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'thought_delta',
      'message_delta',
      'tool_call',
      'tool_call',
      'usage', // step 0: streamed → usage only
      'message_delta', // step 1: unstreamed → complete block
    ]);
    expect(events.at(-1)).toEqual({ kind: 'message_delta', delta: 'never streamed block' });

    // flush() drains synchronously; a turn/end row arms the settle signal;
    // stop() freezes the stream.
    tail.flush();
    const beforeSettle = Date.now();
    expect(tail.turnEndSeenSince(Date.now())).toBe(false);
    file = Buffer.concat([
      file,
      fakeTranscript([
        { type: 'turn/end', seq: 8, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(tail.turnEndSeenSince(beforeSettle)).toBe(true);
    tail.stop();
    const before = events.length;
    file = Buffer.concat([
      file,
      fakeTranscript([
        {
          type: 'text-chunks',
          seq0: 9,
          time0: 9,
          data: { turn: 2, step: 0, index: 0, dt: [], texts: ['post-stop'] },
        },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.length).toBe(before);
  }, 10000);

  it('stops and reports fatal on a bounded frame that will not decode', async () => {
    const events: { kind: string }[] = [];
    const fatal: string[] = [];
    let file = fakeTranscript([{ type: 'session', cwd: '/x', createdAt: 1, delegationDepth: 0 }]);
    const tail = new TranscriptTail(
      '/x/session.jsonl.zstd',
      { size: () => file.length, readEnd: (_p: string, start: number) => file.subarray(start) },
      checkedDecoder,
      (e) => events.push(e as { kind: string }),
      { intervalMs: 5, onFatal: (reason) => fatal.push(reason) },
    );
    tail.start(); // skips the header
    // A bounded undecodable frame (corruption — NOT a torn trailing write:
    // more bytes follow it), then a good frame after it.
    file = Buffer.concat([
      file,
      MAGIC,
      Buffer.from('garbage-not-zstd'),
      fakeTranscript([
        {
          type: 'text-chunks',
          seq0: 1,
          time0: 1,
          data: { turn: 1, step: 0, index: 0, dt: [], texts: ['after'] },
        },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 30));
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain('corrupt');
    expect(events).toEqual([]); // nothing after the corruption is trusted
  }, 10000);
});

describe('findTranscript', () => {
  it('locates the session dir across slugs', () => {
    const sessions = '/root/.dsh/sessions';
    const dirs = new Set([
      sessions, // the sessions root itself
      `${sessions}/--a--`,
      `${sessions}/--b--`,
      `${sessions}/--a--/id-1`, // the session dir itself must exist
    ]);
    const readdir = (p: string): string[] => {
      if (!dirs.has(p)) throw new Error('ENOENT');
      return p === sessions ? ['--a--', '--b--'] : ['whatever'];
    };
    expect(findTranscript(sessions, 'id-1', readdir)).toBe(
      `${sessions}/--a--/id-1/session.jsonl.zstd`,
    );
    expect(
      findTranscript(sessions, 'nope', () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });
});

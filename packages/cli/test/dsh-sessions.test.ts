import { describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import {
  dshHistoryItems,
  dshListSessions,
  decodeTranscript,
  nativeZstd,
  scanSummary,
  splitZstdFrames,
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

    const withoutLive = dshListSessions(root, fs, stripMagic, { liveIds: new Set(['bbb-2']) });
    expect(withoutLive.map((s) => s.sessionId)).toEqual(['aaa-1']);
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

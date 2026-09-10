import * as zlib from 'node:zlib';
import type { HistoryItem } from '@harness-nexus/shared';

/**
 * dsh native session store reader (Phase 9 W7).
 * docs/design/phase-9-w7-native-sessions.md § ground truth.
 *
 * dsh persists every session at `~/.dsh/sessions/<cwd-slug>/<uuid>/
 * session.jsonl.zstd` as MULTI-FRAME zstd — one frame per write batch. Node's
 * one-shot AND stream zstd decoders stop after the first frame, so the reader
 * scans the frame magic (`28 B5 2F FD`), slices, and decodes each frame
 * separately. Everything here is pure/bounded and injectable for tests; the
 * zstd binding is feature-detected (needs Node ≥ 22.15 — machines running dsh
 * already require it, but the daemon degrades gracefully below it).
 */

/** zstd frame magic, big-endian as stored. */
const ZSTD_MAGIC = 0x28_b5_2f_fd;

export type FrameDecoder = (frame: Buffer) => Buffer;

/** The native `zlib.zstdDecompressSync`, or null on Node < 22.15. */
export function nativeZstd(): FrameDecoder | null {
  const fn = (zlib as unknown as { zstdDecompressSync?: FrameDecoder }).zstdDecompressSync;
  return typeof fn === 'function' ? fn : null;
}

/** Slice a concatenated-zstd buffer into its frames (magic scan). */
export function splitZstdFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let start = -1;
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32BE(i) === ZSTD_MAGIC) {
      if (start !== -1) frames.push(buf.subarray(start, i));
      start = i;
      i += 3;
    }
  }
  if (start !== -1) frames.push(buf.subarray(start));
  return frames;
}

/**
 * Decode every frame and parse the JSONL entries. Undecodable frames (a magic
 * hit inside compressed data — ~2^-32 per position) and non-JSON lines are
 * skipped, never fatal. Entries are capped so a runaway transcript can't
 * exhaust memory.
 */
export function decodeTranscript(
  buf: Buffer,
  decompress: FrameDecoder,
  maxEntries = 20000,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  for (const frame of splitZstdFrames(buf)) {
    let text: string;
    try {
      text = decompress(frame).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entries.push(parsed as Record<string, unknown>);
          if (entries.length >= maxEntries) return entries;
        }
      } catch {
        // non-JSON noise — skip
      }
    }
  }
  return entries;
}

// ---- listing ----

export interface DshSessionSummary {
  sessionId: string;
  cwd: string;
  title: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface DshHeader {
  createdAt?: unknown;
  cwd?: unknown;
  delegationDepth?: unknown;
  parentSession?: unknown;
}

/**
 * Header + derived title from the FRONT of a transcript (dsh's own
 * `session/list` exposes neither). Stops as soon as both are found; bounded
 * read so a huge transcript costs at most `maxBytes`. NB: the `session`
 * HEADER entry carries its fields at the TOP level (no `data` wrapper),
 * unlike every other entry type.
 */
export function scanSummary(
  buf: Buffer,
  decompress: FrameDecoder,
  maxBytes = 64 * 1024,
): { header: DshHeader | null; title: string | null } {
  const bounded = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  let header: DshHeader | null = null;
  let title: string | null = null;
  for (const frame of splitZstdFrames(bounded)) {
    let text: string;
    try {
      text = decompress(frame).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const e = JSON.parse(line) as Record<string, unknown>;
        if (e['type'] === 'session' && header === null) {
          header = e as DshHeader; // top-level shape — see the doc comment
        } else if (e['type'] === 'session/title') {
          const t = (e['data'] as Record<string, unknown> | undefined)?.['title'];
          if (typeof t === 'string' && t !== '') title = t;
        }
      } catch {
        // skip
      }
    }
    if (header !== null && title !== null) break;
  }
  return { header, title };
}

export interface DshListFs {
  readdir: (path: string) => string[];
  readFile: (path: string) => Buffer;
  stat: (path: string) => { mtimeMs: number };
}

/**
 * List dsh's ROOT sessions (subagent sessions carry `parentSession`/depth and
 * are dsh's own resume-exclusions). Pure given the fs shims; newest first.
 */
export function dshListSessions(
  sessionsDir: string,
  fs: DshListFs,
  decompress: FrameDecoder,
  opts: { liveIds?: ReadonlySet<string>; maxSessions?: number } = {},
): DshSessionSummary[] {
  const max = opts.maxSessions ?? 100;
  const out: DshSessionSummary[] = [];
  let slugs: string[];
  try {
    slugs = fs.readdir(sessionsDir);
  } catch {
    return []; // no store yet — an honest empty listing
  }
  for (const slug of slugs) {
    let ids: string[];
    try {
      ids = fs.readdir(`${sessionsDir}/${slug}`);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (out.length >= max) break;
      if (opts.liveIds?.has(id)) continue; // dsh refuses resuming active sessions
      const file = `${sessionsDir}/${slug}/${id}/session.jsonl.zstd`;
      let buf: Buffer;
      try {
        buf = fs.readFile(file);
      } catch {
        continue;
      }
      const { header, title } = scanSummary(buf, decompress);
      if (header === null) continue;
      if (typeof header.cwd !== 'string' || header.cwd === '' || !header.cwd.startsWith('/')) {
        continue;
      }
      if (header.parentSession !== undefined || header.delegationDepth !== 0) continue;
      let mtimeMs: number;
      try {
        mtimeMs = fs.stat(file).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      out.push({
        sessionId: id,
        cwd: header.cwd,
        title,
        createdAt:
          typeof header.createdAt === 'number' && Number.isFinite(header.createdAt)
            ? new Date(header.createdAt).toISOString()
            : null,
        updatedAt: mtimeMs > 0 ? new Date(mtimeMs).toISOString() : null,
      });
    }
  }
  const stamp = (s: DshSessionSummary): number =>
    Date.parse(s.updatedAt ?? '') || Date.parse(s.createdAt ?? '') || 0;
  out.sort((a, b) => stamp(b) - stamp(a) || b.sessionId.localeCompare(a.sessionId));
  return out;
}

// ---- history (resume without replay — the transcript becomes the batch) ----

type UnknownRecord = Record<string, unknown>;

const isRecord = (v: unknown): v is UnknownRecord =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const OUTPUT_MAX = 100_000;

function bounded(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  return raw.length <= max ? raw : raw.slice(0, max);
}

/** Parse dsh's tool `arguments` (a JSON string) into a bounded rawInput map. */
function parseArguments(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {
    // malformed — the toolName/title still render
  }
  return undefined;
}

/**
 * Map dsh transcript entries onto history items (user blocks + ordinary
 * stream events — ONE fold path in the browser). Genuine user turns are the
 * `agent/inbox/spliced` inserts; `user/message` echoes and the synthesized
 * runtime-context messages are skipped.
 */
export function dshHistoryItems(entries: UnknownRecord[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const entry of entries) {
    const type = entry['type'];
    const data = isRecord(entry['data']) ? (entry['data'] as UnknownRecord) : null;
    if (data === null) continue;
    switch (type) {
      case 'agent/inbox/spliced': {
        const inserted = data['inserted'];
        if (!Array.isArray(inserted)) break;
        for (const raw of inserted) {
          if (!isRecord(raw)) continue;
          const source = isRecord(raw['source']) ? (raw['source'] as UnknownRecord) : null;
          if (source === null || source['kind'] !== 'user') continue;
          const blocks = toPromptBlocks(raw['content']);
          if (blocks.length > 0) items.push({ type: 'user', blocks });
        }
        break;
      }
      case 'assistant/message': {
        const message = isRecord(data['message']) ? (data['message'] as UnknownRecord) : null;
        const content = message !== null ? message['content'] : data['content'];
        if (!Array.isArray(content)) break;
        for (const rawBlock of content) {
          if (!isRecord(rawBlock)) continue;
          const block = rawBlock as UnknownRecord;
          if (block['type'] === 'reasoning') {
            const text = bounded(block['text'], 100_000);
            if (text !== undefined && text !== '') {
              items.push({ type: 'event', event: { kind: 'thought_delta', delta: text } });
            }
          } else if (block['type'] === 'text') {
            const text = bounded(block['text'], 100_000);
            if (text !== undefined && text !== '') {
              items.push({ type: 'event', event: { kind: 'message_delta', delta: text } });
            }
          } else if (block['type'] === 'tool-call') {
            items.push({
              type: 'event',
              event: {
                kind: 'tool_call',
                call: {
                  toolCallId: String(block['id'] ?? 'unknown'),
                  ...(typeof block['name'] === 'string' && block['name'] !== ''
                    ? { toolName: bounded(block['name'], 128) }
                    : {}),
                  status: 'in_progress',
                  ...(parseArguments(block['arguments']) !== undefined
                    ? { rawInput: parseArguments(block['arguments']) as Record<string, unknown> }
                    : {}),
                },
              },
            });
          }
        }
        break;
      }
      case 'tool/call': {
        // Redundant with the assistant/message tool-call block (same callId —
        // the fold merges), but a safety net when a message lacks blocks.
        items.push({
          type: 'event',
          event: {
            kind: 'tool_call',
            call: {
              toolCallId: String(data['callId'] ?? 'unknown'),
              ...(typeof data['name'] === 'string' && data['name'] !== ''
                ? { toolName: bounded(data['name'], 128) }
                : {}),
              status: 'in_progress',
              ...(parseArguments(data['arguments']) !== undefined
                ? { rawInput: parseArguments(data['arguments']) as Record<string, unknown> }
                : {}),
            },
          },
        });
        break;
      }
      case 'tool/result': {
        const message = isRecord(data['message']) ? (data['message'] as UnknownRecord) : null;
        const source = message !== null && isRecord(message['source']) ? message['source'] : null;
        const callId = source !== null ? source['callId'] : undefined;
        if (typeof callId !== 'string' || callId === '') break;
        const texts: string[] = [];
        const content = message !== null ? message['content'] : undefined;
        if (Array.isArray(content)) {
          for (const c of content) {
            if (!isRecord(c)) continue;
            const inner = c['content'];
            if (!Array.isArray(inner)) continue;
            for (const piece of inner) {
              if (
                isRecord(piece) &&
                piece['type'] === 'text' &&
                typeof piece['text'] === 'string'
              ) {
                texts.push(piece['text']);
              }
            }
          }
        }
        items.push({
          type: 'event',
          event: {
            kind: 'tool_call',
            call: {
              toolCallId: callId,
              status: 'completed',
              ...(texts.length > 0 ? { output: bounded(texts.join('\n'), OUTPUT_MAX) } : {}),
            },
          },
        });
        break;
      }
      case 'assistant/chunk': {
        // Only the usage marker rides the history (the text chunks are
        // superseded by assistant/message's complete blocks).
        const chunk = isRecord(data['chunk']) ? (data['chunk'] as UnknownRecord) : null;
        if (chunk !== null && chunk['type'] === 'usage') {
          const usage = isRecord(chunk['usage']) ? (chunk['usage'] as UnknownRecord) : null;
          if (usage !== null) {
            items.push({
              type: 'event',
              event: {
                kind: 'usage',
                ...(typeof usage['inputTokens'] === 'number'
                  ? { inputTokens: usage['inputTokens'] }
                  : {}),
                ...(typeof usage['outputTokens'] === 'number'
                  ? { outputTokens: usage['outputTokens'] }
                  : {}),
              },
            });
          }
        }
        break;
      }
      case 'turn/end': {
        const reason = isRecord(data['reason']) ? (data['reason'] as UnknownRecord) : null;
        items.push({
          type: 'event',
          event: {
            kind: 'turn_result',
            stopReason: reason?.['kind'] === 'cancelled' ? 'cancelled' : 'end_turn',
          },
        });
        break;
      }
      default:
        break; // presets, request/*, step markers, deltas, title — not history
    }
  }
  return items;
}

/** dsh content blocks → prompt blocks (text only in v1, matching our wire). */
function toPromptBlocks(content: unknown): { type: 'text'; text: string }[] {
  const blocks: { type: 'text'; text: string }[] = [];
  if (!Array.isArray(content)) return blocks;
  for (const raw of content) {
    if (isRecord(raw) && raw['type'] === 'text' && typeof raw['text'] === 'string') {
      if (raw['text'] !== '') blocks.push({ type: 'text', text: bounded(raw['text'], 32_000)! });
    }
  }
  return blocks;
}

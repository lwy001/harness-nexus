import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import {
  acpPermissionOptionSchema,
  acpToolCallViewSchema,
  chatPermissionRespondEventSchema,
  chatPromptEventSchema,
  chatSessionCloseEventSchema,
  chatSessionResyncEventSchema,
  chatSessionStartEventSchema,
  chatTurnCancelEventSchema,
  type AcpPermissionOption,
  type AcpToolCallView,
  type ChatStreamEvent,
  type HistoryItem,
  type PromptBlock,
} from '@harness-nexus/shared';
import { AcpAgentConnection } from './acp/agent-connection.js';
import { resolveAcpCommand } from './acp/adapters.js';
import { decodeTranscript, dshHistoryItems, nativeZstd } from './dsh-sessions.js';

/**
 * Daemon-side chat session manager (Phase 8 C5, extended 9 W7).
 * docs/design/phase-8-c5.md + docs/design/phase-9-w7-native-sessions.md.
 *
 * The daemon is the protocol-adaptation edge: one ACP adapter subprocess per
 * `chat:session.start`, ACP frames mapped onto the platform's semantic stream
 * in both directions, permission requests round-tripped verbatim, subprocesses
 * killed on close/disconnect. One prompt in flight per session — a racing
 * prompt is dropped and `active` re-emitted so the server's busy gate resyncs.
 *
 * 9 W7 — sessions are the AGENT's own: a start event may carry `resume`
 * (the agent's session id + its cwd) and is established via the ADVERTISED
 * capability (`session/load` preferred — claude/codex replay their history as
 * session/updates, which we capture and ship as `chat:history`; dsh only has
 * `session/resume`, so its transcript file is parsed instead). Every channel
 * keeps a bounded history ring (forwarded prompts + mapped events) so a
 * `chat:session.resync` (page refresh rejoin) can rebuild the browser's fold.
 */

interface DaemonSession {
  /** Platform channel id. */
  sessionId: string;
  /** The agent's own session id from `session/new` / the resume arm. */
  acpSessionId: string;
  target: string;
  conn: AcpAgentConnection;
  busy: boolean;
  /** In-flight permission requests by our wire requestId. */
  permissions: Map<string, { jsonrpcId: number; timer: NodeJS.Timeout }>;
  /** 9 W7 — the history ring (user items + mapped events), newest last. */
  history: HistoryItem[];
}

const HISTORY_MAX = 2000;

export interface ChatHandlersOptions {
  /** Env source for `HN_ACP_COMMAND_<TARGET>` overrides (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Extra env for the adapter subprocess. */
  spawnEnv?: NodeJS.ProcessEnv;
  /** Overridable for tests (transcript lookup on dsh resume). */
  homeDir?: string;
}

export interface ChatRegistry {
  /** Native session ids live in this daemon (dsh list exclusion). */
  liveNativeIds(): ReadonlySet<string>;
}

export function attachChatHandlers(socket: Socket, opts: ChatHandlersOptions = {}): ChatRegistry {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const sessions = new Map<string, DaemonSession>();

  const emitEvent = (session: DaemonSession, event: ChatStreamEvent): void => {
    pushHistory(session, { type: 'event', event });
    socket.emit('chat:event', { sessionId: session.sessionId, event });
  };

  const pushHistory = (session: DaemonSession, item: HistoryItem): void => {
    session.history.push(item);
    if (session.history.length > HISTORY_MAX) {
      session.history.splice(0, session.history.length - HISTORY_MAX);
    }
  };

  const emitHistory = (session: DaemonSession, items: HistoryItem[]): void => {
    if (items.length === 0) return;
    for (const item of items) pushHistory(session, item);
    socket.emit('chat:history', {
      sessionId: session.sessionId,
      items: session.history.slice(-HISTORY_MAX),
    });
  };

  const teardown = (session: DaemonSession, reason: string): void => {
    if (sessions.get(session.sessionId) !== session) return;
    sessions.delete(session.sessionId);
    for (const [, p] of session.permissions) clearTimeout(p.timer);
    session.permissions.clear();
    session.conn.kill();
    socket.emit('chat:session.closed', { sessionId: session.sessionId, reason });
  };

  // ---- server → daemon: spawn the channel ----
  socket.on('chat:session.start', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatSessionStartEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { sessionId, target, cwd, resume } = parsed.data;
    void (async () => {
      const cmd = resolveAcpCommand(target, env);
      if (cmd === null) {
        socket.emit('chat:session.ready', {
          sessionId,
          error: `no ACP adapter for target '${target}'`,
        });
        return;
      }
      try {
        const { conn, agentInfo, sessionCaps } = await AcpAgentConnection.start(
          cmd.command,
          cmd.args,
          { cwd, ...(opts.spawnEnv !== undefined ? { env: opts.spawnEnv } : {}) },
        );
        // `mcpServers` is sent explicitly (spec: an array): the CURRENT
        // @zed-industries/claude-agent-acp zod-validates session establishment
        // and rejects an absent field with `Invalid params` — adapters are
        // pulled latest by `npx -y`, so the client must be maximally
        // spec-shaped. Startup race (seen on real dsh 0.1.2-rc.1): an
        // establishment fired the instant initialize resolves can beat the
        // agent's model-adapter REGISTRATION ("-32605 no adapter registered
        // for provider …"). Retry that specific failure a few times.
        let acpSessionId: string;
        let history: HistoryItem[] = [];
        if (resume === undefined) {
          const created = (await establish(conn, 'session/new', { cwd, mcpServers: [] })) as {
            sessionId?: string;
          };
          acpSessionId = created?.sessionId ?? sessionId;
        } else {
          // 9 W7 — pick the method from the ADVERTISED capability: `load`
          // replays history (captured below), `resume` does not (dsh → we
          // parse its transcript file instead).
          if (sessionCaps.load) {
            const captured: HistoryItem[] = [];
            const stopCapture = wireCapture(conn, captured);
            try {
              const loaded = (await establish(conn, 'session/load', {
                sessionId: resume.sessionId,
                cwd,
                mcpServers: [],
              })) as { sessionId?: string };
              acpSessionId = loaded?.sessionId ?? resume.sessionId;
              history = finishCaptured(captured);
            } finally {
              stopCapture();
            }
          } else if (sessionCaps.resume) {
            await establish(conn, 'session/resume', {
              sessionId: resume.sessionId,
              cwd,
              mcpServers: [],
            });
            acpSessionId = resume.sessionId;
            history =
              target === 'deepseek' ? await dshTranscriptHistory(home, resume.sessionId) : [];
          } else {
            throw new Error(`ACP adapter for '${target}' supports no session resume`);
          }
        }
        const session: DaemonSession = {
          sessionId,
          acpSessionId,
          target,
          conn,
          busy: false,
          permissions: new Map(),
          history: [],
        };
        sessions.set(sessionId, session);
        wireSession(session, emitEvent);
        conn.onExit(() => {
          // Crash/quit outside our control — end the channel honestly.
          if (sessions.get(sessionId) === session) teardown(session, 'agent-exited');
        });
        emitHistory(session, history);
        socket.emit('chat:session.ready', {
          sessionId,
          nativeSessionId: acpSessionId,
          ...(agentInfo.name !== undefined ? { agentName: agentInfo.name } : {}),
          ...(agentInfo.version !== undefined ? { agentVersion: agentInfo.version } : {}),
        });
      } catch (e) {
        socket.emit('chat:session.ready', {
          sessionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  });

  // ---- server → daemon: prompt / cancel / permission / disconnect / resync ----
  socket.on('chat:message.send', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatPromptEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session === undefined) {
      ack?.({ error: 'unknown-session' });
      return;
    }
    if (session.busy) {
      // Lost the race against the server's busy gate — resync it.
      emitEvent(session, { kind: 'session_status', state: 'active' });
      ack?.({ error: 'session-busy' });
      return;
    }
    ack?.({ accepted: true });
    // The history ring must know the user turn too — a resync rebuilds the
    // fold from items alone (no optimistic browser echo on that path).
    pushHistory(session, { type: 'user', blocks: parsed.data.prompt });
    void runPrompt(session, parsed.data.prompt, emitEvent);
  });

  socket.on('chat:turn.cancel', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatTurnCancelEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session === undefined) {
      ack?.({ error: 'unknown-session' });
      return;
    }
    ack?.({ accepted: true });
    // The pending session/prompt resolves as 'cancelled' → turn_result fires.
    void session.conn.request('session/cancel', {}, 5000).catch(() => {});
  });

  socket.on('chat:permission.respond', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatPermissionRespondEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session === undefined) {
      ack?.({ error: 'unknown-session' });
      return;
    }
    const pending = session.permissions.get(parsed.data.requestId);
    if (pending === undefined) {
      ack?.({ error: 'unknown-permission' });
      return;
    }
    ack?.({ accepted: true });
    clearTimeout(pending.timer);
    session.permissions.delete(parsed.data.requestId);
    // optionId is forwarded VERBATIM (a rewritten id counts as a rejection).
    session.conn.respondPermission(
      pending.jsonrpcId,
      parsed.data.optionId !== undefined
        ? { outcome: 'selected', optionId: parsed.data.optionId }
        : { outcome: 'cancelled' },
    );
  });

  socket.on('chat:session.close', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatSessionCloseEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session !== undefined) {
      // Best-effort session/close, then SIGTERM (kill is on a 3s grace). The
      // AGENT's session survives this (9 W7) — only the subprocess ends.
      void session.conn.request('session/close', {}, 3000).catch(() => {});
      teardown(session, parsed.data.reason ?? 'user');
    }
    ack?.({ closed: true });
  });

  // 9 W7 — a viewer (re)joined a live channel (page refresh): re-emit the
  // history ring so the rebuilt fold shows what already happened.
  socket.on('chat:session.resync', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatSessionResyncEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session !== undefined && session.history.length > 0) {
      socket.emit('chat:history', {
        sessionId: session.sessionId,
        items: session.history.slice(-HISTORY_MAX),
      });
    }
    ack?.({ accepted: true });
  });

  socket.on('disconnect', () => {
    // Channels die with the daemon's connection; the native sessions survive.
    for (const session of [...sessions.values()]) teardown(session, 'daemon-disconnected');
  });

  return {
    liveNativeIds: () => new Set([...sessions.values()].map((s) => s.acpSessionId)),
  };
}

/**
 * Session establishment (`session/new` / `session/load` / `session/resume`)
 * with a retry for the agent-startup registration race: a rejection
 * mentioning "no adapter registered" is retried with a short backoff — the
 * adapter finishes registering moments later.
 */
async function establish(
  conn: AcpAgentConnection,
  method: string,
  params: unknown,
  attempt = 1,
): Promise<unknown> {
  try {
    return await conn.request(method, params, 20000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (attempt < 4 && /no adapter registered/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 600 * attempt));
      return establish(conn, method, params, attempt + 1);
    }
    throw e;
  }
}

/**
 * Capture `session/update` notifications into `items` instead of emitting —
 * used while `session/load` replays an agent's history (claude/codex replay
 * BEFORE the load response resolves). `user_message_chunk` becomes a USER
 * item (on the live path it is dropped as a browser echo); everything else
 * maps through the ordinary update mapping. Returns the deactivation.
 */
function wireCapture(conn: AcpAgentConnection, items: HistoryItem[]): () => void {
  const handler = (method: string, params: Record<string, unknown>): void => {
    if (method !== 'session/update') return;
    const update = (params.update ?? {}) as Record<string, unknown>;
    if (update.sessionUpdate === 'user_message_chunk') {
      const text = textOf(update.contentBlock) || textOf(update.content);
      if (text !== '') items.push({ type: 'user', blocks: [{ type: 'text', text }] });
      return;
    }
    const mapped = mapAcpUpdate(params);
    if (mapped !== null) items.push({ type: 'event', event: mapped });
  };
  conn.setNotificationHandler(handler);
  return () => conn.setNotificationHandler(() => {});
}

/** Close the captured batch: guarantee a trailing turn_result so the fold settles. */
function finishCaptured(items: HistoryItem[]): HistoryItem[] {
  const last = items[items.length - 1];
  if (last !== undefined && last.type === 'event' && last.event.kind !== 'turn_result') {
    items.push({ type: 'event', event: { kind: 'turn_result', stopReason: 'end_turn' } });
  }
  return items;
}

/**
 * dsh resume history — the adapter restores the log WITHOUT replaying, so the
 * transcript file is the source. Best-effort by design: a missing/unreadable
 * transcript (or no zstd on this Node) resumes WITHOUT history rather than
 * failing the channel.
 */
async function dshTranscriptHistory(home: string, sessionId: string): Promise<HistoryItem[]> {
  try {
    const root = join(home, '.dsh', 'sessions');
    const zstd = nativeZstd();
    if (zstd === null) return [];
    for (const slug of readdirSync(root)) {
      const candidate = join(root, slug, sessionId, 'session.jsonl.zstd');
      try {
        return dshHistoryItems(decodeTranscript(readFileSync(candidate), zstd));
      } catch {
        // not under this slug (or undecodable) — try the next
      }
    }
    return [];
  } catch {
    return [];
  }
}

/** Hook ACP frames for one live session onto the semantic stream. */
function wireSession(
  session: DaemonSession,
  emitEvent: (session: DaemonSession, event: ChatStreamEvent) => void,
): void {
  const { conn } = session;

  conn.setNotificationHandler((method, params) => {
    const mapped = method === 'session/update' ? mapAcpUpdate(params) : null;
    if (mapped !== null) emitEvent(session, mapped);
  });

  conn.setPermissionHandler((jsonrpcId, params) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      // Belt-and-braces: the server runs its own watchdog; this backstop
      // guarantees the agent never waits forever even if the server is gone.
      session.permissions.delete(requestId);
      conn.respondPermission(jsonrpcId, { outcome: 'cancelled' });
      emitEvent(session, {
        kind: 'permission_resolved',
        requestId,
        outcome: 'timeout',
      });
    }, 75000);
    session.permissions.set(requestId, { jsonrpcId, timer });
    emitEvent(session, {
      kind: 'permission_request',
      requestId,
      toolCall: toolCallView(params.toolCall),
      options: permissionOptions(params.options),
    });
  });
}

async function runPrompt(
  session: DaemonSession,
  prompt: PromptBlock[],
  emitEvent: (session: DaemonSession, event: ChatStreamEvent) => void,
): Promise<void> {
  session.busy = true;
  emitEvent(session, { kind: 'session_status', state: 'active' });
  try {
    // No client-side timeout: a turn can legitimately run for minutes; the
    // recovery story is cancel or channel close, not a timer.
    const result = (await session.conn.request(
      'session/prompt',
      { sessionId: session.acpSessionId, prompt },
      30 * 60 * 1000,
    )) as { stopReason?: string };
    const stopReason = (['end_turn', 'cancelled', 'max_tokens', 'refusal'] as const).includes(
      result?.stopReason as never,
    )
      ? (result!.stopReason as 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal')
      : 'end_turn';
    emitEvent(session, { kind: 'turn_result', stopReason });
  } catch (e) {
    // A rejected prompt is a TURN error (adapters answer protocol failures —
    // "Authentication required", upstream API errors — through JSON-RPC
    // errors while staying alive), not a dead subprocess. Real process death
    // is conn.onExit's job. Surface the error, end the turn, keep the channel.
    emitEvent(session, {
      kind: 'raw',
      method: 'hnx/prompt-error',
      params: { message: e instanceof Error ? e.message : String(e) },
    });
    emitEvent(session, { kind: 'turn_result', stopReason: 'end_turn' });
  } finally {
    session.busy = false;
    emitEvent(session, { kind: 'session_status', state: 'idle' });
  }
}

// ---- pure ACP → semantic mapping (exported for unit tests) ----

type UnknownRecord = Record<string, unknown>;

/** Map one ACP `session/update` params object; null = drop (user echo). */
export function mapAcpUpdate(params: UnknownRecord): ChatStreamEvent | null {
  const update = (params.update ?? {}) as UnknownRecord;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return { kind: 'message_delta', delta: chunkText(update) };
    case 'agent_thought_chunk':
      return { kind: 'thought_delta', delta: chunkText(update) };
    case 'tool_call':
    case 'tool_call_update': {
      // Claude adapters ride the registry key on the envelope's `_meta`.
      const meta = (params._meta ?? null) as UnknownRecord | null;
      const cc =
        meta !== null && meta.claudeCode !== null && typeof meta.claudeCode === 'object'
          ? (meta.claudeCode as UnknownRecord)
          : null;
      const metaToolName =
        cc !== null && typeof cc.toolName === 'string' && cc.toolName !== ''
          ? cc.toolName
          : undefined;
      // Two dialects: Zed adapters nest under `toolCallUpdate`; dsh's native
      // adapter spreads the fields FLAT on the update object.
      return {
        kind: 'tool_call',
        call: toolCallView(update.toolCallUpdate ?? update, metaToolName),
      };
    }
    case 'usage_update': {
      const usage = (update.usage ?? {}) as UnknownRecord;
      return {
        kind: 'usage',
        ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
        // dsh reports context occupancy (`used` of `size`) instead of
        // per-turn token counts.
        ...(typeof update.used === 'number' ? { contextUsed: update.used } : {}),
        ...(typeof update.size === 'number' ? { contextSize: update.size } : {}),
      };
    }
    case 'user_message_chunk':
      // The browser echoes the user's message optimistically on the live
      // path; history batches (capture mode) turn these into USER items.
      return null;
    default:
      return { kind: 'raw', method: 'session/update', params: update };
  }
}

/** Extract display text from an ACP ContentBlock chunk. */
export function textOf(contentBlock: unknown): string {
  const block = (contentBlock ?? {}) as UnknownRecord;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'resource_link':
      return `[@${String(block.name ?? '')}](${String(block.uri ?? '')})`;
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    case 'resource':
      return '[resource]';
    default:
      return '';
  }
}

/**
 * Text of one message/thought chunk across the two adapter dialects: Zed
 * adapters carry `contentBlock`; dsh's native ACP adapter carries `content`
 * (a ContentBlock-shaped object without the wrapper name).
 */
function chunkText(update: UnknownRecord): string {
  const fromBlock = textOf(update.contentBlock);
  if (fromBlock !== '') return fromBlock;
  return textOf(update.content);
}

/**
 * Defensive view of an ACP ToolCallUpdate: shared-schema-validated, falling
 * back to the bare id when an adapter sends something malformed (the server
 * re-validates everything crossing the wire).
 *
 * 9 W6 enrichment: carries `toolName` (the card registry key — from the
 * update itself or the Claude `_meta.claudeCode.toolName` on the envelope),
 * `rawInput` (dropped when oversized — Write-style file bodies), structured
 * `content` (diff/text/terminal items), and the `rawOutput` text — the rich
 * tool cards' rendering inputs.
 */
export function toolCallView(toolCallUpdate: unknown, metaToolName?: string): AcpToolCallView {
  const t = (toolCallUpdate ?? {}) as UnknownRecord;
  const parsed = acpToolCallViewSchema.safeParse(buildView(t, metaToolName));
  if (parsed.success) return parsed.data;
  return { toolCallId: String(t.toolCallId ?? 'unknown') };
}

const TOOL_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

/** Spec form is the short kind; some adapters send `readTool`-style variants. */
function normalizeKind(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const k = raw.toLowerCase().replace(/tool$/, '');
  return TOOL_KINDS.has(k) ? k : undefined;
}

const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);

function boundedString(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  return raw.length <= max ? raw : raw.slice(0, max);
}

const RAW_INPUT_MAX = 32 * 1024;

/** Field-by-field extraction with every bound enforced before the parse. */
function buildView(t: UnknownRecord, metaToolName: string | undefined): UnknownRecord {
  const toolName =
    typeof t.toolName === 'string' && t.toolName !== ''
      ? t.toolName
      : typeof metaToolName === 'string' && metaToolName !== ''
        ? metaToolName
        : undefined;

  let rawInput: Record<string, unknown> | undefined;
  if (t.rawInput !== null && typeof t.rawInput === 'object' && !Array.isArray(t.rawInput)) {
    const entries = Object.entries(t.rawInput as Record<string, unknown>).filter(
      ([key]) => key.length <= 128,
    );
    try {
      if (JSON.stringify(Object.fromEntries(entries))!.length <= RAW_INPUT_MAX) {
        rawInput = Object.fromEntries(entries);
      }
    } catch {
      rawInput = undefined; // unserializable values — drop rather than fail
    }
  }

  let content: unknown[] | undefined;
  if (Array.isArray(t.content)) {
    content = t.content
      .filter((c): c is UnknownRecord => c !== null && typeof c === 'object')
      .slice(0, 16)
      .map((c) => ({
        type: c.type,
        ...(c.content !== null && typeof c.content === 'object' && !Array.isArray(c.content)
          ? {
              content: {
                type: String((c.content as UnknownRecord).type ?? ''),
                ...('text' in (c.content as UnknownRecord)
                  ? { text: boundedString((c.content as UnknownRecord).text, 100000) }
                  : {}),
              },
            }
          : {}),
        ...(typeof c.path === 'string' ? { path: boundedString(c.path, 1024) } : {}),
        ...(typeof c.oldText === 'string' ? { oldText: boundedString(c.oldText, 100000) } : {}),
        ...(typeof c.newText === 'string' ? { newText: boundedString(c.newText, 100000) } : {}),
        ...(typeof c.terminalId === 'string'
          ? { terminalId: boundedString(c.terminalId, 128) }
          : {}),
      }));
  }

  const locations = Array.isArray(t.locations)
    ? t.locations
        .filter((l): l is UnknownRecord => l !== null && typeof l === 'object')
        .slice(0, 16)
        .map((l) => ({
          path: String(l.path ?? ''),
          ...(typeof l.line === 'number' ? { line: l.line } : {}),
          ...(typeof l.lineEnd === 'number' ? { lineEnd: l.lineEnd } : {}),
        }))
        .filter((l) => l.path !== '')
    : undefined;

  return {
    toolCallId: String(t.toolCallId ?? ''),
    ...(typeof t.title === 'string' && t.title !== ''
      ? { title: boundedString(t.title, 512) }
      : {}),
    ...(toolName !== undefined ? { toolName: boundedString(toolName, 128) } : {}),
    ...(normalizeKind(t.kind) !== undefined ? { kind: normalizeKind(t.kind) } : {}),
    ...(typeof t.status === 'string' && TOOL_STATUSES.has(t.status) ? { status: t.status } : {}),
    ...(locations !== undefined && locations.length > 0 ? { locations } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(typeof t.rawOutput === 'string' && t.rawOutput !== ''
      ? { output: boundedString(t.rawOutput, 100000) }
      : {}),
  };
}

/** Permission options, shared-schema-validated; malformed entries dropped. */
function permissionOptions(options: unknown): AcpPermissionOption[] {
  if (!Array.isArray(options)) return [];
  const out: AcpPermissionOption[] = [];
  for (const o of options) {
    const parsed = acpPermissionOptionSchema.safeParse(o);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

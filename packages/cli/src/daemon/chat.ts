import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io-client';
import {
  acpPermissionOptionSchema,
  acpToolCallViewSchema,
  chatPermissionRespondEventSchema,
  chatPromptEventSchema,
  chatSessionCloseEventSchema,
  chatSessionStartEventSchema,
  chatTurnCancelEventSchema,
  type AcpPermissionOption,
  type AcpToolCallView,
  type ChatStreamEvent,
  type PromptBlock,
} from '@harness-nexus/shared';
import { AcpAgentConnection } from './acp/agent-connection.js';
import { resolveAcpCommand } from './acp/adapters.js';

/**
 * Daemon-side chat session manager (Phase 8 C5). docs/design/phase-8-c5.md.
 *
 * The daemon is the protocol-adaptation edge: one ACP adapter subprocess per
 * `chat:session.start`, ACP frames mapped onto the platform's semantic stream
 * in both directions, permission requests round-tripped verbatim, subprocesses
 * killed on close/disconnect. One prompt in flight per session — a racing
 * prompt is dropped and `active` re-emitted so the server's busy gate resyncs
 * (the demo's follow-up queue is deferred; see the design doc).
 */

interface DaemonSession {
  /** Platform channel id (the AcSession row). */
  sessionId: string;
  /** The agent's own session id from `session/new`. */
  acpSessionId: string;
  conn: AcpAgentConnection;
  busy: boolean;
  /** In-flight permission requests by our wire requestId. */
  permissions: Map<string, { jsonrpcId: number; timer: NodeJS.Timeout }>;
}

export interface ChatHandlersOptions {
  /** Env source for `HN_ACP_COMMAND_<TARGET>` overrides (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Extra env for the adapter subprocess. */
  spawnEnv?: NodeJS.ProcessEnv;
}

export function attachChatHandlers(socket: Socket, opts: ChatHandlersOptions = {}): void {
  const env = opts.env ?? process.env;
  const sessions = new Map<string, DaemonSession>();

  const emitEvent = (sessionId: string, event: ChatStreamEvent): void => {
    socket.emit('chat:event', { sessionId, event });
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
    const { sessionId, target, cwd } = parsed.data;
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
        const { conn, agentInfo } = await AcpAgentConnection.start(cmd.command, cmd.args, {
          cwd,
          ...(opts.spawnEnv !== undefined ? { env: opts.spawnEnv } : {}),
        });
        const created = (await conn.request('session/new', { cwd }, 20000)) as {
          sessionId?: string;
        };
        const session: DaemonSession = {
          sessionId,
          acpSessionId: created?.sessionId ?? sessionId,
          conn,
          busy: false,
          permissions: new Map(),
        };
        sessions.set(sessionId, session);
        wireSession(session, emitEvent);
        conn.onExit(() => {
          // Crash/quit outside our control — end the channel honestly.
          if (sessions.get(sessionId) === session) teardown(session, 'agent-exited');
        });
        socket.emit('chat:session.ready', {
          sessionId,
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

  // ---- server → daemon: prompt / cancel / permission / close ----
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
      emitEvent(session.sessionId, { kind: 'session_status', state: 'active' });
      ack?.({ error: 'session-busy' });
      return;
    }
    ack?.({ accepted: true });
    void runPrompt(session, parsed.data.prompt, emitEvent, teardown);
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
      // Best-effort session/close, then SIGTERM (kill is on a 3s grace).
      void session.conn.request('session/close', {}, 3000).catch(() => {});
      teardown(session, parsed.data.reason ?? 'user');
    }
    ack?.({ closed: true });
  });

  socket.on('disconnect', () => {
    // No resume in v1 — every channel dies with the daemon's connection.
    for (const session of [...sessions.values()]) teardown(session, 'daemon-disconnected');
  });
}

/** Hook ACP frames for one live session onto the semantic stream. */
function wireSession(
  session: DaemonSession,
  emitEvent: (sessionId: string, event: ChatStreamEvent) => void,
): void {
  const { conn } = session;

  conn.setNotificationHandler((method, params) => {
    const mapped = method === 'session/update' ? mapAcpUpdate(params) : null;
    if (mapped !== null) emitEvent(session.sessionId, mapped);
  });

  conn.setPermissionHandler((jsonrpcId, params) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      // Belt-and-braces: the server runs its own watchdog; this backstop
      // guarantees the agent never waits forever even if the server is gone.
      session.permissions.delete(requestId);
      conn.respondPermission(jsonrpcId, { outcome: 'cancelled' });
      emitEvent(session.sessionId, {
        kind: 'permission_resolved',
        requestId,
        outcome: 'timeout',
      });
    }, 75000);
    session.permissions.set(requestId, { jsonrpcId, timer });
    emitEvent(session.sessionId, {
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
  emitEvent: (sessionId: string, event: ChatStreamEvent) => void,
  teardown: (session: DaemonSession, reason: string) => void,
): Promise<void> {
  session.busy = true;
  emitEvent(session.sessionId, { kind: 'session_status', state: 'active' });
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
    emitEvent(session.sessionId, { kind: 'turn_result', stopReason });
  } catch (e) {
    emitEvent(session.sessionId, {
      kind: 'raw',
      method: 'hnx/prompt-error',
      params: { message: e instanceof Error ? e.message : String(e) },
    });
    emitEvent(session.sessionId, { kind: 'turn_result', stopReason: 'end_turn' });
    // The subprocess is unusable — end the channel honestly.
    teardown(session, 'agent-exited');
    return;
  } finally {
    session.busy = false;
    emitEvent(session.sessionId, { kind: 'session_status', state: 'idle' });
  }
}

// ---- pure ACP → semantic mapping (exported for unit tests) ----

type UnknownRecord = Record<string, unknown>;

/** Map one ACP `session/update` params object; null = drop (user echo). */
export function mapAcpUpdate(params: UnknownRecord): ChatStreamEvent | null {
  const update = (params.update ?? {}) as UnknownRecord;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return { kind: 'message_delta', delta: textOf(update.contentBlock) };
    case 'agent_thought_chunk':
      return { kind: 'thought_delta', delta: textOf(update.contentBlock) };
    case 'tool_call':
    case 'tool_call_update':
      return { kind: 'tool_call', call: toolCallView(update.toolCallUpdate) };
    case 'usage_update': {
      const usage = (update.usage ?? {}) as UnknownRecord;
      return {
        kind: 'usage',
        ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage.outputTokens === 'number' ? { outputTokens: usage.outputTokens } : {}),
      };
    }
    case 'user_message_chunk':
      // The browser echoes the user's message optimistically; there is no
      // replay in v1, so a live echo would double-render.
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
 * Defensive view of an ACP ToolCallUpdate: shared-schema-validated, falling
 * back to the bare id when an adapter sends something malformed (the server
 * re-validates everything crossing the wire).
 */
export function toolCallView(toolCallUpdate: unknown): AcpToolCallView {
  const parsed = acpToolCallViewSchema.safeParse(toolCallUpdate);
  if (parsed.success) return parsed.data;
  const t = (toolCallUpdate ?? {}) as UnknownRecord;
  return { toolCallId: String(t.toolCallId ?? 'unknown') };
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

import { io, type Socket } from 'socket.io-client';
import { TOKEN_KEY } from './api.js';

/**
 * The browser's `/app` realtime channel (Phase 8): server-push events only in
 * C1 (`machine:status`). One lazily-created singleton socket; the auth
 * callback re-reads the stored token on EVERY (re)connect attempt, so a
 * refreshed JWT after re-login needs no extra protocol support. Browsers
 * never talk to daemons — the platform is the only routing point.
 */

/** Wire shape of `inventory:updated` (mirrors shared/realtime.ts). */
export interface InventoryUpdatedEvent {
  machineId: string;
  target: string;
  reportedAt: string;
}

/** Wire shape of `machine:status` (mirrors shared/realtime.ts). */
export interface MachineStatusEvent {
  machineId: string;
  online: boolean;
  lastSeenAt: string | null;
  daemonVersion?: string | null;
}

let socket: Socket | null = null;

export function appSocket(): Socket {
  if (socket === null) {
    socket = io('/app', {
      auth: (cb) => cb({ token: localStorage.getItem(TOKEN_KEY) ?? '' }),
    });
  }
  return socket;
}

/** Close the singleton (e.g. on logout). */
export function closeAppSocket(): void {
  if (socket !== null) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
}

// ---- chat (Phase 8 C5) — mirrors shared/realtime.ts ----

/** One semantic chat event (`chat:event` → `{ sessionId, event }`). */
export type ChatStreamEvent =
  | { kind: 'message_delta'; delta: string }
  | { kind: 'thought_delta'; delta: string }
  | {
      kind: 'tool_call';
      call: {
        toolCallId: string;
        title?: string;
        kind?: string;
        status?: 'pending' | 'in_progress' | 'completed' | 'failed';
        locations?: { path: string; line?: number }[];
      };
    }
  | { kind: 'usage'; inputTokens?: number; outputTokens?: number }
  | {
      kind: 'permission_request';
      requestId: string;
      toolCall: { toolCallId: string; title?: string; kind?: string };
      options: { optionId: string; name: string; kind: string }[];
    }
  | {
      kind: 'permission_resolved';
      requestId: string;
      outcome: 'selected' | 'cancelled' | 'timeout';
      optionId?: string;
    }
  | { kind: 'turn_result'; stopReason: 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' }
  | { kind: 'session_status'; state: 'active' | 'idle' }
  | { kind: 'raw'; method: string; params: unknown };

export interface ChatEventEnvelope {
  sessionId: string;
  event: ChatStreamEvent;
}

export interface ChatSessionReadyPush {
  sessionId: string;
  agentName?: string;
  agentVersion?: string;
}
export interface ChatSessionFailedPush {
  sessionId: string;
  error: string;
}
export interface ChatSessionClosedPush {
  sessionId: string;
  reason: string;
}

/** Emit with an ack callback; resolves the ack object (rejects on timeout). */
export function emitWithAck<T>(event: string, payload: unknown, timeoutMs = 10000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for '${event}'`)), timeoutMs);
    appSocket().emit(event, payload, (res: T) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

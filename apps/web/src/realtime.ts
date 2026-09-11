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
      call: ChatToolCallView;
    }
  | {
      kind: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      /** dsh dialect: context occupancy instead of per-turn token counts. */
      contextUsed?: number;
      contextSize?: number;
    }
  | {
      kind: 'permission_request';
      requestId: string;
      toolCall: ChatToolCallView;
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
  | ({ kind: 'session_config' } & SessionConfigPatch)
  | { kind: 'raw'; method: string; params: unknown };

// ---- 9 W9 A — ACP session modes & configuration (mirrors shared/realtime.ts) ----

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionConfigValue {
  value: string;
  name: string;
  description?: string;
  /** dsh groups model options by provider — display grouping only. */
  group?: string;
}

export interface SessionConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  currentValue?: string;
  options?: SessionConfigValue[];
}

/**
 * PATCH semantics: `availableModes` / `configOptions` replace when present;
 * a lone `currentModeId` patches the current mode. The daemon emits full
 * merged snapshots; option VALUES are opaque adapter keys (dsh model values
 * are JSON `[provider, model]` — compare by equality, never parse).
 */
export interface SessionConfigPatch {
  modes?: { currentModeId?: string; availableModes?: SessionMode[] };
  configOptions?: SessionConfigOption[];
}

/** 9 W9 A — the set payload (what the composer emits). */
export type ChatConfigSetPayload =
  { kind: 'mode'; modeId: string } | { kind: 'option'; configId: string; value: string };

/** 9 W9 A — browser → server: switch the session's mode / one option. */
export type ChatConfigSet = { sessionId: string } & ChatConfigSetPayload;

/** 9 W6 — one ACP ToolCallContent item (diff / content / terminal). */
export interface AcpToolContentItem {
  type: 'content' | 'diff' | 'terminal';
  content?: { type: string; text?: string };
  path?: string;
  oldText?: string | null;
  newText?: string;
  terminalId?: string;
}

/** Shared shape of a tool-call view (rows + permission cards). */
export interface ChatToolCallView {
  toolCallId: string;
  title?: string;
  toolName?: string;
  kind?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  locations?: { path: string; line?: number; lineEnd?: number }[];
  rawInput?: Record<string, unknown>;
  content?: AcpToolContentItem[];
  output?: string;
}

export interface ChatEventEnvelope {
  sessionId: string;
  event: ChatStreamEvent;
}

export interface ChatSessionReadyPush {
  sessionId: string;
  agentName?: string;
  agentVersion?: string;
  /** 9 W7 — the agent's OWN session id behind this channel (rail highlight). */
  nativeSessionId?: string;
  /** 9 W9 B — prompt-content capabilities (gates the attach affordance). */
  promptCapabilities?: { image: boolean; audio?: boolean; embeddedContext?: boolean };
}
export interface ChatSessionFailedPush {
  sessionId: string;
  error: string;
}
export interface ChatSessionClosedPush {
  sessionId: string;
  reason: string;
}

// ---- 9 W7 — native session history (mirrors shared/realtime.ts) ----

/** One prompt block the browser may send / one history user item carries. */
export type PromptBlock =
  | { type: 'text'; text: string }
  | { type: 'resource_link'; name: string; uri: string }
  | {
      type: 'image';
      data: string;
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    };

/** One item of a channel's history batch: a user turn, or an ordinary event. */
export type HistoryItem =
  { type: 'user'; blocks: PromptBlock[] } | { type: 'event'; event: ChatStreamEvent };

export interface ChatHistoryEvent {
  sessionId: string;
  items: HistoryItem[];
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

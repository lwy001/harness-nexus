import type { AcpToolContentItem, ChatStreamEvent, ChatToolCallView } from '@/realtime';

/**
 * The conversation fold (Phase 9 W6) — adapted from the portal reference's
 * row-sequence model (docs/research/phase-9-portal-chat-ui.md §2): the stream
 * is a LIST OF ROWS, not a list of bubbles — user rows, assistant STEPS (one
 * segment of model output, split by tool calls), independent tool rows with a
 * lifecycle, system notes, and turn-tail stats. Pure reducer, O(1) hot path
 * (append to last block / upsert tool row by callId); only touched rows get
 * new object identities so memoized row components skip the rest.
 *
 * Permissions stay a SEPARATE slice (rendered from payload options — the C5
 * rule that option sets are never hardcoded holds).
 */

export interface ToolCallNode {
  callId: string;
  /** Registry key ('Read'/'Bash'/…) — `_meta.claudeCode.toolName` upstream. */
  toolName?: string;
  title?: string;
  kind?: string;
  status: 'running' | 'completed' | 'failed';
  rawInput?: Record<string, unknown>;
  content?: AcpToolContentItem[];
  output?: string;
  locations?: ChatToolCallView['locations'];
  startedAt: number;
  endedAt?: number;
}

export interface ContentBlock {
  type: 'text' | 'reasoning';
  text: string;
}

export interface AssistantStep {
  stepId: string;
  status: 'running' | 'settled' | 'interrupted';
  blocks: ContentBlock[];
  startedAt: number;
}

export interface TurnStats {
  stopReason: string;
  error?: string;
  durationMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type ConversationRow =
  | { row: 'user'; key: string; text: string }
  | { row: 'assistant'; key: string; step: AssistantStep }
  | { row: 'tool'; key: string; root: ToolCallNode }
  | { row: 'system'; key: string; text: string; tone: 'info' | 'success' | 'error' }
  | { row: 'turn-tail'; key: string; stats: TurnStats };

export interface PermissionCardState {
  requestId: string;
  toolCall: ChatToolCallView;
  options: { optionId: string; name: string; kind: string }[];
  settled: boolean;
}

export interface FoldState {
  rows: ConversationRow[];
  toolRowIndex: Map<string, number>;
  currentStepIdx: number;
  stepClosed: boolean;
  seq: number;
  turnStartedAt: number | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  permissions: PermissionCardState[];
  turnActive: boolean;
}

export type FoldAction = { type: 'reset' } | { type: 'user_message'; text: string } | {
  type: 'event';
  event: ChatStreamEvent;
};

export function createFoldState(): FoldState {
  return {
    rows: [],
    toolRowIndex: new Map(),
    currentStepIdx: -1,
    stepClosed: true,
    seq: 0,
    turnStartedAt: null,
    usage: null,
    permissions: [],
    turnActive: false,
  };
}

const nextKey = (state: FoldState, prefix: string): string => `r${state.seq++}-${prefix}`;

function appendBlock(blocks: ContentBlock[], block: ContentBlock): ContentBlock[] {
  const last = blocks[blocks.length - 1];
  if (last !== undefined && last.type === block.type) {
    const next = blocks.slice();
    next[next.length - 1] = { ...last, text: last.text + block.text };
    return next;
  }
  return [...blocks, block];
}

function currentStep(state: FoldState): AssistantStep | null {
  if (state.currentStepIdx < 0 || state.stepClosed) return null;
  const row = state.rows[state.currentStepIdx];
  return row !== undefined && row.row === 'assistant' ? row.step : null;
}

/** Tool rows settle the current step — later text opens a NEW one (order feel). */
function settleCurrentStep(state: FoldState): FoldState {
  const idx = state.currentStepIdx;
  if (idx < 0) return state;
  const row = state.rows[idx];
  if (row === undefined || row.row !== 'assistant' || row.step.status !== 'running') return state;
  const rows = state.rows.slice();
  rows[idx] = { ...row, step: { ...row.step, status: 'settled' } };
  return { ...state, rows };
}

function openStep(state: FoldState, block: ContentBlock): FoldState {
  const step: AssistantStep = {
    stepId: nextKey(state, 'step'),
    status: 'running',
    blocks: [block],
    startedAt: Date.now(),
  };
  const rows = [...state.rows, { row: 'assistant', key: `a-${step.stepId}`, step } as ConversationRow];
  return { ...state, rows, currentStepIdx: rows.length - 1, stepClosed: false };
}

function patchStep(state: FoldState, block: ContentBlock): FoldState {
  const idx = state.currentStepIdx;
  const row = state.rows[idx];
  if (row === undefined || row.row !== 'assistant') return openStep(state, block);
  const rows = state.rows.slice();
  rows[idx] = { ...row, step: { ...row.step, blocks: appendBlock(row.step.blocks, block) } };
  return { ...state, rows };
}

/** ACP statuses fold to the three render states. */
function toNodeStatus(status: ChatToolCallView['status']): ToolCallNode['status'] {
  if (status === 'completed' || status === 'failed') return status;
  return 'running';
}

function nodeFromCall(call: ChatToolCallView): ToolCallNode {
  return {
    callId: call.toolCallId,
    ...(call.toolName !== undefined ? { toolName: call.toolName } : {}),
    ...(call.title !== undefined ? { title: call.title } : {}),
    ...(call.kind !== undefined ? { kind: call.kind } : {}),
    ...(call.locations !== undefined ? { locations: call.locations } : {}),
    ...(call.rawInput !== undefined ? { rawInput: call.rawInput } : {}),
    ...(call.content !== undefined ? { content: call.content } : {}),
    ...(call.output !== undefined ? { output: call.output } : {}),
    status: toNodeStatus(call.status),
    startedAt: Date.now(),
  };
}

function patchToolRow(
  state: FoldState,
  call: ChatToolCallView,
): FoldState {
  const idx = state.toolRowIndex.get(call.toolCallId);
  if (idx === undefined) {
    const node = nodeFromCall(call);
    const rows = [...state.rows, { row: 'tool', key: `t-${node.callId}`, root: node } as ConversationRow];
    const toolRowIndex = new Map(state.toolRowIndex);
    toolRowIndex.set(node.callId, rows.length - 1);
    return settleCurrentStep({ ...state, rows, toolRowIndex, stepClosed: true });
  }
  const row = state.rows[idx];
  if (row === undefined || row.row !== 'tool') return state;
  const nextStatus = toNodeStatus(call.status);
  const root: ToolCallNode = {
    ...row.root,
    ...('title' in call && call.title !== undefined ? { title: call.title } : {}),
    ...(call.toolName !== undefined ? { toolName: call.toolName } : {}),
    ...(call.kind !== undefined ? { kind: call.kind } : {}),
    ...(call.status !== undefined ? { status: nextStatus } : {}),
    ...(call.locations !== undefined ? { locations: call.locations } : {}),
    ...(call.rawInput !== undefined ? { rawInput: call.rawInput } : {}),
    ...(call.content !== undefined && call.content.length > 0 ? { content: call.content } : {}),
    ...(call.output !== undefined ? { output: call.output } : {}),
    ...(nextStatus !== 'running' && row.root.endedAt === undefined ? { endedAt: Date.now() } : {}),
  };
  const rows = state.rows.slice();
  rows[idx] = { ...row, root };
  return { ...state, rows };
}

/** Sweep every running step/tool — the idempotent turn tail guard. */
function sweepRows(state: FoldState, interrupted: boolean): ConversationRow[] {
  return state.rows.map((row, idx) => {
    if (row.row === 'assistant' && row.step.status === 'running') {
      return {
        ...row,
        step: {
          ...row.step,
          status: interrupted && idx === state.currentStepIdx ? ('interrupted' as const) : ('settled' as const),
        },
      };
    }
    if (row.row === 'tool' && row.root.status === 'running') {
      return { ...row, root: { ...row.root, status: 'completed' as const } };
    }
    return row;
  });
}

export function fold(state: FoldState, action: FoldAction): FoldState {
  switch (action.type) {
    case 'reset':
      return createFoldState();

    case 'user_message': {
      // A new user message starts a turn: sweep leftovers, open a running
      // step (renders the "thinking…" placeholder until the first chunk).
      const swept = sweepRows(state, false);
      const step: AssistantStep = {
        stepId: nextKey(state, 'step'),
        status: 'running',
        blocks: [],
        startedAt: Date.now(),
      };
      const rows: ConversationRow[] = [
        ...swept,
        { row: 'user', key: nextKey(state, 'u'), text: action.text },
        { row: 'assistant', key: `a-${step.stepId}`, step },
      ];
      return {
        ...state,
        rows,
        currentStepIdx: rows.length - 1,
        stepClosed: false,
        turnStartedAt: Date.now(),
        turnActive: true,
      };
    }

    case 'event': {
      const { event } = action;
      switch (event.kind) {
        case 'message_delta':
        case 'thought_delta': {
          const block: ContentBlock =
            event.kind === 'message_delta'
              ? { type: 'text', text: event.delta }
              : { type: 'reasoning', text: event.delta };
          if (currentStep(state) !== null) return patchStep(state, block);
          return openStep(state, block);
        }
        case 'tool_call':
          return patchToolRow(state, event.call);
        case 'usage':
          return {
            ...state,
            usage: {
              ...(state.usage ?? {}),
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            },
          };
        case 'permission_request':
          return {
            ...state,
            permissions: [
              ...state.permissions.filter((p) => p.requestId !== event.requestId),
              {
                requestId: event.requestId,
                toolCall: event.toolCall,
                options: event.options,
                settled: false,
              },
            ],
          };
        case 'permission_resolved':
          return {
            ...state,
            permissions: state.permissions.map((p) =>
              p.requestId === event.requestId ? { ...p, settled: true } : p,
            ),
          };
        case 'turn_result': {
          const interrupted = event.stopReason === 'cancelled';
          const next: FoldState = state;
          const rows = sweepRows(next, interrupted);
          const lastRow = rows[rows.length - 1];
          const noRunning = rows.every(
            (r) =>
              (r.row === 'assistant' ? r.step.status !== 'running' : r.row !== 'tool' || r.root.status !== 'running'),
          );
          if (noRunning && lastRow !== undefined && lastRow.row === 'turn-tail') {
            return { ...next, rows };
          }
          const durationMs =
            next.turnStartedAt !== null ? Date.now() - next.turnStartedAt : undefined;
          const tail: ConversationRow = {
            row: 'turn-tail',
            key: nextKey(next, 'tail'),
            stats: {
              stopReason: event.stopReason,
              ...(durationMs !== undefined && durationMs > 0 ? { durationMs } : {}),
              ...(next.usage !== undefined && next.usage !== null ? { usage: next.usage } : {}),
            },
          };
          return {
            ...next,
            rows: [...rows, tail],
            currentStepIdx: -1,
            stepClosed: true,
            turnActive: false,
            turnStartedAt: null,
          };
        }
        case 'session_status':
          return { ...state, turnActive: event.state === 'active' };
        case 'raw':
          if (event.method === 'hnx/prompt-error') {
            const message = (event.params as { message?: string } | undefined)?.message;
            if (message !== undefined && message !== '') {
              return {
                ...state,
                rows: [
                  ...state.rows,
                  { row: 'system', key: nextKey(state, 'err'), text: message, tone: 'error' },
                ],
              };
            }
          }
          return state;
        default:
          return state;
      }
    }

    default:
      return state;
  }
}

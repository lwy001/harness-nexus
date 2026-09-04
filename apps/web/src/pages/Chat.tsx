import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowUpIcon,
  BotIcon,
  CircleStopIcon,
  LaptopIcon,
  MessageSquareIcon,
  PlusIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { AppShell } from '@/components/app-shell';
import {
  appSocket,
  emitWithAck,
  type ChatEventEnvelope,
  type ChatSessionClosedPush,
  type ChatSessionFailedPush,
  type ChatSessionReadyPush,
  type ChatStreamEvent,
} from '@/realtime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  HarnessNexusError,
  type AcSessionView,
  type AgentInstanceView,
  type MachineView,
} from '@harness-nexus/sdk';

/**
 * Chat (Phase 8 C5): pick a machine → agent instance → channel, then talk to
 * the deployed agent over `/app` `chat:*`. The conversation view is a pure
 * fold (useReducer) over the semantic stream — deltas append, tool rows
 * upsert by id, `turn_result` settles the running steps. Signal rules: the
 * live-turn indicator is this view's one `--signal` spend; permission cards
 * render from the payload's options (never hardcoded allow/deny).
 */

// ---- conversation fold ----

interface ToolRow {
  toolCallId: string;
  title: string;
  kind?: string;
  status: string;
}

interface ConversationState {
  /** 'user' | 'agent' | 'thought' text blocks, in order. */
  blocks: { role: 'user' | 'agent' | 'thought'; text: string }[];
  tools: ToolRow[];
  permissions: {
    requestId: string;
    toolCall: { toolCallId: string; title?: string; kind?: string };
    options: { optionId: string; name: string; kind: string }[];
    settled: boolean;
  }[];
  turnActive: boolean;
  stopReason: string | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
}

const EMPTY_CONVERSATION: ConversationState = {
  blocks: [],
  tools: [],
  permissions: [],
  turnActive: false,
  stopReason: null,
  usage: null,
};

type ConversationAction =
  | { type: 'reset' }
  | { type: 'user_message'; text: string }
  | { type: 'event'; event: ChatStreamEvent };

function conversationReducer(
  state: ConversationState,
  action: ConversationAction,
): ConversationState {
  if (action.type === 'reset') return EMPTY_CONVERSATION;
  if (action.type === 'user_message') {
    return {
      ...state,
      stopReason: null,
      blocks: [...state.blocks, { role: 'user', text: action.text }],
    };
  }
  const { event } = action;
  switch (event.kind) {
    case 'message_delta': {
      const last = state.blocks[state.blocks.length - 1];
      if (last !== undefined && last.role === 'agent') {
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), { role: 'agent', text: last.text + event.delta }],
        };
      }
      return { ...state, blocks: [...state.blocks, { role: 'agent', text: event.delta }] };
    }
    case 'thought_delta': {
      const last = state.blocks[state.blocks.length - 1];
      if (last !== undefined && last.role === 'thought') {
        return {
          ...state,
          blocks: [
            ...state.blocks.slice(0, -1),
            { role: 'thought', text: last.text + event.delta },
          ],
        };
      }
      return { ...state, blocks: [...state.blocks, { role: 'thought', text: event.delta }] };
    }
    case 'tool_call': {
      const { call } = event;
      const exists = state.tools.some((t) => t.toolCallId === call.toolCallId);
      return {
        ...state,
        tools: exists
          ? state.tools.map((t) =>
              t.toolCallId === call.toolCallId
                ? {
                    ...t,
                    ...('title' in call ? { title: call.title ?? t.title } : {}),
                    status: call.status ?? t.status,
                  }
                : t,
            )
          : [
              ...state.tools,
              {
                toolCallId: call.toolCallId,
                title: call.title ?? call.toolCallId,
                ...(call.kind !== undefined ? { kind: call.kind } : {}),
                status: call.status ?? 'pending',
              },
            ],
      };
    }
    case 'usage':
      return {
        ...state,
        usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens },
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
    case 'turn_result':
      return {
        ...state,
        turnActive: false,
        stopReason: event.stopReason,
        permissions: state.permissions.map((p) => ({ ...p, settled: true })),
      };
    case 'session_status':
      return { ...state, turnActive: event.state === 'active' };
    default:
      return state; // raw — the fold keeps the known kinds only
  }
}

// ---- page ----

export function ChatPage() {
  const { logout } = useAuth();
  const [machines, setMachines] = useState<MachineView[]>([]);
  const [machineId, setMachineId] = useState('');
  const [agents, setAgents] = useState<AgentInstanceView[]>([]);
  const [agentId, setAgentId] = useState('');
  const [sessions, setSessions] = useState<AcSessionView[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [phase, setPhase] = useState<'idle' | 'connecting' | 'ready' | 'closed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [conversation, dispatch] = useReducer(conversationReducer, EMPTY_CONVERSATION);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const machine = useMemo(() => machines.find((m) => m.id === machineId), [machines, machineId]);
  const agent = useMemo(() => agents.find((a) => a.id === agentId), [agents, agentId]);
  const chatBlocked =
    machine === undefined || !machine.online || !machine.remoteChatEnabled || agent === undefined;

  const loadMachines = useCallback(async () => {
    try {
      setMachines(await withAuthGuard(() => api.listMachines(), logout));
    } catch {
      setMachines([]);
    }
  }, [logout]);

  useEffect(() => {
    void loadMachines();
  }, [loadMachines]);

  // Machine → agents (+ keep selection coherent).
  useEffect(() => {
    if (machineId === '') {
      setAgents([]);
      setAgentId('');
      return;
    }
    void (async () => {
      try {
        const list = await withAuthGuard(() => api.listMachineAgents(machineId), logout);
        setAgents(list);
        setAgentId((prev) => (list.some((a) => a.id === prev) ? prev : (list[0]?.id ?? '')));
      } catch {
        setAgents([]);
        setAgentId('');
      }
    })();
  }, [machineId, logout]);

  const refreshSessions = useCallback(async () => {
    if (agentId === '') {
      setSessions([]);
      return;
    }
    try {
      const res = await withAuthGuard(() => api.listAgentSessions(agentId), logout);
      setSessions(res.sessions);
    } catch {
      setSessions([]);
    }
  }, [agentId, logout]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Reset the pane whenever the channel changes.
  useEffect(() => {
    dispatch({ type: 'reset' });
    setPhase(sessionId === '' ? 'idle' : 'connecting');
  }, [sessionId]);

  // Live channel wiring.
  useEffect(() => {
    if (sessionId === '') return;
    const socket = appSocket();
    const onEvent = (envelope: ChatEventEnvelope): void => {
      if (envelope.sessionId !== sessionId) return;
      dispatch({ type: 'event', event: envelope.event });
    };
    const onReady = (push: ChatSessionReadyPush): void => {
      if (push.sessionId !== sessionId) return;
      setPhase('ready');
      setError(null);
    };
    const onFailed = (push: ChatSessionFailedPush): void => {
      if (push.sessionId !== sessionId) return;
      setPhase('closed');
      setError(push.error);
    };
    const onClosed = (push: ChatSessionClosedPush): void => {
      if (push.sessionId !== sessionId) return;
      setPhase('closed');
    };
    socket.on('chat:event', onEvent);
    socket.on('chat:session.ready', onReady);
    socket.on('chat:session.failed', onFailed);
    socket.on('chat:session.closed', onClosed);
    return () => {
      socket.off('chat:event', onEvent);
      socket.off('chat:session.ready', onReady);
      socket.off('chat:session.failed', onFailed);
      socket.off('chat:session.closed', onClosed);
    };
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversation]);

  async function openChannel(rejoinId?: string): Promise<void> {
    if (agentId === '') return;
    setError(null);
    const ack = await emitWithAck<{ sessionId?: string; error?: string }>('chat:session.open', {
      agentInstanceId: agentId,
      ...(rejoinId !== undefined ? { sessionId: rejoinId } : {}),
    });
    if (ack.error !== undefined || ack.sessionId === undefined) {
      const code = ack.error ?? 'unknown error';
      setError(
        code === 'REMOTE_CHAT_DISABLED'
          ? 'Remote chat is disabled for this machine — enable it on the machine page first.'
          : code === 'MACHINE_OFFLINE'
            ? 'The machine is offline.'
            : code === 'DAEMON_NO_CHAT'
              ? "The machine's daemon does not support chat (upgrade hnx)."
              : code === 'SESSION_LIMIT_REACHED'
                ? 'Too many open chat channels on this machine — close one first.'
                : code,
      );
      return;
    }
    setSessionId(ack.sessionId);
    void refreshSessions();
  }

  async function send(): Promise<void> {
    const text = draft.trim();
    if (text === '' || sessionId === '' || phase !== 'ready' || conversation.turnActive) return;
    setDraft('');
    dispatch({ type: 'user_message', text });
    const ack = await emitWithAck<{ accepted?: boolean; error?: string }>('chat:message.send', {
      sessionId,
      content: text,
    });
    if (ack.error !== undefined) {
      toast.error(ack.error === 'SESSION_BUSY' ? 'A turn is already running' : ack.error);
    }
  }

  async function cancelTurn(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:turn.cancel', { sessionId });
  }

  async function respondPermission(requestId: string, optionId?: string): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:permission.respond', {
      sessionId,
      requestId,
      ...(optionId !== undefined ? { optionId } : {}),
    });
  }

  async function closeChannel(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:session.close', { sessionId, reason: 'user' });
    setPhase('closed');
    void refreshSessions();
  }

  const openSessions = sessions.filter((s) => s.closedAt === null);

  return (
    <AppShell>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-wrap-balance">Chat</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Talk to a deployed agent on one of your machines. Talking drives tool execution on that
          machine — chat is per-machine opt-in.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        {/* Left rail: machine → agent → sessions */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="chat-machine">Machine</Label>
            <Select value={machineId} onValueChange={setMachineId}>
              <SelectTrigger id="chat-machine">
                <SelectValue placeholder="Select machine" />
              </SelectTrigger>
              <SelectContent>
                {machines.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="chat-agent">Agent</Label>
            <Select value={agentId} onValueChange={setAgentId} disabled={agents.length === 0}>
              <SelectTrigger id="chat-agent">
                <SelectValue
                  placeholder={agents.length === 0 ? 'No agents deployed' : 'Select agent'}
                />
              </SelectTrigger>
              <SelectContent>
                {agents.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {machine !== undefined && !machine.remoteChatEnabled ? (
            <p className="text-warn text-xs">
              Remote chat is disabled for {machine.name}. Enable it on the machine page first.
            </p>
          ) : null}
          {machine !== undefined && machine.remoteChatEnabled && !machine.online ? (
            <p className="text-muted-foreground text-xs">{machine.name} is offline.</p>
          ) : null}

          <Button
            onClick={() => void openChannel()}
            disabled={chatBlocked || openSessions.length >= 3}
          >
            <PlusIcon className="size-4" />
            New session
          </Button>

          <div className="flex flex-col gap-1.5">
            {sessions.map((s) => {
              const open = s.closedAt === null;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => (open ? void openChannel(s.id) : undefined)}
                  className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-xs ${
                    s.id === sessionId ? 'border-signal/60' : ''
                  } ${open ? '' : 'opacity-50'}`}
                >
                  <span className="font-mono">{s.id.slice(0, 10)}</span>
                  <span className="text-muted-foreground">
                    {open ? 'open' : (s.closeReason ?? 'closed')}
                  </span>
                </button>
              );
            })}
            {sessions.length === 0 ? (
              <p className="text-muted-foreground text-xs">No sessions yet.</p>
            ) : null}
          </div>
        </div>

        {/* Conversation pane */}
        <Card>
          <CardContent className="flex min-h-[28rem] flex-col">
            {sessionId === '' ? (
              <EmptyPane />
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm">
                    <BotIcon className="size-4" />
                    <span className="font-medium">{agent?.name ?? 'Agent'}</span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {agent?.target}
                    </Badge>
                    {phase === 'connecting' ? (
                      <span className="text-muted-foreground">connecting…</span>
                    ) : null}
                    {phase === 'ready' && conversation.turnActive ? (
                      <span className="text-signal flex items-center gap-1.5">
                        <span className="bg-signal inline-block size-1.5 animate-pulse rounded-full" />
                        working
                      </span>
                    ) : null}
                    {phase === 'closed' ? (
                      <span className="text-muted-foreground">
                        closed{error !== null ? ` — ${error}` : ''}
                      </span>
                    ) : null}
                  </div>
                  {phase !== 'closed' ? (
                    <Button variant="outline" size="sm" onClick={() => void closeChannel()}>
                      Close
                    </Button>
                  ) : null}
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto pr-1">
                  {conversation.blocks.map((b, i) => (
                    <ConversationBlock key={i} role={b.role} text={b.text} />
                  ))}
                  {conversation.tools.map((t) => (
                    <ToolLine key={t.toolCallId} tool={t} />
                  ))}
                  {conversation.permissions
                    .filter((p) => !p.settled)
                    .map((p) => (
                      <PermissionCard
                        key={p.requestId}
                        permission={p}
                        onRespond={(optionId) => void respondPermission(p.requestId, optionId)}
                      />
                    ))}
                  {conversation.stopReason === 'cancelled' ? (
                    <p className="text-muted-foreground text-xs">Turn cancelled.</p>
                  ) : null}
                  <div ref={bottomRef} />
                </div>

                <div className="mt-3 flex items-end gap-2">
                  <Textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={phase === 'ready' ? 'Send a message…' : 'Start a session to chat.'}
                    disabled={phase !== 'ready'}
                    rows={2}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {conversation.turnActive ? (
                    <Button variant="outline" onClick={() => void cancelTurn()}>
                      <CircleStopIcon className="size-4" />
                      Stop
                    </Button>
                  ) : (
                    <Button onClick={() => void send()} disabled={phase !== 'ready'}>
                      <ArrowUpIcon className="size-4" />
                      Send
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}

function EmptyPane() {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 py-16 text-sm">
      <MessageSquareIcon className="size-8" />
      <p>Pick a machine and agent, then open a session.</p>
      <p className="flex items-center gap-1.5 text-xs">
        <LaptopIcon className="size-3.5" /> The machine's daemon spawns the agent locally.
      </p>
    </div>
  );
}

const ROLE_LABEL: Record<'user' | 'agent' | 'thought', string> = {
  user: 'You',
  agent: 'Agent',
  thought: 'Thinking',
};

function ConversationBlock({ role, text }: { role: 'user' | 'agent' | 'thought'; text: string }) {
  if (text === '') return null;
  return (
    <div className={role === 'thought' ? 'text-muted-foreground text-sm italic' : 'text-sm'}>
      <span className="text-muted-foreground mr-2 text-xs uppercase">{ROLE_LABEL[role]}</span>
      <span className={role === 'user' ? 'font-medium' : 'whitespace-pre-wrap'}>{text}</span>
    </div>
  );
}

function ToolLine({ tool }: { tool: ToolRow }) {
  const statusClass =
    tool.status === 'failed'
      ? 'bg-danger'
      : tool.status === 'completed'
        ? 'bg-ok'
        : tool.status === 'in_progress'
          ? 'bg-warn'
          : 'bg-muted-foreground/40';
  return (
    <div className="text-muted-foreground flex items-center gap-2 py-0.5 text-xs">
      <span className={`inline-block size-1.5 rounded-full ${statusClass}`} />
      <span className="font-mono">{tool.kind ?? 'tool'}</span>
      <span className="truncate">{tool.title}</span>
      <span className="ml-auto font-mono text-[10px]">{tool.status}</span>
    </div>
  );
}

function PermissionCard({
  permission,
  onRespond,
}: {
  permission: ConversationState['permissions'][number];
  onRespond: (optionId?: string) => void;
}) {
  return (
    <div className="border-warn/50 bg-warn/5 rounded-md border p-3 text-sm">
      <p className="mb-1 font-medium">
        The agent asks permission
        {permission.toolCall.title !== undefined ? `: ${permission.toolCall.title}` : ''}
      </p>
      <p className="text-muted-foreground mb-2 font-mono text-xs">
        {permission.toolCall.kind ?? 'tool'} · {permission.toolCall.toolCallId}
      </p>
      <div className="flex flex-wrap gap-2">
        {permission.options.map((o) => (
          <Button
            key={o.optionId}
            size="sm"
            variant="outline"
            onClick={() => onRespond(o.optionId)}
          >
            {o.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

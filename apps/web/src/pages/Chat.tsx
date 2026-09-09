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
import { useI18n, type TranslationKey } from '@/i18n';
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
  /** 'user' | 'agent' | 'thought' | 'error' text blocks, in order. */
  blocks: { role: 'user' | 'agent' | 'thought' | 'error'; text: string }[];
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
    case 'raw':
      // The one raw shape the fold cares about: a failed turn (adapter
      // protocol error — e.g. "Authentication required"). Anything else is
      // protocol noise the fold intentionally ignores.
      if (event.method === 'hnx/prompt-error') {
        const message = (event.params as { message?: string } | undefined)?.message;
        if (message !== undefined && message !== '') {
          return { ...state, blocks: [...state.blocks, { role: 'error', text: message }] };
        }
      }
      return state;
    default:
      return state;
  }
}

// ---- page ----

const ROLE_KEY: Record<'user' | 'agent' | 'thought', TranslationKey> = {
  user: 'chat.roleYou',
  agent: 'chat.roleAgent',
  thought: 'chat.roleThinking',
};

export function ChatPage() {
  const { logout } = useAuth();
  const { t } = useI18n();
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
  /** Phase carried by an open ack — consumed by the sessionId effect (its
   *  'connecting' reset would otherwise clobber a same-tick 'ready'). */
  const pendingPhaseRef = useRef<'ready' | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** Session the one-shot connect-retry is armed for. */
  const connectTargetRef = useRef<string | null>(null);

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
    if (sessionId === '') {
      setPhase('idle');
      return;
    }
    setPhase(pendingPhaseRef.current === 'ready' ? 'ready' : 'connecting');
    pendingPhaseRef.current = null;
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
    const ack = await emitWithAck<{
      sessionId?: string;
      phase?: 'starting' | 'ready';
      error?: string;
    }>('chat:session.open', {
      agentInstanceId: agentId,
      ...(rejoinId !== undefined ? { sessionId: rejoinId } : {}),
    });
    if (ack.error !== undefined || ack.sessionId === undefined) {
      const code = ack.error ?? 'unknown error';
      setError(
        code === 'REMOTE_CHAT_DISABLED'
          ? t('chat.errRemoteChatDisabled')
          : code === 'MACHINE_OFFLINE'
            ? t('chat.errMachineOffline')
            : code === 'DAEMON_NO_CHAT'
              ? t('chat.errDaemonNoChat')
              : code === 'SESSION_LIMIT_REACHED'
                ? t('chat.errSessionLimit')
                : code === 'SESSION_NOT_FOUND'
                  ? t('chat.errSessionGone')
                  : code,
      );
      return;
    }
    // A re-join (or an agent that came ready before this ack returned) can
    // settle the pane immediately — the ready push may predate our listeners.
    pendingPhaseRef.current = ack.phase === 'ready' ? 'ready' : null;
    setSessionId(ack.sessionId);
    void refreshSessions();
    if (ack.phase !== 'ready') {
      // One-shot recovery for a ready push lost to the ack/listener race:
      // re-open (idempotent rejoin) settles the phase from its ack.
      const target = ack.sessionId;
      connectTargetRef.current = target;
      window.setTimeout(() => {
        if (phaseRef.current === 'connecting' && connectTargetRef.current === target) {
          connectTargetRef.current = null;
          void openChannel(target);
        }
      }, 12000);
    }
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
      toast.error(ack.error === 'SESSION_BUSY' ? t('chat.turnBusy') : ack.error);
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
        <h1 className="text-2xl font-semibold tracking-tight text-wrap-balance">
          {t('chat.title')}
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('chat.subtitle')}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        {/* Left rail: machine → agent → sessions */}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="chat-machine">{t('chat.machine')}</Label>
            <Select value={machineId} onValueChange={setMachineId}>
              <SelectTrigger id="chat-machine">
                <SelectValue placeholder={t('chat.selectMachine')} />
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
            <Label htmlFor="chat-agent">{t('chat.agent')}</Label>
            <Select value={agentId} onValueChange={setAgentId} disabled={agents.length === 0}>
              <SelectTrigger id="chat-agent">
                <SelectValue
                  placeholder={agents.length === 0 ? t('chat.noAgents') : t('chat.selectAgent')}
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
              {t('chat.remoteChatDisabled', { name: machine.name })}
            </p>
          ) : null}
          {machine !== undefined && machine.remoteChatEnabled && !machine.online ? (
            <p className="text-muted-foreground text-xs">
              {t('chat.machineOffline', { name: machine.name })}
            </p>
          ) : null}

          <Button
            onClick={() => void openChannel()}
            disabled={chatBlocked || openSessions.length >= 3}
          >
            <PlusIcon className="size-4" />
            {t('chat.newSession')}
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
                    {open ? t('chat.sessionOpen') : (s.closeReason ?? t('chat.sessionClosed'))}
                  </span>
                </button>
              );
            })}
            {sessions.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('chat.noSessions')}</p>
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
                    <span className="font-medium">{agent?.name ?? t('chat.agentFallback')}</span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {agent?.target}
                    </Badge>
                    {phase === 'connecting' ? (
                      <span className="text-muted-foreground">{t('chat.connecting')}</span>
                    ) : null}
                    {phase === 'ready' && conversation.turnActive ? (
                      <span className="text-signal flex items-center gap-1.5">
                        <span className="bg-signal inline-block size-1.5 animate-pulse rounded-full" />
                        {t('chat.working')}
                      </span>
                    ) : null}
                    {phase === 'closed' ? (
                      <span className="text-muted-foreground">
                        {error !== null ? t('chat.closedWithError', { error }) : t('chat.closed')}
                      </span>
                    ) : null}
                  </div>
                  {phase !== 'closed' ? (
                    <Button variant="outline" size="sm" onClick={() => void closeChannel()}>
                      {t('common.close')}
                    </Button>
                  ) : null}
                </div>

                <div className="flex-1 space-y-3 overflow-y-auto pr-1">
                  {conversation.blocks.map((b, i) => (
                    <ConversationBlock key={i} role={b.role} text={b.text} />
                  ))}
                  {conversation.tools.map((tool) => (
                    <ToolLine key={tool.toolCallId} tool={tool} />
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
                    <p className="text-muted-foreground text-xs">{t('chat.turnCancelled')}</p>
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
                    placeholder={
                      phase === 'ready' ? t('chat.placeholderReady') : t('chat.placeholderIdle')
                    }
                    disabled={phase !== 'ready'}
                    rows={2}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {conversation.turnActive ? (
                    <Button variant="outline" onClick={() => void cancelTurn()}>
                      <CircleStopIcon className="size-4" />
                      {t('chat.stop')}
                    </Button>
                  ) : (
                    <Button onClick={() => void send()} disabled={phase !== 'ready'}>
                      <ArrowUpIcon className="size-4" />
                      {t('chat.send')}
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
  const { t } = useI18n();
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 py-16 text-sm">
      <MessageSquareIcon className="size-8" />
      <p>{t('chat.emptyTitle')}</p>
      <p className="flex items-center gap-1.5 text-xs">
        <LaptopIcon className="size-3.5" /> {t('chat.emptyHint')}
      </p>
    </div>
  );
}

function ConversationBlock({
  role,
  text,
}: {
  role: 'user' | 'agent' | 'thought' | 'error';
  text: string;
}) {
  const { t } = useI18n();
  if (text === '') return null;
  if (role === 'error') {
    return (
      <div className="text-destructive text-sm">
        <span className="text-muted-foreground mr-2 text-xs uppercase">{t('chat.roleError')}</span>
        <span className="whitespace-pre-wrap">{text}</span>
      </div>
    );
  }
  return (
    <div className={role === 'thought' ? 'text-muted-foreground text-sm italic' : 'text-sm'}>
      <span className="text-muted-foreground mr-2 text-xs uppercase">{t(ROLE_KEY[role])}</span>
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
  const { t } = useI18n();
  return (
    <div className="border-warn/50 bg-warn/5 rounded-md border p-3 text-sm">
      <p className="mb-1 font-medium">
        {permission.toolCall.title !== undefined
          ? t('chat.permissionAskTitle', { title: permission.toolCall.title })
          : t('chat.permissionAsk')}
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

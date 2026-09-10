import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  CircleStopIcon,
  FolderIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { AppShell } from '@/components/app-shell';
import {
  appSocket,
  emitWithAck,
  type ChatEventEnvelope,
  type ChatHistoryEvent,
  type ChatSessionClosedPush,
  type ChatSessionFailedPush,
  type ChatSessionReadyPush,
} from '@/realtime';
import {
  HarnessNexusError,
  type AgentInstanceMachineView,
  type AgentInstanceView,
  type NativeSessionView,
} from '@harness-nexus/sdk';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ChatStream } from '@/components/chat/chat-stream.js';
import { DirPicker } from '@/components/chat/dir-picker.js';
import { createFoldState, fold } from '@/components/chat/fold.js';

/**
 * The Agent session page (Phase 9 W6, rewired 9 W7) — left: the AGENT'S OWN
 * session list (fetched live from the target's native store through the
 * daemon; grouped by workspace cwd; click = RESUME). Right: the portal-style
 * row stream + composer. The platform persists nothing session-shaped:
 * "disconnect" ends the channel only — the conversation stays with the agent.
 * The live-turn indicator is this view's single `--signal` spend.
 */

type Phase = 'idle' | 'connecting' | 'ready' | 'closed';

/** Rail data: the daemon-routed listing or the gate that blocked it. */
type RailState =
  | { state: 'loading' }
  | { state: 'ready'; supported: boolean; sessions: NativeSessionView[] }
  | { state: 'offline' }
  | { state: 'daemon-old' }
  | { state: 'error'; message: string };

interface SessionGroup {
  cwd: string;
  sessions: NativeSessionView[];
  newest: number;
}

function groupSessions(sessions: NativeSessionView[]): SessionGroup[] {
  const map = new Map<string, NativeSessionView[]>();
  for (const s of sessions) {
    const list = map.get(s.cwd);
    if (list === undefined) map.set(s.cwd, [s]);
    else list.push(s);
  }
  const groups: SessionGroup[] = [];
  for (const [cwd, list] of map) {
    list.sort(
      (a, b) =>
        (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0) ||
        b.sessionId.localeCompare(a.sessionId),
    );
    groups.push({ cwd, sessions: list, newest: Date.parse(list[0]!.updatedAt ?? '') || 0 });
  }
  groups.sort((a, b) => b.newest - a.newest);
  return groups;
}

function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const last = trimmed.split('/').pop();
  return last === undefined || last === '' ? cwd : last;
}

function relativeTime(iso: string | null | undefined, locale: string): string {
  if (iso === undefined || iso === null || iso === '') return '';
  const diff = Date.now() - (Date.parse(iso) || 0);
  const minutes = Math.round(diff / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(-hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(-days, 'day');
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}

export function AgentSessionPage() {
  const { agentId = '' } = useParams();
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [agent, setAgent] = useState<AgentInstanceView | null>(null);
  const [machine, setMachine] = useState<AgentInstanceMachineView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rail, setRail] = useState<RailState>({ state: 'loading' });
  const [sessionId, setSessionId] = useState('');
  const [nativeSessionId, setNativeSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [conversation, dispatch] = useReducer(fold, undefined, createFoldState);
  /** Phase carried by an open ack (consumed by the sessionId effect). */
  const pendingPhaseRef = useRef<'ready' | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const connectTargetRef = useRef<string | null>(null);

  useEffect(() => {
    setAgent(null);
    setMachine(null);
    setLoadFailed(false);
    setSessionId('');
    setNativeSessionId(null);
    setPhase('idle');
    void (async () => {
      try {
        const res = await withAuthGuard(() => api.getAgentInstance(agentId), logout);
        setAgent(res.agent);
        setMachine(res.machine);
      } catch {
        setLoadFailed(true);
      }
    })();
  }, [agentId, logout]);

  const refreshSessions = useCallback(async () => {
    if (agentId === '') return;
    try {
      const res = await withAuthGuard(() => api.listAgentSessions(agentId), logout);
      setRail({ state: 'ready', supported: res.supported, sessions: res.sessions });
    } catch (e) {
      const code = e instanceof HarnessNexusError ? e.code : '';
      if (code === 'MACHINE_OFFLINE') setRail({ state: 'offline' });
      else if (code === 'DAEMON_NO_SESSIONS') setRail({ state: 'daemon-old' });
      else setRail({ state: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, [agentId, logout]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Reset the pane whenever the channel changes.
  useEffect(() => {
    dispatch({ type: 'reset' });
    setNativeSessionId(null);
    if (sessionId === '') {
      setPhase('idle');
      return;
    }
    setPhase(pendingPhaseRef.current === 'ready' ? 'ready' : 'connecting');
    pendingPhaseRef.current = null;
  }, [sessionId]);

  // Live channel wiring — the same contract as the C5 page, plus 9 W7 history.
  useEffect(() => {
    if (sessionId === '') return;
    const socket = appSocket();
    const onEvent = (envelope: ChatEventEnvelope): void => {
      if (envelope.sessionId !== sessionId) return;
      dispatch({ type: 'event', event: envelope.event });
    };
    const onHistory = (push: ChatHistoryEvent): void => {
      if (push.sessionId !== sessionId) return;
      dispatch({ type: 'history', items: push.items });
    };
    const onReady = (push: ChatSessionReadyPush): void => {
      if (push.sessionId !== sessionId) return;
      setPhase('ready');
      setError(null);
      if (push.nativeSessionId !== undefined) setNativeSessionId(push.nativeSessionId);
    };
    const onFailed = (push: ChatSessionFailedPush): void => {
      if (push.sessionId !== sessionId) return;
      setPhase('closed');
      setError(push.error);
    };
    const onClosed = (push: ChatSessionClosedPush): void => {
      if (push.sessionId !== sessionId) return;
      setPhase('closed');
      void refreshSessions();
    };
    socket.on('chat:event', onEvent);
    socket.on('chat:history', onHistory);
    socket.on('chat:session.ready', onReady);
    socket.on('chat:session.failed', onFailed);
    socket.on('chat:session.closed', onClosed);
    return () => {
      socket.off('chat:event', onEvent);
      socket.off('chat:history', onHistory);
      socket.off('chat:session.ready', onReady);
      socket.off('chat:session.failed', onFailed);
      socket.off('chat:session.closed', onClosed);
    };
  }, [sessionId, refreshSessions]);

  async function openChannel(
    rejoinId?: string,
    directory?: string,
    resume?: { sessionId: string; cwd: string },
  ): Promise<void> {
    if (agentId === '') return;
    setError(null);
    const ack = await emitWithAck<{
      sessionId?: string;
      phase?: 'starting' | 'ready';
      error?: string;
    }>('chat:session.open', {
      agentInstanceId: agentId,
      ...(rejoinId !== undefined ? { sessionId: rejoinId } : {}),
      ...(directory !== undefined ? { directory } : {}),
      ...(resume !== undefined ? { resume } : {}),
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
                  : code === 'WORKSPACE_NOT_SET'
                    ? t('chat.errWorkspaceNotSet')
                    : code === 'WORKSPACE_INVALID'
                      ? t('chat.errWorkspaceInvalid')
                      : code,
      );
      return;
    }
    pendingPhaseRef.current = ack.phase === 'ready' ? 'ready' : null;
    setSessionId(ack.sessionId);
    if (ack.phase !== 'ready') {
      // One-shot recovery for a ready push lost to the ack/listener race.
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

  /** Channel-only teardown — the native session survives (9 W7). */
  async function disconnectChannel(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:session.close', { sessionId, reason: 'user' });
    setPhase('closed');
    void refreshSessions();
  }

  const groups = useMemo(
    () => (rail.state === 'ready' ? groupSessions(rail.sessions) : []),
    [rail],
  );
  const currentCwd =
    rail.state === 'ready'
      ? (rail.sessions.find((s) => s.sessionId === nativeSessionId)?.cwd ?? undefined)
      : undefined;

  if (loadFailed) {
    return (
      <AppShell>
        <div className="text-muted-foreground flex flex-col items-center gap-3 py-16 text-sm">
          <p>{t('chat.errSessionGone')}</p>
          <Button asChild variant="outline" size="sm">
            <Link to="/chat">{t('chat.backToAgents')}</Link>
          </Button>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell variant="full">
      <div className="flex h-full min-h-0">
        {/* Left rail: new session + the agent's native sessions, grouped by cwd */}
        <aside className="bg-sidebar/40 hidden w-72 shrink-0 flex-col border-r md:flex">
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Button asChild variant="ghost" size="sm" className="gap-1.5 px-2">
              <Link to="/chat">
                <ArrowLeftIcon className="size-3.5" />
                <span className="text-xs">{t('chat.backToAgents')}</span>
              </Link>
            </Button>
            <span className="min-w-0 flex-1" />
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title={t('common.refresh')}
              onClick={() => void refreshSessions()}
            >
              <RefreshCwIcon className="size-3.5" />
            </Button>
          </div>
          <div className="border-b p-3">
            <Button
              className="w-full"
              size="sm"
              onClick={() => setPickerOpen(true)}
              disabled={machine === null || !machine.online || !machine.remoteChatEnabled}
            >
              <PlusIcon className="size-4" />
              {t('chat.newSession')}
            </Button>
            <p className="text-muted-foreground mt-1.5 text-center text-[11px]">
              {t('chat.disconnectHint')}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {rail.state === 'loading' ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">{t('common.loading')}</p>
            ) : rail.state === 'offline' ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">{t('chat.sessionsOffline')}</p>
            ) : rail.state === 'daemon-old' ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">
                {t('chat.sessionsDaemonOld')}
              </p>
            ) : rail.state === 'error' ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">{rail.message}</p>
            ) : !rail.supported ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">
                {t('chat.sessionsUnsupported')}
              </p>
            ) : groups.length === 0 ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">{t('chat.noSessions')}</p>
            ) : (
              groups.map((group) => (
                <div key={group.cwd} className="mb-3">
                  <div
                    className="text-muted-foreground flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium"
                    title={group.cwd}
                  >
                    <FolderIcon className="size-3 shrink-0" />
                    <span className="truncate">{cwdBasename(group.cwd)}</span>
                  </div>
                  {group.sessions.map((s) => {
                    const active = s.sessionId === nativeSessionId;
                    const stale = s.staleReason !== undefined;
                    return (
                      <button
                        key={s.sessionId}
                        type="button"
                        disabled={stale && !active}
                        onClick={() =>
                          active || stale
                            ? undefined
                            : void openChannel(undefined, undefined, {
                                sessionId: s.sessionId,
                                cwd: s.cwd,
                              })
                        }
                        className={cn(
                          'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs',
                          active ? 'bg-accent' : stale ? 'cursor-default' : 'hover:bg-accent/60',
                          stale && !active && 'opacity-50',
                        )}
                        title={stale ? t('chat.staleModel', { model: s.model ?? '?' }) : (s.title ?? s.cwd)}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="truncate">{s.title ?? t('chat.untitled')}</span>
                          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                            {relativeTime(s.updatedAt, dateLocale(lang))}
                          </span>
                        </span>
                        <span className="text-muted-foreground flex items-center gap-1 text-[10px]">
                          {active ? (
                            <>
                              <span className="bg-signal inline-block size-1.5 rounded-full" />
                              {t('chat.working')}
                            </>
                          ) : stale ? (
                            t('chat.staleModel', { model: s.model ?? '?' })
                          ) : (
                            <>
                              <PlayIcon className="size-2.5" />
                              {t('chat.resumeSession')}
                            </>
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* Right: toolbar + stream + composer */}
        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <BotIcon className="text-muted-foreground size-4 shrink-0" />
            <span className="truncate text-sm font-medium">{agent?.name ?? t('chat.title')}</span>
            {agent !== null ? (
              <Badge variant="secondary" className="font-mono text-[10px]">
                {agent.target}
              </Badge>
            ) : null}
            {phase === 'connecting' ? (
              <span className="text-muted-foreground text-xs">{t('chat.connecting')}</span>
            ) : null}
            {phase === 'ready' && conversation.turnActive ? (
              <span className="text-signal flex items-center gap-1.5 text-xs">
                <span className="bg-signal inline-block size-1.5 animate-pulse rounded-full" />
                {t('chat.working')}
              </span>
            ) : null}
            {phase === 'closed' ? (
              <span className="text-muted-foreground truncate text-xs">
                {error !== null ? t('chat.closedWithError', { error }) : t('chat.closed')}
              </span>
            ) : null}
            <span className="min-w-0 flex-1" />
            {phase === 'ready' || phase === 'connecting' ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void disconnectChannel()}
                title={t('chat.disconnectHint')}
              >
                <XIcon className="size-3.5" />
                <span className="hidden sm:inline">{t('chat.disconnect')}</span>
              </Button>
            ) : null}
          </div>

          {error !== null && phase !== 'closed' ? (
            <p className="text-destructive border-destructive/30 bg-destructive/5 border-b px-4 py-2 text-xs">
              {error}
            </p>
          ) : null}

          <ChatStream
            state={conversation}
            cwd={currentCwd}
            onPermissionRespond={(requestId, optionId) =>
              void respondPermission(requestId, optionId)
            }
          />

          <div className="shrink-0 border-t p-3">
            <div className="mx-auto flex w-full max-w-3xl items-end gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder={t('chat.placeholderReady')}
                disabled={phase !== 'ready'}
                rows={2}
                autoComplete="off"
                spellCheck={false}
                className="min-h-0"
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
          </div>
        </section>
      </div>

      {machine !== null ? (
        <DirPicker
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          machineId={machine.id}
          baseWorkspace={machine.baseWorkspace}
          onBaseWorkspaceSaved={(base) =>
            setMachine((prev) => (prev === null ? prev : { ...prev, baseWorkspace: base }))
          }
          onPick={(directory) => void openChannel(undefined, directory)}
        />
      ) : null}
    </AppShell>
  );
}

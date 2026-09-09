import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  CircleStopIcon,
  FolderIcon,
  PlusIcon,
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
  type ChatSessionClosedPush,
  type ChatSessionFailedPush,
  type ChatSessionReadyPush,
} from '@/realtime';
import type {
  AcSessionView,
  AgentInstanceMachineView,
  AgentInstanceView,
} from '@harness-nexus/sdk';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ChatStream } from '@/components/chat/chat-stream.js';
import { DirPicker } from '@/components/chat/dir-picker.js';
import { createFoldState, fold } from '@/components/chat/fold.js';

/**
 * The Agent session page (Phase 9 W6) — left: the session list GROUPED BY
 * WORKSPACE cwd (groups by newest session; sessions by openedAt desc; open
 * rows clickable, closed rows muted — v1 has no transcript replay, and the
 * UI never fakes one). Right: the portal-style row stream + composer. The
 * live-turn indicator is this view's single `--signal` spend. Creating a
 * session requires picking a directory under the machine's base workspace
 * (the DirPicker offers to set the base first when missing).
 */

type Phase = 'idle' | 'connecting' | 'ready' | 'closed';

interface SessionGroup {
  cwd: string;
  sessions: AcSessionView[];
  newest: number;
}

function groupSessions(sessions: AcSessionView[]): SessionGroup[] {
  const map = new Map<string, AcSessionView[]>();
  for (const s of sessions) {
    const key = s.cwd ?? '';
    const list = map.get(key);
    if (list === undefined) map.set(key, [s]);
    else list.push(s);
  }
  const groups: SessionGroup[] = [];
  for (const [cwd, list] of map) {
    list.sort((a, b) => b.openedAt.localeCompare(a.openedAt) || b.id.localeCompare(a.id));
    groups.push({ cwd, sessions: list, newest: Date.parse(list[0]!.openedAt) || 0 });
  }
  groups.sort((a, b) => b.newest - a.newest);
  return groups;
}

function cwdBasename(cwd: string): string {
  if (cwd === '') return '';
  const trimmed = cwd.replace(/\/+$/, '');
  const last = trimmed.split('/').pop();
  return last === undefined || last === '' ? cwd : last;
}

function relativeTime(iso: string, locale: string): string {
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
  const [sessions, setSessions] = useState<AcSessionView[]>([]);
  const [sessionId, setSessionId] = useState('');
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

  // Live channel wiring — the same contract as the C5 page.
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
      void refreshSessions();
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
  }, [sessionId, refreshSessions]);

  async function openChannel(rejoinId?: string, directory?: string): Promise<void> {
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
    void refreshSessions();
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

  async function closeChannel(): Promise<void> {
    if (sessionId === '') return;
    await emitWithAck('chat:session.close', { sessionId, reason: 'user' });
    setPhase('closed');
    void refreshSessions();
  }

  const groups = useMemo(() => groupSessions(sessions), [sessions]);
  const openCount = sessions.filter((s) => s.closedAt === null).length;
  const currentSession = sessions.find((s) => s.id === sessionId);
  const currentCwd = currentSession?.cwd ?? undefined;

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
        {/* Left rail: new session + cwd-grouped session list */}
        <aside className="bg-sidebar/40 hidden w-72 shrink-0 flex-col border-r md:flex">
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <Button asChild variant="ghost" size="sm" className="gap-1.5 px-2">
              <Link to="/chat">
                <ArrowLeftIcon className="size-3.5" />
                <span className="text-xs">{t('chat.backToAgents')}</span>
              </Link>
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
            {machine !== null ? (
              <p className="text-muted-foreground mt-1.5 text-center text-[11px] tabular-nums">
                {t('chat.limitHint', { count: openCount, max: 3 })}
              </p>
            ) : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {groups.length === 0 ? (
              <p className="text-muted-foreground px-2 py-4 text-xs">{t('chat.noSessions')}</p>
            ) : (
              groups.map((group) => (
                <div key={group.cwd} className="mb-3">
                  <div
                    className="text-muted-foreground flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium"
                    title={group.cwd === '' ? undefined : group.cwd}
                  >
                    <FolderIcon className="size-3 shrink-0" />
                    <span className="truncate">
                      {group.cwd === '' ? t('chat.unknownWorkspace') : cwdBasename(group.cwd)}
                    </span>
                  </div>
                  {group.sessions.map((s) => {
                    const open = s.closedAt === null;
                    const active = s.id === sessionId;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => (open && !active ? void openChannel(s.id) : undefined)}
                        className={cn(
                          'flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs',
                          active ? 'bg-accent' : open ? 'hover:bg-accent/60' : 'opacity-50',
                        )}
                        title={s.title ?? s.id}
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="truncate">{s.title ?? t('chat.untitled')}</span>
                          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                            {relativeTime(s.openedAt, dateLocale(lang))}
                          </span>
                        </span>
                        <span className="text-muted-foreground font-mono text-[10px]">
                          {open ? t('chat.sessionOpen') : (s.closeReason ?? t('chat.sessionClosed'))}
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
              <Button variant="outline" size="sm" onClick={() => void closeChannel()}>
                <XIcon className="size-3.5" />
                <span className="hidden sm:inline">{t('chat.closeSession')}</span>
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
            onPermissionRespond={(requestId, optionId) => void respondPermission(requestId, optionId)}
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

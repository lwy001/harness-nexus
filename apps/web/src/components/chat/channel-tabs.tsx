import { CircleXIcon, EraserIcon, Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils.js';
import type { ChatChannelView } from '@/realtime.js';

/**
 * 9 W11 B — the live-channel tab strip. Rendered at the top of both chat
 * pages; hidden entirely when the user has no live channels (the common
 * case costs nothing). Data comes from the `chat:channels` snapshot pushes
 * (see use-chat-channels.ts) — never polled, always current.
 *
 * Tab semantics: click ACTIVATES (same agent → in-page channel switch that
 * keeps the previous channel alive; other agent → route + `?ch=` rejoin);
 * × closes that one channel; the broom closes everything (busy ones defer).
 */

/** Short per-target badge text — the mono protocol string, never localized. */
function targetBadge(target: string): string {
  if (target === 'claude-code') return 'CC';
  if (target === 'deepseek') return 'DSH';
  return target.slice(0, 4).toUpperCase();
}

function tabLabel(channel: ChatChannelView): string {
  return channel.nativeSessionId?.slice(0, 8) ?? channel.sessionId.slice(0, 8);
}

interface ChannelTabsProps {
  channels: ChatChannelView[];
  activeSessionId: string;
  onActivate: (channel: ChatChannelView) => void;
  onClose: (channel: ChatChannelView) => void;
  onCleanup: () => void;
}

export function ChannelTabs({
  channels,
  activeSessionId,
  onActivate,
  onClose,
  onCleanup,
}: ChannelTabsProps) {
  const { t } = useI18n();
  if (channels.length === 0) return null;

  return (
    <div className="bg-sidebar/30 flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {channels.map((ch) => {
          const active = ch.sessionId === activeSessionId;
          return (
            <div
              key={ch.sessionId}
              className={cn(
                'group/tab flex max-w-52 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1',
                active ? 'bg-background shadow-sm' : 'hover:bg-background/60 border-transparent',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5"
                onClick={() => onActivate(ch)}
                title={`${ch.target}${ch.nativeSessionId ? ' · ' + ch.nativeSessionId : ''}`}
              >
                <span className="bg-muted text-muted-foreground rounded px-1 font-mono text-[10px] leading-4">
                  {targetBadge(ch.target)}
                </span>
                {ch.phase === 'starting' ? (
                  <Loader2Icon className="text-muted-foreground size-3 shrink-0 animate-spin" />
                ) : null}
                <span
                  className={cn(
                    'truncate font-mono text-xs',
                    active ? 'text-foreground' : 'text-muted-foreground',
                    ch.deferred && 'opacity-70',
                  )}
                >
                  {tabLabel(ch)}
                </span>
                {ch.busy ? (
                  <span
                    className="size-1.5 shrink-0 animate-pulse rounded-full bg-current opacity-40"
                    aria-hidden
                  />
                ) : null}
                {ch.deferred ? (
                  <span className="text-muted-foreground shrink-0 text-[10px]">
                    {t('chat.tabDeferred')}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => onClose(ch)}
                title={t('chat.tabCloseAria', { id: tabLabel(ch) })}
                aria-label={t('chat.tabCloseAria', { id: tabLabel(ch) })}
              >
                <CircleXIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground h-7 shrink-0 gap-1.5 px-2 text-xs"
        onClick={onCleanup}
        title={t('chat.tabsCleanupTitle')}
      >
        <EraserIcon className="size-3.5" />
        {t('chat.tabsCleanup')}
      </Button>
    </div>
  );
}

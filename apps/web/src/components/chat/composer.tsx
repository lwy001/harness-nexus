import { useEffect, useRef } from 'react';
import { ArrowUpIcon, CircleStopIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The chat Sender (Phase 9 W8) — one card, two rows: an auto-growing textarea
 * over a compact toolbar carrying the context meter and the circular
 * send/stop control, right-aligned. The left toolbar slots stay empty until
 * the follow-up controls (attach, permission-mode chip, model selector) get
 * their wire arms — see docs/design/phase-9-w8-sender.md. Presentational: the
 * page owns the draft and the send/cancel actions. The send control is the
 * page's PRIMARY action (bg-primary); `--signal` stays reserved for the
 * live-turn indicator.
 */

export interface ComposerUsage {
  contextUsed?: number;
  contextSize?: number;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  phase: 'idle' | 'connecting' | 'ready' | 'closed';
  turnActive: boolean;
  usage: ComposerUsage | null;
  onSend: () => void;
  onCancel: () => void;
}

/** 1234 → "1.2k" · 64000 → "64k" · 130000 → "130k" · 1500000 → "1.5M". */
function formatTokens(n: number): string {
  const compact = (div: number): string => {
    const s = (n / div).toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}`;
  };
  if (n >= 1_000_000) return `${compact(1_000_000)}M`;
  if (n >= 1_000) return `${compact(1_000)}k`;
  return String(n);
}

/** Context pressure from the fold's usage slice — hidden when the target's
 *  adapter reports no occupancy (claude-code/codex today; dsh reports live). */
function ContextMeter({ usage }: { usage: ComposerUsage | null }) {
  const { t } = useI18n();
  const used = usage?.contextUsed;
  const size = usage?.contextSize;
  if (used === undefined || size === undefined || size <= 0) return null;
  const pct = Math.min(100, Math.max(0, (used / size) * 100));
  const tone = pct > 95 ? 'danger' : pct > 80 ? 'warn' : 'neutral';
  return (
    <span
      className="flex shrink-0 items-center gap-2"
      title={t('chat.contextUsed', { used: formatTokens(used), size: formatTokens(size) })}
    >
      <span
        className={cn(
          'text-muted-foreground font-mono text-[11px] tabular-nums',
          tone === 'warn' && 'text-warn',
          tone === 'danger' && 'text-danger',
        )}
      >
        {formatTokens(used)} / {formatTokens(size)}
      </span>
      <span className="bg-muted relative h-1 w-16 overflow-hidden rounded-full">
        <span
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300',
            tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

export function Composer({
  value,
  onChange,
  phase,
  turnActive,
  usage,
  onSend,
  onCancel,
}: ComposerProps) {
  const { t } = useI18n();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const disabled = phase !== 'ready';

  // Autogrow: 1 row resting, ~10 rows max, then scroll internally.
  useEffect(() => {
    const el = textRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const placeholder =
    phase === 'connecting'
      ? t('chat.connecting')
      : phase === 'closed'
        ? t('chat.closed')
        : t('chat.placeholderReady');

  return (
    <div
      className={cn(
        'bg-background focus-within:border-ring focus-within:ring-ring/50 rounded-xl border shadow-sm transition-[border-color,box-shadow] focus-within:ring-[3px]',
        disabled && 'opacity-60',
      )}
    >
      <textarea
        ref={textRef}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line; a composing Enter (IME
          // candidate confirm) must never send.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSend();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className="placeholder:text-muted-foreground max-h-56 w-full resize-none overflow-y-auto bg-transparent px-3.5 pb-1 pt-3 text-sm leading-relaxed outline-none disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
        <span className="min-w-0 flex-1" />
        <ContextMeter usage={usage} />
        {turnActive ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="hover:border-destructive/40 hover:text-destructive size-9 shrink-0 rounded-full"
            onClick={onCancel}
            title={t('chat.stopAria')}
            aria-label={t('chat.stopAria')}
          >
            <CircleStopIcon className="size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            className="size-9 shrink-0 rounded-full"
            onClick={onSend}
            disabled={disabled || value.trim() === ''}
            title={t('chat.sendAria')}
            aria-label={t('chat.sendAria')}
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

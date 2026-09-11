import { useEffect, useRef, useState } from 'react';
import { ArrowUpIcon, CircleStopIcon, ImageIcon, PaperclipIcon, PlusIcon } from 'lucide-react';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { DraftAttachment } from './image-attach.js';
import type { ChatConfigSetPayload, SessionConfigOption } from '@/realtime';

/**
 * The chat Sender (Phase 9 W8; controls added 9 W9). One card: the attachment
 * preview row, the auto-growing textarea, and a toolbar carrying — left to
 * right — the "+" menu (image attach / file reference), the data-driven
 * session-config selects (permission mode / model / reasoning effort, each
 * rendered ONLY when the adapter advertised it), and right-aligned the
 * context meter + circular send/stop toggle. Presentational: the page owns
 * the draft, the attachments, and every action. The send control stays the
 * page's PRIMARY action; `--signal` stays reserved for the live-turn dot.
 */

export interface ComposerUsage {
  contextUsed?: number;
  contextSize?: number;
}

/** The fold's config slice — see fold.ts (patch-merged from session_config). */
export interface ComposerConfig {
  currentModeId?: string;
  availableModes?: { id: string; name: string; description?: string }[];
  configOptions?: SessionConfigOption[];
}

/** A pending file reference chip (`resource_link` once sent). */
export interface DraftFileRef {
  name: string;
  uri: string;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  phase: 'idle' | 'connecting' | 'ready' | 'closed';
  turnActive: boolean;
  usage: ComposerUsage | null;
  onSend: () => void;
  onCancel: () => void;
  // ---- 9 W9 ----
  attachments: DraftAttachment[];
  fileRefs: DraftFileRef[];
  onRemoveAttachment: (id: string) => void;
  onRemoveFileRef: (uri: string) => void;
  /** Images picked/pasted/dropped — the page compresses and appends. */
  onPickImages: (files: File[]) => void;
  onOpenFilePicker: () => void;
  /** From the ready push's promptCapabilities — gates the image attach item. */
  imageSupported: boolean;
  config: ComposerConfig;
  onConfigSet: (set: ChatConfigSetPayload) => void;
}

/** Mode ids that WEAKEN the permission gate — confirm before switching. */
const DANGEROUS_MODES = new Set(['bypassPermissions', 'full-access', 'auto']);

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
 *  adapter reports no occupancy. */
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

interface SelectChoice {
  value: string;
  name: string;
  description?: string;
  group?: string;
}

/**
 * One borderless config select (the SessionConfigBar pattern). Values are
 * OPAQUE adapter keys — never parsed; `group` becomes a labeled group
 * (dsh's per-provider model lists).
 */
function ConfigSelect({
  label,
  value,
  choices,
  disabled,
  onPick,
}: {
  label: string;
  value: string | undefined;
  choices: SelectChoice[];
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  if (choices.length === 0) return null;
  const groups = new Map<string, SelectChoice[]>();
  for (const c of choices) {
    const key = c.group ?? '';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [c]);
    else list.push(c);
  }
  return (
    <Select
      value={value === undefined ? undefined : value}
      onValueChange={onPick}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label={label}
        title={
          value === undefined
            ? label
            : (choices.find((c) => c.value === value)?.description ?? label)
        }
        className="text-muted-foreground hover:text-foreground h-7 max-w-40 gap-1 border-none px-1.5 text-xs font-normal shadow-none focus:ring-0 dark:hover:bg-accent/50"
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {[...groups.entries()].map(([group, list]) =>
          group === '' ? (
            list.map((c) => (
              <SelectItem key={c.value} value={c.value} title={c.description}>
                {c.name}
              </SelectItem>
            ))
          ) : (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {list.map((c) => (
                <SelectItem key={c.value} value={c.value} title={c.description}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ),
        )}
      </SelectContent>
    </Select>
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
  attachments,
  fileRefs,
  onRemoveAttachment,
  onRemoveFileRef,
  onPickImages,
  onOpenFilePicker,
  imageSupported,
  config,
  onConfigSet,
}: ComposerProps) {
  const { t } = useI18n();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const disabled = phase !== 'ready';
  const controlsDisabled = disabled || turnActive;
  const canSend =
    !disabled &&
    !turnActive &&
    (value.trim() !== '' || attachments.length > 0 || fileRefs.length > 0);

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

  // ---- the three data-driven selects (render nothing when absent) ----
  const modeFromOptions = config.configOptions?.find((o) => o.category === 'mode');
  const modelOption = config.configOptions?.find((o) => o.category === 'model');
  const effortOption = config.configOptions?.find((o) => o.category === 'thought_level');
  const modeChoices: SelectChoice[] =
    modeFromOptions?.options?.map((o) => ({
      value: o.value,
      name: o.name,
      description: o.description,
    })) ??
    config.availableModes?.map((m) => ({
      value: m.id,
      name: m.name,
      description: m.description,
    })) ??
    [];
  const modeValue = modeFromOptions?.currentValue ?? config.currentModeId;

  const pickMode = (modeId: string): void => {
    if (DANGEROUS_MODES.has(modeId)) {
      const name = modeChoices.find((c) => c.value === modeId)?.name ?? modeId;
      if (!window.confirm(t('chat.modeConfirm', { name }))) return;
    }
    onConfigSet({ kind: 'mode', modeId });
  };

  return (
    <div
      className={cn(
        'bg-background focus-within:border-ring focus-within:ring-ring/50 rounded-xl border shadow-sm transition-[border-color,box-shadow] focus-within:ring-[3px]',
        disabled && 'opacity-60',
        dragOver && 'border-ring',
      )}
      onDragOver={(e) => {
        if (disabled || !imageSupported) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        if (disabled || !imageSupported) return;
        e.preventDefault();
        const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
        if (files.length > 0) onPickImages(files);
      }}
    >
      {/* Hidden input behind the "+" menu's image item. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length > 0) onPickImages(files);
        }}
      />

      {attachments.length > 0 || fileRefs.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
          {fileRefs.map((f) => (
            <span
              key={f.uri}
              className="bg-muted inline-flex max-w-56 items-center gap-1 rounded-md px-2 py-1 font-mono text-xs"
              title={f.uri}
            >
              <PaperclipIcon className="size-3 shrink-0" />
              <span className="truncate">@{f.name}</span>
              <button
                type="button"
                onClick={() => onRemoveFileRef(f.uri)}
                className="text-muted-foreground hover:text-foreground ml-0.5 shrink-0"
                aria-label={t('chat.removeAttachment', { name: f.name })}
              >
                ×
              </button>
            </span>
          ))}
          {attachments.map((a) => (
            <span
              key={a.id}
              className="bg-muted relative inline-flex items-center gap-1 rounded-md p-1"
              title={a.name}
            >
              <img
                src={`data:${a.mimeType};base64,${a.data}`}
                alt={a.name}
                className="size-12 rounded object-cover"
              />
              <button
                type="button"
                onClick={() => onRemoveAttachment(a.id)}
                className="bg-background/90 text-foreground absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border text-[10px] leading-none"
                aria-label={t('chat.removeAttachment', { name: a.name })}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

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
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files).filter((f) =>
            f.type.startsWith('image/'),
          );
          if (files.length > 0 && imageSupported && !disabled) {
            e.preventDefault();
            onPickImages(files);
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        className="placeholder:text-muted-foreground max-h-56 w-full resize-none overflow-y-auto bg-transparent px-3.5 pb-1 pt-3 text-sm leading-relaxed outline-none disabled:cursor-not-allowed"
      />
      <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7 shrink-0"
              disabled={disabled}
              title={t('chat.addMenuAria')}
              aria-label={t('chat.addMenuAria')}
            >
              <PlusIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              disabled={!imageSupported || turnActive}
              title={imageSupported ? undefined : t('chat.imageUnsupported')}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon className="size-4" />
              {t('chat.attachImage')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={turnActive} onClick={onOpenFilePicker}>
              <PaperclipIcon className="size-4" />
              {t('chat.attachFile')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ConfigSelect
          label={t('chat.modeLabel')}
          value={modeValue}
          choices={modeChoices}
          disabled={controlsDisabled}
          onPick={pickMode}
        />
        {modelOption === undefined ? null : (
          <ConfigSelect
            label={t('chat.modelLabel')}
            value={modelOption.currentValue}
            choices={
              modelOption.options?.map((o) => ({
                value: o.value,
                name: o.name,
                description: o.description,
                group: o.group,
              })) ?? []
            }
            disabled={controlsDisabled}
            onPick={(v) => onConfigSet({ kind: 'option', configId: modelOption.id, value: v })}
          />
        )}
        {effortOption === undefined ? null : (
          <ConfigSelect
            label={t('chat.effortLabel')}
            value={effortOption.currentValue}
            choices={
              effortOption.options?.map((o) => ({
                value: o.value,
                name: o.name,
                description: o.description,
              })) ?? []
            }
            disabled={controlsDisabled}
            onPick={(v) => onConfigSet({ kind: 'option', configId: effortOption.id, value: v })}
          />
        )}

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
            disabled={!canSend}
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

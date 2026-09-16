import { OPENCODE_PROVIDER_ID } from '@harness-nexus/shared';
import type { HistoryItem, SessionConfigOption } from '@harness-nexus/shared';

/**
 * 9 W13 — the model-option rewrite. The session-config model selector lists
 * whatever the ADAPTER advertises; under a W3 gateway push everything except
 * the configured default is the agent's own built-in catalog — dead entries.
 * This module narrows the `category === 'model'` select row to the models
 * the platform configured (`chat:session.start` `modelOptions`,
 * `unique([model, ...models])` from the stored RuntimeConfig), at every
 * point adapter options enter OUR wire. The adapters themselves are never
 * touched: values still flow verbatim (`session/set_config_option` accepts
 * raw ids on codex; opencode's registry contains our W12 provider models).
 *
 * claude-code needs no rewrite (the W3 writer's `availableModels` allowlist
 * constrains the wrapper's own option list) and deepseek's native picker
 * already reads the W10 catalog — both fall through as identity.
 * docs/design/phase-9-w13-multi-model.md.
 */

/** What the rewrite needs to know about the channel. */
export interface ModelOptionRewrite {
  target: string;
  /** Configured model set; absent = no stored config (or a pre-W13 server). */
  modelOptions?: readonly string[] | undefined;
}

/**
 * Per-target allowed VALUES for the model-category row. Null = leave the
 * adapter's list untouched (identity targets, or no configured set).
 */
function allowedModelValues(ctx: ModelOptionRewrite): readonly string[] | null {
  if (ctx.modelOptions === undefined || ctx.modelOptions.length === 0) return null;
  switch (ctx.target) {
    case 'codex':
      // codex-acp takes raw model ids on set (no list validation).
      return ctx.modelOptions;
    case 'opencode':
      // opencode validates against its provider registry — our W12 writer's
      // `models` map IS that registry for these ids.
      return ctx.modelOptions.map((id) => `${OPENCODE_PROVIDER_ID}/${id}`);
    default:
      return null;
  }
}

function rewriteModelOption(
  option: SessionConfigOption,
  allowed: readonly string[] | null,
): SessionConfigOption {
  if (allowed === null || option.category !== 'model' || option.options === undefined) {
    return option;
  }
  const kept = option.options.filter((o) => allowed.includes(o.value));
  // Empty intersection = a hand-managed install (or a set the live config no
  // longer describes): the adapter's full list is the honest state.
  if (kept.length === 0) return option;
  // A currentValue outside the filtered list stays selectable verbatim —
  // mirrors the adapters' own out-of-picker semantics (e.g. a resumed
  // session running a model outside our set).
  const current = option.currentValue;
  const options =
    current !== undefined && !kept.some((o) => o.value === current)
      ? [...kept, { value: current, name: current }]
      : kept;
  return { ...option, options };
}

/** Narrow one admitted configOptions array (establishment snapshot or push). */
export function rewriteSessionConfigOptions(
  options: readonly SessionConfigOption[],
  ctx: ModelOptionRewrite,
): SessionConfigOption[] {
  const allowed = allowedModelValues(ctx);
  if (allowed === null) return options.slice();
  return options.map((o) => rewriteModelOption(o, allowed));
}

/**
 * Narrow the `session_config` events inside a captured history batch (the
 * session/load replay path). The establishment response's snapshot is
 * last-wins anyway, but a resync replay should not flash an unfiltered list.
 */
export function rewriteHistoryItems(
  items: readonly HistoryItem[],
  ctx: ModelOptionRewrite,
): HistoryItem[] {
  const allowed = allowedModelValues(ctx);
  if (allowed === null) return items.slice();
  return items.map((item) => {
    if (item.type !== 'event') return item;
    const event = item.event;
    if (event.kind !== 'session_config' || event.configOptions === undefined) return item;
    return {
      ...item,
      event: {
        ...event,
        configOptions: event.configOptions.map((o) => rewriteModelOption(o, allowed)),
      },
    };
  });
}

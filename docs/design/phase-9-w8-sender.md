# Design: Phase 9 W8 — chat Sender (composer) upgrade

> Status: **SHIPPED 2026-09-10** (see §Post-ship notes). Predecessor:
> `docs/design/phase-9-portal-ui.md` §W6 (the session page the
> composer lives in). User intent: 优化 Sender 框,功能样式参考智谱清言
> 风格的 composer(卡片式两行布局:上方多行输入区,下方左侧"+"附件与
> 权限模式 chip,右侧模型选择、推理力度下拉与圆形发送键),配色与风格
> 遵循我们自己的 Signal 体系(不照抄参考图的蓝色系)。
> Reference code index: `~/acp-ref/README.md` (the claude-acp-bridge snapshot
> + adoption notes; the composer screenshot itself is not committed — the
> feature list above is the spec).

## Problem

The current composer (`apps/web/src/pages/AgentSession.tsx`, the
`border-t` strip at the bottom) is a bare `Textarea` + one wide Button —
functionally complete (Enter send / Shift+Enter newline / stop-during-turn)
but visually a control strip, not an input surface. Everything a chat
composer should surface per-turn (context pressure, mode, what happens on
send) is invisible until it goes wrong.

## Target shape (from the reference, re-skinned)

```
┌──────────────────────────────────────────────────────────┐
│ 提出后续修改要求                                        ▒ │  ← textarea, autogrow 1→~10 rows
│                                                          │
├──────────────────────────────────────────────────────────┤
│ (context meter · 12.3k/64k)          (model badge)  (▲) │  ← toolbar row
└──────────────────────────────────────────────────────────┘
```

One CARD, not a strip: the whole composer is a rounded bordered card
floating on the page background with the stream scrolling behind a hard
edge above it. Two rows inside the card: the input row and a compact
toolbar row. The toolbar carries, right-aligned, the context meter and the
send control; left-aligned slots exist for the follow-up controls (below).

## Scope split — what W8 ships vs. what needs wire work first

The reference image has four controls we do NOT have wire for. Splitting
honestly keeps W8 shippable with zero server/daemon changes:

### Ships in W8 (wire-ready today)

1. **Card container** — `rounded-xl border bg-background shadow-sm`,
   focus-within ring in `--ring` (the standard shadcn/radix focus token).
   The strip's `border-t` goes away; the card sits in the same `p-3`
   footer slot, `max-w-3xl mx-auto` kept.
2. **Auto-growing textarea** — 1 row resting, grows with content to ~10
   rows, then scrolls internally (`field-sizing` is not baseline enough —
   use the scrollHeight clamp pattern). Keeps `Enter` send /
   `Shift+Enter` newline, `autoComplete="off"`, `spellCheck={false}`
   (form-hygiene rules).
3. **Circular icon send/stop toggle** — a `size-9` round icon button,
   `rounded-full`. Idle+draft-empty → disabled (muted); idle+draft →
   `bg-primary text-primary-foreground` (the page's single PRIMARY action —
   NOT `--signal`, which stays reserved for the live-turn indicator per
   the Signal system); turn active → swaps to Stop
   (`CircleStop`/`Square` icon, `outline` styling, destructive-on-hover is
   enough — no confirm, same semantics as today's Stop button). Text
   labels go away (title/aria-label keeps them).
4. **Context meter** — reads `conversation.usage` from the fold state
   (`contextUsed`/`contextSize` — dsh reports it live today via
   `used`/`size`; claude-code/codex show nothing yet). Render: tiny
   mono `nums` text `12.3k / 64k` + a 64px `h-1` bar. Bar color is
   NEUTRAL (`bg-muted` → `bg-primary` fill); turns `text-warn`/`--warn`
   fill past 80%, `text-danger`/`--danger` past 95% — state-encoded
   colors only, per Signal. Absent data → the slot renders nothing
   (honesty over decoration).
5. **Phase-aware states** — connecting: card disabled with the existing
   `chat.connecting` hint inline; closed: disabled with
   `chat.closed`; draft preserved across phases (it already survives in
   page state).

### Deferred — each needs a wire/daemon arm first (design stubs here)

| Reference control | Why deferred | What it needs |
|---|---|---|
| **"+" attach (images/files)** | `PromptBlock` is text-only by design (v1); the wire would drop attachments silently | `PromptBlock` image variant end-to-end (shared schema → `chatPromptEventSchema` → daemon → ACP `content` blocks). The new `@agentclientprotocol` wrapper already advertises `promptCapabilities.image: true`, so the adapter side is ready; ours is not. |
| **Permission-mode chip** ("完全访问" 等) | The daemon always establishes sessions in ACP default permission mode; there is no mode arm on the wire | A `mode` field on `chat:session.open` + daemon→wrapper `permissionMode` mapping (`default`/`acceptEdits`/`bypassPermissions`) + a confirm-first chip UI (weakening the gate is a destructive-adjacent action). Natural home: alongside the C6 permission-policy work — the reference's policy-engine shape (see below) fits the same feature. |
| **Model selector** | Model is machine-level today (W3 `RuntimeConfig`), and dsh PINS model per native session — a composer switcher would desync the rail | Per-channel model override on the wire (or a "change model = new session" UX). Interim candidate for W8.5: a read-only mono badge showing the machine's runtime-config model (one GET we already have). |
| **Reasoning-effort selector** | No wire: CC reads `CLAUDE_CODE_EFFORT_LEVEL` env at boot; dsh has per-provider config only | Same arm as the model selector, plus per-harness effort semantics. Lowest priority. |

## Component plan

- New `apps/web/src/components/chat/composer.tsx` exporting `<Composer>` —
  all sub-parts (Toolbar, ContextMeter, SendButton) at MODULE scope (React
  perf rule). Props: `value`/`onChange`, `phase`, `turnActive`, `usage`,
  `onSend`, `onCancel`. The page keeps owning `draft`/`send()`/`cancelTurn()`
  — the composer is presentational.
- Strings: extend `strings/chat.ts` (en/zh side by side). New keys:
  `chat.sendAria`/`chat.stopAria` (icon-only buttons must carry labels),
  `chat.contextUsed` (meter title `Used {used} of {size} tokens`), possibly
  `chat.placeholderBusy`. Wire values stay English-in-both (numbers).
- The old inline Textarea/Button block in `AgentSession.tsx` is REPLACED
  by `<Composer …>`; `chat.send`/`chat.stop` text keys retire with it.

## Plan (implementation order)

1. `composer.tsx` (card + textarea + send/stop + context meter) +
   `AgentSession.tsx` swap; strings en/zh.
2. Visual pass against the Signal checklist: accent spend (primary =
   send, signal = live turn only), mono/nums for the meter, focus ring,
   dark theme, `text-wrap` nothing needed here.
3. Gates: `pnpm --filter @harness-nexus/web run build` (+ typecheck),
   manual checklist — Enter/Shift+Enter, autogrow clamp, stop swap,
   meter states (force values), disabled states, zh/en, dark mode.
   (No web unit-test infra exists; the fold's `usage` shape is already
   exercised by construction.)
4. Docs: this file → SHIPPED + notes; AGENTS.md W8 pointer.

## Reference-code adoption notes (from ~/acp-ref/claude-acp-bridge)

Already shipped from this snapshot (2026-09-10): the C5 default wrapper
switch to `@agentclientprotocol/claude-agent-acp` (thinking streams by
default; branch `fix/cc-acp-wrapper-thinking`). Remaining candidates:

- **`permission/policy-engine.js` — HIGH value, future feature.** Glob
  tool-name rules × `allow_always`/`allow_session`/`reject` + timeout
  auto-deny + optionId-must-be-in-request validation. The natural shape
  for our permission-policy work (C6 or a per-machine setting); pairs with
  the deferred permission-mode chip above.
- **`sandbox-template/patch-acp-agent.js` — candidate.** Push a
  `usage_update` after `session/load` so a resumed session's context meter
  refills. Worth a spike once the composer meter lands (W8 gives the
  surface; today a resume shows no usage until the next turn). Mind its
  own lesson: fetch usage fire-and-forget — a synchronous IPC fetch
  before the first turn stalls the wrapper ~15s per call.
- **`host-rewrite.cjs` + `connect-proxy.cjs` — reference only.** For
  machines in DNS-locked networks (monkey-patched `dns.lookup` for the
  Node side, an HTTP CONNECT proxy for native binaries via
  `HTTPS_PROXY`). Revisit if/when a sandboxed machine target lands.
- **`client/acp-client.js` `stop()` (closeSession before kill) — already
  safe.** The hazard it documents (the wrapper keeps one native claude
  child per session; a bare SIGKILL orphans them) is why our daemon
  SIGTERMs first with a 3s SIGKILL grace — rig leak scans (post-run
  `/proc` sweeps for adapter processes) keep verifying this; keep that
  discipline in every rig chat verification.

## Out of scope

- Any wire/schema/daemon change (the four deferred controls above).
- Mobile layout changes beyond what the card inherits for free.
- Streaming the meter for codex (adapter-side `used`/`size` reporting — a
  wrapper-side question, not ours). The claude-code half of this item
  resolved itself: see §Post-ship notes.

## Post-ship notes (2026-09-10)

- **Landed as designed** in `apps/web/src/components/chat/composer.tsx`
  (module-scope `ContextMeter` sub-component; presentational props
  `value/onChange/phase/turnActive/usage/onSend/onCancel` — the page keeps
  owning the draft and actions). Strings: `chat.sendAria` / `chat.stopAria`
  / `chat.contextUsed` added; `chat.send` / `chat.stop` retired.
- **One small parity fix beyond the plan:** Enter no longer sends while an
  IME composition is active (`e.nativeEvent.isComposing` guard) — the old
  strip had this bug and the zh locale makes it user-visible.
- **Verified E2E on the rig** (web image rebuilt from the tree, real dsh
  session through the live channel): card + 3px focus-within ring, autogrow
  1 row (39px) → 4 lines (107px) → clamps at 224px with internal scroll,
  Enter sends / Shift+Enter breaks, send disabled on empty draft, live
  stop swap during a real turn (outline + 停止生成), meter rendered from
  live usage, en/zh strings, dark mode, zero leaked adapters after
  disconnect.
- **Finding — the claude-code meter is NOT empty after all.** The design
  assumed only dsh reports occupancy; in fact the `@agentclientprotocol`
  claude wrapper (the W7.1-era swap) reports `contextUsed`/`contextSize`
  too — a resumed session showed `9.4k / 262.1k` live. The meter's
  render-nothing-when-absent rule stays (it is what keeps the slot honest
  for codex); no code change needed, the wrapper just feeds it.
- **Deferred items unchanged** (attach, permission-mode chip, model
  selector, effort selector) — the table above still enumerates the wire
  arms each needs.

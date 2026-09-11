# Design: Phase 9 W9 — Sender controls (session config + attachments)

> Status: **SHIPPED 2026-09-11** (see §Post-ship notes). Ground truth:
> `docs/research/phase-9-w9-composer-controls.md` (adapter matrix verified
> against claude wrapper 0.76.0 / codex-acp 0.16.0 / dsh-acp 0.1.2-rc.1).
> Predecessor: `docs/design/phase-9-w8-sender.md` §"Deferred" — this wave
> builds the four wire arms that table enumerated.

## Problem

The W8 composer card is presentational only: no permission-mode chip, no
model / reasoning-effort selectors, no attachments. All four controls exist as
STANDARD ACP surface (session modes & configuration; prompt content blocks)
that every shipped adapter already implements — our wire drops them on the
floor (establishment responses only read `sessionId`; `current_mode_update` /
`config_option_update` fall to `raw` and render nothing; `promptBlockSchema`
has no `image` variant; the UI has no attach affordance).

## Scope

1. **A — session-config selectors** (mode / model / reasoning effort) on the
   composer toolbar, data-driven from the adapter's advertised options.
2. **B — image attachments** (`+` menu, paste, drag-drop; client-side
   downscale; thumbnails in the stream).
3. **C — file references** (`+` menu / trailing `@` → workspace file picker →
   `resource_link` prompt blocks, rendered as chips).

Out of scope: audio attachments, embedded-resource upload, `@` caret-aware
mention popover (only the trailing-`@` trigger ships), machine-level
permission-mode policy (C6), the claude wrapper's `providers/*` client-managed
LLM routing, effort auto-max (portal-specific behavior — NOT copied).

## A. Session-config wire

### Shared schemas (`packages/shared/src/realtime.ts`)

```
SessionConfigState rides THREE surfaces — all additive:

1. stream event (daemon → server → browser, and inside history items):
   { kind: 'session_config',
     modes?:   { currentModeId?: string, availableModes?: [{id,name,description?}] },
     configOptions?: [{ id, name, description?, category?, currentValue?,
                        options?: [{ value, name, description?, group? }] }] }
   PATCH semantics: `availableModes` / `configOptions` replace when present,
   `currentModeId` alone patches the current mode. The daemon always emits a
   FULL merged snapshot; `mapAcpUpdate` (the load-replay capture path, which
   has no session state to merge into) emits the adapter's patch verbatim.

2. browser → server → daemon request:
   chat:config.set = { sessionId, kind: 'mode', modeId }
                        | { sessionId, kind: 'option', configId, value }
   (`value` may be '' — dsh's provider-default reasoning value.)

3. chat:session.ready += promptCapabilities?: { image, audio?, embeddedContext? }
   (from the initialize result's agentCapabilities — the B gating signal).
```

Option `value`s are OPAQUE keys (dsh model values are `JSON.stringify([
provider, model])`) — the UI compares by equality, never parses. Only
`type:'select'` options are surfaced; the daemon filters other kinds
(boolean options from future adapters) at mapping time.

Caps: ≤32 modes, ≤256 option values, ≤64 options, strings ≤2k.

### Daemon (`packages/cli/src/daemon/chat.ts`)

- `DaemonSession.config: { modes?: …; options: SessionConfigOption[] }`.
- Establishment: read `modes` / `configOptions` off the `session/new` /
  `session/load` / `session/resume` RESPONSE (load: AFTER the capture window,
  so the replayed patches settle before the authoritative snapshot) → store →
  `emitConfig` (full snapshot; enters the history ring → resync restores the
  selectors for free).
- `wireSession`: intercept `current_mode_update` / `config_option_update`
  before the ordinary mapping → merge into `session.config` → `emitConfig`.
- `mapAcpUpdate` (exported; the capture path): map the same two updates to
  PATCH events verbatim (`config_option_update` carries a full option list;
  `current_mode_update` only `currentModeId`).
- `chat:config.set` handler: forward `session/set_mode` /
  `session/set_config_option` with the ACP session id; on success apply the
  requested value into `session.config` and `emitConfig` (daemon-side
  optimistic update — codex does not reliably push after set; adapter pushes
  then confirm/correct); on RPC error ack the message. NOT busy-gated: dsh
  pins the selection per turn (a mid-turn set applies to the next turn) and
  the UI disables selectors while a turn runs anyway.
- `AcpAgentConnection.start` also derives `promptCaps: { image: boolean }`
  from `agentCapabilities.promptCapabilities` → rides the ready push.

### Server (`packages/server/src`)

- `ChatService.onConfigSet(ownerId, sessionId, …)` — owner check + phase
  ready (no busy gate) → forward over /ctl. `/app` handler validates the
  shared schema (same envelope-identity binding as the other chat handlers).
- `chat:session.ready` relay passes `promptCapabilities` through; the new
  stream event kind needs no special handling in `onStream`.

### Web

- `fold.ts`: `FoldState.config` (patch-merged in `applyEvent`); user rows
  switch from `{text}` to `{blocks: UserBlock[]}` (B/C need it — see below).
- Composer toolbar-left, data-driven (render NOTHING when the category is
  absent — dsh has no mode selector; effort appears per model):
  - mode ← configOptions `category:'mode'` (fallback `modes.availableModes`),
  - model ← `category:'model'` (grouped options via `group`),
  - effort ← `category:'thought_level'`.
  Selects disabled while `turnActive` or not ready. Mode values are wire
  enums (English, per the i18n exception); labels come from the adapter.
- Dangerous modes (id ∈ {bypassPermissions, full-access, auto}) confirm via
  `window.confirm` first — same pattern as MachineDetail's actions.
- Switch errors surface as toasts; state settles only through
  `session_config` events (single source of truth — no browser-side optimism).

### W3 interplay

Machine-level `RuntimeConfig` stays the DEFAULT (settings writers); a
session-level switch overrides for that channel's subsequent turns only. A
NEW session starts from the machine default again; a resumed session's
`currentValue` reflects its pinned model (W7 stale-model annotation logic
unchanged — it reads the transcript, not live config).

## B. Image attachments

- `promptBlockSchema` += `{ type:'image', data: base64 ≤6MB, mimeType:
  png|jpeg|webp|gif }`; send-path schemas refine ≤4 images and ≤6MB total
  per turn (the socket buffer is 8MB — headroom for the envelope).
- Client-side downscale BEFORE send (canvas, long edge ≤1568px, JPEG 0.85 —
  animated GIFs pass through untouched if ≤2MB, else rejected). The wire
  therefore usually carries hundreds of KB, the caps are the backstop.
- Sources: `+` menu → file input (four accept types, multiple), clipboard
  paste on the textarea, drag-drop onto the composer card.
- Gating: the attach control enables only when `promptCapabilities.image`
  (from ready) is true — dsh advertises it dynamically per model route.
- Fold user row renders image blocks as thumbnails (click → lightbox
  Dialog); the daemon's `hnx/prompt-error` raw event already surfaces dsh's
  image-admission rejections as a system note.
- History: user items keep blocks verbatim (live echo → ring → resync
  replays thumbnails). Adapter-replayed history (load/transcript) is
  text-only by construction — placeholder-free, images simply never appear
  there.

## C. File references

- The `resource_link` prompt block already flows verbatim end-to-end
  (schema + daemon passthrough) — this is UI only, plus a file listing:
- `workspace:list` grows a `files` array (`{name, path}`, hidden skipped,
  capped, sorted) next to `directories`; the REST route returns it; old
  daemons simply omit it. DirPicker ignores it.
- Picker: `+` menu → "reference file" opens a lazy file tree dialog (same
  listing call as DirPicker; dirs expand, files select) — ALSO triggered by
  typing a trailing `@` in the textarea (on pick, the trailing `@` is
  stripped from the draft). Picking inserts a `fileRef` chip
  (`{type:'resource_link', name: basename, uri:'file://'+abs}`).
- User rows render `resource_link` blocks as a mono `@name` chip. Honest
  expectation-setting: claude/codex turn the link into agent-readable text;
  dsh treats it as a plain marker (the agent must be asked to read it).

## Plan (implementation order)

1. shared: schemas + types + tests (session-config surfaces, image block,
   workspace files) → build.
2. cli: agent-connection caps; daemon capture/merge/emit/set; workspace
   files; fixture arms (`FIXTURE_SESSION_CONFIG=1`, `FIXTURE_IMAGE_CAPS=1`,
   `session/set_mode` / `session/set_config_option` arms); tests.
3. server: `onConfigSet` + `/app` handler + ready passthrough + workspace
   route files arm; tests.
4. sdk-ts: mirror `files` on the workspace listing type.
5. web: fold (config + user blocks) → stream rows (image/link chips) →
   composer (+ menu, three selects, attachments row) → page wiring
   (send blocks, config.set, ready caps) → FilePicker; strings en/zh.
6. Gates: `pnpm -r build` + `typecheck` + `test`, `task verify` (Node 20),
   web build; rig E2E against the real claude adapter.
7. Docs: this file → SHIPPED; AGENTS.md section; roadmap/README.

## Testing matrix

- shared: schema accept/reject (patch event, config.set union incl. empty
  value, image caps, file listing).
- cli: ready carries caps; establishment snapshot event; push patches;
  `chat:config.set` → ACP request → optimistic snapshot; workspace files
  listing; fixture image-block echo.
- server: config.set owner gating + forward; session_config relay; ready
  passthrough.
- web: build gate + rig E2E (selectors render from real wrapper data, mode
  switch round-trip, image paste → thumbnail → echo, file ref chip).

## Post-ship notes (2026-09-11)

- **Landed as designed** — all three wires (A config selectors, B image
  attach, C file references), daemon `0.12.0-p9w9` (workspace `files` arm +
  session-config capture/merge + `chat:config.set`), schema arms per §A/B/C.
- **Rig E2E against the REAL claude wrapper 0.76.0** (agent-browser through
  the live web image): the three selectors render from the adapter's own
  data (`Manual` / `deepseek-v4-flash` custom model row / `Default`), mode
  Manual→**Auto** round-trips (confirm accepted, snapshot re-emitted), model
  →**Sonnet 5**, effort →**High**; a canvas-synthesized PNG rides the drop
  handler → compression → chip → user-row thumbnail → the model ANSWERS
  ABOUT THE IMAGE CONTENT ("青绿色背景上白色粗体 W9 attach test") — vision
  verified end-to-end; a trailing `@` opens the picker, `NOTES.md` becomes a
  chip, and the agent's own **Read tool** returns the file's content. Resume
  re-renders the selectors from the load response; replayed history shows
  the image turn as the adapter's text-only `[image]` placeholder (by
  design). One honest upstream finding: resuming an image-bearing session
  under a TEXT-ONLY gateway model fails on the API side (400 "Model only
  support text input") — surfaced as a system note via `hnx/prompt-error`;
  switching the channel's model to a vision model heals it.
- **E2E incidental**: first rig pass "showed no selectors" because the
  machine's dsh agent was entered — dsh advertised no configOptions on that
  channel (data-driven hiding works as designed); the claude agent showed
  everything.
- **Rig hygiene**: `pnpm deploy` now produces the machine overlay (the old
  hand-copied dist lost `node_modules` — `pnpm --filter @harness-nexus/cli
  deploy --prod` + strip the one absolute self-symlink
  `node_modules/.pnpm/node_modules/@harness-nexus/cli` before `docker cp`).
  Daemon restart reaps channels; post-run adapter scan: zero processes.

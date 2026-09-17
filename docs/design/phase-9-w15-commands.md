# Phase 9 W15 — Slash commands in the composer

> Status: SHIPPED 2026-09-17 (branch `feat/p9-w15-commands`, daemon
> `0.20.0-p9w15`). Ground truth:
> [`docs/research/phase-9-w14-w15-plan-commands.md`](../research/phase-9-w14-w15-plan-commands.md)
> (adapter-source-verified) + the rig captures noted inside.

## 1. Problem

The ACP `available_commands_update` push carries the agent's slash-command
catalog — claude-code (after new/load/resume; custom + MCP commands renamed
`mcp:<name>`), codex-acp (`review` / `review-branch` / `review-commit` /
`init` / `compact` / `logout`, with `input.hint` on the review family), and
opencode (its `Command.Info` list — which includes platform-deployed
`command/*.md` custom commands). dsh/hermes never push one. Today the daemon
maps it to `raw` and the web drops it: the portal user has no way to
discover or invoke the agent's commands.

Invocation needs NO new protocol: a command runs as an ordinary
`session/prompt` whose text is `/name rest-of-line` (verified for all three
adapters in the research doc — claude's CLI parses slash text, codex's
thread handles it, opencode's `detectSlashCommand` matches the pushed names
and routes to its internal `session.command`).

## 2. Surface

### 2.1 Wire (`packages/shared/src/realtime.ts`)

Additive stream kind (bounded view of the adapter push):

```ts
export const availableCommandViewSchema = z.object({
  name: z.string().min(1).max(128),        // VERBATIM adapter name (may be 'mcp:foo')
  description: z.string().max(512),        // clamped daemon-side
  hint: z.string().max(256).optional(),    // from input.hint (args placeholder)
});
// chatStreamEventSchema +=
z.object({ kind: z.literal('commands'), commands: z.array(availableCommandViewSchema).max(64) })
```

Replace semantics (the push always carries the full catalog). Riding the
ordinary stream gives it the history ring + resync replay for free; the
claude wrapper pushes AFTER `session/load` replay (deliberately), so a
rejoined channel re-receives it live.

### 2.2 Daemon (`packages/cli/src/daemon/chat.ts`)

One new arm in `mapAcpUpdate`: `case 'available_commands_update'` →
`takeAvailableCommands(update.availableCommands)` (≤64 rows, name ≤128,
description clamped 512, `input.hint` clamped 256, malformed rows skipped)
→ `{kind:'commands', commands}`. Stateless, like `plan`. `DAEMON_VERSION` →
`0.20.0-p9w15`.

### 2.3 Web

- `fold.ts`: `FoldState.commands: CommandView[]` (starts `[]`; replace on
  event; history rebuild converges).
- **Composer `/`-palette** (portal-reference behavior, Signal-styled):
  - Opens while the draft starts with `/`, commands exist, the channel is
    ready and no turn is running. The FIRST word after `/` filters (name OR
    description substring); the palette stays open while typing args.
  - Rows: `/{name}` (mono) + description + the args `hint` (muted).
  - Keyboard: `↑`/`↓` cycle (wrapping), `Esc` closes, bare `Enter` SELECTS
    the active row and fills `/name ` (focus stays; the user reviews then
    sends), `Enter` with a space after the first word sends as a normal
    prompt. Click selects. `isComposing` guards IME as everywhere else.
  - Positioned as a popover ABOVE the composer card (absolute; the card must
    not clip it), width matching the card, capped height with scroll,
    `role="listbox"` + `aria-activedescendant`.
- **No fallback table.** An agent that never pushed commands shows no
    palette (dsh, hermes) — same data-driven honesty as the W9 selectors.
  The portal reference ships a hardcoded fallback list; we deliberately
    don't.
- The empty-filter state shows a muted "no matching commands" row (palette
  stays open so the user sees why).

### 2.4 Out of scope

- Structured command input (`input.hint` is display-only — ACP 1.4 has only
  the unstructured kind), command history/autocomplete beyond the filter,
  server-side command storage (the catalog is per-channel session state).

## 3. Tests

- shared: schema cases (accept, bad kind, cap).
- cli: `mapAcpUpdate` cases (verbatim names incl. `mcp:`, hint extraction,
  clamp, malformed drop, empty catalog passes as cleared) + fixture round
  trip — the fixture gains a `FIXTURE_COMMANDS=1` arm pushing a small
  catalog after `session/new` (one command with a hint, one without).
- web: fold arm mirrors `plan`'s state-only merge (no component harness);
  palette interaction verified on the rig.

## 4. Rig results (2026-09-17, daemon `0.20.0-p9w15`)

- codex: catalog arrives on open (`review` with hint, `review-branch`,
  `review-commit`, `init`, `compact`, `logout`); palette opens on `/`,
  filters, selects, and a `/init`-style bare command turn executes
  end-to-end (browser-verified).
- claude-code: catalog incl. `deep-research`; the `mcp:` rename path rides
  verbatim names.
- opencode: catalog from its `Command.Info` list (platform-deployed custom
  commands surface here).
- dsh: no catalog — typing `/` shows nothing (honest absence).

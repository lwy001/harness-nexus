# Research: Phase 9 — portal session-page distillation (chat UI reference)

> Status: **reference studied** (2026-09). Source: the SAME local copy as the
> C5 note (`~/acp-ref/`, `docs/research/phase-8-c5-acp-web-demo.md`) — this
> note covers the OTHER half: `portal/`'s **session-page presentation**
> (session list, message stream, content rendering), which W6 ports onto the
> Signal design system. Parent design: `docs/design/phase-9-portal-ui.md`.

## What the reference does (verified in source)

### 1. Layout & navigation — Channel > cwd-group > session

`portal/src/App.tsx`:

- Left rail (280px): a two-level inline menu. Top level = channels (agents);
  the selected channel expands its **session list grouped by `cwd`** — the
  grouping the W6 requirements ask for **exists in the reference**:
  `App.tsx:335-378` builds a `cwdMap: Map<cwd, AgentSessionInfo[]>`, sessions
  within a group sorted by session time desc, groups sorted by their newest
  session. A group header renders `cwdBasename(cwd)` (last path segment) with
  the full cwd in a tooltip; a session row renders `title || sessionId.slice(0,16)`
  plus a `dayjs.fromNow()` relative time.
- Right pane states: no session → welcome page (hero + "新建会话" + 5 most
  recent sessions); active session → toolbar (channel/session tags, back /
  new / fork / delete / clear buttons) + message stream + composer.
- **New session = pick a directory first.** `DirPickerModal`
  (`components/DirPickerModal.tsx`): a lazy-loaded directory tree rooted at
  `workspaceRoot` (fetched from `/api/config`), directories only; the confirm
  button resolves the selection (creating the dir if missing) and calls
  `session/new` with that cwd. This is exactly our "base workspace +
  subdirectories only" requirement — minus that their workspace root is the
  Portal server's own fs, while ours must be listed **through the daemon on
  the user's machine**.

### 2. Message stream — a row sequence, not a bubble list

`portal/src/model/types.ts` + `model/fold.ts` (pure reducer, O(1) hot path):

```
ConversationRow =
  | user        { text }
  | assistant   { step: AssistantStep }        // one segment of model output
  | tool        { root: ToolCallNode }         // one tool call, lifecycle
  | system      { text, tone }
  | turn-tail   { stats }
```

Formation rules (the load-bearing part):

1. `turn_begin` pushes an empty **running** assistant step ("思考中…" placeholder until the first chunk).
2. Text/thought chunks append to the current step's last same-type block (`appendBlock` concat).
3. `tool_start` pushes an **independent tool row** after the current step AND immediately settles that step — a later text chunk then opens a NEW step. This is what preserves order-feel (text → tool → text reads as three rows).
4. `turn_settled` sweeps ALL running steps/tools (cancelled/error → the current step gets `interrupted`, others `settled`; still-running tools converge to `completed`), appends a `turn-tail` stats row, and is idempotent (a tail already at the end ⇒ no-op).
5. Orphan `tool_update` for an unknown callId is silently ignored (protocol guarantees `tool_call` first).

`AssistantStep.status: running | settled | interrupted`; only the last block of a RUNNING step renders in streaming mode (cursor / follow-tail).

### 3. Rendering per row (`components/stream/*`)

- **user**: right-aligned bubble (max-width ~82%, pre-wrap).
- **assistant**: document-flow (no bubble). `text` → markdown with streaming
  cursor on the last live block; `reasoning` → **ReasoningRow**: a 24px-high
  disclosure row ("思考" + one-line summary). While running the summary shows
  the LAST line and horizontally follows the stream; when settled it shows the
  FIRST line; expanding reveals the full grey text. Empty+running ⇒ synthesized
  "思考中…" placeholder. `interrupted` ⇒ a quiet "已停止" inline tag.
- **tool**: **ToolCallTree** — a disclosure card resolved through a three-tier
  registry: exact `toolName` (Read/Bash/Edit/Write/Grep/Glob/WebSearch/
  WebFetch/Task/Agent/TodoWrite…) → ACP `kind` (read/edit/execute/search/
  fetch) → `GenericToolCard` fallback, each wrapped in an error boundary
  ("never crash" discipline). Collapsed row: `[icon] ToolName · summary`
  (file tools show the cwd-relative path, Bash shows description-or-command);
  failed ⇒ red StateDot + error-first-line in error color. Expanded body =
  the Block family:
  - `ReadBlock` — banner (relative path · "显示 N / M 行" · lang tag · copy) + line-numbered syntax-highlighted window, head/tail capped (8 lines) with "… 其余 N 行" in-place expand.
  - `DiffBlock` — per-file path header + `-`/`+` lines in pure text colors (no row backgrounds), `white-space: pre`, `└ +A -R · N files` footer, head/tail cap + copy.
  - `TerminalBlock` — status dot + `[cwd-basename] $ command` banner (+ exit-code pill), `pre` output capped ~224px with follow-tail while running.
  - `SearchBlock` — grep matches grouped by file (collapsible headers, `lineNo: line`) or a flat path list; counts + copy.
  - `IoCard` — IN/OUT slot-label card for everything else (Task prompt / generic rawInput JSON + rawOutput).
  - `TodoCard` — TodoWrite rendered as a live checklist (non-collapsible).
- **system**: one-line note, tone-colored.
- **turn-tail**: one muted small line — duration · `↑in ↓out tokens` · "已取消" — nothing when empty.

### 4. Scroll policy (`ChatStream.tsx`)

Stick-to-bottom only when the user is already at the bottom (80px threshold);
a programmatic-scroll flag suppresses the "left bottom" misjudgment between
scroll frames; a `ResizeObserver` on the content keeps following late height
growth (images, lazy diagrams, highlight); session load (empty→non-empty)
jumps to bottom + one 400ms catch-up tick; a floating "回到底部" button
appears when scrolled up.

### 5. Composer (`ChatInput.tsx`)

Enter sends / Shift+Enter newline; send vs stop button swaps on busy;
`/` slash-command palette and `@` file mentions (via a fs-browsing popover)
— both depend on capabilities the reference's Portal/agent expose but our
v1 wire does not (see "deferred").

## What W6 adopts vs adapts

| Reference                                             | W6 decision                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| antd Menu + inline styles + dsh tokens                | **Signal system**: tailwind classes, `bg-background`/`text-muted-foreground` etc., IBM Plex Mono for paths/IDs      |
| `@ant-design/x-markdown` + react-syntax-highlighter   | `react-markdown` + `remark-gfm` + `rehype-highlight` (highlight.js) — one markdown stack, self-hosted, no CDN        |
| MermaidBlock, IdePanel, terminal, @-mentions, slash   | **deferred** (out of scope; our adapters don't surface `available_commands`, and IDE/terminal are separate channels) |
| Session list from agent-side `session/list` (resumable) | Our `AcSession` audit rows (cwd/title/openedAt) — **no resume in v1**: closed rows render greyed; open rows clickable |
| DirPicker over Portal-local fs                        | DirPicker over **daemon-routed** `workspace:list` (subdirectories of the machine's `baseWorkspace`)                 |
| fold fed by raw ACP                                   | fold fed by our **semantic** `chat:event` stream (same row model; permissions stay a separate inline slice)         |
| `toolName` from `_meta.claudeCode.toolName`           | Same extraction, daemon-side, extended into `acpToolCallView` (toolName/rawInput/content/output)                    |

## Numbers worth keeping

- Row chrome: 24px-high disclosure rows, 16px icon slot, 14px title, summary
  tertiary + ellipsis; 16px vertical rhythm between rows.
- Head/tail cap: 8 lines (Read/Diff/Search); Terminal caps by height.
- Content column max width ~748px; user bubble max-width min(525px, 82%).
- Copy buttons settle to "已复制" for 1s (`useCopyFeedback`).
- Shimmer sweep 300px/2.6s for running rows (we use a subtler pulse — Signal).

## Out of scope of this note

- The protocol/bridge half (C5 note covers it) and dsh-specific plugin
  mechanics (T1 note).
- Running the demo here (source-reading only, same as C5).

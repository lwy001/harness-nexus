# Design: Phase 9 W5+W6 — modal containers & the portal-style chat UI

> Status: **SHIPPED 2026-09** (W5: `feat/9w5-modal-containers`, W6: `feat/9w6-portal-chat`).
> Post-ship notes in §"What landed".
> Two user asks, one doc: (W5) a reusable **modal container** so list pages stop
> inlining create forms; (W6) the chat surface rebuilt as **Agent cards → session
> page** (left: sessions grouped by workspace; right: portal-style row-sequence
> stream), with machine **base workspace** + daemon-routed directory picking.
> References: `docs/research/phase-9-portal-chat-ui.md` (portal distillation),
> `docs/design/phase-8-c5.md` (chat transport — unchanged), Signal system
> (`AGENTS.md` § Web UI design system).

## W5 — modal container mechanism

### Problem

Five pages render their create form as an always-mounted Card below the list
(Profiles, Credentials, McpManagement, Machines enroll, Users). Every new
entity makes the page longer and the list harder to scan; one page
(McpManagement's ImportJsonDialog) hand-rolls raw radix primitives instead of
the shared wrapper.

### Mechanism

One new primitive, `apps/web/src/components/ui/form-dialog.tsx`:

- Built on the existing `ui/dialog.tsx` wrapper (portal, overlay, focus,
  ESC/close button). Props: `open`, `onClose`, `title`, `description?`,
  `size: 'sm' | 'md' | 'lg' | 'xl'` (max-w-sm/md/lg/4xl … 2xl for the skill
  bundle editor), `children`, `footer?`.
- `<FormDialogHeader>` title/description styling fixed here so every create
  dialog looks identical. Forms inside stay controlled by their page (the
  `editing: T | 'new' | null` conditional-render pattern from Resources.tsx is
  the reference; W5 just gives it a shared shell).

### Page conversions (behavior-preserving, create-only stays create-only)

| Page              | Change                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Resources.tsx     | `ResourceEditor` re-shelled onto `FormDialog` (no logic change; skill editor = `xl`)                                |
| Profiles.tsx      | `CreateProfile` Card → dialog; page header gains a "新建" button (`editing`-style state)                            |
| Credentials.tsx   | `CreateCredential` Card → dialog + header button                                                                    |
| McpManagement.tsx | `CreateMcpServer` Card → dialog + header button; `ImportJsonDialog` rebuilt on FormDialog, raw radix import deleted |
| Machines.tsx      | `EnrollCard` Card → dialog + header button ("注册机器")                                                             |
| Users.tsx         | inline create form → dialog + header button                                                                         |

No route, SDK, or API changes in W5. All copy via the page's i18n string file
(en/zh side by side). MachineDetail is untouched (its forms are contextual
sub-cards of a detail page, not list-page create flows).

## W6 — portal chat

### Goals (from the user's asks)

1. `/chat` shows **Agent cards** (one per AgentInstance — detected + deployed);
   clicking enters that Agent's session page.
2. Session page: left **session list grouped by workspace (cwd)**, right
   **portal-style message stream** (row sequence: user bubble / assistant
   markdown / collapsible reasoning / rich tool cards / turn tail).
3. New sessions **require picking a directory on the machine** — the machine
   declares a `baseWorkspace`; the picker lists only its subdirectories,
   routed through the daemon.
4. Presentation follows the portal reference
   (`docs/research/phase-9-portal-chat-ui.md`) **in Signal clothing**.

### Data model (migration `0013`)

- `machines.base_workspace TEXT NULL` → `Machine.baseWorkspace: string | null`.
  Set via `PATCH /api/machines/:id` (owner-or-admin, like today's fields;
  absolute path, 1..1024). Unset ⇒ the chat picker prompts to set it first.
- `ac_sessions.cwd TEXT NULL` → `AcSession.cwd` — the session's working
  directory (chosen at open; null only for pre-W6 rows). Drives grouping.
- `ac_sessions.title TEXT NULL` → `AcSession.title` — derived once from the
  FIRST prompt (first text block's first line, whitespace-collapsed, ≤80
  chars); never overwritten. Sessions with no prompt stay untitled.

### API surface

- `PATCH /api/machines/:id` — accepts `baseWorkspace: string | null`
  (`updateMachineSchema` gains the field; the refine widens).
- `GET /api/machines/:id/workspace?path=<abs>` (new, `modules/workspace.ts`) —
  one level of **subdirectories only** under `baseWorkspace`:
  `{ path, directories: [{ name, path }] }` (≤512, name-sorted, hidden
  `.*` entries skipped, symlinks not followed in v1). Gates, in order:
  owner-or-admin with 404-hiding → `baseWorkspace` set (400
  `WORKSPACE_ROOT_NOT_SET`) → path containment: `resolve(path)` must equal
  the root or sit under it (400 `WORKSPACE_OUTSIDE_ROOT`) → online (409
  `MACHINE_OFFLINE`) → daemon capability `workspace` (409
  `DAEMON_NO_WORKSPACE`) → daemon reply within `WORKSPACE_TIMEOUT_MS`
  (default 10s; 504 `WORKSPACE_TIMEOUT`; daemon `error` arm → 502
  `DAEMON_WORKSPACE_FAILED`).
- `GET /api/agent-instances/:id` (new) — `{ agent, machine }` for the session
  page's header + gating state. Owner-ONLY (chat is owner-only by design;
  admins get the 404).
- `GET /api/agent-instances/:id/sessions` — rows now carry `cwd` + `title`.
- `chat:session.open` (socket) — accepts `directory?`:
  - absent → legacy default (agent's install directory);
  - present → `machine.baseWorkspace` must be set (`WORKSPACE_NOT_SET`) and
    the resolved directory must be the root or under it (`WORKSPACE_INVALID`);
    validation runs BEFORE the session-limit gate's side effects.
    The chosen directory is stored as the row's `cwd` and sent as
    `chat:session.start.cwd` (the daemon already honors `cwd` for the subprocess
    and `session/new`).
- SDK: `updateMachine({ baseWorkspace })`, `listMachineWorkspace(machineId, path?)`,
  `getAgentInstance(id)`; `MachineView.baseWorkspace`, `AcSessionView.{cwd,title}`.

### Realtime (`/ctl`) — `workspace:list`

Request `{ requestId, path }` → reply `workspace:list` with
`{ requestId, directories: [{ name, path }] }` or `{ requestId, error }` —
same inventory-style waiter pattern as the W4 config viewer, in a new
`server/src/realtime/workspace.ts` (`WorkspaceCoordinator`: awaitList/onList/
failMachine; disconnect fails waiters). The daemon lists `readdir(withFileTypes)`,
keeps `isDirectory()` entries (symlinks therefore excluded), drops `.*`,
sorts by name, caps 512. The daemon performs NO containment check of its own
(the server already validated; the daemon trusts the server like every other
`/ctl` instruction). Capability tag `workspace` (daemon `0.9.0-p9w6`).

### Wire enrichment — rich tool cards need more than title/status

`acpToolCallViewSchema` gains (all optional, backward compatible):

- `toolName` (≤128) — the card registry key. Daemon-side extraction:
  `update.toolCallUpdate.toolName` if an adapter provides it, else the
  Claude `_meta.claudeCode.toolName` on the `session/update` envelope.
- `rawInput` (`record(string → unknown)`) — arguments for summaries/diffs;
  daemon drops it if `JSON.stringify` exceeds 32 KiB (Write-style payloads).
- `content` (≤16 items) — ACP ToolCallContent: `{ type: 'content' | 'diff' |
'terminal', content?: { type, text? }, path?, oldText?, newText?,
terminalId? }` — the structured arm Edit/Write cards prefer.
- `output` (≤100 000 chars) — `rawOutput` text (Read/Bash/Grep bodies).

`mapAcpUpdate` fills them; the server's existing re-validation relays them to
every viewer. `permission_request` views inherit the same enrichment for free
(rawInput gives the permission card an argument brief).

### Web

Routes (`App.tsx`):

- `/chat` — Agent cards, grouped by machine (section header = machine name +
  online dot + remote-chat state). Card: agent name, target badge, source
  (`deploy`/`detected`), machine, chatability state. Click → `/chat/agents/:id`.
  Blocked states render as hints on the card (offline / remote chat off /
  no agent… cards stay visible — honesty over hiding).
- `/chat/agents/:agentId` — the session page. `AppShell` gains a `full`
  variant for this route (main drops `max-w-6xl` + padding; page height =
  viewport − header). Two panes:
  - **Left (280px)**: "新建会话" button (opens the directory picker) + session
    list **grouped by `cwd`** — group header = `basename(cwd)` with full path
    tooltip, groups ordered by newest session, sessions within by `openedAt`
    desc showing `title ?? id.slice(0,10)` + relative time. Open sessions are
    clickable and highlighted; closed rows render muted (no transcript
    replay in v1 — clicking shows the "已关闭" hint, never a fake history).
  - **Right**: toolbar (agent name/target, live-turn indicator = the view's
    single `--signal` spend, close button) + the stream + composer.
- **Directory picker** (`components/chat/dir-picker.tsx`): FormDialog (W5
  primitive) + lazy tree — root = machine `baseWorkspace`, children fetched
  via `listMachineWorkspace` on expand, directories only. If `baseWorkspace`
  is unset the dialog offers an inline "set base workspace" field
  (`updateMachine`) first. Confirm ⇒ `chat:session.open { agentInstanceId,
directory }`.

Stream rendering (`components/chat/`, all Signal-styled, i18n'd, module-scope
sub-components; adapted from the reference per the research note):

- `fold.ts` — the row model + pure reducer over our semantic events:
  `user_message` → user row + turn begin; `message_delta`/`thought_delta` →
  append-or-open assistant steps; `tool_call` → upsert tool row AND settle the
  current step (status `pending|in_progress` → `running`); `turn_result` →
  sweep + turn-tail (duration measured client-side; usage from `usage`
  events); `raw hnx/prompt-error` → system row (error tone). Permissions stay
  a separate slice rendered inline under the stream, from payload options.
- `chat-stream.tsx` — stick-to-bottom scroll container (threshold + programmatic
  flag + ResizeObserver + jump-to-bottom button).
- `markdown-text.tsx` — react-markdown + remark-gfm + rehype-highlight;
  streaming caret on the live last block; code blocks in IBM Plex Mono.
- `reasoning-row.tsx` — disclosure row ("思考", last-line-follow while running,
  first-line when settled, expandable full text, "思考中…" placeholder).
- `tool-card.tsx` + blocks — three-tier resolution (`toolName` → ACP kind →
  generic), error-boundary-wrapped; blocks: ReadBlock (line numbers +
  highlight + head/tail cap 8 + copy), DiffBlock (pure-text-color diff,
  `└ +A -R` footer), TerminalBlock (status dot + `[dir] $ cmd` banner +
  capped output), SearchBlock (grouped matches / path list), IoCard (IN/OUT),
  and a plain TodoCard. Status colors follow the established state encoding
  (`ok`/`danger`/`warn`); running rows get a subtle pulse, not the reference
  shimmer.
- `turn-tail.tsx` — muted mono line: duration · tokens · 已取消.

New web deps: `react-markdown`, `remark-gfm`, `rehype-highlight` +
`highlight.js` (CSS imported locally; self-hosted only — no CDN, consistent
with the font policy).

`MachineDetail.tsx`: the Deployments card's Chat link points at
`/chat/agents/:agentId`; the header action row gains a small base-workspace
field (owner). Old `Chat.tsx` is deleted (routes replaced).

### Security & scope notes

- Chat stays owner-only; workspace listing is owner-or-admin read (404-hiding)
  but only the owner can open sessions.
- Directory validation is server-side at BOTH open and list time (resolve +
  prefix containment against `baseWorkspace`); the daemon additionally only
  ever returns directory names, never file contents.
- No transcript persistence (unchanged): AcSession rows stay audit-only;
  closed sessions are inert list entries.
- `promptBlockSchema` already accepts `resource_link` — @-file mentions and
  slash commands are deferred (the adapters don't surface commands; the
  browser fs-browse popover is a separate channel).

## Out of scope

- Session resume/replay (needs transcript persistence — a future wave),
  fork/delete of agent-side sessions, IDE/terminal panels, Mermaid rendering,
  @-mentions + slash-command palette, sub-agent trace modals.
- Editing existing credentials/MCP servers/profiles (W5 moves create flows
  into modals; edit paths remain what they are today).

## Test & verification plan

- **server**: chat.test.ts — open with `directory` (happy, outside root →
  `WORKSPACE_INVALID`, unset root → `WORKSPACE_NOT_SET`, absent → legacy
  default), title derived on first send only; workspace.test.ts — coordinator
  unit + route gates (offline/capability/timeout/containment) mirroring
  config-view.test.ts; machines PATCH round-trips `baseWorkspace`.
- **cli**: chat.test.ts — enriched `toolCallView` (toolName from `_meta`,
  diff content passthrough, rawInput 32 KiB drop, output cap);
  workspace.test.ts — tmpdir listing (dirs only, hidden skipped, 512 cap).
- **smoke**: `[9 W6]` — PATCH baseWorkspace, real-daemon workspace listing,
  chat open with directory against the fixture ACP agent.
- **web**: `tsc` + `vite build`; browser walkthrough on the dev rig (cards →
  session page → picker → fixture-agent turn with tool calls rendering).

## What landed (2026-09)

Both waves shipped as designed, with these deviations worth knowing:

- **W5** also fixed a dev-only vite proxy bug the walkthrough surfaced: the
  `'/mcp'` prefix proxy swallowed the app's own `/mcp-servers` page route —
  a `bypass` now rewrites it to the SPA shell (`vite.config.ts`).
- **W6 wire**: `acpToolCallView` normalization happens daemon-side in
  `toolCallView`/`buildView` (`packages/cli/src/daemon/chat.ts`) — kind
  variants like `readTool` fold to the spec short form, unknown statuses are
  dropped (field-by-field extraction, never a whole-view fallback), and
  `rawInput` is dropped wholesale past 32 KiB (Write-style bodies).
- **W6 route bug found by its own test**: the daemon `error` arm must be
  mapped BEFORE the generic `!outcome.ok` → 504 branch, or a fast error
  reply misreports as a timeout (`modules/workspace.ts`).
- The session page's left rail is desktop-only (`hidden md:flex`); mobile
  falls back to the right-pane-only layout (a mobile drawer is future work).
- The directory picker's first click on a collapsed folder EXPANDS it; a
  second click (or the root row / manual path input) selects. Expanding an
  empty folder renders it selectable.
- The fixture ACP agent gained a `show-tools` prompt arm
  (`test/fixtures/acp-agent.mjs`) emitting `_meta.claudeCode.toolName`-tagged
  Read/Bash/Edit calls with rawOutput + structured diff — the reference
  payload for the rich-card tests and walkthroughs.
- Tests: server 99 (workspace route suite + chat cwd/title suite), cli 67
  (enrichment + `listDirectories`), shared 69; smoke **380/380** including a
  `[9 W6]` section (real-daemon workspace listing + gates).

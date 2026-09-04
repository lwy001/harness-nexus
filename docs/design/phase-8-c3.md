# Design: Phase 8 C3 — inventory, diff & one-click import

> Status: **implemented** (branch `phase-8-c3`). Parent design:
> `docs/design/phase-8-client.md` § "Inventory, diff & import (C3)". PRD:
> `docs/prd/phase-8-client.md` ("读取当前Agent的各种插件、工具 … 一键导入并创建
> profile"). C2: `docs/design/phase-8-c2.md` (shipped — client MCP serving).
> Verification: shared 41 (snapshot/event schemas + pure diff matrix), cli 7
> (fixture-HOME scanners incl. the env/header redaction assertion), server 33
> (fake-daemon integration: scan round-trip, import → reuse-or-create →
> profile, idempotent re-import, all gates), smoke `[8 C3]` — the REAL daemon
> dist against a fixture HOME (scan → import → re-import reuse → diff → 409s)
> — 220/220 overall; SQLite migration `0008` upsert/cascade verified.

## Scope

C3 answers "what does this machine actually have installed, how does it compare
to a profile, and can I pull it into the platform?" — the management half of
the vision (the deploy half is C4):

1. **Daemon scanners** read the same ground-truth locations the 3.3/C2 adapters
   write and report a **normalized per-target snapshot**:
   - claude-code: `~/.claude/skills|commands|agents` + `mcpServers` in `~/.claude.json`
   - codex: `~/.codex/skills|prompts` + `[mcp_servers.*]` in `~/.codex/config.toml`
   - hermes: `~/.hermes/plugins/*/skills` + `mcp_servers` in `~/.hermes/config.yaml`
     - `~/.hermes/AGENTS.md` (rules)
       Each item carries `{kind, name, origin: 'platform'|'local', path, summary,
contentPreview, importable, meta?}`. `origin: 'platform'` is derived from
       markers we own (install-state ledger, `harness-nexus[-*]` MCP entry names) —
       never guessed from content. Absent home dir ⇒ target absent from the report
       (honest: "not installed here").
2. **Direct request/response over `/ctl`** (no `Job` rows in C3 — C4 formalizes
   the queue/replay semantics and absorbs these flows; `jobTypeSchema` already
   reserves `'scan' | 'import'`):
   - S→D `inventory:scan` `{requestId, targets[]}` → daemon scans, replies one
     `inventory:report` `{target, snapshot}` per target.
   - S→D `inventory:collect` `{requestId, target, items:[{kind,name}]}` →
     daemon **re-scans that target** (the server never dictates file paths) and
     replies `inventory:payload` with artifact bodies.
   - D→S `inventory:report` is validated, stored (latest per machine+target),
     resolves any pending scan waiter, and pushes `inventory:updated`
     `{machineId, target, reportedAt}` to the owner (+admins) on `/app`.
   - The daemon also auto-reports every target after each successful
     `machine:hello` — inventory is fresh whenever the daemon comes up.
3. **Storage**: `machine_inventory` table (migration `0008`), `UNIQUE(machine_id,
target)`, report stored as a JSON document. New `MachineInventorySnapshot`
   domain type + `InventoryRepository` port (`findLatest`, `list`, `save`
   upsert, `deleteByMachine`) + both drivers. Machine deletion clears its rows.
4. **REST** (`modules/inventory.ts`, all under the machine owner-or-admin +
   404-hiding guard):
   - `GET /api/machines/:id/inventory` — latest snapshot per target.
   - `POST /api/machines/:id/inventory/scan` `{targets?}` — gates: offline →
     `409 MACHINE_OFFLINE`; daemon without the `inventory` capability → `409
DAEMON_NO_INVENTORY`; then awaits one report per requested target
     (`INVENTORY_REQUEST_TIMEOUT_MS`, default 60s; a concurrent scan → `409
SCAN_IN_PROGRESS`). Timeout → `504 INVENTORY_SCAN_TIMEOUT` with partials.
   - `GET /api/machines/:id/inventory/diff?profile=<id>` — the snapshot for the
     profile's `target` diffed against the profile (404 if profile/snapshot
     missing/not visible).
   - `POST /api/machines/:id/inventory/import` `{target, profileName,
items:[{kind,name}]}` — collect → create → bundle; synchronous (bounded by
     the same timeout); responds `{profile, created[], reused[], warnings[]}`.
5. **Diff is pure** (`shared/src/diff-inventory.ts`): profile entries are
   resolved server-side to `{kind, name}` pairs, then matched against snapshot
   items by `(kind, name)` — adapters write artifacts named after the resource,
   so the round-trip is name-stable. The **MCP arm is coarse by design**: one
   profile install emits ONE shim entry (`harness-nexus[-<slug>]`), so the
   profile's whole MCP arm matches a single `origin:'platform'` mcp item.
   Output: `{upToDate[], missingOnMachine[], notInProfile[], summary}` —
   `notInProfile` (origin `local`) is exactly the import-candidate list.
6. **Import** = reuse-or-create, then bundle:
   - Non-MCP items → `Resource` rows (`key = '<kind>:<slug(name)>'`, `targets:
[target]`, `source: inline` single-file / `inline-bundle` multi-file skill).
     If a resource with the same key exists AND the content is identical →
     **reuse** (re-import is idempotent); different content → suffix `-<n>` on
     the key. This mirrors the "plans are idempotent overwrites" doctrine.
   - MCP items → **`McpServer` rows, never Resources** (4.2's `mcp` kind rule),
     with the profile-entry arm `{mcpServerId}`. `dialSite: 'auto'`.
   - Everything bundles into a new personal `Profile` owned by the **machine's
     owner** (the artifacts are that user's setup; an admin importing still
     works because admin sees all). Creation is best-effort sequential — not
     transactional; a failure surfaces which items made it.
7. **Secret redaction happens in the daemon, before upload** (load-bearing):
   MCP `env` values and `header` values are replaced by `${cred:<KEY>}`
   placeholders (the key name survives, the plaintext never crosses the wire);
   `command`/`args`/`url` pass verbatim (same trust level as typing them into
   the platform). The import response carries a warning per placeholder whose
   credential does not exist yet, so the user knows to fill them in.
8. **Daemon capability**: `machine:hello` now reports `capabilities:
['inventory']`; the scan route checks it for a precise error instead of a
   timeout against an old daemon.
9. **Web**: `MachineDetail` page at `/machines/:id` (linked from Machines rows,
   no sidebar entry — drill-down, not a top-level surface): header (online
   badge, daemon version, hostname/os), per-target inventory tables, Scan
   button, per-profile diff view (missing / candidates / up-to-date), and the
   import wizard (select candidates → profile name → result links to the
   profile). `inventory:updated` on `/app` refreshes the view live.
10. **SDK**: `getMachineInventory` / `scanMachineInventory` /
    `diffMachineInventory` / `importMachineInventory` + view types.

## Snapshot shape (shared schema, mirrored in core)

```ts
InventorySnapshot = {
  target: AgentTarget;
  scannedAt: string;            // ISO, daemon clock
  agents: InventoryAgent[];     // C3: exactly one (the default home)
};
InventoryAgent = {
  name: string;                 // e.g. '~/.claude'
  directory: string;            // absolute home dir
  profileApplied: boolean | null; // null = unknown
  items: InventoryItem[];
};
InventoryItem = {
  kind: 'skill' | 'command' | 'sub_agent' | 'rule' | 'mcp';
  name: string;
  origin: 'platform' | 'local';
  path: string;                 // relative to `directory`, display only
  summary?: string;             // first meaningful line, ≤120 chars
  contentPreview?: string;      // ≤200 chars, metadata-only report
  importable: boolean;          // false: binary/oversized/mcp-with-issues
  note?: string;                // why not importable, or origin evidence
  meta?: { multi?: boolean; transport?: 'stdio'|'sse'|'http'; command?: string; url?: string };
};
```

Caps (validated): ≤500 items per target, ≤200-char previews, collect bodies
≤256 KiB per item (beyond ⇒ `importable: false` at scan time by size class
where cheap, else `ok: false, error: 'too-large'` in the payload).

## Tasks (dependency order)

1. **shared** — `schemas/inventory.ts` (snapshot/item/artifact/import request +
   diff response) + realtime event schemas (`inventory:scan|report|collect|
payload`, `/app` `inventory:updated`) + `diff-inventory.ts` pure function.
   Unit tests: schema round-trips, diff matrix (applied / missing / candidates /
   coarse-MCP).
2. **core** — `domain/inventory.ts` (`MachineInventorySnapshot`, plain item/
   agent interfaces kept in sync with shared) + `InventoryRepository` port +
   `UnitOfWork.inventories`.
3. **server storage** — migration `0008` + SQLite repo + memory repo; machine
   delete cascades to `deleteByMachine`.
4. **server realtime** — `InventoryCoordinator` (`src/realtime/inventory.ts`):
   pending scan/collect waiters keyed by machine (+target), timeout + one-
   in-flight-scan guard; `/ctl` handlers `inventory:report|payload`; `/app`
   `inventory:updated` push.
5. **server routes** — `modules/inventory.ts` (4 endpoints above) + config
   `INVENTORY_REQUEST_TIMEOUT_MS`; import handler with reuse-or-create +
   McpServer arm + warnings.
6. **sdk** — views + 4 methods.
7. **cli** — `src/inventory/` (scanner registry + 3 scanners + collect readers
   with redaction); daemon wiring (scan/collect handlers, capability, auto-
   report after hello). Scanner tests run against fixture HOMEs (tmp dirs);
   **redaction assertion**: an env/header plaintext value never appears in any
   emitted payload.
8. **web** — `MachineDetail.tsx` + route + Machines row link + `inventory:
updated` subscription.
9. **verify** — server integration tests (fake daemon socket: report ingest,
   scan round-trip, import round-trip incl. idempotent re-import + redaction +
   409/404 gates); smoke `[8 C3]` block: enroll → spawn the REAL daemon dist
   against a fixture HOME → scan → diff vs an empty profile → import → assert
   resources + profile + redacted McpServer → re-import is a full reuse.

## Security notes

- The daemon never trusts server-supplied paths — collect re-derives every
  path from its own scan.
- Secret redaction is daemon-side and structural (env/header values), not a
  server-side scrub of arbitrary text; anything we did not classify (args,
  URLs) is treated as user-entered config, identical to the existing MCP form.
- Machine PAT blast radius is unchanged: inventory rides `/ctl` only; no new
  REST exception is opened (the REST endpoints authenticate the OWNER, never
  the machine token).
- Snapshots store previews only — full bodies exist transiently in the import
  request, never persisted as inventory.

## Out of scope (explicit)

- Queued/offline-replay semantics (C4's job system absorbs `scan`/`import`).
- Hook scanning for any target (CC's matcher format is lossy vs the 4.5 event
  map; Hermes hooks are Python plugins) — items are simply not reported.
- CC `~/.claude/plugins` marketplace installs and project-scoped (`.claude/`)
  artifacts — global homes only.
- Rules for claude-code (no established global rules dir) and codex
  (project-root AGENTS.md only).
- Importing INTO an existing profile (C3 always creates a new one — simpler,
  reversible via profile delete).
- Multi-agent-per-target snapshots (the `agents[]` array is the forward-compat
  shape; C3 fills exactly one entry).

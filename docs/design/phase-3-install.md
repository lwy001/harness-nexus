# Install pipeline & target-tool profiles (Phase 3)

> Status: **3.1 shipped** (McpServer.mode + stdio-in-direct + rename + migration
> v2); **3.2–3.6 not started.** PRD: `docs/prd/phase-3-install.md`. Research:
> `docs/research/phase-3-plugin-targets.md`. Read both before changing code.
> This revision corrects several points where the original draft described a
> shape that has since moved (the `proxied` field, the hook-matrix location,
> migration numbering) — see the inline `> note` callouts.

## What Phase 3 adds

Three coupled changes, summarized then detailed below:

1. **MCP Management** — the `McpServer` entity carries a `mode` (`proxy` |
   `direct`). stdio is re-enabled, gated to `direct`. "MCP Connections" is
   renamed "MCP Management".
2. **Target-bound profiles** — `Profile` gains a required, immutable `target`.
   The creation form narrows offered resources/hook events to the target.
3. **Install pipeline** — `hnx install` resolves a profile, a **target writer**
   emits a plugin directory in the target's native format, and an installer
   places it. CC + ZCode share a writer; Hermes has its own.

> **Status as of this revision.** 3.1 (`mode` + stdio-in-direct + rename) is
> shipped. 3.2 (`Profile.target`) → 3.6 are not started. The notes below flag
> where the original draft described a shape that has since moved on, so the
> remaining sub-phases build on the _current_ code, not the draft.

The dependency boundary is `core` (domain) → `shared` (zod + the hook
compatibility matrix) → `server` (storage migration + REST + import) →
`sdk-ts` (client methods) → `cli` (writers + installer) → `apps/web` (renamed
page, target picker, import UI). Build each before the next.

## Part 1 — McpServer.mode & the stdio re-enable ✅ shipped (3.1)

> This part is implemented. The interface below is the _current_ shape, with the
> stale `proxied` field removed (2.4 deleted it — mode alone drives pooling).

### Domain change (`packages/core/src/domain/user.ts`)

The `McpServer` interface (`user.ts:56`) carries `mode`. The `McpTransport`
union (`user.ts:73`) includes the `stdio` variant. `McpMode = 'proxy' |
'direct'` (`user.ts:53`).

```ts
export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport; // unchanged (already supports stdio)
  /**
   * proxy  — Harness Nexus dials the upstream and re-exposes it via /mcp.
   *          Only SSE / Streamable HTTP. Pooled by the registry.
   * direct — the target tool dials the upstream itself. SSE / HTTP / stdio.
   *          Harness Nexus stores the connection + encrypted credentials only;
   *          it never opens the connection. stdio forces direct.
   */
  mode: 'proxy' | 'direct';
  scope: 'global' | 'personal';
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

> **No `proxied` field.** The original draft modeled a `proxied: boolean`
> alongside `mode`; 2.4 collapsed that into a single source of truth — mode is
> the only pooling signal. The registry now filters `list({ mode: 'proxy' })`
> directly (`server/src/mcp/registry.ts:111`). Do not re-introduce `proxied`.

### mode × transport matrix

| mode     | `sse` | `streamable-http` |            `stdio`             |
| -------- | :---: | :---------------: | :----------------------------: |
| `proxy`  |  ✅   |        ✅         | ❌ `409 STDIO_REQUIRES_DIRECT` |
| `direct` |  ✅   |        ✅         |               ✅               |

The registry (Phase 2.2) only ever dials `mode === 'proxy'` rows. A `direct`
row is never opened by Harness Nexus — it is emitted verbatim into a plugin at
install time. This is what re-enables stdio without weakening the server trust
boundary: Harness Nexus still never spawns a stdio subprocess.

### Schema change (`packages/shared/src/schemas/mcp.ts`)

Lift the Phase 2.1 stdio exclusion **for direct mode only**, and add `mode`.
This is implemented; the current schema does **not** use a zod `.refine()` for
the stdio+proxy rejection — instead a `requiresDirect()` helper
(`mcp.ts:65`) drives a route-layer `409 STDIO_REQUIRES_DIRECT` so the error
carries the right code rather than a generic 400 validation failure:

```ts
const mcpModeSchema = z.enum(['proxy', 'direct']);

export const mcpTransportSchema = z.discriminatedUnion('type', [
  stdioTransportSchema, // { type:'stdio', command, args?, env? }
  z.object({ type: z.literal('sse'), url: z.string().url(), ...headersBase }),
  z.object({ type: z.literal('streamable-http'), url: z.string().url(), ...headersBase }),
]);

export const createMcpServerSchema = z.object({
  name: z.string().min(1).max(64),
  transport: mcpTransportSchema,
  mode: mcpModeSchema.default('proxy'),
  scope: scopeSchema,
});

export function requiresDirect(transport): boolean { return transport.type === 'stdio'; }
```

The route handler (`modules/mcp-servers.ts`) calls `assertDirectForTransport()`
→ `AppError(..., 409, 'STDIO_REQUIRES_DIRECT')` when `requiresDirect(transport)
&& mode !== 'direct'`.

### Registry impact

`McpRegistry.doReload()` (`server/src/mcp/registry.ts:111`) fetches only proxy
rows directly — `await this.uow.mcpServers.list({ mode: 'proxy' })`. No other
registry change — direct rows are simply not in its world. The
`/api/mcp-servers/status` endpoint continues to report only pooled (proxy)
servers; direct rows are listed in MCP Management without a live status.

### Migration

`mcp_servers.mode` was added **inline** to the existing `mcp_servers` CREATE
TABLE (the `mode TEXT NOT NULL DEFAULT 'proxy'` column in migration v2,
`migrations.ts:74`). This project has not shipped a release, so there is no
legacy data to back-fill or upgrade path to preserve — early migration rows
were edited in place rather than appended as ALTERs. **Done.**

Current migration versions: v1 (auth) · v2 (credentials + mcp_servers, with
`mode`) · v3 (profiles) · v4 (resources). The next free version is **v5**.
When 3.2 starts, `profiles.target` lands there as `target TEXT NOT NULL
DEFAULT 'generic'` (the back-fill default for pre-target rows), again edited
inline into the `profiles` CREATE TABLE.

## Part 2 — Profile.target

### Domain change (`packages/core/src/domain/profile.ts`)

```ts
export interface Profile {
  id: string;
  name: string;
  description?: string;
  version: string;
  /** Single target tool this profile is shaped for. Immutable post-create. */
  target: AgentTarget; // 'claude-code' | 'zcode' | 'hermes' | 'generic'
  scope: 'global' | 'personal';
  ownerId: string | null;
  entries: ProfileEntry[];
  imports?: ProfileImport[];
  createdAt: string;
  updatedAt: string;
}
```

> **`AgentTarget` is currently defined twice** and must be unified as part of
> 3.2: once in `core/src/domain/resource.ts:16` (plain type) and once in
> `shared/src/schemas/profile.ts:12` (zod enum + inferred type). Per the
> layering rule, `shared` is the schema source of truth and `core` mirrors it —
> but `core` may not depend on `shared`. Resolution for 3.2: keep the canonical
> literal union in `core` (`resource.ts` already has it), have `shared`'s zod
> enum infer to that same type, and re-export one `AgentTarget` from `shared`
> for consumers that don't depend on `core`. Decide the exact wiring when 3.2
> starts; the point now is _don't proceed assuming a single source exists_.

`ProfileEntry` is unchanged from Phase 2.2 — `resourceId`, `kind`,
`pinnedVersion?`, `installOptions?`. Crucially, an MCP entry still references a
`McpServer.id`; **mode lives on the McpServer, not on the entry**, so a profile
simply selects MCP servers and inherits each one's mode (Part 4 explains how
the writer branches on it).

> **Reality check on the entry shape.** The _domain_ `ProfileEntry`
> (`core/domain/profile.ts:26`) is generic `{ resourceId, kind, … }`, but the
> current **REST request schema is narrower**: `profileEntryInputSchema`
> (`shared/schemas/profile.ts:46`) takes `{ mcpServerId }` only — 2.2 maps that
> to `McpServer.id` and synthesizes a `kind: 'mcp'` entry internally. So the
> "resource picker narrowed by target" UI described below presumes the broader
> multi-kind entry shape, which does **not** exist in the API yet. 3.2 should
> either widen `profileEntryInputSchema` to the generic `{ resourceId, kind }`
> form (and update the 2.2 route's MCP synthesis) or stage the multi-kind
> picker until the entry schema is widened. This is a 3.2 design decision, not
> a drop-in.

### Schema change (`packages/shared/src/schemas/profile.ts`)

`createProfileSchema` requires `target`; `updateProfileSchema` deliberately
**omits** it. The handler rejects a PATCH body carrying `target` with
`409 TARGET_IMMUTABLE` (a defensive check — the field isn't in the update
schema anyway, but the error is clearer than a generic 400).

### Creation form behavior

Target is chosen **first**, before any resource entry:

1. Step 1 — name, description, scope, **target** (required).
2. Step 2 — resource picker, narrowed by target:
   - MCP servers: all visible servers (mode shown as a badge).
   - Skills / commands: offered for all targets (cross-target portable).
   - Sub-agents: offered for `claude-code`, `hermes`; **hidden for `zcode`**
     (ZCode plugins do not execute `agents/*.md`; a callout explains this and
     links to the user-scope fallback).
   - Hooks: offered events are filtered by the **hook support matrix**
     (Part 3).
   - Rules: offered for all targets; the writer wraps them appropriately.

## Part 3 — Hook support matrix

> **Already built — do not recreate.** Phase 4.5 landed this matrix in
> `packages/shared/src/hooks.ts` (NOT a new `target-compat.ts` as this doc's
> original draft proposed). `HOOK_EVENTS`, `HOOK_SUPPORT`, and
> `DECLARATIVE_HOOK_TARGETS` all live there and are the single source of truth
> for the hook-event side. 3.2/3.4/3.3 consume them as-is.

`packages/shared/src/hooks.ts` owns the declarative table of canonical hook
events and which targets support each. The profile creation form and the import
path consult it; the writers consult it to skip unsupported events defensively.
Current shape (`hooks.ts:18–67`):

```ts
export const HOOK_EVENTS = [ /* 16 canonical events (CC union) */ ] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

// null = the target uses a different hook model (Hermes → Python plugins),
// so a declarative hooks.json resource cannot target it at all.
export const HOOK_SUPPORT: Readonly<Record<AgentTarget, ReadonlySet<HookEvent> | null>> = {
  'claude-code': new Set<HookEvent>(HOOK_EVENTS), // full set
  zcode: new Set<HookEvent>([ /* the 7 ZCode supports */ ]),
  hermes: null,        // not a declarative-hooks target
  generic: new Set<HookEvent>(HOOK_EVENTS),
};
export const DECLARATIVE_HOOK_TARGETS: ReadonlySet<AgentTarget> = /* keys where value !== null */;
```

> **Correction vs. the original draft:** Hermes is modeled as `null`
> (structurally different hook model — Python plugins, not `hooks.json`), and
> the route layer rejects a hook targeting Hermes outright (`409
> TARGET_NO_DECLARATIVE_HOOKS` via `DECLARATIVE_HOOK_TARGETS`). The draft's
> "fill the Hermes set from `hermes_cli/` later" is therefore moot for the
> declarative path — Hermes hooks are not unsupported-event, they are
> wrong-model, and go through a different writer path in 3.5.

A full **per-artifact compatibility matrix** — `(resourceKind, fromTarget,
toTarget) → portable | convertible | unsupported(reason)` — is genuinely
net-new and lands with 3.4. It is _not_ the same as the hook-event matrix
(which is `(event, target) → bool`). It will most naturally live alongside
`hooks.ts` in a new `packages/shared/src/target-compat.ts`, since it concerns
all resource kinds, not just hooks. The draft's reference to `target-compat.ts`
is accurate for **3.4**, not the hook matrix.
import report (Part 5): for each `(resourceKind, fromTarget, toTarget)` it says
`portable` | `convertible` | `unsupported(reason)`.

## Part 4 — Install pipeline & target writers

### CLI entry

```bash
hnx install --profile <id> [--target <t>] [--mode auto|proxy|direct] [--out <dir>]
```

- `--profile` resolves via the SDK (running server) or a local manifest
  (standalone, per AGENTS.md's CLI rule).
- `--target` overrides the profile's own `target` only for `generic` profiles;
  for a target-bound profile it must match (else `409 TARGET_MISMATCH`).
  > **`generic` install semantics are deferred** (decided when 3.3 starts):
  > either `generic` is a placeholder that **requires** `--target` to install,
  > or it installs a minimal portable-only bundle (skill/command). Until then,
  > neither behavior is committed.
- Output defaults to `./<profile-name>-bundle/`.

### Resolution

`ProfileResolver` produces a resolved profile: the `Profile` plus the fully
fetched artifacts for each entry (skill bodies, hook configs, the McpServer
rows for MCP entries). For direct-mode MCP entries whose transport string fields
(url, command, args, env, headers) carry `${cred:NAME}` placeholders, the
writer resolves those placeholders to decrypted plaintext at emit time
(`resolvePlaceholders` from `@harness-nexus/shared`); the secret is attached
**in-memory only** and written into the emitted plugin config only for direct
mode (the output dir is then flagged sensitive).

### Writer interface

```ts
// packages/cli/src/writers/types.ts
export interface WriterOutput {
  /** Relative path → file contents. The installer materializes these. */
  files: Map<string, string | Buffer>;
  /** Human-readable install instructions specific to this target. */
  installHint: string;
  /** True if any emitted file carries decrypted secrets (direct-mode creds). */
  sensitive: boolean;
}

export interface TargetWriter {
  readonly target: AgentTarget;
  write(resolved: ResolvedProfile, opts: WriteOpts): Promise<WriterOutput>;
}
```

### Claude-Code writer (serves CC + ZCode)

Emits the layout from the research doc. The MCP block branches on each entry's
`McpServer.mode`:

```
<profile>-bundle/
├── .claude-plugin/plugin.json        # name, version, description, userConfig{PAT}
├── .zcode-plugin/plugin.json         # twin (optional; CC manifest is auto-recognized by ZCode)
├── .mcp.json                         # see MCP emission below
├── skills/<name>/SKILL.md            # per kind=skill
├── commands/<name>.md                # per kind=command
├── agents/<name>.md                  # per kind=sub_agent (CC only; ZCode narrows this out)
├── hooks/hooks.json                  # per kind=hook (events filtered to target support)
└── rules/<name>.SKILL.md             # kind=rule wrapped as a skill (no CLAUDE.md auto-load)
```

**MCP emission** — the core decision. **Confirmed: proxy is the default; direct
is the escape hatch for offline / no-server installs.** For each `kind === 'mcp'`
entry, branch on the referenced `McpServer.mode`:

```jsonc
// .mcp.json — mixed example
{
  "mcpServers": {
    // proxy mode → single aggregated endpoint
    "harnessnexus-cloud": {
      "type": "streamable-http",
      "url": "https://hnx.example.com/mcp?profile=<profileId>",
      "headers": { "Authorization": "Bearer ${user_config.PAT}" },
    },
    // direct mode → connection verbatim (stdio preserved)
    "local-fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
    },
  },
}
```

- **proxy entries collapse into one** `harnessnexus-<profile>` server (the whole
  point of aggregation). The PAT is a `${user_config.PAT}` placeholder;
  `userConfig` in the manifest prompts for it at enable time (CC stores it in
  the keychain). No upstream secret is shipped.
- **direct entries are written verbatim**, transport included (stdio command /
  HTTP url). Any `${cred:NAME}` placeholders in the transport string fields are
  resolved to decrypted plaintext (inlined into url/command/args/env/headers)
  and the output is flagged `sensitive`.

**ZCode narrowing pass** (a flag on the same writer, not a second writer):

- Drop `agents/` (ZCode plugin `agents` is recorded but not executed); emit an
  `installHint` telling the user to copy them to `~/.zcode/agents/` manually
  if wanted.
- Filter `hooks/hooks.json` to the 7 ZCode-supported events.
- Emit the `.zcode-plugin/plugin.json` twin.
- Use `${ZCODE_*}` variables in addition to `${CLAUDE_*}` (ZCode expands both,
  but being explicit avoids future drift).

### Hermes writer (separate, ships after CC/ZCode)

YAML manifest + YAML `config.yaml` `mcp_servers:`. Different enough to justify
its own writer; lower confidence (schema verified against the repo first). The
skill bodies transfer almost verbatim (SKILL.md-compatible). MCP entries map
to `config.yaml`; proxy → one HTTP entry, direct → stdio/http verbatim.

### Installer

Materializes the writer's `files` map to `--out`, then prints the
`installHint`. It does **not** run target-specific commands by default (the
user copies / adds the marketplace themselves) — a future `--apply` flag may
shell out to `claude plugin marketplace add` / `hermes skills add`.

## Part 5 — Cross-target import

### Endpoint

```
POST /api/profiles/:id/import-from   { sourceProfileId }   → 200 CompatibilityReport
POST /api/profiles/:id/import-apply  { sourceProfileId, selectedEntryIds[] }  → 200 Profile
```

Two-step so the UI can show the report and let the user pick before mutating.

### CompatibilityReport

```ts
interface CompatibilityReport {
  entries: Array<{
    sourceEntryId: string;
    kind: ResourceKind;
    status: 'portable' | 'convertible' | 'unsupported';
    reason?: string; // present iff unsupported (e.g. "ZCode plugins do not execute sub-agents")
    convertedPreview?: unknown; // iff convertible (e.g. hook event filtered, mcp shape changed)
  }>;
}
```

Mapping rules (from the research doc's matrix):

| Kind      | Portable                        | Convertible                      | Unsupported                    |
| --------- | ------------------------------- | -------------------------------- | ------------------------------ |
| skill     | all targets                     | —                                | —                              |
| command   | all                             | —                                | —                              |
| rule      | —                               | all (wrap-as-skill vs AGENTS.md) | —                              |
| sub_agent | claude-code, hermes             | —                                | zcode (plugin doesn't execute) |
| hook      | event ∈ target's `HOOK_SUPPORT` | event filtered out               | event ∉ support set            |
| mcp       | proxy mode                      | JSON↔YAML, proxy↔single endpoint | —                              |

`import-apply` copies entries marked `portable` or `convertible`, skips
`unsupported`, and only the `selectedEntryIds` the user confirmed.

## Part 6 — API surface (additions)

All under `/api`, same `{ error, message }` shape.

| Method | Path                             | Auth           | Notes                                                   |
| ------ | -------------------------------- | -------------- | ------------------------------------------------------- |
| POST   | `/api/mcp-servers`               | `requireAuth`† | now accepts `mode`; stdio requires `direct`             |
| PATCH  | `/api/mcp-servers/:id`           | `requireAuth`‡ | mode change allowed (proxy↔direct) if transport permits |
| POST   | `/api/profiles`                  | `requireAuth`† | now requires `target`                                   |
| PATCH  | `/api/profiles/:id`              | `requireAuth`‡ | omits `target`; carrying it → `409 TARGET_IMMUTABLE`    |
| POST   | `/api/profiles/:id/import-from`  | `requireAuth`‡ | owner-or-admin on both profiles                         |
| POST   | `/api/profiles/:id/import-apply` | `requireAuth`‡ | owner-or-admin on both profiles                         |

† admin required iff `scope === 'global'`. ‡ ownership check on both profiles
(source must be visible to the caller too; else `404 NOT_FOUND`).

New error codes: `STDIO_REQUIRES_DIRECT` (409), `TARGET_IMMUTABLE` (409),
`TARGET_MISMATCH` (409), `PROFILE_SOURCE_NOT_ACCESSIBLE` (404).

## Part 7 — Web UI

Follows the Signal design system (AGENTS.md "Web UI design system").

- **Rename**: "MCP Connections" → "MCP Management" in `navItems()` (both
  desktop + mobile), page heading, breadcrumbs. Add a `mode` badge (proxy =
  signal accent, direct = neutral) to each row; direct rows show no live
  status (or a `direct` sentinel instead of the connection dot).
- **MCP Management create/edit form**: a `mode` radio (proxy / direct). stdio
  becomes selectable in the transport picker only when `direct` is chosen;
  picking stdio auto-flips mode to direct and disables the proxy radio with a
  tooltip.
- **Profiles create form**: two-step — step 1 collects name/description/scope/
  **target** (target first), step 2 narrows the resource picker by target per
  Part 2. Sub-agents hidden for zcode with a callout.
- **Import flow**: a "Import from profile…" action on the profiles page →
  picker → compatibility report view (green = portable, amber = convertible
  with preview, red = unsupported with reason) → confirm selection.
- All copy in English (i18n is a later cross-cutting change).

## Part 8 — Scope, permission, and security rules

- **MCP mode and profiles inherit the existing scope model** (global admin-
  mutate / personal owner-only). No new scope concepts.
- **Direct-mode bundles are sensitive.** If any emitted file carries a
  decrypted credential (a direct MCP entry whose `${cred:NAME}` placeholders
  were resolved to plaintext), the CLI prints a warning and the output dir gets
  restrictive permissions (`0700`). Proxy-only bundles carry only a PAT and are
  not sensitive.
- **The PAT in a proxy bundle is `${user_config.PAT}`**, not a literal — the
  tool prompts at enable time (CC → keychain). The CLI never writes a PAT to
  disk unless explicitly told to (a future `--embed-pat` flag, off by default).
- **Import never silently drops.** Every unsupported entry appears in the
  report with a reason; the user must confirm the selection.

## Out of scope (deferred)

- ECC + Superpower `imports` adapters (later sub-phase).
- Hermes writer full fidelity (ships after CC/ZCode, pending repo schema
  verification).
- Hosted per-profile marketplace / registry.
- `--apply` shelling out to target CLIs.
- Per-PAT profile binding and tool-level authorization (still from 2.2).
- The stdio bridge entry (Phase 6) — direct mode here is the _tool_ spawning
  stdio, not Harness Nexus.

## Suggested sub-phasing

- **3.1 ✅ done** — `mode` on McpServer + stdio-in-direct + rename + migration
  v2 (mode column) + server/SDK plumbing + MCP Management UI (mode badge,
  form). Smoke-test stdio create (success) and stdio+proxy (409). No profiles
  change.
- **3.2** — `target` on Profile + create form narrowing + unify the duplicate
  `AgentTarget` type + migration **v5** (profiles.target) + `TARGET_IMMUTABLE`.
  Reuse the existing `hooks.ts` matrix (do NOT create target-compat.ts here).
  Open decision: whether to widen `profileEntryInputSchema` from `{ mcpServerId
  }` to the generic `{ resourceId, kind }` now, so the narrowed resource picker
  has something to bind to. No install yet.
- **3.3** — Claude-Code writer (CC + ZCode narrowing) + `hnx install` +
  resolver + proxy/default + direct/escape-hatch MCP emission. Decide
  `generic` install semantics. Verify the emitted plugin loads in both tools.
- **3.4** — Import flow (report + apply) + UI. **This is where the
  per-artifact compatibility matrix** (`target-compat.ts`) is genuinely
  net-new.
- **3.5** — Hermes writer (after repo schema verification).
- **3.6** — ECC + Superpower adapters.

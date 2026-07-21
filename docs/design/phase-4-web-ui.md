# Design: Phase 4 — Resource management & PAT UI

> Status: 4.1 implemented; 4.2–4.3 designed here; 4.4–4.6 pending research.
> PRD: `docs/prd/phase-4-web-ui.md`.

This design covers the **shared Resource backend** (lands with 4.2) and the
**sub-agent (4.2) / rule (4.3) markdown editors**. Skill/hook/command (4.4–4.6)
are out of scope here — they extend this backend later.

## Data model

The `Resource` domain interface (`packages/core/src/domain/resource.ts`) already
exists and is unchanged:

```ts
interface Resource {
  id: string;
  key: string; // stable id within instance, e.g. "sub_agent:reviewer"
  kind: ResourceKind; // 'skill' | 'hook' | 'sub_agent' | 'rule' | 'mcp' | 'command'
  name: string;
  description?: string;
  version: string; // asset semver, independent of packaging
  source: ResourceSource;
  scope: ResourceScope; // 'global' | 'personal'
  ownerId: string | null;
  targets: AgentTarget[];
  labels?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

type ResourceSource =
  | { type: 'git'; url: string; ref?: string; path?: string }
  | { type: 'tarball'; url: string; checksum?: string }
  | { type: 'local'; path: string }
  | { type: 'inline'; content: string };
```

**Key semantics.** `key` is caller-provided and stable. It is the handle used in
`kind:key` profile references (e.g. `sub_agent:reviewer`). Uniqueness is
**per (key, scope, owner)** — enforced by the route layer via `findByKey` before
`save` (409 `RESOURCE_KEY_TAKEN` on collision). A `global:foo` key and a
`personal:foo` key (different owners) coexist.

**Sub-agent / rule content.** Both use `source: { type: 'inline', content }`
(markdown). The body is the system prompt (sub-agent) or policy doc (rule). The
other `ResourceSource` variants exist in the domain but are not exercised by
4.2/4.3 — they arrive with 4.4 (skills: git/tarball/hub) and later.

## Storage

### SQLite migration v5

Append to `MIGRATIONS` in `packages/server/src/infra/storage/sqlite/migrations.ts`:

```sql
CREATE TABLE IF NOT EXISTS resources (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  version     TEXT NOT NULL DEFAULT '1.0.0',
  source      TEXT NOT NULL,                -- JSON-encoded ResourceSource
  scope       TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  targets     TEXT NOT NULL DEFAULT '[]',   -- JSON-encoded AgentTarget[]
  labels      TEXT,                         -- JSON-encoded Record<string,string> | NULL
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_id);
CREATE INDEX IF NOT EXISTS idx_resources_scope ON resources(scope);
CREATE INDEX IF NOT EXISTS idx_resources_kind  ON resources(kind);
```

No unique constraint on `key` at the DB level — uniqueness is (key, scope, owner)
and enforced in the route layer (read-then-write check), mirroring how the
profile name-uniqueness and last-admin protections work. This avoids a composite
unique index over a nullable `owner_id` (global rows have NULL owner).

### `sqliteResourceRepository` (repos.ts)

A new exported factory following the credential/mcp-server shape:

- `findById(id)` — `SELECT * FROM resources WHERE id = ?`.
- `findByKey(key, scope, ownerId?)` — `WHERE key = ? AND scope = ?` plus
  `owner_id = ?` when `ownerId` is given (personal); global rows match
  `owner_id IS NULL`. Build the WHERE dynamically like the existing `list()`.
- `list(filter?)` — dynamic WHERE over `kind`, `scope`, `ownerId`, `target`
  (target is `targets LIKE '%"target"%'` since it's a JSON array; acceptable for
  4.2's scale — a GIN index is premature).
- `save(resource)` — UPSERT keyed on `id` (INSERT … ON CONFLICT(id) DO UPDATE),
  matching the credential pattern. `source`/`targets`/`labels` are
  `JSON.stringify`-ed.
- `delete(id)` — `DELETE FROM resources WHERE id = ?`.

Row shape + `mapResource` mapper follow the existing `mapCredential`/
`mapMcpServer` conventions (JSON-parse `source`/`targets`/`labels`; omit
`description`/`labels` when null to match the optional domain fields).

### In-memory `resourceRepository` (memory/index.ts)

A real implementation replacing `memoryResourceStub`, mirroring the credential
repo: a `Map<string, Resource>`, `list()` filters over the array, `findByKey`
matches `(key, scope, owner)`. The stub file (`stub-repos.ts`) is **deleted**
once both drivers implement it — the `UnitOfWork` shape is complete.

Both drivers return `resources: ResourceRepository` in the `UnitOfWork` (replace
the `...memoryResourceStub()` spread in both `createSqliteUnitOfWork` and
`createMemoryUnitOfWork`).

## Shared schemas

New file `packages/shared/src/schemas/resource.ts` (mirrors `mcp.ts`):

```ts
const scopeSchema = z.enum(['global', 'personal']);
// resourceKindSchema + agentTargetSchema already exist in schemas/profile.ts;
// import them rather than redefining.

const resourceSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('git'),
    url: z.string().min(1),
    ref: z.string().optional(),
    path: z.string().optional(),
  }),
  z.object({ type: z.literal('tarball'), url: z.string().min(1), checksum: z.string().optional() }),
  z.object({ type: z.literal('local'), path: z.string().min(1) }),
  z.object({ type: z.literal('inline'), content: z.string() }),
]);

export const createResourceSchema = z.object({
  key: z.string().min(1).max(128),
  kind: resourceKindSchema,
  name: z.string().min(1).max(128),
  description: z.string().max(2048).optional(),
  version: z.string().min(1).max(64).default('1.0.0'),
  source: resourceSourceSchema,
  scope: scopeSchema,
  targets: z.array(agentTargetSchema).default([]),
  labels: z.record(z.string(), z.string()).optional(),
});
```

4.2/4.3 constrain `kind` to `'sub_agent' | 'rule'` at the **route layer** (not
the schema — the schema stays general so 4.4–4.6 don't need to touch it). A
create/update with `kind: 'skill'` is rejected `409 KIND_NOT_AVAILABLE` until
that kind's sub-phase ships.

`updateResourceSchema` = all fields optional except `kind` and `scope` are
**immutable** post-create (a resource's identity and visibility don't change;
mutate-by-recreate instead). PATCH of `kind`/`scope` → `409 RESOURCE_IMMUTABLE`.

Re-export from `packages/shared/src/index.ts`. Types `CreateResourceInput` /
`UpdateResourceInput` via `z.infer`.

## API surface

Route module `packages/server/src/modules/resources.ts`, registered in `app.ts`
(replacing the `// TODO: resources route module` comment). Scope rules identical
to credentials/mcp-servers.

| Method | Path                 | Auth        | Notes                                                                          |
| ------ | -------------------- | ----------- | ------------------------------------------------------------------------------ |
| POST   | `/api/resources`     | requireAuth | global⇒admin; kind constrained to sub_agent/rule (4.2/4.3); key uniqueness 409 |
| GET    | `/api/resources`     | requireAuth | query `?kind=&scope=&target=`; returns personal+global like mcp-servers        |
| GET    | `/api/resources/:id` | requireAuth | owner-or-admin for personal, else 404                                          |
| PATCH  | `/api/resources/:id` | requireAuth | owner-or-admin; kind/scope immutable (409)                                     |
| DELETE | `/api/resources/:id` | requireAuth | owner-or-admin; 404 not-found on others                                        |

**List behavior** mirrors `GET /api/mcp-servers`: returns the caller's personal
resources + all global resources. Query filters (`kind`/`scope`/`target`) map to
`ResourceListFilter`. For `scope=global` only globals; for `scope=personal` only
the caller's; default both.

**Create flow:**

1. `createResourceSchema.parse(body)`.
2. global scope + non-admin ⇒ 403.
3. kind not in the allowlist (sub_agent/rule) ⇒ 409 `KIND_NOT_AVAILABLE`.
4. `findByKey(key, scope, ownerId)` exists ⇒ 409 `RESOURCE_KEY_TAKEN`.
5. `generateId()`, timestamps, save, 201.

**Update flow:** parse, find existing (404 if missing/foreign), reject
kind/scope change (409 `RESOURCE_IMMUTABLE`), merge, bump `updatedAt`, save.

`serialize.ts` gets `resourceView(r: Resource): Resource` — the domain type
carries no secret, so the view is the resource as-is (kept as a named function
for symmetry with `credentialView` and future redaction).

## SDK

`packages/sdk-ts/src/index.ts`:

- Re-export `Resource`, `ResourceKind`, `AgentTarget` from `@harness-nexus/core`.
- Add `listResources(filter?)`, `getResource(id)`, `createResource(input)`,
  `updateResource(id, input)`, `deleteResource(id)`.
- `listResources` accepts an optional `{ kind?, scope?, target? }` and builds
  the query string. Response shapes: `{ resources: Resource[] }` /
  `{ resource: Resource }`.

## Web

### Resource browser — `apps/web/src/pages/Resources.tsx`

Structure mirrors `Profiles.tsx` / `Credentials.tsx` (list card + filter bar +
create/edit via Dialog). New nav item **"Resources"** (`/resources`,
`BoxesIcon`), all roles (personal + visible globals).

- **Filter bar:** `kind` Select (All / Sub-agent / Rule — only the shipped kinds
  offered; skill/hook/command appear when their sub-phase lands) + `scope`
  Select (All / Personal / Global). Filters drive `api.listResources(filter)`.
- **Table columns:** Name / Kind (badge) / Key (`font-mono`) / Scope (badge,
  Globe/User icon like credentials) / Updated / Actions.
- **Create:** a "New resource" button opens the create Dialog. The kind is
  chosen in the dialog; the form swaps to the kind's editor fields.
- **Edit / Delete:** row DropdownMenu (Edit opens the Dialog pre-filled; Delete
  confirms then `api.deleteResource`).

### Kind editors (sub-agent, rule)

A shared `ResourceEditor` Dialog component (module scope) renders common fields

- a kind-specific body. Common: key (mono, `spellCheck=false`), name,
  description, version, scope (admin-only global toggle), targets (checkboxes of
  the 4 targets for simplicity in 4.2). Kind-specific:

* **Sub-agent:** a `Textarea` labeled "System prompt" → `source.inline.content`.
* **Rule:** a `Textarea` labeled "Policy / guideline" → `source.inline.content`.

Both force `source.type = 'inline'` (the only variant the markdown editors
produce). The Dialog reuses `components/ui/dialog.tsx` (built in 4.1).

### Wiring

`App.tsx`: `<Route path="/resources" element={<RequireAuth><ResourcesPage/></RequireAuth>} />`.
`app-shell.tsx`: add to `navItems()` after Profiles, before Credentials
(logical grouping: bundle-like things together).

## Scope matrix

Same as credentials & mcp-servers (unchanged):

|       | list global | list personal | create global | create personal | mutate own | mutate foreign |
| ----- | ----------- | ------------- | ------------- | --------------- | ---------- | -------------- |
| admin | ✓           | ✓             | ✓             | ✓               | ✓          | ✓ (admin)      |
| user  | ✓           | ✓             | ✗ 403         | ✓               | ✓          | ✗ 404          |

Not-found returns `404` (not `403`) to avoid leaking existence — identical to
credentials.

## Testing

Extend `scripts/smoke.mjs` with a `[4.2]` block:

- user creates a personal `sub_agent` resource (201), inline body.
- admin creates a global `rule` resource (201).
- list returns personal + global.
- non-admin global create ⇒ 403.
- duplicate key in same scope ⇒ 409.
- kind `skill` rejected ⇒ 409 `KIND_NOT_AVAILABLE` (until 4.4).
- PATCH kind ⇒ 409 `RESOURCE_IMMUTABLE`.
- non-admin accessing another's personal resource ⇒ 404.
- `?kind=` / `?scope=` filtering.

Asserts status codes + response shapes against a memory-driver server. No live
tool boot.

## Out of scope (deferred)

- skill/hook/command kinds (4.4–4.6, pending research) — the allowlist blocks them.
- external `ResourceSource` variants (git/tarball/local) in the UI — the schema
  accepts them, but only `inline` is produced by the 4.2/4.3 editors.
- profile-entry resource picker (data model already supports `kind:key`; the
  picker UI is a follow-on).
- resource version history / diffing.

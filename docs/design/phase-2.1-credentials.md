# MCP connection config & credential management (Phase 2.1)

> Status: implemented. Covers the **configuration layer** for connecting
> AgentNexus to upstream MCP servers (as a client) plus the encrypted
> **credential** store. This sub-phase does **not** include live MCP traffic —
> the registry/proxy that resolves and dials the configured connections lands
> in 2.2 (see "Out of scope" below). MCP `mode` (proxy/direct) and stdio
> re-enablement are Phase 3.1 (see `phase-3-install.md`).

## Why split this out

Phase 2 as a whole is large: credentials + MCP client config + the live registry
+ profile organization + callable-function scripts. 2.1 delivers the storage,
API, and UI surface for *describing* connections so that 2.2 can focus purely on
*dialing and aggregating* them. Everything in 2.1 is pure CRUD over structured
config — no subprocesses, no network egress, no MCP protocol handling.

## Two new concepts

### 1. Credential (a named encrypted secret)

A `Credential` is a reusable, named secret that AgentNexus injects into an MCP
transport at resolve time. It is referenced by **name** via a `${cred:NAME}`
placeholder inside any transport string field (url, command, args, env values,
header values); the placeholder is replaced with the decrypted plaintext when
the connection is opened (proxy mode) or at install time (direct mode). It is
**distinct** from a `PersonalAccessToken`, which authenticates a user *into*
AgentNexus.

```ts
// packages/core/src/domain/credential.ts
interface Credential {
  id: string;
  name: string;
  /** AES-256-GCM ciphertext (base64); plaintext never returned by the API. */
  secret: string;
  scope: 'global' | 'personal';
  /** null iff scope === 'global'; otherwise the owning user id. */
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}
```

A credential is a **pure named secret** — no `kind`, no type discriminator. The
name is the placeholder handle (`${cred:NAME}`), so it should be
human-meaningful (e.g. `context7-key`, `acme-token`).

- **global** — shared across the instance. Any authenticated user can *read*
  (they need to reference it), but only admins can create/update/delete.
- **personal** — owned by the creator. Only the owner can read, update, or
  delete it.

The `secret` field is **write-only at the API boundary**: create/update accept
plaintext, but every read path returns a masked `secretPreview` (first 3 + `…` +
last 3 characters) instead of the plaintext or ciphertext. The plaintext is
decrypted server-side only at resolve time (2.2 proxy connect / 3.3 direct
install).

### 2. MCP server record (`McpServer`, with mode + placeholder-bearing transport)

The `McpServer` domain entity is the record of an MCP server this instance knows
about. Each carries a `mode` (Phase 3.1):

- **`proxy`** — AgentNexus dials the upstream and re-exposes it via `/mcp`.
  Only SSE / Streamable HTTP. Pooled by the registry when `proxied: true`.
- **`direct`** — the target tool dials the upstream itself. SSE / Streamable
  HTTP **and stdio**. AgentNexus stores the connection + encrypted credentials
  only; it never opens the connection. stdio forces `direct`.

```ts
type McpTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'streamable-http'; url: string; headers?: Record<string, string> };
```

Credential secrets are referenced as `${cred:NAME}` placeholders **directly in
the transport string fields** — in `url`, `command`, `args[]`, `env` values, and
`headers` values. There is no separate `credentialBindings` map; the placeholder
*is* the binding.

```jsonc
// HTTP, proxy mode — headers edited as JSON:
{
  "type": "streamable-http",
  "url": "https://mcp.example.com/mcp",
  "headers": { "Authorization": "Bearer ${cred:acme-token}" }
}

// stdio, direct mode — placeholder in args:
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@upstash/context7-mcp", "--api-key", "${cred:context7-key}"]
}
```

## Placeholder interpolation

`packages/shared/src/utils/placeholders.ts` exports the resolution machinery:

- **`CRED_PLACEHOLDER_RE`** — `/\$\{cred:([^}]+)\}/g`. Matches `${cred:NAME}`.
- **`credPlaceholder(name)`** — returns the literal `${cred:NAME}` string (for UI hints).
- **`resolvePlaceholders(str, lookup)`** — scans `str` for every `${cred:NAME}`
  token, calls `lookup(name)` (which decrypts and returns the plaintext), and
  substitutes. Unknown name → `lookup` throws, which surfaces as a connection
  error (proxy) / install error (direct). Resolutions are cached per-name within
  a single call so a name referenced twice is decrypted once.

**Resolution timing:**

| mode | when | where | plaintext lifetime |
| --- | --- | --- | --- |
| `proxy` | connect time | `McpRegistry.resolveHeaders` / `resolveUrl` | in-memory only, discarded after dial |
| `direct` | install time | Phase 3.3 target writer | written into the emitted plugin config (bundle is sensitive) |

In 2.1 scope, the server stores placeholders verbatim — it does not validate
that `${cred:X}` references a real credential at create time. A dangling
placeholder surfaces as a connection error when the proxy actually dials
(proxy) or when the writer emits the bundle (direct, 3.3). This is acceptable
because it cannot cause a silent failure.

## stdio policy

**Supported in `direct` mode only.** stdio is the most common transport for
local tools (filesystem, shell, language runtimes), but spawning third-party
subprocesses on the AgentNexus host is the highest-risk transport. The `mode`
field resolves this cleanly:

- `stdio` + `direct` → accepted. AgentNexus never spawns the process; the target
  tool does, locally, at install time.
- `stdio` + `proxy` → rejected with `409 STDIO_REQUIRES_DIRECT`.

The registry only ever dials `mode === 'proxy'` rows, so a stdio server (which
forces `direct`) never enters the connection pool.

## Scope & permission matrix

Applies identically to **credentials** and **mcp-servers**. The instance-level
auth guards (`requireAuth` / `requireAdmin` from Phase 1) are the first gate; the
per-resource ownership check layers on top.

| Operation            | `global` scope             | `personal` scope          |
| -------------------- | -------------------------- | ------------------------- |
| List / get           | any authenticated user     | owner only                |
| Create               | admin only                 | any authenticated user    |
| Update / delete      | admin only                 | owner only                |

Not-found returns `404` (not `403`) to avoid leaking existence.

## Credential encryption

- **Algorithm**: AES-256-GCM (`node:crypto`), random 12-byte IV per record.
- **Wire format**: `base64(iv) : base64(ciphertext) : base64(tag)`.
- **Key source**: `CREDENTIAL_ENCRYPTION_KEY` env var. If unset, falls back to
  `JWT_SECRET` so a dev instance boots with no extra config. The key is hashed
  to 32 bytes via sha256 before use (any length input is acceptable).
- **At rest**: only the ciphertext blob is stored in the `credentials.secret`
  column. Plaintext is held in memory only for the duration of a create/update
  request (to encrypt) and, at resolve time, for the duration of a placeholder
  substitution.
- **Key rotation**: not automated. Rotating `CREDENTIAL_ENCRYPTION_KEY`
  invalidates existing ciphertexts (decryption fails → connection errors). A
  re-encryption migration is a later concern.

`maskSecret` (used in every API response) shows `prefix(3) + '…' + suffix(3)`
for secrets ≥ 8 chars; shorter secrets become `***`. The point is UI
recognition, not security — the ciphertext is already unrecoverable from the
API.

## API surface (Phase 2.1)

All under `/api`, JSON bodies. Same `{ error, message }` error shape as Phase 1.

| Method | Path                    | Auth           | Notes                                                                       |
| ------ | ----------------------- | -------------- | --------------------------------------------------------------------------- |
| POST   | `/api/credentials`      | `requireAuth`† | create; admin required iff `scope === 'global'`; returns masked view        |
| GET    | `/api/credentials`      | `requireAuth`  | list caller's personal + all global; secrets masked                         |
| PATCH  | `/api/credentials/:id`  | `requireAuth`‡ | update name/secret; owner-or-admin                                          |
| DELETE | `/api/credentials/:id`  | `requireAuth`‡ | delete; owner-or-admin                                                      |
| POST   | `/api/mcp-servers`      | `requireAuth`† | create; admin required iff `scope === 'global'`; accepts `mode` + transport |
| GET    | `/api/mcp-servers`      | `requireAuth`  | list caller's personal + all global                                         |
| PATCH  | `/api/mcp-servers/:id`  | `requireAuth`‡ | update; owner-or-admin                                                      |
| DELETE | `/api/mcp-servers/:id`  | `requireAuth`‡ | delete; owner-or-admin                                                      |

† `requireAuth` plus an in-handler scope check: creating a `global` record
requires `role === 'admin'`, else `403 FORBIDDEN`.
‡ `requireAuth` plus an ownership check: the caller must own the record (for
`personal`) or be an admin (for `global`), else `404 NOT_FOUND` (404, not 403,
to avoid leaking existence).

## Validation source of truth

Zod schemas in `packages/shared/src/schemas/mcp.ts`:

- `createCredentialSchema`, `updateCredentialSchema` — `{ name, secret, scope }`
  (no `kind`).
- `mcpTransportSchema` — `z.discriminatedUnion('type', [...])` accepting
  `stdio`, `sse`, `streamable-http`. Header values may carry `${cred:...}`.
- `createMcpServerSchema`, `updateMcpServerSchema` — include `mode`
  (default `'proxy'`). The stdio+proxy rule is enforced in the route handler
  (`409 STDIO_REQUIRES_DIRECT`), not in zod, so the error carries the right code.

Placeholder resolution helpers in
`packages/shared/src/utils/placeholders.ts` (see above).

Server, SDK, and web share these via inferred types.

## Web UI

- **Credentials page** (`/credentials`): table of Name / Placeholder / Preview /
  Scope. The Placeholder column shows `${cred:NAME}` so the user knows what to
  paste into transport fields. Create form: Name / Secret / Scope (no Kind).
- **MCP management page** (`/mcp-servers`): create form with Mode, Transport,
  and per-transport fields. HTTP transports show a **custom-headers JSON editor**
  (default `{"Authorization": "Bearer ${cred:token}"}`). stdio shows command /
  args / optional env JSON editor. **Placeholder chips** list available
  `${cred:NAME}` tokens (click to copy). An **Import JSON** button opens a modal
  that parses a single-entry `{ "mcpServers": { "name": {...} } }` blob, infers
  mode, and fills the form.

## Out of scope (deferred)

- **2.2 — live registry & proxy**: `McpRegistry` that reads configured
  `mcpServers`, dials the `proxy` ones with the SDK's `Client` + transports,
  resolves `${cred:...}` placeholders into real values, aggregates tools, and
  re-exposes via `mountMcpProxy` (Streamable HTTP + SSE). Profile CRUD and
  PAT+profile routing also land here.
- **3.3 — direct-mode placeholder resolution at install time**: the target
  writer substitutes `${cred:...}` with decrypted plaintext in the emitted
  plugin config.
- **2.3 — callable-function scripts**: admin-authored JS functions wrapping
  vendor APIs as MCP tools, executed in a sandbox.
- Resource/skill/hook/rule/sub-agent management — separate later work.
- Credential rotation/expiry, key re-encryption migration.

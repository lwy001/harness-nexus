# MCP connection config & credential management (Phase 2.1)

> Status: implemented in Phase 2.1. Covers the **configuration layer** for
> connecting AgentNexus to upstream MCP servers (as a client), plus the encrypted
> **credential** store used to authenticate those connections. This sub-phase does
> **not** include live MCP traffic — the registry/proxy that resolves and dials
> the configured connections lands in 2.2 (see "Out of scope" below).

## Why split this out

Phase 2 as a whole is large: credentials + MCP client config + the live registry
+ profile organization + callable-function scripts. 2.1 delivers the storage,
API, and UI surface for *describing* connections so that 2.2 can focus purely on
*dialing and aggregating* them. Everything in 2.1 is pure CRUD over structured
config — no subprocesses, no network egress, no MCP protocol handling.

## Two new concepts

### 1. Credential (secrets used to call *upstream* MCP servers)

A `Credential` is a reusable secret that AgentNexus injects into request headers
when it connects to a third-party MCP server (e.g. a Bearer token for a hosted
MCP, an API key for a vendor's tool API). It is **distinct** from a
`PersonalAccessToken`, which authenticates a user *into* AgentNexus.

```ts
// packages/core/src/domain/credential.ts
type CredentialKind = 'bearer' | 'api_key' | 'basic' | 'custom';

interface Credential {
  id: string;
  name: string;
  secret: string;        // AES-256-GCM ciphertext (base64); plaintext never returned by the API
  kind?: CredentialKind;
  scope: 'global' | 'personal';
  ownerId: string | null; // null iff scope === 'global'
  createdAt: string;
  updatedAt: string;
}
```

- **global** — shared across the instance. Any authenticated user can *read*
  (they need to reference it from a profile/connection), but only admins can
  create/update/delete.
- **personal** — owned by the creator. Only the owner can read, update, or
  delete it.

The `secret` field is **write-only at the API boundary**: create/update accept
plaintext, but every read path returns a masked `secretPreview` (first 3 + `…` +
last 3 characters) instead of the plaintext or ciphertext. The plaintext is
decrypted server-side only at connection time (2.2).

### 2. MCP client connection (`McpServer`, extended)

The existing `McpServer` domain entity is the record of an upstream MCP server
this instance can connect to. 2.1 extends the `sse` / `streamable-http`
transport variants with optional **credential bindings** so a configured
credential can be attached to a named header without pasting the secret inline:

```ts
type McpTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'sse';
      url: string;
      headers?: Record<string, string>;
      credentialBindings?: Record<string, string>; // headerName → credentialId
    }
  | {
      type: 'streamable-http';
      url: string;
      headers?: Record<string, string>;
      credentialBindings?: Record<string, string>;
    };
```

`credentialBindings` is purely additive (optional), so existing rows are
unaffected. `headers` remains for static, non-secret values; anything sensitive
should go through a binding so the value never sits in plaintext in the
`transport` JSON column.

> 2.1 stores bindings verbatim and validates that each referenced credential is
> reachable by the connection's owner (global, or personal-owned-by-same-user).
> It does **not** resolve them into live headers — that happens in 2.2's
> registry when a connection is actually opened.

## stdio policy

**Not supported in 2.1.** Spawning third-party subprocesses on the AgentNexus
host is the highest-risk transport (arbitrary command execution; a malicious
repo could ship a `stdio` MCP that runs anything). The domain `McpTransport`
union keeps the `stdio` variant so the type system stays honest about the full
protocol surface, but:

- The create/update zod schemas (`packages/shared/src/schemas/mcp.ts`) accept
  only `sse` and `streamable-http`.
- The web UI shows a disabled "stdio (暂不支持)" option for discoverability, but
  it cannot be selected.

stdio may return in a later sub-phase behind an admin allowlist + sandbox.

## Scope & permission matrix

Applies identically to **credentials** and **mcp-servers**. The instance-level
auth guards (`requireAuth` / `requireAdmin` from Phase 1) are the first gate; the
per-resource ownership check layers on top.

| Operation            | `global` scope             | `personal` scope          |
| -------------------- | -------------------------- | ------------------------- |
| List / get           | any authenticated user     | owner only                |
| Create               | admin only                 | any authenticated user    |
| Update / delete      | admin only                 | owner only                |

Cross-reference rule: when an `mcp-server` carries a `credentialBindings` entry,
the referenced credential must be either `global` or `personal`-owned-by-the-same
user as the `mcp-server`. Otherwise the create/update is rejected with
`409 CREDENTIAL_NOT_ACCESSIBLE`. This stops a user from binding an admin's global
secret to a personal connection in a way that would later fail at resolve time.

## Credential encryption

- **Algorithm**: AES-256-GCM (`node:crypto`), random 12-byte IV per record.
- **Wire format**: `base64(iv) : base64(ciphertext) : base64(tag)`.
- **Key source**: `CREDENTIAL_ENCRYPTION_KEY` env var. If unset, falls back to
  `JWT_SECRET` so a dev instance boots with no extra config. The key is hashed
  to 32 bytes via sha256 before use (any length input is acceptable).
- **At rest**: only the ciphertext blob is stored in the `credentials.secret`
  column. Plaintext is held in memory only for the duration of a create/update
  request (to encrypt) and, in 2.2, for the duration of a connection dial (to
  decrypt).
- **Key rotation**: not automated in 2.1. Rotating `CREDENTIAL_ENCRYPTION_KEY`
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
| PATCH  | `/api/credentials/:id`  | `requireAuth`‡ | update name/kind/secret; owner-or-admin                                     |
| DELETE | `/api/credentials/:id`  | `requireAuth`‡ | delete; owner-or-admin                                                      |
| POST   | `/api/mcp-servers`      | `requireAuth`† | create; admin required iff `scope === 'global'`; validates credential refs  |
| GET    | `/api/mcp-servers`      | `requireAuth`  | list caller's personal + all global                                         |
| PATCH  | `/api/mcp-servers/:id`  | `requireAuth`‡ | update; owner-or-admin; re-validates credential refs                        |
| DELETE | `/api/mcp-servers/:id`  | `requireAuth`‡ | delete; owner-or-admin                                                      |

† `requireAuth` plus an in-handler scope check: creating a `global` record
requires `role === 'admin'`, else `403 FORBIDDEN`.
‡ `requireAuth` plus an ownership check: the caller must own the record (for
`personal`) or be an admin (for `global`), else `404 NOT_FOUND` (404, not 403,
to avoid leaking existence).

## Validation source of truth

Zod schemas in `packages/shared/src/schemas/mcp.ts`:

- `createCredentialSchema`, `updateCredentialSchema`
- `mcpTransportSchema` — `z.discriminatedUnion('type', [...])` accepting only
  `sse` / `streamable-http` (stdio deliberately excluded here)
- `createMcpServerSchema`, `updateMcpServerSchema`

Server, SDK, and web share these via inferred types.

## Out of scope (deferred)

- **2.2 — live registry & proxy**: `McpRegistry` that reads configured
  `mcpServers`, dials them with the SDK's `Client` + transports, resolves
  `credentialBindings` into real headers, aggregates tools, and re-exposes via
  `mountMcpProxy` (Streamable HTTP + SSE). Profile CRUD and PAT+profile routing
  also land here.
- **2.3 — callable-function scripts**: admin-authored JS functions wrapping
  vendor APIs as MCP tools, executed in a sandbox (`isolated-vm` or
  `worker_threads`).
- Resource/skill/hook/rule/sub-agent management — separate later work.
- Credential rotation/expiry, key re-encryption migration.

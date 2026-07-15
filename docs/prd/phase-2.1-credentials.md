# PRD: Phase 2.1 — MCP connection config & credential management

> Status: implemented. Technical design: `docs/design/phase-2.1-credentials.md`.

## Problem Statement

To aggregate upstream MCP servers (Phase 2.2), AgentNexus first needs a way to
*describe* those connections — their transport (SSE, Streamable HTTP, or stdio),
their endpoints, and the secrets needed to authenticate to them. Many hosted MCP
servers and vendor APIs require a Bearer token or API key in a header, and stdio
servers often take an API key as a command-line argument or environment variable.
There is no place to store those descriptions or those secrets, and pasting
secrets inline into connection config is insecure. Administrators and users need
a managed, encrypted credential store and a connection registry where a
credential can be injected into any transport field without exposing the
plaintext.

## Solution

A configuration layer with two concepts:

1. **Credential** — a reusable, AES-256-GCM-encrypted *named secret*. It carries
   only a name and a secret (no `kind`, no type). The name is the handle used to
   reference it elsewhere. Both support global (admin-managed, shared) and
   personal (owner-only) scoping.
2. **MCP server record** (an `McpServer` row) describing an upstream server, its
   transport, and its `mode` (`proxy` — AgentNexus dials it; `direct` — the
   target tool dials it). A credential's secret is injected via **placeholder
   interpolation**: a `${cred:NAME}` token written inside any transport string
   field (url, command, args, env values, header values) is replaced with the
   decrypted plaintext at resolve time.

This phase stores config only; live aggregation is Phase 2.2, and placeholder
resolution for direct mode happens at install time (Phase 3.3).

## User Stories

1. As an admin, I want to store an upstream MCP server's token as a credential, so that it isn't pasted into plaintext config.
2. As an admin, I want credentials encrypted at rest, so that a database leak doesn't expose them.
3. As an admin, I want credentials never returned in plaintext by the API, so that they can't be exfiltrated via a read.
4. As a user, I want a masked preview of a credential, so that I can recognize which one it is without seeing the value.
5. As a user, I want to create a personal credential, so that my own MCP connections can use it.
6. As an admin, I want to create a global credential, so that all users' connections can share it.
7. As a user, I want to see global credentials, so that I can reference them in my connections.
8. As a non-admin, I want to be blocked from creating or mutating global credentials, so that shared secrets stay admin-controlled.
9. As a user, I want only my personal credentials listed (plus globals), so that other users' secrets are hidden.
10. As an admin, I want to register an upstream MCP server with an SSE or Streamable HTTP transport, so that it can be aggregated later.
11. As a user, I want to inject a credential into an HTTP header via a `${cred:NAME}` placeholder, so that the upstream receives the right auth without me handling the secret.
12. As a user, I want to inject a credential into a stdio command, args, or env via a `${cred:NAME}` placeholder, so that local tools that take an API key on the command line are supported.
13. As a user, I want to write custom headers as JSON (e.g. `{"Authorization": "Bearer ${cred:token}"}`), so that I control exactly which headers are sent.
14. As a user, I want to see the available `${cred:NAME}` placeholders listed in the MCP form, so that I know what to paste.
15. As a user, I want to import an MCP server config from a JSON blob (`{ "mcpServers": { "name": {...} } }`), so that I don't hand-type vendor-provided config.
16. As a user, I want multi-entry JSON import rejected with a clear message, so that I import one server at a time deliberately.
17. As a developer, I want stdio supported in `direct` mode only, so that AgentNexus never spawns a third-party subprocess but local tools still work.
18. As a developer, I want config validated by shared zod schemas, so that server, SDK, and web agree on accepted shapes.
19. As a user, I want to delete my own credential, so that I can retire a leaked token.
20. As an admin, I want to delete a global credential, so that shared secrets can be rotated out.
21. As a non-admin, I want a "not found" (not "forbidden") when touching someone else's credential, so that existence isn't leaked.

## Implementation Decisions

- **Credential ≠ PAT.** A `PersonalAccessToken` authenticates a user *into*
  AgentNexus; a `Credential` authenticates AgentNexus *out to* an upstream.
- **Credential is a pure named secret:** `{ name, secret, scope, ownerId }`. No
  `kind` field — a credential is transport-agnostic; its name is the placeholder
  handle.
- **Encryption:** AES-256-GCM (`node:crypto`), random 12-byte IV per record, wire
  format `base64(iv):base64(ct):base64(tag)`. Key from
  `CREDENTIAL_ENCRYPTION_KEY` env, falling back to `JWT_SECRET` (sha256-derived
  to 32 bytes).
- **Secret is write-only at the API:** create/update accept plaintext; every
  read returns a masked `secretPreview` (first 3 + `…` + last 3, or `***`).
  Plaintext is decrypted only at resolve time.
- **Placeholder interpolation:** a credential is referenced by name as
  `${cred:NAME}` inside any transport string field (url, command, args, env
  values, header values). The `resolvePlaceholders` helper
  (`packages/shared/src/utils/placeholders.ts`) scans a string, looks up the
  credential by name, decrypts, and substitutes.
  - **proxy mode:** resolved server-side at connect time in `McpRegistry`
    (plaintext in memory only, never persisted).
  - **direct mode:** resolved at install time by the Phase 3.3 writer (the tool
    dials the connection, so the placeholder becomes a literal in the emitted
    plugin config; the bundle is then sensitive).
- **MCP mode (`proxy` | `direct`):** `proxy` — AgentNexus dials; SSE / HTTP only.
  `direct` — the tool dials; SSE / HTTP / stdio. stdio forces `direct`
  (`409 STDIO_REQUIRES_DIRECT`). See Phase 3.1 design.
- **Custom headers:** HTTP transports accept a `headers` record whose values may
  carry `${cred:NAME}` placeholders. The web UI edits headers as JSON, defaulting
  to `{"Authorization": "Bearer ${cred:token}"}`.
- **Scope model (identical for credentials and mcp-servers):** `global` is
  readable by any authenticated user but admin-only to mutate; `personal` is
  owner-only for all operations. Instance-level guards first, per-record
  ownership (owner-or-admin) on top. Not-found returns `404` (not `403`).
- **JSON import:** the web "Import JSON" button parses a single-entry
  `{ "mcpServers": { "name": {...} } }` blob, infers mode (`command` → direct,
  `serverUrl`/`url` → proxy), and fills the create form. Multi-entry blobs are
  rejected with a toast.
- **API surface:** `/api/credentials` (POST/GET/PATCH/DELETE),
  `/api/mcp-servers` (POST/GET/PATCH/DELETE), `/api/mcp-servers/status`.
- **Migration:** SQLite migration v2 adds `credentials` and `mcp_servers` tables.

## Testing Decisions

- HTTP smoke tests (`scripts/smoke.mjs`) cover: personal/global credential
  creation, secret masking + omission, scope permission denials, global
  credential delete by non-admin (404), mcp-server creation with a
  `${cred:NAME}` placeholder in headers, stdio+direct accepted (201),
  stdio+proxy rejected (409), non-admin global mcp-server rejection (403).
- Tests assert status codes and response shapes (external behavior).

## Out of Scope

- Live MCP registry / aggregation / proxy re-exposure (Phase 2.2).
- Placeholder resolution for direct mode at install time (Phase 3.3).
- Profile CRUD + PAT+profile routing (Phase 2.2).
- callable-function scripts (Phase 2.3).
- Validating `${cred:NAME}` references a real credential at create time
  (deferred to resolve time — a dangling ref surfaces as a connection error).
- Credential rotation/expiry and key re-encryption migration.

## Further Notes

- Full technical design (entity shapes, encryption details, placeholder
  semantics, scope matrix, API table, stdio policy) lives in
  `docs/design/phase-2.1-credentials.md`.
- `CREDENTIAL_ENCRYPTION_KEY` falls back to `JWT_SECRET`, so no extra env is
  needed for a dev instance to boot.

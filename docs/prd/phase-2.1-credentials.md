# PRD: Phase 2.1 — MCP connection config & credential management

> Status: implemented. Technical design: `docs/design/phase-2.1-credentials.md`.

## Problem Statement

To aggregate upstream MCP servers (Phase 2.2), AgentNexus first needs a way to
*describe* those connections — their transport (SSE or Streamable HTTP), their
URLs, and crucially the secrets needed to authenticate to them. Many hosted MCP
servers and vendor APIs require a Bearer token or API key in a request header.
Today there is no place to store those descriptions or those secrets, and pasting
secrets inline into connection config is insecure. Administrators and users need
a managed, encrypted credential store and a connection registry where a
credential can be attached to a specific header without exposing the plaintext.

## Solution

A configuration layer with two new concepts. First, a **Credential** — a
reusable, AES-256-GCM-encrypted secret that AgentNexus injects into upstream
request headers at connect time. Second, an **MCP client connection** record (an
`McpServer` row) describing an upstream server and its transport, with optional
`credentialBindings` mapping a header name to a stored credential. Both support
global (admin-managed, shared) and personal (owner-only) scoping, with the same
permission model. This phase stores config only; live aggregation is Phase 2.2.

## User Stories

1. As an admin, I want to store an upstream MCP server's Bearer token as a credential, so that it isn't pasted into plaintext config.
2. As an admin, I want credentials encrypted at rest, so that a database leak doesn't expose them.
3. As an admin, I want credentials never returned in plaintext by the API, so that they can't be exfiltrated via a read.
4. As a user, I want a masked preview of a credential, so that I can recognize which one it is without seeing the value.
5. As a user, I want to create a personal credential, so that my own MCP connections can use it.
6. As an admin, I want to create a global credential, so that all users' connections can share it.
7. As a user, I want to see global credentials, so that I can reference them in my connections.
8. As a non-admin, I want to be blocked from creating or mutating global credentials, so that shared secrets stay admin-controlled.
9. As a user, I want only my personal credentials listed (plus globals), so that other users' secrets are hidden.
10. As an admin, I want to register an upstream MCP server with an SSE transport, so that it can be aggregated later.
11. As an admin, I want to register an upstream MCP server with a Streamable HTTP transport, so that modern servers are supported.
12. As a user, I want to bind a credential to a specific header on a connection, so that the upstream receives the right auth without me handling the secret.
13. As a user, I want a connection rejected if it binds a credential I can't access, so that I don't create a connection that will fail at dial time.
14. As a developer, I want stdio transport unsupported, so that arbitrary subprocess execution on the host is avoided.
15. As a developer, I want the domain `McpTransport` union to keep the stdio variant, so that the type system stays honest about the protocol.
16. As a user, I want the web UI to show a disabled "stdio (not supported)" option, so that I understand it's a deliberate omission.
17. As a developer, I want config validated by shared zod schemas, so that server, SDK, and web agree on accepted shapes.
18. As a user, I want to delete my own credential, so that I can retire a leaked token.
19. As an admin, I want to delete a global credential, so that shared secrets can be rotated out.
20. As a non-admin, I want a "not found" (not "forbidden") when touching someone else's credential, so that existence isn't leaked.

## Implementation Decisions

- **Credential ≠ PAT.** A `PersonalAccessToken` authenticates a user *into*
  AgentNexus; a `Credential` authenticates AgentNexus *out to* an upstream.
- **Encryption:** AES-256-GCM (`node:crypto`), random 12-byte IV per record, wire
  format `base64(iv):base64(ct):base64(tag)`. Key from
  `CREDENTIAL_ENCRYPTION_KEY` env, falling back to `JWT_SECRET` (sha256-derived
  to 32 bytes).
- **Secret is write-only at the API:** create/update accept plaintext; every
  read returns a masked `secretPreview` (first 3 + `…` + last 3, or `***`).
  Plaintext is decrypted only at connect time (Phase 2.2).
- **`credentialBindings`:** on `sse` / `streamable-http` transports, an optional
  `Record<headerName, credentialId>`. Static `transport.headers` remain for
  non-secret values; bindings win on conflict. Additive (backwards-compatible).
- **Scope model (identical for credentials and mcp-servers):** `global` is
  readable by any authenticated user but admin-only to mutate; `personal` is
  owner-only for all operations. Instance-level guards first, per-record
  ownership (owner-or-admin) on top. Not-found returns `404` (not `403`).
- **stdio unsupported:** the create/update zod schemas accept only `sse` and
  `streamable-http`; the domain union keeps `stdio` as a documented-but-rejected
  variant.
- **Cross-reference validation:** an mcp-server's `credentialBindings` must
  resolve to a global credential or one owned by the same user, else
  `409 CREDENTIAL_NOT_ACCESSIBLE`.
- **API surface:** `/api/credentials` (POST/GET/PATCH/DELETE),
  `/api/mcp-servers` (POST/GET/PATCH/DELETE).
- **Migration:** SQLite migration v2 adds `credentials` and `mcp_servers` tables.

## Testing Decisions

- HTTP smoke tests (`scripts/smoke.mjs`) cover: personal/global credential
  creation, secret masking + omission, scope permission denials, global
  credential delete by non-admin (404), mcp-server creation with a credential
  binding, unreachable-binding rejection (409), stdio rejection (400), non-admin
  global mcp-server rejection (403).
- Tests assert status codes and response shapes (external behavior).

## Out of Scope

- Live MCP registry / aggregation / proxy re-exposure (Phase 2.2).
- Resolving `credentialBindings` into live headers (Phase 2.2, at connect time).
- Profile CRUD + PAT+profile routing (Phase 2.2).
- callable-function scripts (Phase 2.3).
- stdio transport behind an allowlist + sandbox (future).
- Credential rotation/expiry and key re-encryption migration.

## Further Notes

- Full technical design (entity shapes, encryption details, scope matrix, API
  table, stdio policy) lives in `docs/design/phase-2.1-credentials.md`.
- `CREDENTIAL_ENCRYPTION_KEY` falls back to `JWT_SECRET`, so no extra env is
  needed for a dev instance to boot.

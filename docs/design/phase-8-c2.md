# Design: Phase 8 C2 — client MCP serving (shims, dial-site routing, `/mcp` outlet narrowing)

> Status: **implemented** (branch `phase-8-c2`). Parent design:
> `docs/design/phase-8-client.md` § "MCP serving model (C2)". PRD:
> `docs/prd/phase-8-client.md` (locked decisions #1/#2/#4). C1:
> `docs/design/phase-8-c1.md` (shipped — machines, realtime v0).
> Verification: shared 33 (dial-site matrix), server 23 (client-config contract
> incl. secret-leak assertions + 409 matrix), shim E2E
> `scripts/test-hnx-mcp-serve.mjs` 5/5 (config fetch → stdio dial → namespaced
> serving → call round-trip with the resolved secret), smoke `[8 C2]` block —
> 192/192 overall.

## Scope

C2 moves MCP serving to the client and deletes the proxy/direct split:

1. **Model**: `McpServer.mode` is replaced by `dialSite: 'auto' | 'client' | 'server'`;
   `Credential` gains `distributable` (personal ⇒ always true; global ⇒ admin
   opt-in, default false). stdio can never be server-dialed (auto ⇒ client;
   explicit `'server'` + stdio → `409 STDIO_REQUIRES_CLIENT`).
2. **Dial-site derivation** (pure, in `shared`): `auto` ⇒ client iff every
   `${cred:NAME}` the transport references is distributable (or none), else
   server. Unit-tested; used by BOTH the server (pool filter + config API) and
   the shim (informational).
3. **`packages/mcp-runtime`** (new): transport-facing pool extracted from
   `McpRegistry` — dial upstreams (sse / streamable-http / **stdio**, the new
   one), aggregate namespaced tools, route calls. Takes
   `UpstreamDefinition[]` with **already-resolved** transports; placeholder
   resolution stays with the callers. Server registry keeps config loading +
   resolution + 2.4 surface and delegates pool ops; the shim reuses the pool
   directly.
4. **`GET /api/client/mcp-config?profile=<id>`**: the shim's config fetch.
   Custom auth (like the marketplace routes): accepts an api PAT/JWT **or a
   machine PAT** (`machine-ctl` scope — the one REST exception, bound to its
   machine's owner). Returns resolved transports for client-dialed servers
   ONLY; server-dialed servers are listed by name with no transport, plus a
   `platform` block iff any entry is server-dialed. Secret-leak assertions:
   non-distributable plaintext never appears.
5. **Outlet narrowing**: the server registry pools exactly the
   resolves-to-server rows; `/mcp` (Streamable HTTP + SSE) keeps its contract
   unchanged. The shim dials the outlet as ONE passthrough upstream when the
   profile has server-dialed entries (outlet tools arrive already namespaced —
   the shim must NOT re-namespace them).
6. **`hnx mcp serve --profile <id> [--server <url>] [--token <pat>]`**: the
   stdio shim. Per agent-tool process; fetches config, dials client-side
   upstreams via `mcp-runtime`, dials the outlet if needed, serves one
   namespaced tool set over stdio (SDK `McpServer` + `StdioServerTransport`;
   logs to stderr only). Secrets exist in process memory only.
7. **Install adapters emit one stdio shim entry per profile** (absolute `hnx`
   path baked via `process.argv[1]`; `--server` URL included). Install-time
   `${cred:NAME}` resolution and the "sensitive/0700" handling disappear.
   Hermes `mcp_servers:` merge simplified. **Codex adapter ships here as the
   trivial case**: `~/.codex/config.toml` `[mcp_servers.harness-nexus]`
   command/args (Codex is stdio-only — the shim makes it first-class).
   Codex non-MCP artifacts follow `docs/research/phase-3-plugin-targets.md`
   where the format is documented; anything unverified is explicitly deferred
   (see Out of scope).
8. **Emitter `emitMode: 'client' | 'server'`** (env `EMITTER_MODE`, default
   flips to `client` with C2): client mode emits ONE stdio shim entry in
   `.mcp.json` (`hnx mcp serve …`, no PAT env var, no `${cred:NAME}` warning —
   replaced by an "hnx enrolled" warning); `server` keeps today's output as
   the no-`hnx` fallback.
9. **Web**: MCP form — `mode` radio → `dialSite` select with derivation hint;
   credential form — `distributable` switch (global rows, admin). The 2.4
   status page keeps working (it now reflects the server-dialed set);
   per-machine MCP status lands with C3.

## Migration `0007`

- `mcp_servers`: add `dial_site TEXT NOT NULL DEFAULT 'auto'`, fold
  `mode: direct → 'client'`, `proxy → 'auto'`, then drop the `mode` column.
- `credentials`: add `distributable INTEGER NOT NULL DEFAULT 0` (existing
  global creds stay non-distributable — the locked default).

## Dial-site × distributability matrix (normative)

| Transport creds referenced | `auto` | `client`         | `server` |
| -------------------------- | ------ | ---------------- | -------- |
| none                       | client | client           | server   |
| all distributable          | client | client           | server   |
| any non-distributable      | server | **409 at use\*** | server   |

\* an explicit `client` + non-distributable credential is a config contradiction:
rejected at create/update with `409 CREDENTIAL_NOT_DISTRIBUTABLE` (the server
would have to ship a secret it must not ship). `auto` silently routes to
server — that is the derived default doing its job.

## Tasks (dependency order)

1. **shared** — `dial-site.ts` (`collectPlaceholderNames(transport)`,
   `resolveDialSite`) + schema flips (`dialSite`, `distributable`) +
   `requiresDirect` deletion. Unit tests incl. the matrix above.
2. **core** — `McpServer.dialSite` (drop `mode`), `Credential.distributable`.
3. **server storage** — migration `0007` + both drivers (mode→dial_site,
   distributable columns).
4. **mcp-runtime** — new package; `UpstreamPool` (connect/disconnect/status/
   listTools/callTool/listServerTools + stdio transport support + reconcile
   `sync(definitions)`); server registry refactored to delegate (public API
   unchanged for `proxy.ts` + routes), pooling filter = resolves-to-server.
5. **server routes** — `modules/mcp-servers.ts`: dialSite field replaces mode,
   `STDIO_REQUIRES_DIRECT` → `STDIO_REQUIRES_CLIENT`, matrix enforcement,
   `not_proxy` RegistryError → `not_server_dialed`; `modules/credentials.ts`:
   distributable handling; **`modules/client-config.ts`** (new, custom auth).
6. **sdk** — field flips + `getClientMcpConfig(profileId)`.
7. **cli** — `src/mcp/serve.ts` shim (registry of upstreams + outlet
   passthrough + stdio server); install resolver drops transport inlining;
   Hermes adapter simplification; **Codex adapter** (`adapters/codex.ts` +
   registry + TOML add-only merge per ECC pattern); uninstall paths updated.
8. **emitter** — `emitMode` (client default) + archive snapshot tests updated.
9. **web** — form changes (`dialSite`, `distributable`).
10. **verify** — update every mode-sensitive test (`emitter.test.ts`,
    `scripts/test-hermes-adapter.mjs`, `test-hnx-uninstall.mjs`, smoke);
    NEW `scripts/test-hnx-mcp-serve.mjs` — full shim E2E: fixture stdio MCP
    upstream (SDK server script) + memory server with a
    personal-cred/dial-client entry + a server-dialed outlet entry → shim
    serves both, namespaced + passthrough, call round-trips; smoke `[8 C2]`
    block asserts the config-API contract (resolved transports only for
    client-dialed; non-distributable plaintext absent; machine PAT accepted).

## Security notes

- The config API is the ONLY REST surface a machine PAT can call, and it is
  profile-visibility-checked against the machine's owner. Non-distributable
  plaintext never enters any response — asserted by tests.
- The shim holds resolved secrets in memory only; the sole at-rest client
  secret remains `~/.hnx/config.json` (0600, from C1).
- The outlet keeps its PAT gate and profile routing exactly as in 2.2.

## Out of scope (explicit)

- Per-machine MCP status reporting (needs the C3 inventory channel).
- Codex skills/commands/agents artifact formats beyond what the research doc
  verifies — MCP merge is the C2 deliverable; the rest ships when verified.
- Offline config cache, hybrid connection broker (parent design: deferred).
- Config hot-reload inside a running shim (config applies next session).

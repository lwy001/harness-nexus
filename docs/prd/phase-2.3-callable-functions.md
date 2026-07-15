# PRD: Phase 2.3 — Callable-function scripts

> Status: not started. Research: `docs/research/phase-2.3-sandbox.md`. Technical
> design: to be written (`docs/design/phase-2.3-callable-functions.md`) before
> implementation, per the feature-development workflow.

## Problem Statement

Some capabilities an agent needs are not available as MCP servers — they live
behind cloud-vendor HTTP APIs (e.g. a document-translation API, an OCR service,
an image generator, a proprietary search endpoint). Today there is no way to
expose those to an agent tool through AgentNexus: the proxy only aggregates
upstream MCP servers. An admin who wants to give agents access to a vendor API
has no in-product path and must run a separate MCP wrapper server. There needs to
be a way for an admin to author a small function that calls the vendor API and
expose it as an MCP tool, running safely on the AgentNexus host.

## Solution

Admin-authored JavaScript functions, stored and managed in AgentNexus, compiled
and executed in a sandbox, and exposed as MCP tools alongside upstream tools
through the same profile-based proxy. The sandbox has no filesystem or
subprocess access and can only make network calls to an admin-specified host
allowlist, mediated by a host-injected `ctx.fetch`. Functions are bundled into
profiles like MCP servers, so an agent tool connecting with `?profile=<id>` sees
both upstream tools and callable-function tools in one aggregated surface.

## User Stories

1. As an admin, I want to author a JS function that calls a vendor API, so that agents can use it without a separate MCP server.
2. As an admin, I want the function's network calls restricted to a host allowlist, so that a buggy or malicious script can't exfiltrate data.
3. As an admin, I want the sandbox to have no filesystem or subprocess access, so that the host is protected.
4. As an admin, I want to define the function's input schema, so that agents know what arguments to pass.
5. As an admin, I want to set a per-call timeout, so that a hung vendor API doesn't block the proxy.
6. As an admin, I want to bind a credential to a callable-function, so that it can authenticate to the vendor without the script seeing the secret.
7. As an admin, I want to test-run a function from the UI before publishing, so that I can verify it works.
8. As an admin, I want to disable a function without deleting it, so that I can take a broken tool offline temporarily.
9. As a user, I want callable-functions included in a profile alongside MCP servers, so that my agent sees one unified tool set.
10. As an agent tool, I want to call a callable-function the same way I call an upstream tool, so that the transport is transparent.
11. As an admin, I want only admins to author functions, so that untrusted users can't run arbitrary sandboxed code.
12. As an operator, I want each invocation audited, so that I can investigate sensitive API calls.
13. As a developer, I want callable-functions to plug into the existing proxy without changing the upstream connection pool, so that the McpRegistry stays focused.
14. As an admin, I want input validated before entering the sandbox, so that the script never sees malformed arguments.
15. As an operator, I want a callable-function crash isolated, so that one bad script doesn't take down the proxy.

## Implementation Decisions

- **Sandbox: `isolated-vm`** (V8 native Isolate) — chosen over `node:vm`
  (escapable), `vm2` (deprecated), and `worker_threads` (not a security
  boundary). Keeps V8 performance; fatal errors don't crash the host. Backup
  option: `quickjs-emscripten` if native builds are a hard blocker. See
  `docs/research/phase-2.3-sandbox.md`.
- **Dedicated `CallableFunction` entity** (not reuse of the deferred `Resource`
  module). Carries `source`, `inputSchema`, `allowedHosts`, `timeoutMs`, `scope`,
  `ownerId`, `status`. `ResourceKind = 'command'` left as a forward-compat slot.
- **`ToolSource` abstraction:** an interface (`listTools`, `callTool`) with two
  implementations — `McpRegistry` (existing upstream pool) and a new
  `CallableRegistry` (sandboxed scripts). The proxy merges both; `callTool`
  routes by namespace prefix (`<server>__` → McpRegistry, `fn__` →
  CallableRegistry). McpRegistry's connection semantics stay untouched.
- **Network via injected `ctx.fetch`:** the script receives only a host-proxied
  fetch that enforces `allowedHosts`. The real `fetch` never enters the sandbox.
  Credentials are decrypted host-side and added to outgoing headers by the
  proxy, so plaintext secrets stay outside the sandbox.
- **Host-side input validation:** `args` validated against `inputSchema` (zod)
  before the sandbox runs; script-internal validation is not trusted.
- **Admin-only authoring:** creation/mutation restricted to admins (consistent
  with the established 2.3 constraint). Scope still global/personal for profile
  referencing.
- **Profile integration:** `profileEntryInputSchema` extended to accept
  callable-function entries; `profileEntriesFor()` returns callable-function ids
  alongside `serverIds`; `buildSession` registers them on the same per-session
  `SdkMcpServer`.
- **Config:** new env fields `sandboxTimeoutMs`, `callableFunctionAllowedHosts`
  (instance-level default), following the existing `config.ts` pattern.
- **Migration:** a new SQLite table for callable-functions.

## Testing Decisions

- HTTP smoke tests: callable-function CRUD (admin-only), profile entry with a
  callable-function, the function exposed as a tool via the proxy,
  `ctx.fetch` allowlist enforcement (blocked host → error), timeout enforcement,
  crash isolation (one bad function doesn't break others).
- Sandbox behavior tested at the API seam (call the tool, assert the
  response/error), not by inspecting sandbox internals.
- Prior art: the Phase 2.2 smoke tests for profile routing and `/mcp` proxy
  gating.

## Out of Scope

- A full code editor with syntax checking in the UI (a textarea + test-run is
  sufficient for 2.3).
- Non-admin authoring of functions.
- Functions that need filesystem or subprocess access (deliberately impossible).
- Reusing the `Resource` aggregate / building the generic Resource module.
- Sharing callable-functions via the ECC/Superpower import pipeline.
- Per-call credential selection beyond a single bound credential.

## Further Notes

- Suggested sub-phasing: **2.3.1 core** (entity + CRUD + executor + ToolSource
  integration + smoke tests, no UI) then **2.3.2 UI** (management page + profile
  picker). Confirm scope when starting.
- The full technology comparison (isolated-vm vs QuickJS-WASM vs others) and the
  network-access design are in `docs/research/phase-2.3-sandbox.md`.

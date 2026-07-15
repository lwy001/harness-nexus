# Phase 2.3 research: callable-function sandbox

> Status: research complete. Captures the codebase integration points, the
> sandbox technology comparison, and the recommended approach for implementing
> admin-authored callable-function scripts that wrap vendor APIs as MCP tools.
> The implementation design doc + PRD follow once the decisions below are
> confirmed.

## Goal

Admins author small JavaScript functions that wrap cloud-vendor APIs (e.g. a
document-translation API, an OCR service, an image generator) and expose them as
MCP tools callable through a profile. The function bodies run **server-side in a
sandbox** — they must not be able to read the filesystem, execute arbitrary
subprocesses, or make unrestricted network calls.

## Codebase integration points (what already exists)

| Layer | Current state | How a callable-function plugs in |
| --- | --- | --- |
| `McpRegistry` (`server/src/mcp/registry.ts`) | Structurally coupled to upstream `Client` connections + transports. A callable-function has no upstream connection — **it cannot live in this pool.** | Introduce a sibling `ToolSource`; the registry stays focused on upstreams. |
| Proxy `buildSession` (`server/src/mcp/proxy.ts`) | One loop calls `registerTool(name, meta, handler)` per aggregated tool. Tool-source agnostic — **the easiest seam.** | A callable-function is just another `registerTool` entry on the same per-session `SdkMcpServer`. |
| `profileEntriesFor()` | Returns only `{ serverIds }`; skips non-`mcp` entries. | Extend the return shape to carry callable-function ids; widen the profile REST entry schema. |
| `Resource` domain (`core/src/domain/resource.ts`) | `ResourceKind` includes `'command'` but it is unused; the whole `Resource` aggregate is a no-op stub. | Reuse is possible but means building the deferred Resource module; a dedicated entity is lower-risk (see below). |
| `config.ts` | No sandbox/timeout/allowlist fields. | Add `sandboxTimeoutMs`, `callableFunctionAllowedHosts`, etc. |
| deps | No sandboxing library present. | New dependency (see comparison). |

### Recommended architecture: a `ToolSource` abstraction

```text
ToolSource (interface)
├── listTools(filter?) → AggregatedTool[]      // reuse the existing shape
└── callTool(name, args) → CallToolResult

McpRegistry        implements ToolSource   // upstream connection pool (existing)
CallableRegistry   implements ToolSource   // sandboxed scripts (new)
```

The proxy merges tools from both sources and routes `callTool` by namespace
prefix: `<server>__<tool>` → McpRegistry, `fn__<name>` → CallableRegistry. This
keeps the connection-pool semantics of McpRegistry untouched.

## Sandbox technology comparison

| Option | Isolation | Performance | Dependency cost | Verdict |
| --- | --- | --- | --- | --- |
| `node:vm` | ❌ **Not a sandbox** — Node docs say so explicitly | high | none | **Unusable** (escapable) |
| `vm2` | Deprecated, multiple known escapes | high | none | **Unusable** (unmaintained) |
| `worker_threads` | Weak — same process; fatal errors can crash the host; no real permission boundary | high | none (built-in) | Not for untrusted code |
| **`isolated-vm`** | **Strong** — V8 native Isolate, separate heap, memory/CPU limits, crashes don't hit the host | high (V8 JIT) | native build (prebuilt binaries available) | **Recommended** |
| QuickJS-WASM (`quickjs-emscripten`) | Very strong — separate engine inside a WASM sandbox | slow (interpreted) | pure WASM, no native build | Backup when no native deps allowed |
| Node Permission Model (`--permission`) | Process-level fs/network restrictions | native | none | **Defense-in-depth supplement**, not a standalone sandbox |

**Recommendation: `isolated-vm`.** It keeps V8 performance (important for
frequently-called MCP tools), provides real Isolate-level isolation with
memory/CPU caps, and fatal errors in untrusted code do not crash the host
process. The native build step is a CI concern but prebuilt binaries cover the
common platforms.

**Backup: `quickjs-emscripten`** if native compilation is a hard blocker. The
security boundary is arguably stronger (separate JS engine + WASM) but at a
significant performance cost.

## Network access from inside the sandbox

`isolated-vm` Isolates have **no Node APIs and no `fetch`** by default. To let a
script call a vendor API, the host injects a **controlled `ctx.fetch` callback**:

1. The script calls `ctx.fetch(url, opts)`.
2. The host intercepts and checks the URL host against the function's
   `allowedHosts` whitelist.
3. If allowed, the host performs the real request and returns the result to the
   script.
4. The script never holds the real `fetch` — only the proxied, allowlisted one.

Credential injection rides the same channel: a credential bound to the callable
function is decrypted host-side and added to the outgoing `Authorization` header
by the proxy `fetch`, so the plaintext secret never enters the sandbox.

## Data model decision

**Recommendation: a dedicated `CallableFunction` entity** (not reuse of
`Resource`).

- The `Resource` module has been deferred for two phases; building it now to host
  callable-functions is scope creep.
- `Resource` lacks execution-semantics fields (`inputSchema`, `timeoutMs`,
  `allowedHosts`, runtime status) — forcing them in dirties a generic model.
- A dedicated entity carries exactly what 2.3 needs and stays decoupled from the
  Resource roadmap. `ResourceKind = 'command'` is left as a forward-compat slot.

```ts
// Proposed shape (packages/core/src/domain/callable-function.ts)
export interface CallableFunction {
  id: string;
  name: string;
  description?: string;
  /** JS source — the body of an async (args, ctx) => { ... } function. */
  source: string;
  /** JSON Schema surfaced as the MCP tool's inputSchema. */
  inputSchema?: Record<string, unknown>;
  /** Hosts the function may call via ctx.fetch; empty = no network. */
  allowedHosts: string[];
  /** Per-call timeout (ms); defaults to config.sandboxTimeoutMs. */
  timeoutMs?: number;
  /** Admin-authored; scope global/personal for profile referencing. */
  scope: 'global' | 'personal';
  ownerId: string | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}
```

## Suggested sub-phasing

- **2.3.1 core**: CallableFunction entity + admin-only CRUD + `isolated-vm`
  executor + `ctx.fetch` whitelist proxy + `ToolSource` integration into the
  proxy + profile entry support + smoke tests. No UI (verify via API).
- **2.3.2 UI**: management page (script editor, inputSchema editor, allowedHosts
  config, test-run button) + profile entry picker for callable-functions.

## Open risks

- **Credential decryption boundary**: the encryption key must never enter the
  sandbox; decryption stays host-side in the `ctx.fetch` proxy.
- **Input validation**: validate `args` against `inputSchema` host-side (zod)
  before entering the sandbox — never trust script-internal validation.
- **Audit logging**: admin scripts can make sensitive calls; log each `callTool`
  (function, caller, duration, outcome).

## Sources

- [laverdet/isolated-vm (GitHub)](https://github.com/laverdet/isolated-vm)
- [Simon Willison: JavaScript Sandboxing Research](https://simonwillison.net/2026/Mar/22/javascript-sandboxing-research/)
- [LogRocket: Building a code evaluator with isolated-vm](https://blog.logrocket.com/building-leetcode-style-code-evaluator-isolated-vm/)
- [Temporal: Intro to isolated-vm in TypeScript](https://temporal.io/blog/intro-to-isolated-vm)
- [Inngest: Node.js worker threads are problematic](https://www.inngest.com/blog/node-worker-threads)
- [node:vm Is Not a Sandbox](https://dev.to/dendrite_soup/nodevm-is-not-a-sandbox-stop-using-it-like-one-2f74)
- [Semgrep: vm2 sandbox escape](https://semgrep.dev/blog/2026/calling-back-to-vm2-and-escaping-sandbox)
- [QuickJS in a WASM sandbox (HN)](https://news.ycombinator.com/item?id=40896873)
- [TanStack: Code Mode Isolate Drivers comparison](https://tanstack.com/ai/latest/docs/code-mode/code-mode-isolates)
- [Node.js Permissions docs](https://nodejs.org/api/permissions.html)

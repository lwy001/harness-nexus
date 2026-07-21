# MCP Proxy design (early concept note)

> ⚠️ **Superseded.** This was the original concept sketch. The implemented design
> — registry internals, proxy wiring, profile routing — lives in
> [`phase-2.2-registry.md`](./phase-2.2-registry.md). Kept for historical context
> only; do not rely on it for current behavior.

Goal: connect to many upstream MCP servers (stdio / SSE / streamable-http) as a
**client**, aggregate their tools/resources/prompts, and re-expose a single,
authenticated **server** to your coding tools.

## Why

Each coding tool (Claude Code, ZCode, Hermes) manages its own MCP list, and many
MCP servers run locally with per-machine config (env vars, secrets, paths).
Maintaining that across work / home / servers is the pain point. The proxy lets
you configure each upstream once in Harness Nexus and point every tool at one URL.

## Intended shape

- Upstream servers are stored as `McpServer` rows (scope: global/personal).
- A `McpRegistry` (TODO in `packages/server/src/mcp/`) holds live connections to
  every `proxied: true` server and aggregates their capabilities.
- The registry is mounted under `/mcp` (streamable-http) and `/mcp/sse` (SSE),
  and also exposes a programmatic entry for a stdio bridge.

## Auth

Tools authenticate to the proxy with a PAT (Bearer `hnpat_…`). Per-tool scoping
(restrict which upstreams a token may reach) is a follow-up.

## Status

Skeleton only — `mountMcpProxy` logs and returns. Implementation tracking in
`docs/roadmap.md`.

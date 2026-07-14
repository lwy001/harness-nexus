# ADR 0001 — Initial technology stack

- **Status:** accepted
- **Date:** 2026-07-14

## Context

Greenfield project; the directory is named `mcp-proxy` but the intent is a
broader unified Agent management platform spanning multiple coding tools
(Claude Code, ZCode, Hermes) across work / home / server machines. Needs: MCP
proxying, resource/profile management, third-party harness import, users +
PAT, and later ACP bridging, channels, and a knowledge base.

## Decision

- **Language:** TypeScript (Node ≥20) across all packages for now.
- **Monorepo:** polyglot-style layout under one git repo, pnpm workspaces.
- **HTTP:** Fastify (modern, typed, lifecycle-friendly).
- **MCP:** official `@modelcontextprotocol/sdk` on both client and server side.
- **Storage:** pluggable via a `UnitOfWork` of repository ports in core; default
  SQLite (`better-sqlite3`), in-memory driver for tests.
- **Validation:** zod, schemas centralized in `@agent-nexus/shared`.
- **Frontend:** React + TS + Vite SPA.
- **Project name / npm scope:** `agentnexus` / `@agent-nexus`.

## Consequences

- One language keeps the team's context-switching low and lets the CLI/SDK reuse
  core domain types directly.
- Putting repository _ports_ in core (not implementations) is the key rule that
  keeps storage pluggable — any edit adding I/O to core is a regression.
- The `mcp-proxy` directory name is retained for now; a rename to `agentnexus`
  can happen independently since the npm scope is already `@agent-nexus`.

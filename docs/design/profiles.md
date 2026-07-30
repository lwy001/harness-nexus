# Profiles (concept & install-flow note)

> The implemented Profile model (CRUD, scope rules, profile-routed proxy access)
> is documented in [`phase-2.2-registry.md`](./phase-2.2-registry.md). This note
> covers the broader concept (bundling all resource kinds + third-party imports)
> and the intended CLI install flow, which is still future work.

A **profile** is a named, versioned bundle of resources (MCP servers, skills,
hooks, sub-agents, rules, commands) plus optional third-party imports (ECC,
Superpower). One-click install applies one or more profiles to a target Agent
tool, writing assets into that tool's config directories.

## Scoping

Every resource and profile is either **global** (admin-managed, shared) or
**personal** (per-user). Personal items are only visible to their owner; global
items are visible to all authenticated users. The CLI and API honor this when
listing and installing.

## Install flow (intended)

1. `hnx install --profile frontend-daily --target zcode`
2. CLI resolves the profile → its entries (resources) and imports.
3. For each resource: fetch the artifact (git/tarball/local), verify checksum,
   then write to the target tool's directory using a target-specific writer
   (e.g. `~/.claude/skills`, ZCode workspace config, …).
4. For each import: run the matching adapter (ECC/Superpower) to place assets.

The CLI fetches profiles from a running Harness Nexus server via the SDK. A
profile is a reference bundle (its entries point at server-side resources by
id), so the resource bodies and the aggregated `/mcp` endpoint both require
the server — the CLI does not read local manifests.

## Manifest schema

Defined in `packages/shared/src/schemas/profile.ts` (zod). The server, web UI,
and CLI all validate against this. Keep it in sync with the domain types in
`packages/core/src/domain/profile.ts`.

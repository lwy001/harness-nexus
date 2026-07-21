# Design: Phase 7.1 — Plugin source + trust/provenance model

> Status: implemented in Phase 7.1 (✅). PRD: `docs/prd/phase-7-skills.md`.
> Research: `docs/research/phase-4.4-skills.md` (read first — this design
> assumes its findings, with the four corrections noted in the PRD).

This design covers the **first Phase 7 sub-phase only** — the foundation that
all later sub-phases build on. It adds a `plugin` variant to `ResourceSource`,
lands the trust tier + provenance-pin model, defines the `SkillSource` port
(with one no-op implementation), and flips the validator + smoke test that
currently reject non-inline skill sources. **No outbound network** is
introduced in 7.1 — the user pastes the spec; trust is computed from the repo
owner string. The first fetch lands in 7.2.

## What 7.1 adds

Four coupled changes, in dependency order:

1. **Domain** (`core`) — a `plugin` variant on `ResourceSource`; a `SkillSource`
   port (new file); a `TrustTier` type; `SkillMeta` / `SkillBundle` data
   shapes mirroring Hermes's dataclasses.
2. **Shared** (`shared`) — the matching zod object for `plugin`; a
   `TRUSTED_REPOS` constant + `resolveTrustTier()` helper (the single source of
   truth for the 4 trusted repos + the `official` ⇒ `builtin` rule).
3. **Server** (`server`) — extend `validateSkillResource` to accept `plugin`;
   compute trust at save time and stash it on the resource's `labels` (no
   schema/storage change needed — `labels` already exists).
4. **Smoke** — flip the `INVALID_SKILL_SOURCE` block (`scripts/smoke.mjs:593`)
   to a positive create-and-verify flow.

The dependency boundary is `core` → `shared` → `server` → `smoke`. Build each
before the next (composite project references need `dist`).

## Part 1 — Domain changes

### 1a. New `plugin` variant (`packages/core/src/domain/resource.ts:46`)

Append a sixth member to the `ResourceSource` discriminated union:

```ts
export type ResourceSource =
  | { type: 'git'; url: string; ref?: string; path?: string }
  | { type: 'tarball'; url: string; checksum?: string }
  | { type: 'local'; path: string }
  | { type: 'inline'; content: string }
  | { type: 'inline-bundle'; files: Record<string, string> }
  // ---- Phase 7.1 ----
  | {
      type: 'plugin';
      /**
       * Mirrors the CC marketplace.json `source` kinds (research-corrected:
       * 4 live kinds in the official catalog — url / git-subdir / string-path /
       * github; no npm in production, modeled for completeness). The string
       * relative-path form (`"./plugins/foo"`) is NOT accepted here — it only
       * makes sense inside a marketplace repo; Harness Nexus stores resolved specs.
       */
      source:
        | { source: 'github'; repo: string; ref?: string; sha?: string; path?: string }
        | { source: 'url'; url: string; ref?: string; sha?: string; path?: string }
        | { source: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
        | { source: 'npm'; package: string; version: string; registry?: string };
      /** The plugin this entry resolves to (the `plugin:skill` namespace half). */
      plugin: string;
      /**
       * Optional marketplace-entry version pin. Falls back to `sha` (for git
       * kinds) or the resolved git commit at install time. Absent ⇒ floating,
       * tracked to `ref` (default branch).
       */
      version?: string;
    };
```

The choice of a new variant over reusing `git` is settled in the research doc
and preserved: `plugin` carries the namespace (`plugin` field) and the
source-kind distinction (`git-subdir` is a sparse clone ≠ `github`/`url` full
clone) that `git` cannot express.

### 1b. Trust tier + provenance (computed, not stored as new fields)

Trust and provenance are **not** new columns or new domain fields. They ride
on the existing `labels: Record<string, string>` (`Resource.labels`, already
in the schema and storage). This avoids a migration and keeps `Resource` stable.

At save/update time the server computes three label entries (only when
`source.type === 'plugin'`; other kinds are unaffected):

| Label key    | Value                                                     | Source                              |
| ------------ | --------------------------------------------------------- | ----------------------------------- |
| `trust`      | `'builtin'` \| `'trusted'` \| `'community'`               | `resolveTrustTier(source)` (Part 2) |
| `pin`        | the `sha` / `version` string, or absent                   | from the spec                       |
| `provenance` | short human string, e.g. `"anthropics/skills@sha:abc123"` | derived from the spec               |

If the user passes `labels` of their own, the server **overwrites** these three
keys (trust/provenance are authoritative; user labels coexist for everything
else). A `community` resource with no `pin` is valid but triggers the
install-warning UX in 7.3.

> **Why labels and not new fields?** The trust tier is derived from the spec
> (it is a function of the repo owner), so storing it is denormalization for
> UI convenience — `labels` is the existing extension point for exactly this.
> Provenance is the same. If we later want to index on trust (e.g. for a
> `?trust=trusted` filter), we can promote it to a real column then; 7.1 does
> not need it.

### 1c. `SkillSource` port (new file: `packages/core/src/ports/skill-source.ts`)

A **port** (pure interface, no I/O imports) mirroring Hermes's ABC ground
truth: **4 abstract methods + 1 concrete default** (`trustLevelFor` defaults to
`'community'`). `search` is optional — only multi-source adapters (7.4)
implement it; the single-marketplace fetcher (7.2) lists the whole catalog and
does not need it.

```ts
import type { TrustTier, SkillMeta, SkillBundle } from '../domain/skill.js';

/**
 * A source of skills (a marketplace, a GitHub repo, a direct URL, …). Mirrors
 * Hermes's `SkillSource` ABC (`~/.hermes/hermes-agent/tools/skills_hub.py`).
 *
 * This is a PORT — pure interface. Concrete adapters live in
 * `@harness-nexus/server` under `src/infra/source-fetchers/*`. Phase 7.1 ships
 * one no-op implementation (to prove the shape); 7.2 ships the marketplace
 * adapter; 7.4 ships the rest.
 */
export interface SkillSource {
  /** Stable id for this source kind: 'github' | 'url' | 'claude-marketplace' | … */
  sourceId(): string;
  /** Metadata only — no bytes. Returns null if the identifier is unknown here. */
  inspect(identifier: string): Promise<SkillMeta | null>;
  /** The bytes (a SKILL.md + its bundle). Phase 7.2+; 7.1's impl throws. */
  fetch(identifier: string): Promise<SkillBundle | null>;
  /** Optional: search across this source's catalog. Multi-source only (7.4+). */
  search?(query: string, limit?: number): Promise<SkillMeta[]>;
  /**
   * Trust tier for a given identifier. NOT abstract — defaults to 'community'
   * (mirrors Hermes's concrete default). Adapters that know better (github,
   * claude-marketplace) override.
   */
  trustLevelFor(identifier: string): TrustTier {
    return 'community';
  }
}
```

### 1d. Domain types for skills (new file: `packages/core/src/domain/skill.ts`)

Three small types, mirroring Hermes's `SkillMeta` / `SkillBundle` dataclasses
(ground-truth quoted in the research verification):

```ts
export type TrustTier = 'builtin' | 'trusted' | 'community';

export interface SkillMeta {
  name: string;
  description: string;
  /** The source_id that produced this meta: 'github' | 'url' | … */
  source: string;
  /** Source-specific identifier (e.g. 'anthropics/skills/skill-creator'). */
  identifier: string;
  trustLevel: TrustTier;
  repo?: string;
  path?: string;
  tags?: string[];
  /** Source-specific extras (category, author, homepage, …). */
  extra?: Record<string, unknown>;
}

export interface SkillBundle {
  name: string;
  /** Relative path → content. One key must be `SKILL.md`. */
  files: Record<string, string | Buffer>;
  source: string;
  identifier: string;
  trustLevel: TrustTier;
  metadata?: Record<string, unknown>;
}
```

Export both new files from `packages/core/src/ports/index.ts` and
`packages/core/src/domain/index.ts` respectively (then `core/src/index.ts`
re-exports them, as it already does for the other ports/domains).

## Part 2 — Shared schema + trust resolution

### 2a. zod object for `plugin` (`packages/shared/src/schemas/resource.ts:28`)

Add a sixth arm to the `resourceSourceSchema` discriminated union. Field
shapes mirror Part 1a exactly:

```ts
z.object({
  type: z.literal('plugin'),
  source: z.discriminatedUnion('source', [
    z.object({
      source: z.literal('github'),
      repo: z.string().min(1),
      ref: z.string().optional(),
      sha: z.string().optional(),
      path: z.string().optional(),
    }),
    z.object({
      source: z.literal('url'),
      url: z.string().min(1),
      ref: z.string().optional(),
      sha: z.string().optional(),
      path: z.string().optional(),
    }),
    z.object({
      source: z.literal('git-subdir'),
      url: z.string().min(1),
      path: z.string().min(1),
      ref: z.string().optional(),
      sha: z.string().optional(),
    }),
    z.object({
      source: z.literal('npm'),
      package: z.string().min(1),
      version: z.string().min(1),
      registry: z.string().optional(),
    }),
  ]),
  plugin: z.string().min(1),
  version: z.string().optional(),
}),
```

No change to `createResourceSchema` / `updateResourceSchema` — they consume
`resourceSourceSchema` and pick up the new arm automatically.

### 2b. Trust resolution (new file: `packages/shared/src/trust.ts`)

The single source of truth for the 4 trusted repos and the resolution rules.
Lives in `shared` (not `core`) because it is a pure function over a constant
table — both server and (eventually) web consult it. Mirrors
`hooks.ts` (also at the shared root) as a peer.

> **Layering correction (verified during implementation).** An earlier draft of
> this section had `import type { TrustTier } from '@harness-nexus/core'` here.
> That violates the one-way dependency rule — `shared/package.json` depends
> only on `zod`, never on `core` (the existing `@harness-nexus/core` mentions in
> `shared/src` are comments only). The implemented file mirrors `TrustTier`
> locally via `z.infer`, exactly how `schemas/profile.ts` mirrors `AgentTarget`
> — see `packages/shared/src/trust.ts`. Keep the two definitions in sync.

```ts
import { z } from 'zod';

/**
 * The zod mirror of `@harness-nexus/core` `TrustTier`. Defined locally (not
 * imported from core) because `shared` does not depend on `core` — matches
 * the `AgentTarget` pattern in `schemas/profile.ts`. Keep in sync with
 * `core/src/domain/skill.ts` `TrustTier`.
 */
export const trustTierSchema = z.enum(['builtin', 'trusted', 'community']);
export type TrustTier = z.infer<typeof trustTierSchema>;

/**
 * The 4 trusted repos (ground-truth verified from Hermes's `TRUSTED_REPOS`,
 * `tools/skills_guard.py:40-49`). Capitalization of `NVIDIA` matters — the
 * comparison lowercases both sides but the canonical form is preserved here.
 */
export const TRUSTED_REPOS: ReadonlySet<string> = new Set([
  'openai/skills',
  'anthropics/skills',
  'huggingface/skills',
  'NVIDIA/skills',
]);

/**
 * Resolve the trust tier for a plugin source. Rules (mirror Hermes
 * `_resolve_trust_level`, skills_hub.py:1050-1061):
 *   - `official` source kind      ⇒ `builtin`  (Harness Nexus owns none today)
 *   - repo owner ∈ TRUSTED_REPOS  ⇒ `trusted`
 *   - otherwise                   ⇒ `community`
 *
 * The 4th Hermes tier (`agent-created`, off-by-default) is NOT surfaced.
 */
export function resolveTrustTier(
  source:
    | { source: 'github'; repo: string }
    | { source: 'url'; url: string }
    | { source: 'git-subdir'; url: string }
    | { source: 'npm'; package: string },
): TrustTier {
  // Extract an `owner/repo` string from the source, lowercase for compare.
  const ownerRepo = extractOwnerRepo(source);
  if (ownerRepo && TRUSTED_REPOS.has(ownerRepo.toLowerCase())) return 'trusted';
  return 'community';
}

/** Best-effort owner/repo extraction; returns null if not parseable. */
function extractOwnerRepo(
  source:
    | { source: 'github'; repo: string }
    | { source: 'url'; url: string }
    | { source: 'git-subdir'; url: string }
    | { source: 'npm'; package: string },
): string | null {
  if (source.source === 'github') return source.repo;
  // url / git-subdir: try to pull owner/repo out of a github URL.
  const match =
    source.source === 'npm'
      ? null
      : source.source === 'url'
        ? source.url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?(?:[/?#]|$)/i)
        : source.url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?(?:[/?#]|$)/i);
  return match ? match[1] : null;
}
```

Re-export from `packages/shared/src/index.ts`. (Note: `core` cannot import
from `shared` — dependency direction is one-way. `resolveTrustTier` takes the
narrow source-shape union, not the full `ResourceSource`, so `shared` does not
need to import the domain type beyond the `TrustTier` re-export, which already
flows core → shared.)

## Part 3 — Server validation flip

### 3a. Accept `plugin` in `validateSkillResource` (`packages/server/src/modules/resources.ts:275`)

The current validator hard-rejects anything but `inline` / `inline-bundle`
(`409 INVALID_SKILL_SOURCE`). Extend the allowlist and add plugin-specific
validation (path safety for the `path` field, since the install writer joins
it onto a target directory):

```ts
function validateSkillResource(kind: ResourceKind, source: Resource['source']): void {
  if (kind !== 'skill') return;
  switch (source.type) {
    case 'inline':
      return; // single-file SKILL.md body
    case 'inline-bundle':
      validateBundlePaths(source.files); // extracted from the current logic
      return;
    case 'plugin':
      validatePluginSource(source); // new — see below
      return;
    default:
      // git / tarball / local still rejected for skills in 7.1 (a plugin
      // source is the right representation for an external skill; a bare git
      // ref loses the plugin namespace). Revisit if a use case appears.
      throw new AppError(
        `A skill source must be 'inline', 'inline-bundle', or 'plugin', got '${source.type}'`,
        409,
        'INVALID_SKILL_SOURCE',
      );
  }
}

function validatePluginSource(source: Extract<Resource['source'], { type: 'plugin' }>): void {
  // Path safety for github/url/git-subdir path fields (the install writer
  // joins them onto a target dir — same traversal risk as bundle paths).
  const s = source.source;
  const path = 'path' in s ? s.path : undefined;
  if (path !== undefined && (path.startsWith('/') || path.includes('..') || path.includes('\\'))) {
    throw new AppError(
      `Unsafe plugin source path: "${path}" (must be relative, no '..')`,
      400,
      'VALIDATION_ERROR',
    );
  }
  // npm requires a version (the schema enforces non-empty, but be explicit).
  if (s.source === 'npm' && !s.version) {
    throw new AppError('An npm plugin source requires a version', 400, 'VALIDATION_ERROR');
  }
}
```

`git` / `tarball` / `local` stay rejected for skills in 7.1 — `plugin` is the
correct representation for an external skill (the namespace matters). This is a
deliberate narrowing; revisit if a real use case for a bare-git skill appears.

### 3b. Compute trust + provenance at save time (`resources.ts`, POST + PATCH)

In both the create and update handlers, after `validateSkillResource` and
before `save`, if `source.type === 'plugin'`, compute the three labels (Part
1b) and merge them into `labels`:

```ts
import { resolveTrustTier } from '@harness-nexus/shared';

function withTrustLabels(resource: Resource): Resource {
  if (resource.source.type !== 'plugin') return resource;
  const tier = resolveTrustTier(resource.source.source);
  const pin =
    'sha' in resource.source.source ? resource.source.source.sha : resource.source.version;
  const provenance = buildProvenance(resource.source); // 'anthropics/skills@sha:abc123'
  return {
    ...resource,
    labels: {
      ...(resource.labels ?? {}),
      trust: tier,
      ...(pin ? { pin } : {}),
      provenance,
    },
  };
}
```

Call it in the POST handler after constructing the `resource` object (before
`save`), and in the PATCH handler after merging `next` (before `save`).
Existing user-supplied `labels` are preserved except for the three authoritative
keys.

### 3c. `resourceView` — no change

`serialize.resourceView` is an identity function today and stays that way. The
trust labels are already part of `Resource.labels` and flow through unchanged.
(If we later want to redact something — e.g. a private registry token in a
custom `registry` URL — this is the seam.)

## Part 4 — Storage

**No migration. No driver change.** The storage layer is fully variant-agnostic
(verified):

- **SQLite** (`packages/server/src/infra/storage/sqlite/repos.ts:171, 582`):
  `source` is `JSON.stringify`-ed on write and `JSON.parse`-ed on read — the
  new `plugin` shape round-trips with zero code change. The `as ResourceSource`
  cast at line 171 picks up the new variant automatically once `core` exports
  it.
- **Memory** (`packages/server/src/infra/storage/memory/index.ts:177-206`):
  stores the `Resource` object directly in a `Map` — no serialization, no
  branching.
- `labels` is already a JSON column (`labels TEXT`, JSON-encoded); the three
  new keys ride along for free.

## Part 5 — SDK

**No code change.** `packages/sdk-ts/src/index.ts` is pure pass-through: it
`JSON.stringify`s the request body and ships it. `createResource` /
`updateResource` accept `source: ResourceSource`, and `ResourceSource` is
re-exported (line 370) from `@harness-nexus/core` — once `core` adds `plugin`,
the SDK accepts it automatically. The `TrustTier` / `SkillMeta` / `SkillBundle`
types should be added to the SDK's re-export list (line 369-371) for client
ergonomics.

## Part 6 — One no-op `SkillSource` implementation

To prove the port shape compiles and round-trips, ship one no-op adapter in
`packages/server/src/infra/source-fetchers/noop-source.ts`:

```ts
import type { SkillSource } from '@harness-nexus/core';

/** No-op adapter — proves the port shape. Real adapters arrive in 7.2/7.4. */
export class NoopSkillSource implements SkillSource {
  sourceId(): string {
    return 'noop';
  }
  async inspect(): Promise<null> {
    return null;
  }
  async fetch(): Promise<null> {
    return null;
  }
  // search is optional — omitted.
}
```

It is not wired to any route in 7.1 (there is no registry of sources yet —
that arrives in 7.2 alongside the marketplace fetch endpoint). Its only job is
to make `tsc` exercise the port contract.

## Part 7 — Smoke test flip (`scripts/smoke.mjs:593-606`)

The current block asserts `source: { type: 'git', url }` is rejected with
`409 INVALID_SKILL_SOURCE`. Replace it with a positive `plugin` flow and add
trust assertions. Keep a negative assertion for `git` (which stays rejected —
see Part 3a):

```js
log('\n--- [7.1] skill with plugin source accepted; trust computed ---');

// Positive: anthropics/skills github plugin ⇒ trusted tier.
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-trusted',
    kind: 'skill',
    name: 'trusted-plugin-skill',
    scope: 'personal',
    source: {
      type: 'plugin',
      source: { source: 'github', repo: 'anthropics/skills', sha: 'abc123def456' },
      plugin: 'skill-creator',
    },
    targets: ['claude-code'],
  },
});
expect('plugin skill created', r.status, 201);
expect('plugin source round-trips', r.json.resource.source.type, 'plugin');
expect('trust label = trusted', r.json.resource.labels?.trust, 'trusted');
expect('pin label = sha', r.json.resource.labels?.pin, 'abc123def456');

// Positive: unknown repo ⇒ community tier, no pin ⇒ no pin label.
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-community',
    kind: 'skill',
    name: 'community-plugin-skill',
    scope: 'personal',
    source: { type: 'plugin', source: { source: 'github', repo: 'random/dev' }, plugin: 'thing' },
    targets: ['claude-code'],
  },
});
expect('community plugin skill created', r.status, 201);
expect('trust label = community', r.json.resource.labels?.trust, 'community');
expect('no pin label when floating', r.json.resource.labels?.pin, undefined);

// Negative: git source still rejected for skills (use 'plugin' instead).
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:git-nope',
    kind: 'skill',
    name: 'nope',
    scope: 'personal',
    source: { type: 'git', url: 'https://example.com/repo' },
    targets: ['claude-code'],
  },
});
expect('skill git source still rejected', r.status, 409);
expect('error code INVALID_SKILL_SOURCE', r.json.error, 'INVALID_SKILL_SOURCE');

// Negative: unsafe path in plugin source.
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-badpath',
    kind: 'skill',
    name: 'badpath',
    scope: 'personal',
    source: {
      type: 'plugin',
      source: { source: 'github', repo: 'anthropics/skills', path: '../etc/passwd' },
      plugin: 'x',
    },
    targets: ['claude-code'],
  },
});
expect('unsafe plugin path rejected', r.status, 400);
```

## Part 8 — Edit map (the full blast radius, verified)

For the implementer — every spot that changes in 7.1:

| File                                                             | Change                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/domain/resource.ts:46`                        | Add `\| { type: 'plugin'; ... }` to the union (Part 1a).                                                           |
| `packages/core/src/domain/skill.ts` (new)                        | `TrustTier`, `SkillMeta`, `SkillBundle` (Part 1d).                                                                 |
| `packages/core/src/domain/index.ts`                              | Re-export `./skill.js`.                                                                                            |
| `packages/core/src/ports/skill-source.ts` (new)                  | `SkillSource` interface (Part 1c).                                                                                 |
| `packages/core/src/ports/index.ts`                               | Re-export `./skill-source.js`.                                                                                     |
| `packages/shared/src/schemas/resource.ts:28`                     | Add the `plugin` arm to `resourceSourceSchema` (Part 2a).                                                          |
| `packages/shared/src/trust.ts` (new)                             | `TRUSTED_REPOS`, `resolveTrustTier()` (Part 2b).                                                                   |
| `packages/shared/src/index.ts`                                   | Re-export `./trust.js` + `./schemas/resource.js` (already exports the latter).                                     |
| `packages/server/src/modules/resources.ts:275`                   | Extend `validateSkillResource`; add `validatePluginSource`; call `withTrustLabels` in POST + PATCH (Parts 3a, 3b). |
| `packages/server/src/infra/source-fetchers/noop-source.ts` (new) | `NoopSkillSource` (Part 6).                                                                                        |
| `packages/sdk-ts/src/index.ts:369`                               | Add `TrustTier`, `SkillMeta`, `SkillBundle` to the type re-exports (Part 5).                                       |
| `scripts/smoke.mjs:593-606`                                      | Flip the assertion block (Part 7).                                                                                 |

**Not touched** (variant-agnostic by construction — verified by grep):

- `packages/server/src/infra/storage/sqlite/repos.ts` — `source` is JSON.
- `packages/server/src/infra/storage/memory/index.ts` — direct `Map`.
- `packages/server/src/modules/serialize.ts` — `resourceView` is identity.
- `packages/core/src/domain/profile.ts` — references resources by id/kind, not source.
- `packages/core/src/ports/repository.ts` — `ResourceRepository` is source-agnostic.

## Part 9 — Scope, permission, and security rules

- **No new outbound network in 7.1.** Trust is computed from the repo owner
  string (`resolveTrustTier`); no fetch happens. The first fetch lands in 7.2
  behind `MARKETPLACE_ALLOWLIST`.
- **The existing scope model applies unchanged.** A `plugin`-source skill is
  `global` (admin-mutate) or `personal` (owner-only) exactly like every other
  resource. No new scope concepts.
- **Trust labels are advisory.** They inform the install-warning UX (7.3); they
  do not gate storage. A `community` skill stores fine — the warning appears
  later, in the profile/install path.
- **`git` / `tarball` / `local` stay rejected for skills.** A bare `git` ref
  loses the plugin namespace; `plugin` is the correct external-skill shape. If
  a non-plugin external skill use case appears, revisit.

## Out of scope (deferred to 7.2+)

- **Any outbound fetch** — marketplace browse, plugin resolution, SHA pinning
  by fetching the repo. All of this is 7.2+.
- **The marketplace allowlist + `GET /api/skills/marketplaces/:id/plugins`
  endpoint** — 7.2.
- **The hub search UI** — 7.3.
- **Real `SkillSource` adapters** (github, url, skills-sh, …) — 7.4. 7.1 ships
  only the no-op proof-of-shape.
- **Content security scanning** — not modeled; Harness Nexus stores references,
  the target tool executes.
- **Promoting `trust` to a real column / indexed filter** — only if a
  `?trust=trusted` list filter is needed; `labels` suffices for 7.1's UI badge.
- **The 4th Hermes trust tier (`agent-created`)** — off-by-default in Hermes,
  not surfaced here.
- **Install-time materialization** — Phase 3.3's writer pipeline. 7.1 only
  stores the reference.

## Verification checklist

When implementing 7.1:

1. `pnpm --filter @harness-nexus/core run build` — the new union member + port +
   domain types compile.
2. `pnpm --filter @harness-nexus/shared run build` — zod picks up the new arm;
   `resolveTrustTier` typechecks.
3. `pnpm --filter @harness-nexus/server run build` — `validateSkillResource` and
   `withTrustLabels` compile; the no-op adapter satisfies `SkillSource`.
4. `pnpm --filter @harness-nexus/sdk-ts run build` — re-exports compile.
5. `pnpm -r run typecheck` — whole tree.
6. Boot a memory-driver server (`STORAGE_DRIVER=memory JWT_SECRET=… pnpm dev:server`)
   and run `node scripts/smoke.mjs` — the flipped `[7.1]` block passes.

# Phase 3.5 — Marketplace emitter: serve Claude Code plugins over HTTP

> Status: **design** (2026-09-04). Grounded in the empirical spike
> ([`research/phase-3.5-marketplace-emitter-spike.md`](../research/phase-3.5-marketplace-emitter-spike.md))
> — every client-side behavior cited here was verified against a live
> `claude plugin add/install/update/uninstall` cycle.
>
> **This re-plans the old "3.5 Claude Code adapter".** Writing into `~/.claude`
> ourselves is now the *fallback* (old CLI < 2.1.224, or airgapped hosts);
> the preferred distribution path for claude-code targets is native
> marketplace consumption. The adapter pipeline (3.3/3.4) is untouched and
> remains the path for Hermes and future non-marketplace targets.

## What Phase 3.5 adds

A **read-only emitter** on the Harness Nexus server that turns a user's
visible profiles into a Claude Code plugin marketplace:

```
claude plugin marketplace add https://<host>/api/marketplace/<token>/marketplace.json
claude plugin install <profile-name>@harness-nexus-<username>
```

Install, update (`claude plugin update` re-pulls the zip), and uninstall are
all owned by Claude Code — **no install-state ledger on this path**, no
client-side writes. Harness Nexus only emits a catalog and per-profile zip
archives.

## Decisions (locked)

1. **Token in URL = the user's PAT** (`hnpat_…`). No new entity, no new
   storage, no new UI. Trade-off: the add-URL is exactly as sensitive as a
   CLI PAT (it *is* one) and rides in claude's `settings.json`; rotation =
   new PAT + re-`add`. A dedicated, revocable emit token is future work
   (listed in roadmap) — the swap is contained in one resolver function.
2. **One marketplace per user**, name `harness-nexus-<username>` (sanitized
   to claude's `[a-z0-9-]` expectations; unique per user — the spike showed
   claude rejects re-adding a marketplace *name* from a different URL, so
   per-user uniqueness prevents collisions on shared machines).
3. **One plugin per profile.** Plugin name = sanitized profile name;
   version = `profile.version` (editors bump it; `claude plugin update`
   picks up the change).
4. **Catalog routes are PAT-in-path, headerless** (claude sends no headers we
   can rely on — spike §4). Unknown/revoked token → `404` (no existence
   leak; matches our API 404 posture). These routes do **not** use
   `requireAuth` — there is no `Authorization` header; they resolve the token
   themselves and set `req.user`.
5. **MCP emission mirrors the Hermes adapter's split**: proxy-mode entries
   collapse into the single aggregated `/mcp?profile=<id>` endpoint with a
   `${HN_PAT}` env placeholder (`.mcp.json` supports env expansion); direct
   entries are emitted verbatim with `${cred:NAME}` placeholders left
   unresolved (CLI-side decryption needs a server API we don't expose — same
   limitation as 3.4, warned in the plugin description).
6. **Rules become skills.** Claude Code plugins have no always-on "rules"
   concept; a rule resource is emitted as `skills/<key>/SKILL.md` with a
   description prefix `Rules:`. Documented limitation, not silent.
7. **Zip assembly via `jszip`** (pure JS) in the server package. Archives are
   built on the fly — no cache, no persistence.

## API surface

Two GET routes under `packages/server/src/modules/marketplace.ts`, both
bounded by a `marketplaceTokens` style preHandler that resolves the PAT:

| Route | Returns |
|---|---|
| `GET /api/marketplace/:token/marketplace.json` | Catalog: every profile visible to the token's user; each entry's `source` = `{ source: 'archive', url: <PUBLIC_BASE_URL>/api/marketplace/<token>/archives/<profileId>.zip }` |
| `GET /api/marketplace/:token/archives/:profileId.zip` | The profile assembled as a claude-code plugin zip |

Visibility = the same scope filter as the profile list API (`global` +
own `personal`; admin sees all). A profile the user can't see → `404`.

Config addition (`packages/server/src/config.ts`): `PUBLIC_BASE_URL`
(default `http://localhost:8080`) — **must** be the public HTTPS origin in
production, because claude enforces `https://` + non-loopback on archive
URLs (spike §2). Our Caddy :15921 front door satisfies this.

## Plugin zip layout (claude-code native)

```
<profile-name>/
  .claude-plugin/plugin.json        # { name, version: profile.version, description }
  .mcp.json                          # only when the profile has MCP entries
  skills/<key>/SKILL.md              # skill resources (inline)
  skills/<key>/…                     # inline-bundle files (references/, scripts/)
  skills/<key>/SKILL.md              # rule resources (wrapped, see decision 6)
  commands/<key>.md                  # command resources
  agents/<key>.md                    # sub_agent resources
  hooks/hooks.json                   # hook resources (claude-code-supported events only)
```

- The zip carries one top-level folder (spike §3 layout, "one folder deep").
- Hook emission filters by the existing `HOOK_SUPPORT` matrix
  (`packages/shared/src/hooks.ts`): events claude-code doesn't support are
  dropped with a note in the plugin description (same discipline as the
  Hermes adapter's skip-with-warning).
- The MCP block in `.mcp.json`:

```json
{
  "mcpServers": {
    "harness-nexus": {
      "type": "http",
      "url": "<PUBLIC_BASE_URL>/mcp?profile=<profileId>",
      "headers": { "Authorization": "Bearer ${HN_PAT}" }
    },
    "<direct-server-name>": { "…verbatim…" }
  }
}
```

The install hint (plugin `description` suffix) tells the user to export
`HN_PAT` with a profile-scoped PAT before launching claude.

## Architecture placement

- `packages/server/src/marketplace/emitter.ts` — catalog builder + zip
  builder. Depends on `UnitOfWork` (profiles + resources + mcp-servers), not
  on route handlers (mirrors how `mcp/registry.ts` stays transport-decoupled).
- No `core` changes. No `shared` schema changes (the marketplace.json shape
  we *emit* is a subset of `marketplaceCatalogSchema` minus the `archive`
  source variant — extend `marketplaceSourceSchema` with the `archive` kind
  so emit and parse share one schema).
- Web UI: deferred to a follow-up (the add-command string is trivially shown
  later on the profile list; no screen exists for "marketplace" today).

## Verification

1. Unit: catalog + zip builders against the in-memory driver fixture.
2. `scripts/smoke.mjs`: PAT → fetch `marketplace.json` (assert name/plugins
   shape + archive URLs) → fetch one archive (assert zip magic + expected
   member paths).
3. Manual E2E (documented for the future, gated on a non-loopback HTTPS
   origin): `claude plugin marketplace add …` against the deployed server.

## Out of scope (explicit)

- Dedicated/rotatable emit tokens (PAT reuse only; swap point is one
   function).
- Per-profile marketplaces, marketplace metadata editing, categories/tags
   beyond what profiles already carry.
- Local-write claude-code adapter (old-CLI fallback) — remains deferred,
   re-numbered behind the emitter.
- ZCode marketplace consumption (its catalog format is the same shape per
   our 7.2 schema, but ZCode stays out of install scope).
- Access-log redaction of the token (noted: the full URL appears in Fastify
   request logs; acceptable for now, flagged in the security section).

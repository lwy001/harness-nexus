# Phase 3.5 research: serving a Claude Code marketplace directly over HTTP

> Status: **spike complete** (2026-09-04). All findings below are empirical,
> verified against a live `claude plugin marketplace add` / `install` /
> `update` / `uninstall` cycle on this machine — not read from docs alone.
> Test rig: zero-dep Node `http`/`https` servers (this is *not* the production
> emitter), claude **2.1.205** (system) and **2.1.260** (sandboxed npm copy),
> `CLAUDE_CONFIG_DIR` sandbox so the real `~/.claude` was never touched.

## The question

The user's preferred distribution mode is Claude Code's native
marketplace+plugin flow (`claude plugin marketplace add <url>` →
`claude plugin install name@mp`), not our adapter pipeline writing into
`~/.claude` by hand. Can Harness Nexus **serve** such a marketplace directly
over HTTP(S), with no git involved?

**Answer: yes.** Claude Code accepts a plain URL to a `marketplace.json`, and
plugins can be shipped as `archive` sources (HTTPS zip downloads, no git, no
npm). The full lifecycle — add, install, update, uninstall — is handled
natively by the Claude CLI. Details and sharp edges below.

## Verified facts

### 1. `marketplace add <http-url>` works without git, without TLS, without a `.json` suffix

- `claude plugin marketplace add http://127.0.0.1:8787/marketplace.json` → ✔
  (plain HTTP, loopback, HTTP/1.1 — accepted)
- `… add http://127.0.0.1:8787/api/marketplace` → ✔ (path suffix is
  irrelevant; the URL just needs to return the JSON)
- `… add http://…/weird/marketplace.json` served as `text/plain` → ✔
  (Content-Type is **not** validated; only the body is parsed)

So the *catalog* fetch is maximally permissive. The restrictions all live on
the **archive** (plugin payload) side.

### 2. `archive` plugin source: needs claude ≥ 2.1.224, HTTPS, and a non-loopback host

On **2.1.205**: install fails with *"This plugin uses a source type your
Claude Code version does not support. Update Claude Code and try again."*
(notably: it downloads the zip first, then rejects at validation — the version
gate is client-side post-download).

On **2.1.260**: install succeeds, with a hard SSRF guard on the archive URL:

> `source.url: Archive URLs must use https:// and must not point at a loopback,
> link-local, or cloud-metadata host`

Consequences for us:

- The **public deployment must be HTTPS** (our Caddy-on-:15921 front door
  satisfies this).
- **Local dev cannot use 127.0.0.1 for archives** — the spike worked around
  this with the machine's LAN IP (`10.0.0.7`) + a self-signed CA injected via
  `NODE_EXTRA_CA_CERTS` (which Claude Code **does** respect — useful for
  intranet deployments behind an internal CA).
- Users need claude ≥ 2.1.224. Older CLI users must fall back to the adapter
  pipeline (or upgrade their CLI).

### 3. Zip layout accepted

One folder deep: `hnx-test-plugin/.claude-plugin/plugin.json` +
`hnx-test-plugin/skills/hello/SKILL.md`. Installed plugin shows up in
`claude plugin details` with the skill in its component inventory, cached at
`<config>/plugins/cache/<marketplace>/<plugin>/<version>/` (versioned cache
directory — old and new versions coexist).

### 4. Auth: headers are unreliable; capability URLs are bulletproof

Docs suggest marketplaces can be registered with `headers` (e.g. via
`extraKnownMarketplaces`) and that those headers are forwarded to same-origin
archive downloads. **Empirically this is only partially true** (on 2.1.260):

- Declaring `extraKnownMarketplaces["mp"] = { source, headers }` in
  `settings.json` does **not** auto-register the marketplace.
- CLI `claude plugin marketplace add <url>` fetches **without** the declared
  headers (our gated server saw an unauthenticated request → 403).
- Some internal refresh path *did* send the header (one authenticated request
  hit the server), but the install still failed — the mechanism is not
  reliable enough to build on from user-level settings. (Possibly it behaves
  better from enterprise *managed* settings; untested.)

**The robust pattern is a capability URL**: embed a per-user secret token in
the path and serve both endpoints under it —
`/emit/<token>/marketplace.json` and `/emit/<token>/archives/<plugin>.zip`.
Then plain `claude plugin marketplace add https://host/emit/<token>/marketplace.json`
+ `plugin install` works with zero client-side configuration, on any
archive-capable version, because every fetch (catalog and archive, same
origin) authenticates by URL alone. Wrong token → 404 (indistinguishable
from nonexistent, no existence leak — same posture as our API 404 policy).

Security note: the token rides in URLs (stored in the user's claude settings
and cache). That is the same trust level as a PAT used as a bearer token;
scoped to marketplace emission it is acceptable. It should be a distinct
secret from login PATs, revocable, and rotated only on demand (rotation
forces re-`add`).

### 5. Update & uninstall are native and clean

- Bumping the plugin version inside the zip + `claude plugin marketplace
  update <mp>` + `claude plugin update <plugin>` → *"updated from 0.1.0 to
  0.2.0"*, re-downloads the archive. ✔
- `claude plugin uninstall <plugin>@<mp>` → clean removal. ✔

This is the core appeal: **Harness Nexus emits; Claude Code owns the install
lifecycle.** No install-state ledger needed on this path (contrast with the
Hermes adapter, where our ledger is the only reliable uninstall record).

### 6. Miscellaneous behaviors worth knowing

- A marketplace whose internal `name` is already registered **cannot be
  re-added from a different URL** — rejected with a settings-consistency
  error. Marketplace identity = the `name` field, so our emitted marketplace
  names must be unique per user (e.g. `harness-nexus-<username>`), or the
  add will collide across users on a shared machine.
- Install flow from URL marketplaces fetches: `marketplace.json` (on add and
  on install/update), then the archive zip once per install/update.
- `NODE_EXTRA_CA_CERTS` works for both the catalog fetch and archive download
  (self-signed intranet deployments are viable).

## Design implications (feeding `docs/design/phase-3-install.md` §3.5)

1. **New server surface: a marketplace emitter.** Per-user capability token →
   `GET /api/marketplace/<token>/marketplace.json` (catalog built from that
   user's visible profiles) + `GET /api/marketplace/<token>/archives/<…>.zip`
   (profile → plugin zip built on the fly). PAT-gated by token-in-path.
2. **No auth headers, no settings provisioning** — the flow must stay
   `marketplace add <one URL>` on a stock CLI.
3. **Zip assembly reuses the adapter vocabulary.** The zip *contents* are
   target-format files (`.claude-plugin/plugin.json`, `skills/…`); for
   claude-code the plugin layout is native; the same emitter can later serve
   other archive-capable consumers if they appear.
4. **Versioning**: marketplace entry `version` should track profile
   `version`; bump on profile edits so `plugin update` has something to pick
   up.
5. **Constraint to document loudly**: archives need public-ish HTTPS + claude
   ≥ 2.1.224; loopback-only deployments can't use this path (dev workaround:
   LAN IP + `NODE_EXTRA_CA_CERTS`).
6. **Relationship to the adapter pipeline**: not a replacement. Marketplace
   emission is the *preferred path for claude-code targets* (and any
   archive-capable CLI); the 3.3/3.4 adapter pipeline remains the path for
   Hermes (3.4, shipped) and future targets without a native marketplace
   (Codex etc.).

## Reproducing the spike

Rig lives (transiently) in `/tmp/cc-spike/` — server scripts (`server.cjs`,
`server-https.cjs`, `server-emit.cjs`), four marketplace variants, and the
plugin fixture. The essential recipe:

```bash
# plugin zip: .claude-plugin/plugin.json one folder deep
python3 -m zipfile ...  # or zip -r
# serve marketplace.json + zip over HTTPS on a NON-loopback host
claude plugin marketplace add https://<lan-ip>:<port>/emit/<token>/marketplace.json
claude plugin install <plugin>@<marketplace>
```

# Phase 4.4 research: Skill references & distribution

> Status: research complete. PRD: `docs/prd/phase-4-web-ui.md` (§4.4). Design:
> to be written (`docs/design/phase-4.4-skills.md`) before implementation.

This answers the open questions that gate the Skill management sub-phase: how
Harness Nexus should represent and resolve an **external skill reference**, whether
the existing `ResourceSource` variants cover it, and how a stored reference maps
onto the three install targets (Claude Code, ZCode, Hermes).

## The single most important finding (corrects a premise)

**Skills are never distributed alone — they are bundled inside _plugins_** in
the Claude Code / ZCode world. "Install a skill from a hub" is, in that world,
"install a _plugin_ (from a marketplace) whose `skills/<name>/SKILL.md` the tool
then exposes." And there is **no live-reference model**: installing a plugin
**clones and caches** it locally (`~/.claude/plugins/cache/…`,
`~/.zcode/cli/plugins/cache/…`). A "reference" is materialized, not dereferenced
at runtime.

**But this is only half the picture.** Hermes (installed and running on this
machine, source read-only at `~/.hermes/hermes-agent/`) implements a far richer
**multi-source model** where skills _are_ first-class, addressable across many
heterogeneous sources — not just one plugin marketplace. That model is the more
complete answer to "how does an agent find skills from multiple sources," and it
is the model we should learn from for 4.4. See the dedicated section
**"Hermes: a multi-source skill hub (verified on this machine)"** below.

This reshapes 4.4: Harness Nexus isn't storing a _live_ skill reference — it's
storing a **source spec** (plugin entry for CC/ZCode; one of several adapter
kinds for Hermes) that, at install time, gets resolved and materialized. The
"search the skill hub" feature is really **search across configured sources**.

## Confirmed distribution facts (2026-07, high confidence)

Verified against official Claude Code docs, the live `claude-plugins-official`
catalog, GitHub issues, and on-disk ZCode evidence on this machine.

### Marketplaces & addressing

- **Three Anthropic-maintained plugin directories** (none is literally named
  "Skill Hub"): `claude-plugins-official` (auto-available by default),
  `anthropics/skills` (skills-specific), `claude-plugins-community` (validated
  third-party, SHA-pinned). Browse UI at `claude.com/plugins`.
- **ZCode mirrors this**: its own `zcode-plugins-official` marketplace + tracks
  `anthropics/claude-plugins-official` as a `github`-sourced known marketplace
  (confirmed in `~/.zcode/cli/plugins/known_marketplaces.json` on this machine).
- **Addressing:** `/plugin install <plugin-name>@<marketplace-name>`. A
  marketplace is added once via `/plugin marketplace add <owner/repo | git-url |
local-dir | url-to-marketplace.json>`. `marketplace add owner/repo` is the
  dominant form (git clone).

### `marketplace.json` source kinds (authoritative)

A marketplace entry points at a plugin via a `source`. The verified kinds:

| Source kind                                   | Fetch                                      | Pinning                            |
| --------------------------------------------- | ------------------------------------------ | ---------------------------------- |
| `github` (`owner/repo`, optional `ref`/`sha`) | git clone GitHub repo                      | `sha` is effective pin             |
| `url` (any git URL; `ref`/`sha`/`path`)       | git clone any host                         | `sha` is effective pin             |
| `git-subdir` (`url`/`path`/`ref`/`sha`)       | **sparse/partial clone** of a subdirectory | `sha` is effective pin             |
| relative path (`./…`)                         | co-located in the marketplace's own repo   | resolved against `.claude-plugin/` |
| `npm` (`package`/`version`/`registry`)        | `npm install`                              | `version` field                    |

Notes:

- **`filesystem` is NOT a Claude source kind.** It only appears in ZCode's local
  _cache_ metadata (`cachePath`), describing an already-installed plugin — not a
  fetchable source. (The PRD's earlier "skill hub / npx" enumeration was
  approximate; this is the corrected list.)
- `npm` is a real, documented source kind (consumer-side schema in the official
  docs; triple-corroborated by issues #37093, #33253, #37670) but is **not used
  in the current official catalog** — the live `claude-plugins-official`
  `marketplace.json` uses only `github`/`url`/`git-subdir`/relative-path.
  `git-subdir` is the common choice for skill-heavy plugins from big vendors
  (cloudflare, mongodb, databricks, stripe, airtable).
- `git-subdir` has client-compatibility bugs (issues #585, #768) — prefer `url`
  for broad compatibility.

### What "npx skill" / npm-based skills actually mean

- **The native flow** for an npm-distributed plugin: a marketplace entry with
  `source: { source: 'npm', package, version, registry? }`; the user runs
  `plugin install <name>@<marketplace>`; the tool runs `npm install` under the
  hood. So "npm skill" = "plugin whose source kind is `npm`".
- **`npx @org/skill-name` as a one-liner is NOT native** — it's a third-party CLI
  pattern (e.g. Vercel's `add-skill`, `skills.sh`). We should not model our
  reference on it; if a user has an npm-packaged skill, the right representation
  is the `npm` marketplace source kind, not an `npx` invocation string.
- **Concrete published npm-sourced skill example: not found.** Schema and bug
  reports confirm npm works; we could not point to a canonical published one. If
  a user asks for an npm skill, we store the npm source spec.

### Versioning

Resolution order (from the plugin-marketplaces doc):

1. `version` in the plugin's `plugin.json`.
2. `version` in the marketplace entry.
3. the git commit SHA.

Git-based sources may omit `version` entirely — "every new commit is treated as
a new version." **No evidence** that a `version` field in `SKILL.md` frontmatter
drives resolution; versioning is plugin/marketplace-entry level, not per-skill.

### Runtime skill addressing

Once installed, a skill is addressed `plugin:skill`-style
(e.g. `document-skills:docx`, `skill-creator:skill-creator`) — confirmed by the
skills loaded in this very environment. The plugin namespace disambiguates
collisions.

## Hermes: a multi-source skill hub (verified on this machine)

Source read-only at `~/.hermes/hermes-agent/tools/skills_hub.py` (4073 lines) +
`tools/skills_guard.py` + `hermes_cli/skills_hub.py`. **All read-only; Hermes is
running in production on this host and was not modified.** This is the most
complete real-world design for "find skills from multiple sources" we have
access to, and it diverges meaningfully from the CC/ZCode single-marketplace
model — skills here _are_ first-class across heterogeneous sources.

### The core abstraction: a `SkillSource` adapter

```python
class SkillSource(ABC):
    def search(self, query, limit=10) -> List[SkillMeta]      # find
    def fetch(self, identifier)   -> Optional[SkillBundle]    # download files
    def inspect(self, identifier) -> Optional[SkillMeta]      # metadata only
    def source_id(self)           -> str                       # 'github', 'url', …
    def trust_level_for(self, identifier) -> str               # trust tier
```

Every source is a plug-in implementing the same 4-method interface. The runtime
holds a **list** of sources and queries them **in parallel** (thread pool,
per-source timeout, 30 s overall). This is the key architectural lesson: **the
source layer is an open set behind a uniform interface, not a hardcoded
marketplace.**

### The 9 concrete source adapters (the full source set)

From `create_source_router()`, in priority order:

| source_id            | Class                     | What it fetches                                                           | Trust                                       | Notes                                                                                                    |
| -------------------- | ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `official`           | `OptionalSkillSource`     | skills shipped in the repo's `optional-skills/`                           | `builtin`                                   | Nous-maintained, not activated by default                                                                |
| `hermes-index`       | `HermesIndexSource`       | a pre-built merged index (cached, 1 h TTL)                                | per-skill                                   | **When available, all external API sources are skipped** (avoids ~70 GitHub calls/search)                |
| `skills-sh`          | `SkillsShSource`          | skills.sh catalog (~20k+, via sitemap) → underlying GitHub repo           | community                                   | **This is the real `npx skills add` source** — its regex parses `npx skills add <repo> [--skill <name>]` |
| `well-known`         | `WellKnownSkillSource`    | a domain's `/.well-known/skills/index.json`                               | community                                   | standard discovery protocol                                                                              |
| `url`                | `UrlSource`               | a single `SKILL.md` at a direct HTTP(S) URL                               | community                                   | identifier **IS** the URL; single-file only                                                              |
| `github`             | `GitHubSource`            | GitHub repos via Contents API + configurable **taps**                     | `trusted` for 4 named repos, else community | default taps: openai/skills, anthropics/skills, huggingface/skills, NVIDIA/skills, garrytan/gstack       |
| `clawhub`            | `ClawHubSource`           | clawhub.ai HTTP API (50k+)                                                | community                                   | **explicitly distrusted** — "ClawHavoc" incident (341 malicious skills, Feb 2026)                        |
| `claude-marketplace` | `ClaudeMarketplaceSource` | CC marketplace repos (`.claude-plugin/marketplace.json`)                  | community                                   | known: anthropics/skills, aiskillstore/marketplace                                                       |
| `lobehub`            | `LobeHubSource`           | LobeHub agent marketplace (14.5k) → converts prompt templates to SKILL.md | community                                   | data in lobehub/lobe-chat-agents                                                                         |
| `browse-sh`          | `BrowseShSource`          | browse.sh catalog (200+ site-automation SKILL.md)                         | community                                   | Browserbase-hosted                                                                                       |

**This directly answers the "npx skill" question:** `npx skills add` is the
install command surfaced by **skills.sh** (`SkillsShSource` parses it). It is
not a source kind of its own — it's a CLI wrapper around a GitHub repo, where
skills.sh is the discovery index. The underlying fetch is still GitHub.

### Trust + security model (this is the differentiator)

Three tiers, resolved per-source and enforced by a **security scan before
install** (`tools/skills_guard.py`):

```python
TRUSTED_REPOS = {"openai/skills", "anthropics/skills",
                 "huggingface/skills", "NVIDIA/skills"}
INSTALL_POLICY = {
    #                  safe     caution   dangerous
    "builtin":       ("allow", "allow",   "allow"),
    "trusted":       ("allow", "allow",   "block"),
    "community":     ("allow", "block",   "block"),
}
```

- **`builtin`** — ships with Hermes, never scanned.
- **`trusted`** — the 4 named GitHub repos; caution findings allowed, dangerous blocked.
- **`community`** — everything else; any non-safe finding blocks (unless `--force`,
  and never for `dangerous`).

Every fetched skill goes through **quarantine → scan → install**: the bundle is
written to `skills/.hub/quarantine/`, scanned against a regex threat-DB
(exfiltration / injection / destructive / persistence / network / obfuscation
patterns), and only installed to `~/.hermes/skills/` if the verdict × trust tier
permits. This is a meaningful security boundary the CC/ZCode model lacks.

### Provenance: `lock.json` + `taps.json` + audit log

Installed skills are tracked in `skills/.hub/lock.json` (full provenance per
skill):

```jsonc
{
  "version": 1,
  "installed": {
    "<skill-name>": {
      "source": "github", // source_id
      "identifier": "anthropics/skills/skill-creator",
      "trust_level": "trusted",
      "scan_verdict": "safe",
      "content_hash": "...", // integrity pin
      "install_path": "~/.hermes/skills/skill-creator",
      "files": ["SKILL.md", "..."],
      "metadata": {},
      "installed_at": "...",
      "updated_at": "...",
    },
  },
}
```

- **`taps.json`** — user-added GitHub repo sources (`{repo, path}`); extend
  `GitHubSource`'s default taps at runtime. This is the user-facing "add a
  source" mechanism.
- **`audit.log`** — append-only record of every install/scan/uninstall with
  verdict.
- **content_hash** — the integrity pin (analogous to CC's SHA pin, but per-skill
  and hash-based, not git-SHA-based).

### Merge / dedup / ranking

Search results from all sources are merged (`parallel_search_sources`), deduped
by `identifier` (keeping the highest-trust copy), then sorted by
`(-trust_rank, source != "official", name)`. So `builtin` > `trusted` >
`community`, official first within a tier, then alphabetical. This is the
ranking policy that makes a multi-source hub usable.

### Implication for our `ResourceSource` (refines the earlier recommendation)

The CC/ZCode-only recommendation was a single `plugin` variant. Hermes shows
the real shape: **the source layer is open and heterogeneous.** The "plugin"
concept is just _one_ adapter kind among many (CC marketplace, GitHub repo,
skills.sh, url, well-known, vendor hubs). The recommendation in the next
section is updated to reflect this — `ResourceSource` should model a **source
kind** (open set), not a single `plugin` variant.

Our domain (`packages/core/src/domain/resource.ts`):

```ts
type ResourceSource =
  | { type: 'git'; url: string; ref?: string; path?: string }
  | { type: 'tarball'; url: string; checksum?: string }
  | { type: 'local'; path: string }
  | { type: 'inline'; content: string };
```

### Conclusion: a skill needs a NEW `ResourceSource` variant

The existing four don't cleanly express "this skill comes from plugin `foo` in
marketplace `bar`, pinned to this SHA / npm version, living at this subpath" —
nor the richer "this skill comes from skills.sh / a direct URL / a well-known
index" shapes that Hermes surfaces.

- `git` is close but lacks the **plugin/marketplace indirection** (the namespace,
  the skill subpath inside the plugin, the entry version pin). A bare git ref
  loses "which plugin in this repo, which skill in that plugin."
- `tarball`/`local`/`inline` don't apply to marketplace distribution.
- Nothing models the **non-plugin** external sources (direct URL, skills.sh,
  well-known index) that Hermes treats as first-class.

**Recommended new variant** — a `plugin` source for the CC/ZCode marketplace
shape, validated against the marketplace source-kind table above:

```ts
| {
    type: 'plugin';
    // A marketplace plugin entry — mirrors marketplace.json source kinds.
    source:
      | { source: 'github'; repo: string; ref?: string; sha?: string; path?: string }
      | { source: 'url'; url: string; ref?: string; sha?: string; path?: string }
      | { source: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
      | { source: 'npm'; package: string; version: string; registry?: string };
    // Which plugin this entry resolves to, and which skill(s) it exposes.
    plugin: string;
    // Optional: pin a marketplace-entry version (falls back to sha/git-commit).
    version?: string;
  }
```

This is a deliberate choice over overloading `git`, because:

1. It preserves the **plugin namespace** (`plugin` field) so emitted bundles and
   profile entries can address `plugin:skill` correctly.
2. It distinguishes `git-subdir` (sparse clone) from `github`/`url` (full clone),
   which matters for install correctness — not all clone strategies are equal.
3. It keeps `npm` first-class, matching the documented source kind.

`inline` still covers a user-authored markdown skill (no external source) — the
simple case from the PRD. The existing `url`/`tarball`/`local` variants already
cover the Hermes `url` / single-file / local-directory cases, so no new variant
is needed for those — only `plugin` is genuinely missing for the marketplace
world. (skills.sh is ultimately a GitHub fetch behind an index, so a `plugin`
github entry or `git` covers it once the index resolves it.)

### How a stored skill reference flows to install

| Skill `source`              | Install-time behavior (Phase 3 writer)                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inline`                    | Emit `skills/<key>/SKILL.md` directly into the bundle (content is in the row).                                                                                         |
| `plugin`                    | Emit a marketplace-add + plugin-install instruction (or pre-resolve by fetching the plugin and copying its `skills/<name>/` into the bundle). Pin via `sha`/`version`. |
| `git` / `tarball` / `local` | Resolve the bytes and copy `SKILL.md` into the bundle's `skills/`.                                                                                                     |

The "search the skill hub" UI feature = fetch a known marketplace's
`marketplace.json`, list its plugin entries (filtered to those exposing skills),
let the user pick one, and store it as a `plugin`-source resource. **Do not**
attempt to fetch/index individual `SKILL.md` files across repos — the marketplace
entry is the unit. (Hermes's `parallel_search_sources` + merged index is a more
ambitious version of this; for our first cut a single-marketplace browse is the
pragmatic scope, with the `SkillSource`-adapter pattern as the documented
extension path if we later want multi-source.)

## Open risks & decisions to confirm (for the design doc)

1. **New `ResourceSource` variant vs. reuse `git`.** Research recommends a new
   `plugin` variant (better fidelity). Confirm before the design doc, since it
   touches `core`/`shared`/storage/SDK.
2. **Marketplace registry: which to search?** Start with
   `claude-plugins-official` (auto-available, broadest). Whether to also surface
   `anthropics/skills`, community marketplaces, or a user-configured custom
   marketplace URL is a product-scoping decision.
3. **Resolution at store-time vs install-time.** When a user "saves a skill
   reference," do we (a) store only the spec and resolve at install, or (b)
   fetch + pin the SHA immediately so the reference is immutable? Recommend (a)
   store-the-spec, with an optional explicit `sha`/`version` pin for (b).
   Pinning avoids supply-chain drift; floating `ref` tracks upstream.
4. **Fetching marketplace JSON server-side.** Searching a marketplace requires
   Harness Nexus to fetch a remote `marketplace.json` (or a git repo) — this is a
   new outbound-network path (the server is otherwise fetch-light; only the
   proxy dials configured upstreams). Decision: a dedicated, allowlisted
   marketplace-fetch endpoint, or have the CLI/web fetch client-side. Affects the
   security model.
5. **Skill within a multi-skill plugin.** A plugin can expose many skills. Does
   one stored resource = one plugin (all its skills) or one plugin + one skill
   name? Recommend **plugin-level** (matches how tools address them as
   `plugin:skill` and how marketplaces list them), with the skill name可选.
6. **npm registry for `npm` sources.** Default to the public registry; private
   registries need credential handling (reuse the `${cred:NAME}` model from 2.1).
7. **Trust tiers + security scan (from Hermes).** Hermes blocks community skills
   with any non-safe scan finding, and its `clawhub` source is explicitly
   distrusted after a real malicious-skills incident. For 4.4's first cut we
   likely **don't** run a content scanner (Harness Nexus stores references, it
   doesn't execute them — the target tool does). But the **trust tier** concept
   (`builtin`/`trusted`/`community`, visible in the UI) and provenance pinning
   (`sha`/`content_hash`, recorded like Hermes's `lock.json`) are worth adopting
   from the start, since they're cheap and inform the install-warning UX. A scan
   gate is a later hardening if we ever materialize/execute skill bytes.
8. **Multi-source extensibility (from Hermes).** Hermes's `SkillSource` ABC +
   9 adapters + parallel search + merged index is the mature end-state. Our
   first cut is one marketplace; but designing `ResourceSource` and the
   (future) search endpoint so a second source kind (skills.sh, direct URL,
   custom tap) can be added without schema churn is worth it. Concretely: keep
   the source spec as a discriminated union (open set), not a single shape.

## Honest gaps

- **No concrete published npm-sourced skill/plugin** to point to. The schema is
  verified; adoption is not. Model it anyway (it's documented), but don't build
  npm-search until there's demand.
- **Skill-frontmatter `version` for resolution:** not evidenced. Treat
  versioning as plugin/marketplace-entry-level.
- **`commit` vs `sha` field semantics** in some live `github` entries: both
  appear in the wild but the docs only explain `sha`. Treat them as aliases for
  now; verify in the design doc.

## Sources

- Claude Code: [plugin-marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
  (source kinds, version resolution), [discover-plugins](https://code.claude.com/docs/en/discover-plugins),
  [skills](https://code.claude.com/docs/en/skills).
- [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
  - its live [`marketplace.json`](https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json).
- [anthropics/skills](https://github.com/anthropics/skills).
- npm source evidence: issues
  [#37093](https://github.com/anthropics/claude-code/issues/37093),
  [#33253](https://github.com/anthropics/claude-code/issues/33253),
  [#37670](https://github.com/anthropics/claude-code/issues/37670).
- `git-subdir` compat: issues
  [#585](https://github.com/anthropics/claude-plugins-official/issues/585),
  [#768](https://github.com/anthropics/claude-plugins-official/issues/768).
- ZCode (on-disk, this machine): `~/.zcode/cli/plugins/known_marketplaces.json`,
  `~/.zcode/cli/plugins/marketplaces/zcode-plugins-official/marketplace.json`,
  `~/.zcode/cli/plugins/cache/zcode-plugins-official/*/.zcode-plugin-seed.json`.
- Earlier Phase 3 target research: `docs/research/phase-3-plugin-targets.md`
  (plugin/skill _format_ per target — this doc is about _sourcing_).

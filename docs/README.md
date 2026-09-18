# Harness Nexus documentation

Since 2026-09 the documentation is split by **audience and coupling**:

## In this repo — code-coupled contract docs

| File / folder                          | What it is                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| [`architecture.md`](./architecture.md) | layering, storage contract, MCP transport — changes must ride the PR that changes the code |
| [`adr/`](./adr)                        | architecture decision records — irreversible cross-cutting choices                         |

## In the GitHub wiki — everything else

Feature guides (user-facing), PRDs, technical designs, research notes, and
the historical roadmap live in the
[GitHub wiki](https://github.com/sinrimin/harness-nexus/wiki):

- `features/` — what the product does, per capability area
- `dev/prd/` · `dev/design/` · `dev/research/` — the development process docs
  (imported from this folder 2026-09; indexed by `dev/README.md` there)
- `dev/roadmap.md` — the historical phase plan; forward planning lives in
  [issues + milestones](https://github.com/sinrimin/harness-nexus/milestones)

The wiki is a git repository
(`https://github.com/sinrimin/harness-nexus.wiki.git`) — keep a clone next to
this repo (`../harness-nexus.wiki`) and edit through git, not the web editor.

Exception: `docs/dev/test-rig.md` (verification-rig notes) is machine-specific
and stays local + git-ignored — it is deliberately not published.

The development workflow itself (issues, branches, verification, releases) is
documented in the root [`CONTRIBUTING.md`](../CONTRIBUTING.md).

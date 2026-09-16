# Research: Phase 9 W12 — OpenCode runtime onboarding

> Status: **verified against the official docs (2026-09-16)** — opencode.ai
> `/docs`, `/docs/acp`, `/docs/config`, `/docs/providers`. The rig E2E section
> at the end records what the live install confirmed. OpenCode is SST's
> open-source terminal coding agent (GitHub `sst/opencode`, npm
> [`opencode-ai`](https://www.npmjs.com/package/opencode-ai), binary
> `opencode`). This note is the ground truth the W12 implementation is built
> on — same role as the T1 dsh note for deepseek.

## 1. Install & version

- npm package **`opencode-ai`** (NOT `opencode`); `npm i -g opencode-ai`
  ships a platform binary via postinstall (needs network on the machine).
- Other channels exist (official install script, brew, direct download) —
  **we use npm only** for install/upgrade/pin, same as codex. No native
  self-update exception in our job table (`opencode upgrade` exists upstream
  but the npm channel covers all three actions uniformly).
- Version pinning = `npm install -g opencode-ai@<exact>`; default channel
  tag `latest`.
- `opencode --version` prints a semver — feeds the W1 runtime probe
  (first line, ≤64 chars, 5s timeout — our standard shape).

## 2. ACP — native, no adapter needed

OpenCode speaks the **Agent Client Protocol natively**: the command is
**`opencode acp`** (official docs `/docs/acp`; also listed in the ACP
registry used by Zed). No third-party wrapper (contrast: claude-code rides
`@agentclientprotocol/claude-agent-acp`, codex rides `zed-industries/codex-acp`).

- Dialect: standard ACP (Zed-ecosystem shaped) — the daemon's existing
  `mapAcpUpdate` standard arm applies. Rig-verified end to end (§5).
- `session/list`-shaped native session surfaces are NOT exposed over ACP
  here → the chat rail stays `supported:false` (honest default; the
  sessions handler's generic fall-through already answers that).

## 3. Config layout (the W3 writer's target)

- Global config: **`~/.config/opencode/opencode.json`** (JSON; JSONC with
  comments accepted by opencode itself). Project config `opencode.json`
  walks up to the git root; **we only touch the global file**. Env
  overrides exist (`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`) — we do not
  set them; the machine user's default layout wins.
- Config files MERGE (remote → global → env → project → managed); our
  writes are therefore additive blocks inside the global file.
- **Custom provider block** (`provider.<id>`):

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "provider": {
      "<id>": {
        "npm": "@ai-sdk/openai-compatible",
        "name": "Display Name",
        "options": { "baseURL": "https://api.example.com/v1", "apiKey": "{env:VAR}" },
        "models": {
          "<model-id>": { "name": "Model Display Name", "limit": { "context": 200000 } }
        }
      }
    }
  }
  ```

  - `npm` — the AI SDK package driving the wire: **`@ai-sdk/openai-compatible`
    for `/v1/chat/completions`**, **`@ai-sdk/openai` for `/v1/responses`**,
    `@ai-sdk/anthropic` for the anthropic wire. This is a FINER axis than
    our W3 `api` enum → our `PROVIDER_API_KIND` maps onto it exactly
    (`openai-chat` → compatible, `openai-responses` → openai, `anthropic`
    → anthropic).
  - `options.baseURL` — custom endpoint; omitted → the built-in provider
    default (models.dev).
  - `options.apiKey` — variable substitution: `{env:VAR}` (resolved from
    opencode's process env — misses the user's own TUI runs) or
    **`{file:~/path}`** (resolved by every opencode invocation — TUI, ACP,
    headless). **We use `{file:}` + a 0600 key file** so the pushed key
    works for ALL launch modes, not just our daemon's spawns.
  - `models` is an object map (not an array); unknown models default to
    `{}` entries. `limit.context` optional (unknown → opencode treats as
    unlimited; we do not invent numbers).

- **Default model**: top-level **`model` = `"provider/model-id"`** (also
  `small_model` for cheap tasks — we leave that alone).
- `/connect` credentials live in `~/.local/share/opencode/auth.json` —
  **never read or written by us** (it is the user's own auth store).
- MCP: top-level **`mcp`** block in opencode.json — local stdio entries
  (`command`/`args`/env) and remote (`url`) servers. This is the C3
  scanner's MCP source.

## 4. Skills / commands / agents (the C3 scanner's sources)

Global (OPENCODE_CONFIG_DIR default) `~/.config/opencode/`:

- `command/*.md` — slash commands (frontmatter `description`).
- `agent/*.md` — custom agents (maps to our `sub_agent` kind).
- Skills: opencode added Agent-Skills-style support (`skill/<name>/SKILL.md`
  in the config dir); the scanner reads it if present and skips cleanly on
  versions without it (dir absent).

## 5. Rig verification (2026-09-16, machine container `hnx-cc-machine`)

See `docs/dev/test-rig.md` for rig mechanics. What the live E2E confirmed
— including two corrections to the docs-derived assumptions:

- `npm i -g opencode-ai` lands `opencode` on PATH; `opencode --version`
  prints a clean semver line (probe shape OK); realpath classifies `npm`.
- `opencode acp` initializes over stdio with the standard dialect; a chat
  turn streams through our unmodified `mapAcpUpdate` (portal + headless).
- **baseURL must end with `/v1` (rig-found, the session's one real bug).**
  `@ai-sdk/anthropic` / `@ai-sdk/openai-compatible` expect the base to end
  with `/v1` (their defaults do) and append only the method path. Ark's
  `/api/coding` — which claude-code takes VERBATIM, it appends `/v1/…`
  itself — therefore posted to `/api/coding/messages` and the gateway
  auth-checks BEFORE routing, so the failure reads "Unauthorized", not
  404. The writer now normalizes (`opencodeSdkBaseURL`). Verified by
  curling both paths with the same key: right path 200, `/v1`-less 401
  with the EXACT error opencode surfaced.
- **The key file must be the RAW secret, no trailing newline.** opencode
  reads the `{file:…}` target verbatim; a `
` rides the key and the
  gateway rejects it (46-byte key + `
` = 47 bytes = 401).
- `options.apiKey` IS wired for custom providers (provider.ts:1774 —
  config apiKey with `provider.key` fallback); auth.json is NOT needed
  for our flow. (`~/.local/share/opencode/auth.json` remains the user's
  own `/connect` store; `{type:"api", key}` shape, 0600 — read from
  source packages/opencode/src/auth/index.ts, which also documents the
  `OPENCODE_AUTH_CONTENT` env override.)
- The provider block + `{file:}` key reference drive live turns on the
  pushed route (headless `opencode run` + a portal ACP turn both
  answered), and the viewer shows `opencode.json` masked where secrets
  appear with the `.key` file wholesale-redacted.

## 6. What we deliberately do NOT do (deferred / out of scope)

- **Profile install adapter** (deploy axis) — opencode is runtime-managed +
  chatable; local-write profile installs would be a separate wave (it has
  no hooks surface to install into anyway — plugins are TS code).
- **Native sessions rail** — no `session/list` surface over ACP here;
  `supported:false`.
- **`~/.local/share/opencode/auth.json`** — the user's own credential
  store; our key file is separate by design.
- **JSONC tolerance** — if the user's global `opencode.json` contains
  comments and fails `JSON.parse`, the apply-config job FAILS with an
  explicit error instead of guessing; hand-managed files are documented as
  out of bounds for the writer.

# Research: Phase 9 — Harness runtime lifecycle (binaries, versions, provider config)

> Status: **studied** (2026-09, W3 provider-config ground truth added 2026-09-08).
> The design (`docs/design/phase-9-harness-runtime.md`) builds on this; W1/W2
> shipped, W3 shipped.
>
> Sources: official Claude Code docs (code.claude.com — setup / settings /
> env-vars / model-config), official Codex docs + the codex-rs SOURCE on
> GitHub (main @ 2026-09-08), the Phase 8 T1 dsh research
> (`docs/research/phase-8-t1-deepseek-harness.md`, pinned to dsh `v0.1.2-rc.1`)
> and the acp-ref reference project's dsh overlay. W3 dsh facts were verified
> against the REAL `@deepseek-ai/dsh@0.1.2-rc.1` install in the local rig
> machine container (installed by the W2 acceptance run).

## 1. The question

Phase 8 C3/C4 manage **profile artifacts** (skills, commands, MCP rows) on a
machine. Nothing in the platform today can answer or act on:

- Is `claude` / `codex` / `dsh` **installed** on this machine? Which binary
  path, which **version**, installed **how** (npm / native / brew)?
- **Install / upgrade / pin** that software remotely, one click.
- Configure the **LLM provider route** (provider, base URL, model, API key)
  the harness should use — remotely, without SSH.
- **View** the harness's effective configuration from the web UI (redacted).
- And the model question underneath it all: inventory should be **Agent-first**
  (detect the Agent — the installed harness — then what's inside it), and
  **chat should key off the detected Agent**, not off a deploy record: a
  claude-code installed via the 3.5 emitter can't be chatted with today purely
  because that install path never creates an `AgentInstance`.

## 2. Claude Code (`claude`)

### Install methods

| Method               | Command                                                                     | Notes                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native (recommended) | `curl -fsSL https://claude.ai/install.sh \| bash`                           | No Node dependency. Pin: `bash -s 2.1.89` or `bash -s stable`. Windows: `install.ps1` / `install.cmd`.                                                                   |
| npm                  | `npm install -g @anthropic-ai/claude-code`                                  | Node **22+** required since v2.1.198 (the package itself ships a native binary via optional deps). npm installs are soft-deprecated in favor of native. Never with sudo. |
| Homebrew             | `brew install --cask claude-code` (`@latest` for the bleeding-edge channel) | No auto-update by default.                                                                                                                                               |

### Update semantics

- Native installs **auto-update in the background** (startup + periodic checks);
  manual: `claude update`. `DISABLE_AUTOUPDATER=1` (settings `env`) disables the
  background updater, `DISABLE_UPDATES` blocks everything.
- npm: `npm install -g @anthropic-ai/claude-code@latest` — **not** `npm update -g`
  (respects the original semver range and may stay behind).
- Channels: `latest` (default, every release) vs `stable` (~a week old, regressions
  skipped) — `autoUpdatesChannel` in settings.json or `/config`. `minimumVersion`
  guards against downgrades when switching channels.
- **Consequence for remote management:** a platform-managed machine should set
  `DISABLE_AUTOUPDATER` so our pinned/upgrade jobs are the only version movers.

### Detection & version

- `claude --version` → `2.1.211 (Claude Code)` (`<semver> (Claude Code)`).
- Native launcher: `~/.local/bin/claude` → `~/.local/share/claude/versions/…`;
  npm: resolves under the global `node_modules`; brew: under the brew prefix.
  Install-method detection = bin-path prefix sniff + `claude doctor` exists but is
  interactive-ish; path sniff is enough and cheap.

### Config & provider routing

- `~/.claude/settings.json` is the sanctioned file: `env` block
  (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`,
  `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`), `model`,
  `autoUpdatesChannel`, `permissions`, `apiKeyHelper`. Enterprise managed
  settings override it (out of our scope).
- Routing nuance: `ANTHROPIC_BASE_URL` only changes **where** requests go; the
  model is chosen by `model` / `ANTHROPIC_DEFAULT_*`. Both must be set together
  for a provider switch.
- Keys **may** live in settings.json `env` — that is the documented pattern for
  custom endpoints (file perms 0600 apply as our hygiene, not theirs).

## 3. Codex (`codex`)

### Install & update

- `npm i -g @openai/codex` (Node 18+; Rust binary via npm wrapper) ·
  `brew install --cask codex` · winget · direct binary from
  github.com/openai/codex releases.
- No built-in updater contract we can rely on: upgrade = **reinstall the same
  channel** (`npm i -g @openai/codex@latest`, `brew upgrade codex`). Pinning =
  `@<version>` on npm. Version: `codex --version` → `codex-cli <semver>` (older
  builds) or a bare semver (newer); parse leniently.

### Config & provider routing

- Home: `$CODEX_HOME` (default `~/.codex`). Config: `config.toml` —
  `model`, `model_provider`, and per-provider blocks:

  ```toml
  [model_providers.my-gateway]
  name = "My Provider"
  base_url = "https://gw.example.com/v1"
  wire_api = "chat"            # or "responses"
  env_key = "MY_GATEWAY_API_KEY"   # env var NAME the provider reads
  ```

- Auth: `~/.codex/auth.json` — `{"auth_mode": "apikey", "OPENAI_API_KEY": "sk-…"}`
  or ChatGPT-login tokens; `codex login --with-api-key` (key via stdin) writes it.
- Caveats that matter to us: a custom provider **cannot reuse** built-in OpenAI
  auth — supply its own key via `env_key` (an env var the codex process must
  have) or a provider-specific auth file; `requires_openai_auth = true` flips a
  provider back to auth.json and ignores `env_key`. Our remote apply must write
  BOTH the TOML block and a working key channel (auth.json for apikey mode;
  for custom providers the key has to reach the process env — see §5).

## 4. DeepSeek Harness (`dsh`)

From the T1 research (ground truth pinned to `v0.1.2-rc.1`, developer preview —
expect movement across 0.1.x):

- **Install:** npm-distributed — `npm i -g @deepseek-ai/dsh` (runs fine via
  `npx @deepseek-ai/dsh …` too). Home: `$DSH_HOME` → `~/.dsh`. `dsh --version`
  prints the semver.
- **Layering:** profiles at `~/.dsh/profiles/<name>/` (pnpm-managed plugin
  sets) → profile `cordis.patch.yml` → **home `cordis.patch.yml`** (applies to
  every profile, hot-reloads live). T1 already owns a managed MARKED region in
  the home patch for MCP rows — the same region mechanism extends to provider
  rows.
- **Provider config** (verified in the acp-ref overlay): the LLM provider is a
  Cordis plugin, configured as patch rows:

  ```yaml
  - id: llm-pi-ai
    name: '@deepseek-ai/dsh-llm-pi-ai'
    config:
      providers:
        demo:
          api: anthropic-messages # or the OpenAI-compatible api
          baseURL: https://…
          apiKeyEnv: LLM_API_KEY # env var NAME — the key never sits in the yml
          models:
            - id: <model-id>
  ```

  The key reaches dsh via process env (`apiKeyEnv`), not via a file. The acp-ref
  bridge does exactly this: template + env, applied with `--patch`.

## 5. Cross-cutting observations

1. **Version probing is trivial and uniform** — all three answer `<cli> --version`
   on PATH; a scanner can also locate the bin (`which`-walk over PATH + the known
   per-method locations) and classify the install method by path prefix
   (`~/.local/share/claude` → native; global `node_modules` → npm; brew prefix →
   brew; else unknown).
2. **Upgrades are idempotent reinstalls** (npm `@latest`/`@<version>`, brew
   upgrade) or a built-in updater (`claude update`). Downgrade = pin install.
   No separate "uninstall upgrade" concept — reversal is just another pin.
3. **Auto-update fights the manager** only for Claude Code — remote-managed
   machines should get `DISABLE_AUTOUPDATER` alongside our installs.
4. **Secret placement differs per harness** and the platform must map a
   credential onto each native slot:
   - claude-code → `settings.json` `env` (sanctioned; 0600 the file ourselves),
   - codex → `auth.json` (apikey mode, 0600) or a custom provider's `env_key`,
   - dsh → `apiKeyEnv` process env (no file slot at all).
     The one genuinely awkward case is env-based key channels (dsh `apiKeyEnv`,
     codex `env_key`): daemon-spawned ACP sessions can be given env directly, but
     a key typed by the user into their own shell needs a persistent env file
     (`~/.dsh/env` + shell hook, or a tiny wrapper) — W3 designs this per target.
5. **Node prerequisites differ** (claude-code npm needs Node 22+, codex 18+,
   dsh is itself a Node runtime) — but every machine running our daemon already
   has Node ≥20 (hnx requires it), so npm is a viable universal channel; the
   native installer is the fallback for claude-code on Node-less machines.
6. **Machines need egress** to npm (and claude.ai for native installs); proxied
   machines must pass proxy env through to the spawned installer — the daemon
   job executor should forward `HTTP(S)_PROXY`/`npm_config_registry` from its
   own environment.

## 6. Agent-first inventory — the model today vs. the model we want

**Today (C3/C4/C5):** scanning enumerates _items_ per target regardless of
whether the harness is even installed; `AgentInstance` rows exist only as a
side effect of C4 deploys (`claude-code` deliberately excluded — the 3.5
emitter is its preferred path); chat gating starts at `AgentInstance →
remoteChatEnabled → online → capability → cap`. Consequence: a machine with a
perfectly good `claude` shows empty target cards (pre-fix: no explanation) and
no chat target.

**Wanted:** the _Agent_ (installed harness runtime) is the primary object.

- "Agent present" = the runtime probe finds the binary (§5.1). Items nest
  under it; a target without a runtime renders "Agent not installed" instead
  of an empty item list.
- **Profile attribution is optional.** Items already carry `origin:
platform | local` (install ledger, `harness-nexus*` names, CC marketplace
  cache names). An Agent whose items are all `local` is simply in its
  **default state (缺省)** — nothing wrong, nothing to attribute. C3's
  collect+import (reuse-or-create) already _is_ "save current state as
  profile"; it is just only reachable through the diff view today. Making it a
  first-class "capture as profile" action on the Agent is a UI/route
  reframing, not new machinery.
- **Chat follows the Agent.** Per-target ACP adapter prerequisites (from
  `daemon/acp/adapters.ts`, verified):

  | target      | adapter command                           | prerequisites on the machine                                          |
  | ----------- | ----------------------------------------- | --------------------------------------------------------------------- |
  | claude-code | `npx -y @zed-industries/claude-agent-acp` | Node/npx + local Claude **auth** (the adapter bundles the CLI itself) |
  | codex       | `npx -y @zed-industries/codex-acp`        | `codex` on PATH + auth (ChatGPT login or API key)                     |
  | deepseek    | `dsh --profile acp`                       | `dsh` on PATH + a configured provider route                           |

  So "detected Agent ⇒ chatable" is sound per target, with adapter failure
  (missing auth, missing dsh) surfacing at session open exactly as it does
  today. What's missing is only the _instance registration_ for non-deployed
  agents — an auto-registered `AgentInstance (source: detected)` closes the
  emitter gap with no protocol change.

## 7. Consequences (bridge to the design)

- A **runtime arm on the existing inventory report** is the natural carrier for
  presence/version/method (C3 already round-trips per-target data on scan).
- **Install/upgrade rides the C4 job pipeline** (queued → dispatched → running →
  succeeded/failed, requeue-on-disconnect) as a new job type with a per-target
  command table; the daemon gains a `runtime` capability.
- **Provider/model config is a first-class server-side entity** referencing a
  _distributable_ credential (existing `Credential.distributable` rule), applied
  by the daemon into the native slots above — never into profile artifacts.
- **Chat keys off the detected Agent**: runtime detection auto-registers
  `AgentInstance (source: 'detected')` rows (one per machine × target), so
  emitter-installed claude-code becomes chatable with zero protocol change.
- **Config viewing** is a redacted read-back of the harness's own files/env
  (extend the daemon-side redactor that already scrubs env/header values to
  `${cred:<KEY>}`).

## 8. W3 ground truth — provider config per target (verified 2026-09-08)

### 8.1 DeepSeek Harness (verified against the installed `dsh@0.1.2-rc.1`)

- **Provider plugin** `@deepseek-ai/dsh-llm-pi-ai` (`lib/types/config.d.ts`):
  plugin config is `{ providers?: Record<route, PiAiProviderProfile> }`; the
  dict key IS the route. `PiAiProviderProfile` fields we use: `displayName`,
  `api` (wire protocol string — REQUIRED for a route the pi-ai catalog does
  not ship), `baseURL` (likewise required — no catalog default), `apiKeyEnv`
  (env var NAME, "resolved per request through ctx.credentials"),
  `models: PiAiModelProfile[]` where ONLY `id` is required (context window /
  max tokens / modalities default at route level: 262144 / 32768 / `[text]`).
- **api flavor mapping** (pi-ai `KnownApi` union): `anthropic-messages`
  verbatim; our `openai` → **`openai-completions`** (the chat-completions
  interop name; `openai-responses` also exists in the union).
- **Default model selection** `@deepseek-ai/dsh-agent-default-model` (README):
  config `{ provider: <route>, model: <id> }` — what FRESH agents start on.
  Mounting a provider route alone does NOT select it; the composition entry
  is the base, a user's saved selection layers over ours (user choice wins —
  honest, not a fight).
- **Key channel — the big one**: dsh has a NATIVE env-file credential layer.
  `dsh-credentials-local` resolves an `apiKeyEnv` name through, highest first:
  1. the inherited process environment (`KEY=… dsh`),
  2. `$DSH_HOME/.credentials.yaml` (provider-managed, writable — YAML
     `refs`/`records` shapes, not worth generating),
  3. `<invocation cwd>/.env` (project layer),
  4. **`$DSH_HOME/.env`** (user layer — our slot).
     `dsh-app-boot` parses both `.env` files on EVERY launch and materializes
     non-inherited values — user shells, daemon ACP spawns, everything; NO
     wrapper script or shell snippet needed. The parser REJECTS bootstrap-only
     names (`DSH_*` prefix, proxy/CA vars, `DEEPSEEK_BASE_URL`, `EDITOR`, …);
     `HARNESS_NEXUS_API_KEY` is clear of the blocklist.
     (The design's `~/.dsh/env` guess was wrong by one dot — it's `.env`.)
- **Correction (2026-09-09, post-ship): do NOT insert these plugins as loader
  entries.** The dsh composition (e.g. `dsh-base` + `dsh-acp-app` for the acp
  profile) ALREADY mounts `dsh-llm-pi-ai` and `dsh-agent-default-model`; a
  home-patch `- insert:` of either double-registers and crashes the plugin
  tree (`configurable provider "amazon-bedrock" is already declared` /
  `service "agentDefaultModel" has been registered`). The sanctioned channel
  for an already-mounted plugin is its SETTINGS section —
  `dsh-settings-file` keeps one document at `~/.dsh/settings.yaml`
  (namespace → user section, hot-reloaded, 0600, loud on invalid):
  - `llm-pi-ai:` → the plugin `Config` (`providers:` dict) — dormant until a
    section appears, routes activate live;
  - `agent-default-model:` → `{provider, model, reasoningEffort?}`;
  - a duplicate top-level namespace key is a boot error — a hand-managed
    section must be refused, not merged.
- Also learned: an EMPTY `cordis.patch.yml` is itself a boot error ("must be
  a top-level YAML array") — normalize stripped docs to `[]`.
- **Node floor: the dsh plugin tree needs Node ≥22.15** (zlib zstd
  `createZstdDecompress` in `dsh-session-persistence-jsonl`;
  `Promise.withResolvers` in `dsh-agent-loop`). Node 20 runs `dsh --version`
  but EVERY profile load (`--profile acp` included, i.e. chat) fails. The
  harness jobs now attach a result `warning` on deepseek targets when the
  daemon runs an older Node.
- **More follow-up facts (2026-09-09, chat verification round):**
  - The `dsh-acp-app` bundle's composition PINS the ACP plugin's model:
    `- id: acp … config: {provider: deepseek-official, model:
deepseek-v4-flash}` — a plugin's explicit config beats the settings-layer
    default for its sessions, so the settings `agent-default-model` section
    alone does NOT reroute chat. The patch layer's id-targeted CONFIG
    OVERRIDE (`- id: acp / config: {provider: harness-nexus, model}`) does —
    verified end to end (fresh acp sessions select our route).
  - A `session/new` fired the instant `initialize` resolves races the agent's
    model-adapter registration: dsh replies `-32603 Internal error` with
    `data.details: "no adapter registered for provider …"` (the bare message
    hides the cause — our JSON-RPC client now surfaces `data.details`, and
    the daemon retries that specific failure with backoff).
  - Adapters answer turn failures (bad API key → dsh replies an Internal
    error turn; claude-code replies `-32000 Authentication required`) as
    JSON-RPC errors WHILE STAYING ALIVE — a client must treat a rejected
    prompt as a turn error, not a dead channel. (dsh 0.1.2-rc.1's acp app
    DOES exit after a failed turn — its own bug; the error surfaces first.)

### 8.2 Codex (verified against codex-rs source, main @ 2026-09-08)

- **`wire_api = "chat"` is REMOVED** (`model-provider-info/src/lib.rs`):
  `WireApi` has exactly one variant — `Responses`; deserializing `"chat"`
  fails with a pointer to openai/codex discussion #7782. Consequence: no
  `wire_api` in our emitted block, and a target gateway must speak the
  Responses API (`/v1/responses`). The old "default wire_api=chat for
  gateways" interop advice is dead.
- **Key channel**: `ModelProviderInfo.env_key` reads the key from the process
  environment (no file fallback — codex has no `~/.codex/.env` layer).
  The file channel is `requires_openai_auth = true` (default false): "login
  preference and token/key are stored in auth.json" — with
  `auth.json = {"auth_mode":"apikey","OPENAI_API_KEY":…}` the auth manager
  builds an ApiKey bearer (`login/src/auth/manager.rs: from_auth_dot_json`)
  sent to the provider's `base_url` (explicit `base_url` overrides the
  OpenAI default; `create_openai_provider` — the built-in — uses exactly
  this pairing with `env_key: None`). Caveat: auth.json auth is GLOBAL for
  the codex install — pushing an apikey config switches the machine's codex
  off any ChatGPT login. That IS "point this harness at our gateway".
- TOML surgery constraint: root keys (`model`, `model_provider`) may only be
  edited in the region BEFORE the first `[section]` header — appended at file
  end they'd land inside the last table. Hence `mergeTomlRootKeys` operates
  on that region only; the `[model_providers.harness_nexus]` section is
  order-independent and rides the existing `mergeTomlSection`.
- Provider id `harness_nexus` (underscore — bare TOML key, no quoting).

### 8.3 Claude Code

- npm dist-tags (registry, 2026-09-08): `stable` 2.1.236 · `latest` 2.1.263 ·
  `next` 2.1.263 — `stable` exists and tracks ~a week behind. Version-less
  managed installs use `@stable`.
- The provider write is exactly the documented settings surface:
  `env.ANTHROPIC_BASE_URL` + `env.ANTHROPIC_AUTH_TOKEN` (bearer to custom
  endpoints) + top-level `model` — base URL alone doesn't switch the model.

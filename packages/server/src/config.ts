/** Runtime configuration, resolved from environment with sane defaults. */

export interface ServerConfig {
  port: number;
  host: string;
  /** Storage driver to activate. Defaults to sqlite. */
  storageDriver: 'sqlite' | 'memory';
  /** SQLite database file path. Ignored unless storageDriver === 'sqlite'. */
  sqlitePath: string;
  /** Directory for resource/profile artifacts pulled at install time. */
  dataDir: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Secret used to sign JWT access tokens. Required. */
  jwtSecret: string;
  /** JWT issuer claim (`iss`). */
  jwtIssuer: string;
  /** JWT access-token lifetime, as a jose-compatible string/number. */
  jwtAccessTtl: string;
  /** Key material for encrypting Credential secrets (AES-256-GCM). */
  credentialEncryptionKey: string;
  /**
   * Phase 3.5 — the absolute origin this server is reachable at from Agent
   * tools' perspective (e.g. the public Caddy HTTPS front door). Used to build
   * the archive URLs inside the emitted marketplace.json and the `/mcp`
   * endpoint inside plugin `.mcp.json` blocks. Claude Code enforces
   * `https://` + non-loopback on archive URLs, so production MUST set this to
   * the public HTTPS origin.
   */
  publicBaseUrl: string;
  /**
   * Phase 7.2 — comma-separated marketplace allowlist (`name=owner/repo` or
   * `name=url`). The server's only outbound-fetch surface. See
   * `infra/source-fetchers/allowlist.ts`.
   */
  marketplaceAllowlist: string;
  /** Phase 7.2 — marketplace catalog cache TTL, in milliseconds. */
  marketplaceFetchTtlMs: number;
  /** Phase 7.2 — per-fetch timeout, in milliseconds. */
  marketplaceFetchTimeoutMs: number;
  /**
   * Phase 7.2 — if set, the marketplace fetcher reads this local file instead
   * of making HTTP requests (test/fixture mode; production leaves it unset).
   */
  marketplaceFixturePath?: string;
  /**
   * Phase 7.4 — optional GitHub PAT for `GitHubSource` (5000 req/hr
   * authenticated vs 60/hr anonymous). Unset ⇒ anonymous.
   */
  skillGithubToken?: string;
  /**
   * Phase 7.4 — comma-separated `owner/repo` taps for `GitHubSource`. Defaults
   * to the 4 `TRUSTED_REPOS`.
   */
  skillGithubTaps: string;
  /** Phase 7.4 — overall multi-source search timeout in ms. */
  skillSearchTimeoutMs: number;
  /**
   * Phase 7.4 — comma-separated source ids to disable (test mode: e.g.
   * `github,well-known,url` to search marketplace-only against a fixture).
   */
  skillDisabledSources?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new ConfigError(
      'JWT_SECRET is required and must be at least 16 characters. ' +
        'Generate one with, e.g.: openssl rand -base64 48',
    );
  }

  return {
    port: Number(env.PORT ?? '8080'),
    host: env.HOST ?? '0.0.0.0',
    storageDriver: (env.STORAGE_DRIVER as ServerConfig['storageDriver']) ?? 'sqlite',
    sqlitePath: env.SQLITE_PATH ?? './data/harnessnexus.sqlite',
    dataDir: env.DATA_DIR ?? './data',
    logLevel: (env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER ?? 'harnessnexus',
    jwtAccessTtl: env.JWT_ACCESS_TTL ?? '7d',
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY ?? jwtSecret,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    marketplaceAllowlist:
      env.MARKETPLACE_ALLOWLIST ?? 'claude-plugins-official=anthropics/claude-plugins-official',
    marketplaceFetchTtlMs: Number(env.MARKETPLACE_FETCH_TTL_MS ?? '3600000'),
    marketplaceFetchTimeoutMs: Number(env.MARKETPLACE_FETCH_TIMEOUT_MS ?? '10000'),
    ...(env.MARKETPLACE_FIXTURE_PATH
      ? { marketplaceFixturePath: env.MARKETPLACE_FIXTURE_PATH }
      : {}),
    ...(env.GITHUB_TOKEN ? { skillGithubToken: env.GITHUB_TOKEN } : {}),
    skillGithubTaps:
      env.SKILL_GITHUB_TAPS ?? 'openai/skills,anthropics/skills,huggingface/skills,NVIDIA/skills',
    skillSearchTimeoutMs: Number(env.SKILL_SEARCH_TIMEOUT_MS ?? '30000'),
    ...(env.SKILL_DISABLED_SOURCES ? { skillDisabledSources: env.SKILL_DISABLED_SOURCES } : {}),
  };
}

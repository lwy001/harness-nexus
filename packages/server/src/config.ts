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
    port: Number(env.PORT ?? '7477'),
    host: env.HOST ?? '0.0.0.0',
    storageDriver: (env.STORAGE_DRIVER as ServerConfig['storageDriver']) ?? 'sqlite',
    sqlitePath: env.SQLITE_PATH ?? './data/agentnexus.sqlite',
    dataDir: env.DATA_DIR ?? './data',
    logLevel: (env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER ?? 'agentnexus',
    jwtAccessTtl: env.JWT_ACCESS_TTL ?? '7d',
  };
}

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
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT ?? '7477'),
    host: env.HOST ?? '0.0.0.0',
    storageDriver: (env.STORAGE_DRIVER as ServerConfig['storageDriver']) ?? 'sqlite',
    sqlitePath: env.SQLITE_PATH ?? './data/agentnexus.sqlite',
    dataDir: env.DATA_DIR ?? './data',
    logLevel: (env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
  };
}

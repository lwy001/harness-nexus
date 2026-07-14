/**
 * SQLite schema migrations (placeholder).
 *
 * Keep migrations append-only and idempotent. Each entry: a version number and
 * the SQL to run. The runner (TODO) will track applied versions in a
 * `schema_version` table.
 */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'initial schema (users, resources, profiles, tokens, mcp_servers)',
    sql: '-- TODO: CREATE TABLE ...',
  },
] as const;

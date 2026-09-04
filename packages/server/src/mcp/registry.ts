/**
 * McpRegistry — the server-side aggregation layer (Phase 2.2, reshaped in
 * Phase 8 C2).
 *
 * Owns which upstreams the platform itself dials: exactly the `McpServer` rows
 * whose dial site RESOLVES to `server` (see `shared/dial-site.ts` — non-
 * distributable credentials, or an explicit admin override). Those are pooled
 * and re-exposed through the `/mcp` outlet. Everything else is dialed on the
 * user's machine by the `hnx mcp serve` shim, which fetches its resolved
 * config from `modules/client-config.ts`.
 *
 * Transport-facing work (dialing, namespacing, tool routing) lives in
 * `@harness-nexus/mcp-runtime` and is shared with the shim; this class keeps
 * the server concerns — config loading from the UnitOfWork, `${cred:NAME}`
 * resolution against the encrypted store, dial-site derivation, profile
 * visibility — and the Phase 2.4 operator surface.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { McpServer, McpTransport, Profile, UnitOfWork } from '@harness-nexus/core';
import { resolveDialSite, resolvePlaceholders, type McpToolInfo } from '@harness-nexus/shared';
import {
  UpstreamPool,
  RegistryError,
  type AggregatedTool,
  type McpServerStatus,
  type ResolvedTransport,
  type UpstreamDefinition,
} from '@harness-nexus/mcp-runtime';
import { decryptSecret } from '../infra/crypto.js';

export { NAMESPACE_SEP } from '@harness-nexus/mcp-runtime';
export { RegistryError };
export type {
  AggregatedTool,
  ConnectionStatus,
  McpServerStatus,
  RegistryErrorKind,
} from '@harness-nexus/mcp-runtime';

export interface McpRegistryOptions {
  uow: UnitOfWork;
  /** Key material for decrypting credential secrets (see crypto.ts). */
  encryptionKey: string;
  logger: FastifyBaseLogger;
}

export class McpRegistry {
  private readonly uow: UnitOfWork;
  private readonly encryptionKey: string;
  private readonly pool: UpstreamPool;

  constructor(opts: McpRegistryOptions) {
    this.uow = opts.uow;
    this.encryptionKey = opts.encryptionKey;
    this.pool = new UpstreamPool({ logger: opts.logger, clientName: 'harness-nexus-server' });
  }

  /**
   * Re-read the configured servers, derive each one's dial site, and
   * reconcile the pool against exactly the server-dialed set. Safe to call
   * repeatedly; concurrent calls share the same in-flight promise (upstream
   * pool guard). Called at boot (`mountMcpProxy`) and fire-and-forget by the
   * mcp-servers routes after any mutation.
   */
  reload(): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise;
    this.reloadPromise = this.doReload().finally(() => {
      this.reloadPromise = null;
    });
    return this.reloadPromise;
  }

  private reloadPromise: Promise<void> | null = null;

  private async doReload(): Promise<void> {
    const defs = await this.serverDialedDefinitions();
    await this.pool.sync(defs);
  }

  /** The McpServers this platform itself dials (the `/mcp` outlet's set). */
  private async serverDialedDefinitions(): Promise<UpstreamDefinition[]> {
    const servers = await this.uow.mcpServers.list();
    const distributable = await this.distributabilityIndex();
    const defs: UpstreamDefinition[] = [];
    for (const server of servers) {
      if (resolveDialSite(server, (name) => distributable.get(name) === true) !== 'server') {
        continue;
      }
      defs.push({
        id: server.id,
        name: server.name,
        transport: await this.resolveTransport(server.transport),
      });
    }
    return defs;
  }

  /**
   * name → distributable for every stored credential. Names are not unique
   * across scopes; first occurrence wins, mirroring `findByName` semantics.
   */
  private async distributabilityIndex(): Promise<Map<string, boolean>> {
    const index = new Map<string, boolean>();
    for (const cred of await this.uow.credentials.list()) {
      if (!index.has(cred.name)) index.set(cred.name, cred.distributable);
    }
    return index;
  }

  /** Substitute every `${cred:NAME}` in a transport config (server-side dial). */
  private async resolveTransport(t: McpTransport): Promise<ResolvedTransport> {
    if (t.type === 'stdio') {
      // Defensive: the route layer rejects stdio server-dial (409); auto never
      // derives it for a reachable config. A stdio row that somehow resolves
      // here is skipped rather than crashing the pool.
      throw new Error(`stdio upstream "${t.command}" cannot be server-dialed`);
    }
    const url = await this.resolve(t.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.headers ?? {})) {
      headers[k] = await this.resolve(v);
    }
    return { type: t.type, url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }

  /** Resolve placeholders in a string by looking the credential up by name. */
  private async resolve(input: string): Promise<string> {
    return resolvePlaceholders(input, async (name) => {
      const cred = await this.uow.credentials.findByName(name);
      if (!cred) {
        throw new Error(`credential "${name}" not found (referenced by placeholder)`);
      }
      return decryptSecret(cred.secret, this.encryptionKey);
    });
  }

  /**
   * Resolve a profile into the set of outlet server ids it exposes, after an
   * accessibility check. Throws if the profile references an MCP server the
   * caller cannot see. Returns `{ serverIds }` for use as a `listTools` filter.
   */
  async profileEntriesFor(
    profileId: string,
    userId: string,
    role: 'admin' | 'user',
  ): Promise<{ serverIds: string[] }> {
    const profile = await this.uow.profiles.findById(profileId);
    if (!profile || !profileVisibleBy(profile, userId, role)) {
      throw new Error(`profile ${profileId} not accessible`);
    }
    const serverIds: string[] = [];
    for (const entry of profile.entries) {
      if (entry.kind !== 'mcp') continue;
      const server = await this.uow.mcpServers.findById(entry.resourceId);
      if (!server || !serverVisibleBy(server, userId, role)) {
        throw new Error(`profile entry ${entry.resourceId} not accessible`);
      }
      serverIds.push(server.id);
    }
    return { serverIds };
  }

  /** Aggregated (namespaced) tools of the pooled server-dialed set. */
  listTools(filterServerIds?: string[]): AggregatedTool[] {
    return this.pool.listTools(filterServerIds);
  }

  /** Call a namespaced tool on a pooled upstream. */
  callTool(namespacedName: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.pool.callTool(namespacedName, args);
  }

  /** Snapshot of every server-dialed upstream's connection status. */
  getStatuses(): McpServerStatus[] {
    return this.pool.statuses();
  }

  // ---- per-server operator control (Phase 2.4) ----
  // Explicit connect/disconnect + tool inspection over the pool. They add an
  // operator surface on top of startup pooling; they do NOT change `/mcp`
  // aggregation. Server-dialed rows only — client-dialed rows are never
  // dialed by the platform (that is the shim's job).

  /**
   * Force (re)connect of one server-dialed upstream — the main use is
   * re-dialing a server stuck at `error` after a config/credential fix, since
   * `reload()` is fire-and-forget. Reads the LATEST config so edits since
   * startup are honored. Best-effort: resolves with the resulting status
   * (possibly `error` + `detail`) rather than throwing on upstream failure;
   * only config-level problems (deleted / not server-dialed) throw.
   */
  async connectServer(id: string): Promise<McpServerStatus> {
    const def = await this.definitionForId(id);
    return this.pool.connect(def);
  }

  /**
   * Drop a live connection on demand WITHOUT removing the pool entry — the
   * entry stays `disconnected` so it remains visible in `getStatuses()` and is
   * NOT silently reconnected by the next unrelated `refresh()`.
   */
  async disconnectServer(id: string): Promise<McpServerStatus> {
    return this.pool.disconnect(id);
  }

  /** One server's cached tools in their ORIGINAL (un-namespaced) form. */
  listServerTools(id: string): McpToolInfo[] {
    return this.pool.listUpstreamTools(id);
  }

  /** Re-fetch one server's tool list and return it (Refresh button). */
  async refreshServerTools(id: string): Promise<McpToolInfo[]> {
    return this.pool.refreshUpstreamTools(id);
  }

  /** Load a server's latest config and require it to be server-dialed. */
  private async definitionForId(id: string): Promise<UpstreamDefinition> {
    const server = await this.uow.mcpServers.findById(id);
    if (!server) {
      throw new RegistryError(`MCP server not pooled: ${id}`, 'not_found');
    }
    const distributable = await this.distributabilityIndex();
    const site = resolveDialSite(server, (name) => distributable.get(name) === true);
    if (site !== 'server') {
      throw new RegistryError(
        `MCP server "${server.name}" is dialed by the client, not the platform (dial site: ${site})`,
        'not_dialable',
      );
    }
    return {
      id: server.id,
      name: server.name,
      transport: await this.resolveTransport(server.transport),
    };
  }

  /** Close every pooled connection. Call on app shutdown. */
  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}

/** A profile is visible to a user iff global, or personal + owned by them. */
function profileVisibleBy(profile: Profile, userId: string, role: 'admin' | 'user'): boolean {
  return profile.scope === 'global' || profile.ownerId === userId || role === 'admin';
}

/** An MCP server is visible to a user iff global, or personal + owned by them. */
function serverVisibleBy(server: McpServer, userId: string, role: 'admin' | 'user'): boolean {
  return server.scope === 'global' || server.ownerId === userId || role === 'admin';
}

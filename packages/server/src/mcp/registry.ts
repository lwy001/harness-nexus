/**
 * McpRegistry — the live aggregation layer (Phase 2.2).
 *
 * Owns a pool of MCP `Client` connections to every proxy-mode upstream
 * `McpServer`, resolves `${cred:NAME}` placeholders in their transport into real
 * values at connect time, and aggregates their tools under a namespaced key so
 * callers (the proxy) see one unified tool set.
 *
 * Design notes (see docs/design/phase-2.2-registry.md):
 *   - Lazy + pooled: connections are opened on first use / reload and kept.
 *   - Best-effort: an unreachable upstream is marked `error` and skipped; it
 *     never blocks startup or tool listing for the others.
 *   - Namespacing: tools are exposed as `<server-name>__<tool-name>` to avoid
 *     collisions across upstreams. `callTool` splits the namespace and routes.
 *   - Decoupled from transport: the proxy asks for aggregated tools/forwarding;
 *     this module knows nothing about HTTP/SSE.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { FastifyBaseLogger } from 'fastify';
import type { McpServer, McpTransport, Profile, UnitOfWork } from '@harness-nexus/core';
import { resolvePlaceholders, type McpToolInfo } from '@harness-nexus/shared';
import { decryptSecret } from '../infra/crypto.js';

/** Separator between server-name and tool-name in the aggregated namespace. */
export const NAMESPACE_SEP = '__';

export type ConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export interface McpServerStatus {
  id: string;
  name: string;
  status: ConnectionStatus;
  /** Human-readable detail for the `error` state; empty otherwise. */
  detail?: string;
  /** Cached tool count for this connection (0 when not connected). Phase 2.4. */
  toolCount: number;
}

/** Minimal tool shape we surface to the proxy (a subset of the SDK's Tool). */
export interface AggregatedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Registry-local error kinds, mapped to HTTP by the route layer. Kept free of
 * `AppError`/HTTP concerns so the registry stays decoupled from transport
 * (AGENTS.md architecture rule #4). Phase 2.4.
 */
export type RegistryErrorKind = 'not_found' | 'not_proxy' | 'not_connected';

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly kind: RegistryErrorKind,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

interface LiveConnection {
  server: McpServer;
  client: Client;
  status: ConnectionStatus;
  detail?: string;
  /** Raw tools from the upstream, keyed by their original name. */
  tools: Map<string, AggregatedTool>;
}

export interface McpRegistryOptions {
  uow: UnitOfWork;
  /** Key material for decrypting credential secrets (see crypto.ts). */
  encryptionKey: string;
  logger: FastifyBaseLogger;
}

export class McpRegistry {
  private readonly uow: UnitOfWork;
  private readonly encryptionKey: string;
  private readonly log: FastifyBaseLogger;
  private readonly pool = new Map<string, LiveConnection>();
  /** Guards against concurrent reload() runs. */
  private reloadPromise: Promise<void> | null = null;

  constructor(opts: McpRegistryOptions) {
    this.uow = opts.uow;
    this.encryptionKey = opts.encryptionKey;
    this.log = opts.logger;
  }

  /**
   * Re-read the configured proxy-mode servers and reconcile the connection pool:
   * connect new servers, disconnect removed ones, refresh changed ones. Safe to
   * call repeatedly; concurrent calls share the same in-flight promise.
   */
  reload(): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise;
    this.reloadPromise = this.doReload().finally(() => {
      this.reloadPromise = null;
    });
    return this.reloadPromise;
  }

  private async doReload(): Promise<void> {
    // Only proxy-mode servers are pooled — direct-mode servers are dialed by
    // the target tool at install time, never by Harness Nexus.
    const configured = await this.uow.mcpServers.list({ mode: 'proxy' });
    const configuredById = new Map(configured.map((s) => [s.id, s]));

    // Disconnect + drop servers that are no longer configured/proxy.
    for (const [id, conn] of this.pool) {
      if (!configuredById.has(id)) {
        await this.closeConnection(conn);
        this.pool.delete(id);
      }
    }

    // Connect new servers; refresh changed ones by reconnecting. `configured`
    // already contains only proxy-mode rows (see the list() filter above);
    // direct-mode servers are dialed by the target tool at install time.
    for (const server of configured) {
      const existing = this.pool.get(server.id);
      if (existing) {
        // Reconnect if the config changed (cheap structural compare).
        if (!sameServer(existing.server, server)) {
          await this.closeConnection(existing);
          this.pool.delete(server.id);
          void this.connectOne(server);
        }
      } else {
        void this.connectOne(server);
      }
    }
  }

  /** Establish a single upstream connection (best-effort, non-throwing). */
  private async connectOne(server: McpServer): Promise<void> {
    const transport = server.transport as Extract<McpTransport, { url: string }>;
    const client = new Client({ name: 'harness-nexus', version: '0.1.0' }, { capabilities: {} });
    const conn: LiveConnection = { server, client, status: 'connecting', tools: new Map() };
    this.pool.set(server.id, conn);

    try {
      const headers = await this.resolveHeaders(transport);
      const url = await this.resolveUrl(transport.url);
      const upstreamTransport = makeClientTransport({ ...transport, url }, headers);
      await client.connect(upstreamTransport as Parameters<Client['connect']>[0]);
      conn.status = 'connected';
      await this.refreshTools(conn);
      this.log.info({ name: server.name }, 'upstream MCP connected');
    } catch (err) {
      conn.status = 'error';
      conn.detail = err instanceof Error ? err.message : String(err);
      this.log.warn({ name: server.name, err }, 'upstream MCP connection failed');
    }
  }

  /** Fetch the upstream's tool list into the connection cache. */
  private async refreshTools(conn: LiveConnection): Promise<void> {
    try {
      const { tools } = await conn.client.listTools();
      conn.tools = new Map(
        tools.map((t) => [
          t.name,
          {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            inputSchema: t.inputSchema as Record<string, unknown>,
          },
        ]),
      );
    } catch (err) {
      conn.status = 'error';
      conn.detail = err instanceof Error ? err.message : String(err);
      this.log.warn({ name: conn.server.name, err }, 'listing upstream tools failed');
    }
  }

  /**
   * Resolve the headers for an upstream connection. Each header value may carry
   * `${cred:NAME}` placeholders, which are replaced with the decrypted plaintext.
   * stdio has no headers and returns `{}`.
   */
  private async resolveHeaders(transport: McpTransport): Promise<Record<string, string>> {
    if (transport.type === 'stdio') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(transport.headers ?? {})) {
      out[k] = await this.resolvePlaceholders(v);
    }
    return out;
  }

  /** Resolve `${cred:NAME}` placeholders in the transport URL. */
  private async resolveUrl(url: string): Promise<string> {
    return this.resolvePlaceholders(url);
  }

  /** Resolve placeholders in a string by looking up the credential by name. */
  private async resolvePlaceholders(input: string): Promise<string> {
    return resolvePlaceholders(input, async (name) => {
      const cred = await this.uow.credentials.findByName(name);
      if (!cred) {
        throw new Error(`credential "${name}" not found (referenced by placeholder)`);
      }
      return decryptSecret(cred.secret, this.encryptionKey);
    });
  }

  /**
   * Resolve a profile into the set of upstream server ids it exposes, after an
   * accessibility check. Throws `AppError` (403) if the profile references an
   * MCP server the caller cannot see. Returns `{ serverIds }` for use as a
   * `listTools` filter.
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

  /**
   * List aggregated tools, optionally restricted to a subset of server ids
   * (used by the proxy to honor a profile's entries). Each tool name is
   * namespaced as `<server-name>__<tool-name>`.
   */
  listTools(filterServerIds?: string[]): AggregatedTool[] {
    const allow = filterServerIds ? new Set(filterServerIds) : null;
    const out: AggregatedTool[] = [];
    for (const conn of this.pool.values()) {
      if (conn.status !== 'connected') continue;
      if (allow && !allow.has(conn.server.id)) continue;
      const prefix = sanitizeNamespace(conn.server.name) + NAMESPACE_SEP;
      for (const tool of conn.tools.values()) {
        out.push({
          name: prefix + tool.name,
          ...(tool.description
            ? {
                description: `[${conn.server.name}] ${tool.description}`,
              }
            : {}),
          inputSchema: tool.inputSchema,
        });
      }
    }
    return out;
  }

  /**
   * Call a namespaced tool. Returns the upstream's raw call result, or throws
   * if the namespace is malformed / the server or tool is unknown.
   */
  async callTool(namespacedName: string, args?: Record<string, unknown>): Promise<unknown> {
    const [serverName, toolName] = splitNamespace(namespacedName);
    if (!toolName) {
      throw new Error(`invalid tool name: ${namespacedName} (expected server${NAMESPACE_SEP}tool)`);
    }
    const conn = this.findByServerName(serverName);
    if (!conn || conn.status !== 'connected') {
      throw new Error(`upstream not connected: ${serverName}`);
    }
    if (!conn.tools.has(toolName)) {
      throw new Error(`tool not found: ${toolName} on ${serverName}`);
    }
    return conn.client.callTool({ name: toolName, arguments: args });
  }

  /** Snapshot of every proxy-mode upstream's connection status (for the UI/API). */
  getStatuses(): McpServerStatus[] {
    return [...this.pool.values()].map((c) => ({
      id: c.server.id,
      name: c.server.name,
      status: c.status,
      toolCount: c.tools.size,
      ...(c.detail ? { detail: c.detail } : {}),
    }));
  }

  // ---- per-server operator control (Phase 2.4) ----
  // These add an explicit connect/disconnect + tool-inspection surface on top
  // of the existing pool. They do NOT replace startup auto-pooling (doReload)
  // and do NOT change /mcp aggregation. See docs/design/phase-2.4-connect-tools.md.

  /**
   * Force (re)connect of one proxy upstream. The primary use case is re-dialing
   * a server stuck at `error` after the operator fixed its config/credential —
   * since startup `reload()` is fire-and-forget, there is otherwise no way to
   * trigger a single reconnect. Reads the LATEST config from the store so an
   * edit since startup is honored, and so a deleted/direct-switched server
   * throws the right config-level error. Best-effort: resolves with the
   * resulting status (possibly `error` + `detail`) rather than throwing on
   * upstream failure. Phase 2.4.
   */
  async connectServer(id: string): Promise<McpServerStatus> {
    // Re-fetch config: connectOne takes a McpServer object, and the pool may
    // hold a stale snapshot. A missing record → not_found; non-proxy → not_proxy.
    const server = await this.uow.mcpServers.findById(id);
    if (!server) {
      throw new RegistryError(`MCP server not pooled: ${id}`, 'not_found');
    }
    if (server.mode !== 'proxy') {
      throw new RegistryError(
        `MCP server "${server.name}" is not in proxy mode (Harness Nexus does not dial it)`,
        'not_proxy',
      );
    }
    // Close any existing pool entry first to avoid leaking a Client. connectOne
    // will re-insert a fresh entry.
    const existing = this.pool.get(id);
    if (existing) {
      await this.closeConnection(existing);
      this.pool.delete(id);
    }
    await this.connectOne(server);
    return this.statusOf(id);
  }

  /**
   * Drop a live connection on demand WITHOUT removing it from the pool — the
   * entry stays with `status: 'disconnected'` so it remains visible in
   * `getStatuses()` and is NOT silently reconnected by the next unrelated
   * `reload()` (doReload only reconnects entries it doesn't see vs. configured).
   * Phase 2.4.
   */
  async disconnectServer(id: string): Promise<McpServerStatus> {
    const conn = this.pool.get(id);
    if (!conn) {
      throw new RegistryError(`MCP server not pooled: ${id}`, 'not_found');
    }
    await this.closeConnection(conn);
    return this.statusOf(id);
  }

  /**
   * Read-only snapshot of one server's cached tools in their ORIGINAL
   * (un-namespaced) form — the UI shows a single server, where the `<server>__`
   * prefix is noise. Distinct from `listTools()`, which returns the namespaced
   * aggregated form for the proxy. Not connected → `[]` (NOT an error; the UI
   * gates the panel on status==='connected'). Phase 2.4.
   */
  listServerTools(id: string): McpToolInfo[] {
    const conn = this.pool.get(id);
    if (!conn) {
      throw new RegistryError(`MCP server not pooled: ${id}`, 'not_found');
    }
    if (conn.status !== 'connected') return [];
    return [...conn.tools.values()].map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * Re-fetch the upstream's tool list into the cache and return it. Powers the
   * Refresh button in the UI. Requires an active connection (`not_connected`
   * otherwise — refresh makes no sense on a down server). Best-effort upstream
   * fetch: if listTools fails, `refreshTools` flips the connection to `error`
   * and this returns `[]`. Phase 2.4.
   */
  async refreshServerTools(id: string): Promise<McpToolInfo[]> {
    const conn = this.pool.get(id);
    if (!conn) {
      throw new RegistryError(`MCP server not pooled: ${id}`, 'not_found');
    }
    if (conn.status !== 'connected') {
      throw new RegistryError(`MCP server not connected: ${id}`, 'not_connected');
    }
    await this.refreshTools(conn);
    return this.listServerTools(id);
  }

  /** Build one status entry for a pooled server by id (assumes present). */
  private statusOf(id: string): McpServerStatus {
    const conn = this.pool.get(id)!;
    return {
      id: conn.server.id,
      name: conn.server.name,
      status: conn.status,
      toolCount: conn.tools.size,
      ...(conn.detail ? { detail: conn.detail } : {}),
    };
  }

  private findByServerName(name: string): LiveConnection | undefined {
    const target = sanitizeNamespace(name);
    for (const conn of this.pool.values()) {
      if (sanitizeNamespace(conn.server.name) === target) return conn;
    }
    return undefined;
  }

  private async closeConnection(conn: LiveConnection): Promise<void> {
    conn.status = 'disconnected';
    try {
      await conn.client.close();
    } catch (err) {
      this.log.debug({ err, name: conn.server.name }, 'error closing upstream');
    }
  }

  /** Close every connection. Call on app shutdown. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.pool.values()].map((c) => this.closeConnection(c)));
    this.pool.clear();
  }
}

// ---- helpers ----

/** The URL-bearing transport variants (stdio is excluded — unsupported). */
type HttpTransport = Extract<McpTransport, { url: string }>;

/** Build the right SDK client transport for an upstream's transport type. */
function makeClientTransport(
  transport: HttpTransport,
  headers: Record<string, string>,
): StreamableHTTPClientTransport | SSEClientTransport {
  const url = new URL(transport.url);
  const init = { requestInit: { headers } } as const;
  if (transport.type === 'streamable-http') {
    return new StreamableHTTPClientTransport(url, init);
  }
  return new SSEClientTransport(url, init);
}

/** Collapse a server name to a stable namespace segment (no spaces/separators). */
function sanitizeNamespace(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Inverse of namespacing: split `<server>__<tool>` on the FIRST separator. */
function splitNamespace(namespaced: string): [string, string] {
  const idx = namespaced.indexOf(NAMESPACE_SEP);
  if (idx === -1) return [namespaced, ''];
  return [namespaced.slice(0, idx), namespaced.slice(idx + NAMESPACE_SEP.length)];
}

/** Structural equality check for an McpServer (decides reconnect on reload). */
function sameServer(a: McpServer, b: McpServer): boolean {
  return (
    a.name === b.name &&
    a.mode === b.mode &&
    a.scope === b.scope &&
    JSON.stringify(a.transport) === JSON.stringify(b.transport)
  );
}

/** A profile is visible to a user iff global, or personal + owned by them. */
function profileVisibleBy(profile: Profile, userId: string, role: 'admin' | 'user'): boolean {
  return profile.scope === 'global' || profile.ownerId === userId || role === 'admin';
}

/** An MCP server is visible to a user iff global, or personal + owned by them. */
function serverVisibleBy(server: McpServer, userId: string, role: 'admin' | 'user'): boolean {
  return server.scope === 'global' || server.ownerId === userId || role === 'admin';
}

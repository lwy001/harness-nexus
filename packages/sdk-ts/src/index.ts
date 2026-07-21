/**
 * @agent-nexus/sdk — thin HTTP client for the AgentNexus REST API.
 *
 * Used by the web SPA, the install CLI (when it talks to a running server),
 * and external scripts. Auth is via a JWT (from login/register) or a PAT
 * (`anpat_…`), sent as `Authorization: Bearer <token>`.
 */
import type {
  Role,
  User,
  McpServer,
  McpMode,
  McpTransport,
  Profile,
  Resource,
  ResourceKind,
  AgentTarget,
  ResourceSource,
  TrustTier,
  SkillMeta,
  SkillBundle,
} from '@agent-nexus/core';
import type {
  MarketplaceCatalog,
  MarketplacePlugin,
  MarketplaceSource,
  PluginResourceSource,
} from '@agent-nexus/shared';
export {
  HOOK_EVENTS,
  HOOK_SUPPORT,
  resolveTrustTier,
  marketplacePluginToResourceSource,
  type HookEvent,
} from '@agent-nexus/shared';
export type { MarketplaceCatalog, MarketplacePlugin, MarketplaceSource, PluginResourceSource };

export interface SdkOptions {
  baseUrl: string;
  /** Raw JWT or PAT, sent as `Authorization: Bearer <token>`. */
  token?: string;
  fetch?: typeof fetch;
}

export interface PublicUser extends Omit<User, 'passwordHash'> {}
export interface PatView {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
export interface CredentialView {
  id: string;
  name: string;
  secretPreview: string;
  scope: 'global' | 'personal';
  ownerId: string | null;
  createdAt: string;
  updatedAt: string;
}
// McpServer is re-exported directly from core (it carries no secret fields).
// McpTransport likewise, so callers can build typed transport objects.
// Profile is re-exported from core too (its entries reference McpServer ids).

/** Live connection state of a proxy-mode upstream MCP server. */
export interface McpServerStatus {
  id: string;
  name: string;
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  detail?: string;
}

/** Input shape for a profile entry (references an McpServer by id). */
export interface ProfileEntryInput {
  mcpServerId: string;
  pinnedVersion?: string;
}

interface ApiErrorBody {
  error: string;
  message: string;
  statusCode?: number;
  details?: unknown;
}

export class AgentNexusError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AgentNexusError';
  }
}

export class AgentNexusClient {
  private token: string | undefined;
  private readonly opts: SdkOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SdkOptions) {
    this.opts = opts;
    this.token = opts.token;
    // Bind fetch: in the browser `fetch` is a method on `window` and relies on
    // `this === window`. Taking it as a bare reference and calling it later
    // throws "does not implement interface Window". Bind it to globalThis so it
    // can be invoked as a free function. (Node 18+ also exposes fetch on
    // globalThis.)
    const bound = globalThis.fetch?.bind(globalThis);
    this.fetchImpl = opts.fetch ?? bound ?? fetch;
  }

  /** Update the token after login/register. */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  // ---- auth ----
  async login(username: string, password: string): Promise<{ token: string; user: PublicUser }> {
    const res = await this.request('POST', '/api/auth/login', { username, password }, true);
    this.token = res.token;
    return res;
  }

  async register(
    username: string,
    password: string,
    email?: string,
  ): Promise<{ token: string; user: PublicUser }> {
    const res = await this.request(
      'POST',
      '/api/auth/register',
      { username, password, email },
      true,
    );
    this.token = res.token;
    return res;
  }

  async getMe(): Promise<PublicUser> {
    const res = await this.request('GET', '/api/auth/me');
    return res.user;
  }

  // ---- users (admin) ----
  async listUsers(): Promise<PublicUser[]> {
    const res = await this.request('GET', '/api/users');
    return res.users;
  }

  async createUser(input: {
    username: string;
    password: string;
    email?: string;
    role?: Role;
  }): Promise<PublicUser> {
    const res = await this.request('POST', '/api/users', input);
    return res.user;
  }

  async deleteUser(id: string): Promise<void> {
    await this.request('DELETE', `/api/users/${id}`);
  }

  async updateUserRole(id: string, role: Role): Promise<PublicUser> {
    const res = await this.request('PATCH', `/api/users/${id}/role`, { role });
    return res.user;
  }

  // ---- PATs ----
  async createPat(input: {
    name: string;
    scopes?: string[];
    expiresAt?: string;
  }): Promise<{ pat: PatView; token: string }> {
    return this.request('POST', '/api/pats', input);
  }

  async listPats(): Promise<PatView[]> {
    const res = await this.request('GET', '/api/pats');
    return res.pats;
  }

  async revokePat(id: string): Promise<void> {
    await this.request('DELETE', `/api/pats/${id}`);
  }

  // ---- settings ----
  async getRegistration(): Promise<{ allowRegistration: boolean }> {
    return this.request('GET', '/api/settings/registration', undefined, true);
  }

  async setRegistration(allowRegistration: boolean): Promise<{ allowRegistration: boolean }> {
    return this.request('PUT', '/api/settings/registration', { allowRegistration });
  }

  // ---- credentials ----
  async createCredential(input: {
    name: string;
    secret: string;
    scope: 'global' | 'personal';
  }): Promise<{ credential: CredentialView }> {
    return this.request('POST', '/api/credentials', input);
  }

  async listCredentials(): Promise<CredentialView[]> {
    const res = await this.request('GET', '/api/credentials');
    return res.credentials;
  }

  async updateCredential(
    id: string,
    input: { name?: string; secret?: string },
  ): Promise<{ credential: CredentialView }> {
    return this.request('PATCH', `/api/credentials/${id}`, input);
  }

  async deleteCredential(id: string): Promise<void> {
    await this.request('DELETE', `/api/credentials/${id}`);
  }

  // ---- mcp servers ----
  async createMcpServer(input: {
    name: string;
    transport: McpTransport;
    mode?: McpMode;
    scope: 'global' | 'personal';
  }): Promise<{ mcpServer: McpServer }> {
    return this.request('POST', '/api/mcp-servers', input);
  }

  async listMcpServers(): Promise<McpServer[]> {
    const res = await this.request('GET', '/api/mcp-servers');
    return res.mcpServers;
  }

  async updateMcpServer(
    id: string,
    input: { name?: string; transport?: McpTransport; mode?: McpMode },
  ): Promise<{ mcpServer: McpServer }> {
    return this.request('PATCH', `/api/mcp-servers/${id}`, input);
  }

  async deleteMcpServer(id: string): Promise<void> {
    await this.request('DELETE', `/api/mcp-servers/${id}`);
  }

  // ---- mcp server status (live registry) ----
  async listMcpServerStatuses(): Promise<McpServerStatus[]> {
    const res = await this.request('GET', '/api/mcp-servers/status');
    return res.statuses;
  }

  // ---- profiles ----
  async createProfile(input: {
    name: string;
    description?: string;
    scope: 'global' | 'personal';
    entries?: ProfileEntryInput[];
  }): Promise<{ profile: Profile }> {
    return this.request('POST', '/api/profiles', input);
  }

  async listProfiles(): Promise<Profile[]> {
    const res = await this.request('GET', '/api/profiles');
    return res.profiles;
  }

  async getProfile(id: string): Promise<{ profile: Profile }> {
    return this.request('GET', `/api/profiles/${id}`);
  }

  async updateProfile(
    id: string,
    input: { name?: string; description?: string; entries?: ProfileEntryInput[] },
  ): Promise<{ profile: Profile }> {
    return this.request('PATCH', `/api/profiles/${id}`, input);
  }

  async deleteProfile(id: string): Promise<void> {
    await this.request('DELETE', `/api/profiles/${id}`);
  }

  // ---- resources ----
  async createResource(input: {
    key: string;
    kind: ResourceKind;
    name: string;
    description?: string;
    version?: string;
    source: ResourceSource;
    scope: 'global' | 'personal';
    targets?: AgentTarget[];
    labels?: Record<string, string>;
  }): Promise<{ resource: Resource }> {
    return this.request('POST', '/api/resources', input);
  }

  async listResources(filter?: {
    kind?: ResourceKind;
    scope?: 'global' | 'personal';
    target?: AgentTarget;
  }): Promise<Resource[]> {
    const qs = new URLSearchParams();
    if (filter?.kind) qs.set('kind', filter.kind);
    if (filter?.scope) qs.set('scope', filter.scope);
    if (filter?.target) qs.set('target', filter.target);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await this.request('GET', `/api/resources${suffix}`);
    return res.resources;
  }

  async getResource(id: string): Promise<{ resource: Resource }> {
    return this.request('GET', `/api/resources/${id}`);
  }

  async updateResource(
    id: string,
    input: {
      key?: string;
      name?: string;
      description?: string;
      version?: string;
      source?: ResourceSource;
      targets?: AgentTarget[];
      labels?: Record<string, string>;
    },
  ): Promise<{ resource: Resource }> {
    return this.request('PATCH', `/api/resources/${id}`, input);
  }

  async deleteResource(id: string): Promise<void> {
    await this.request('DELETE', `/api/resources/${id}`);
  }

  // ---- skills hub (Phase 7.2) ----

  /** List the configured marketplace allowlist (no fetch). */
  async listMarketplaces(): Promise<{ marketplaces: { id: string }[] }> {
    return this.request('GET', '/api/skills/marketplaces');
  }

  /**
   * List a marketplace's plugins (fetched + cached server-side). Optional
   * `category` and free-text `q` filters narrow the result.
   */
  async listMarketplacePlugins(
    id: string,
    filter?: { category?: string; q?: string },
  ): Promise<{ plugins: MarketplacePlugin[] }> {
    const params = new URLSearchParams();
    if (filter?.category) params.set('category', filter.category);
    if (filter?.q) params.set('q', filter.q);
    const qs = params.toString();
    return this.request('GET', `/api/skills/marketplaces/${id}/plugins${qs ? `?${qs}` : ''}`);
  }

  // ---- core request helper ----
  private async request(
    method: string,
    path: string,
    body?: unknown,
    isPublic = false,
  ): Promise<any> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!isPublic && this.token) headers.Authorization = `Bearer ${this.token}`;

    const url = this.opts.baseUrl.replace(/\/$/, '') + path;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(url, init);

    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const err = parsed as ApiErrorBody | undefined;
      throw new AgentNexusError(
        err?.message ?? `request failed: ${res.status}`,
        err?.error ?? 'REQUEST_FAILED',
        err?.statusCode ?? res.status,
        err?.details,
      );
    }
    return parsed;
  }
}

export type {
  Role,
  McpServer,
  McpMode,
  McpTransport,
  Profile,
  Resource,
  ResourceKind,
  ResourceSource,
  AgentTarget,
  // Phase 7.1 — skill-sourcing domain types (back the SkillSource port).
  TrustTier,
  SkillMeta,
  SkillBundle,
};

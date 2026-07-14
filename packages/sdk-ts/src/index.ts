/**
 * @agent-nexus/sdk — thin HTTP client for the AgentNexus REST API.
 *
 * Used by the web SPA, the install CLI (when it talks to a running server),
 * and external scripts. Auth is via a JWT (from login/register) or a PAT
 * (`anpat_…`), sent as `Authorization: Bearer <token>`.
 */
import type { Role, User } from '@agent-nexus/core';

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

export type { Role };

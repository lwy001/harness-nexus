import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Credential, McpServer, McpTransport, Profile } from '@harness-nexus/core';
import {
  AppError,
  resolveDialSite,
  resolvePlaceholders,
  type ClientMcpConfig,
} from '@harness-nexus/shared';
import { decryptSecret, hashToken, PAT_PREFIX } from '../infra/crypto.js';

/**
 * Client config fetch (Phase 8 C2) — `GET /api/client/mcp-config?profile=<id>`.
 *
 * The single REST surface a `hnx mcp serve` shim talks to before serving an
 * agent tool. Auth is resolved HERE (not by the instance-level requireAuth
 * guard): an api PAT / JWT authenticates as its user, and — the one REST
 * exception for machine tokens — a `machine-ctl` PAT authenticates as its
 * machine's owner. Profile visibility follows the caller.
 *
 * Secret flow (the locked policy): transports are resolved to plaintext for
 * CLIENT-dialed servers only — which by derivation reference exclusively
 * distributable credentials. Server-dialed servers are listed without a
 * transport; the shim reaches them via the `/mcp` outlet. The plaintext of a
 * non-distributable credential NEVER enters any response here.
 */
export async function clientConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/client/mcp-config', async (req: FastifyRequest, reply) => {
    const caller = await resolveClientCaller(app, req);
    if (!caller) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const profileId = (req.query as { profile?: string }).profile;
    if (!profileId) {
      throw new AppError('A profile query parameter is required', 400, 'PROFILE_REQUIRED');
    }
    const profile = await app.uow.profiles.findById(profileId);
    if (!profile || !visibleProfile(profile, caller.userId, caller.role)) {
      throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
    }

    const key = app.credentialEncryptionKey;
    const distributable = new Map<string, boolean>();
    for (const cred of await app.uow.credentials.list()) {
      if (!distributable.has(cred.name)) distributable.set(cred.name, cred.distributable);
    }
    const isDistributable = (name: string): boolean => distributable.get(name) === true;

    const resolve = (input: string): Promise<string> =>
      resolvePlaceholders(input, async (name) => {
        const cred: Credential | null = await app.uow.credentials.findByName(name);
        if (!cred) {
          throw new AppError(
            `credential "${name}" not found (referenced by a profile entry)`,
            409,
            'CREDENTIAL_NOT_FOUND',
          );
        }
        return decryptSecret(cred.secret, key);
      });

    const servers: ClientMcpConfig['servers'] = [];
    let anyServerDialed = false;
    for (const entry of profile.entries) {
      if (entry.kind !== 'mcp') continue;
      const server = await app.uow.mcpServers.findById(entry.resourceId);
      if (!server || !visibleServer(server, caller.userId, caller.role)) {
        throw new AppError(
          'A profile entry references an MCP server you cannot access',
          403,
          'PROFILE_ENTRY_NOT_ACCESSIBLE',
        );
      }
      const site = resolveDialSite(server, isDistributable);
      if (site === 'server') {
        anyServerDialed = true;
        servers.push({ id: server.id, name: server.name, dialSite: 'server' });
        continue;
      }
      servers.push({
        id: server.id,
        name: server.name,
        dialSite: 'client',
        transport: await resolveTransport(server.transport, resolve),
      });
    }

    const config: ClientMcpConfig = {
      profileId: profile.id,
      platform: anyServerDialed ? { baseUrl: app.publicBaseUrl } : null,
      servers,
    };
    return reply.send(config);
  });
}

/**
 * Resolve the caller from the Authorization header. Machine PATs
 * (`machine-ctl`) map to their machine's owner — the ONLY REST surface they
 * unlock; the root auth hook rejects them everywhere else. Marketplace tokens
 * are rejected (their blast radius is the emitter URL only).
 */
async function resolveClientCaller(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<{ userId: string; role: 'admin' | 'user'; machineId?: string } | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const raw = header.slice('Bearer '.length).trim();

  if (raw.startsWith(PAT_PREFIX)) {
    const record = await app.uow.tokens.findByTokenHash(hashToken(raw));
    if (!record || (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) return null;
    if (record.scopes.includes('marketplace')) return null;

    if (record.scopes.includes('machine-ctl')) {
      const machine = await app.uow.machines.findByEnrollmentPatId(record.id);
      if (!machine) return null;
      const user = await app.uow.users.findById(machine.ownerId);
      return user?.status === 'active'
        ? { userId: user.id, role: user.role, machineId: machine.id }
        : null;
    }
    const user = await app.uow.users.findById(record.userId);
    return user?.status === 'active' ? { userId: user.id, role: user.role } : null;
  }

  try {
    const payload = await app.jwt.verifyAccessToken(raw);
    const user = await app.uow.users.findById(payload.sub);
    return user?.status === 'active' ? { userId: user.id, role: user.role } : null;
  } catch {
    return null;
  }
}

/** Substitute placeholders in a CLIENT-dialed transport (stdio included). */
async function resolveTransport(
  t: McpTransport,
  resolve: (input: string) => Promise<string>,
): Promise<Extract<ClientMcpConfig['servers'][number], { dialSite: 'client' }>['transport']> {
  if (t.type === 'stdio') {
    return {
      type: 'stdio',
      command: await resolve(t.command),
      ...(t.args ? { args: await Promise.all(t.args.map(resolve)) } : {}),
      ...(t.env
        ? {
            env: Object.fromEntries(
              await Promise.all(
                Object.entries(t.env).map(async ([k, v]) => [k, await resolve(v)] as const),
              ),
            ),
          }
        : {}),
    };
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.headers ?? {})) {
    headers[k] = await resolve(v);
  }
  return {
    type: t.type,
    url: await resolve(t.url),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

function visibleProfile(profile: Profile, userId: string, role: 'admin' | 'user'): boolean {
  return profile.scope === 'global' || profile.ownerId === userId || role === 'admin';
}

function visibleServer(server: McpServer, userId: string, role: 'admin' | 'user'): boolean {
  return server.scope === 'global' || server.ownerId === userId || role === 'admin';
}

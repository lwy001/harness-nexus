import { homedir } from 'node:os';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import { sessionsListRequestSchema, type NativeSessionView } from '@harness-nexus/shared';
import { AcpAgentConnection } from './acp/agent-connection.js';
import { resolveAcpCommand } from './acp/adapters.js';
import { currentCatalogModels, dshListSessions, nativeZstd } from './dsh-sessions.js';

/**
 * Native session listing (Phase 9 W7) — the chat rail's data source. The
 * platform persists nothing session-shaped; this answers `sessions:list` from
 * whatever the TARGET itself holds:
 *
 *   claude-code / codex — a short-lived ACP adapter spawn + `session/list`
 *     (the adapter IS the vendor's session list; no storage-format coupling).
 *   deepseek — a pure file scan of `~/.dsh/sessions` (no spawn, no auth; dsh's
 *     own list returns neither title nor time, so both come from the
 *     transcript header + mtime).
 *   hermes / zcode / generic — no verified native surface: `supported:false`.
 */

export interface SessionsHandlersOptions {
  /** Env source for `HN_ACP_COMMAND_<TARGET>` overrides. */
  env?: NodeJS.ProcessEnv;
  /** Overridable for tests. */
  homeDir?: string;
  /**
   * 9 W11 D — listing cache TTL override (tests). Env: `SESSIONS_CACHE_TTL_MS`,
   * default 15s, 0 = off.
   */
  cacheTtlMs?: number;
}

export function attachSessionsHandlers(socket: Socket, opts: SessionsHandlersOptions = {}): void {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const ttlMs =
    opts.cacheTtlMs ??
    (() => {
      const raw = Number.parseInt(env.SESSIONS_CACHE_TTL_MS ?? '', 10);
      return Number.isFinite(raw) ? Math.max(raw, 0) : 15_000;
    })();

  /**
   * 9 W11 D — listing TTL cache, keyed by target (one machine per daemon).
   * Every rail paint otherwise pays an adapter spawn (claude/codex) or a
   * zstd file walk (dsh); a hit answers without either. `refresh` bypasses
   * (the rail's manual refresh button), failures never cache, and
   * concurrent requests share the in-flight computation.
   */
  const cache = new Map<string, { expiresAt: number; sessions: NativeSessionView[] }>();
  const inFlight = new Map<string, Promise<NativeSessionView[]>>();
  const listCached = (
    target: string,
    refresh: boolean,
    compute: () => Promise<NativeSessionView[]>,
  ): Promise<NativeSessionView[]> => {
    const cached = cache.get(target);
    if (!refresh && cached !== undefined && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.sessions);
    }
    let p = inFlight.get(target);
    if (p === undefined) {
      p = compute().then((sessions) => {
        if (ttlMs > 0) cache.set(target, { expiresAt: Date.now() + ttlMs, sessions });
        return sessions;
      });
      p.finally(() => inFlight.delete(target)).catch(() => {});
      inFlight.set(target, p);
    }
    return p;
  };

  socket.on('sessions:list', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = sessionsListRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { requestId, target, refresh } = parsed.data;
    void (async () => {
      try {
        if (target === 'claude-code' || target === 'codex') {
          socket.emit('sessions:list:result', {
            requestId,
            sessions: await listCached(target, refresh === true, () => listViaAdapter(target, env)),
          });
          return;
        }
        if (target === 'deepseek') {
          socket.emit('sessions:list:result', {
            requestId,
            sessions: await listCached(target, refresh === true, async () => listDsh(home)),
          });
          return;
        }
        socket.emit('sessions:list:result', { requestId, supported: false });
      } catch (e) {
        socket.emit('sessions:list:result', {
          requestId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  });
}

/** dsh's file-scan listing, mapped to rail rows (pure — no spawn, no auth). */
function listDsh(home: string): NativeSessionView[] {
  const zstd = nativeZstd();
  if (zstd === null) {
    throw new Error('dsh session transcripts need Node >= 22.15 (zstd) on the daemon');
  }
  const catalog = (() => {
    try {
      return currentCatalogModels(readFileSync(join(home, '.dsh', 'settings.yaml'), 'utf8'));
    } catch {
      return null; // no settings yet — nothing to compare against
    }
  })();
  return dshListSessions(
    join(home, '.dsh', 'sessions'),
    {
      readdir: (p) => readdirSync(p),
      readFile: (p) => readFileSync(p),
      stat: (p) => statSync(p),
    },
    zstd,
    { maxSessions: 200 },
  ).map((s): NativeSessionView => {
    // dsh validates the session's PINNED (provider, model) against
    // the live catalog at resume — a provider-config change orphans
    // old sessions. Flag them here so the rail explains instead of
    // offering a guaranteed failure.
    if (s.model !== null && catalog !== null && !catalog.has(s.model)) {
      return {
        sessionId: s.sessionId,
        cwd: s.cwd,
        ...(s.title !== null ? { title: s.title } : {}),
        ...(s.updatedAt !== null ? { updatedAt: s.updatedAt } : {}),
        model: s.model,
        staleReason: 'model-missing',
      };
    }
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      ...(s.title !== null ? { title: s.title } : {}),
      ...(s.updatedAt !== null ? { updatedAt: s.updatedAt } : {}),
      ...(s.model !== null ? { model: s.model } : {}),
    };
  });
}

/** Spawn the target's adapter, `session/list`, kill. Bounded, best-effort. */
async function listViaAdapter(
  target: 'claude-code' | 'codex',
  env: NodeJS.ProcessEnv,
): Promise<NativeSessionView[]> {
  const cmd = resolveAcpCommand(target, env);
  if (cmd === null) throw new Error(`no ACP adapter for target '${target}'`);
  const { conn, sessionCaps } = await AcpAgentConnection.start(cmd.command, cmd.args, {
    cwd: homedir(),
  });
  try {
    if (!sessionCaps.list) throw new Error(`adapter for '${target}' does not support session/list`);
    const result = (await conn.request('session/list', {}, 10000)) as {
      sessions?: unknown;
    };
    const raw = Array.isArray(result?.sessions) ? (result!.sessions as unknown[]) : [];
    const out: NativeSessionView[] = [];
    for (const s of raw.slice(0, 200)) {
      if (s === null || typeof s !== 'object') continue;
      const r = s as Record<string, unknown>;
      if (typeof r['sessionId'] !== 'string' || r['sessionId'] === '') continue;
      if (typeof r['cwd'] !== 'string' || !r['cwd'].startsWith('/')) continue;
      out.push({
        sessionId: r['sessionId'],
        cwd: r['cwd'],
        ...(typeof r['title'] === 'string' && r['title'] !== ''
          ? { title: r['title'].slice(0, 256) }
          : {}),
        // Adapters speak different timestamp dialects (codex-acp's chrono
        // emits `+00:00` offsets). Normalize to ISO-Z when parseable and
        // DROP the field when not — a malformed timestamp must never fail
        // the whole listing downstream.
        ...isoTimestamp(r['updatedAt']),
      });
    }
    return out;
  } finally {
    conn.kill();
  }
}

/** `{updatedAt}` only when the value parses as a real timestamp (ISO-Z normalized). */
function isoTimestamp(value: unknown): { updatedAt?: string } {
  if (typeof value !== 'string' || value === '') return {};
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return {};
  return { updatedAt: new Date(ms).toISOString() };
}

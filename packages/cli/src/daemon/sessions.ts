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
  /** Native session ids currently LIVE in this daemon (dsh refuses resuming active). */
  liveNativeIds?: () => ReadonlySet<string>;
  /** Overridable for tests. */
  homeDir?: string;
}

export function attachSessionsHandlers(socket: Socket, opts: SessionsHandlersOptions = {}): void {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();

  socket.on('sessions:list', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = sessionsListRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { requestId, target } = parsed.data;
    void (async () => {
      try {
        if (target === 'claude-code' || target === 'codex') {
          socket.emit('sessions:list:result', {
            requestId,
            sessions: await listViaAdapter(target, env),
          });
          return;
        }
        if (target === 'deepseek') {
          const zstd = nativeZstd();
          if (zstd === null) {
            socket.emit('sessions:list:result', {
              requestId,
              error: 'dsh session transcripts need Node >= 22.15 (zstd) on the daemon',
            });
            return;
          }
          const catalog = (() => {
            try {
              return currentCatalogModels(
                readFileSync(join(home, '.dsh', 'settings.yaml'), 'utf8'),
              );
            } catch {
              return null; // no settings yet — nothing to compare against
            }
          })();
          const sessions = dshListSessions(
            join(home, '.dsh', 'sessions'),
            {
              readdir: (p) => readdirSync(p),
              readFile: (p) => readFileSync(p),
              stat: (p) => statSync(p),
            },
            zstd,
            { liveIds: opts.liveNativeIds?.() ?? new Set<string>() },
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
          socket.emit('sessions:list:result', { requestId, sessions });
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
        ...(typeof r['updatedAt'] === 'string' && r['updatedAt'] !== ''
          ? { updatedAt: r['updatedAt'] }
          : {}),
      });
    }
    return out;
  } finally {
    conn.kill();
  }
}

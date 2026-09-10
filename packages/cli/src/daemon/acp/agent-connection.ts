import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Minimal ACP client over a subprocess's stdio (Phase 8 C5) — JSON-RPC 2.0,
 * newline-delimited, exactly the wire the ACP v1 adapters speak. Hand-rolled
 * on purpose (no new dependency): three message shapes cover the whole
 * surface — requests with id correlation + timeouts, notifications, and the
 * one agent→client request (`session/request_permission`). The fixture agent
 * (test/fixtures/acp-agent.mjs) is the compatibility proof.
 */

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export type PermissionOutcome =
  { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

export interface AcpAgentInfo {
  name?: string | undefined;
  version?: string | undefined;
}

/** The resume-relevant slice of `agentCapabilities` (9 W7). */
export interface AcpSessionCaps {
  /** `session/load` — resume WITH history replay (claude/codex adapters). */
  load: boolean;
  /** `session/resume` — resume WITHOUT replay (dsh's native adapter). */
  resume: boolean;
  /** `session/list` exists (the claude/codex listing path). */
  list: boolean;
}

/**
 * Advertised caps decide the resume dialect (9 W7): prefer `session/load`
 * (replay for free), fall back to `session/resume`. `loadSession` is the
 * pre-capability legacy flag — and WHERE it sits differs by adapter family:
 * the Zed adapters set it at the initialize RESULT ROOT, the official
 * `@agentclientprotocol/claude-agent-acp` sets it NESTED inside
 * `agentCapabilities.loadSession` while its `sessionCapabilities` has `resume`
 * but NOT `load`. Reading only the root made the official wrapper look like a
 * resume-only adapter — claude-code channels then resumed with NO replay
 * ("opening a history session shows an empty pane").
 */
export function deriveSessionCaps(result: unknown): AcpSessionCaps {
  const r = (result ?? {}) as {
    loadSession?: boolean;
    agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: Record<string, unknown> };
  };
  const caps = r.agentCapabilities?.sessionCapabilities ?? {};
  return {
    load:
      caps['load'] !== undefined ||
      r.loadSession === true ||
      r.agentCapabilities?.loadSession === true,
    resume: caps['resume'] !== undefined,
    list: caps['list'] !== undefined,
  };
}

export class AcpAgentConnection {
  private proc: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrTail: string[] = [];
  private onNotification: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private onPermission: ((jsonrpcId: number, params: Record<string, unknown>) => void) | null =
    null;
  private exited = false;

  private constructor(proc: ChildProcess) {
    this.proc = proc;
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => this.handleLine(line));
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Keep a small tail for spawn/initialize failure messages.
      for (const l of chunk.toString('utf8').split('\n')) {
        if (l.trim() !== '') {
          this.stderrTail.push(l.trimEnd());
          if (this.stderrTail.length > 10) this.stderrTail.shift();
        }
      }
    });
    proc.on('exit', () => {
      this.exited = true;
      const err = new Error(`agent process exited unexpectedly${this.stderrTailSuffix()}`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  /** Spawn + `initialize` handshake + `initialized` notification. */
  static async start(
    command: string,
    args: string[],
    opts: { cwd: string; env?: NodeJS.ProcessEnv | undefined; initializeTimeoutMs?: number },
  ): Promise<{
    conn: AcpAgentConnection;
    agentInfo: AcpAgentInfo;
    sessionCaps: AcpSessionCaps;
  }> {
    const initializeTimeoutMs = opts.initializeTimeoutMs ?? 20000;
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        // Own process group: adapters spawn their own trees (npm → sh →
        // wrapper → the vendor binary). Signaling only the direct child
        // orphaned the grandchildren — a bare `claude` binary survived every
        // teardown, parented to init. kill() takes the whole group down.
        detached: true,
      });
    } catch (e) {
      throw new Error(`failed to spawn ACP adapter '${command}': ${errText(e)}`);
    }
    const conn = new AcpAgentConnection(proc);
    proc.on('error', (e) => {
      conn.failAll(new Error(`ACP adapter '${command}' failed: ${errText(e)}`));
    });
    const result = (await conn.request(
      'initialize',
      { protocolVersion: 1, clientCapabilities: {} },
      initializeTimeoutMs,
    )) as {
      agentInfo?: AcpAgentInfo;
      loadSession?: boolean;
      agentCapabilities?: { sessionCapabilities?: Record<string, unknown> };
    };
    conn.notify('initialized', {});
    return {
      conn,
      agentInfo: result?.agentInfo ?? {},
      sessionCaps: deriveSessionCaps(result),
    };
  }

  /** JSON-RPC request with a timeout; rejects on error/exit. */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited || this.proc.stdin === null) {
      return Promise.reject(new Error('agent process is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer: timer as unknown as NodeJS.Timeout,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Answer the agent's `session/request_permission` (optionId verbatim). */
  respondPermission(jsonrpcId: number, outcome: PermissionOutcome): void {
    this.send({ jsonrpc: '2.0', id: jsonrpcId, result: { outcome } });
  }

  setNotificationHandler(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.onNotification = handler;
  }

  setPermissionHandler(
    handler: (jsonrpcId: number, params: Record<string, unknown>) => void,
  ): void {
    this.onPermission = handler;
  }

  /** Fires when the subprocess exits on its own (crash/quit) — not on kill(). */
  onExit(handler: () => void): void {
    this.proc.on('exit', handler);
  }

  /**
   * SIGTERM the whole process GROUP, then SIGKILL it after `graceMs`.
   * Idempotent. The group signal is the point: the direct child (npm/npx)
   * dying does NOT take the wrapper and the vendor binary with it — they
   * reparent to init and keep running. The timer is unref'd and NOT cleared
   * on leader exit: grandchildren can outlive the leader, and the follow-up
   * SIGKILL to a dead group is a caught ESRCH.
   */
  kill(graceMs = 3000): void {
    if (this.exited || this.proc.stdin === null) return;
    this.proc.removeAllListeners('exit');
    const pid = this.proc.pid;
    const sigGroup = (sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig); // negative pid = the process group
      } catch {
        // group already gone
      }
    };
    const killTimer = setTimeout(() => sigGroup('SIGKILL'), graceMs);
    killTimer.unref();
    sigGroup('SIGTERM');
    this.proc.kill('SIGTERM'); // the leader too (belt and braces)
    this.failAll(new Error('agent process killed'));
    this.exited = true;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg: {
      id?: number | string | null;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return; // agents log noise on stdout sometimes; skip non-JSON lines
    }

    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      this.onPermission?.(Number(msg.id), msg.params ?? {});
      return;
    }
    if (msg.method !== undefined) {
      if (msg.id === undefined || msg.id === null) {
        this.onNotification?.(msg.method, msg.params ?? {});
      }
      return; // agent-side extension requests are not implemented (v1) — dropped
    }
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(pending.timer);
      if (msg.error !== undefined) {
        // Error `data` (e.g. dsh's `details: "no adapter registered for …"`)
        // rides along — the callers key retry/surface logic off it.
        const details = (msg.error as { data?: { details?: string } }).data?.details;
        pending.reject(
          new Error(`${msg.error.message ?? 'ACP request failed'}${details ? `: ${details}` : ''}`),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private send(message: unknown): void {
    if (this.proc.stdin === null || this.exited) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private stderrTailSuffix(): string {
    return this.stderrTail.length > 0 ? `: ${this.stderrTail.join(' | ')}` : '';
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

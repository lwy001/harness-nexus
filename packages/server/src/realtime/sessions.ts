import { randomUUID } from 'node:crypto';
import type { SessionsListResultEvent } from '@harness-nexus/shared';

/**
 * Native session-listing request bookkeeping (Phase 9 W7) — the same
 * request/response shape as the W6 workspace coordinator: a REST handler
 * registers a waiter, emits `sessions:list` into the machine's /ctl room, and
 * the daemon's reply resolves it here. Outcomes are values, not exceptions —
 * the route maps `reason` to HTTP codes.
 */

export interface SessionsListOutcome {
  ok: boolean;
  reason?: 'timeout' | 'disconnected';
  sessions?: SessionsListResultEvent['sessions'];
  supported?: boolean;
  error?: string;
}

interface ListWaiter {
  machineId: string;
  resolve: (outcome: SessionsListOutcome) => void;
  timer: NodeJS.Timeout;
}

export class SessionsCoordinator {
  private readonly waiters = new Map<string, ListWaiter>(); // requestId → waiter

  constructor(private readonly timeoutMs: number) {}

  /** Register the waiter for a listing we are about to emit. */
  awaitList(
    machineId: string,
    requestId: string = randomUUID(),
  ): {
    requestId: string;
    done: Promise<SessionsListOutcome>;
  } {
    const done = new Promise<SessionsListOutcome>((resolve) => {
      const waiter: ListWaiter = {
        machineId,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(requestId);
          resolve({ ok: false, reason: 'timeout' });
        }, this.timeoutMs),
      };
      this.waiters.set(requestId, waiter);
    });
    return { requestId, done };
  }

  /** A listing arrived; resolves its waiter. Returns false for unknown/late ids. */
  onList(requestId: string, evt: Omit<SessionsListResultEvent, 'requestId'>): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(requestId);
    if (evt.error !== undefined) {
      waiter.resolve({ ok: false, error: evt.error });
      return true;
    }
    waiter.resolve({
      ok: true,
      sessions: evt.sessions ?? [],
      supported: evt.supported ?? true,
    });
    return true;
  }

  /** Machine went offline: fail everything it was waiting on. */
  failMachine(machineId: string): void {
    for (const [requestId, waiter] of [...this.waiters.entries()]) {
      if (waiter.machineId !== machineId) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(requestId);
      waiter.resolve({ ok: false, reason: 'disconnected' });
    }
  }
}

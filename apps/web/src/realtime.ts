import { io, type Socket } from 'socket.io-client';
import { TOKEN_KEY } from './api.js';

/**
 * The browser's `/app` realtime channel (Phase 8): server-push events only in
 * C1 (`machine:status`). One lazily-created singleton socket; the auth
 * callback re-reads the stored token on EVERY (re)connect attempt, so a
 * refreshed JWT after re-login needs no extra protocol support. Browsers
 * never talk to daemons — the platform is the only routing point.
 */

/** Wire shape of `inventory:updated` (mirrors shared/realtime.ts). */
export interface InventoryUpdatedEvent {
  machineId: string;
  target: string;
  reportedAt: string;
}

/** Wire shape of `machine:status` (mirrors shared/realtime.ts). */
export interface MachineStatusEvent {
  machineId: string;
  online: boolean;
  lastSeenAt: string | null;
  daemonVersion?: string | null;
}

let socket: Socket | null = null;

export function appSocket(): Socket {
  if (socket === null) {
    socket = io('/app', {
      auth: (cb) => cb({ token: localStorage.getItem(TOKEN_KEY) ?? '' }),
    });
  }
  return socket;
}

/** Close the singleton (e.g. on logout). */
export function closeAppSocket(): void {
  if (socket !== null) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
}

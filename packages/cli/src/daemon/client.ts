import { arch, hostname, platform } from 'node:os';
import { io } from 'socket.io-client';
import {
  inventoryCollectRequestSchema,
  inventoryScanRequestSchema,
  type MachineHelloAck,
} from '@harness-nexus/shared';
import { collectItems, scanAllTargets, scanTarget } from '../inventory/scan.js';
import { attachJobHandlers } from './jobs.js';
import { attachChatHandlers } from './chat.js';

/** Client-side daemon version, reported in every `machine:hello`. */
export const DAEMON_VERSION = '0.4.0-c5';

/** Capabilities this daemon build carries (C3: inventory; C4: deploy; C5: chat). */
export const DAEMON_CAPABILITIES = ['inventory', 'deploy', 'chat'];

export interface DaemonOptions {
  server: string;
  /** Machine PAT (scopes ['machine-ctl']). */
  token: string;
  machineId: string;
}

/**
 * The on-demand Harness Nexus daemon (Phase 8 C1): connects to the server's
 * `/ctl` namespace, says `machine:hello` on every (re)connect so presence and
 * metadata stay fresh, and stays attached until SIGINT/SIGTERM. Socket.IO
 * handles reconnection with backoff; each reconnect re-runs hello and — since
 * C3 — re-reports every target's inventory (fresh snapshots whenever the
 * daemon comes up).
 *
 * The machine shows online exactly while this process is running — that is
 * the honest-presence contract; MCP serving (C2) does NOT depend on it.
 */
export function runDaemon(options: DaemonOptions): Promise<void> {
  const socket = io(`${options.server}/ctl`, {
    auth: { token: options.token, machineId: options.machineId },
    transports: ['websocket'],
  });

  attachJobHandlers(socket, { server: options.server, token: options.token });
  attachChatHandlers(socket);

  const reportAll = (requestId?: string): void => {
    void (async () => {
      for (const snapshot of scanAllTargets()) {
        socket.emit('inventory:report', { ...(requestId ? { requestId } : {}), snapshot });
      }
    })();
  };

  socket.on('connect', () => {
    socket.emit(
      'machine:hello',
      {
        daemonVersion: DAEMON_VERSION,
        os: platform(),
        arch: arch(),
        hostname: hostname(),
        capabilities: DAEMON_CAPABILITIES,
      },
      (res: unknown) => {
        const ack = res as MachineHelloAck | { error: string };
        if (ack && 'error' in ack) {
          // eslint-disable-next-line no-console
          console.error(`hnx daemon: hello rejected: ${ack.error}`);
          return;
        }
        // eslint-disable-next-line no-console
        console.log(
          `hnx daemon: online (proto ${(ack as MachineHelloAck).proto}, machine ${(ack as MachineHelloAck).machineId})`,
        );
        reportAll();
      },
    );
  });

  socket.on('inventory:scan', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = inventoryScanRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { requestId, targets } = parsed.data;
    void (async () => {
      for (const target of targets) {
        try {
          const snapshot = scanTarget(target);
          socket.emit('inventory:report', { requestId, snapshot });
        } catch {
          // No scanner for this target on this build — still report the empty
          // shape so the server's waiter never hangs on it.
          const home = `~/.${target}`;
          socket.emit('inventory:report', {
            requestId,
            snapshot: {
              target,
              scannedAt: new Date().toISOString(),
              agents: [{ name: home, directory: home, profileApplied: false, items: [] }],
            },
          });
        }
      }
    })();
  });

  socket.on('inventory:collect', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = inventoryCollectRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { requestId, target, items } = parsed.data;
    void (async () => {
      // Bodies are read fresh (paths re-derived) and secrets redacted
      // daemon-side before anything crosses the wire.
      const payloadItems = await collectItems(target, items);
      socket.emit('inventory:payload', { requestId, items: payloadItems });
    })();
  });

  socket.on('connect_error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error(`hnx daemon: connection error: ${err.message}`);
  });
  socket.on('disconnect', (reason: string) => {
    // eslint-disable-next-line no-console
    console.error(`hnx daemon: disconnected (${reason})`);
  });

  return new Promise((resolve) => {
    const stop = (): void => {
      socket.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

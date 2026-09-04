import { arch, hostname, platform } from 'node:os';
import { io } from 'socket.io-client';
import type { MachineHelloAck } from '@harness-nexus/shared';

/** Client-side daemon version, reported in every `machine:hello`. */
export const DAEMON_VERSION = '0.1.0-c1';

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
 * handles reconnection with backoff; each reconnect re-runs hello.
 *
 * The machine shows online exactly while this process is running — that is
 * the honest-presence contract; MCP serving (C2) will NOT depend on it.
 */
export function runDaemon(options: DaemonOptions): Promise<void> {
  const socket = io(`${options.server}/ctl`, {
    auth: { token: options.token, machineId: options.machineId },
    transports: ['websocket'],
  });

  socket.on('connect', () => {
    socket.emit(
      'machine:hello',
      {
        daemonVersion: DAEMON_VERSION,
        os: platform(),
        arch: arch(),
        hostname: hostname(),
        capabilities: [],
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
      },
    );
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

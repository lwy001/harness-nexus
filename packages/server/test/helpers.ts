import type { EventEmitter } from 'node:events';
import type { ServerConfig } from '../src/config.js';

/** Build a memory-mode ServerConfig for tests (no env needed). */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    storageDriver: 'memory',
    sqlitePath: ':memory:',
    dataDir: './data',
    logLevel: 'fatal',
    jwtSecret: 'test-secret-0123456789abcdef',
    jwtIssuer: 'test',
    jwtAccessTtl: '1h',
    credentialEncryptionKey: 'test-secret-0123456789abcdef',
    publicBaseUrl: 'http://127.0.0.1:1',
    marketplaceAllowlist: 'fixtures=example/fixtures',
    marketplaceFetchTtlMs: 1000,
    marketplaceFetchTimeoutMs: 1000,
    skillGithubTaps: '',
    skillSearchTimeoutMs: 100,
    socketMaxHttpBufferSize: 1024 * 1024,
    inventoryRequestTimeoutMs: 5000,
    runtimeConfigViewTimeoutMs: 700,
    jobAckTimeoutMs: 700,
    jobSweepIntervalMs: 200,
    jobMaxAttempts: 3,
    chatMaxSessionsPerMachine: 2,
    chatPermissionTimeoutMs: 400,
    chatReadyTimeoutMs: 800,
    ...overrides,
  };
}

/** Resolve on the next emission of `event` (with its arg), or reject on timeout. */
export function once<E extends EventEmitter>(
  emitter: E,
  event: string,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`timeout waiting for '${event}'`));
    }, timeoutMs);
    const onEvent = (arg: unknown) => {
      clearTimeout(timer);
      resolve(arg);
    };
    emitter.once(event, onEvent);
  });
}

/** Emit with an ack callback and resolve the ack response. */
export function emitAck(
  emitter: { emit: (event: string, payload: unknown, ack: (res: unknown) => void) => unknown },
  event: string,
  payload: unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ack of '${event}'`)),
      timeoutMs,
    );
    emitter.emit(event, payload, (res: unknown) => {
      clearTimeout(timer);
      resolve(res);
    });
  });
}

/** Poll `fn` until it returns true (10ms interval, 5s budget). */
export async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: condition not met before timeout');
}

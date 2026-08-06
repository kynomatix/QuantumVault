import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BIND_RETRY_LIMIT,
  BIND_RETRY_MS,
  SHUTDOWN_DRAIN_TIMEOUT_MS,
  STORAGE_CLOSE_TIMEOUT_MS,
  createGracefulHttpShutdown,
} from '../../server/graceful-http-shutdown';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('graceful HTTP shutdown', () => {
  it('stops HTTP admission first, waits for drain and cleanup, then closes storage once', async () => {
    const events: string[] = [];
    const drained = deferred();
    const cleanup = deferred();
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => {
        events.push('close-http');
        drained.promise.then(() => callback());
      }),
      closeIdleConnections: vi.fn(() => events.push('close-idle')),
      closeAllConnections: vi.fn(() => events.push('close-active')),
    };
    const shutdown = createGracefulHttpShutdown({
      server,
      beforeStorageClose: async () => {
        events.push('cleanup-start');
        await cleanup.promise;
        events.push('cleanup-end');
      },
      closeStorage: async () => {
        events.push('close-storage');
      },
      onTimeout: vi.fn(),
      onStorageTimeout: vi.fn(),
      timeoutMs: 1_000,
    });

    const first = shutdown();
    const second = shutdown();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(events.slice(0, 2)).toEqual(['close-http', 'close-idle']);
    expect(events).not.toContain('close-storage');

    drained.resolve();
    await Promise.resolve();
    expect(events).not.toContain('close-storage');
    cleanup.resolve();

    await expect(first).resolves.toBe('drained');
    expect(events).toEqual([
      'close-http',
      'close-idle',
      'cleanup-start',
      'cleanup-end',
      'close-storage',
    ]);
    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('forces active connections and reports an environment halt at the deadline', async () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const server = {
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(() => events.push('forced-close')),
    };
    const closeStorage = vi.fn().mockResolvedValue(undefined);
    const onTimeout = vi.fn(() => events.push('environment-halt-evidence'));
    const shutdown = createGracefulHttpShutdown({
      server,
      beforeStorageClose: () => new Promise<void>(() => {}),
      closeStorage,
      onTimeout,
      onStorageTimeout: vi.fn(),
      timeoutMs: 120,
      storageTimeoutMs: 60,
    });

    const result = shutdown();
    await vi.advanceTimersByTimeAsync(120);

    await expect(result).resolves.toBe('timed_out');
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith(120);
    expect(events).toEqual(['environment-halt-evidence', 'forced-close']);
    expect(closeStorage).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('waits for a deferred storage close after forcing active connections', async () => {
    vi.useFakeTimers();
    const storage = deferred();
    const events: string[] = [];
    const shutdown = createGracefulHttpShutdown({
      server: {
        close: vi.fn(),
        closeIdleConnections: vi.fn(),
        closeAllConnections: vi.fn(() => events.push('forced-close')),
      },
      beforeStorageClose: () => new Promise<void>(() => {}),
      closeStorage: async () => {
        events.push('storage-start');
        await storage.promise;
        events.push('storage-end');
      },
      onTimeout: () => events.push('http-environment-halt'),
      onStorageTimeout: () => events.push('storage-environment-halt'),
      timeoutMs: 120,
      storageTimeoutMs: 60,
    });

    let settled = false;
    const result = shutdown().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(120);
    expect(settled).toBe(false);
    expect(events).toEqual(['http-environment-halt', 'forced-close', 'storage-start']);
    storage.resolve();
    await expect(result).resolves.toBe('timed_out');
    expect(events).toEqual([
      'http-environment-halt',
      'forced-close',
      'storage-start',
      'storage-end',
    ]);
    vi.useRealTimers();
  });

  it('bounds a stuck storage close and reports a distinct environment halt', async () => {
    vi.useFakeTimers();
    const onStorageTimeout = vi.fn();
    const shutdown = createGracefulHttpShutdown({
      server: {
        close: vi.fn(),
        closeIdleConnections: vi.fn(),
        closeAllConnections: vi.fn(),
      },
      beforeStorageClose: () => new Promise<void>(() => {}),
      closeStorage: () => new Promise<void>(() => {}),
      onTimeout: vi.fn(),
      onStorageTimeout,
      timeoutMs: 120,
      storageTimeoutMs: 60,
    });

    let settled = false;
    const result = shutdown().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(120);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(59);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('timed_out');
    expect(onStorageTimeout).toHaveBeenCalledWith(60);
    vi.useRealTimers();
  });

  it('reports a close error without duplicating the shutdown sequence', async () => {
    const server = {
      close: vi.fn((callback: (error?: Error) => void) => callback(new Error('not listening'))),
      closeIdleConnections: vi.fn(),
    };
    const shutdown = createGracefulHttpShutdown({
      server,
      beforeStorageClose: async () => {},
      closeStorage: async () => {},
      onTimeout: vi.fn(),
      onStorageTimeout: vi.fn(),
      timeoutMs: 1_000,
    });

    await expect(shutdown()).resolves.toBe('close_error');
    await expect(shutdown()).resolves.toBe('close_error');
    expect(server.close).toHaveBeenCalledTimes(1);
  });
});

describe('close-path and restart contract wiring', () => {
  it('keeps the bind retry window above both sequential shutdown deadlines', () => {
    expect(BIND_RETRY_MS * BIND_RETRY_LIMIT).toBeGreaterThan(
      SHUTDOWN_DRAIN_TIMEOUT_MS + STORAGE_CLOSE_TIMEOUT_MS,
    );
  });

  it('uses the strict authority read only at the two initial Signal Bot full-close decisions', () => {
    const routes = readFileSync('server/routes.ts', 'utf8');
    const strictReads = routes.match(/getPositionForCloseAuthority\(/g) ?? [];
    const cacheFallbacks = routes.match(/getRiskReducingCachedCloseFallback\(/g) ?? [];
    expect(strictReads).toHaveLength(2);
    expect(cacheFallbacks).toHaveLength(2);
    expect(routes).toContain('getPositionForExecution(');
    expect(routes).toContain('only for a reduce-only close');
    expect(routes).toContain('All declared close-position authority sources failed');
  });

  it('removes the legacy ten-second shutdown backstop and uses the shared drain helper', () => {
    const index = readFileSync('server/index.ts', 'utf8');
    expect(index).toContain('createGracefulHttpShutdown({');
    expect(index).not.toContain('Shutdown grace period (10s)');
    expect(index).not.toContain('}, 10_000);');
  });
});

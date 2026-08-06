export const SHUTDOWN_DRAIN_TIMEOUT_MS = 120_000;
export const STORAGE_CLOSE_TIMEOUT_MS = 60_000;
export const BIND_RETRY_MS = 1_000;
export const BIND_RETRY_LIMIT = 195;

export type GracefulHttpShutdownOutcome = 'drained' | 'timed_out' | 'close_error';

export interface DrainableHttpServer {
  close(callback: (error?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
}

interface GracefulHttpShutdownDependencies {
  server: DrainableHttpServer;
  beforeStorageClose: () => Promise<void>;
  closeStorage: () => Promise<void>;
  onTimeout: (timeoutMs: number) => void | Promise<void>;
  onStorageTimeout: (timeoutMs: number) => void | Promise<void>;
  timeoutMs?: number;
  storageTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

export function createGracefulHttpShutdown(
  dependencies: GracefulHttpShutdownDependencies,
): () => Promise<GracefulHttpShutdownOutcome> {
  let activeShutdown: Promise<GracefulHttpShutdownOutcome> | undefined;

  return () => {
    if (!activeShutdown) activeShutdown = runShutdown(dependencies);
    return activeShutdown;
  };
}

async function runShutdown(
  dependencies: GracefulHttpShutdownDependencies,
): Promise<GracefulHttpShutdownOutcome> {
  const timeoutMs = dependencies.timeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  let closeError: Error | undefined;

  const httpDrained = new Promise<void>((resolve) => {
    try {
      dependencies.server.close((error?: Error) => {
        closeError = error;
        resolve();
      });
      dependencies.server.closeIdleConnections?.();
    } catch (error) {
      closeError = error instanceof Error ? error : new Error(String(error));
      resolve();
    }
  });

  const subsystemCleanup = Promise.resolve()
    .then(dependencies.beforeStorageClose)
    .catch((error) => {
      closeError = error instanceof Error ? error : new Error(String(error));
    });
  const readyForStorageClose = Promise.allSettled([httpDrained, subsystemCleanup]);
  let storageClose: Promise<void> | undefined;
  const startStorageClose = () => {
    if (!storageClose) {
      storageClose = Promise.resolve()
        .then(dependencies.closeStorage)
        .catch((error) => {
          closeError = error instanceof Error ? error : new Error(String(error));
        });
    }
    return storageClose;
  };
  const waitForStorageCloseWithinBound = async () => {
    const storageTimeoutMs = dependencies.storageTimeoutMs ?? STORAGE_CLOSE_TIMEOUT_MS;
    let storageTimer: ReturnType<typeof setTimeout> | undefined;
    const storageTimedOut = new Promise<'storage_timed_out'>((resolve) => {
      storageTimer = setTimer(() => resolve('storage_timed_out'), storageTimeoutMs);
      storageTimer.unref?.();
    });
    const storageResult = await Promise.race([
      startStorageClose().then(() => 'storage_closed' as const),
      storageTimedOut,
    ]);
    if (storageTimer) clearTimer(storageTimer);
    if (storageResult === 'storage_timed_out') {
      await Promise.resolve(dependencies.onStorageTimeout(storageTimeoutMs)).catch(() => {});
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timed_out'>((resolve) => {
    timer = setTimer(() => resolve('timed_out'), timeoutMs);
    timer.unref?.();
  });

  const first = await Promise.race([
    readyForStorageClose
      .then(startStorageClose)
      .then(() => 'ready' as const),
    timedOut,
  ]);

  if (first === 'timed_out') {
    await Promise.resolve(dependencies.onTimeout(timeoutMs)).catch(() => {});
    try {
      dependencies.server.closeAllConnections?.();
    } catch {
      // The process will exit after the timeout outcome is recorded.
    }
    await waitForStorageCloseWithinBound();
    return 'timed_out';
  }

  if (timer) clearTimer(timer);
  return closeError ? 'close_error' : 'drained';
}

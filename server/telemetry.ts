/**
 * Local telemetry persistence — async queue edition.
 *
 * Appends lines that are already emitted to console.log to a size-rotated
 * local file so incident-window evidence survives a deployment-log rollover.
 *
 * Contract:
 *  - appendTelemetry(line):void is fire-and-forget: it timestamps the line
 *    synchronously at enqueue time, pushes it to a module-level FIFO buffer,
 *    then triggers a single serial async drainer if not already running.
 *    The disk write is entirely off the main event loop.
 *  - The drainer uses fs.promises exclusively, so no synchronous fs call
 *    ever blocks the event loop during normal operation.
 *  - The drainer batches all currently-queued lines into ONE fs.promises.appendFile
 *    call per drain cycle.  Each element in the batch already ends with "\n",
 *    so the payload contains only whole lines — no reader ever sees a torn line.
 *  - Cross-process line integrity: the lab child process (separate PID) also
 *    calls appendTelemetry on the same file.  Each individual queued line is
 *    well under 4 KB, matching the POSIX O_APPEND atomic-write boundary, so
 *    concurrent appends from different processes cannot interleave mid-line.
 *    A batch write from one process may exceed 4 KB but only that process's
 *    drainer writes from inside the process; there is no in-process race.
 *  - appendTelemetrySync(line):void contains the original blocking
 *    fs.appendFileSync path.  It is exported for the process.on('exit') handler
 *    ONLY, where the event loop is dead and async cannot run.  Do not use it
 *    anywhere else.
 *  - flushTelemetry(timeoutMs):Promise<void> awaits the drainer draining the
 *    in-flight queue, bounded by timeoutMs.  Use in SIGTERM/SIGINT handlers
 *    before process.exit().
 *  - Rotation: two-file (telemetry.log → telemetry.log.1) on MAX_BYTES cap.
 *    Only the drainer ever renames/appends, so there is exactly one writer per
 *    process and no in-process rotation race.  A cross-PID rotate race (lab
 *    child) is harmless: the rename that loses catches ENOENT and the appender
 *    starts a fresh file.
 *  - All I/O failures are swallowed silently — telemetry must never affect the
 *    running application.
 *  - appendTelemetry is a documented no-op under VITEST: test processes must
 *    never write to the shared telemetry file (caused prod misdiagnosis
 *    Jul 18, 2026).  Tests that need to exercise queue mechanics use the
 *    __appendForTests export which bypasses the guard.
 */

import fs from "fs";
import path from "path";

const LOG_DIR = "logs";
const LOG_FILE = path.join(LOG_DIR, "telemetry.log");
const LOG_ROTATED = path.join(LOG_DIR, "telemetry.log.1");
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

const MAX_QUEUE_LINES = 2000;
const MAX_QUEUE_BYTES = 2 * 1024 * 1024; // 2 MB

// ── Effective paths / limits (overridable by test hooks) ─────────────────────
let _logDir = LOG_DIR;
let _logFile = LOG_FILE;
let _logRotated = LOG_ROTATED;
let _maxBytes = MAX_BYTES;
let _maxQueueLines = MAX_QUEUE_LINES;
let _maxQueueBytes = MAX_QUEUE_BYTES;

// ── Module-level queue state ─────────────────────────────────────────────────
const _queue: string[] = []; // pre-formatted "ISO timestamp line\n" strings
let _queueBytes = 0;
let _droppedLines = 0;
let _drainerRunning = false;
let _consecutiveFailures = 0;
const _flushResolvers: Array<() => void> = [];

// Generation counter — incremented by __resetTelemetryForTests() to invalidate
// any in-flight drainer from a previous test so stale drainers never resolve
// flush resolvers or mutate state that belongs to the current generation.
let _drainerGeneration = 0;

// ── Async drainer ─────────────────────────────────────────────────────────────
// Single serial loop — only one instance per generation ever runs at a time.
async function _runDrainer(myGen: number): Promise<void> {
  _drainerRunning = true;
  try {
    while (_queue.length > 0 && _drainerGeneration === myGen) {
      // Snapshot the current batch synchronously (no interleave with callers).
      const batch = _queue.splice(0);
      _queueBytes = 0;

      try {
        await fs.promises.mkdir(_logDir, { recursive: true });

        // Rotation check — only the drainer ever touches the file, so there is
        // no in-process race between stat and rename.
        try {
          const { size } = await fs.promises.stat(_logFile);
          if (size >= _maxBytes) {
            try {
              await fs.promises.rename(_logFile, _logRotated);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
              // Another process (Lab child) already rotated — fresh file, continue.
            }
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          // File does not exist yet — appendFile will create it.
        }

        // Write all lines as one payload.  Each element ends with "\n", so
        // the payload contains only whole lines.
        await fs.promises.appendFile(_logFile, batch.join(""));

        // Recovery summary: emitted once after coming back from write failures.
        // Pushed directly to avoid calling appendTelemetry() (VITEST guard +
        // bound checks there are for external callers, not internal recovery).
        if (_consecutiveFailures > 0 && _drainerGeneration === myGen) {
          const prev = _consecutiveFailures;
          const dropped = _droppedLines;
          _consecutiveFailures = 0;
          const summaryLine =
            `${new Date().toISOString()} [Telemetry] writer recovered; failures=${prev} dropped=${dropped}\n`;
          if (_queue.length < _maxQueueLines && _queueBytes + summaryLine.length <= _maxQueueBytes) {
            _queue.push(summaryLine);
            _queueBytes += summaryLine.length;
          }
        }
      } catch {
        // Write failed — put the batch back at the front so its lines are retried.
        _consecutiveFailures++;
        const batchBytes = batch.reduce((acc, l) => acc + l.length, 0);
        if (
          _queue.length + batch.length <= _maxQueueLines &&
          _queueBytes + batchBytes <= _maxQueueBytes
        ) {
          _queue.unshift(...batch);
          _queueBytes += batchBytes;
        } else {
          // No room to re-enqueue — count as dropped.
          _droppedLines += batch.length;
        }
        // Brief backoff before retry to avoid a tight spin on a persistent error.
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }
  } finally {
    // Only update shared state and notify waiters if this drainer is still
    // the current generation.  A stale drainer (from a test reset) must not
    // clear _drainerRunning or resolve flush resolvers that belong to a newer
    // drainer / newer test.
    if (_drainerGeneration === myGen) {
      _drainerRunning = false;
      const resolvers = _flushResolvers.splice(0);
      for (const r of resolvers) r();
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget async writer.  Timestamps the line at call time and enqueues
 * it for async disk write.  Never throws; never blocks the event loop.
 *
 * No-op under VITEST — tests must use __appendForTests to exercise queue logic.
 */
export function appendTelemetry(line: string): void {
  if (process.env.VITEST) return;
  try {
    const formatted = `${new Date().toISOString()} ${line}\n`;
    if (_queue.length >= _maxQueueLines || _queueBytes + formatted.length > _maxQueueBytes) {
      _droppedLines++;
      return;
    }
    _queue.push(formatted);
    _queueBytes += formatted.length;
    if (!_drainerRunning) {
      const gen = _drainerGeneration;
      _runDrainer(gen).catch(() => {
        // drainer swallows errors internally; this outer catch is a safety net.
      });
    }
  } catch {
    // Swallow all errors — telemetry must never affect the app.
  }
}

/**
 * Synchronously drain any lines still in the async queue.
 *
 * For use ONLY in the process.on('exit') handler where the event loop is
 * dead and async cannot run.  Under the old sync writer every line was on
 * disk at the moment it was emitted; the async rewrite would silently discard
 * queued lines on an uncaught crash unless this is called first.
 * No-op under VITEST.
 */
export function drainQueueSyncForExit(): void {
  if (process.env.VITEST) return;
  if (_queue.length === 0) return;
  try {
    fs.mkdirSync(_logDir, { recursive: true });
    try {
      const { size } = fs.statSync(_logFile);
      if (size >= _maxBytes) {
        try {
          fs.renameSync(_logFile, _logRotated);
        } catch {
          // Another process already rotated — fresh file.
        }
      }
    } catch {
      // File does not exist yet — appendFileSync will create it.
    }
    fs.appendFileSync(_logFile, _queue.join(""));
    _queue.length = 0;
    _queueBytes = 0;
  } catch {
    // Swallow all errors — telemetry must never affect the app.
  }
}

/**
 * Synchronous emergency writer.
 *
 * For use ONLY in the process.on('exit') handler where the event loop is
 * dead and async cannot run.  Uses the original blocking appendFileSync path.
 * All normal writes go through appendTelemetry().
 *
 * Also a no-op under VITEST.
 */
export function appendTelemetrySync(line: string): void {
  if (process.env.VITEST) return;
  try {
    fs.mkdirSync(_logDir, { recursive: true });
    try {
      const { size } = fs.statSync(_logFile);
      if (size >= _maxBytes) {
        try {
          fs.renameSync(_logFile, _logRotated);
        } catch {
          // Another process already rotated — proceed with the now-fresh file.
        }
      }
    } catch {
      // File does not exist yet — appendFileSync will create it.
    }
    fs.appendFileSync(_logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Swallow all errors — telemetry must never affect the app.
  }
}

/**
 * Await the in-flight drainer draining the current queue, bounded by
 * timeoutMs.  Resolves (does not reject) even if the fs promise stalls —
 * suitable for graceful SIGTERM/SIGINT shutdown.
 */
export async function flushTelemetry(timeoutMs: number): Promise<void> {
  // If there are items but no drainer (edge case after a reset), start one.
  if (!_drainerRunning && _queue.length > 0) {
    const gen = _drainerGeneration;
    _runDrainer(gen).catch(() => {});
  }
  if (!_drainerRunning && _queue.length === 0) return;
  return Promise.race([
    new Promise<void>((resolve) => _flushResolvers.push(resolve)),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// ── Test-only exports ─────────────────────────────────────────────────────────
// Named with __ prefix per project convention.
// Never import these in production code.

/**
 * Reset all queue and drainer state between test cases.
 * Increments the drainer generation so any in-flight drainer from the previous
 * test becomes inert and cannot resolve flush resolvers or mutate state.
 */
export function __resetTelemetryForTests(): void {
  _drainerGeneration++;
  _queue.length = 0;
  _queueBytes = 0;
  _droppedLines = 0;
  _drainerRunning = false;
  _consecutiveFailures = 0;
  _flushResolvers.length = 0;
}

/** Read queue state without modifying it. */
export function __getTelemetryStateForTests(): {
  queueLength: number;
  queueBytes: number;
  droppedLines: number;
  drainerRunning: boolean;
  consecutiveFailures: number;
} {
  return {
    queueLength: _queue.length,
    queueBytes: _queueBytes,
    droppedLines: _droppedLines,
    drainerRunning: _drainerRunning,
    consecutiveFailures: _consecutiveFailures,
  };
}

/** Redirect the drainer to a temp directory for test isolation. */
export function __setLogPathsForTests(dir: string, file: string, rotated: string): void {
  _logDir = dir;
  _logFile = file;
  _logRotated = rotated;
}

/** Restore original log paths. */
export function __resetLogPathsForTests(): void {
  _logDir = LOG_DIR;
  _logFile = LOG_FILE;
  _logRotated = LOG_ROTATED;
}

/** Override MAX_BYTES threshold (for rotation tests). */
export function __setMaxBytesForTests(n: number): void {
  _maxBytes = n;
}

/** Restore MAX_BYTES. */
export function __resetMaxBytesForTests(): void {
  _maxBytes = MAX_BYTES;
}

/** Override queue bounds (for overflow tests). */
export function __setQueueBoundsForTests(maxLines: number, maxBytes: number): void {
  _maxQueueLines = maxLines;
  _maxQueueBytes = maxBytes;
}

/** Restore queue bounds. */
export function __resetQueueBoundsForTests(): void {
  _maxQueueLines = MAX_QUEUE_LINES;
  _maxQueueBytes = MAX_QUEUE_BYTES;
}

/**
 * Enqueue a line, bypassing the VITEST no-op guard.
 * For tests that need to exercise actual queue and drainer mechanics.
 */
export function __appendForTests(line: string): void {
  try {
    const formatted = `${new Date().toISOString()} ${line}\n`;
    if (_queue.length >= _maxQueueLines || _queueBytes + formatted.length > _maxQueueBytes) {
      _droppedLines++;
      return;
    }
    _queue.push(formatted);
    _queueBytes += formatted.length;
    if (!_drainerRunning) {
      const gen = _drainerGeneration;
      _runDrainer(gen).catch(() => {});
    }
  } catch {
    // Swallow.
  }
}

/**
 * Synchronous write, bypassing the VITEST no-op guard.
 * For tests that need to exercise the exit-path / appendTelemetrySync mechanics.
 */
export function __appendSyncForTests(line: string): void {
  try {
    fs.mkdirSync(_logDir, { recursive: true });
    try {
      const { size } = fs.statSync(_logFile);
      if (size >= _maxBytes) {
        try {
          fs.renameSync(_logFile, _logRotated);
        } catch {
          // Race — proceed with the now-fresh file.
        }
      }
    } catch {
      // File does not exist yet.
    }
    fs.appendFileSync(_logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Swallow.
  }
}

/**
 * Local telemetry persistence.
 *
 * Appends lines that are already emitted to console.log to a size-rotated
 * local file so incident-window evidence survives a deployment-log rollover.
 *
 * Contract:
 *  - All I/O failures are swallowed silently — telemetry must never affect
 *    the running application.
 *  - Uses fs.appendFileSync (O_APPEND) which is POSIX-atomic for lines well
 *    under 4 KB, safe for concurrent appends from the main process and the
 *    QuantumLab child process sharing the same filesystem.
 *  - Simple two-file rotation (telemetry.log → telemetry.log.1) on 5 MB cap.
 *    A concurrent rotate race between two processes is harmless: the rename
 *    that loses the race catches ENOENT and the appender starts a new file.
 */

import fs from "fs";
import path from "path";

const LOG_DIR = "logs";
const LOG_FILE = path.join(LOG_DIR, "telemetry.log");
const LOG_ROTATED = path.join(LOG_DIR, "telemetry.log.1");
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

export function appendTelemetry(line: string): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try {
      const { size } = fs.statSync(LOG_FILE);
      if (size >= MAX_BYTES) {
        try {
          fs.renameSync(LOG_FILE, LOG_ROTATED);
        } catch {
          // Another process already rotated — proceed with the now-fresh file.
        }
      }
    } catch {
      // File does not exist yet — appendFileSync will create it.
    }
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + " " + line + "\n");
  } catch {
    // Swallow all errors — telemetry must never affect the app.
  }
}

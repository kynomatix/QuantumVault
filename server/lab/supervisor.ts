import { spawn, type ChildProcess } from "child_process";
import { resolve, dirname } from "path";
import { createHash } from "crypto";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";

export interface LabSupervisorStatus {
  pid: number | null;
  isReady: boolean;
  restartCount: number;
  consecutiveFailures: number;
  suspended: boolean;
  labPort: number;
}

export interface LabSupervisor {
  labPort: number;
  isReady: boolean;
  start(): Promise<void>;
  shutdown(): Promise<void>;
  requestManualRestart(): Promise<{ newPid: number | null }>;
  getStatus(): LabSupervisorStatus;
}

const LAB_PORT = 5050;
const PID_FILE = "/tmp/quantumlab.pid";
const MIN_RESTART_DELAY = 2000;
const MAX_RESTART_DELAY = 60000;
const HEALTH_CHECK_INTERVAL = 30000;
const READY_TIMEOUT = 120000;
const MAX_CONSECUTIVE_FAILURES = 8;
const FAILURE_WINDOW_MS = 300_000;

function deriveLabAuthSecret(): string {
  const base = process.env.SESSION_SECRET;
  if (!base) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "[LabSupervisor] FATAL: SESSION_SECRET is not set. Refusing to derive lab auth secret from a hardcoded default in production."
      );
    }
    console.warn("[LabSupervisor] WARNING: SESSION_SECRET not set — using insecure default. Set SESSION_SECRET before deploying.");
  }
  return createHash("sha256").update(`lab-auth:${base ?? "quantum-vault-secret-change-in-production"}`).digest("hex");
}

const LAB_AUTH_SECRET = deriveLabAuthSecret();

export function getLabAuthSecret(): string {
  return LAB_AUTH_SECRET;
}

async function probeHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return resp.ok;
  } catch {
    return false;
  }
}

function readPidFile(): number | null {
  try {
    if (!existsSync(PID_FILE)) return null;
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function writePidFile(pid: number): void {
  try {
    writeFileSync(PID_FILE, String(pid));
  } catch {}
}

function removePidFile(): void {
  try {
    if (existsSync(PID_FILE)) unlinkSync(PID_FILE);
  } catch {}
}

export function createLabSupervisor(): LabSupervisor {
  let child: ChildProcess | null = null;
  let labPort = LAB_PORT;
  let isReady = false;
  let restartCount = 0;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let shuttingDown = false;
  let ownsChild = false;
  let spawnInFlight = false;
  let consecutiveFailures = 0;
  let firstFailureTime = 0;
  let backoffSuspended = false;
  let suspensionTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingAutoRestartTimer: ReturnType<typeof setTimeout> | null = null;

  function getRestartDelay(): number {
    const base = Math.min(MIN_RESTART_DELAY * Math.pow(2, restartCount), MAX_RESTART_DELAY);
    const jitter = Math.random() * base * 0.3;
    return base + jitter;
  }

  function recordFailure(): boolean {
    const now = Date.now();
    if (now - firstFailureTime > FAILURE_WINDOW_MS) {
      consecutiveFailures = 0;
      firstFailureTime = now;
    }
    consecutiveFailures++;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      backoffSuspended = true;
      console.error(`[LabSupervisor] ${consecutiveFailures} consecutive failures in ${Math.round((now - firstFailureTime) / 1000)}s — suspending restarts for 5 minutes`);
      if (suspensionTimer) clearTimeout(suspensionTimer);
      suspensionTimer = setTimeout(() => {
        suspensionTimer = null;
        backoffSuspended = false;
        consecutiveFailures = 0;
        restartCount = 0;
        console.log(`[LabSupervisor] Restart suspension lifted, will attempt fresh spawn`);
        if (!shuttingDown && !spawnInFlight && !isReady) {
          spawnAndWaitForReady().catch((err) => {
            console.error(`[LabSupervisor] Failed to restart after suspension: ${err.message}`);
          });
        }
      }, FAILURE_WINDOW_MS);
      return false;
    }
    return true;
  }

  function recordSuccess() {
    consecutiveFailures = 0;
    firstFailureTime = 0;
    backoffSuspended = false;
  }

  let consecutiveHealthFailures = 0;
  const MAX_HEALTH_FAILURES = 5;

  function startHealthCheck() {
    if (healthTimer) clearInterval(healthTimer);
    consecutiveHealthFailures = 0;
    healthTimer = setInterval(async () => {
      if (shuttingDown) return;
      const healthy = await probeHealth(labPort);
      if (healthy) {
        if (!isReady) {
          console.log(`[LabSupervisor] Lab process became reachable on port ${labPort}`);
        }
        isReady = true;
        consecutiveHealthFailures = 0;
      } else {
        consecutiveHealthFailures++;
        if (isReady) {
          console.log(`[LabSupervisor] Health check failed (${consecutiveHealthFailures}/${MAX_HEALTH_FAILURES})`);
        }
        if (consecutiveHealthFailures >= MAX_HEALTH_FAILURES) {
          isReady = false;
          if (backoffSuspended) {
            console.log(`[LabSupervisor] Health check failed but restart suspended — waiting for cooldown`);
            consecutiveHealthFailures = 0;
          } else if (ownsChild && child) {
            console.log(`[LabSupervisor] Health check failed ${MAX_HEALTH_FAILURES} times, killing child for restart`);
            consecutiveHealthFailures = 0;
            try { child.kill("SIGKILL"); } catch {}
          } else if (!ownsChild) {
            consecutiveHealthFailures = 0;
            const stalePid = readPidFile();
            if (stalePid) {
              console.log(`[LabSupervisor] Killing unreachable existing process (pid: ${stalePid}) before spawning new one`);
              try { process.kill(stalePid, "SIGKILL"); } catch {}
              removePidFile();
            }
            console.log(`[LabSupervisor] Existing lab process unreachable, spawning new one`);
            ownsChild = true;
            spawnAndWaitForReady().catch((err) => {
              console.error(`[LabSupervisor] Failed to spawn new lab: ${err.message}`);
            });
          }
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  function spawnAndWaitForReady(): Promise<void> {
    if (spawnInFlight) {
      console.log(`[LabSupervisor] Spawn already in flight, skipping duplicate`);
      return Promise.resolve();
    }
    spawnInFlight = true;

    return new Promise((resolveReady, rejectReady) => {
      const isProd = typeof (globalThis as any).__ESBUILD_CJS_BUNDLE__ !== "undefined";
      const entryPath = isProd
        ? resolve(dirname(process.argv[1] || __filename), "lab-server.cjs")
        : resolve(process.cwd(), "server", "lab", "index.ts");

      const env = {
        ...process.env,
        LAB_PORT: String(labPort),
        LAB_AUTH_SECRET,
        DB_POOL_SIZE: "5",
        DB_CONN_TIMEOUT_MS: "25000",
      };

      const args = isProd ? [entryPath] : ["--import", "tsx", entryPath];

      const spawnedChild = spawn("node", args, {
        env,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        detached: true,
      });

      child = spawnedChild;
      ownsChild = true;

      if (spawnedChild.pid) {
        writePidFile(spawnedChild.pid);
        console.log(`[LabSupervisor] Spawned lab process (pid: ${spawnedChild.pid})`);
      }

      const readyTimeout = setTimeout(async () => {
        console.log(`[LabSupervisor] Child did not send IPC ready within ${READY_TIMEOUT}ms, falling back to bounded health poll`);
        spawnedChild.unref();
        try { spawnedChild.disconnect?.(); } catch {}

        const HEALTH_POLL_TIMEOUT = 180_000;
        const HEALTH_POLL_INTERVAL = 5_000;
        const deadline = Date.now() + HEALTH_POLL_TIMEOUT;
        let resolved = false;
        const poll = async () => {
          while (Date.now() < deadline && !resolved) {
            const healthy = await probeHealth(labPort);
            if (healthy) {
              isReady = true;
              restartCount = 0;
              resolved = true;
              spawnInFlight = false;
              recordSuccess();
              console.log(`[LabSupervisor] Lab process became healthy via poll on port ${labPort}`);
              resolveReady();
              return;
            }
            await new Promise(r => setTimeout(r, HEALTH_POLL_INTERVAL));
          }
          if (!resolved) {
            spawnInFlight = false;
            try { spawnedChild.kill("SIGKILL"); } catch {}
            recordFailure();
            rejectReady(new Error("Lab child process health poll timeout"));
          }
        };
        poll();
      }, READY_TIMEOUT);

      spawnedChild.on("error", (err) => {
        console.log(`[LabSupervisor] Child process error: ${err.message}`);
      });

      spawnedChild.on("message", (msg: any) => {
        if (msg?.type === "ready") {
          clearTimeout(readyTimeout);
          labPort = msg.port || labPort;
          isReady = true;
          restartCount = 0;
          spawnInFlight = false;
          recordSuccess();
          console.log(`[LabSupervisor] Lab process ready on port ${labPort} (pid: ${spawnedChild.pid})`);
          spawnedChild.unref();
          try { spawnedChild.disconnect?.(); } catch {}
          resolveReady();
        }
      });

      spawnedChild.on("exit", (code, signal) => {
        isReady = false;
        clearTimeout(readyTimeout);
        console.log(`[LabSupervisor] Lab process exited (code: ${code}, signal: ${signal})`);
        removePidFile();

        const isCurrentChild = child === spawnedChild;
        child = null;
        ownsChild = false;
        spawnInFlight = false;

        if (!shuttingDown && isCurrentChild) {
          const canRetry = recordFailure();
          if (!canRetry || backoffSuspended) {
            return;
          }
          const delay = getRestartDelay();
          restartCount++;
          console.log(`[LabSupervisor] Restarting in ${Math.round(delay)}ms (attempt ${restartCount}, failures: ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
          if (pendingAutoRestartTimer) clearTimeout(pendingAutoRestartTimer);
          pendingAutoRestartTimer = setTimeout(() => {
            pendingAutoRestartTimer = null;
            // Skip if a healthy child already exists (e.g. manual restart raced us)
            if (shuttingDown || spawnInFlight || backoffSuspended) return;
            if (child || isReady) {
              console.log(`[LabSupervisor] Auto-restart skipped: child already healthy (manual restart likely raced)`);
              return;
            }
            spawnAndWaitForReady().catch((err) => {
              console.error(`[LabSupervisor] Failed to restart lab: ${err.message}`);
            });
          }, delay);
        }
      });

      spawnedChild.on("error", (err) => {
        console.error(`[LabSupervisor] Child process error: ${err.message}`);
        clearTimeout(readyTimeout);
        spawnInFlight = false;
        rejectReady(err);
      });
    });
  }

  async function killCurrentChild(graceMs = 5000): Promise<void> {
    const target = child;
    // Detach from module-level `child` so the existing "exit" handler's
    // `isCurrentChild` check is false and it does NOT schedule an auto-restart
    // that would race with our manual respawn.
    child = null;
    ownsChild = false;

    if (!target) {
      const stalePid = readPidFile();
      if (stalePid) {
        try { process.kill(stalePid, "SIGTERM"); } catch {}
        await new Promise((r) => setTimeout(r, graceMs));
        try { process.kill(stalePid, "SIGKILL"); } catch {}
        removePidFile();
      }
      return;
    }
    await new Promise<void>((resolveKill) => {
      let exited = false;
      const onExit = () => {
        exited = true;
        resolveKill();
      };
      target.once("exit", onExit);
      try { target.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        if (!exited) {
          try { target.kill("SIGKILL"); } catch {}
          setTimeout(() => {
            if (!exited) resolveKill();
          }, 1000);
        }
      }, graceMs);
    });
  }

  async function requestManualRestart(): Promise<{ newPid: number | null }> {
    if (shuttingDown) {
      throw new Error("Supervisor is shutting down");
    }
    console.log(`[LabSupervisor] Manual restart requested by admin`);

    if (suspensionTimer) {
      clearTimeout(suspensionTimer);
      suspensionTimer = null;
    }
    if (pendingAutoRestartTimer) {
      clearTimeout(pendingAutoRestartTimer);
      pendingAutoRestartTimer = null;
    }
    backoffSuspended = false;
    consecutiveFailures = 0;
    firstFailureTime = 0;
    restartCount = 0;
    consecutiveHealthFailures = 0;

    await killCurrentChild(5000);

    // The child's "exit" handler may have scheduled an auto-restart between
    // our kill signal and now. Clear it again so it can't race our respawn.
    if (pendingAutoRestartTimer) {
      clearTimeout(pendingAutoRestartTimer);
      pendingAutoRestartTimer = null;
    }
    consecutiveFailures = 0;
    restartCount = 0;

    isReady = false;
    child = null;
    ownsChild = false;
    spawnInFlight = false;
    removePidFile();

    await spawnAndWaitForReady();
    if (!healthTimer) startHealthCheck();
    const newChild = child as ChildProcess | null;
    return { newPid: newChild?.pid ?? null };
  }

  const supervisor: LabSupervisor = {
    get labPort() {
      return labPort;
    },
    get isReady() {
      return isReady;
    },
    requestManualRestart,
    getStatus(): LabSupervisorStatus {
      return {
        pid: child?.pid ?? readPidFile() ?? null,
        isReady,
        restartCount,
        consecutiveFailures,
        suspended: backoffSuspended,
        labPort,
      };
    },
    async start() {
      shuttingDown = false;

      const existingPid = readPidFile();
      if (existingPid) {
        const healthy = await probeHealth(labPort);
        if (healthy) {
          isReady = true;
          ownsChild = false;
          console.log(`[LabSupervisor] Connected to existing lab process (pid: ${existingPid}, port: ${labPort})`);
          startHealthCheck();
          return;
        }
        console.log(`[LabSupervisor] Stale PID file found (pid: ${existingPid}), spawning fresh`);
        removePidFile();
      }

      await spawnAndWaitForReady();
      startHealthCheck();
    },
    async shutdown() {
      shuttingDown = true;
      if (healthTimer) {
        clearInterval(healthTimer);
        healthTimer = null;
      }
      if (suspensionTimer) {
        clearTimeout(suspensionTimer);
        suspensionTimer = null;
      }
      if (pendingAutoRestartTimer) {
        clearTimeout(pendingAutoRestartTimer);
        pendingAutoRestartTimer = null;
      }
      isReady = false;
      child = null;
      ownsChild = false;
    },
  };

  return supervisor;
}

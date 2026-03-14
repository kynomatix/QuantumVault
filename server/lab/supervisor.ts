import { spawn, type ChildProcess } from "child_process";
import { resolve, dirname } from "path";
import { createHash } from "crypto";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";

export interface LabSupervisor {
  labPort: number;
  isReady: boolean;
  start(): Promise<void>;
  shutdown(): Promise<void>;
}

const LAB_PORT = 5050;
const PID_FILE = "/tmp/quantumlab.pid";
const MIN_RESTART_DELAY = 1000;
const MAX_RESTART_DELAY = 30000;
const HEALTH_CHECK_INTERVAL = 15000;
const READY_TIMEOUT = 20000;

function deriveLabAuthSecret(): string {
  const base = process.env.SESSION_SECRET || "quantum-vault-secret-change-in-production";
  return createHash("sha256").update(`lab-auth:${base}`).digest("hex");
}

const LAB_AUTH_SECRET = deriveLabAuthSecret();

export function getLabAuthSecret(): string {
  return LAB_AUTH_SECRET;
}

async function probeHealth(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
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

  function getRestartDelay(): number {
    const base = Math.min(MIN_RESTART_DELAY * Math.pow(2, restartCount), MAX_RESTART_DELAY);
    const jitter = Math.random() * base * 0.3;
    return base + jitter;
  }

  let consecutiveHealthFailures = 0;
  const MAX_HEALTH_FAILURES = 3;

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
          if (ownsChild && child) {
            console.log(`[LabSupervisor] Health check failed ${MAX_HEALTH_FAILURES} times, killing child for restart`);
            try { child.kill("SIGKILL"); } catch {}
          } else if (!ownsChild) {
            console.log(`[LabSupervisor] Existing lab process unreachable, spawning new one`);
            spawnAndWaitForReady().catch((err) => {
              console.error(`[LabSupervisor] Failed to spawn new lab: ${err.message}`);
            });
          }
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  function spawnAndWaitForReady(): Promise<void> {
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
      };

      const args = isProd ? [entryPath] : ["--import", "tsx", entryPath];

      child = spawn("node", args, {
        env,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        detached: true,
      });

      ownsChild = true;

      if (child.pid) {
        writePidFile(child.pid);
        console.log(`[LabSupervisor] Spawned lab process (pid: ${child.pid})`);
      }

      const readyTimeout = setTimeout(() => {
        console.log(`[LabSupervisor] Child did not send ready within ${READY_TIMEOUT}ms, falling back to health poll`);
        child?.unref();
        try { child?.disconnect?.(); } catch {}
        rejectReady(new Error("Lab child process IPC ready timeout"));
      }, READY_TIMEOUT);

      child.on("message", (msg: any) => {
        if (msg?.type === "ready") {
          clearTimeout(readyTimeout);
          labPort = msg.port || labPort;
          isReady = true;
          restartCount = 0;
          console.log(`[LabSupervisor] Lab process ready on port ${labPort} (pid: ${child?.pid})`);
          child?.unref();
          try { child?.disconnect?.(); } catch {}
          resolveReady();
        }
      });

      child.on("exit", (code, signal) => {
        isReady = false;
        clearTimeout(readyTimeout);
        console.log(`[LabSupervisor] Lab process exited (code: ${code}, signal: ${signal})`);
        removePidFile();
        child = null;
        ownsChild = false;

        if (!shuttingDown) {
          const delay = getRestartDelay();
          restartCount++;
          console.log(`[LabSupervisor] Restarting in ${Math.round(delay)}ms (attempt ${restartCount})`);
          setTimeout(() => {
            if (!shuttingDown) {
              spawnAndWaitForReady().catch((err) => {
                console.error(`[LabSupervisor] Failed to restart lab: ${err.message}`);
              });
            }
          }, delay);
        }
      });

      child.on("error", (err) => {
        console.error(`[LabSupervisor] Child process error: ${err.message}`);
        clearTimeout(readyTimeout);
        rejectReady(err);
      });
    });
  }

  const supervisor: LabSupervisor = {
    get labPort() {
      return labPort;
    },
    get isReady() {
      return isReady;
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
      isReady = false;
      child = null;
      ownsChild = false;
    },
  };

  return supervisor;
}

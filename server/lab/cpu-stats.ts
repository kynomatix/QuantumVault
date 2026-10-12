/** Child-only CPU accounting, including import/startup CPU in the first line. */
export function startLabCpuStats(): () => void {
  let previousTime = 0;
  let previousCpu = { user: 0, system: 0 };
  const emit = (phase: "loaded" | "interval") => {
    try {
      const now = process.uptime() * 1000;
      const cpu = process.cpuUsage();
      const intervalMs = now - previousTime;
      const userMs = (cpu.user - previousCpu.user) / 1000;
      const systemMs = (cpu.system - previousCpu.system) / 1000;
      previousTime = now;
      previousCpu = cpu;
      console.log(`[LabCpu] pid=${process.pid} phase=${phase} uptime=${Math.round(now)}ms interval=${Math.round(intervalMs)}ms cpu_user=${Math.round(userMs)}ms cpu_system=${Math.round(systemMs)}ms cpu=${((userMs + systemMs) / Math.max(intervalMs, 1) * 100).toFixed(1)}%`);
    } catch { /* Observability must not affect the child. */ }
  };
  emit("loaded");
  const timer = setInterval(() => emit("interval"), 60_000);
  timer.unref();
  return () => clearInterval(timer);
}

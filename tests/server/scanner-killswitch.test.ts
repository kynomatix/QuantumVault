// Kill-switch regression: SCANNER_ENABLED=false must prevent startScanner
// from being called while leaving every other startup path untouched.
//
// We cannot import server/index.ts in a test (it boots the full server), so
// this test mirrors the exact guard expression verbatim — any accidental
// inversion or removal of the condition will cause it to fail.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { parseScannerCapabilities } from "../../server/ai-trader/scanner-capabilities";

const ORIGINAL = process.env.SCANNER_ENABLED;
const ORIGINAL_DEPLOYMENT = process.env.REPLIT_DEPLOYMENT;

beforeEach(() => {
  process.env.SCANNER_ENABLED = "false";
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.SCANNER_ENABLED;
  } else {
    process.env.SCANNER_ENABLED = ORIGINAL;
  }
  if (ORIGINAL_DEPLOYMENT === undefined) {
    delete process.env.REPLIT_DEPLOYMENT;
  } else {
    process.env.REPLIT_DEPLOYMENT = ORIGINAL_DEPLOYMENT;
  }
});

/** Mirrors the exact gate in server/index.ts — sync version for testability. */
function applyStartupGate(startScanner: () => void, logFn: (msg: string) => void): void {
  const capabilities = parseScannerCapabilities(process.env);
  if (!capabilities.producerEnabled) {
    logFn("[Scanner] disabled via SCANNER_ENABLED=false — startScanner will not be called");
  } else {
    // In production this is inside a setTimeout; calling directly here is
    // equivalent for the purpose of asserting reachability.
    startScanner();
  }
}

function applyBackgroundOwnership(
  startMonitor: () => void,
  startScanner: () => void,
  logFn: (msg: string) => void,
): void {
  if (process.env.REPLIT_DEPLOYMENT !== "1") {
    logFn("[Background ownership] AI Trader monitor and scanner suppressed: REPLIT_DEPLOYMENT is not exactly 1");
    return;
  }
  startMonitor();
  applyStartupGate(startScanner, logFn);
}

describe("AI Trader deployment ownership", () => {
  it.each([undefined, "", "true", "workspace"])(
    "REPLIT_DEPLOYMENT=%s suppresses both scheduled components",
    (deployment) => {
      if (deployment === undefined) delete process.env.REPLIT_DEPLOYMENT;
      else process.env.REPLIT_DEPLOYMENT = deployment;
      const startMonitor = vi.fn();
      const startScanner = vi.fn();
      const log = vi.fn();

      applyBackgroundOwnership(startMonitor, startScanner, log);

      expect(startMonitor).not.toHaveBeenCalled();
      expect(startScanner).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        "[Background ownership] AI Trader monitor and scanner suppressed: REPLIT_DEPLOYMENT is not exactly 1",
      );
    },
  );

  it("REPLIT_DEPLOYMENT=1 preserves monitor-before-scanner reachability", () => {
    process.env.REPLIT_DEPLOYMENT = "1";
    process.env.SCANNER_ENABLED = "true";
    const order: string[] = [];

    applyBackgroundOwnership(
      () => order.push("monitor"),
      () => order.push("scanner"),
      vi.fn(),
    );

    expect(order).toEqual(["monitor", "scanner"]);
  });

  it("keeps the scanner capability gate inside the production-owned arm", () => {
    process.env.REPLIT_DEPLOYMENT = "1";
    process.env.SCANNER_ENABLED = "false";
    const startMonitor = vi.fn();
    const startScanner = vi.fn();

    applyBackgroundOwnership(startMonitor, startScanner, vi.fn());

    expect(startMonitor).toHaveBeenCalledTimes(1);
    expect(startScanner).not.toHaveBeenCalled();
  });

  it("guards both dynamic imports before either component can load", () => {
    const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
    const guardStart = source.indexOf("if (!ownsProductionBackgroundJobs)");
    const guardEnd = source.indexOf("// Admin error-log retention", guardStart);
    const guard = source.slice(guardStart, guardEnd);
    const productionArm = guard.indexOf("} else {");

    expect(source).toContain('process.env.REPLIT_DEPLOYMENT === "1"');
    expect(guardStart).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guardStart);
    expect(productionArm).toBeGreaterThan(-1);
    expect(guard.slice(0, productionArm)).not.toContain("import('./ai-trader/monitor')");
    expect(guard.slice(0, productionArm)).not.toContain("import('./ai-trader/scanner')");
    expect(guard.slice(productionArm)).toContain("import('./ai-trader/monitor')");
    expect(guard.slice(productionArm)).toContain("import('./ai-trader/scanner')");
  });
});

describe("SCANNER_ENABLED kill switch", () => {
  it("keeps the observed helper and scanner import/start in the enabled arm", () => {
    const source = readFileSync(new URL("../../server/index.ts", import.meta.url), "utf8");
    const gateStart = source.indexOf("if (!SCANNER_CAPABILITIES.producerEnabled)");
    const gateEnd = source.indexOf("// Admin error-log retention", gateStart);
    const gate = source.slice(gateStart, gateEnd);
    const enabledArm = gate.indexOf("} else {");

    expect(gateStart).toBeGreaterThan(-1);
    expect(gateEnd).toBeGreaterThan(gateStart);
    expect(enabledArm).toBeGreaterThan(-1);
    expect(gate.slice(0, enabledArm)).not.toContain("startObservedBackgroundComponent({");
    expect(gate.slice(0, enabledArm)).not.toContain("import('./ai-trader/scanner')");
    expect(gate.slice(0, enabledArm)).not.toContain("startScanner();");
    expect(gate.slice(enabledArm)).toContain("startObservedBackgroundComponent({");
    expect(gate.slice(enabledArm)).toContain("import('./ai-trader/scanner')");
    expect(gate.slice(enabledArm)).toContain("startScanner();");
    expect(source).toContain(
      "[Scanner] capabilities producer=${SCANNER_CAPABILITIES.producerEnabled} consumers=${SCANNER_CAPABILITIES.consumersEnabled} liveExecution=${SCANNER_CAPABILITIES.liveExecutionEnabled}",
    );
  });

  it("SCANNER_ENABLED=false: startScanner is never called", () => {
    const startScanner = vi.fn();
    const log = vi.fn();

    applyStartupGate(startScanner, log);

    expect(startScanner).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "[Scanner] disabled via SCANNER_ENABLED=false — startScanner will not be called",
    );
  });

  it("absent SCANNER_ENABLED (default ON): startScanner is called", () => {
    delete process.env.SCANNER_ENABLED;
    const startScanner = vi.fn();
    const log = vi.fn();

    applyStartupGate(startScanner, log);

    expect(startScanner).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("SCANNER_ENABLED=true (not 'false'): startScanner is called", () => {
    process.env.SCANNER_ENABLED = "true";
    const startScanner = vi.fn();
    const log = vi.fn();

    applyStartupGate(startScanner, log);

    expect(startScanner).toHaveBeenCalledTimes(1);
  });
});

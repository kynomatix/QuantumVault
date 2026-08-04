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

beforeEach(() => {
  process.env.SCANNER_ENABLED = "false";
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.SCANNER_ENABLED;
  } else {
    process.env.SCANNER_ENABLED = ORIGINAL;
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

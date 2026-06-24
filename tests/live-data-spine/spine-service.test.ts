import { describe, it, expect, afterEach } from "vitest";
import {
  pacificaMapSymbol,
  countStaleSymbols,
  topBasisDeviations,
  isLiveDataSpineEnabled,
  initLiveDataSpine,
  getLiveDataSpineStatus,
  stopLiveDataSpine,
} from "../../server/live-data-spine/spine-service";
import type { SymbolStatus } from "../../server/live-data-spine/types";

function status(over: Partial<SymbolStatus>): SymbolStatus {
  return {
    venue: "pacifica",
    internalSymbol: "SOL-PERP",
    latest: null,
    lastSeenAt: null,
    ageMs: null,
    tickCount: 0,
    basis: null,
    ...over,
  };
}

describe("pacificaMapSymbol", () => {
  it("appends -PERP and uppercases", () => {
    expect(pacificaMapSymbol("sol")).toBe("SOL-PERP");
    expect(pacificaMapSymbol("BTC")).toBe("BTC-PERP");
  });
  it("handles kBONK/kPEPE special cases", () => {
    expect(pacificaMapSymbol("kBONK")).toBe("1MBONK-PERP");
    expect(pacificaMapSymbol("kPEPE")).toBe("1MPEPE-PERP");
  });
});

describe("countStaleSymbols", () => {
  it("counts only symbols older than the threshold", () => {
    const now = 10_000;
    const statuses = [
      status({ internalSymbol: "A", lastSeenAt: 9_000 }), // 1s old -> fresh
      status({ internalSymbol: "B", lastSeenAt: 1_000 }), // 9s old -> stale at 5s
      status({ internalSymbol: "C", lastSeenAt: null }), // never seen -> not counted
    ];
    expect(countStaleSymbols(statuses, 5_000, now)).toBe(1);
  });
});

describe("topBasisDeviations", () => {
  it("returns worst-N by p99 descending, skipping symbols without basis", () => {
    const statuses = [
      status({ internalSymbol: "A", basis: { count: 5, min: 0, max: 0.02, mean: 0.01, p50: 0.01, p95: 0.018, p99: 0.02 } }),
      status({ internalSymbol: "B", basis: { count: 5, min: 0, max: 0.05, mean: 0.03, p50: 0.03, p95: 0.045, p99: 0.05 } }),
      status({ internalSymbol: "C", basis: null }),
    ];
    const top = topBasisDeviations(statuses, 1);
    expect(top).toHaveLength(1);
    expect(top[0].internalSymbol).toBe("B");
  });

  it("returns empty when nothing has basis", () => {
    expect(topBasisDeviations([status({})], 5)).toEqual([]);
  });
});

describe("init gating (SPINE_ENABLED off)", () => {
  const original = process.env.SPINE_ENABLED;
  afterEach(() => {
    stopLiveDataSpine();
    if (original === undefined) delete process.env.SPINE_ENABLED;
    else process.env.SPINE_ENABLED = original;
  });

  it("is a no-op when the flag is not set", () => {
    delete process.env.SPINE_ENABLED;
    expect(isLiveDataSpineEnabled()).toBe(false);
    initLiveDataSpine();
    expect(getLiveDataSpineStatus().running).toBe(false);
  });
});

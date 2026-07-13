// Unit tests for server/ai-trader/calibration.ts
// Covers: bucket assignment, confidence-precedence rule, empty buckets,
// win rate, avgRealizedPnlUsd, avgRiskPct (risk_based only).
import { describe, it, expect } from "vitest";
import {
  computeConfidenceCalibration,
  getConfidenceBucketLabel,
  CONFIDENCE_BUCKETS,
  type CalibrationRow,
} from "../../server/ai-trader/calibration";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<CalibrationRow> & { conf?: number; clampedConf?: number } = {}): CalibrationRow {
  const { conf, clampedConf, ...rest } = overrides;
  return {
    rawDecision: conf !== undefined ? { confidence: conf } : null,
    clampedDecision: clampedConf !== undefined ? { confidence: clampedConf } : null,
    realizedPnl: "0",
    ...rest,
  };
}

function makeRiskRow(conf: number, riskPct: number, pnl: number): CalibrationRow {
  return {
    rawDecision: { confidence: conf },
    clampedDecision: { confidence: conf, sizingMode: "risk_based", riskPct },
    realizedPnl: String(pnl),
  };
}

// ---------------------------------------------------------------------------
// getConfidenceBucketLabel — boundary tests
// ---------------------------------------------------------------------------

describe("getConfidenceBucketLabel", () => {
  it("maps confidence 1 → 1–2", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 1 }))).toBe("1–2");
  });
  it("maps confidence 2 → 1–2", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 2 }))).toBe("1–2");
  });
  it("maps confidence 3 → 3–4", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 3 }))).toBe("3–4");
  });
  it("maps confidence 4 → 3–4", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 4 }))).toBe("3–4");
  });
  it("maps confidence 5 → 5–6", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 5 }))).toBe("5–6");
  });
  it("maps confidence 6 → 5–6", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 6 }))).toBe("5–6");
  });
  it("maps confidence 7 → 7–8", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 7 }))).toBe("7–8");
  });
  it("maps confidence 8 → 7–8", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 8 }))).toBe("7–8");
  });
  it("maps confidence 9 → 9–10", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 9 }))).toBe("9–10");
  });
  it("maps confidence 10 → 9–10", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 10 }))).toBe("9–10");
  });

  it("returns null for confidence 0 (below range)", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 0 }))).toBeNull();
  });
  it("returns null for confidence 11 (above range)", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 11 }))).toBeNull();
  });
  it("returns null when both decisions are null", () => {
    expect(getConfidenceBucketLabel({ rawDecision: null, clampedDecision: null, realizedPnl: null })).toBeNull();
  });
  it("returns null when confidence is a non-finite float", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: NaN }))).toBeNull();
  });
  it("rounds a near-integer float (e.g. 6.9 → 7 → 7–8)", () => {
    expect(getConfidenceBucketLabel(makeRow({ conf: 6.9 }))).toBe("7–8");
  });
});

// ---------------------------------------------------------------------------
// Confidence-precedence rule
// ---------------------------------------------------------------------------

describe("confidence precedence (clampedDecision over rawDecision)", () => {
  it("uses clampedDecision.confidence when both are set", () => {
    const row = makeRow({ clampedConf: 9, conf: 3 });
    // clamped=9 → bucket "9–10"; raw=3 → "3–4"; clamped must win
    expect(getConfidenceBucketLabel(row)).toBe("9–10");
  });

  it("falls back to rawDecision.confidence when clampedDecision has no confidence", () => {
    const row: CalibrationRow = {
      rawDecision: { confidence: 7 },
      clampedDecision: { sizingMode: "risk_based", riskPct: 1.0 }, // no confidence field
      realizedPnl: "5",
    };
    expect(getConfidenceBucketLabel(row)).toBe("7–8");
  });

  it("falls back to rawDecision when clampedDecision is null", () => {
    const row: CalibrationRow = {
      rawDecision: { confidence: 5 },
      clampedDecision: null,
      realizedPnl: "0",
    };
    expect(getConfidenceBucketLabel(row)).toBe("5–6");
  });

  it("returns null when only rawDecision is null and clamped has no confidence", () => {
    const row: CalibrationRow = {
      rawDecision: null,
      clampedDecision: { sizingMode: "discretionary" },
      realizedPnl: "0",
    };
    expect(getConfidenceBucketLabel(row)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeConfidenceCalibration — structure
// ---------------------------------------------------------------------------

describe("computeConfidenceCalibration — output shape", () => {
  it("always returns exactly 5 buckets in order", () => {
    const result = computeConfidenceCalibration([]);
    expect(result).toHaveLength(5);
    expect(result.map((b) => b.bucket)).toEqual(["1–2", "3–4", "5–6", "7–8", "9–10"]);
  });

  it("all-empty input → all nulls (trades=0, winRate=null, avgPnl=null, avgRisk=null)", () => {
    const result = computeConfidenceCalibration([]);
    for (const b of result) {
      expect(b.trades).toBe(0);
      expect(b.winRate).toBeNull();
      expect(b.avgRealizedPnlUsd).toBeNull();
      expect(b.avgRiskPct).toBeNull();
    }
  });

  it("rows with out-of-range confidence are silently skipped", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 0 }, clampedDecision: null, realizedPnl: "10" },
      { rawDecision: { confidence: 11 }, clampedDecision: null, realizedPnl: "10" },
      { rawDecision: null, clampedDecision: null, realizedPnl: "10" },
    ];
    const result = computeConfidenceCalibration(rows);
    expect(result.every((b) => b.trades === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeConfidenceCalibration — bucket math
// ---------------------------------------------------------------------------

describe("computeConfidenceCalibration — per-bucket math", () => {
  it("counts trades and wins correctly", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 8 }, clampedDecision: null, realizedPnl: "5" },   // win
      { rawDecision: { confidence: 7 }, clampedDecision: null, realizedPnl: "-2" },  // loss
      { rawDecision: { confidence: 7 }, clampedDecision: null, realizedPnl: "3" },   // win
    ];
    const result = computeConfidenceCalibration(rows);
    const b78 = result.find((b) => b.bucket === "7–8")!;
    expect(b78.trades).toBe(3);
    expect(b78.winRate).toBeCloseTo((2 / 3) * 100);
    expect(b78.avgRealizedPnlUsd).toBeCloseTo((5 - 2 + 3) / 3);
  });

  it("winRate is 100 when all trades are wins", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 10 }, clampedDecision: null, realizedPnl: "10" },
      { rawDecision: { confidence: 9 }, clampedDecision: null, realizedPnl: "20" },
    ];
    const b = computeConfidenceCalibration(rows).find((b) => b.bucket === "9–10")!;
    expect(b.winRate).toBe(100);
  });

  it("winRate is 0 when all trades are losses", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 2 }, clampedDecision: null, realizedPnl: "-5" },
    ];
    const b = computeConfidenceCalibration(rows).find((b) => b.bucket === "1–2")!;
    expect(b.winRate).toBe(0);
  });

  it("treats realizedPnl=0 as a loss for win-rate purposes (not >0)", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 4 }, clampedDecision: null, realizedPnl: "0" },
    ];
    const b = computeConfidenceCalibration(rows).find((b) => b.bucket === "3–4")!;
    expect(b.winRate).toBe(0);
  });

  it("avgRealizedPnlUsd averages across both positive and negative values", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 6 }, clampedDecision: null, realizedPnl: "10" },
      { rawDecision: { confidence: 5 }, clampedDecision: null, realizedPnl: "-4" },
    ];
    const b = computeConfidenceCalibration(rows).find((b) => b.bucket === "5–6")!;
    expect(b.avgRealizedPnlUsd).toBeCloseTo(3); // (10 + -4) / 2
  });

  it("other buckets remain zeroed when only one bucket has data", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 1 }, clampedDecision: null, realizedPnl: "5" },
    ];
    const result = computeConfidenceCalibration(rows);
    for (const b of result.filter((b) => b.bucket !== "1–2")) {
      expect(b.trades).toBe(0);
      expect(b.winRate).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// avgRiskPct — risk_based rows only
// ---------------------------------------------------------------------------

describe("avgRiskPct — risk_based rows only", () => {
  it("avgRiskPct is null when no risk_based rows in bucket", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 8 }, clampedDecision: { confidence: 8, sizingMode: "discretionary" }, realizedPnl: "5" },
    ];
    const b = computeConfidenceCalibration(rows).find((b) => b.bucket === "7–8")!;
    expect(b.avgRiskPct).toBeNull();
  });

  it("avgRiskPct averages only risk_based rows, ignoring discretionary", () => {
    const rows: CalibrationRow[] = [
      makeRiskRow(7, 1.0, 5),   // risk_based: riskPct=1.0
      makeRiskRow(8, 1.5, -2),  // risk_based: riskPct=1.5
      // discretionary row in the same bucket:
      { rawDecision: { confidence: 7 }, clampedDecision: { confidence: 7, sizingMode: "discretionary" }, realizedPnl: "3" },
    ];
    const b = computeConfidenceCalibration(rows).find((b) => b.bucket === "7–8")!;
    expect(b.trades).toBe(3);
    expect(b.avgRiskPct).toBeCloseTo(1.25); // (1.0 + 1.5) / 2 only
  });

  it("avgRiskPct works when clampedDecision is null (no riskPct → excluded)", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 3 }, clampedDecision: null, realizedPnl: "2" },
    ];
    const b = computeConfidenceCalibration(rows).find((b) => b.bucket === "3–4")!;
    expect(b.avgRiskPct).toBeNull();
  });

  it("excludes riskPct if it is not a finite number", () => {
    const rows: CalibrationRow[] = [
      { rawDecision: { confidence: 9 }, clampedDecision: { confidence: 9, sizingMode: "risk_based", riskPct: NaN }, realizedPnl: "1" },
    ];
    const b = computeConfidenceCalibration(rows).find((b) => b.bucket === "9–10")!;
    expect(b.avgRiskPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CONFIDENCE_BUCKETS export — sanity
// ---------------------------------------------------------------------------

describe("CONFIDENCE_BUCKETS constant", () => {
  it("has 5 buckets covering 1–10 with no gaps", () => {
    expect(CONFIDENCE_BUCKETS).toHaveLength(5);
    let expected = 1;
    for (const b of CONFIDENCE_BUCKETS) {
      expect(b.min).toBe(expected);
      expect(b.max).toBe(expected + 1);
      expected += 2;
    }
  });
});

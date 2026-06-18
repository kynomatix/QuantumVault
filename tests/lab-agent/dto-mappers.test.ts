import { describe, it, expect } from "vitest";
import type {
  LabOptimizationRun,
  LabOptResult,
  LabStrategy,
  LabInsightsReport,
  LabOosMetrics,
} from "@shared/schema";
import {
  runStatusDtoSchema,
  backtestResultDtoSchema,
  topResultsDtoSchema,
  oosSummaryDtoSchema,
  strategyDtoSchema,
  strategyMatchDtoSchema,
  queuePositionDtoSchema,
  insightsReportDtoSchema,
  heatmapDtoSchema,
} from "@shared/lab-agent-contract";
import {
  mapRunStatusFromDb,
  mapJobProgressStatus,
  mapStage,
  sanitizeErrorReason,
  toRunStatusDto,
  toOosSummaryDto,
  toBacktestResultDto,
  toTopResultsDto,
  toStrategyDto,
  toStrategyMatchDto,
  toQueuePositionDto,
  toInsightsReportDto,
  toHeatmapDto,
  MAX_HEATMAP_CELLS,
} from "../../server/lab-agent/dto-mappers";

// --- factories ------------------------------------------------------------

function makeRun(overrides: Partial<LabOptimizationRun> = {}): LabOptimizationRun {
  return {
    id: 1,
    userId: "wallet1",
    strategyId: 10,
    tickers: ["BTC"],
    timeframes: ["1h"],
    startDate: "2026-01-01",
    endDate: "2026-02-01",
    randomSamples: 100,
    topK: 5,
    refinementsPerSeed: 3,
    minTrades: 10,
    maxDrawdownCap: 50,
    mode: "sweep",
    status: "running",
    totalConfigsTested: 42,
    checkpoint: null,
    queueOrder: null,
    configSnapshot: null,
    oosFraction: null,
    slippage: null,
    parityMatch: null,
    parityDiffs: null,
    agentTaskId: null,
    agentIdempotencyKey: null,
    agentCorrelationId: null,
    agentOwned: false,
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
    completedAt: null,
    ...overrides,
  } as LabOptimizationRun;
}

function makeResult(overrides: Partial<LabOptResult> = {}): LabOptResult {
  return {
    id: 1,
    runId: 7,
    ticker: "BTC",
    timeframe: "1h",
    rank: 1,
    netProfitPercent: 12.5,
    winRatePercent: 55,
    maxDrawdownPercent: 8,
    profitFactor: 1.8,
    totalTrades: 30,
    params: { len: 14, src: "close" },
    trades: [{ entryTime: "x" }],
    equityCurve: [{ time: "x", equity: 1 }],
    sharpeRatio: 1.2,
    isMetrics: null,
    oosMetrics: null,
    ...overrides,
  } as LabOptResult;
}

const sufficientOos: LabOosMetrics = {
  netProfitPercent: 5,
  winRatePercent: 52,
  maxDrawdownPercent: 6,
  profitFactor: 1.4,
  totalTrades: 12,
  sharpeRatio: 0.9,
  sufficient: true,
};

// --- status mapping -------------------------------------------------------

describe("mapRunStatusFromDb", () => {
  it("maps known DB statuses onto the stable enum", () => {
    expect(mapRunStatusFromDb("queued")).toBe("queued");
    expect(mapRunStatusFromDb("running")).toBe("running");
    expect(mapRunStatusFromDb("paused")).toBe("paused");
    expect(mapRunStatusFromDb("complete")).toBe("completed");
    expect(mapRunStatusFromDb("failed")).toBe("failed");
  });

  it("reports a user-cancelled failed run as cancelled", () => {
    expect(mapRunStatusFromDb("failed", { userCancelled: true } as any)).toBe("cancelled");
  });

  it("fails safe (terminal) on an unknown internal status, never leaking it", () => {
    expect(mapRunStatusFromDb("some_new_internal_state")).toBe("failed");
  });
});

describe("mapJobProgressStatus", () => {
  it("collapses in-flight stages to running", () => {
    for (const s of ["fetching", "baseline", "random_search", "refinement", "retrying"] as const) {
      expect(mapJobProgressStatus({ status: s, stage: "" })).toBe("running");
    }
  });
  it("maps complete and error", () => {
    expect(mapJobProgressStatus({ status: "complete", stage: "" })).toBe("completed");
    expect(mapJobProgressStatus({ status: "error", stage: "boom" })).toBe("failed");
    expect(mapJobProgressStatus({ status: "error", stage: "Cancelled by user" })).toBe("cancelled");
  });
});

describe("mapStage", () => {
  it("prefers the checkpoint's exact stage", () => {
    expect(mapStage({ currentStage: "deep" } as any, { status: "refinement" })).toBe("deep");
    expect(mapStage({ currentStage: "coordinate" } as any, null)).toBe("coordinate");
  });
  it("falls back to the job status, else null", () => {
    expect(mapStage(null, { status: "random_search" })).toBe("random");
    expect(mapStage(null, { status: "refinement" })).toBe("refine");
    expect(mapStage(null, { status: "fetching" })).toBeNull();
    expect(mapStage(null, null)).toBeNull();
  });
});

describe("sanitizeErrorReason", () => {
  it("returns null for empty input", () => {
    expect(sanitizeErrorReason(null)).toBeNull();
    expect(sanitizeErrorReason("")).toBeNull();
  });
  it("keeps only the first line and strips stack frames", () => {
    const raw = "TypeError: bad thing happened\n    at foo (file.ts:1:1)\n    at bar";
    const out = sanitizeErrorReason(raw)!;
    expect(out).toBe("TypeError: bad thing happened");
    expect(out).not.toContain("at foo");
  });
  it("caps length", () => {
    expect(sanitizeErrorReason("x".repeat(500))!.length).toBeLessThanOrEqual(240);
  });
});

// --- run status DTO -------------------------------------------------------

describe("toRunStatusDto", () => {
  it("enriches a running run with live stage/percent and validates", () => {
    const dto = toRunStatusDto(makeRun({ status: "running" }), {
      progress: { status: "random_search", stage: "Random search", percent: 42.6, error: undefined },
    });
    expect(() => runStatusDtoSchema.parse(dto)).not.toThrow();
    expect(dto.status).toBe("running");
    expect(dto.stage).toBe("random");
    expect(dto.progressPct).toBe(43);
    expect(dto.errorReason).toBeNull();
  });

  it("reports queue position only when queued", () => {
    const queued = toRunStatusDto(makeRun({ status: "queued" }), { jobsAhead: 3 });
    expect(queued.jobsAhead).toBe(3);
    expect(queued.progressPct).toBeNull();
    const running = toRunStatusDto(makeRun({ status: "running" }), { jobsAhead: 3 });
    expect(running.jobsAhead).toBeNull();
  });

  it("maps a user-cancelled run to cancelled with no error text", () => {
    const dto = toRunStatusDto(
      makeRun({ status: "failed", checkpoint: { userCancelled: true } as any }),
    );
    expect(() => runStatusDtoSchema.parse(dto)).not.toThrow();
    expect(dto.status).toBe("cancelled");
    expect(dto.errorReason).toBeNull();
  });

  it("gives a failed run a sanitized reason and no live fields", () => {
    const dto = toRunStatusDto(makeRun({ status: "failed" }), {
      progress: { status: "error", stage: "boom", percent: 80, error: "Worker crashed\n  at x" },
    });
    expect(dto.status).toBe("failed");
    expect(dto.stage).toBeNull();
    expect(dto.progressPct).toBeNull();
    expect(dto.errorReason).toBe("Worker crashed");
  });

  it("surfaces completedAt and correlationId for an agent-owned completed run", () => {
    const dto = toRunStatusDto(
      makeRun({
        status: "complete",
        completedAt: new Date("2026-06-02T00:00:00.000Z"),
        agentCorrelationId: "corr-123",
        oosFraction: 0.2,
      }),
    );
    expect(() => runStatusDtoSchema.parse(dto)).not.toThrow();
    expect(dto.status).toBe("completed");
    expect(dto.completedAt).toBe("2026-06-02T00:00:00.000Z");
    expect(dto.correlationId).toBe("corr-123");
    expect(dto.oosFraction).toBe(0.2);
  });
});

// --- OOS summary ----------------------------------------------------------

describe("toOosSummaryDto", () => {
  it("is null when there was no holdout", () => {
    expect(toOosSummaryDto(null, 0.2)).toBeNull();
    expect(toOosSummaryDto(sufficientOos, null)).toBeNull();
    expect(toOosSummaryDto(sufficientOos, 0)).toBeNull();
  });
  it("keeps the fraction but nulls metrics when inconclusive", () => {
    const dto = toOosSummaryDto({ ...sufficientOos, sufficient: false }, 0.2)!;
    expect(() => oosSummaryDtoSchema.parse(dto)).not.toThrow();
    expect(dto.fraction).toBe(0.2);
    expect(dto.netProfitPercent).toBeNull();
    expect(dto.totalTrades).toBeNull();
  });
  it("fills metrics when sufficient", () => {
    const dto = toOosSummaryDto(sufficientOos, 0.25)!;
    expect(() => oosSummaryDtoSchema.parse(dto)).not.toThrow();
    expect(dto.netProfitPercent).toBe(5);
    expect(dto.totalTrades).toBe(12);
  });
});

// --- results --------------------------------------------------------------

describe("toBacktestResultDto", () => {
  it("drops trades/equityCurve and validates", () => {
    const dto = toBacktestResultDto(makeResult(), { oosFraction: null });
    expect(() => backtestResultDtoSchema.parse(dto)).not.toThrow();
    expect(dto).not.toHaveProperty("trades");
    expect(dto).not.toHaveProperty("equityCurve");
    expect(dto.params).toEqual({ len: 14, src: "close" });
    expect(dto.oos).toBeNull();
  });
  it("nulls a missing sharpe and attaches OOS when present", () => {
    const dto = toBacktestResultDto(
      makeResult({ sharpeRatio: null, oosMetrics: sufficientOos }),
      { oosFraction: 0.2 },
    );
    expect(dto.sharpeRatio).toBeNull();
    expect(dto.oos?.netProfitPercent).toBe(5);
  });
  it("derives a suggested leverage from drawdown + ticker cap and the leveraged net profit", () => {
    // BTC cap is 50; floor((100/8)*0.8) = 10, well under the cap.
    const dto = toBacktestResultDto(makeResult(), { oosFraction: null });
    expect(dto.suggestedLeverage).toBe(10);
    // 12.5% net * 10x, rounded to 1dp.
    expect(dto.leveragedNetProfitPercent).toBe(125);
  });
  it("caps the suggested leverage at the ticker's tier max", () => {
    // SOL cap is 20; a tiny 2% drawdown would suggest 40x, so it must clamp to 20.
    const dto = toBacktestResultDto(
      makeResult({ ticker: "SOL", maxDrawdownPercent: 2 }),
      { oosFraction: null },
    );
    expect(dto.suggestedLeverage).toBe(20);
    expect(dto.leveragedNetProfitPercent).toBe(250);
  });
  it("falls back to 1x leverage when drawdown is non-positive", () => {
    const dto = toBacktestResultDto(
      makeResult({ maxDrawdownPercent: 0 }),
      { oosFraction: null },
    );
    expect(dto.suggestedLeverage).toBe(1);
    expect(dto.leveragedNetProfitPercent).toBe(12.5);
  });
});

describe("toTopResultsDto", () => {
  it("labels the ordering honestly as lab_objective and validates", () => {
    const dto = toTopResultsDto(10, 7, [makeResult(), makeResult({ rank: 2 })], { oosFraction: null });
    expect(() => topResultsDtoSchema.parse(dto)).not.toThrow();
    expect(dto.rankedBy).toBe("lab_objective");
    expect(dto.results).toHaveLength(2);
  });
});

// --- strategy / queue / insights / heatmap --------------------------------

function makeStrategy(overrides: Partial<LabStrategy> = {}): LabStrategy {
  return {
    id: 10,
    userId: "wallet1",
    name: "My Strat",
    description: null,
    pineScript: "// pine",
    parsedInputs: [],
    groups: null,
    strategySettings: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  } as LabStrategy;
}

describe("toStrategyDto / toStrategyMatchDto", () => {
  it("validates and carries result flags", () => {
    const dto = toStrategyDto(makeStrategy({ description: "desc" }), { hasResults: true, latestRunId: 7 });
    expect(() => strategyDtoSchema.parse(dto)).not.toThrow();
    expect(dto.hasResults).toBe(true);
    expect(dto.latestRunId).toBe(7);
    expect(dto.createdAt).toBe("2026-05-01T00:00:00.000Z");
  });
  it("clamps match score to 0..1", () => {
    expect(toStrategyMatchDto(makeStrategy(), 1.7).score).toBe(1);
    expect(toStrategyMatchDto(makeStrategy(), -2).score).toBe(0);
    const dto = toStrategyMatchDto(makeStrategy(), 0.42);
    expect(() => strategyMatchDtoSchema.parse(dto)).not.toThrow();
    expect(dto.score).toBe(0.42);
  });
});

describe("toQueuePositionDto", () => {
  it("validates and floors negatives", () => {
    const dto = toQueuePositionDto({ jobsAhead: 2, hasActiveRun: true });
    expect(() => queuePositionDtoSchema.parse(dto)).not.toThrow();
    expect(dto.jobsAhead).toBe(2);
    expect(toQueuePositionDto({ jobsAhead: -5, hasActiveRun: false }).jobsAhead).toBe(0);
  });
});

describe("toInsightsReportDto", () => {
  it("extracts defensively from arbitrary reportData and validates", () => {
    const report = {
      id: 1,
      strategyId: 10,
      reportData: {
        summary: "Looks decent",
        directionalBias: "long",
        paramSensitivity: [
          { param: "len", impact: 0.7 },
          { param: "bad" }, // dropped (no numeric impact)
        ],
      },
      totalResults: 5,
      totalRuns: 1,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    } as LabInsightsReport;
    const dto = toInsightsReportDto(report);
    expect(() => insightsReportDtoSchema.parse(dto)).not.toThrow();
    expect(dto.summary).toBe("Looks decent");
    expect(dto.directionalBias).toBe("long");
    expect(dto.paramSensitivity).toEqual([{ param: "len", impact: 0.7 }]);
  });
  it("tolerates an empty report", () => {
    const dto = toInsightsReportDto({
      id: 2,
      strategyId: 11,
      reportData: {},
      totalResults: null,
      totalRuns: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
    } as LabInsightsReport);
    expect(() => insightsReportDtoSchema.parse(dto)).not.toThrow();
    expect(dto.summary).toBe("");
    expect(dto.paramSensitivity).toBeNull();
  });
});

describe("toHeatmapDto", () => {
  it("caps cells and flags truncation", () => {
    const cells = Array.from({ length: MAX_HEATMAP_CELLS + 50 }, (_, i) => ({ x: i, y: 0, metric: i }));
    const dto = toHeatmapDto({ strategyId: 7, xParam: "len", yParam: "mult", metricName: "netProfit", cells });
    expect(() => heatmapDtoSchema.parse(dto)).not.toThrow();
    expect(dto.cells).toHaveLength(MAX_HEATMAP_CELLS);
    expect(dto.truncated).toBe(true);
  });
  it("does not flag truncation when within bounds", () => {
    const dto = toHeatmapDto({
      strategyId: 7,
      xParam: "len",
      yParam: "mult",
      metricName: "netProfit",
      cells: [{ x: 1, y: 2, metric: 3 }],
    });
    expect(dto.truncated).toBe(false);
  });
});

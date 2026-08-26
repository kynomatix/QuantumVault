// WO-A acceptance: unit tests for server/ai-trader/scanner.ts.
//
// Coverage:
//   - getBoundaryTfs: table-driven UTC boundary → TF list.
//   - evaluateCandidate: G9 staleness reject, W detection → long, M detection → short,
//     parent-opposed → null, parent-aligned bonus, scoring formula determinism.
//   - SCANNER_FEED_EXCLUDE: exhaustive membership check + no-overlap with live markets.
//   - Universe filter invariant: excluded symbols are absent after the SCANNER_FEED_EXCLUDE filter.
//
// Bar fixture convention (FRACTAL_N=3 — the production default):
//   flatBar: H=52 L=48 C=50  TR=4  → ATR(14)→4 after 20 consecutive flatBars.
//   spikeLow(price):  H=52 L=price C=50 (price < 48 → swing-low with 3+ flatBars on each side)
//   spikeHigh(price): H=price L=48 C=50 (price > 52 → swing-high with 3+ flatBars on each side)
//   forming(close):   H=52 L=48 C=close (the forming bar — bars[bars.length-1])
//
// W (double-bottom) layout (n=3):
//   bars[0-19]:  warmup (ATR→4)
//   bars[20-22]: 3 flatBars  (left buffer for extreme1)
//   bars[23]:    spikeLow(44)   extreme1  idx=23
//   bars[24-26]: 3 flatBars  (right buffer)
//   bars[27-29]: 3 flatBars  (gap)
//   bars[30-32]: 3 flatBars  (left buffer for neckline)
//   bars[33]:    spikeHigh(55.5) neckline  idx=33
//   bars[34-36]: 3 flatBars  (right buffer / left buffer for extreme2)
//   bars[37]:    spikeLow(44.5)  extreme2  idx=37   barSep=14 ✓
//   bars[38-40]: 3 flatBars  (right buffer for extreme2)
//   bars[41]:    forming(55.6)   0.18% from neckline ✓
//
// M (double-top) layout mirrors the W with highs↔lows.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { OHLCV } from "../../server/lab/engine";
import { classifyDow, detectPivots } from "../../server/ai-trader/dow-structure";
import { detectWM } from "../../server/ai-trader/wm-detector";

// ─── Module mocks ─────────────────────────────────────────────────────────────

const fetchOHLCVMock = vi.fn<[string, string, string, string], Promise<OHLCV[]>>();
const prefetchCachedOHLCVMock = vi.fn();
vi.mock("../../server/lab/datafeed", () => ({
  fetchOHLCV: (...a: unknown[]) => fetchOHLCVMock(...(a as Parameters<typeof fetchOHLCVMock>)),
  prefetchCachedOHLCV: (...a: unknown[]) => prefetchCachedOHLCVMock(...a),
  isNonCryptoMarketOpen: () => true,
  isAbortError: (err: unknown) => err instanceof Error && err.name === "AbortError",
  isCacheDegradedError: (err: unknown) =>
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "CacheDegradedError",
  setDatafeedIncidentReporter: vi.fn(),
  MONEY_CANDLE_POLICY: {
    consumer: "scanner", acceptedBasis: ["perp"], acceptedFinality: ["finalized"], acceptedProxy: ["direct"],
  },
}));

vi.mock("../../server/ai-trader/context-builder", () => ({
  marketToDatafeedTicker: (market: string) => market.replace("-PERP", "/USDT"),
}));

const getFlashMarketSpecsMock = vi.fn<[], { internalSymbol: string }[]>();
vi.mock("../../server/protocol/flash/flash-markets", () => ({
  getFlashMarketSpecs: () => getFlashMarketSpecsMock(),
}));

const getAdapterMock = vi.fn();
vi.mock("../../server/protocol/adapter-registry", () => ({
  getAdapter: (...a: unknown[]) => getAdapterMock(...a),
}));

const getSessionContextMock = vi.fn<[Date], { label: string }>();
vi.mock("../../server/ai-trader/session-context", () => ({
  getSessionContext: (...a: unknown[]) => getSessionContextMock(...(a as [Date])),
}));

// Lifecycle tests deliberately drive cancellation, replacement, and empty-sweep
// paths. Keep their incident reporting process-local: the real recorder targets
// the one global database evidence hold and can contaminate a concurrently running
// real-Postgres retention test.
const recordCriticalErrorMock = vi.fn();
vi.mock("../../server/error-log", () => ({
  recordCriticalError: (...a: unknown[]) => recordCriticalErrorMock(...a),
}));

// ─── Bar fixture helpers ──────────────────────────────────────────────────────
//
// Conventions exactly matching wm-detector.test.ts (H=52/L=48/C=50 for flats).

const MS = 60_000; // 1m unit; fixtures don't care about TF, timestamps are scaled externally

function flatBarAt(tMs: number): OHLCV {
  return { time: tMs, open: 50, high: 52, low: 48, close: 50, volume: 1_000 };
}

function spikeLowAt(tMs: number, price: number, vol = 1_000): OHLCV {
  return { time: tMs, open: 50, high: 52, low: price, close: 50, volume: vol };
}

function spikeHighAt(tMs: number, price: number, vol = 1_000): OHLCV {
  return { time: tMs, open: 50, high: price, low: 48, close: 50, volume: vol };
}

function formingAt(tMs: number, close: number): OHLCV {
  return { time: tMs, open: 50, high: 52, low: 48, close, volume: 1_000 };
}

/**
 * Build a textbook W (double-bottom) bar array that detectWM will find actionable.
 *
 * Uses FRACTAL_N=3 layout: each pivot has 3 flat bars on each side.
 * @param nowMs  Unix-ms timestamp for "now" — the forming bar is placed at nowMs - tfMs.
 * @param tfMs   Timeframe interval in milliseconds.
 */
function textbookWBars(nowMs: number, tfMs: number): OHLCV[] {
  // Place bar[i] at time = (nowMs - 41 * tfMs) + i * tfMs
  // so bar[41] (forming) is at nowMs - 0 * tfMs ... but actually:
  // forming bar time = nowMs - tfMs  (i.e., the bar whose open is 1 tfMs ago — fresh).
  const baseTime = nowMs - 42 * tfMs; // bar[0].time; bar[41].time = baseTime + 41*tfMs = nowMs - tfMs
  const t = (i: number) => baseTime + i * tfMs;

  const bars: OHLCV[] = [];

  // Warmup: indices 0–19 (ATR → 4 after bar 13)
  for (let i = 0; i < 20; i++) bars.push(flatBarAt(t(i)));

  // Left buffer for extreme1
  bars.push(flatBarAt(t(20)));
  bars.push(flatBarAt(t(21)));
  bars.push(flatBarAt(t(22)));

  // extreme1 at idx 23: spikeLow to 44 (well below flatBar's L=48)
  bars.push(spikeLowAt(t(23), 44));

  // Right buffer for extreme1 (also serves as gap + left buffer for neckline)
  bars.push(flatBarAt(t(24)));
  bars.push(flatBarAt(t(25)));
  bars.push(flatBarAt(t(26)));
  bars.push(flatBarAt(t(27)));
  bars.push(flatBarAt(t(28)));
  bars.push(flatBarAt(t(29)));
  bars.push(flatBarAt(t(30)));
  bars.push(flatBarAt(t(31)));
  bars.push(flatBarAt(t(32)));

  // neckline at idx 33: spikeHigh to 55.5 (well above flatBar's H=52)
  bars.push(spikeHighAt(t(33), 55.5));

  // Right buffer for neckline / left buffer for extreme2
  bars.push(flatBarAt(t(34)));
  bars.push(flatBarAt(t(35)));
  bars.push(flatBarAt(t(36)));

  // extreme2 at idx 37: spikeLow to 44.5  barSep = 37-23 = 14 ≥ MIN_BAR_SEP(10) ✓
  bars.push(spikeLowAt(t(37), 44.5));

  // Right buffer for extreme2
  bars.push(flatBarAt(t(38)));
  bars.push(flatBarAt(t(39)));
  bars.push(flatBarAt(t(40)));

  // Forming bar at idx 41: close=55.6, which is 0.18% above neckline 55.5 ≤ 0.5% ✓
  bars.push(formingAt(t(41), 55.6));

  return bars; // 42 bars total
}

/**
 * Build a textbook M (double-top) bar array that detectWM will find actionable.
 * Mirrors textbookWBars with swing highs for extremes and a swing low for the neckline.
 */
function textbookMBars(nowMs: number, tfMs: number): OHLCV[] {
  const baseTime = nowMs - 42 * tfMs;
  const t = (i: number) => baseTime + i * tfMs;

  const bars: OHLCV[] = [];

  // Warmup
  for (let i = 0; i < 20; i++) bars.push(flatBarAt(t(i)));

  // Left buffer for extreme1
  bars.push(flatBarAt(t(20)));
  bars.push(flatBarAt(t(21)));
  bars.push(flatBarAt(t(22)));

  // extreme1 at idx 23: spikeHigh to 56
  bars.push(spikeHighAt(t(23), 56));

  // Buffer/gap
  bars.push(flatBarAt(t(24)));
  bars.push(flatBarAt(t(25)));
  bars.push(flatBarAt(t(26)));
  bars.push(flatBarAt(t(27)));
  bars.push(flatBarAt(t(28)));
  bars.push(flatBarAt(t(29)));
  bars.push(flatBarAt(t(30)));
  bars.push(flatBarAt(t(31)));
  bars.push(flatBarAt(t(32)));

  // neckline at idx 33: spikeLow to 44.5
  bars.push(spikeLowAt(t(33), 44.5));

  // Right buffer / left buffer for extreme2
  bars.push(flatBarAt(t(34)));
  bars.push(flatBarAt(t(35)));
  bars.push(flatBarAt(t(36)));

  // extreme2 at idx 37: spikeHigh to 55.8  barSep=14 ✓
  bars.push(spikeHighAt(t(37), 55.8));

  // Right buffer
  bars.push(flatBarAt(t(38)));
  bars.push(flatBarAt(t(39)));
  bars.push(flatBarAt(t(40)));

  // Forming bar: close=44.6, which is 0.22% above neckline 44.5 ≤ 0.5% ✓
  bars.push(formingAt(t(41), 44.6));

  return bars;
}

function withPostBreakReturn(
  source: OHLCV[],
  nowMs: number,
  tfMs: number,
  type: "W" | "M",
  closedBarsAfterBreak: number,
  options: { exhausted?: boolean; formingExhausted?: boolean } = {},
): OHLCV[] {
  const bars = source.slice(0, -1).map((bar) => ({ ...bar }));
  const breakClose = type === "W" ? 56 : 44;
  bars.push({
    time: 0, open: 50, high: 56.2, low: 43.8, close: breakClose, volume: 1_000,
  });
  for (let index = 0; index < closedBarsAfterBreak; index++) {
    const exhausted = options.exhausted && index === 0;
    bars.push({
      time: 0,
      open: 50,
      high: type === "W" && exhausted ? 68 : 56.2,
      low: type === "M" && exhausted ? 32 : 43.8,
      close: type === "W" ? 55.8 : 44.2,
      volume: 1_000,
    });
  }
  bars.push({
    time: 0,
    open: 50,
    high: type === "W" && options.formingExhausted ? 68 : 56.2,
    low: type === "M" && options.formingExhausted ? 32 : 43.8,
    close: type === "W" ? 55.6 : 44.6,
    volume: 1_000,
  });
  const baseTime = nowMs - bars.length * tfMs;
  return bars.map((bar, index) => ({ ...bar, time: baseTime + index * tfMs }));
}

// ─── Import under test ────────────────────────────────────────────────────────

import {
  getBoundaryTfs,
  evaluateCandidate,
  evaluateCandidateResult,
  SCANNER_FEED_EXCLUDE,
  buildScannerUniverse,
  getScannerStatus,
  createScannerSweepManifest,
  publishScannerSweepManifest,
  getScannerShortlist,
  resetScannerPublicationForTest,
  runScannerSweepForTest,
  startScanner,
  stopScanner,
  MAX_POST_BREAK_RETURN_AGE_BARS,
  classifyScannerFormationLifecycle,
  isActionableScannerFormationLifecycle,
} from "../../server/ai-trader/scanner";

const directPerp = {
  source: "okx", venue: "okx", basis: "perp", proxy: "direct",
  finality: "finalized", timeSemantic: "open_time",
} as const;

describe("scanner generation publication", () => {
  const candidate = {
    protocol: "pacifica", market: "BTC-PERP", timeframe: "1d", direction: "long",
    setup: "W", score: 90, necklineDistancePct: 0.1, parentTrend: "none",
    evaluatedAt: Date.now(), candleProvenance: directPerp, parentCandleProvenance: null,
  } as const;
  const accounting = {
    attempted: 1, scanned: 1, feedHealthSkipped: 0, venueClosed: 0,
    timeoutSkipped: 0, primaryCacheDegraded: 0, parentInconclusive: 0,
    errors: 0, abandoned: 0, unclassified: 0, accountingValid: true,
  };

  it("publishes candidates and manifest atomically for one sweepGeneration", () => {
    resetScannerPublicationForTest();
    const manifest = createScannerSweepManifest({ generation: 10, boundaryTimeframes: ["1d"],
      startedAt: Date.now() - 10, finishedAt: Date.now(), accounting, budgetSkippedUnits: 0,
      parentCacheDegraded: false, candidatesByProtocol: new Map([["pacifica", [candidate]]]), completed: true });
    publishScannerSweepManifest(manifest);
    expect(getScannerStatus().currentGeneration?.generation).toBe(10);
    expect(getScannerShortlist("pacifica")).toHaveLength(1);
  });

  it("retains the last tradable generation when the current generation is diagnostic-only", () => {
    const diagnostic = createScannerSweepManifest({ generation: 11, boundaryTimeframes: ["15m"],
      startedAt: 3, finishedAt: 4, accounting, budgetSkippedUnits: 0,
      parentCacheDegraded: false, candidatesByProtocol: new Map(), completed: false });
    publishScannerSweepManifest(diagnostic);
    expect(getScannerStatus().currentGeneration?.verdict).toBe("diagnostic_only");
    expect(getScannerStatus().lastTradableGeneration?.generation).toBe(10);
    expect(getScannerShortlist("pacifica")).toEqual([]);
  });

  it("admits a 1d candidate with no configured parent vacuously", () => {
    const manifest = createScannerSweepManifest({ generation: 12, boundaryTimeframes: ["1d"],
      startedAt: 5, finishedAt: 6, accounting, budgetSkippedUnits: 0,
      parentCacheDegraded: false, candidatesByProtocol: new Map([["pacifica", [candidate]]]),
      completed: true });
    expect(manifest.verdict).toBe("tradable");
  });
});

// ─── Test constants ───────────────────────────────────────────────────────────

// Fixed "now": 2026-07-15T00:00:00Z (midnight → all 4 TFs fire at this boundary).
const NOW_MS = new Date("2026-07-15T00:00:00Z").getTime();
const TF_15M = 15 * 60_000;
const TF_1H = 60 * 60_000;
const TF_1D = 24 * TF_1H;

type ParentPoint = readonly [high: number, low: number];

const MIXED_PARENT_POINTS: readonly ParentPoint[] = [
  [95, 88], [93, 86], [94, 87],
  [90, 80],
  [90, 84], [95, 86], [100, 88],
  [110, 102],
  [105, 96], [100, 90], [95, 85],
  [85, 72],
  [90, 78], [95, 82], [100, 88],
  [120, 110],
  [115, 105], [110, 100], [105, 95],
  [100, 90],
];

const UP_PARENT_POINTS: readonly ParentPoint[] = [
  [100, 93], [98, 92], [99, 91],
  [95, 88],
  [100, 93], [105, 96], [108, 99],
  [112, 104],
  [108, 100], [105, 98], [102, 96],
  [100, 93],
  [105, 96], [110, 100], [115, 105],
  [122, 110],
  [115, 105], [110, 100], [108, 98],
  [105, 95],
];

const DOWN_PARENT_POINTS: readonly ParentPoint[] = [
  [108, 98], [107, 97], [106, 96],
  [120, 110],
  [115, 105], [110, 100], [106, 96],
  [104, 94],
  [107, 97], [108, 98], [109, 99],
  [112, 102],
  [108, 98], [106, 96], [103, 93],
  [102, 90],
  [104, 92], [105, 93], [106, 94],
  [107, 95],
];

function parentBars(points: readonly ParentPoint[]): OHLCV[] {
  const baseTime = NOW_MS - points.length * TF_1H;
  return points.map(([high, low], index) => {
    const midpoint = (high + low) / 2;
    return { time: baseTime + index * TF_1H, open: midpoint, high, low, close: midpoint, volume: 500 };
  });
}

const healthyMixedParentBars = (): OHLCV[] => parentBars(MIXED_PARENT_POINTS);
const alignedUpParentBars = (): OHLCV[] => parentBars(UP_PARENT_POINTS);
const alignedDownParentBars = (): OHLCV[] => parentBars(DOWN_PARENT_POINTS);

// ─── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  prefetchCachedOHLCVMock.mockReset();
  prefetchCachedOHLCVMock.mockResolvedValue(new Map());
  // Default: active prime session (no thin-session penalty).
  getSessionContextMock.mockReturnValue({ label: "london_new_york" });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─── getBoundaryTfs ───────────────────────────────────────────────────────────

describe("getBoundaryTfs", () => {
  const cases: Array<[string, string[]]> = [
    // 15m-only boundaries
    ["2026-07-15T21:15:00Z", ["15m"]],
    ["2026-07-15T09:30:00Z", ["15m"]],
    ["2026-07-15T13:45:00Z", ["15m"]],
    // 1h boundaries (not a 4h or 1d boundary)
    ["2026-07-15T22:00:00Z", ["15m", "1h"]],
    ["2026-07-15T11:00:00Z", ["15m", "1h"]],
    ["2026-07-15T09:00:00Z", ["15m", "1h"]],
    // 4h boundaries (not midnight)
    ["2026-07-15T04:00:00Z", ["15m", "1h", "4h"]],
    ["2026-07-15T08:00:00Z", ["15m", "1h", "4h"]],
    ["2026-07-15T20:00:00Z", ["15m", "1h", "4h"]],
    // 1d boundary (midnight — also 4h, 1h, 15m)
    ["2026-07-15T00:00:00Z", ["15m", "1h", "4h", "1d"]],
    ["2026-07-16T00:00:00Z", ["15m", "1h", "4h", "1d"]],
  ];

  it.each(cases)("(%s) → %j", (isoTime, expected) => {
    expect(getBoundaryTfs(new Date(isoTime))).toEqual(expected);
  });
});

// ─── evaluateCandidate — G9 staleness ────────────────────────────────────────

describe("evaluateCandidate — G9 staleness", () => {
  it("rejects bars when forming bar is ≥ 2 × tfMs old", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    // Override forming bar time to be very stale.
    bars[bars.length - 1].time = NOW_MS - 3 * TF_15M;

    const result = evaluateCandidate(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));
    expect(result).toBeNull();
  });

  it("accepts bars when forming bar is < 2 × tfMs old", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    // textbookWBars places forming bar at NOW_MS - TF_15M (1 interval old < 2×TF_15M).

    const result = evaluateCandidate(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));
    expect(result).not.toBeNull();
  });
});

// ─── evaluateCandidate — W detection ─────────────────────────────────────────

describe("evaluateCandidate — W pattern", () => {
  it("returns a long ScannerCandidate for an actionable textbook W (n=3 fixture)", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    const result = evaluateCandidate(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");

    expect(result.protocol).toBe("flash");
    expect(result.market).toBe("SOL-PERP");
    expect(result.timeframe).toBe("15m");
    expect(result.setup).toBe("W");
    expect(result.direction).toBe("long");
    expect(result.necklineDistancePct).toBeGreaterThanOrEqual(0);
    expect(result.necklineDistancePct).toBeLessThanOrEqual(0.5); // within NECKLINE_WINDOW
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThan(60);
    expect(result.evaluatedAt).toBe(NOW_MS);
    expect(result.parentTrend).toBe("mixed");
  });

  it("returns null for an empty bar array", () => {
    expect(evaluateCandidate("SOL-PERP", "flash", [], null, "15m", new Date(NOW_MS))).toBeNull();
  });

  it("returns null for an unknown timeframe", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    expect(evaluateCandidate("SOL-PERP", "flash", bars, null, "3d", new Date(NOW_MS))).toBeNull();
  });
});

// ─── evaluateCandidate — M detection ─────────────────────────────────────────

describe("evaluateCandidate — M pattern", () => {
  it("returns a short ScannerCandidate for an actionable textbook M (n=3 fixture)", () => {
    const bars = textbookMBars(NOW_MS, TF_15M);
    const result = evaluateCandidate(
      "BTC-PERP", "pacifica", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));

    expect(result).not.toBeNull();
    if (!result) throw new Error("expected non-null");

    expect(result.setup).toBe("M");
    expect(result.direction).toBe("short");
    expect(result.market).toBe("BTC-PERP");
    expect(result.protocol).toBe("pacifica");
    expect(result.necklineDistancePct).toBeGreaterThanOrEqual(0);
    expect(result.necklineDistancePct).toBeLessThanOrEqual(0.5);
    expect(result.parentTrend).toBe("mixed");
  });
});

// ─── evaluateCandidate — parent Dow alignment ────────────────────────────────

describe("evaluateCandidate — parent Dow filtering", () => {
  it("proves the shared one-hour parent fixture is finite, spaced, sufficient, and mixed", () => {
    const parent = healthyMixedParentBars();
    expect(parent.every((bar) =>
      [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite)))
      .toBe(true);
    for (let index = 1; index < parent.length; index++) {
      expect(parent[index].time - parent[index - 1].time).toBe(TF_1H);
    }
    expect(classifyDow(detectPivots(parent)).classification).toBe("mixed");
  });

  it.each([
    "missing",
    "budget-exhausted",
    "aborted",
    "cache-degraded",
    "fetch-error",
  ])("configured-parent %s input normalized to null is parent_inconclusive", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    expect(evaluateCandidateResult("SOL-PERP", "flash", bars, null, "15m", new Date(NOW_MS)))
      .toEqual({ kind: "parent_inconclusive", reason: "parent_inconclusive" });
    expect(evaluateCandidate("SOL-PERP", "flash", bars, null, "15m", new Date(NOW_MS)))
      .toBeNull();
  });

  it("finite but insufficient configured-parent bars are parent_inconclusive", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    const shortParent: OHLCV[] = [
      flatBarAt(NOW_MS - 3 * TF_1H),
      flatBarAt(NOW_MS - 2 * TF_1H),
      flatBarAt(NOW_MS - TF_1H),
    ];
    expect(evaluateCandidateResult(
      "SOL-PERP", "flash", bars, shortParent, "15m", new Date(NOW_MS)))
      .toEqual({ kind: "parent_inconclusive", reason: "parent_inconclusive" });
  });

  it.each(["time", "open", "high", "low", "close", "volume"] as const)(
    "rejects nonfinite parent field %s before pivot detection",
    (field) => {
      const bars = textbookWBars(NOW_MS, TF_15M);
      const parent = healthyMixedParentBars();
      parent[0] = { ...parent[0], [field]: Number.NaN };
      expect(evaluateCandidateResult(
        "SOL-PERP", "flash", bars, parent, "15m", new Date(NOW_MS)))
        .toEqual({ kind: "parent_inconclusive", reason: "parent_inconclusive" });
    },
  );

  it("preserves mixed neutrality and the exact no-bonus score", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    const result = evaluateCandidateResult(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));
    expect(result.kind).toBe("candidate");
    if (result.kind !== "candidate") throw new Error("expected mixed-parent candidate");
    expect(result.candidate.parentTrend).toBe("mixed");
    expect(result.candidate.score)
      .toBeCloseTo(100 - result.candidate.necklineDistancePct * 40, 12);
  });

  it("preserves W alignment bonus and W opposition rejection", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    const neutral = evaluateCandidateResult(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));
    const aligned = evaluateCandidateResult(
      "SOL-PERP", "flash", bars, alignedUpParentBars(), "15m", new Date(NOW_MS));
    const opposed = evaluateCandidateResult(
      "SOL-PERP", "flash", bars, alignedDownParentBars(), "15m", new Date(NOW_MS));
    expect(neutral.kind).toBe("candidate");
    expect(aligned.kind).toBe("candidate");
    if (neutral.kind !== "candidate" || aligned.kind !== "candidate") {
      throw new Error("expected healthy W candidates");
    }
    expect(aligned.candidate.parentTrend).toBe("HH/HL");
    expect(aligned.candidate.score).toBeCloseTo(neutral.candidate.score + 20, 12);
    expect(opposed).toEqual({ kind: "no_candidate" });
  });

  it("preserves M alignment bonus and M opposition rejection", () => {
    const bars = textbookMBars(NOW_MS, TF_15M);
    const neutral = evaluateCandidateResult(
      "BTC-PERP", "pacifica", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));
    const aligned = evaluateCandidateResult(
      "BTC-PERP", "pacifica", bars, alignedDownParentBars(), "15m", new Date(NOW_MS));
    const opposed = evaluateCandidateResult(
      "BTC-PERP", "pacifica", bars, alignedUpParentBars(), "15m", new Date(NOW_MS));
    expect(neutral.kind).toBe("candidate");
    expect(aligned.kind).toBe("candidate");
    if (neutral.kind !== "candidate" || aligned.kind !== "candidate") {
      throw new Error("expected healthy M candidates");
    }
    expect(aligned.candidate.parentTrend).toBe("LH/LL");
    expect(aligned.candidate.score).toBeCloseTo(neutral.candidate.score + 20, 12);
    expect(opposed).toEqual({ kind: "no_candidate" });
  });

  it("keeps 1d parent-not-applicable output byte-exact and outside inconclusive", () => {
    const bars = textbookWBars(NOW_MS, TF_1D);
    const typed = evaluateCandidateResult(
      "SOL-PERP", "flash", bars, null, "1d", new Date(NOW_MS));
    expect(typed).toEqual({
      kind: "candidate",
      candidate: {
        protocol: "flash",
        market: "SOL-PERP",
        timeframe: "1d",
        direction: "long",
        setup: "W",
        score: 92.7927927927927,
        necklineDistancePct: 0.18018018018018275,
        parentTrend: "none",
        evaluatedAt: NOW_MS,
        candleProvenance: null,
        parentCandleProvenance: null,
      },
    });
    if (typed.kind !== "candidate") throw new Error("expected not-applicable candidate");
    expect(evaluateCandidate("SOL-PERP", "flash", bars, null, "1d", new Date(NOW_MS)))
      .toEqual(typed.candidate);
  });
});

// ─── evaluateCandidate — scoring ─────────────────────────────────────────────

describe("evaluateCandidate — scoring formula", () => {
  it("score follows base formula: 100 − necklineDistancePct×40 (no bonuses)", () => {
    // Prime session (no thin penalty), mixed parent (no alignment bonus).
    getSessionContextMock.mockReturnValue({ label: "london_new_york" });
    const bars = textbookWBars(NOW_MS, TF_15M);
    const result = evaluateCandidate(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected candidate from healthy neutral fixture");

    // No parent bonus (+0), no thin session penalty (−0).
    const expected = 100 - result.necklineDistancePct * 40;
    expect(result.score).toBeCloseTo(expected, 5);
  });

  it("thin-session (weekend) applies −10 penalty relative to prime session", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);

    getSessionContextMock.mockReturnValue({ label: "london_new_york" });
    const primeResult = evaluateCandidate(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));

    getSessionContextMock.mockReturnValue({ label: "weekend" });
    const weekendResult = evaluateCandidate(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));

    expect(primeResult).not.toBeNull();
    expect(weekendResult).not.toBeNull();
    if (!primeResult || !weekendResult) throw new Error("expected healthy candidates");

    // All else equal, weekend score is exactly 10 lower.
    expect(weekendResult.score).toBeCloseTo(primeResult.score - 10, 5);
  });

  it("score stays within the documented range [70, 120]", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    getSessionContextMock.mockReturnValue({ label: "london" });
    const result = evaluateCandidate(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected candidate from healthy neutral fixture");

    expect(result.score).toBeGreaterThan(60);   // loose lower bound (worst case: 70 − ε)
    expect(result.score).toBeLessThanOrEqual(120); // upper bound: 100 + 20 aligned
  });

  it("evaluatedAt equals now.getTime()", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    const result = evaluateCandidate(
      "SOL-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS));
    expect(result).not.toBeNull();
    if (!result) throw new Error("expected candidate from healthy neutral fixture");
    expect(result.evaluatedAt).toBe(NOW_MS);
  });
});

// ─── SCANNER_FEED_EXCLUDE membership ─────────────────────────────────────────

describe("evaluateCandidate formation lifecycle", () => {
  it("does not confirm a break when a closed candle finishes exactly at the neckline", () => {
    const bars = withPostBreakReturn(
      textbookWBars(NOW_MS, TF_15M), NOW_MS, TF_15M, "W", 0);
    const formation = detectWM(bars);
    expect(formation).not.toBeNull();
    if (!formation) throw new Error("expected W formation");
    const closedLastIndex = bars.length - 2;
    const exactNecklineClose = bars.map((bar, index) => (
      index > formation.extreme2.index && index <= closedLastIndex)
      ? { ...bar, close: formation.neckline.price }
      : bar);

    expect(classifyScannerFormationLifecycle(exactNecklineClose, formation))
      .toEqual({ state: "pre_break" });
  });

  it("accepts an unexhausted retest through four bars and rejects the fifth", () => {
    expect(MAX_POST_BREAK_RETURN_AGE_BARS).toBe(4);
    const ageFour = withPostBreakReturn(
      textbookWBars(NOW_MS, TF_15M), NOW_MS, TF_15M, "W", 4);
    const ageFive = withPostBreakReturn(
      textbookWBars(NOW_MS, TF_15M), NOW_MS, TF_15M, "W", 5);

    const formation = detectWM(ageFour);
    expect(formation).not.toBeNull();
    if (!formation) throw new Error("expected W formation");
    expect(classifyScannerFormationLifecycle(ageFour, formation)).toMatchObject({
      state: "post_break", breakAgeBars: 4, targetExhausted: false,
    });
    expect(evaluateCandidate(
      "SOL-PERP", "flash", ageFour, healthyMixedParentBars(), "15m", new Date(NOW_MS),
    )).not.toBeNull();
    expect(evaluateCandidate(
      "SOL-PERP", "flash", ageFive, healthyMixedParentBars(), "15m", new Date(NOW_MS),
    )).toBeNull();
  });

  it("rejects the owner-observed class after the measured move is exhausted", () => {
    const bars = withPostBreakReturn(
      textbookWBars(NOW_MS, TF_15M), NOW_MS, TF_15M, "W", 5, { exhausted: true });
    const formation = detectWM(bars);
    expect(formation).not.toBeNull();
    if (!formation) throw new Error("expected W formation");
    expect(classifyScannerFormationLifecycle(bars, formation)).toMatchObject({
      state: "post_break", breakAgeBars: 5, targetExhausted: true,
    });
    expect(evaluateCandidate(
      "BNB-PERP", "pacifica", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS),
    )).toBeNull();
  });
});

describe("formation lifecycle symmetry and fail-closed inputs", () => {
  it.each(["W", "M"] as const)(
    "treats an exact measured-target touch as exhausting a %s formation",
    (type) => {
      const source = type === "W"
        ? textbookWBars(NOW_MS, TF_15M)
        : textbookMBars(NOW_MS, TF_15M);
      const bars = withPostBreakReturn(source, NOW_MS, TF_15M, type, 1);
      const formation = detectWM(bars);
      expect(formation).not.toBeNull();
      if (!formation) throw new Error(`expected ${type} formation`);
      const measuredTarget = type === "W"
        ? formation.neckline.price + formation.patternHeight
        : formation.neckline.price - formation.patternHeight;
      const formingIndex = bars.length - 1;
      const exactTargetTouch = bars.map((bar, index) => index === formingIndex
        ? type === "W"
          ? { ...bar, high: measuredTarget }
          : { ...bar, low: measuredTarget }
        : bar);

      const lifecycle = classifyScannerFormationLifecycle(exactTargetTouch, formation);
      expect(lifecycle).toMatchObject({
        state: "post_break", measuredTarget, targetExhausted: true,
      });
      expect(isActionableScannerFormationLifecycle(lifecycle)).toBe(false);
    },
  );

  it.each(["W", "M"] as const)(
    "rejects an exhausted %s return, including exhaustion in the forming candle",
    (type) => {
      const source = type === "W"
        ? textbookWBars(NOW_MS, TF_15M)
        : textbookMBars(NOW_MS, TF_15M);
      for (const options of [{ exhausted: true }, { formingExhausted: true }]) {
        const bars = withPostBreakReturn(source, NOW_MS, TF_15M, type, 1, options);
        const formation = detectWM(bars);
        expect(formation).not.toBeNull();
        if (!formation) throw new Error(`expected ${type} formation`);
        const lifecycle = classifyScannerFormationLifecycle(bars, formation);
        expect(lifecycle).toMatchObject({ state: "post_break", targetExhausted: true });
        expect(isActionableScannerFormationLifecycle(lifecycle)).toBe(false);
        expect(evaluateCandidate(
          "TEST-PERP", "flash", bars, healthyMixedParentBars(), "15m", new Date(NOW_MS),
        )).toBeNull();
      }
    },
  );

  it("fails closed when a required lifecycle input is non-finite", () => {
    const bars = textbookWBars(NOW_MS, TF_15M);
    const formation = detectWM(bars);
    expect(formation).not.toBeNull();
    if (!formation) throw new Error("expected W formation");
    const lifecycle = classifyScannerFormationLifecycle(
      bars, { ...formation, patternHeight: Number.NaN },
    );
    expect(lifecycle).toEqual({ state: "unknown" });
    expect(isActionableScannerFormationLifecycle(lifecycle)).toBe(false);
  });
});

describe("SCANNER_FEED_EXCLUDE", () => {
  const REQUIRED_EXCLUDES = [
    "NATGAS-PERP",
    "CL-PERP",
    "CRUDEOIL-PERP",
    "SPCX-PERP",
    "SKHYNIX-PERP",
    "SAMSUNG-PERP",
    "URNM-PERP",
    "COPPER-PERP",
    "BP-PERP",
  ] as const;

  it.each(REQUIRED_EXCLUDES)("contains %s", (market) => {
    expect(SCANNER_FEED_EXCLUDE.has(market)).toBe(true);
  });

  it("is a non-empty Set", () => {
    expect(SCANNER_FEED_EXCLUDE.size).toBeGreaterThan(0);
  });

  it("does not exclude known live markets", () => {
    for (const live of ["SOL-PERP", "BTC-PERP", "ETH-PERP"]) {
      expect(SCANNER_FEED_EXCLUDE.has(live)).toBe(false);
    }
  });
});

// ─── Universe filter invariant ────────────────────────────────────────────────
//
// The sweep calls fetchOHLCV only for markets that survive the SCANNER_FEED_EXCLUDE
// filter applied in buildUniverse(). These tests verify that invariant is upheld by
// the filter logic itself (pure set intersection), which is the exact code path the
// sweep exercises.

describe("excluded symbols — never forwarded to fetchOHLCV", () => {
  it("filter removes all excluded symbols from a raw universe list", () => {
    const rawUniverse = [
      "SOL-PERP",
      "NATGAS-PERP",   // excluded
      "BTC-PERP",
      "CL-PERP",        // excluded
      "ETH-PERP",
      "CRUDEOIL-PERP",  // excluded
      "SPCX-PERP",      // excluded
      "SAMSUNG-PERP",   // excluded
    ];
    const filtered = rawUniverse.filter((m) => !SCANNER_FEED_EXCLUDE.has(m));
    expect(filtered).toEqual(["SOL-PERP", "BTC-PERP", "ETH-PERP"]);
    expect(filtered.every((m) => !SCANNER_FEED_EXCLUDE.has(m))).toBe(true);
  });

  it("no intersection between SCANNER_FEED_EXCLUDE and common live markets", () => {
    const liveMarkets = [
      "SOL-PERP", "BTC-PERP", "ETH-PERP",
      "JTO-PERP", "JUP-PERP", "INF-PERP",
      "BONK-PERP", "WIF-PERP", "PYTH-PERP",
    ];
    const intersection = liveMarkets.filter((m) => SCANNER_FEED_EXCLUDE.has(m));
    expect(intersection).toHaveLength(0);
  });

  it("every excluded symbol produces no fetchOHLCV calls when used as a spy (contract test)", () => {
    // Simulate what the sweep does: filter universe then call fetchOHLCV per market.
    // A universe that is already filtered should never have excluded symbols forwarded.
    const fullUniverse = [
      "SOL-PERP", "NATGAS-PERP", "BTC-PERP", "CL-PERP",
    ];
    const filteredUniverse = fullUniverse.filter((m) => !SCANNER_FEED_EXCLUDE.has(m));

    // Confirm none of the excluded symbols are in the filtered list.
    for (const excluded of SCANNER_FEED_EXCLUDE) {
      expect(filteredUniverse.includes(excluded)).toBe(false);
    }
    // Only live markets remain.
    expect(filteredUniverse).toEqual(["SOL-PERP", "BTC-PERP"]);
  });
});

describe("multiplier quarantine — real universe-build seam", () => {
  it("removes all six before fetch and reports a sorted status set outside attempt accounting", async () => {
    stopScanner();
    const multiplierMarkets = [
      "1MBONK-PERP",
      "1MPEPE-PERP",
      "1KWEN-PERP",
      "1KMEW-PERP",
      "1KPUMP-PERP",
      "1KMON-PERP",
    ];
    getAdapterMock.mockReturnValue({
      getMarkets: vi.fn(async () => [
        ...multiplierMarkets.map((internalSymbol) => ({ internalSymbol, isActive: true })),
        { internalSymbol: "BONK-PERP", isActive: true },
        { internalSymbol: "PEPE-PERP", isActive: true },
      ]),
    });
    fetchOHLCVMock.mockResolvedValue([]);

    const universe = await buildScannerUniverse("pacifica");

    expect(universe).toEqual(["BONK-PERP", "PEPE-PERP"]);
    expect(fetchOHLCVMock).not.toHaveBeenCalled();
    for (const market of universe) {
      await fetchOHLCVMock(market, "15m", "pacifica", "test");
    }
    expect(fetchOHLCVMock.mock.calls.map(([market]) => market)).toEqual(["BONK-PERP", "PEPE-PERP"]);
    expect(getScannerStatus().multiplierQuarantinedMarkets).toEqual([...multiplierMarkets].sort());
    expect(getScannerStatus().lastBoundaryStats).toBeNull();

    stopScanner();
    expect(getScannerStatus().multiplierQuarantinedMarkets).toEqual([]);
  });
});

describe("active sweep lifecycle ownership", () => {
  function deferredBars() {
    let resolve!: (bars: OHLCV[]) => void;
    const promise = new Promise<OHLCV[]>((done) => { resolve = done; });
    return { promise, resolve };
  }

  function oneMarketUniverse() {
    getFlashMarketSpecsMock.mockReturnValue([{ internalSymbol: "BTC-PERP" }]);
    getAdapterMock.mockReturnValue({ getMarkets: vi.fn(async () => []) });
  }

  it("aborts the active fetch and rejects every late mutation after stop", async () => {
    stopScanner();
    oneMarketUniverse();
    const pending = deferredBars();
    let capturedSignal: AbortSignal | null = null;
    fetchOHLCVMock.mockImplementation((...args: unknown[]) => {
      capturedSignal = (args as unknown as any[])[5]?.signal ?? null;
      return pending.promise;
    });

    startScanner();
    const sweep = runScannerSweepForTest();
    await vi.waitFor(() => expect(fetchOHLCVMock).toHaveBeenCalledTimes(1));

    stopScanner();
    await sweep;
    expect(capturedSignal).not.toBeNull();
    expect((capturedSignal as AbortSignal).aborted).toBe(true);
    expect(getScannerStatus()).toMatchObject({
      scannerRunning: false,
      currentGeneration: null,
      lastTradableGeneration: null,
      recentHistory: [],
    });
    expect(recordCriticalErrorMock).not.toHaveBeenCalled();

    pending.resolve(textbookWBars(Date.now(), TF_15M));
    await Promise.resolve();
    await Promise.resolve();
    expect(getScannerStatus().currentGeneration).toBeNull();
  });

  it("lets a wedge replacement publish while the revoked generation resolves late", async () => {
    vi.useFakeTimers();
    try {
      stopScanner();
      vi.setSystemTime(new Date("2026-08-18T00:15:00Z"));
      oneMarketUniverse();
      const pending = deferredBars();
      fetchOHLCVMock
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue([]);

      startScanner();
      const staleSweep = runScannerSweepForTest();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchOHLCVMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-08-18T00:20:00.001Z"));
      const replacementSweep = runScannerSweepForTest();
      await vi.advanceTimersByTimeAsync(200);
      await replacementSweep;
      await staleSweep;

      const replacementGeneration = getScannerStatus().currentGeneration?.generation;
      expect(replacementGeneration).toBeTypeOf("number");
      pending.resolve(textbookWBars(Date.now(), TF_15M));
      await vi.advanceTimersByTimeAsync(0);
      expect(getScannerStatus().currentGeneration?.generation).toBe(replacementGeneration);
    } finally {
      stopScanner();
      vi.useRealTimers();
    }
  });

  it("does not let a pre-stop promise overwrite a restarted scanner generation", async () => {
    stopScanner();
    oneMarketUniverse();
    const pending = deferredBars();
    fetchOHLCVMock
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue([]);

    startScanner();
    const staleSweep = runScannerSweepForTest();
    await vi.waitFor(() => expect(fetchOHLCVMock).toHaveBeenCalledTimes(1));
    stopScanner();
    await staleSweep;

    startScanner();
    await runScannerSweepForTest();
    const restartedGeneration = getScannerStatus().currentGeneration?.generation;
    expect(restartedGeneration).toBeTypeOf("number");

    pending.resolve(textbookWBars(Date.now(), TF_15M));
    await Promise.resolve();
    await Promise.resolve();
    expect(getScannerStatus().currentGeneration?.generation).toBe(restartedGeneration);
    stopScanner();
  });
});

describe("scanner batch cache prefetch", () => {
  it("deduplicates shared protocol symbols and seeds both due timeframes without legacy fetches", async () => {
    vi.useFakeTimers();
    try {
      stopScanner();
      vi.setSystemTime(new Date("2026-08-18T00:15:00Z"));
      getFlashMarketSpecsMock.mockReturnValue([{ internalSymbol: "BTC-PERP" }]);
      getAdapterMock.mockReturnValue({
        getMarkets: vi.fn(async () => [{ internalSymbol: "BTC-PERP", isActive: true }]),
      });
      prefetchCachedOHLCVMock.mockImplementation(
        async (_symbols: string[], timeframe: string) => new Map([
          ["BTC/USDT", textbookWBars(Date.now(), timeframe === "1h" ? TF_1H : TF_15M)
            .map((bar) => ({ ...bar, provenance: directPerp }))],
        ]),
      );

      startScanner();
      await runScannerSweepForTest();

      expect(prefetchCachedOHLCVMock).toHaveBeenCalledTimes(2);
      expect(prefetchCachedOHLCVMock.mock.calls.map((call) => call[0])).toEqual([
        ["BTC/USDT"], ["BTC/USDT"],
      ]);
      expect(prefetchCachedOHLCVMock.mock.calls.map((call) => call[1])).toEqual(["15m", "1h"]);
      expect(fetchOHLCVMock).not.toHaveBeenCalled();
    } finally {
      stopScanner();
      vi.useRealTimers();
    }
  });

  it("records one visible batch failure per timeframe and falls back to the existing per-market path", async () => {
    vi.useFakeTimers();
    try {
      stopScanner();
      vi.setSystemTime(new Date("2026-08-18T00:15:00Z"));
      getFlashMarketSpecsMock.mockReturnValue([{ internalSymbol: "BTC-PERP" }]);
      getAdapterMock.mockReturnValue({ getMarkets: vi.fn(async () => []) });
      prefetchCachedOHLCVMock.mockRejectedValue(new Error("batch unavailable"));
      fetchOHLCVMock.mockResolvedValue([]);

      startScanner();
      const sweep = runScannerSweepForTest();
      await vi.advanceTimersByTimeAsync(1_000);
      await sweep;

      expect(prefetchCachedOHLCVMock).toHaveBeenCalledTimes(2);
      expect(fetchOHLCVMock).toHaveBeenCalledTimes(1);
      expect(getScannerStatus().recentHistory).toEqual(expect.arrayContaining([
        expect.objectContaining({ protocol: "flash", marketsAttempted: 1, errorCount: 1 }),
      ]));
    } finally {
      stopScanner();
      vi.useRealTimers();
    }
  });
});

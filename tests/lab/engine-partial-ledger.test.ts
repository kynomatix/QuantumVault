import { describe, expect, it } from "vitest";
import { runBacktest, type OHLCV } from "../../server/lab/engine";
import { computeWindowMetrics } from "../../server/lab/metrics";

type Bar = [open: number, high: number, low: number, close: number];

function longSetup(stopPrice = 96): Bar[] {
  return [
    ...Array.from({ length: 20 }, (): Bar => [98, 98, 98, 98]),
    [98, 100, 98, 100],
    [100, 111, 100, 110],
    [stopPrice, stopPrice, stopPrice, stopPrice],
  ];
}

function candles(bars: Bar[]): OHLCV[] {
  return bars.map(([open, high, low, close], i) => ({
    time: Date.UTC(2026, 0, 1, i), open, high, low, close, volume: 100,
  }));
}

const config = { initialCapital: 1000, positionSize: 1000, commission: 0.0005, slippage: 0 };

function backtest(bars: Bar[], params = {}, overrides = {}) {
  return runBacktest(candles(bars), {
    bbLen: 2, kcLen: 2, momLen: 2, useLinReg: false, bbwPctileLen: 2, bbwPctile: 100,
    slAtrLen: 2, slMode: "Percentage", slPct: 4, tpMode: "Percentage",
    tp1Pct: 10, tp1QtyPct: 50, useTP1: true, useTP2: false, useTP3: false,
    tradeDir: "Long Only", cooldownBars: 4, ...params,
  }, "EXAMPLE", "1h", { ...config, ...overrides });
}

describe("native position ledger", () => {
  it("records the half target and the stop as one net winning long", () => {
    const result = backtest(longSetup());
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      direction: "long", entryPrice: 100, exitReason: "Stop Loss", barsHeld: 1,
      pnlDollar: 29, pnlPercent: 2.9,
    });
    expect(result.trades[0].exitPrice).toBeCloseTo(103, 10);
    expect(result).toMatchObject({ totalTrades: 1, netProfitPercent: 2.9, profitFactor: 999, winRatePercent: 100 });
    expect(result.equityCurve[21].equity).toBeCloseTo(1099.5);
    expect(result.equityCurve[22].equity).toBeCloseTo(1029);
  });

  it("records a 100% TP1 even when a later target is touched with no quantity left", () => {
    const bars = longSetup().slice(0, 22);
    bars[21] = [100, 111, 100, 108];
    const { trades } = backtest(bars, { tp1QtyPct: 100, useTP2: true, tp2Pct: 10.5 });
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ pnlDollar: 99, pnlPercent: 9.9, exitReason: "TP1", barsHeld: 0 });
    expect(trades[0].exitPrice).toBeCloseTo(110, 10);
  });

  it("includes both fills of a short with a partial target", () => {
    const bars = longSetup().map(([o, h, l, c]): Bar => [200 - o, 200 - l, 200 - h, 200 - c]);
    const result = backtest(bars, { tradeDir: "Short Only" });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({
      direction: "short", pnlDollar: 29, pnlPercent: 2.9, exitReason: "Stop Loss", barsHeld: 1,
    });
    expect(result.trades[0].exitPrice).toBeCloseTo(97, 10);
    expect(result.equityCurve[22].equity).toBeCloseTo(1029);
  });

  it("counts a gross winner that loses after fees as a loss", () => {
    const bars = longSetup().slice(0, 22);
    bars[21] = [100, 100.05, 100, 100.05];
    const result = backtest(bars);
    expect(result).toMatchObject({ totalTrades: 1, profitFactor: 0, winRatePercent: 0 });
    expect(result.trades[0]).toMatchObject({ pnlDollar: -0.5, pnlPercent: -0.05 });
  });

  it("counts a positive net dollar record even when its net return rounds to zero", () => {
    const bars = longSetup().slice(0, 22);
    bars[21] = [100, 100.101, 100, 100.101];
    const result = backtest(bars);
    expect(result.trades[0]).toMatchObject({ pnlDollar: 0.01, pnlPercent: 0 });
    expect(result).toMatchObject({ totalTrades: 1, profitFactor: 999, winRatePercent: 100 });
  });

  it("assigns all fills of a crossing position to its entry window", () => {
    const bars = [...longSetup(), ...longSetup(94)];
    const result = backtest(bars);
    const boundary = candles(bars)[22].time;
    const { is, oos } = computeWindowMetrics(result.trades, boundary, config.initialCapital);
    expect(result.trades).toHaveLength(2);
    expect(Date.parse(result.trades[0].entryTime)).toBeLessThan(boundary);
    expect(Date.parse(result.trades[0].exitTime)).toBe(boundary);
    expect(is).toMatchObject({ totalTrades: 1, netProfitPercent: 2.9 });
    expect(oos).toMatchObject({ totalTrades: 1, netProfitPercent: 1.9 });
    const windowDollars = (is.netProfitPercent + oos.netProfitPercent) * config.initialCapital / 100;
    expect(windowDollars).toBeCloseTo(result.equityCurve[bars.length - 1].equity - config.initialCapital);
  });

  it("settles a nonzero dust balance at the bar close", () => {
    const bars = longSetup().slice(0, 22);
    bars[21] = [100, 111, 100, 100];
    const result = backtest(bars, { tp1QtyPct: 99.95 });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]).toMatchObject({ pnlDollar: 98.95, pnlPercent: 9.9, exitReason: "TP1" });
    expect(result.trades[0].exitPrice).toBeCloseTo(109.995, 10);
    expect(result.equityCurve[21].equity).toBeCloseTo(1098.95, 10);
  });

  it.each([17, 93, 411])("reconciles multiple net records to realized equity for seed %i", (seed) => {
    let state = seed;
    function random() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    }
    const bars = Array.from({ length: 5 }, () => longSetup(90 + random() * 6)).flat();
    const result = backtest(bars, {
      tp1QtyPct: 20 + random() * 30, useTP2: true, tp2Pct: 5, tp2QtyPct: 15 + random() * 20,
    }, { positionSize: 700 + random() * 400, slippage: 0.001 });
    expect(result.trades).toHaveLength(5);
    expect(result.trades.every(t => t.exitReason === "Stop Loss")).toBe(true);
    const recorded = result.trades.reduce((sum, t) => sum + t.pnlDollar, 0);
    const realized = result.equityCurve[bars.length - 1].equity - config.initialCapital;
    expect(Math.abs(recorded - realized)).toBeLessThanOrEqual(0.01 * result.trades.length);
  });
});

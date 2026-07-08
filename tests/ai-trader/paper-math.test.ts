// WO-5 — paper-math unit tests: slippage direction, candle-vs-bracket evaluation
// against deterministic candle fixtures, and round-trip PnL with fees.
import { describe, it, expect } from "vitest";
import {
  PAPER_SLIPPAGE_PER_LEG,
  paperEntryPrice,
  paperExitPrice,
  evaluateCandleAgainstBracket,
  evaluatePaperBracket,
  paperRealizedPnl,
  type PaperCandle,
} from "../../server/ai-trader/paper-math";

const T0 = 1_760_000_000_000;
const candle = (i: number, o: number, h: number, l: number, c: number): PaperCandle => ({
  time: T0 + i * 900_000,
  open: o,
  high: h,
  low: l,
  close: c,
  volume: 1000,
});

describe("paperEntryPrice — adverse entry slippage", () => {
  it("long entries fill ABOVE mark by exactly the per-leg slippage", () => {
    expect(paperEntryPrice(100, "long")).toBeCloseTo(100 * (1 + PAPER_SLIPPAGE_PER_LEG), 12);
    expect(paperEntryPrice(100, "long")).toBeGreaterThan(100);
  });

  it("short entries fill BELOW mark by exactly the per-leg slippage", () => {
    expect(paperEntryPrice(100, "short")).toBeCloseTo(100 * (1 - PAPER_SLIPPAGE_PER_LEG), 12);
    expect(paperEntryPrice(100, "short")).toBeLessThan(100);
  });

  it("rejects non-finite / non-positive marks", () => {
    expect(() => paperEntryPrice(0, "long")).toThrow();
    expect(() => paperEntryPrice(NaN, "long")).toThrow();
    expect(() => paperEntryPrice(-5, "short")).toThrow();
    expect(() => paperEntryPrice(Infinity, "short")).toThrow();
  });
});

describe("paperExitPrice — adverse exit slippage", () => {
  it("long exits (sells) fill BELOW the trigger level", () => {
    expect(paperExitPrice(98, "long")).toBeCloseTo(98 * (1 - PAPER_SLIPPAGE_PER_LEG), 12);
  });

  it("short exits (buys) fill ABOVE the trigger level", () => {
    expect(paperExitPrice(102, "short")).toBeCloseTo(102 * (1 + PAPER_SLIPPAGE_PER_LEG), 12);
  });

  it("rejects invalid trigger levels", () => {
    expect(() => paperExitPrice(0, "long")).toThrow();
    expect(() => paperExitPrice(NaN, "short")).toThrow();
  });
});

describe("evaluateCandleAgainstBracket", () => {
  // Long position: entry ~100, SL 98, TP 103.
  it("long: candle low touching SL (inclusive) triggers SL", () => {
    expect(evaluateCandleAgainstBracket(candle(0, 100, 101, 98, 100), "long", 98, 103)).toBe("sl");
  });

  it("long: candle high touching TP (inclusive) triggers TP", () => {
    expect(evaluateCandleAgainstBracket(candle(0, 100, 103, 99, 102), "long", 98, 103)).toBe("tp");
  });

  it("long: candle spanning BOTH levels counts as SL (conservative rule)", () => {
    expect(evaluateCandleAgainstBracket(candle(0, 100, 104, 97, 101), "long", 98, 103)).toBe("sl");
  });

  it("long: candle inside the bracket triggers nothing", () => {
    expect(evaluateCandleAgainstBracket(candle(0, 100, 102.99, 98.01, 101), "long", 98, 103)).toBeNull();
  });

  // Short position: entry ~100, SL 102, TP 97 (mirrored).
  it("short: candle high touching SL triggers SL", () => {
    expect(evaluateCandleAgainstBracket(candle(0, 100, 102, 99, 100), "short", 102, 97)).toBe("sl");
  });

  it("short: candle low touching TP triggers TP", () => {
    expect(evaluateCandleAgainstBracket(candle(0, 100, 101, 97, 98), "short", 102, 97)).toBe("tp");
  });

  it("short: candle spanning BOTH levels counts as SL", () => {
    expect(evaluateCandleAgainstBracket(candle(0, 100, 103, 96, 99), "short", 102, 97)).toBe("sl");
  });

  it("short: candle inside the bracket triggers nothing", () => {
    expect(evaluateCandleAgainstBracket(candle(0, 100, 101.99, 97.01, 100), "short", 102, 97)).toBeNull();
  });
});

describe("evaluatePaperBracket — first hit across a candle window", () => {
  // Fixture: long from ~100, SL 98 / TP 103. Candles drift up, dip, then spike.
  const LONG_WINDOW: PaperCandle[] = [
    candle(0, 100.0, 101.2, 99.4, 100.8), // inside
    candle(1, 100.8, 102.1, 100.1, 101.5), // inside
    candle(2, 101.5, 103.4, 100.9, 103.0), // TP touch (high 103.4 ≥ 103)
    candle(3, 103.0, 104.0, 97.5, 98.0),  // would be SL — must never be reached
  ];

  it("returns the FIRST triggering candle, not a later/worse one", () => {
    const hit = evaluatePaperBracket(LONG_WINDOW, "long", 98, 103);
    expect(hit).not.toBeNull();
    expect(hit!.leg).toBe("tp");
    expect(hit!.candleTime).toBe(LONG_WINDOW[2].time);
    expect(hit!.triggerLevel).toBe(103);
    expect(hit!.exitPrice).toBeCloseTo(103 * (1 - PAPER_SLIPPAGE_PER_LEG), 12);
  });

  it("a both-sides candle first in the window resolves to SL with SL exit slippage", () => {
    const hit = evaluatePaperBracket([candle(0, 100, 104, 97, 101)], "long", 98, 103);
    expect(hit!.leg).toBe("sl");
    expect(hit!.triggerLevel).toBe(98);
    expect(hit!.exitPrice).toBeCloseTo(98 * (1 - PAPER_SLIPPAGE_PER_LEG), 12);
  });

  it("short bracket mirrors: SL above fills with upward slippage", () => {
    const hit = evaluatePaperBracket(
      [candle(0, 100, 101, 99, 100.5), candle(1, 100.5, 102.3, 100, 102)],
      "short",
      102,
      97
    );
    expect(hit!.leg).toBe("sl");
    expect(hit!.candleTime).toBe(T0 + 900_000);
    expect(hit!.exitPrice).toBeCloseTo(102 * (1 + PAPER_SLIPPAGE_PER_LEG), 12);
  });

  it("returns null when the position survives the whole window", () => {
    expect(
      evaluatePaperBracket(
        [candle(0, 100, 101, 99, 100), candle(1, 100, 102, 99.5, 101)],
        "long",
        98,
        103
      )
    ).toBeNull();
    expect(evaluatePaperBracket([], "long", 98, 103)).toBeNull();
  });

  it("throws on a non-finite bracket instead of silently never triggering", () => {
    expect(() => evaluatePaperBracket(LONG_WINDOW, "long", NaN, 103)).toThrow();
    expect(() => evaluatePaperBracket(LONG_WINDOW, "long", 98, Infinity)).toThrow();
  });
});

describe("paperRealizedPnl — round trip with fees", () => {
  it("long winner: gross, fees on both notionals, net", () => {
    // entry 100.05 (slipped), exit 102.9485 (TP 103 slipped), size 2, taker 4bps
    const r = paperRealizedPnl({
      side: "long",
      entryPrice: 100.05,
      exitPrice: 102.9485,
      sizeBase: 2,
      takerFeeRate: 0.0004,
    });
    expect(r.grossPnl).toBeCloseTo((102.9485 - 100.05) * 2, 10);
    expect(r.fees).toBeCloseTo(0.0004 * (100.05 + 102.9485) * 2, 10);
    expect(r.netPnl).toBeCloseTo(r.grossPnl - r.fees, 10);
    expect(r.netPnl).toBeLessThan(r.grossPnl);
  });

  it("short winner: direction flips the gross sign correctly", () => {
    const r = paperRealizedPnl({
      side: "short",
      entryPrice: 99.95, // short entry slipped down from 100
      exitPrice: 97.0485, // TP 97: a short exit is a BUY, slipped up → 97 × 1.0005
      sizeBase: 1.5,
      takerFeeRate: 0.0004,
    });
    expect(r.grossPnl).toBeCloseTo((97.0485 - 99.95) * 1.5 * -1, 10);
    expect(r.grossPnl).toBeGreaterThan(0);
  });

  it("long loser nets below gross (fees always subtract)", () => {
    const r = paperRealizedPnl({
      side: "long",
      entryPrice: 100.05,
      exitPrice: 97.951, // SL 98 slipped down
      sizeBase: 2,
      takerFeeRate: 0.0004,
    });
    expect(r.grossPnl).toBeLessThan(0);
    expect(r.netPnl).toBeLessThan(r.grossPnl);
  });

  it("zero fee rate is legal (gross === net); negative/invalid inputs throw", () => {
    const r = paperRealizedPnl({ side: "long", entryPrice: 100, exitPrice: 101, sizeBase: 1, takerFeeRate: 0 });
    expect(r.netPnl).toBe(r.grossPnl);
    expect(() => paperRealizedPnl({ side: "long", entryPrice: 0, exitPrice: 101, sizeBase: 1, takerFeeRate: 0.0004 })).toThrow();
    expect(() => paperRealizedPnl({ side: "long", entryPrice: 100, exitPrice: 101, sizeBase: -1, takerFeeRate: 0.0004 })).toThrow();
    expect(() => paperRealizedPnl({ side: "long", entryPrice: 100, exitPrice: 101, sizeBase: 1, takerFeeRate: NaN })).toThrow();
  });

  it("full paper round trip composes: entry slip + exit slip + fees for a long TP", () => {
    // Mark 100 → long entry 100.05; TP 103 → exit 102.9485; size 1; 4bps taker.
    const entry = paperEntryPrice(100, "long");
    const hit = evaluatePaperBracket([candle(0, 101, 103.2, 100.5, 103)], "long", 98, 103)!;
    const r = paperRealizedPnl({ side: "long", entryPrice: entry, exitPrice: hit.exitPrice, sizeBase: 1, takerFeeRate: 0.0004 });
    expect(entry).toBeCloseTo(100.05, 10);
    expect(hit.exitPrice).toBeCloseTo(102.9485, 10);
    expect(r.grossPnl).toBeCloseTo(2.8985, 6);
    expect(r.fees).toBeCloseTo(0.0004 * (100.05 + 102.9485), 10);
    expect(r.netPnl).toBeCloseTo(2.8985 - 0.08119940000000001, 6);
  });
});

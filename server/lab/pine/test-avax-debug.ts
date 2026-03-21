import { compilePine, runPineBacktest } from "./index";
import { executePine, type OHLCV, type PineEngineConfig } from "./runtime";
import { fetchOHLCV } from "../datafeed";

async function main() {
  const candles = await fetchOHLCV("AVAX", "12h", "2020-06-01", "2026-03-21");
  console.log("Candles:", candles.length, "from", new Date(candles[0].time).toISOString(), "to", new Date(candles[candles.length-1].time).toISOString());

  const fs = await import("fs");
  const source = fs.readFileSync("attached_assets/Pasted--This-Pine-Script-code-is-subject-to-the-terms-of-the-M_1774090674627.txt", "utf8");
  const plan = compilePine(source);

  const params: Record<string, any> = {
    useTP: false, adxLen: 58, slMode: "BOS (Structure)", useADX: true,
    bb_mult: 0.7, slATRlen: 5, aoFastLen: 17, aoSlowLen: 16,
    bb_length: 23, bb_source: "close", cviLength: 8, slATRmult: 4.9,
    slOnClose: true, slPercent: 14, trailMode: "ATR",
    trendMode: "Both (Filter Off)", bb_use_ema: true, useCVIexit: false,
    bosSwingLen: 3, cviBearThld: 0.086, cviBullThld: -1.49, fast_ma_len: 4,
    trendEmaLen: 952, useCVIentry: false, useStopLoss: true, useTrailing: true,
    adxThreshold: 31.6, trailATRmult: 5.25, trailPercent: 8.75,
    usePartialTP: false, activationATR: 2.5, activationPct: 4.5,
    useTrendFilter: false, trailActivation: true,
    backtestStartDate: 1609459200000, useDateFilter: true,
    moveSlToBreakeven: true,
  };

  console.log("\n=== Config A: My test config (positionSize=100, capital=10000) ===");
  const configA: PineEngineConfig = {
    initialCapital: 10000, commission: 0.0005, positionSize: 100,
    processOrdersOnClose: true,
  };
  const resultA = executePine(plan.ast, candles, params, "AVAX", "12h", configA);
  console.log("Net Profit:", resultA.netProfitPercent + "%", "| Trades:", resultA.totalTrades);

  console.log("\n=== Config B: Optimizer config (positionSize=1000, capital=1000) ===");
  const configB: PineEngineConfig = {
    initialCapital: 1000, commission: 0.0005, positionSize: 1000,
    processOrdersOnClose: true,
  };
  const resultB = executePine(plan.ast, candles, params, "AVAX", "12h", configB);
  console.log("Net Profit:", resultB.netProfitPercent + "%", "| Trades:", resultB.totalTrades);

  console.log("\n=== Config C: Optimizer without processOrdersOnClose ===");
  const configC: PineEngineConfig = {
    initialCapital: 1000, commission: 0.0005, positionSize: 1000,
    processOrdersOnClose: false,
  };
  const resultC = executePine(plan.ast, candles, params, "AVAX", "12h", configC);
  console.log("Net Profit:", resultC.netProfitPercent + "%", "| Trades:", resultC.totalTrades);

  console.log("\n=== Config D: positionSize=100, capital=100 (same ratio as optimizer) ===");
  const configD: PineEngineConfig = {
    initialCapital: 100, commission: 0.0005, positionSize: 100,
    processOrdersOnClose: true,
  };
  const resultD = executePine(plan.ast, candles, params, "AVAX", "12h", configD);
  console.log("Net Profit:", resultD.netProfitPercent + "%", "| Trades:", resultD.totalTrades);

  const tvTrades = [
    { dir: "short", entry: 15.82, entryDate: "2023-03-16", exit: 17.30, exitDate: "2023-03-29" },
    { dir: "short", entry: 36.365, entryDate: "2024-04-24", exit: 37.344, exitDate: "2024-05-04" },
    { dir: "short", entry: 34.412, entryDate: "2024-05-08", exit: 36.56, exitDate: "2024-05-17" },
    { dir: "short", entry: 35.899, entryDate: "2024-06-06", exit: 29.362, exitDate: "2024-06-30" },
    { dir: "short", entry: 47.909, entryDate: "2024-12-17", exit: 42.63, exitDate: "2025-01-04" },
    { dir: "short", entry: 38.152, entryDate: "2025-01-08", exit: 24.956, exitDate: "2025-03-02" },
    { dir: "short", entry: 23.422, entryDate: "2025-07-30", exit: 23.344, exitDate: "2025-08-07" },
    { dir: "long", entry: 24.675, entryDate: "2025-08-12", exit: 22.346, exitDate: "2025-08-19" },
    { dir: "short", entry: 23.402, entryDate: "2025-08-26", exit: 25.983, exitDate: "2025-09-09" },
    { dir: "long", entry: 30.722, entryDate: "2025-10-01", exit: 27.912, exitDate: "2025-10-07" },
    { dir: "long", entry: 14.735, entryDate: "2025-12-04", exit: 13.1, exitDate: "2025-12-12" },
  ];

  console.log("\n=== Trade Matching (Config B) ===");
  for (const tvT of tvTrades) {
    const match = resultB.trades!.find(t =>
      t.direction === tvT.dir && t.entryTime!.startsWith(tvT.entryDate)
    );
    console.log(`TV ${tvT.dir} ${tvT.entryDate}: ${match ? `MATCH entry ${tvT.entry} vs ${match.entryPrice}` : "MISSING"}`);
  }
}
main().catch(console.error);

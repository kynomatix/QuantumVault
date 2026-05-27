/**
 * Gate bisection harness for golden-001 (VSS).
 *
 * Runs the VSS script with progressively-relaxed `longSetup` definitions,
 * to find which gate evaluates `true` enough to fire any trades on ETH 1H.
 *
 * READ-ONLY — no fixture writes, no engine edits.
 *
 * Usage:
 *   npx tsx server/lab/pine/debug-gates.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compilePine } from "./index.js";
import { executePine, type PineEngineConfig } from "./runtime.js";
import { getCachedCandles, saveCandlesToDb } from "../candle-store.js";
import { fetchOHLCV } from "../datafeed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FIXTURE = path.resolve(__dirname, "fixtures/golden-001");
const ORIG = fs.readFileSync(path.join(FIXTURE, "script.pine"), "utf8");
const PARAMS = JSON.parse(fs.readFileSync(path.join(FIXTURE, "params.json"), "utf8"));

const ORIG_LONGSETUP =
  "bool longSetup  = snapLong  and rsiWasOS and rsiTurningUp and emaLongOk  and volOk and cooldownOk and inDateRange and allowLong  and strategy.position_size == 0";

const VARIANTS: Array<{ name: string; longSetup: string }> = [
  { name: "T0_always_true",            longSetup: "bool longSetup = strategy.position_size == 0" },
  { name: "T1_inDateRange_only",       longSetup: "bool longSetup = inDateRange and strategy.position_size == 0" },
  { name: "T2_snapLong_only",          longSetup: "bool longSetup = snapLong and strategy.position_size == 0" },
  { name: "T3_snap_and_rsiWasOS",      longSetup: "bool longSetup = snapLong and rsiWasOS and strategy.position_size == 0" },
  { name: "T4_snap_rsi_turn",          longSetup: "bool longSetup = snapLong and rsiWasOS and rsiTurningUp and strategy.position_size == 0" },
  { name: "T5_add_cooldown",           longSetup: "bool longSetup = snapLong and rsiWasOS and rsiTurningUp and cooldownOk and strategy.position_size == 0" },
  { name: "T6_add_inDateRange",        longSetup: "bool longSetup = snapLong and rsiWasOS and rsiTurningUp and cooldownOk and inDateRange and strategy.position_size == 0" },
  { name: "T7_full_original",          longSetup: ORIG_LONGSETUP },
];

function variantSource(longSetup: string): string {
  if (!ORIG.includes(ORIG_LONGSETUP)) {
    throw new Error("Original longSetup line not found in script.pine — update ORIG_LONGSETUP literal.");
  }
  return ORIG.replace(ORIG_LONGSETUP, longSetup);
}

async function main() {
  // Window: same as fixture
  const startMs = Date.UTC(2022, 11, 31, 11);
  const endMs   = Date.UTC(2026, 4, 20, 10);
  const symbol = "ETH/USDT:USDT", timeframe = "1h";

  let candles: any = await getCachedCandles(symbol, timeframe, startMs, endMs);
  if (!candles || candles.length < 50) {
    console.log("[candles] miss — fetching");
    candles = await (fetchOHLCV as any)(symbol, timeframe, startMs, endMs);
    if (candles?.length) await saveCandlesToDb(symbol, timeframe, candles);
  }
  console.log(`[candles] ${candles.length} bars (${new Date(candles[0].time).toISOString()} → ${new Date(candles[candles.length-1].time).toISOString()})`);

  const config: PineEngineConfig = { initialCapital: 100, commission: 0.001, positionSize: 100, processOrdersOnClose: false };

  console.log(`\n${"variant".padEnd(28)} ${"trades".padStart(8)} ${"net%".padStart(10)} ${"wr%".padStart(8)} ${"first entry".padStart(22)}`);
  console.log("-".repeat(80));

  for (const v of VARIANTS) {
    const src = variantSource(v.longSetup);
    let plan;
    try { plan = compilePine(src); } catch (e: any) { console.log(`${v.name.padEnd(28)} compile error: ${e.message}`); continue; }
    let r: any;
    try { r = executePine(plan.ast, candles, PARAMS, symbol, timeframe, config); }
    catch (e: any) { console.log(`${v.name.padEnd(28)} runtime error: ${e.message}`); continue; }
    const firstEntry = r.trades?.[0]?.entryTime ?? "—";
    console.log(`${v.name.padEnd(28)} ${String(r.totalTrades).padStart(8)} ${r.netProfitPercent.toFixed(2).padStart(10)} ${r.winRatePercent.toFixed(2).padStart(8)} ${String(firstEntry).padStart(22)}`);
  }
  console.log("\nDone.");
}

main().catch(e => { console.error(e); process.exit(1); });

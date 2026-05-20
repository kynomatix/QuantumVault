import { compilePine, runPineBacktest } from "./index";
import { fetchOHLCV } from "../datafeed";
import { TA_WHITELIST } from "./compiler";
import { TA_IMPL_REGISTRY } from "./runtime";

// One Pine snippet per newly added ta.* function. Each script just needs to
// compile + execute without throwing and (for indicator-based ones) ideally
// produce at least one non-NA value on a real OHLCV series.
const CASES: { name: string; code: string }[] = [
  { name: "obv",         code: `v = ta.obv\nif v > v[1]\n    strategy.entry("L", strategy.long)` },
  { name: "accdist",     code: `v = ta.accdist\nif v > v[1]\n    strategy.entry("L", strategy.long)` },
  { name: "ad_alias",    code: `v = ta.ad\nif v > v[1]\n    strategy.entry("L", strategy.long)` },
  { name: "pvt",         code: `v = ta.pvt\nif v > v[1]\n    strategy.entry("L", strategy.long)` },
  { name: "nvi",         code: `v = ta.nvi\nif v > v[1]\n    strategy.entry("L", strategy.long)` },
  { name: "pvi",         code: `v = ta.pvi\nif v > v[1]\n    strategy.entry("L", strategy.long)` },
  { name: "iii",         code: `v = ta.iii\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "wad",         code: `v = ta.wad\nif v > v[1]\n    strategy.entry("L", strategy.long)` },
  { name: "bop",         code: `v = ta.bop\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "mom",         code: `v = ta.mom(close, 10)\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "wpr",         code: `v = ta.wpr(14)\nif v > -50\n    strategy.entry("L", strategy.long)` },
  { name: "cmo",         code: `v = ta.cmo(close, 9)\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "bbw",         code: `v = ta.bbw(close, 20, 2.0)\nif v > 0.01\n    strategy.entry("L", strategy.long)` },
  { name: "kcw",         code: `v = ta.kcw(close, 20, 1.5)\nif v > 0.01\n    strategy.entry("L", strategy.long)` },
  { name: "highestbars", code: `v = ta.highestbars(high, 14)\nif v == 0\n    strategy.entry("L", strategy.long)` },
  { name: "lowestbars",  code: `v = ta.lowestbars(low, 14)\nif v == 0\n    strategy.entry("L", strategy.long)` },
  { name: "range",       code: `v = ta.range(close, 14)\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "variance",    code: `v = ta.variance(close, 14)\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "correlation", code: `v = ta.correlation(close, volume, 20)\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "pearsonr",    code: `v = ta.pearsonr(close, volume, 20)\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "cog",         code: `v = ta.cog(close, 10)\nif v < 0\n    strategy.entry("L", strategy.long)` },
  { name: "aroon",       code: `[u, l] = ta.aroon(14)\nif u > l\n    strategy.entry("L", strategy.long)` },
  { name: "tsi",         code: `v = ta.tsi(close, 13, 25)\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "vortex",      code: `[vp, vm] = ta.vortex(14)\nif vp > vm\n    strategy.entry("L", strategy.long)` },
  { name: "mode",        code: `v = ta.mode(close, 14)\nif v > 0\n    strategy.entry("L", strategy.long)` },
  { name: "sar",         code: `v = ta.sar(0.02, 0.02, 0.2)\nif close > v\n    strategy.entry("L", strategy.long)` },
];

function header(name: string): string {
  return `//@version=5\nstrategy("ta.${name} smoke", overlay=true, initial_capital=10000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)\n`;
}

async function main() {
  // T003 parity guard.
  console.log(`=== TA registry parity ===`);
  const missing = [...TA_WHITELIST].filter(n => !TA_IMPL_REGISTRY.has(n));
  const orphan = [...TA_IMPL_REGISTRY].filter(n => !TA_WHITELIST.has(n));
  if (missing.length || orphan.length) {
    console.error(`PARITY FAIL: whitelist−registry=[${missing.join(",")}] registry−whitelist=[${orphan.join(",")}]`);
    process.exit(1);
  }
  console.log(`PARITY OK: ${TA_WHITELIST.size} entries`);

  const ticker = "SOL/USDT:USDT";
  const timeframe = "5m";
  const candles = await fetchOHLCV(ticker, timeframe, 500);
  if (!candles || candles.length < 50) {
    console.log("Not enough candles");
    process.exit(1);
  }
  console.log(`Bars: ${candles.length}`);

  const config = { initialCapital: 10000, commission: 0.0005, positionSize: 100, processOrdersOnClose: false };

  let pass = 0, fail = 0;
  for (const c of CASES) {
    const code = header(c.name) + c.code + "\n";
    try {
      const plan = compilePine(code);
      const result = runPineBacktest(plan, candles, {}, ticker, timeframe, config);
      console.log(`  [PASS] ta.${c.name}: path=${result.compiledPath} trades=${result.totalTrades}`);
      pass++;
    } catch (e: any) {
      console.error(`  [FAIL] ta.${c.name}: ${e?.message || e}`);
      fail++;
    }
  }
  console.log(`=== ${pass}/${CASES.length} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 2);
}

main().catch(e => { console.error(e); process.exit(1); });

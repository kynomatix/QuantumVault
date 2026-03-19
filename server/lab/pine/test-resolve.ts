import { compilePine } from "./index";
import { fetchOHLCV } from "../datafeed";
import { executePine } from "./runtime";

async function main() {
  const candles = await fetchOHLCV("SOL/USDT", "2h", "2022-12-31", "2026-03-19");
  console.log(`Got ${candles.length} candles`);

  function run(label: string, code: string) {
    try {
      const plan = compilePine(code);
      const result = executePine(plan.ast, candles, {}, "SOL/USDT", "2h", {
        initialCapital: 100, commission: 0.0005, positionSize: 100, processOrdersOnClose: true,
      });
      console.log(`${label}: ${result.totalTrades} trades`);
    } catch (e: any) {
      console.log(`${label}: ERROR - ${e.message}`);
    }
  }

  // Does input resolution work for pivothigh?
  run("A: inline pivothigh(18,18)", `
//@version=5
strategy("T", overlay=true, process_orders_on_close=true)
float ph = ta.pivothigh(18, 18)
var int count = 0
if not na(ph)
    count := count + 1
if count == 5
    strategy.entry("L", strategy.long)
`);

  run("B: input pivothigh(i_pl, i_pl)", `
//@version=5
strategy("T", overlay=true, process_orders_on_close=true)
i_pl = input.int(18, "PL")
float ph = ta.pivothigh(i_pl, i_pl)
var int count = 0
if not na(ph)
    count := count + 1
if count == 5
    strategy.entry("L", strategy.long)
`);

  // Does shifted series work with inputs?
  run("C: inline high[18]", `
//@version=5
strategy("T", overlay=true, process_orders_on_close=true)
float ph = ta.pivothigh(18, 18)
float ph_price = high[18]
float t_ema = ta.ema(close, 146)
float ph_ema = t_ema[18]
var int ms = 0
var float m_p1 = na
if not na(ph)
    if ms == 0
        if ph_price > ph_ema
            ms := 1
            m_p1 := ph_price
if ms == 1
    strategy.entry("S", strategy.short)
    ms := 0
`);

  run("D: input high[i_pl]", `
//@version=5
strategy("T", overlay=true, process_orders_on_close=true)
i_pl = input.int(18, "PL")
i_ema_len = input.int(146, "EMA")
float ph = ta.pivothigh(i_pl, i_pl)
float ph_price = high[i_pl]
float t_ema = ta.ema(close, i_ema_len)
float ph_ema = t_ema[i_pl]
var int ms = 0
var float m_p1 = na
if not na(ph)
    if ms == 0
        if ph_price > ph_ema
            ms := 1
            m_p1 := ph_price
if ms == 1
    strategy.entry("S", strategy.short)
    ms := 0
`);
}

main().catch(e => { console.error(e.stack || e); process.exit(1); });

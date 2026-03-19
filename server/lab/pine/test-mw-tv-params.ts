import { compilePine } from "./index.js";
import { executePine } from "./runtime.js";
import { getCachedCandles, saveCandlesToDb } from "../candle-store.js";
import { fetchOHLCV } from "../datafeed.js";

async function getCandles(symbol: string, timeframe: string, startDate: string = "2022-12-31T00:00:00Z") {
  const now = Date.now();
  const startMs = new Date(startDate).getTime();
  const cached = await getCachedCandles(symbol, timeframe, startMs, now);
  if (cached && cached.length > 1000) {
    console.log(`[CandleCache] Hit: ${cached.length} candles for ${symbol} ${timeframe}`);
    return cached;
  }
  console.log(`[CandleCache] Miss — fetching from exchange...`);
  const fresh = await fetchOHLCV(symbol, timeframe, startMs, now);
  await saveCandlesToDb(symbol, timeframe, fresh);
  return fresh;
}

const pineCode = `
//@version=5
strategy("MW Reversal v2 [Kryptolytix]", overlay=true, initial_capital=100,
     default_qty_type=strategy.cash, default_qty_value=100,
     commission_type=strategy.commission.percent,
     commission_value=0.05, slippage=1, calc_on_every_tick=false,
     process_orders_on_close=true)

i_pivot_len     = input.int   (19,    "Pivot Length",               minval=10,  maxval=20)
i_sym_pct       = input.float (2.25,  "Symmetry Tolerance %",       minval=0.5, maxval=3.0,  step=0.25)
i_weak_second   = input.bool  (false, "Require Weaker Second Test")
i_trend_ema     = input.int   (173,   "Trend EMA Length",           minval=80,  maxval=200)
i_ema_slope     = input.bool  (false, "Require EMA Slope")
i_ema_slope_len = input.int   (10,    "EMA Slope Lookback",         minval=2,   maxval=15)
i_rsi_len       = input.int   (10,    "RSI Length",                 minval=7,   maxval=21)
i_rsi_div       = input.bool  (true,  "Require RSI Divergence")
i_retest        = input.bool  (false, "Retest Entry")
i_retest_bars   = input.int   (12,    "Retest Window (bars)",       minval=2,   maxval=12)
i_ma_filter     = input.bool  (false, "MA Confluence Filter")
i_ma_len        = input.int   (184,   "MA Length",                  minval=90,  maxval=200)

i_atr_len     = input.int   (16,    "ATR Length",                minval=16,  maxval=21)
i_sl_mult     = input.float (1.25,  "SL ATR Buffer",             minval=0.75, maxval=2.0, step=0.25)
i_min_mm_atr  = input.float (0.5,   "Min Pattern Height (ATR*)", minval=0.5,  maxval=4.0, step=0.25)

i_tp1_frac    = input.float (0.5,   "TP1 Fraction of Measured Move", minval=0.25, maxval=0.5,  step=0.05)
i_tp1_qty     = input.float (65.0,  "TP1 Close % of Position",       minval=35.0, maxval=65.0, step=5.0)
i_tp2_qty     = input.float (80.0,  "TP2 Close % of Remaining",      minval=50.0, maxval=80.0, step=5.0)

i_trail_mult  = input.float (0.5,   "Trail ATR Multiplier",    minval=0.5,  maxval=3.5,  step=0.25)
i_tighten     = input.bool  (true,  "Tighten Trail After TP2")
i_tighten_pct = input.float (45.0,  "Tighten % After TP2",     minval=30.0, maxval=55.0, step=5.0)

float rsi         = ta.rsi(close, i_rsi_len)
float atr         = ta.atr(i_atr_len)
float t_ema       = ta.ema(close, i_trend_ema)
float c_ma        = ta.ema(close, i_ma_len)
float ph          = ta.pivothigh(i_pivot_len, i_pivot_len)
float pl          = ta.pivotlow (i_pivot_len, i_pivot_len)

float ph_price    = high [i_pivot_len]
float ph_rsi      = rsi  [i_pivot_len]
float ph_ema      = t_ema[i_pivot_len]
float ph_ema_old  = t_ema[i_pivot_len + i_ema_slope_len]
float pl_price    = low  [i_pivot_len]
float pl_rsi      = rsi  [i_pivot_len]
float pl_ema      = t_ema[i_pivot_len]
float pl_ema_old  = t_ema[i_pivot_len + i_ema_slope_len]

float lowest_piv  = ta.lowest (low,  i_pivot_len)
float highest_piv = ta.highest(high, i_pivot_len)

bool ph_ema_falling = ph_ema < ph_ema_old
bool pl_ema_rising  = pl_ema > pl_ema_old

var int   ms        = 0
var float m_p1      = na
var int   m_p1_bar  = na
var float m_p1_rsi  = na
var float m_neck    = na
var float m_nrun    = na
var float m_p2      = na
var int   m_p2_bar  = na
var bool  m_broken  = false
var int   m_brkbar  = na
var bool  m_touched = false

var int   ws        = 0
var float w_t1      = na
var int   w_t1_bar  = na
var float w_t1_rsi  = na
var float w_neck    = na
var float w_nrun    = na
var float w_t2      = na
var int   w_t2_bar  = na
var bool  w_broken  = false
var int   w_brkbar  = na
var bool  w_touched = false

var int   last_entry_bar = -1
var bool  tp1_hit        = false
var bool  tp2_hit        = false
var float entry_price    = na
var float tp1_level      = na
var float tp2_level      = na
var float trail_best     = na
var float current_sl     = na

if ms == 1
    m_nrun := na(m_nrun) ? low : math.min(m_nrun, low)
if ws == 1
    w_nrun := na(w_nrun) ? high : math.max(w_nrun, high)

if not na(ph)
    int p_bar = bar_index - i_pivot_len

    if ms == 0
        bool slope_ok = i_ema_slope ? ph_ema_falling : true
        if ph_price > ph_ema and slope_ok
            ms       := 1
            m_p1     := ph_price
            m_p1_bar := p_bar
            m_p1_rsi := ph_rsi
            m_nrun   := lowest_piv

    else if ms == 1
        float sym_hi = m_p1 * (1.0 + i_sym_pct / 100.0)
        float sym_lo = m_p1 * (1.0 - i_sym_pct / 100.0)

        if ph_price > sym_hi
            bool slope_ok = i_ema_slope ? ph_ema_falling : true
            if ph_price > ph_ema and slope_ok
                m_p1     := ph_price
                m_p1_bar := p_bar
                m_p1_rsi := ph_rsi
                m_nrun   := lowest_piv
            else
                ms     := 0
                m_p1   := na
                m_nrun := na

        else if not na(m_nrun)
            bool in_range = ph_price >= sym_lo
            bool weak_ok  = i_weak_second ? ph_price < m_p1 : true
            bool rsi_ok   = i_rsi_div ? ph_rsi < m_p1_rsi : true
            bool abv_neck = ph_price > m_nrun

            if in_range and weak_ok and rsi_ok and abv_neck
                ms       := 2
                m_p2     := ph_price
                m_p2_bar := p_bar
                m_neck   := m_nrun
            else
                bool slope_ok = i_ema_slope ? ph_ema_falling : true
                if ph_price > ph_ema and slope_ok
                    m_p1     := ph_price
                    m_p1_bar := p_bar
                    m_p1_rsi := ph_rsi
                    m_nrun   := lowest_piv
                else
                    ms     := 0
                    m_p1   := na
                    m_nrun := na

if not na(pl)
    int p_bar = bar_index - i_pivot_len

    if ws == 0
        bool slope_ok = i_ema_slope ? pl_ema_rising : true
        if pl_price < pl_ema and slope_ok
            ws       := 1
            w_t1     := pl_price
            w_t1_bar := p_bar
            w_t1_rsi := pl_rsi
            w_nrun   := highest_piv

    else if ws == 1
        float sym_lo = w_t1 * (1.0 - i_sym_pct / 100.0)
        float sym_hi = w_t1 * (1.0 + i_sym_pct / 100.0)

        if pl_price < sym_lo
            bool slope_ok = i_ema_slope ? pl_ema_rising : true
            if pl_price < pl_ema and slope_ok
                w_t1     := pl_price
                w_t1_bar := p_bar
                w_t1_rsi := pl_rsi
                w_nrun   := highest_piv
            else
                ws     := 0
                w_t1   := na
                w_nrun := na

        else if not na(w_nrun)
            bool in_range = pl_price <= sym_hi
            bool weak_ok  = i_weak_second ? pl_price > w_t1 : true
            bool rsi_ok   = i_rsi_div ? pl_rsi > w_t1_rsi : true
            bool blw_neck = pl_price < w_nrun

            if in_range and weak_ok and rsi_ok and blw_neck
                ws       := 2
                w_t2     := pl_price
                w_t2_bar := p_bar
                w_neck   := w_nrun
            else
                bool slope_ok = i_ema_slope ? pl_ema_rising : true
                if pl_price < pl_ema and slope_ok
                    w_t1     := pl_price
                    w_t1_bar := p_bar
                    w_t1_rsi := pl_rsi
                    w_nrun   := highest_piv
                else
                    ws     := 0
                    w_t1   := na
                    w_nrun := na

if ms == 2 and not m_broken and barstate.isconfirmed
    if close > math.max(m_p1, m_p2) + atr
        ms        := 0
        m_p1      := na
        m_neck    := na
        m_nrun    := na
        m_broken  := false
        m_touched := false

if ws == 2 and not w_broken and barstate.isconfirmed
    if close < math.min(w_t1, w_t2) - atr
        ws        := 0
        w_t1      := na
        w_neck    := na
        w_nrun    := na
        w_broken  := false
        w_touched := false

if ms == 2 and strategy.position_size == 0 and last_entry_bar != bar_index and barstate.isconfirmed
    if not m_broken
        if close < m_neck
            float mm_raw = math.max(m_p1, m_p2) - m_neck
            if mm_raw >= i_min_mm_atr * atr
                if not i_retest
                    bool ma_ok = i_ma_filter ? close < c_ma : true
                    if ma_ok
                        strategy.entry("Short", strategy.short)
                        entry_price    := close
                        current_sl     := math.max(m_p1, m_p2) + i_sl_mult * atr
                        tp1_level      := close - mm_raw * i_tp1_frac
                        tp2_level      := close - mm_raw
                        trail_best     := close
                        tp1_hit        := false
                        tp2_hit        := false
                        last_entry_bar := bar_index
                        ms             := 0
                        m_p1           := na
                        m_neck         := na
                        m_nrun         := na
                else
                    m_broken := true
                    m_brkbar := bar_index
    else
        if bar_index - m_brkbar <= i_retest_bars
            if not m_touched and high >= m_neck
                m_touched := true
            if m_touched and close < m_neck
                float mm_raw = math.max(m_p1, m_p2) - m_neck
                bool ma_ok   = i_ma_filter ? close < c_ma : true
                if ma_ok and mm_raw >= i_min_mm_atr * atr
                    strategy.entry("Short", strategy.short)
                    entry_price    := close
                    current_sl     := math.max(m_p1, m_p2) + i_sl_mult * atr
                    tp1_level      := close - mm_raw * i_tp1_frac
                    tp2_level      := close - mm_raw
                    trail_best     := close
                    tp1_hit        := false
                    tp2_hit        := false
                    last_entry_bar := bar_index
                    ms             := 0
                    m_p1           := na
                    m_neck         := na
                    m_nrun         := na
                    m_broken       := false
                    m_touched      := false
        else
            ms        := 0
            m_p1      := na
            m_neck    := na
            m_nrun    := na
            m_broken  := false
            m_touched := false

if ws == 2 and strategy.position_size == 0 and last_entry_bar != bar_index and barstate.isconfirmed
    if not w_broken
        if close > w_neck
            float mm_raw = w_neck - math.min(w_t1, w_t2)
            if mm_raw >= i_min_mm_atr * atr
                if not i_retest
                    bool ma_ok = i_ma_filter ? close > c_ma : true
                    if ma_ok
                        strategy.entry("Long", strategy.long)
                        entry_price    := close
                        current_sl     := math.min(w_t1, w_t2) - i_sl_mult * atr
                        tp1_level      := close + mm_raw * i_tp1_frac
                        tp2_level      := close + mm_raw
                        trail_best     := close
                        tp1_hit        := false
                        tp2_hit        := false
                        last_entry_bar := bar_index
                        ws             := 0
                        w_t1           := na
                        w_neck         := na
                        w_nrun         := na
                else
                    w_broken := true
                    w_brkbar := bar_index
    else
        if bar_index - w_brkbar <= i_retest_bars
            if not w_touched and low <= w_neck
                w_touched := true
            if w_touched and close > w_neck
                float mm_raw = w_neck - math.min(w_t1, w_t2)
                bool ma_ok   = i_ma_filter ? close > c_ma : true
                if ma_ok and mm_raw >= i_min_mm_atr * atr
                    strategy.entry("Long", strategy.long)
                    entry_price    := close
                    current_sl     := math.min(w_t1, w_t2) - i_sl_mult * atr
                    tp1_level      := close + mm_raw * i_tp1_frac
                    tp2_level      := close + mm_raw
                    trail_best     := close
                    tp1_hit        := false
                    tp2_hit        := false
                    last_entry_bar := bar_index
                    ws             := 0
                    w_t1           := na
                    w_neck         := na
                    w_nrun         := na
                    w_broken       := false
                    w_touched      := false
        else
            ws        := 0
            w_t1      := na
            w_neck    := na
            w_nrun    := na
            w_broken  := false
            w_touched := false

bool is_long  = strategy.position_size > 0
bool is_short = strategy.position_size < 0
bool in_pos   = is_long or is_short

if in_pos and barstate.isconfirmed

    if is_long
        trail_best := na(trail_best) ? close : math.max(trail_best, close)
    if is_short
        trail_best := na(trail_best) ? close : math.min(trail_best, close)

    float live_mult = (i_tighten and tp2_hit) ? i_trail_mult * (1.0 - i_tighten_pct / 100.0) : i_trail_mult
    float trail_sl  = is_long ? trail_best - live_mult * atr : trail_best + live_mult * atr

    if not tp1_hit
        if (is_long and close >= tp1_level) or (is_short and close <= tp1_level)
            strategy.close("Long",  qty_percent=i_tp1_qty, comment="TP1")
            strategy.close("Short", qty_percent=i_tp1_qty, comment="TP1")
            tp1_hit    := true
            current_sl := entry_price

    if tp1_hit and not tp2_hit
        if (is_long and close >= tp2_level) or (is_short and close <= tp2_level)
            strategy.close("Long",  qty_percent=i_tp2_qty, comment="TP2")
            strategy.close("Short", qty_percent=i_tp2_qty, comment="TP2")
            tp2_hit := true

    float effective_sl = tp1_hit ? (is_long ? math.max(current_sl, trail_sl) : math.min(current_sl, trail_sl)) : current_sl

    if is_long and close <= effective_sl
        strategy.close("Long",  comment=tp1_hit ? "Trail/BE" : "SL")
    if is_short and close >= effective_sl
        strategy.close("Short", comment=tp1_hit ? "Trail/BE" : "SL")
`;

async function main() {
  console.log("Compiling Pine...");
  const plan = compilePine(pineCode);
  console.log("Compiled OK");
  
  console.log("Fetching candles...");
  const candles = await getCandles("SOL/USDT", "2h");
  console.log(`Got ${candles.length} candles`);
  console.log(`First: ${new Date(candles[0].time).toISOString()} O=${candles[0].open}`);
  console.log(`Last:  ${new Date(candles[candles.length-1].time).toISOString()} O=${candles[candles.length-1].open}`);

  console.log("\nRunning interpreter...");
  (globalThis as any).__PINE_DEBUG_ENTRIES = false;
  const config = { initialCapital: 100, commission: 0.0005, positionSize: 100, processOrdersOnClose: true };
  const result = executePine(plan.ast, candles, {}, "SOL/USDT", "2h", config);
  (globalThis as any).__PINE_DEBUG_ENTRIES = false;
  
  console.log(`\n=== QV Results ===`);
  console.log(`Total trade records: ${result.trades.length}`);
  console.log(`Net profit: ${result.netProfitPercent?.toFixed(2)}%`);
  console.log(`Win rate: ${result.winRatePercent?.toFixed(2)}%`);
  console.log(`Profit factor: ${result.profitFactor?.toFixed(1)}`);
  console.log(`Max drawdown: ${result.maxDrawdownPercent?.toFixed(2)}%`);
  
  const seen = new Set<string>();
  const uniqueEntries: any[] = [];
  for (const t of result.trades) {
    const key = `${t.direction}_${t.entryTime}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueEntries.push(t);
    }
  }
  console.log(`Unique entries: ${uniqueEntries.length}`);
  
  console.log(`\n=== QV Unique Entries ===`);
  for (let i = 0; i < uniqueEntries.length; i++) {
    const t = uniqueEntries[i];
    const d = new Date(t.entryTime);
    const dateStr = d.toISOString().replace("T", " ").substring(0, 19);
    const relatedTrades = result.trades.filter((tr: any) => tr.entryTime === t.entryTime && tr.direction === t.direction);
    const totalPnlDollar = relatedTrades.reduce((s: number, tr: any) => s + (tr.pnlDollar || 0), 0);
    const exitReasons = relatedTrades.map((tr: any) => `${tr.exitReason}:${tr.pnlDollar?.toFixed(2)}`);
    console.log(`QV#${(i+1).toString().padStart(2)} ${t.direction.padEnd(6)} ${dateStr} @ ${t.entryPrice.toFixed(2).padStart(8)} $PnL:${totalPnlDollar.toFixed(2).padStart(8)} [${exitReasons.join(', ')}]`);
  }

  console.log(`\n=== TV Unique Entries (from XLSX Properties) ===`);
  console.log("TV params: i_pivot_len=19, i_sym_pct=2.25, i_rsi_len=10, i_trend_ema=173");
  console.log("TV params: i_sl_mult=1.25, i_min_mm_atr=0.5, i_tp1_frac=0.5");
  console.log("TV params: i_tp1_qty=65, i_tp2_qty=80, i_trail_mult=0.5");
  console.log("TV params: i_tighten=true, i_tighten_pct=45, i_ema_slope=false");
  console.log("TV params: i_retest=false, i_ma_filter=false, i_ma_len=184");
}

main().catch(console.error);

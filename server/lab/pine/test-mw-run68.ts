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

i_pivot_len     = input.int   (12,   "Pivot Length",               minval=10,  maxval=20)
i_sym_pct       = input.float (2.25,  "Symmetry Tolerance %",       minval=0.5, maxval=3.0,  step=0.25)
i_weak_second   = input.bool  (true,"Require Weaker Second Test")
i_trend_ema     = input.int   (80,  "Trend EMA Length",           minval=80,  maxval=200)
i_ema_slope     = input.bool  (false, "Require EMA Slope")
i_ema_slope_len = input.int   (10,    "EMA Slope Lookback",         minval=2,   maxval=15)
i_rsi_len       = input.int   (10,   "RSI Length",                 minval=7,   maxval=21)
i_rsi_div       = input.bool  (true, "Require RSI Divergence")
i_retest        = input.bool  (false, "Retest Entry")
i_retest_bars   = input.int   (12,    "Retest Window (bars)",       minval=2,   maxval=12)
i_ma_filter     = input.bool  (false, "MA Confluence Filter")
i_ma_len        = input.int   (184,  "MA Length",                  minval=90,  maxval=200)

i_atr_len     = input.int   (20,   "ATR Length",                minval=16,  maxval=21)
i_sl_mult     = input.float (0.75, "SL ATR Buffer",             minval=0.75, maxval=2.0, step=0.25)
i_min_mm_atr  = input.float (2.5,  "Min Pattern Height (ATR*)", minval=0.5,  maxval=4.0, step=0.25)

i_tp1_frac    = input.float (0.5, "TP1 Fraction of Measured Move", minval=0.25, maxval=0.5,  step=0.05)
i_tp1_qty     = input.float (65.0, "TP1 Close % of Position",       minval=35.0, maxval=65.0, step=5.0)
i_tp2_qty     = input.float (80.0, "TP2 Close % of Remaining",      minval=50.0, maxval=80.0, step=5.0)

i_trail_mult  = input.float (2.5,  "Trail ATR Multiplier",    minval=0.5,  maxval=3.5,  step=0.25)
i_tighten     = input.bool  (true, "Tighten Trail After TP2")
i_tighten_pct = input.float (45.0, "Tighten % After TP2",     minval=30.0, maxval=55.0, step=5.0)

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

const TV_ENTRIES = [
  { date: "2023-02-16 07:00", dir: "Long",  price: 23.02 },
  { date: "2023-04-11 16:00", dir: "Long",  price: 22.00 },
  { date: "2023-04-26 20:00", dir: "Long",  price: 22.33 },
  { date: "2023-05-12 00:00", dir: "Short", price: 20.19 },
  { date: "2023-06-27 08:00", dir: "Short", price: 16.06 },
  { date: "2023-06-30 00:00", dir: "Long",  price: 17.61 },
  { date: "2023-07-18 04:00", dir: "Short", price: 26.05 },
  { date: "2023-08-01 14:00", dir: "Short", price: 23.39 },
  { date: "2023-08-22 08:00", dir: "Short", price: 21.33 },
  { date: "2023-09-10 16:00", dir: "Short", price: 18.38 },
  { date: "2023-10-05 03:00", dir: "Short", price: 22.69 },
  { date: "2024-02-29 01:00", dir: "Long",  price: 113.11 },
  { date: "2024-04-11 00:00", dir: "Short", price: 165.87 },
  { date: "2024-06-05 12:00", dir: "Long",  price: 173.26 },
  { date: "2024-08-28 08:00", dir: "Short", price: 149.21 },
  { date: "2024-11-17 17:00", dir: "Long",  price: 236.68 },
  { date: "2024-11-24 23:00", dir: "Short", price: 248.54 },
  { date: "2024-12-09 21:00", dir: "Short", price: 226.90 },
  { date: "2025-01-02 17:00", dir: "Long",  price: 204.64 },
  { date: "2025-01-08 03:00", dir: "Short", price: 207.76 },
  { date: "2025-01-27 11:00", dir: "Short", price: 240.49 },
  { date: "2025-02-17 11:00", dir: "Short", price: 188.21 },
  { date: "2025-03-10 01:00", dir: "Short", price: 133.12 },
  { date: "2025-05-08 20:00", dir: "Long",  price: 154.59 },
  { date: "2025-06-16 12:00", dir: "Long",  price: 156.45 },
  { date: "2025-07-10 02:00", dir: "Long",  price: 153.92 },
  { date: "2025-08-24 14:00", dir: "Long",  price: 209.13 },
  { date: "2025-10-17 07:00", dir: "Short", price: 184.92 },
  { date: "2025-11-05 19:00", dir: "Short", price: 156.39 },
  { date: "2025-11-30 07:00", dir: "Short", price: 135.61 },
  { date: "2025-12-16 03:00", dir: "Short", price: 126.76 },
  { date: "2026-01-02 15:00", dir: "Long",  price: 127.50 },
  { date: "2026-01-12 15:00", dir: "Long",  price: 142.49 },
  { date: "2026-01-19 11:00", dir: "Short", price: 137.79 },
  { date: "2026-03-16 15:00", dir: "Long",  price: 93.15 },
];

async function main() {
  console.log("Compiling Pine...");
  const plan = compilePine(pineCode);
  console.log("Compiled OK");
  
  console.log("Fetching candles...");
  const candles = await getCandles("SOL/USDT", "2h");
  console.log(`Got ${candles.length} candles`);
  console.log(`First: ${new Date(candles[0].time).toISOString()}`);
  console.log(`Last:  ${new Date(candles[candles.length-1].time).toISOString()}`);

  console.log("\nRunning interpreter...");
  const config = { initialCapital: 100, commission: 0.0005, positionSize: 100, processOrdersOnClose: true };
  const result = executePine(plan.ast, candles, {}, "SOL/USDT", "2h", config);
  
  const seen = new Set<string>();
  const qvEntries: any[] = [];
  for (const t of result.trades) {
    const key = `${t.direction}_${t.entryTime}`;
    if (!seen.has(key)) {
      seen.add(key);
      qvEntries.push(t);
    }
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`QV: ${qvEntries.length} unique entries | TV: ${TV_ENTRIES.length} unique entries`);
  console.log(`QV Net: ${result.netProfitPercent?.toFixed(2)}% | TV Net: 173.12%`);
  console.log(`QV WR: ${result.winRatePercent?.toFixed(2)}% | TV WR: 94.38%`);
  console.log(`${'='.repeat(80)}`);

  console.log(`\n--- Side-by-side comparison ---`);
  
  let qi = 0, ti = 0;
  let matched = 0, qvOnly = 0, tvOnly = 0;
  
  const qvDates = qvEntries.map(e => ({ 
    ts: new Date(e.entryTime).getTime(), 
    date: new Date(e.entryTime).toISOString().replace("T", " ").substring(0, 16),
    dir: e.direction,
    price: e.entryPrice,
    trades: result.trades.filter((tr: any) => tr.entryTime === e.entryTime && tr.direction === e.direction),
  }));
  
  const tvDates = TV_ENTRIES.map(e => ({
    ts: new Date(e.date + ":00Z").getTime(),
    date: e.date,
    dir: e.dir.toLowerCase(),
    price: e.price,
  }));

  const allEvents: any[] = [];
  for (const q of qvDates) allEvents.push({ ...q, src: 'QV' });
  for (const t of tvDates) allEvents.push({ ...t, src: 'TV' });
  allEvents.sort((a, b) => a.ts - b.ts);

  const MATCH_WINDOW_MS = 14 * 3600 * 1000;
  const tvMatched = new Set<number>();
  const qvMatched = new Set<number>();

  
  for (let i = 0; i < qvDates.length; i++) {
    for (let j = 0; j < tvDates.length; j++) {
      if (tvMatched.has(j)) continue;
      const timeDiff = Math.abs(qvDates[i].ts - tvDates[j].ts);
      if (timeDiff <= MATCH_WINDOW_MS && qvDates[i].dir === tvDates[j].dir) {
        qvMatched.add(i);
        tvMatched.add(j);
        break;
      }
    }
  }

  for (let j = 0; j < tvDates.length; j++) {
    const tv = tvDates[j];
    const qIdx = [...qvMatched].find(qi => {
      const q = qvDates[qi];
      return Math.abs(q.ts - tv.ts) <= MATCH_WINDOW_MS && q.dir === tv.dir;
    });
    
    if (qIdx !== undefined) {
      const q = qvDates[qIdx];
      const totalPnl = q.trades.reduce((s: number, tr: any) => s + (tr.pnlDollar || 0), 0);
      const timeDiffH = ((q.ts - tv.ts) / 3600000).toFixed(1);
      console.log(`✓ TV#${(j+1).toString().padStart(2)} ${tv.date} ${tv.dir.padEnd(6)} @${tv.price.toFixed(2).padStart(8)} | QV @${q.price.toFixed(2).padStart(8)} Δt=${timeDiffH}h $PnL=${totalPnl.toFixed(2)}`);
      matched++;
    } else {
      console.log(`✗ TV#${(j+1).toString().padStart(2)} ${tv.date} ${tv.dir.padEnd(6)} @${tv.price.toFixed(2).padStart(8)} | MISSING IN QV`);
      tvOnly++;
    }
  }
  
  for (let i = 0; i < qvDates.length; i++) {
    if (!qvMatched.has(i)) {
      const q = qvDates[i];
      const totalPnl = q.trades.reduce((s: number, tr: any) => s + (tr.pnlDollar || 0), 0);
      console.log(`+ QV#${(i+1).toString().padStart(2)} ${q.date} ${q.dir.padEnd(6)} @${q.price.toFixed(2).padStart(8)} | EXTRA (not in TV) $PnL=${totalPnl.toFixed(2)}`);
      qvOnly++;
    }
  }
  
  console.log(`\n--- Summary ---`);
  console.log(`Matched: ${matched} | TV-only: ${tvOnly} | QV-only: ${qvOnly}`);
  console.log(`Match rate: ${(matched / TV_ENTRIES.length * 100).toFixed(1)}%`);
}

main().catch(console.error);

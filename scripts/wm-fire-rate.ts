// scripts/wm-fire-rate.ts
// Fire-rate gate for Brick 3 Phase 3B: measure W/M detection frequency at three
// RETRACE_MIN_FRAC values (0.30, 0.50, 1.00) across the fleet's cached candle history.
//
// Usage: npx tsx scripts/wm-fire-rate.ts
//
// For each (symbol, timeframe) pair in lab_candle_cache, fetches the last MAX_BARS bars,
// then walks a WINDOW-bar rolling window across every position treating bars[i] as the
// forming bar. Reports fire rate = detections / positions checked.
//
// The actionability criterion (price within 1% of neckline) is what makes this metric
// meaningful: it counts only setups that were actionable AT THAT MOMENT, not all
// historical patterns. A high fire rate here = the detector is overfitting / finding
// noise. A low rate at 0.30 is acceptable; if 0.30 and 0.50 are similar, use 0.50.

import pg from "pg";
import { detectWM } from "../server/ai-trader/wm-detector.js";
import type { OHLCV } from "../server/lab/engine.js";

const { Pool } = pg;

const WINDOW = 400;     // matches INDICATOR_BARS in context-builder.ts
const MAX_BARS = 2000;  // per owner spec
const FRACS = [0.30, 0.50, 1.00];

// Only actual perpetual swap symbols (USDT:USDT), timeframes the AI trader uses.
// BTC/USDT (non-swap) is also included as it has 1d data (only 1d source).
const TARGET_TIMEFRAMES = new Set(["15m", "1h", "4h", "1d"]);

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // Fetch all qualifying (symbol, timeframe) pairs with enough bars.
  const pairsRes = await pool.query<{ symbol: string; timeframe: string; bar_count: string }>(`
    SELECT symbol, timeframe, COUNT(*) as bar_count
    FROM lab_candle_cache
    WHERE timeframe = ANY($1)
    GROUP BY symbol, timeframe
    HAVING COUNT(*) >= 200
    ORDER BY symbol, timeframe
  `, [Array.from(TARGET_TIMEFRAMES)]);

  const pairs = pairsRes.rows;
  console.log(`\n=== W/M Fire-Rate Gate ===`);
  console.log(`Window: ${WINDOW} bars, history: last ${MAX_BARS} bars, pairs: ${pairs.length}`);
  console.log(`All criteria active (barSep [10,60], extremeDelta ≤0.25×ATR, neckline ≥ FRAC×ATR, price ±1% neckline)\n`);

  const header = "symbol".padEnd(22) + "tf".padEnd(5) + "bars".padEnd(7) +
    "FRAC=0.30".padEnd(22) + "FRAC=0.50".padEnd(22) + "FRAC=1.00";
  console.log(header);
  console.log("─".repeat(90));

  const summary: Record<string, { det: number; total: number }[]> = {
    "0.30": [],
    "0.50": [],
    "1.00": [],
  };

  for (const { symbol, timeframe, bar_count } of pairs) {
    const totalInDb = parseInt(bar_count, 10);

    // Fetch last MAX_BARS bars ordered oldest-first.
    const barsRes = await pool.query<{
      time: string; open: string; high: string; low: string; close: string; volume: string;
    }>(`
      SELECT time::float8 as time, open::float8 as open, high::float8 as high,
             low::float8 as low, close::float8 as close, volume::float8 as volume
      FROM lab_candle_cache
      WHERE symbol = $1 AND timeframe = $2
      ORDER BY time DESC
      LIMIT $3
    `, [symbol, timeframe, MAX_BARS]);

    // Reverse to chronological order (oldest first).
    const bars: OHLCV[] = barsRes.rows.reverse().map((r) => ({
      time: parseFloat(r.time),
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
    }));

    if (bars.length < 50) continue;

    const rateCols: string[] = [];

    for (const frac of FRACS) {
      let detections = 0;
      const positions = bars.length - 1; // positions 1..N-1 (each needs at least 1 prior bar)

      for (let i = 1; i < bars.length; i++) {
        const windowStart = Math.max(0, i - WINDOW + 1);
        // bars[i] is the forming bar; bars[windowStart..i-1] are closed.
        const window = bars.slice(windowStart, i + 1);
        const result = detectWM(window, { retraceFrac: frac });
        if (result !== null) detections++;
      }

      const fracKey = frac.toFixed(2);
      summary[fracKey].push({ det: detections, total: positions });

      const pct = ((detections / positions) * 100).toFixed(2);
      rateCols.push(`${pct}% (${detections}/${positions})`.padEnd(22));
    }

    const sym = symbol.padEnd(22);
    const tf = timeframe.padEnd(5);
    const n = Math.min(totalInDb, MAX_BARS).toString().padEnd(7);
    console.log(`${sym}${tf}${n}${rateCols.join("")}`);
  }

  // Aggregate totals across all pairs.
  console.log("\n" + "─".repeat(90));
  const totCols = FRACS.map((frac) => {
    const key = frac.toFixed(2);
    const totDet = summary[key].reduce((a, x) => a + x.det, 0);
    const totPos = summary[key].reduce((a, x) => a + x.total, 0);
    const pct = totPos > 0 ? ((totDet / totPos) * 100).toFixed(2) : "0.00";
    return `${pct}% (${totDet}/${totPos})`.padEnd(22);
  });
  console.log(`${"AGGREGATE".padEnd(22)}${"".padEnd(5)}${"".padEnd(7)}${totCols.join("")}`);
  console.log();

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

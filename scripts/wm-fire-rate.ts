// scripts/wm-fire-rate.ts
// Fire-rate calibration for Brick 3: measure W/M detection frequency across three
// configurations to validate the recency criterion (MAX_PATTERN_AGE_BARS).
//
// Usage: npx tsx scripts/wm-fire-rate.ts
//
// Configs tested (all use RETRACE_MIN_FRAC=0.30; retrace is not the binding gate):
//   A  baseline — no age limit (Infinity), NECKLINE_WINDOW=1.0%
//   B  age-60,   NECKLINE_WINDOW=1.0%
//   C  age-60,   NECKLINE_WINDOW=0.5%
//
// For each (symbol, timeframe) pair in lab_candle_cache, fetches the last MAX_BARS bars,
// then walks a WINDOW-bar rolling window treating bars[i] as the forming bar.
// Fire rate = detections / positions checked (actionable at that exact moment).

import pg from "pg";
import { detectWM } from "../server/ai-trader/wm-detector.js";
import type { OHLCV } from "../server/lab/engine.js";

const { Pool } = pg;

const WINDOW   = 400;    // matches INDICATOR_BARS in context-builder.ts
const MAX_BARS = 2000;   // per owner spec

const CONFIGS = [
  { label: "baseline(no-age,1%)",  maxPatternAgeBars: Infinity, necklineWindow: 0.01  },
  { label: "age-60,NKLN=1%",       maxPatternAgeBars: 60,       necklineWindow: 0.01  },
  { label: "age-60,NKLN=0.5%",     maxPatternAgeBars: 60,       necklineWindow: 0.005 },
] as const;

const TARGET_TIMEFRAMES = new Set(["15m", "1h", "4h", "1d"]);

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const pairsRes = await pool.query<{ symbol: string; timeframe: string; bar_count: string }>(`
    SELECT symbol, timeframe, COUNT(*) as bar_count
    FROM lab_candle_cache
    WHERE timeframe = ANY($1)
    GROUP BY symbol, timeframe
    HAVING COUNT(*) >= 200
    ORDER BY symbol, timeframe
  `, [Array.from(TARGET_TIMEFRAMES)]);

  const pairs = pairsRes.rows;
  const colW = 24;
  console.log(`\n=== W/M Fire-Rate Calibration — Criterion 6 (Recency) ===`);
  console.log(`Window: ${WINDOW} bars, history: last ${MAX_BARS} bars, pairs: ${pairs.length}`);
  console.log(`Retrace: FRAC=0.30 (confirmed not the binding gate in Phase 3B)\n`);

  const labelRow = "symbol".padEnd(22) + "tf".padEnd(5) + "bars".padEnd(7) +
    CONFIGS.map((c) => c.label.padEnd(colW)).join("");
  console.log(labelRow);
  console.log("─".repeat(22 + 5 + 7 + CONFIGS.length * colW));

  const summary = CONFIGS.map(() => ({ det: 0, total: 0 }));

  for (const { symbol, timeframe, bar_count } of pairs) {
    const totalInDb = parseInt(bar_count, 10);

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

    const bars: OHLCV[] = barsRes.rows.reverse().map((r) => ({
      time: parseFloat(r.time),
      open: parseFloat(r.open),
      high: parseFloat(r.high),
      low: parseFloat(r.low),
      close: parseFloat(r.close),
      volume: parseFloat(r.volume),
    }));

    if (bars.length < 50) continue;

    const positions = bars.length - 1;
    const rateCols: string[] = [];

    for (let ci = 0; ci < CONFIGS.length; ci++) {
      const cfg = CONFIGS[ci];
      let detections = 0;

      for (let i = 1; i < bars.length; i++) {
        const windowStart = Math.max(0, i - WINDOW + 1);
        const window = bars.slice(windowStart, i + 1);
        const result = detectWM(window, {
          retraceFrac:      0.30,
          maxPatternAgeBars: cfg.maxPatternAgeBars,
          necklineWindow:    cfg.necklineWindow,
        });
        if (result !== null) detections++;
      }

      summary[ci].det   += detections;
      summary[ci].total += positions;

      const pct = ((detections / positions) * 100).toFixed(2);
      rateCols.push(`${pct}% (${detections}/${positions})`.padEnd(colW));
    }

    const sym = symbol.padEnd(22);
    const tf  = timeframe.padEnd(5);
    const n   = Math.min(totalInDb, MAX_BARS).toString().padEnd(7);
    console.log(`${sym}${tf}${n}${rateCols.join("")}`);
  }

  console.log("\n" + "─".repeat(22 + 5 + 7 + CONFIGS.length * colW));
  const totCols = summary.map(({ det, total }) => {
    const pct = total > 0 ? ((det / total) * 100).toFixed(2) : "0.00";
    return `${pct}% (${det}/${total})`.padEnd(colW);
  });
  console.log(`${"AGGREGATE".padEnd(22)}${"".padEnd(5)}${"".padEnd(7)}${totCols.join("")}`);

  // Decision guidance printed at the end.
  console.log(`\nTarget: aggregate < ~3%, majors (SOL/BTC/ETH 1h-4h) < 5%.`);
  console.log(`If age-60 + NKLN=1% hits target: keep NECKLINE_WINDOW=1.0% (production constant).`);
  console.log(`If not: apply age-60 + NKLN=0.5% — rate in col C is the then-production rate.\n`);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

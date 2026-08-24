import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

const HAS_DB = !!process.env.DATABASE_URL;
const uniqueSymbol = `QV-PROVENANCE-${process.pid}-${Date.now()}`;

afterAll(async () => {
  if (!HAS_DB) return;
  const client = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await client.query("DELETE FROM lab_candle_cache_v2 WHERE symbol = $1", [uniqueSymbol]);
    await client.query("DELETE FROM lab_candle_cache WHERE symbol = $1", [uniqueSymbol]);
  } finally {
    await client.end();
  }
});

describe.runIf(HAS_DB)("provenance-aware candle cache on real PostgreSQL", () => {
  it("is idempotent, leaves legacy rows unchanged, separates identity, and never reads legacy as authority", async () => {
    const { ensureSchema, pool } = await import("../../server/db");
    const legacyBefore = Number((await pool.query("SELECT count(*) AS n FROM lab_candle_cache")).rows[0].n);
    await ensureSchema();
    await ensureSchema();
    const legacyAfter = Number((await pool.query("SELECT count(*) AS n FROM lab_candle_cache")).rows[0].n);
    expect(legacyAfter).toBe(legacyBefore);

    const time = Date.now() - 3_600_000;
    const common = [uniqueSymbol, "1h", String(time), 100, 101, 99, 100, 1];
    await pool.query(
      `INSERT INTO lab_candle_cache_v2
       (symbol,timeframe,time,open,high,low,close,volume,source,venue,basis,proxy,finality,time_semantic)
       VALUES
       ($1,$2,$3,$4,$5,$6,$7,$8,'okx','okx','perp','direct','finalized','open_time'),
       ($1,$2,$3,$4,$5,$6,$7,$8,'okx','okx','perp','direct','forming','open_time'),
       ($1,$2,$3,$4,$5,$6,$7,$8,'gate','gate','spot','direct','unknown','unknown'),
       ($1,$2,$3,$4,$5,$6,$7,$8,'gate','gate','perp','direct','finalized','open_time')`,
      common,
    );
    await pool.query(
      `INSERT INTO lab_candle_cache
       (symbol,timeframe,time,open,high,low,close,volume)
       VALUES ($1,$2,$3,$4,$5,$6,777,$7)`,
      [common[0], common[1], common[2], common[3], common[4], common[5], common[7]],
    );

    const coexist = Number((await pool.query(
      "SELECT count(*) AS n FROM lab_candle_cache_v2 WHERE symbol=$1 AND timeframe='1h' AND time=$2",
      [uniqueSymbol, String(time)],
    )).rows[0].n);
    expect(coexist).toBe(4);

    const { saveCandlesToDb } = await import("../../server/lab/candle-store");
    await saveCandlesToDb(uniqueSymbol, "1h", [{
      time, open: 100, high: 106, low: 99, close: 105, volume: 2,
      provenance: {
        source: "okx", venue: "okx", basis: "perp", proxy: "direct",
        finality: "forming", timeSemantic: "open_time",
      },
    }]);
    const refreshedForming = await pool.query(
      "SELECT count(*) AS n, max(close) AS close FROM lab_candle_cache_v2 WHERE symbol=$1 AND timeframe='1h' AND time=$2 AND source='okx' AND finality='forming'",
      [uniqueSymbol, String(time)],
    );
    expect(Number(refreshedForming.rows[0].n)).toBe(1);
    expect(Number(refreshedForming.rows[0].close)).toBe(105);

    const { getCachedCandles } = await import("../../server/lab/candle-store");
    const rows = await getCachedCandles(uniqueSymbol, "1h", time, time + 3_600_000, {
      basisPolicy: {
        consumer: "scanner",
        acceptedBasis: ["perp"],
        acceptedFinality: ["finalized"],
        acceptedProxy: ["direct"],
      },
      callerClass: "scanner",
    });
    expect(rows).toHaveLength(1);
    expect(rows?.[0].close).toBe(100);
    expect(rows?.[0].provenance).toEqual({
      source: "gate", venue: "gate", basis: "perp", proxy: "direct",
      finality: "finalized", timeSemantic: "open_time",
    });

    const contextRows = await getCachedCandles(uniqueSymbol, "1h", time, time + 3_600_000, {
      basisPolicy: {
        consumer: "ai_context",
        acceptedBasis: ["perp"],
        acceptedFinality: ["finalized"],
        acceptedProxy: ["direct"],
      },
      callerClass: "context",
    });
    expect(contextRows).toHaveLength(1);
    expect(contextRows?.[0].provenance).toEqual({
      source: "gate", venue: "gate", basis: "perp", proxy: "direct",
      finality: "finalized", timeSemantic: "open_time",
    });

    const chartRows = await getCachedCandles(uniqueSymbol, "1h", time, time + 3_600_000, {
      basisPolicy: {
        consumer: "chart",
        acceptedBasis: ["perp"],
        acceptedFinality: ["finalized", "forming"],
        acceptedProxy: ["direct"],
      },
      callerClass: "lab",
    });
    expect(chartRows).toHaveLength(1);
    expect(chartRows?.[0].provenance.finality).toBe("finalized");
  }, 30_000);
});

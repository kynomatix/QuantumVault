import { afterAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

const HAS_DB = !!process.env.DATABASE_URL;
const uniqueSymbol = `QV-PROVENANCE-${process.pid}-${Date.now()}`;
const fixtureSymbols = [uniqueSymbol];

afterAll(async () => {
  if (!HAS_DB) return;
  const client = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    await client.query("DELETE FROM lab_candle_cache_v2 WHERE symbol = ANY($1::text[])", [fixtureSymbols]);
    await client.query("DELETE FROM lab_candle_cache WHERE symbol = $1", [uniqueSymbol]);
  } finally {
    await client.end();
  }
});

describe.runIf(HAS_DB)("provenance-aware candle cache on real PostgreSQL", () => {
  // Keep these in sync with all six CHECK constraints, including values the
  // money policy excludes. C collation must match JS for the entire domain.
  const sources = ["okx", "gate", "pyth", "hyperliquid", "unknown"];
  const venues = ["okx", "gate", "hyperliquid", "none", "unknown"];
  const bases = ["perp", "spot", "index", "unknown"];
  const proxies = ["direct", "proxy", "unknown"];
  const finalities = ["finalized", "forming", "unknown"];
  const semantics = ["open_time", "unknown"];
  const identities = sources.flatMap(source => venues.flatMap(venue => bases.flatMap(basis =>
    proxies.flatMap(proxy => finalities.flatMap(finality => semantics.map(time_semantic => ({
      source, venue, basis, proxy, finality, time_semantic,
    })))))));
  const identity = (p: typeof identities[number]) =>
    `${p.source}/${p.venue}/${p.basis}/${p.proxy}/${p.finality}/${p.time_semantic}`;

  it("orders every schema-allowed complete provenance identity exactly like JavaScript under C collation", async () => {
    const { pool } = await import("../../server/db");
    const result = await pool.query(`
      SELECT identity FROM (
        SELECT (source || '/' || venue || '/' || basis || '/' || proxy || '/' || finality || '/' || time_semantic) AS identity
        FROM jsonb_to_recordset($1::jsonb) AS p(source text, venue text, basis text, proxy text, finality text, time_semantic text)
      ) AS identities
      ORDER BY identity COLLATE "C"`, [JSON.stringify(identities)]);
    expect(result.rows.map(row => row.identity)).toEqual(identities.map(identity).sort());
    expect(result.rows).toHaveLength(1800);
  });

  it("returns exactly the old admitted bytes with fewer SQL rows across provenance and history shapes", async () => {
    const { ensureSchema, pool, scannerCandlePool } = await import("../../server/db");
    const { getCachedCandlesBatch } = await import("../../server/lab/candle-store");
    const { MONEY_CANDLE_POLICY } = await import("../../server/lab/datafeed");
    await ensureSchema();
    const tf = 3_600_000;
    const start = 1_800_000_000_000;
    const end = start + 80 * tf;
    const symbols = ["full", "gap", "stale", "short", "empty"].map(shape => `${uniqueSymbol}-${shape}`);
    fixtureSymbols.push(...symbols);
    const accepted = identities.filter(p => p.basis === "perp" && p.proxy === "direct"
      && p.finality === "finalized" && p.time_semantic === "open_time"
      && p.source !== "unknown" && p.venue !== "unknown");
    expect(accepted).toHaveLength(16);
    const fixtures = symbols.flatMap((symbol, shape) => Array.from({ length: 83 }, (_, i) => i - 1)
      .filter(i => shape === 0 || (shape === 1 && i !== 40) || (shape === 2 && i <= 76) || (shape === 3 && i === 0))
      .flatMap(i => (shape === 0 && i === 40 ? identities : accepted).map((p, observation) => ({
        symbol, timeframe: "1h", time: String(start + i * tf), ...p,
        open: 100 + observation, high: 3000 + observation, low: 50 + observation,
        close: 101 + observation, volume: 10 + observation,
      }))));
    await pool.query(`INSERT INTO lab_candle_cache_v2
      (symbol,timeframe,time,open,high,low,close,volume,source,venue,basis,proxy,finality,time_semantic)
      SELECT symbol,timeframe,time,open,high,low,close,volume,source,venue,basis,proxy,finality,time_semantic
      FROM jsonb_to_recordset($1::jsonb) AS p(symbol text,timeframe text,time numeric,
        open real,high real,low real,close real,volume real,source text,venue text,basis text,proxy text,finality text,time_semantic text)`,
    [JSON.stringify(fixtures)]);

    // Numeric storage canonicalizes alternate timestamp spellings. Equal
    // identities cannot coexist even when different OHLCV is proposed.
    const duplicate = await pool.query(`INSERT INTO lab_candle_cache_v2
      (symbol,timeframe,time,open,high,low,close,volume,source,venue,basis,proxy,finality,time_semantic)
      VALUES ($1,'1h',$2,999,999,999,999,999,'gate','gate','perp','direct','finalized','open_time')
      ON CONFLICT DO NOTHING RETURNING id`, [symbols[0], `0${start}.0`]);
    expect(duplicate.rowCount).toBe(0);

    // Capture actual wire rows from the production query. The lab consumer
    // executes the old SELECT with identical predicates and unchanged admission.
    const read = async (optimized: boolean, prefix: boolean) => {
      const client = await scannerCandlePool.connect();
      const checkout = vi.spyOn(scannerCandlePool, "connect").mockImplementationOnce(async () => client);
      const query = vi.spyOn(client, "query");
      let phases: import("../../server/lab/candle-store").CandleBatchReadPhases | undefined;
      try {
        const bars = await getCachedCandlesBatch([...symbols].reverse(), "1h", start, end, {
          basisPolicy: { ...MONEY_CANDLE_POLICY, consumer: optimized ? "scanner" : "lab" },
          queryTimeoutMs: 5_000, admission: prefix ? "scanner_prefix" : undefined,
          onPhases: value => { phases = value; },
        });
        const calls = query.mock.calls as unknown as readonly (readonly [unknown])[];
        const select = calls.findIndex(([config]) => typeof config === "object"
          && config !== null && "text" in config && String(config.text).includes("FROM lab_candle_cache_v2"));
        expect(select).toBeGreaterThanOrEqual(0);
        const wire = await (query.mock.results[select].value as unknown as Promise<pg.QueryResult>);
        return { bars, rows: wire.rows, phases: phases! };
      } finally {
        query.mockRestore();
        checkout.mockRestore();
      }
    };
    const old = await read(false, true);
    const selected = await read(true, true);
    expect(JSON.stringify([...selected.bars])).toBe(JSON.stringify([...old.bars]));
    const expectedCounts = [81, 80, 77, 1, 0];
    expect(selected.rows).toHaveLength(expectedCounts.reduce((a, b) => a + b, 0));
    expect(old.rows.length).toBe(selected.rows.length * 16);
    expect(selected.phases).toMatchObject({ rows: selected.rows.length, distinctSymbolTimes: selected.rows.length });
    expect(old.phases.distinctSymbolTimes).toBeNull();
    const ordered = [...selected.rows].sort((a, b) => a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : Number(a.time) - Number(b.time));
    expect(selected.rows).toEqual(ordered);
    for (const [index, symbol] of symbols.entries()) {
      const rows = selected.rows.filter(row => row.symbol === symbol);
      expect(rows).toHaveLength(expectedCounts[index]);
      const mapped = rows.map(({ symbol: _symbol, time, source, venue, basis, proxy, finality, timeSemantic, ...ohlcv }) => ({
        time: Number(time), ...ohlcv, provenance: { source, venue, basis, proxy, finality, timeSemantic },
      }));
      if (index < 3) {
        // Compares every OHLCV/provenance byte, not just bar counts.
        expect(JSON.stringify(mapped)).toBe(JSON.stringify(old.bars.get(symbol)));
        expect(mapped.every(bar => bar.provenance.source === "gate" && bar.provenance.venue === "gate")).toBe(true);
        expect(mapped[0].time).toBe(start);
      } else expect(selected.bars.get(symbol)).toBeNull();
      if (index < 2) expect(mapped.at(-1)?.time).toBe(end);
    }
    expect(selected.bars.get(symbols[1])?.some(bar => bar.time === start + 40 * tf)).toBe(false);
    expect(selected.bars.get(symbols[2])?.at(-1)?.time).toBe(end - 4 * tf);
    const oldStrict = await read(false, false);
    const selectedStrict = await read(true, false);
    expect(JSON.stringify([...selectedStrict.bars])).toBe(JSON.stringify([...oldStrict.bars]));
    expect(selectedStrict.bars.get(symbols[2])).toBeNull();
  }, 60_000);

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

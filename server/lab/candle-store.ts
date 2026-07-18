import { labCandleCache } from "@shared/schema";
import { db } from "../db";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import type { OHLCV } from "./engine";

export async function getCachedCandles(
  symbol: string,
  timeframe: string,
  startMs: number,
  endMs: number
): Promise<OHLCV[] | null> {
  try {
    const rows = await db
      .select()
      .from(labCandleCache)
      .where(
        and(
          eq(labCandleCache.symbol, symbol),
          eq(labCandleCache.timeframe, timeframe),
          gte(labCandleCache.time, String(startMs)),
          lte(labCandleCache.time, String(endMs))
        )
      )
      .orderBy(labCandleCache.time);

    const tfSeconds = getTimeframeSecondsForCache(timeframe);
    const tfMs = tfSeconds * 1000;
    const expectedCandles = Math.floor((endMs - startMs) / tfMs);

    // Range-aware floor: short requests (e.g. an open position's entry→now
    // window) can never contain 50 rows, so a flat floor forced a network
    // refetch on every monitor tick for young positions. Coverage-ratio and
    // tail-gap checks below still guard correctness for short ranges.
    const minRows = Math.min(50, Math.max(1, expectedCandles - 1));
    if (rows.length < minRows) return null;
    const coverageRatio = rows.length / Math.max(expectedCandles, 1);

    if (coverageRatio < 0.7) {
      console.log(`[CandleCache] Partial hit for ${symbol} ${timeframe}: ${rows.length}/${expectedCandles} candles (${(coverageRatio * 100).toFixed(0)}% coverage) — refetching`);
      return null;
    }

    const lastCachedTime = Number(rows[rows.length - 1].time);
    const tailGapCandles = Math.floor((endMs - lastCachedTime) / tfMs);
    if (tailGapCandles > 3) {
      console.log(`[CandleCache] Tail gap: ${tailGapCandles} candles behind for ${symbol} ${timeframe} (last cached: ${new Date(lastCachedTime).toISOString()}, requested end: ${new Date(endMs).toISOString()}) — refetching to append tail`);
      return null;
    }

    if (tfMs >= 28800000 && rows.length >= 3) {
      const sampleSize = Math.min(rows.length, 20);
      let misaligned = 0;
      let wrongInterval = 0;
      for (let i = 0; i < sampleSize; i++) {
        const ts = Number(rows[i].time);
        if (ts % tfMs !== 0) misaligned++;
        if (i > 0) {
          const gap = ts - Number(rows[i - 1].time);
          if (gap > 0 && gap < tfMs) wrongInterval++;
        }
      }
      if (misaligned > 0 || wrongInterval > 0) {
        console.log(`[CandleCache] MISALIGNED: ${symbol} ${timeframe} — ${misaligned}/${sampleSize} off-boundary, ${wrongInterval}/${sampleSize - 1} wrong-interval — purging & refetching`);
        try {
          await db.delete(labCandleCache)
            .where(and(eq(labCandleCache.symbol, symbol), eq(labCandleCache.timeframe, timeframe)));
        } catch (err: any) {
          console.log(`[CandleCache] Purge error: ${err.message}`);
        }
        return null;
      }
    }

    return rows.map((r) => ({
      time: Number(r.time),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
  } catch (err: any) {
    console.log(`[CandleCache] Read error: ${err.message}`);
    return null;
  }
}

function getTimeframeSecondsForCache(tf: string): number {
  const map: Record<string, number> = {
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "45m": 2700,
    "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800,
    "12h": 43200, "1d": 86400, "1w": 604800,
  };
  return map[tf] || 3600;
}

// Backpressure for best-effort cache writes: callers fire-and-forget these,
// so a boundary burst (many markets fetched at once) could otherwise queue an
// unbounded number of INSERT jobs against the shared pool (max 8 connections).
// Cap concurrency and the wait queue; beyond that, drop the write — the cache
// is best-effort and the next fetch simply re-saves.
let activeCandleWrites = 0;
let queuedCandleWrites = 0;
const MAX_ACTIVE_CANDLE_WRITES = 2;
const MAX_QUEUED_CANDLE_WRITES = 12;

export async function saveCandlesToDb(
  symbol: string,
  timeframe: string,
  candles: OHLCV[]
): Promise<void> {
  if (candles.length === 0) return;
  if (activeCandleWrites >= MAX_ACTIVE_CANDLE_WRITES) {
    if (queuedCandleWrites >= MAX_QUEUED_CANDLE_WRITES) {
      console.log(`[CandleCache] Write queue full — dropping best-effort save of ${candles.length} candles for ${symbol} ${timeframe}`);
      return;
    }
    queuedCandleWrites++;
    try {
      while (activeCandleWrites >= MAX_ACTIVE_CANDLE_WRITES) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      queuedCandleWrites--;
    }
  }
  activeCandleWrites++;
  try {
    const batchSize = 500;
    let inserted = 0;
    for (let i = 0; i < candles.length; i += batchSize) {
      const batch = candles.slice(i, i + batchSize);
      const values = batch.map((c) => ({
        symbol,
        timeframe,
        time: String(c.time),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));
      await db
        .insert(labCandleCache)
        .values(values)
        .onConflictDoNothing();
      inserted += batch.length;
    }
    console.log(`[CandleCache] Saved ${inserted} candles for ${symbol} ${timeframe}`);
  } catch (err: any) {
    console.log(`[CandleCache] Write error: ${err.message}`);
  } finally {
    activeCandleWrites--;
  }
}

export async function getCacheStats(): Promise<{
  totalCandles: number;
  symbols: number;
  estimatedSizeMb: number;
}> {
  try {
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(labCandleCache);
    const symbolResult = await db
      .select({ count: sql<number>`count(distinct ${labCandleCache.symbol})` })
      .from(labCandleCache);
    const totalCandles = Number(countResult[0]?.count ?? 0);
    const symbols = Number(symbolResult[0]?.count ?? 0);
    const estimatedSizeMb = Math.round((totalCandles * 130) / (1024 * 1024) * 100) / 100;
    return { totalCandles, symbols, estimatedSizeMb };
  } catch {
    return { totalCandles: 0, symbols: 0, estimatedSizeMb: 0 };
  }
}

export async function clearCandleCache(): Promise<number> {
  // Full-table delete over ~2M rows can exceed the pool's 30s statement_timeout
  // safety net; this is a rare admin operation, so exempt it for this tx only.
  return await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = 0`);
    const result = await tx.delete(labCandleCache);
    return result.rowCount ?? 0;
  });
}

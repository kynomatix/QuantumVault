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

    if (rows.length < 50) return null;

    const tfSeconds = getTimeframeSecondsForCache(timeframe);
    const expectedCandles = Math.floor((endMs - startMs) / (tfSeconds * 1000));
    const coverageRatio = rows.length / Math.max(expectedCandles, 1);

    if (coverageRatio < 0.7) {
      console.log(`[CandleCache] Partial hit for ${symbol} ${timeframe}: ${rows.length}/${expectedCandles} candles (${(coverageRatio * 100).toFixed(0)}% coverage) — refetching`);
      return null;
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
    "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "8h": 28800,
    "12h": 43200, "1d": 86400, "1w": 604800,
  };
  return map[tf] || 3600;
}

export async function saveCandlesToDb(
  symbol: string,
  timeframe: string,
  candles: OHLCV[]
): Promise<void> {
  if (candles.length === 0) return;
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
  const result = await db.delete(labCandleCache);
  return result.rowCount ?? 0;
}

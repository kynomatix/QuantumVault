/**
 * Bounded in-memory cache for Flash Trade adapter.
 *
 * Two separate caches:
 *  - marketCache: ProtocolMarket[] list, refreshed every 5 minutes.
 *    Flash markets are static (they come from PoolConfig JSON, not live API),
 *    so this is mostly for consistency with the Pacifica adapter pattern.
 *  - priceCache: per-symbol USD price from Pyth Hermes, TTL 30 seconds.
 *    Kept short so bots receive fresh oracle prices without hammering Hermes
 *    on every tick.
 *
 * Neither cache grows unbounded: the market list is always ≤ MAX_MARKET_CACHE_SIZE
 * entries, and the price cache is capped at MAX_PRICE_CACHE_SIZE entries by
 * evicting the oldest entry when the cap is reached.
 */

import type { ProtocolMarket } from '../protocol-types.js';

const MAX_MARKET_CACHE_SIZE = 50;
const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes

const MAX_PRICE_CACHE_SIZE = 50;
const PRICE_CACHE_TTL_MS = 30 * 1000;          // 30 seconds

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// ── Market list cache ─────────────────────────────────────────────────────────

let marketCacheEntry: CacheEntry<ProtocolMarket[]> | null = null;

export function getCachedMarkets(): ProtocolMarket[] | null {
  if (!marketCacheEntry || Date.now() > marketCacheEntry.expiresAt) return null;
  return marketCacheEntry.value;
}

export function setCachedMarkets(markets: ProtocolMarket[]): void {
  if (markets.length > MAX_MARKET_CACHE_SIZE) {
    throw new Error(
      `flashCache: market list length ${markets.length} exceeds MAX_MARKET_CACHE_SIZE (${MAX_MARKET_CACHE_SIZE})`,
    );
  }
  marketCacheEntry = { value: markets, expiresAt: Date.now() + MARKET_CACHE_TTL_MS };
}

export function invalidateMarketCache(): void {
  marketCacheEntry = null;
}

// ── Price cache ───────────────────────────────────────────────────────────────

const priceEntries = new Map<string, CacheEntry<number>>();

export function getCachedPrice(internalSymbol: string): number | null {
  const entry = priceEntries.get(internalSymbol);
  if (!entry || Date.now() > entry.expiresAt) {
    priceEntries.delete(internalSymbol);
    return null;
  }
  return entry.value;
}

export function setCachedPrice(internalSymbol: string, price: number): void {
  // Evict the oldest entry if at cap.
  if (priceEntries.size >= MAX_PRICE_CACHE_SIZE && !priceEntries.has(internalSymbol)) {
    const oldest = priceEntries.keys().next().value;
    if (oldest !== undefined) priceEntries.delete(oldest);
  }
  priceEntries.set(internalSymbol, { value: price, expiresAt: Date.now() + PRICE_CACHE_TTL_MS });
}

export function invalidatePriceCache(): void {
  priceEntries.clear();
}

export function invalidateAllCaches(): void {
  invalidateMarketCache();
  invalidatePriceCache();
}

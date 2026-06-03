/**
 * Flash dynamic market discovery.
 *
 * Reads the flash-sdk PoolConfig at runtime and enumerates every distinct
 * tradeable asset across all non-deprecated mainnet-beta pools. This is the
 * LIVE path for getMarkets(): it auto-picks up new markets whenever flash-sdk
 * is updated (Flash ships market additions as PoolConfig/governance changes,
 * not as a polled REST endpoint), so we deliberately read the bundled config
 * rather than hammering Solana RPC for on-chain pool accounts (see the RPC-cost
 * rule in replit.md). On-chain live discovery is a possible later enhancement.
 *
 * If the runtime read fails (or returns nothing), callers fall back to the
 * exhaustive static FLASH_MARKET_SPECS in flash-constants.ts. The derivation
 * here is kept identical to the generator that produced that static list.
 */

import { createRequire } from 'module';
import { FLASH_MARKET_SPECS, type FlashMarketSpec } from './flash-constants.js';

// In the esbuild CJS production bundle, `import.meta.url` is replaced with "" (see
// script/build.ts `define`), so `createRequire(import.meta.url)` would throw
// ("filename must be ... Received ''") at module load, which silently de-registers
// the Flash adapter at startup. Branch on the bundle marker and resolve relative to
// cwd in the bundle (same pattern as drift-service.ts), keeping import.meta.url in dev.
const isBundledCJS = typeof __ESBUILD_CJS_BUNDLE__ !== 'undefined' && __ESBUILD_CJS_BUNDLE__;
const require = createRequire(isBundledCJS ? `file://${process.cwd()}/` : import.meta.url);

interface RawCustody {
  custodyAccount: string;
  symbol: string;
  usdPrecision: number;
  tokenPrecision: number;
  isVirtual?: boolean;
  pythTicker?: string;
  pythPriceId?: string;
}
interface RawMarket {
  targetCustody: string;
  maxLev: number;
}
interface RawPool {
  poolName: string;
  cluster: string;
  isDeprecated?: boolean;
  custodies?: RawCustody[];
  markets?: RawMarket[];
}
interface RawPoolConfig {
  pools: RawPool[];
}

const FULLNAME: Record<string, string> = {
  SOL: 'Solana', BTC: 'Bitcoin', ETH: 'Ethereum', ZEC: 'Zcash', BNB: 'BNB',
  JUP: 'Jupiter', PYTH: 'Pyth Network', JTO: 'Jito', KMNO: 'Kamino',
  HYPE: 'Hyperliquid', MEGA: 'MegaETH', BONK: 'Bonk', PENGU: 'Pudgy Penguins',
  PUMP: 'Pump.fun', WIF: 'dogwifhat', FARTCOIN: 'Fartcoin', ORE: 'ORE',
  XAU: 'Gold', XAG: 'Silver', EUR: 'Euro', GBP: 'British Pound',
  CRUDEOIL: 'Crude Oil (WTI)', USDJPY: 'US Dollar / Japanese Yen',
  USDCNH: 'US Dollar / Chinese Yuan', NATGAS: 'Natural Gas', SPY: 'S&P 500 ETF',
  NVDA: 'NVIDIA', TSLA: 'Tesla', AAPL: 'Apple', AMD: 'AMD', AMZN: 'Amazon',
};
const MAJORS = new Set(['SOL', 'BTC', 'ETH']);
const MEMES = new Set(['BONK', 'PENGU', 'PUMP', 'WIF', 'FARTCOIN', 'MEGA', 'ORE']);

function categoryOf(pythTicker: string): string[] {
  if (pythTicker.startsWith('FX.')) return ['forex'];
  if (pythTicker.startsWith('Metal.')) return ['commodity', 'metal'];
  if (pythTicker.startsWith('Commodities.')) return ['commodity'];
  if (pythTicker.startsWith('Equity.')) return ['equity', 'stocks'];
  return ['crypto'];
}
function slippageOf(category: string[], sym: string): number {
  if (category.includes('forex')) return 0.02;
  if (category.includes('commodity')) return 0.05;
  if (category.includes('equity')) return 0.1;
  if (MAJORS.has(sym)) return 0.05;
  if (MEMES.has(sym)) return 0.2;
  return 0.1;
}
function riskTierOf(sym: string): FlashMarketSpec['riskTier'] {
  if (MAJORS.has(sym)) return 'recommended';
  if (MEMES.has(sym)) return 'high_risk';
  return 'caution';
}
function pow10(precision: number): number {
  return Number((1 / Math.pow(10, precision)).toFixed(precision));
}

/**
 * Read the installed flash-sdk PoolConfig and return one FlashMarketSpec per
 * distinct tradeable asset across all mainnet-beta, non-deprecated pools.
 * Returns [] on any failure so callers can fall back to the static list.
 */
export function loadFlashMarketsFromPoolConfig(): FlashMarketSpec[] {
  let cfg: RawPoolConfig;
  try {
    cfg = require('flash-sdk/dist/PoolConfig.json') as RawPoolConfig;
  } catch (err) {
    console.warn(
      `[flash-markets] Could not read flash-sdk PoolConfig — falling back to static specs: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return [];
  }

  const specs: FlashMarketSpec[] = [];
  const seenPools = new Set<string>();
  // Dedupe by asset symbol GLOBALLY across every pool — not just within one pool.
  // Flash lists each asset twice per pool (long + short market) and may also list
  // the same asset across multiple pools; we want one spec per distinct tradeable
  // asset. The first pool to declare a symbol wins.
  const seenSymbols = new Set<string>();

  for (const pool of cfg.pools ?? []) {
    if (pool.cluster !== 'mainnet-beta' || pool.isDeprecated) continue;
    if (seenPools.has(pool.poolName)) continue;
    seenPools.add(pool.poolName);

    const custodyByAccount = new Map<string, RawCustody>();
    for (const c of pool.custodies ?? []) custodyByAccount.set(c.custodyAccount, c);

    for (const m of pool.markets ?? []) {
      const custody = custodyByAccount.get(m.targetCustody);
      if (!custody || custody.symbol === 'USDC') continue;
      if (seenSymbols.has(custody.symbol)) continue;
      seenSymbols.add(custody.symbol);

      const pythTicker = custody.pythTicker ?? '';
      const category = categoryOf(pythTicker);
      const lotSize = pow10(custody.tokenPrecision);
      const tickSize = pow10(custody.usdPrecision);

      specs.push({
        internalSymbol: `${custody.symbol.toUpperCase()}-PERP`,
        flashSymbol: custody.symbol,
        pool: pool.poolName,
        maxLeverage: m.maxLev,
        tickSize,
        lotSize,
        minOrderSizeBase: lotSize,
        minOrderSizeUsd: 0.1,
        maintenanceMarginWeight: 0.005,
        estimatedSlippagePct: slippageOf(category, custody.symbol),
        riskTier: riskTierOf(custody.symbol),
        fullName: FULLNAME[custody.symbol] ?? custody.symbol,
        category,
        isVirtual: !!custody.isVirtual,
        pythTicker,
        pythPriceId: (custody.pythPriceId ?? '').replace(/^0x/, ''),
      });
    }
  }

  return specs;
}

let cachedSpecs: FlashMarketSpec[] | null = null;

/**
 * Memoized accessor used by the adapter's sync paths (quantize*, margin weight)
 * and getMarkets(). Loads from PoolConfig once; falls back to the exhaustive
 * static FLASH_MARKET_SPECS when the runtime read yields nothing.
 */
export function getFlashMarketSpecs(): FlashMarketSpec[] {
  if (cachedSpecs) return cachedSpecs;
  const dynamic = loadFlashMarketsFromPoolConfig();
  if (dynamic.length > 0) {
    cachedSpecs = dynamic;
    console.log(`[flash-markets] Discovered ${dynamic.length} Flash markets from PoolConfig`);
  } else {
    cachedSpecs = FLASH_MARKET_SPECS;
    console.warn(`[flash-markets] Using static FLASH_MARKET_SPECS fallback (${FLASH_MARKET_SPECS.length} markets)`);
  }
  return cachedSpecs;
}

/** Clear the memoized spec cache (e.g. after an SDK upgrade in a long-running process). */
export function resetFlashMarketSpecsCache(): void {
  cachedSpecs = null;
}

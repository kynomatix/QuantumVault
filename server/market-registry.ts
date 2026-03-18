import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

function getModuleDir(): string {
  try {
    if (typeof __dirname !== 'undefined') return __dirname;
  } catch {}
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {}
  return path.join(process.cwd(), 'server');
}

export const CANONICAL_PERP_MARKETS: Record<number, string> = {
  0: 'SOL-PERP',
  1: 'BTC-PERP',
  2: 'ETH-PERP',
  3: 'APT-PERP',
  4: '1MBONK-PERP',
  5: 'POL-PERP',
  6: 'ARB-PERP',
  7: 'DOGE-PERP',
  8: 'BNB-PERP',
  9: 'SUI-PERP',
  10: '1MPEPE-PERP',
  11: 'OP-PERP',
  12: 'RENDER-PERP',
  13: 'XRP-PERP',
  14: 'HNT-PERP',
  15: 'INJ-PERP',
  16: 'LINK-PERP',
  17: 'RLB-PERP',
  18: 'PYTH-PERP',
  19: 'TIA-PERP',
  20: 'JTO-PERP',
  21: 'SEI-PERP',
  22: 'AVAX-PERP',
  23: 'WIF-PERP',
  24: 'JUP-PERP',
  25: 'DYM-PERP',
  26: 'TAO-PERP',
  27: 'W-PERP',
  28: 'KMNO-PERP',
  29: 'TNSR-PERP',
  30: 'DRIFT-PERP',
  31: 'CLOUD-PERP',
  32: 'IO-PERP',
  33: 'ZEX-PERP',
  34: 'POPCAT-PERP',
  35: '1KWEN-PERP',
  42: 'TON-PERP',
  44: 'MOTHER-PERP',
  45: 'MOODENG-PERP',
  47: 'DBR-PERP',
  51: '1KMEW-PERP',
  52: 'MICHI-PERP',
  53: 'GOAT-PERP',
  54: 'FWOG-PERP',
  55: 'PNUT-PERP',
  56: 'RAY-PERP',
  59: 'HYPE-PERP',
  60: 'LTC-PERP',
  61: 'ME-PERP',
  62: 'PENGU-PERP',
  63: 'AI16Z-PERP',
  64: 'TRUMP-PERP',
  65: 'MELANIA-PERP',
  66: 'BERA-PERP',
  69: 'KAITO-PERP',
  70: 'IP-PERP',
  71: 'FARTCOIN-PERP',
  72: 'ADA-PERP',
  73: 'PAXG-PERP',
  74: 'LAUNCHCOIN-PERP',
  75: 'PUMP-PERP',
  76: 'ASTER-PERP',
  77: 'XPL-PERP',
  78: '2Z-PERP',
  79: 'ZEC-PERP',
  80: 'MNT-PERP',
  81: '1KPUMP-PERP',
  82: 'MET-PERP',
  83: '1KMON-PERP',
  84: 'LIT-PERP',
};

export const PERP_ALIASES: Record<string, number> = {
  'BONK': 4, 'BONK-PERP': 4, 'BONKUSD': 4,
  'PEPE': 10, 'PEPE-PERP': 10, 'PEPEUSD': 10,
  'MATIC': 5, 'MATIC-PERP': 5,
  'RNDR': 12, 'RNDR-PERP': 12, 'RNDRUSD': 12,
  'WEN': 35, 'WEN-PERP': 35,
  'MEW': 51, 'MEW-PERP': 51,
  'MON': 83, 'MON-PERP': 83,
};

export function getCanonicalIndex(symbol: string): number | undefined {
  for (const [idxStr, sym] of Object.entries(CANONICAL_PERP_MARKETS)) {
    if (sym === symbol) return Number(idxStr);
  }
  return undefined;
}

export function buildPerpMarketNames(base: Record<number, string> = CANONICAL_PERP_MARKETS): Record<number, string> {
  return { ...base };
}

export function buildPerpMarketIndices(
  base: Record<number, string> = CANONICAL_PERP_MARKETS,
  aliases: Record<string, number> = PERP_ALIASES
): Record<string, number> {
  const indices: Record<string, number> = {};
  for (const [idxStr, symbol] of Object.entries(base)) {
    const idx = Number(idxStr);
    const baseName = symbol.replace('-PERP', '');
    indices[baseName] = idx;
    indices[symbol] = idx;
    indices[`${baseName}USD`] = idx;
  }
  for (const [alias, idx] of Object.entries(aliases)) {
    indices[alias] = idx;
  }
  return indices;
}

const EXECUTOR_JSON_PATH = path.join(getModuleDir(), 'market-indices.json');

export function writeExecutorJson(indices: Record<string, number>): void {
  try {
    fs.writeFileSync(EXECUTOR_JSON_PATH, JSON.stringify(indices, null, 2), 'utf8');
  } catch (err) {
    console.error('[market-registry] Failed to write executor JSON:', err);
  }
}

export async function syncFromSdk(
  currentNames: Record<number, string>,
  currentIndices: Record<string, number>
): Promise<{ names: Record<number, string>; indices: Record<string, number> }> {
  try {
    const sdkModule = await import('@drift-labs/sdk');
    const perpMarkets = sdkModule.PerpMarkets?.['mainnet-beta'];
    if (!perpMarkets || !Array.isArray(perpMarkets)) {
      console.warn('[market-registry] SDK PerpMarkets not available, keeping hardcoded fallback');
      return { names: currentNames, indices: currentIndices };
    }

    const sdkNames: Record<number, string> = {};
    for (const m of perpMarkets) {
      if (typeof m.symbol === 'string' && m.symbol.endsWith('-PERP')) {
        sdkNames[m.marketIndex] = m.symbol;
      }
    }

    if (sdkNames[83] === undefined) sdkNames[83] = '1KMON-PERP';
    if (sdkNames[84] === undefined) sdkNames[84] = 'LIT-PERP';

    const hardcodedCount = Object.keys(CANONICAL_PERP_MARKETS).length;
    const sdkCount = Object.keys(sdkNames).length;
    if (sdkCount < hardcodedCount) {
      console.warn(`[market-registry] SDK returned fewer perp markets (${sdkCount}) than hardcoded (${hardcodedCount}), keeping fallback`);
      return { names: currentNames, indices: currentIndices };
    }

    for (const [idxStr, symbol] of Object.entries(CANONICAL_PERP_MARKETS)) {
      const idx = Number(idxStr);
      if (sdkNames[idx] && sdkNames[idx] !== symbol) {
        console.warn(`[market-registry] Discrepancy at index ${idx}: hardcoded=${symbol}, SDK=${sdkNames[idx]}`);
      }
    }

    for (const [idxStr, symbol] of Object.entries(sdkNames)) {
      const idx = Number(idxStr);
      if (!CANONICAL_PERP_MARKETS[idx]) {
        console.log(`[market-registry] New market from SDK: ${idx}: ${symbol}`);
      }
    }

    const newIndices = buildPerpMarketIndices(sdkNames, PERP_ALIASES);

    console.log(`[market-registry] SDK sync complete: ${sdkCount} perp markets`);
    return { names: sdkNames, indices: newIndices };
  } catch (err) {
    console.warn('[market-registry] SDK sync failed, keeping hardcoded fallback:', err);
    return { names: currentNames, indices: currentIndices };
  }
}

import { getPhoenixReader } from '../protocol/phoenix/runtime';

/** Separate from Signal Bots and scanner consumers. No flag installs money IO. */
export function phoenixAiFlags(env: NodeJS.ProcessEnv = process.env) {
  return { live: env.PHOENIX_AI_LIVE_ENABLED === 'true', scan: env.PHOENIX_AI_SCANNER_ENABLED === 'true',
    paper: env.PHOENIX_AI_PAPER_ENABLED === 'true' };
}

const MARKETS = new Set(['BTC-PERP', 'ETH-PERP', 'SOL-PERP']);
export function phoenixAiMarkets(): string[] {
  const reader = getPhoenixReader();
  const observation = reader?.getMarkets();
  if (!observation || observation.state !== 'fresh' || reader?.getCapabilities().publicReads !== 'ready') return [];
  return (observation.value ?? []).filter(m => MARKETS.has(m.internalSymbol) && m.isActive
    && m.marketStatus === 'active' && m.isolatedOnly === false && m.tickSizeRaw !== null
    && m.baseLotsDecimals !== null).map(m => m.internalSymbol);
}

export function phoenixAiOptions() {
  // U13 is still under review. U10-U12 need installed production IO and their
  // own acceptance gates before AI can deploy collateral through them.
  return { parking: false, borrow: false, carry: false } as const;
}

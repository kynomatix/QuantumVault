/**
 * Swap aggregation entry point.
 *
 * Currently routes through Jupiter only (per Task #181: Titan deferred — it
 * needs a paid subscription). The provider list is the only thing that changes
 * when a venue is added; callers depend on getBestQuote / the SwapProvider
 * interface, never on a concrete provider.
 */

import type { SwapProvider, SwapQuote, QuoteParams } from './types.js';
import { JupiterProvider } from './jupiter.js';

export type { SwapProvider, SwapQuote, QuoteParams } from './types.js';

const providers: SwapProvider[] = [new JupiterProvider()];

/**
 * Returns the highest-output quote across all configured providers, or null if
 * none can route the pair. Provider transport failures are isolated so one bad
 * venue can't sink the whole quote.
 */
export async function getBestQuote(params: QuoteParams): Promise<SwapQuote | null> {
  const settled = await Promise.allSettled(providers.map((p) => p.getQuote(params)));

  let best: SwapQuote | null = null;
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    const q = r.value;
    if (!best || BigInt(q.outAmountRaw) > BigInt(best.outAmountRaw)) {
      best = q;
    }
  }
  return best;
}

/** Resolves the provider that produced a quote so callers can build its tx. */
export function getProviderByName(name: string): SwapProvider | null {
  return providers.find((p) => p.name === name) ?? null;
}

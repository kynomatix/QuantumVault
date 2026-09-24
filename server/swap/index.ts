import type { BestQuoteResult, ProviderQuoteResult, QuoteParams, SwapProvider, SwapQuote } from "./types.js";
import { JupiterProvider } from "./jupiter.js";

export type { BestQuoteResult, ProviderQuoteResult, QuoteParams, QuoteUnavailable, QuoteUnavailableClass, SwapProvider, SwapQuote } from "./types.js";

const providers: SwapProvider[] = [new JupiterProvider()];
const readInFlight = new Map<string, Promise<BestQuoteResult>>();

function readKey(params: QuoteParams): string {
  return JSON.stringify([
    providers.map((provider) => `${provider.name}:${provider.quoteIdentity()}`).sort(),
    params.inputMint,
    params.outputMint,
    params.amountRaw,
    params.slippageBps,
    params.restrictIntermediateTokens ?? true,
    params.onlyDirectRoutes ?? null,
    params.maxAccounts ?? null,
    params.purpose ?? "read",
  ]);
}

export function selectBestQuoteResult(settled: ReadonlyArray<PromiseSettledResult<ProviderQuoteResult>>): BestQuoteResult {
  let best: SwapQuote | null = null;
  let unavailable: BestQuoteResult | null = null;
  const noRoutes: Array<Extract<BestQuoteResult, { kind: "no_route" }>> = [];
  for (const item of settled) {
    if (item.status === "rejected") {
      unavailable ??= { kind: "unavailable", failure: { provider: "unknown", failureClass: "network", status: null, retryAfterMs: null } };
      continue;
    }
    if (item.value.kind === "quote") {
      const quote = item.value.quote;
      if (!best || BigInt(quote.outAmountRaw) > BigInt(best.outAmountRaw)) best = quote;
    } else if (item.value.kind === "unavailable") {
      unavailable ??= item.value;
    } else {
      noRoutes.push(item.value);
    }
  }
  if (best) return { kind: "quote", quote: best };
  if (unavailable) return unavailable;
  const first = noRoutes[0];
  return first ?? { kind: "unavailable", failure: { provider: "none", failureClass: "configuration", status: null, retryAfterMs: null } };
}

async function collect(params: QuoteParams): Promise<BestQuoteResult> {
  const settled = await Promise.allSettled(providers.map((provider) => provider.getQuote(params)));
  return selectBestQuoteResult(settled);
}

export async function getBestQuote(params: QuoteParams): Promise<BestQuoteResult> {
  const purpose = params.purpose ?? "read";
  if (purpose !== "read") return collect({ ...params, purpose });
  const normalized = { ...params, purpose: "read" as const };
  const key = readKey(normalized);
  const existing = readInFlight.get(key);
  if (existing) return existing;
  const pending = collect(normalized).finally(() => readInFlight.delete(key));
  readInFlight.set(key, pending);
  return pending;
}

export function getProviderByName(name: string): SwapProvider | null {
  return providers.find((provider) => provider.name === name) ?? null;
}

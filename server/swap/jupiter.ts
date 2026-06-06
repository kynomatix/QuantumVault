/**
 * Jupiter swap provider.
 *
 * Uses Jupiter's HTTP swap API (no SDK dependency — Node 20 global fetch). The
 * base URL defaults to the free "lite" endpoint and can be overridden with
 * JUPITER_API_BASE (e.g. to point at the paid api.jup.ag tier with a key).
 *
 * Quote → /quote (GET), build tx → /swap (POST). The /swap response is a fully
 * formed VersionedTransaction (base64) including any setup ix (ATA creation,
 * SOL wrap/unwrap), so the agent wallet only needs to sign + send it.
 */

import type { SwapProvider, SwapQuote, QuoteParams } from './types.js';

const DEFAULT_BASE = 'https://lite-api.jup.ag/swap/v1';
const FETCH_TIMEOUT_MS = 12_000;

function getBase(): string {
  return (process.env.JUPITER_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Non-JSON body — surface a trimmed snippet for debugging.
      throw new Error(`Jupiter non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = body?.error || body?.message || `HTTP ${res.status}`;
      throw new Error(`Jupiter API error: ${msg}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export class JupiterProvider implements SwapProvider {
  readonly name = 'jupiter';

  async getQuote(params: QuoteParams): Promise<SwapQuote | null> {
    const qs = new URLSearchParams({
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amountRaw,
      slippageBps: String(params.slippageBps),
      // Fewer hops → cheaper, more reliable landing for deposit conversions.
      restrictIntermediateTokens: 'true',
    });
    const url = `${getBase()}/quote?${qs.toString()}`;

    let body: any;
    try {
      body = await fetchJson(url);
    } catch (err: any) {
      // Jupiter returns a 4xx with an error body when no route exists. Treat a
      // "no route"/"could not find" style failure as "no quote" (null) rather
      // than a transport error, so the aggregator can move on.
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('route') || msg.includes('not find') || msg.includes('no routes')) {
        return null;
      }
      throw err;
    }

    if (!body || !body.outAmount || !body.inAmount) return null;

    const priceImpactPct =
      body.priceImpactPct != null && Number.isFinite(parseFloat(body.priceImpactPct))
        ? parseFloat(body.priceImpactPct)
        : null;

    return {
      provider: this.name,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmountRaw: String(body.inAmount),
      outAmountRaw: String(body.outAmount),
      priceImpactPct,
      slippageBps: params.slippageBps,
      raw: body,
    };
  }

  async buildSwapTransaction(quote: SwapQuote, userPublicKey: string): Promise<string> {
    const url = `${getBase()}/swap`;
    const body = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote.raw,
        userPublicKey,
        // Wrap/unwrap native SOL automatically when SOL is the input mint.
        wrapAndUnwrapSol: true,
        // Let Jupiter size compute units + a reasonable priority fee so the
        // agent-signed tx lands without us hand-tuning CU limits.
        dynamicComputeUnitLimit: true,
        dynamicSlippage: false,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: 'medium' } },
      }),
    });
    if (!body?.swapTransaction || typeof body.swapTransaction !== 'string') {
      throw new Error('Jupiter /swap did not return a swapTransaction');
    }
    return body.swapTransaction;
  }
}

import { jupiterRequestJson, jupiterRuntimeIdentity } from "./jupiter-runtime.js";
import type { ProviderQuoteResult, QuoteParams, QuoteUnavailable, SwapProvider, SwapQuote } from "./types.js";

function unavailable(failure: Omit<QuoteUnavailable, "provider">): ProviderQuoteResult {
  return {
    kind: "unavailable",
    failure: {
      provider: "jupiter",
      failureClass: failure.failureClass,
      status: failure.status,
      retryAfterMs: failure.retryAfterMs,
    },
  };
}

export class JupiterProvider implements SwapProvider {
  readonly name = "jupiter";

  quoteIdentity(): string {
    return jupiterRuntimeIdentity();
  }

  async getQuote(params: QuoteParams): Promise<ProviderQuoteResult> {
    const result = await jupiterRequestJson({
      operation: "quote",
      purpose: params.purpose ?? "read",
      query: {
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        amount: params.amountRaw,
        slippageBps: String(params.slippageBps),
        restrictIntermediateTokens: String(params.restrictIntermediateTokens ?? true),
        ...(params.onlyDirectRoutes === undefined ? {} : { onlyDirectRoutes: String(params.onlyDirectRoutes) }),
        ...(params.maxAccounts === undefined ? {} : { maxAccounts: String(params.maxAccounts) }),
      },
    });
    if (result.kind === "no_route") return { kind: "no_route", provider: this.name, code: result.code };
    if (result.kind === "unavailable") return unavailable(result.failure);
    const body = result.body as { inAmount?: unknown; outAmount?: unknown; priceImpactPct?: unknown } | null;
    if (
      !body
      || typeof body.inAmount !== "string"
      || typeof body.outAmount !== "string"
      || !/^\d+$/.test(body.inAmount)
      || !/^\d+$/.test(body.outAmount)
      || body.inAmount !== params.amountRaw
      || BigInt(body.outAmount) <= BigInt(0)
    ) {
      return unavailable({ failureClass: "malformed_response", status: 200, retryAfterMs: null });
    }
    const parsedImpact = body.priceImpactPct == null ? null : Number(body.priceImpactPct);
    const quote: SwapQuote = {
      provider: this.name,
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmountRaw: body.inAmount,
      outAmountRaw: body.outAmount,
      priceImpactPct: parsedImpact !== null && Number.isFinite(parsedImpact) ? parsedImpact : null,
      slippageBps: params.slippageBps,
      purpose: params.purpose ?? "read",
      raw: result.body,
    };
    return { kind: "quote", quote };
  }

  async buildSwapTransaction(quote: SwapQuote, userPublicKey: string): Promise<string> {
    const result = await jupiterRequestJson({
      operation: "swap",
      purpose: quote.purpose ?? "execution",
      body: {
        quoteResponse: quote.raw,
        userPublicKey,
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: false,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 1_000_000, priorityLevel: "medium" } },
      },
    });
    if (result.kind !== "success") throw new Error(result.kind === "no_route" ? "Jupiter route unavailable before build" : `Jupiter build unavailable (${result.failure.failureClass})`);
    const body = result.body as { swapTransaction?: unknown } | null;
    if (!body || typeof body.swapTransaction !== "string" || body.swapTransaction.length === 0) throw new Error("Jupiter build returned a malformed response");
    return body.swapTransaction;
  }
}

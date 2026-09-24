/** Provider-agnostic swap quote contract. All amounts are raw integer strings. */

export type QuotePurpose = "read" | "execution" | "risk_reducing";

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps: number;
  purpose?: QuotePurpose;
  restrictIntermediateTokens?: boolean;
  onlyDirectRoutes?: boolean;
  maxAccounts?: number;
}

export interface SwapQuote {
  provider: string;
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  priceImpactPct: number | null;
  slippageBps: number;
  purpose?: QuotePurpose;
  raw: unknown;
}

export type QuoteUnavailableClass =
  | "rate_limited"
  | "upstream_server"
  | "timeout"
  | "network"
  | "authentication"
  | "invalid_request"
  | "malformed_response"
  | "configuration";

export interface QuoteUnavailable {
  provider: string;
  failureClass: QuoteUnavailableClass;
  status: number | null;
  retryAfterMs: number | null;
}

export type ProviderQuoteResult =
  | { kind: "quote"; quote: SwapQuote }
  | { kind: "no_route"; provider: string; code: string }
  | { kind: "unavailable"; failure: QuoteUnavailable };

export type BestQuoteResult = ProviderQuoteResult;

export interface SwapProvider {
  readonly name: string;
  quoteIdentity(): string;
  getQuote(params: QuoteParams): Promise<ProviderQuoteResult>;
  buildSwapTransaction(quote: SwapQuote, userPublicKey: string): Promise<string>;
}

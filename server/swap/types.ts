/**
 * Provider-agnostic swap aggregation seam.
 *
 * QuantumVault converts arbitrary deposited SPL tokens into USDC before the
 * funds land in a user's agent (trading) wallet. The concrete swap route is
 * sourced from a pluggable provider so we can add venues (e.g. Titan) later
 * without touching call sites. Today only Jupiter is wired in.
 *
 * Amounts at this layer are ALWAYS raw integer base units (string) to avoid
 * float rounding on-chain. UI-scaled values are derived by callers that know
 * the mint decimals.
 */

export interface QuoteParams {
  /** Mint being sold (raw input token). */
  inputMint: string;
  /** Mint being bought — for deposits this is always the platform USDC mint. */
  outputMint: string;
  /** Amount of inputMint to sell, as a raw integer base-unit string. */
  amountRaw: string;
  /** Max slippage tolerance in basis points (100 = 1%). */
  slippageBps: number;
}

export interface SwapQuote {
  /** Provider that produced this quote (e.g. "jupiter"). */
  provider: string;
  inputMint: string;
  outputMint: string;
  /** Raw input amount the quote was priced for. */
  inAmountRaw: string;
  /** Expected raw output amount (outputMint base units). */
  outAmountRaw: string;
  /** Price impact as a fraction (0.01 = 1%); null when the provider omits it. */
  priceImpactPct: number | null;
  slippageBps: number;
  /**
   * Opaque provider-specific payload required to build the swap transaction.
   * Never inspected outside the provider that produced it.
   */
  raw: unknown;
}

export interface SwapProvider {
  readonly name: string;
  /**
   * Returns the best route this provider can offer, or null when it cannot
   * price the pair (no route / unsupported). Must NOT throw for "no route" —
   * reserve throws for genuine transport/parse failures.
   */
  getQuote(params: QuoteParams): Promise<SwapQuote | null>;
  /**
   * Builds an unsigned, ready-to-sign transaction (base64) for `quote`, with
   * `userPublicKey` as the swapping authority / fee payer.
   */
  buildSwapTransaction(quote: SwapQuote, userPublicKey: string): Promise<string>;
}

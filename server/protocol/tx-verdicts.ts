/**
 * Machine-readable transaction-verdict markers shared between protocol
 * adapters and every retry / re-entry gate.
 *
 * Why this exists: when a market order's landing verification times out, the
 * transaction was ALREADY BROADCAST and may still land inside the blockhash
 * validity window (~60–90s) even though we report "not filled" to the caller.
 * Automatically retrying such an order can double-open a position. String
 * matching on human-readable error text is not a safe gate — a base58
 * signature embedded in the message can accidentally contain substrings like
 * "429" that the retry classifier treats as retryable. This token gives the
 * verdict a stable, collision-proof identity that classification functions
 * hard-exclude BEFORE any pattern matching.
 *
 * INVARIANT: any error string carrying this token MUST NEVER be classified as
 * transient / rate-limited / timeout-retryable by trade-retry-service, and the
 * AI Trader executor MUST NOT treat it as a provably-clean abort.
 */
export const UNCONFIRMED_LANDING_VERDICT_TOKEN = "[verdict:unconfirmed-may-land]";

/** True when the error carries the unconfirmed-landing verdict token. */
export function isUnconfirmedLandingVerdict(error: string | Error | unknown): boolean {
  const s = error instanceof Error ? error.message : String(error ?? "");
  return s.includes(UNCONFIRMED_LANDING_VERDICT_TOKEN);
}

/**
 * Fixed Yield vault — pure decision core (no SDK / RPC / DB).
 *
 * These are the money-critical branch points of the deposit executor, extracted
 * so they can be unit-tested in isolation (same pattern as decideSwapResume):
 *   - which Exponent market class an on-chain account is (discriminator dispatch),
 *   - how to shape the buy request per class (exact-input vs exact-output),
 *   - whether an in-flight UNWIND swap is safe to re-broadcast.
 */

export type MarketKind = "two" | "three";

// Anchor 8-byte account discriminators = sha256("account:<Name>")[:8].
// The pinned ONyc market (51TZ…) is a MarketTwo account; earlier code hardcoded
// MarketThree and threw "Invalid account discriminator" on it. Never assume the
// class — probe the account on-chain, then load with the matching loader.
export const MARKET_TWO_DISCRIMINATOR = Uint8Array.from([212, 4, 132, 126, 169, 121, 121, 20]);
export const MARKET_THREE_DISCRIMINATOR = Uint8Array.from([242, 240, 26, 15, 148, 186, 185, 205]);

function bytesEqualPrefix(data: Uint8Array, prefix: Uint8Array): boolean {
  if (data.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (data[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Classify an EXISTING on-chain account's data by its 8-byte discriminator.
 * "unsupported" = a found account that is neither MarketTwo nor MarketThree
 * (genuinely wrong/dead — retrying won't help). Callers handle the separate
 * account-not-found case (transient) before calling this.
 */
export function classifyMarketDiscriminator(data: Uint8Array | null | undefined): MarketKind | "unsupported" {
  if (!data || data.length < 8) return "unsupported";
  if (bytesEqualPrefix(data, MARKET_TWO_DISCRIMINATOR)) return "two";
  if (bytesEqualPrefix(data, MARKET_THREE_DISCRIMINATOR)) return "three";
  return "unsupported";
}

export type BuyPtArgs =
  | { baseIn: bigint; minPtOut: bigint }
  | { ptOut: bigint; maxBaseIn: bigint };

/**
 * Shape the Exponent buy request per market class. The SAME slippage-haircut PT
 * number (`targetPtRaw`) is used two different ways:
 *   - MarketThree (exact INPUT): spend exactly baseIn, protect the fill with a
 *     minPtOut floor.
 *   - MarketTwo (exact OUTPUT): ask for exactly targetPt, spend up to maxBaseIn
 *     (caps overspend; a small leftover underlying may remain in the wallet).
 */
export function buildBuyPtArgs(input: { kind: MarketKind; targetPtRaw: bigint; baseInRaw: bigint }): BuyPtArgs {
  if (input.kind === "three") {
    return { baseIn: input.baseInRaw, minPtOut: input.targetPtRaw };
  }
  return { ptOut: input.targetPtRaw, maxBaseIn: input.baseInRaw };
}

export type UnwindSwapStatus = "landed" | "reverted" | "in_flight" | null;

export type UnwindResumeAction = "swap" | "finalize_failed" | "retry_swap" | "stop_in_flight";

/**
 * Decide what to do with a stranded-deposit UNWIND swap (ONyc → USDC) on resume.
 * Cardinal rule (same as decideSwapResume): NEVER re-broadcast a swap that may
 * have landed — an in-flight ONyc balance reads unchanged, so a balance-only
 * check would double-swap into the shared Earn park position.
 *   - no signature ever recorded            → swap (first attempt)
 *   - landed                                → finalize_failed (funds already back)
 *   - reverted (confirmed failure)          → retry_swap (safe to re-broadcast)
 *   - unknown, blockhash window over        → retry_swap (proven dead)
 *   - unknown, still within the window       → stop_in_flight (wait, stay resumable)
 */
export function decideUnwindResume(input: {
  recordedSig?: string | null;
  status?: UnwindSwapStatus;
  lastValidBlockHeight?: number | null;
  currentBlockHeight?: number | null;
}): { action: UnwindResumeAction } {
  if (!input.recordedSig) return { action: "swap" };
  if (input.status === "landed") return { action: "finalize_failed" };
  if (input.status === "reverted") return { action: "retry_swap" };
  // Unknown (in_flight / not found): only re-broadcast once the blockhash window
  // has demonstrably closed; otherwise it may still land — wait.
  const lvbh = Number(input.lastValidBlockHeight ?? 0);
  const cur = input.currentBlockHeight;
  if (Number.isFinite(lvbh) && lvbh > 0 && typeof cur === "number" && cur > lvbh + 30) {
    return { action: "retry_swap" };
  }
  return { action: "stop_in_flight" };
}

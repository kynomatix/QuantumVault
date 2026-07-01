// Autonomous per-bot "defend the loan" auto collateral top-up — PURE decision
// layer. NO keys, NO I/O. The routes.ts scanner reads live facts, asks this layer
// what to do, and only for a "topup" verdict spends the ACCOUNT agent wallet's
// held collateral to restore a safe LTV.
//
// v1 is DIRECT collateral only: we spend collateral the account wallet already
// holds — no autonomous swaps and no repay-fallback (those stay manual, where the
// user picks the source + amount). Anything we can't safely auto-defend becomes an
// "alert" so the opted-in user still knows to act.

import { BAND_SEVERITY } from "./borrow-health";
import type { PerBotPositionHealth, TopUpSuggestion } from "./borrow-health";

/**
 * Re-fire throttle window. The atomic claim in storage only succeeds once per
 * window per position, so a loan that stays urgent can't re-fire every scan tick.
 * 10 min matches the health monitor's hysteresis: long enough to stop churn, short
 * enough to defend again if the user tops up the account wallet with more collateral.
 */
export const AUTO_TOPUP_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Economic floor. Never burn gas to add less than this much collateral USD — a
 * dust top-up wouldn't move the health factor and just churns fees.
 */
export const AUTO_TOPUP_MIN_USD = 5;

export type AutoTopUpDecision =
  | { action: "topup"; sourceAmountRaw: bigint; addUsd: number }
  | { action: "alert"; reason: string }
  | { action: "skip"; reason: string };

/**
 * Decide what to do for ONE per-bot loan from already-read facts. PURE.
 *
 * - `skip`  → do nothing, do not claim, do not notify. Used when the loan is not
 *   actionable by the auto path (unreadable health, already liquidatable, not yet
 *   urgent, nothing to add). The health monitor separately alerts on
 *   unavailable/liquidation band crossings, so we do NOT double-notify here.
 * - `alert` → the loan IS urgent and needs defending, but the account wallet does
 *   not hold enough of the collateral asset to make a worthwhile direct top-up.
 *   The user opted into auto-defense, so tell them to act.
 * - `topup` → spend `sourceAmountRaw` of the collateral mint (direct, no swap).
 */
export function decideAutoTopUp(input: {
  health: PerBotPositionHealth;
  suggestion: TopUpSuggestion | null;
  /** ACCOUNT agent wallet's live held balance of the collateral mint (strict read). */
  heldCollateralRaw: bigint;
  /** Liquidation oracle price used by the health read — keeps USD math consistent. */
  collateralPriceUsd: number;
  collateralDecimals: number;
  minUsd?: number;
}): AutoTopUpDecision {
  const { health, suggestion } = input;
  const minUsd = input.minUsd ?? AUTO_TOPUP_MIN_USD;

  // Fail closed on an unreadable health read — never act on a bad read. (The
  // monitor alerts on `unavailable` band crossings; this path stays silent.)
  if (health.status !== "available") {
    return { action: "skip", reason: "health unavailable" };
  }
  // Already mid-liquidation per the venue: do NOT throw more collateral at it.
  if (health.liquidatable === true) {
    return { action: "skip", reason: "liquidatable" };
  }
  // Only defend once the loan has crossed INTO the urgent band (HF <= 1.3) or worse.
  if (BAND_SEVERITY[health.band] < BAND_SEVERITY.urgent) {
    return { action: "skip", reason: `band ${health.band}` };
  }
  // No suggestion (fail-closed on unreadable facts) or already at/above target.
  if (!suggestion || suggestion.suggestedCollateralRaw <= 0n) {
    return { action: "skip", reason: "no suggested top-up" };
  }
  // Guard the USD math inputs.
  if (
    !(input.collateralPriceUsd > 0) ||
    !Number.isInteger(input.collateralDecimals) ||
    input.collateralDecimals < 0
  ) {
    return { action: "skip", reason: "invalid collateral price/decimals" };
  }

  // v1: spend ONLY collateral the account wallet already holds — no swap. Cap the
  // add at the held balance (the executor re-caps at the live balance too).
  const addRaw =
    input.heldCollateralRaw < suggestion.suggestedCollateralRaw
      ? input.heldCollateralRaw
      : suggestion.suggestedCollateralRaw;
  const addUsd = (Number(addRaw) / 10 ** input.collateralDecimals) * input.collateralPriceUsd;

  if (addRaw <= 0n || addUsd < minUsd) {
    // Opted into auto-defense but the account wallet lacks enough of the collateral
    // asset to help — surface it so the user can act (manual top-up / repay).
    return { action: "alert", reason: "insufficient collateral held in account wallet" };
  }

  return { action: "topup", sourceAmountRaw: addRaw, addUsd };
}

/** A `borrow_operations` row narrowed to the fields the resume selector reads. */
export interface TopUpOpRow {
  id: string;
  operationType: string;
  status: string;
  clientRequestId: string | null;
  createdAt: Date | null;
  metadata: Record<string, unknown> | null;
}

export type ResumeSelection =
  | { kind: "none" }
  | { kind: "unresumable"; opId: string }
  | { kind: "resume"; opId: string; clientRequestId: string; sourceMint: string; sourceAmountRaw: bigint };

/** Prefix for every clientRequestId the autonomous scanner mints. Kept here so
 *  the minting site (routes) and the resume selector share ONE source of truth —
 *  a drift between them would misclassify auto ops as manual (or vice-versa). */
export const AUTO_TOPUP_CLIENT_REQUEST_PREFIX = "auto-topup:";

/** Build the idempotency key for an auto top-up on `positionId` at `isoStamp`. */
export function buildAutoTopUpClientRequestId(positionId: string, isoStamp: string): string {
  return `${AUTO_TOPUP_CLIENT_REQUEST_PREFIX}${positionId}:${isoStamp}`;
}

/**
 * Pick how to handle any UNFINISHED collateral top-up op for one loan BEFORE we
 * consider a fresh top-up. PURE.
 *
 * A partial op (collateral already moved to the bot, supply not yet done) is
 * parked as a non-terminal `perbot_collateral_topup` row. The executor can ONLY
 * finish it when re-run under its ORIGINAL clientRequestId (it is idempotent per
 * id). Minting a NEW id would start a SECOND spend and strand the first tranche in
 * the bot wallet — the exact double-spend this selector prevents.
 *
 * CRITICAL money-safety boundary: the manual "Add Collateral" route and the auto
 * scanner BOTH create `perbot_collateral_topup` ops via the same executor, and
 * that executor SWAPS whenever the recorded source mint != the collateral mint.
 * The v1 auto path is DIRECT-collateral-only (no autonomous swaps, no finishing a
 * user's manual op). So the auto path may ONLY resume an op that is PROVABLY:
 *   - auto-origin  → `metadata.autoTopup === true`. This flag is set ONLY by the
 *     scanner (the manual route never sets it). The clientRequestId prefix is NOT
 *     an authority: the manual route accepts a client-supplied id, so a manual op
 *     could spoof the `auto-topup:` prefix — the flag is the single source of truth.
 *   - direct       → recorded source mint EQUALS the loan collateral mint (no swap).
 * Any unfinished op that fails EITHER gate — a manual op (flag absent, even if
 * direct), or ANY swap-backed op — is `unresumable`: the caller stops (leaves it
 * for manual review) and must NOT fall through to a fresh spend on top of it.
 *
 * - `none`        → no unfinished op; the caller may run the fresh decision path.
 * - `resume`      → finish this auto-origin direct op under its own id + amount.
 * - `unresumable` → an unfinished op exists that the auto path must not touch.
 *
 * "Unfinished" = any `perbot_collateral_topup` row whose status is not
 * `succeeded` (an already-succeeded op returns its recorded result on replay, so
 * it needs no resume). The newest such row wins.
 *
 * @param collateralMint the loan's on-chain collateral mint — the direct-vs-swap
 *   reference. A resumed op's source mint must equal it.
 */
export function selectResumableTopUpOp(ops: TopUpOpRow[], collateralMint: string): ResumeSelection {
  const inflight = ops
    .filter((o) => o.operationType === "perbot_collateral_topup" && o.status !== "succeeded")
    .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))[0];
  if (!inflight) return { kind: "none" };

  const meta = (inflight.metadata ?? {}) as Record<string, unknown>;
  const rawMint = meta.sourceMint;
  const sourceMint = typeof rawMint === "string" && rawMint ? rawMint : null;
  let sourceAmountRaw: bigint;
  try {
    sourceAmountRaw = BigInt((meta.sourceAmountRaw ?? "0") as string | number | bigint);
  } catch {
    sourceAmountRaw = 0n;
  }

  // Auto-origin is proven ONLY by the server-set metadata flag. The manual route
  // accepts a client-supplied clientRequestId, so the id prefix is NOT trustworthy
  // as authority (a manual op could spoof "auto-topup:") — we never classify origin
  // by it. A manual op (flag absent/false) is unresumable even when direct.
  const isAutoOrigin = meta.autoTopup === true;
  // Direct: the recorded source mint equals the loan collateral mint => no swap.
  const isDirect = sourceMint !== null && sourceMint === collateralMint;

  if (!isAutoOrigin || !isDirect || !inflight.clientRequestId || sourceAmountRaw <= 0n) {
    return { kind: "unresumable", opId: inflight.id };
  }
  return {
    kind: "resume",
    opId: inflight.id,
    clientRequestId: inflight.clientRequestId,
    sourceMint,
    sourceAmountRaw,
  };
}

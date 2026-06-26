/**
 * PREVIEW-ONLY borrow assumptions (Phase B — read-only health/preview layer).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CRITICAL: NONE of these are enforcement. They power UI HINTS in the read-only
 * borrow preview ("suggested safe size", "this would be flagged as aggressive").
 * They MUST NEVER gate, authorize, or size a money movement.
 *
 * The real, owner-ratified numbers (hard max-LTV cap, circuit-breaker
 * thresholds, fee model) are a Phase C OWNER DECISION. When those land, Phase C
 * introduces a SEPARATE `borrow-risk-policy.ts` that the money path imports.
 * This module must NEVER be imported by a write/money path.
 *
 * Misuse is made loud on purpose: every value is wrapped in `PreviewOnly<T>`
 * carrying `enforcement: "preview_only_not_money_gate"` and an `ownerPending`
 * flag (true = a placeholder default the owner has not yet ratified).
 * ───────────────────────────────────────────────────────────────────────────
 */

/** A value that is explicitly NOT a money-gating policy number. */
export type PreviewOnly<T> = {
  readonly value: T;
  /** Compile-time + runtime marker that this is never an authorization gate. */
  readonly enforcement: "preview_only_not_money_gate";
  /** True when the owner has not yet ratified this number (placeholder default). */
  readonly ownerPending: boolean;
  readonly note: string;
};

function previewOnly<T>(value: T, ownerPending: boolean, note: string): PreviewOnly<T> {
  return { value, enforcement: "preview_only_not_money_gate", ownerPending, note };
}

export interface BorrowPreviewAssumptions {
  /** Suggested conservative LTV for the "safe size" hint (fraction 0..1). */
  suggestedSafeLtv: PreviewOnly<number>;
  /** Borrow APR (fraction) above which the preview shows an "expensive" hint. */
  borrowAprHintCeiling: PreviewOnly<number>;
  /** Market utilization (fraction) above which the preview warns withdrawals may be constrained. */
  utilizationHintCeiling: PreviewOnly<number>;
  /** Max oracle age (seconds) before the preview flags the price as possibly stale. */
  oracleMaxAgeSec: PreviewOnly<number>;
}

/**
 * Conservative placeholders. Each `ownerPending: true` value is a Phase C
 * decision; the numbers here exist only so the read-only preview can render a
 * "suggested"/"would be flagged" indicator today. Changing them changes only UI
 * hints, never behaviour with money.
 */
export const BORROW_PREVIEW_ASSUMPTIONS: BorrowPreviewAssumptions = {
  suggestedSafeLtv: previewOnly(
    0.5,
    false,
    "50% recommended safe-default LTV hint — mirrors BORROW_RISK_POLICY.recommendedMaxLtv (Decision Wall #1, revised 2026-06-26: 'encourage safety, not force it'). UI hint only; the enforced ceiling is the protocol's own max LTV, applied in borrow-risk-policy.ts, never here.",
  ),
  borrowAprHintCeiling: previewOnly(
    0.2,
    true,
    "OWNER_PENDING: 20% borrow APR — purely a 'this is expensive right now' UI hint.",
  ),
  utilizationHintCeiling: previewOnly(
    0.9,
    true,
    "OWNER_PENDING: 90% pool utilization — a near-full pool can block withdrawing collateral even after repaying.",
  ),
  oracleMaxAgeSec: previewOnly(
    120,
    true,
    "OWNER_PENDING: 120s oracle-freshness hint for the preview only; the Phase C money gate gets its own enforced freshness value.",
  ),
};

/** Model explanations, never deterministic feed or execution diagnoses. */
export const FLAT_REASON_CODES = [
  "no_setup", "reward_risk_insufficient", "structure_conflict",
  "stop_geometry_unworkable", "thin_liquidity", "volatility_risk",
  "context_insufficient", "session_risk", "other",
] as const;
export type FlatReason = (typeof FLAT_REASON_CODES)[number];
export const FLAT_REASON_LABELS: Record<FlatReason, string> = {
  no_setup: "no setup",
  reward_risk_insufficient: "reward versus risk was too low",
  structure_conflict: "conflicting market structure",
  stop_geometry_unworkable: "safe stop placement unavailable",
  thin_liquidity: "thin liquidity",
  volatility_risk: "volatility risk",
  context_insufficient: "insufficient context",
  session_risk: "session risk",
  other: "other model reason",
};

export function readFlatReasons(raw: unknown): FlatReason[] | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.action !== "flat" || value.flatReasonsVersion !== 1 || !Array.isArray(value.flatReasons)) return null;
  const reasons = value.flatReasons;
  if (reasons.length < 1 || reasons.length > 3 || new Set(reasons).size !== reasons.length
      || !reasons.every(reason => FLAT_REASON_CODES.includes(reason as FlatReason))) return null;
  return reasons as FlatReason[];
}

export function usesFixedPaperDecisionV2(bot: { paperMode: boolean; marketSource?: string | null }): boolean {
  return bot.paperMode && bot.marketSource !== "scanner";
}

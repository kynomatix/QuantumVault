// Confidence Calibration — pure, side-effect-free bucket math.
//
// PRECONDITION: This module is Gate #1 for the reflection-playbook injection
// phase. The playbook will use calibration data to decide whether to widen or
// narrow risk bands per confidence bucket. Do not alter the bucket definitions,
// the confidence-precedence rule, or the riskPct averaging logic without
// re-evaluating that downstream dependency.
//
// Confidence-precedence rule (matches ZEC script convention):
//   For executed rows → prefer clampedDecision.confidence (post-guardrail
//   authoritative value), fall back to rawDecision.confidence.
//   For any other outcome → rawDecision.confidence only.
//   Since this module is called only on executed+closed rows, the rule is
//   always: clampedDecision?.confidence ?? rawDecision?.confidence.

export const CONFIDENCE_BUCKETS = [
  { label: "1–2", min: 1, max: 2 },
  { label: "3–4", min: 3, max: 4 },
  { label: "5–6", min: 5, max: 6 },
  { label: "7–8", min: 7, max: 8 },
  { label: "9–10", min: 9, max: 10 },
] as const;

export type BucketLabel = (typeof CONFIDENCE_BUCKETS)[number]["label"];

export interface ConfidenceBucket {
  /** Human-readable range, e.g. "7–8". */
  bucket: BucketLabel;
  /** Number of closed+executed trades in this bucket. */
  trades: number;
  /** Win rate (0–100), or null when trades === 0. */
  winRate: number | null;
  /** Average realizedPnl in USD, or null when trades === 0. */
  avgRealizedPnlUsd: number | null;
  /** Average riskPct across risk_based rows only; null when no risk_based rows. */
  avgRiskPct: number | null;
}

/** Minimal input shape — only the fields calibration needs. */
export interface CalibrationRow {
  rawDecision: Record<string, unknown> | null;
  clampedDecision: Record<string, unknown> | null;
  /** Drizzle returns decimal columns as strings; we coerce via Number(). */
  realizedPnl: string | number | null;
}

/** Returns the bucket label for a row, or null if confidence is out of range or missing. */
export function getConfidenceBucketLabel(row: CalibrationRow): BucketLabel | null {
  // Precedence: clampedDecision.confidence (post-guardrail) → rawDecision.confidence
  const conf =
    (row.clampedDecision?.confidence as number | undefined) ??
    (row.rawDecision?.confidence as number | undefined);

  if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 1 || conf > 10) return null;
  const rounded = Math.round(conf); // guard against non-integer floats
  for (const b of CONFIDENCE_BUCKETS) {
    if (rounded >= b.min && rounded <= b.max) return b.label;
  }
  return null;
}

type BucketAcc = {
  trades: number;
  wins: number;
  sumPnl: number;
  riskPctSum: number;
  riskPctCount: number;
};

/**
 * Buckets a set of closed+executed decision rows by confidence and returns
 * per-bucket stats. All five buckets are always present in the output (trades=0
 * for empty ones). Accepts any iterable of CalibrationRow.
 */
export function computeConfidenceCalibration(rows: CalibrationRow[]): ConfidenceBucket[] {
  const acc = new Map<BucketLabel, BucketAcc>();
  for (const b of CONFIDENCE_BUCKETS) {
    acc.set(b.label, { trades: 0, wins: 0, sumPnl: 0, riskPctSum: 0, riskPctCount: 0 });
  }

  for (const row of rows) {
    const bucket = getConfidenceBucketLabel(row);
    if (!bucket) continue;

    const pnl = Number(row.realizedPnl ?? 0);
    const a = acc.get(bucket)!;
    a.trades++;
    if (pnl > 0) a.wins++;
    a.sumPnl += pnl;

    // riskPct only accumulated where sizingMode === 'risk_based' and a value exists
    const cd = row.clampedDecision;
    if (cd?.sizingMode === "risk_based" && typeof cd.riskPct === "number" && Number.isFinite(cd.riskPct)) {
      a.riskPctSum += cd.riskPct;
      a.riskPctCount++;
    }
  }

  return CONFIDENCE_BUCKETS.map((b) => {
    const a = acc.get(b.label)!;
    return {
      bucket: b.label,
      trades: a.trades,
      winRate: a.trades > 0 ? (a.wins / a.trades) * 100 : null,
      avgRealizedPnlUsd: a.trades > 0 ? a.sumPnl / a.trades : null,
      avgRiskPct: a.riskPctCount > 0 ? a.riskPctSum / a.riskPctCount : null,
    };
  });
}

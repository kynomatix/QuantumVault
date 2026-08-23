import { AiTraderPerformanceChart, type QualificationEquityPoint } from './AiTraderPerformanceChart';

type ProfitFactor = { kind: 'finite'; value: number } | { kind: 'positive_infinity' };
type Fees = { status: 'complete'; total: number } | { status: 'unavailable'; missingDecisionIds: string[] };

export interface QualificationReviewRecord {
  id: string;
  qualificationEraDigest: string;
  trialStartedAt: string;
  evaluatedAt: string;
  criteria: Record<string, unknown>;
  allocationUsdc: string;
  decisionIds: string[];
  equitySeries: QualificationEquityPoint[];
  equitySeriesDigest: string;
  tradeCount: number;
  netPnl: string;
  fees: Fees;
  profitFactor: ProfitFactor;
  maxDrawdownPct: string;
  openPositionMtm: string;
  leverageObservation: {
    observedAt: string;
    decisionId: string;
    effectiveMaxLeverage: number;
    smartLeverageCap: number;
  } | null;
  evidenceSourceDigest: string;
  createdAt: string;
}

export type QualificationReviewResponse =
  | { status: 'available'; record: QualificationReviewRecord }
  | { status: 'waived' }
  | { status: 'pending'; graduationState: string }
  | { status: 'unavailable'; reason: 'legacy_record_missing' };

export type QualificationReviewState =
  | QualificationReviewResponse
  | { status: 'loading' }
  | { status: 'error' };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseQualificationReviewResponse(value: unknown): QualificationReviewResponse | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as Record<string, unknown>;
  if (response.status === 'waived') return { status: 'waived' };
  if (response.status === 'pending' && typeof response.graduationState === 'string') {
    return { status: 'pending', graduationState: response.graduationState };
  }
  if (response.status === 'unavailable' && response.reason === 'legacy_record_missing') {
    return { status: 'unavailable', reason: 'legacy_record_missing' };
  }
  if (response.status !== 'available' || !response.record || typeof response.record !== 'object') return null;
  const record = response.record as Record<string, unknown>;
  if (
    typeof record.id !== 'string'
    || typeof record.qualificationEraDigest !== 'string'
    || typeof record.trialStartedAt !== 'string'
    || typeof record.evaluatedAt !== 'string'
    || typeof record.allocationUsdc !== 'string'
    || !Array.isArray(record.decisionIds)
    || !record.decisionIds.every((id) => typeof id === 'string')
    || !Array.isArray(record.equitySeries)
    || typeof record.equitySeriesDigest !== 'string'
    || !Number.isInteger(record.tradeCount)
    || typeof record.netPnl !== 'string'
    || typeof record.maxDrawdownPct !== 'string'
    || typeof record.openPositionMtm !== 'string'
    || typeof record.evidenceSourceDigest !== 'string'
    || typeof record.createdAt !== 'string'
  ) return null;
  return value as QualificationReviewResponse;
}

function money(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed >= 0 ? '+' : '-'}$${Math.abs(parsed).toFixed(2)}` : 'unavailable';
}

export function AiTraderQualificationReview({ review }: { review: QualificationReviewState }) {
  if (review.status === 'loading') return null;
  if (review.status === 'error') {
    return <p className="text-xs text-muted-foreground" data-testid="qualification-review-error">Qualification review temporarily unavailable.</p>;
  }
  if (review.status === 'waived') {
    return (
      <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 text-xs" data-testid="qualification-review-waived">
        Qualification was explicitly waived; no paper-trial evidence record exists.
      </div>
    );
  }
  if (review.status === 'pending') {
    return (
      <div className="rounded-xl border border-border/60 bg-muted/20 p-3 text-xs text-muted-foreground" data-testid="qualification-review-pending">
        Immutable qualification evidence will be captured only if this trial graduates.
      </div>
    );
  }
  if (review.status === 'unavailable') {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300" data-testid="qualification-review-legacy-unavailable">
        This legacy graduation predates immutable qualification records. Evidence is unavailable; it has not been reconstructed.
      </div>
    );
  }

  const record = review.record;
  const profitFactor = record.profitFactor.kind === 'positive_infinity'
    ? 'âˆž'
    : finite(record.profitFactor.value) ? record.profitFactor.value.toFixed(2) : 'unavailable';
  const fees = record.fees.status === 'complete'
    ? `$${record.fees.total.toFixed(4)}`
    : `Unavailable (${record.fees.missingDecisionIds.length} missing)`;
  const leverage = record.leverageObservation;
  return (
    <section className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 space-y-3" data-testid="qualification-review-available">
      <div>
        <p className="text-xs font-semibold text-emerald-300">Immutable graduation evidence</p>
        <p className="text-[10px] text-muted-foreground">
          Evaluated {new Date(record.evaluatedAt).toLocaleString()} Â· {record.tradeCount} exact trial trades
        </p>
      </div>
      <AiTraderPerformanceChart points={record.equitySeries} />
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg bg-muted/30 p-2"><p className="text-muted-foreground">Net P&amp;L</p><p className="font-semibold">{money(record.netPnl)}</p></div>
        <div className="rounded-lg bg-muted/30 p-2"><p className="text-muted-foreground">Profit factor</p><p className="font-semibold">{profitFactor}</p></div>
        <div className="rounded-lg bg-muted/30 p-2"><p className="text-muted-foreground">Historical max drawdown</p><p className="font-semibold">{Number(record.maxDrawdownPct).toFixed(2)}%</p></div>
        <div className="rounded-lg bg-muted/30 p-2"><p className="text-muted-foreground">Recorded fees</p><p className="font-semibold">{fees}</p></div>
      </div>
      <div className="text-[11px] text-muted-foreground space-y-1">
        {leverage ? (
          <p data-testid="qualification-review-leverage">
            Latest retained leverage observation: effective cap {leverage.effectiveMaxLeverage}Ã—, smart cap {leverage.smartLeverageCap}Ã—.
          </p>
        ) : (
          <p data-testid="qualification-review-leverage-unavailable">Leverage observation unavailable in retained trial evidence.</p>
        )}
        <p data-testid="qualification-review-volatility-unavailable">Volatility proxy unavailable: it was not part of the frozen graduation evidence.</p>
        <p className="font-mono break-all">Evidence {record.evidenceSourceDigest}</p>
      </div>
    </section>
  );
}

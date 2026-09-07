import { accountingNumber } from './ai-trader-accounting-display';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const positive = (value: unknown): number | null => {
  const parsed = accountingNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nonnegativeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export type RetainedFeeBasis =
  | { status: 'unavailable' }
  | { status: 'retained_quote'; rate: number; observedAt: number; ageAtDecisionMs: number; provenance: string };

/** Historical display evidence, NOT an execution-time quote freshness certificate. */
function retainedFee(digest: ObjectValue, decidedAt: unknown): RetainedFeeBasis {
  const unavailable: RetainedFeeBasis = { status: 'unavailable' };
  const quote = object(digest.feeRateQuote), expected = object(digest.feeRateIdentity);
  if (!quote || !expected || quote.availability !== 'available') return unavailable;
  if (!text(expected.protocol) || !text(expected.account) || expected.liquidityRole !== 'taker'
    || quote.protocol !== expected.protocol || quote.account !== expected.account
    || quote.subaccountId !== (expected.subaccountId ?? null) || quote.liquidityRole !== 'taker') return unavailable;
  if (!nonnegativeNumber(quote.baseRate) || !nonnegativeNumber(quote.effectiveRate)
    || !nonnegativeNumber(quote.observedAt) || !text(quote.provenance)) return unavailable;
  const decisionMs = typeof decidedAt === 'string' ? Date.parse(decidedAt) : NaN;
  if (!Number.isFinite(decisionMs) || !Number.isFinite(new Date(quote.observedAt).getTime())
    || quote.observedAt > decisionMs) return unavailable;
  const builder = object(quote.builder);
  if (!builder) return unavailable;
  let expectedRate = quote.baseRate;
  if (builder.status === 'absent') {
    if ('rate' in builder || 'provenance' in builder || text(expected.builderCode)) return unavailable;
  } else if (builder.status === 'included') {
    if (!text(builder.code) || !nonnegativeNumber(builder.rate) || !text(builder.provenance)
      || (text(expected.builderCode) && builder.code !== expected.builderCode)) return unavailable;
    expectedRate += builder.rate;
  } else return unavailable;
  if (quote.effectiveRate !== expectedRate) return unavailable;
  return { status: 'retained_quote', rate: quote.effectiveRate, observedAt: quote.observedAt,
    ageAtDecisionMs: decisionMs - quote.observedAt, provenance: quote.provenance };
}

export interface BracketBasisMetrics {
  entry: number;
  grossRewardRisk: number;
  quotedFeeRewardRisk: number | null;
  riskPct: number;
  rewardPct: number;
}

function metrics(side: 'long' | 'short', entry: number | null, stop: number, target: number,
  fee: RetainedFeeBasis): BracketBasisMetrics | null {
  if (entry === null) return null;
  const risk = side === 'long' ? entry - stop : stop - entry;
  const reward = side === 'long' ? target - entry : entry - target;
  if (!(risk > 0 && reward > 0)) return null;
  const grossRewardRisk = reward / risk, riskPct = risk / entry * 100, rewardPct = reward / entry * 100;
  if (![grossRewardRisk, riskPct, rewardPct].every(Number.isFinite)) return null;
  let quotedFeeRewardRisk: number | null = null;
  if (fee.status === 'retained_quote') {
    // Each hypothetical exit has a different notional. This is not realized net P&L.
    const feeAtTarget = fee.rate * (entry + target), feeAtStop = fee.rate * (entry + stop);
    const netReward = reward - feeAtTarget, totalRisk = risk + feeAtStop;
    if ([feeAtTarget, feeAtStop, netReward, totalRisk].every(Number.isFinite)) {
      const afterQuotedFees = netReward / totalRisk;
      if (Number.isFinite(afterQuotedFees)) quotedFeeRewardRisk = afterQuotedFees;
    }
  }
  return { entry, grossRewardRisk, quotedFeeRewardRisk, riskPct, rewardPct };
}

export interface DecisionBracketMetrics {
  version: 1;
  side: 'long' | 'short';
  originalStop: number | null;
  target: number | null;
  usesPreBreakevenStop: boolean;
  decisionSnapshot: BracketBasisMetrics | null;
  recordedFill: BracketBasisMetrics | null;
  fee: RetainedFeeBasis;
}

/** Read-only presentation. Never consumes model rationale, current bot settings or live prices. */
export function decisionBracketMetrics(decision: {
  clampedDecision: unknown; contextDigest: unknown; entryPrice: unknown; outcome: unknown; decidedAt: unknown;
}): DecisionBracketMetrics | null {
  const clamp = object(decision.clampedDecision), digest = object(decision.contextDigest) ?? {};
  if (!clamp || (clamp.action !== 'long' && clamp.action !== 'short')) return null;
  const hasBreakeven = clamp.breakevenProtect !== null && clamp.breakevenProtect !== undefined;
  const be = object(clamp.breakevenProtect);
  const stop = positive(hasBreakeven ? be?.originalStopLossPrice : clamp.stopLossPrice);
  const target = positive(clamp.takeProfitPrice), fee = retainedFee(digest, decision.decidedAt);
  const at = (entry: unknown) => stop !== null && target !== null
    ? metrics(clamp.action as 'long' | 'short', positive(entry), stop, target, fee) : null;
  return { version: 1, side: clamp.action, originalStop: stop, target, usesPreBreakevenStop: hasBreakeven,
    decisionSnapshot: at(digest.price), recordedFill: decision.outcome === 'executed' ? at(decision.entryPrice) : null, fee };
}


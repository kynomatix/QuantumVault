import * as React from 'react';
import { decisionBracketMetrics, type BracketBasisMetrics } from '@/lib/ai-trader-bracket-metrics';

type DecisionInput = Parameters<typeof decisionBracketMetrics>[0];
const ratio = (value: number | null) => value === null ? 'Unavailable' : `${value.toFixed(2)}:1`;
const price = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString(undefined, { maximumSignificantDigits: 10 });
const percentage = (value: number) => Number.isFinite(value * 100) ? `${(value * 100).toPrecision(4)}%` : 'percentage unavailable';

function Basis({ label, value }: { label: string; value: BracketBasisMetrics | null }) {
  return (
    <div className="space-y-0.5">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd>Entry {price(value?.entry ?? null)} · Gross R:R {ratio(value?.grossRewardRisk ?? null)}</dd>
      <dd>Quoted-fee estimate {ratio(value?.quotedFeeRewardRisk ?? null)}</dd>
    </div>
  );
}

/** Independent arithmetic over retained inputs; never a trading recommendation or execution gate. */
export function AiTraderBracketMetrics({ decision }: { decision: DecisionInput }) {
  const metrics = decisionBracketMetrics(decision);
  if (!metrics) return null;
  return (
    <details className="rounded-md border border-border/50 px-2 py-1.5 text-[11px] text-muted-foreground" data-testid="decision-bracket-metrics">
      <summary className="cursor-pointer text-foreground">Calculated bracket R:R · {ratio(metrics.decisionSnapshot?.grossRewardRisk ?? null)} gross at decision</summary>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        <Basis label="Decision snapshot" value={metrics.decisionSnapshot} />
        {decision.outcome === 'executed' && <Basis label="Recorded entry fill" value={metrics.recordedFill} />}
      </dl>
      <p className="mt-2">Original stop {price(metrics.originalStop)} · Target {price(metrics.target)}{metrics.usesPreBreakevenStop ? ' · Pre-breakeven stop basis' : ''}</p>
      {metrics.fee.status === 'retained_quote' ? (
        <p>Retained taker quote {percentage(metrics.fee.rate)} · {metrics.fee.provenance} · observed {new Date(metrics.fee.observedAt).toISOString()} · age at decision {(metrics.fee.ageAtDecisionMs / 60_000).toFixed(1)} min</p>
      ) : <p>Fee basis unavailable; no fee-adjusted ratio can be established.</p>}
      <p>Quoted fees are an estimate, not realized net R:R. Funding, actual exit fees and adverse exit fills are not included. No current-fee or execution-freshness guarantee.</p>
    </details>
  );
}


import React from 'react';
import { readPriceExcursion, observedExcursionMetrics } from '@shared/ai-trader-excursion';
import { accountingNumber } from '@/lib/ai-trader-accounting-display';
import { decisionBracketMetrics } from '@/lib/ai-trader-bracket-metrics';
import type { AiDecisionRow } from './AiTraderDecisionCard';

const percent = (value: number | null) => value === null ? 'unavailable' : value.toFixed(2) + '%';
const unavailableLabels: Record<string, string> = {
  empty_window: 'No usable closed interior candles were observed.',
  malformed_window: 'The observed window could not be validated.',
  mixed_provenance: 'The window contained different price-source identities.',
  window_limit: 'The observed window exceeded the bounded capture limit.',
  no_retained_observation: 'No retained observation; collection may not have started or may have been lost on restart/eviction.',
  terminal_precedes_sample: 'Observation timing did not prove a pre-close window.',
};

/** Human history only; not the AI prompt, qualification record or monetary P&L. */
export function AiTraderExcursion({ decision }: { decision: AiDecisionRow }) {
  if (decision.outcome !== 'executed' || !decision.closedAt) return null;
  const decidedMs = Date.parse(decision.decidedAt ?? ''), closedMs = Date.parse(decision.closedAt);
  const record = readPriceExcursion(decision.priceExcursion, { decisionStartedAtMs: decidedMs, closedAtMs: closedMs });
  if (!record || record.status === 'unavailable') return (
    <p className="text-xs text-muted-foreground" data-testid="excursion-unavailable">
      Price-path observations unavailable. {record?.status === 'unavailable' ? unavailableLabels[record.reason] : 'Legacy or unverified observation record.'}
    </p>
  );
  const bracket = decisionBracketMetrics(decision), entry = accountingNumber(decision.entryPrice);
  const metrics = bracket && entry !== null ? observedExcursionMetrics(record, bracket.side, entry,
    bracket.originalStop, bracket.target) : null;
  const elapsed = Number.isFinite(closedMs - decidedMs) && closedMs >= decidedMs
    ? ((closedMs - decidedMs) / 3_600_000).toFixed(2) + ' hours' : 'unavailable';
  return (
    <details className="text-xs text-muted-foreground" data-testid="excursion-observed">
      <summary className="cursor-pointer">Observed price path — partial coverage</summary>
      <div className="mt-2 space-y-1">
        <p>{record.basis === 'paper_closed_candles' ? 'Closed interior candle extrema' : 'Sampled venue marks'} · {record.sampleCount} observations</p>
        <p>Observed favorable excursion: {percent(metrics?.favorablePct ?? null)} · adverse: {percent(metrics?.adversePct ?? null)}</p>
        <p>Observed target progress: {percent(metrics?.targetProgress !== null && metrics?.targetProgress !== undefined
          && Number.isFinite(metrics.targetProgress * 100) ? metrics.targetProgress * 100 : null)} · adverse / original risk: {metrics?.adverseRisk === null || metrics?.adverseRisk === undefined ? 'unavailable' : metrics.adverseRisk.toFixed(2) + 'R'}</p>
        <p>High {record.high.price} at {new Date(record.high.atMs).toISOString()} · low {record.low.price} at {new Date(record.low.atMs).toISOString()}</p>
        <p>Observed {new Date(record.fromMs).toISOString()} to {new Date(record.throughMs).toISOString()}.</p>
        <p>Source: {record.source.provider} / {record.source.venue} / {record.source.basis} / {record.source.proxy}. Boot: {record.bootId}.</p>
        {record.basis === 'paper_closed_candles'
          ? <p>{record.missingInteriorBars} missing/unusable of {record.expectedInteriorBars} interior bars. Entry, exit and forming candles excluded; timestamps identify candle opens, not the instant an extreme occurred.</p>
          : <p>Unobserved intervals between polls and before collection are unknown. Timestamps are monitor reads, not venue quote timestamps.</p>}
        <p>Decision to recorded close: {elapsed}. This is not exact fill-to-fill holding time; a paper bracket close is recorded at the hit candle's opening time.</p>
        <p>These are sampled observations, not lifetime maxima or net P&amp;L. Restart or eviction can lose observations before close. Zero observed favorable movement does not prove none occurred.</p>
      </div>
    </details>
  );
}

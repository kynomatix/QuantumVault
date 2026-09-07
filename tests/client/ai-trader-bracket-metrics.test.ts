import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { decisionBracketMetrics } from '../../client/src/lib/ai-trader-bracket-metrics';
import { AiTraderBracketMetrics } from '../../client/src/components/AiTraderBracketMetrics';

const identity = { protocol: 'fixture', account: 'fixture-account', subaccountId: null, liquidityRole: 'taker' };
const quote = { ...identity, availability: 'available', baseRate: 0.001, effectiveRate: 0.001,
  builder: { status: 'absent' }, observedAt: Date.parse('2026-01-01T00:00:00Z'), provenance: 'fixture-quote' };
function input() {
  return { clampedDecision: { action: 'long', stopLossPrice: 95, takeProfitPrice: 110 },
    contextDigest: { price: 100, feeRateIdentity: { ...identity }, feeRateQuote: structuredClone(quote) },
    entryPrice: '101', outcome: 'executed', decidedAt: '2026-01-01T00:01:00Z' };
}
const result = (value: unknown) => decisionBracketMetrics(value as ReturnType<typeof input>);

describe('independently calculated decision bracket metrics', () => {
  it('distinguishes decision snapshot from actual fill with different exit notionals', () => {
    const value = result(input())!;
    expect(value.decisionSnapshot?.grossRewardRisk).toBe(2);
    expect(value.recordedFill?.grossRewardRisk).toBe(1.5);
    expect(value.decisionSnapshot?.quotedFeeRewardRisk).toBeCloseTo((10 - 0.210) / (5 + 0.195), 12);
    expect(value.recordedFill?.quotedFeeRewardRisk).toBeCloseTo((9 - 0.211) / (6 + 0.196), 12);
    expect(value.decisionSnapshot?.riskPct).toBe(5);
    expect(value.decisionSnapshot?.rewardPct).toBe(10);
    expect(value.fee).toMatchObject({ status: 'retained_quote', ageAtDecisionMs: 60_000 });
  });
  it('handles shorts and sub-dollar prices without a decimal floor', () => {
    const d = input();
    d.clampedDecision = { action: 'short', stopLossPrice: 0.105, takeProfitPrice: 0.09 };
    d.contextDigest.price = 0.1; d.entryPrice = '0.099';
    expect(result(d)?.decisionSnapshot?.grossRewardRisk).toBeCloseTo(2);
    expect(result(d)?.recordedFill?.grossRewardRisk).toBeCloseTo(1.5);
  });
  it('uses the retained original stop after a breakeven move', () => {
    const d = input();
    Object.assign(d.clampedDecision, { stopLossPrice: 101, breakevenProtect: { originalStopLossPrice: 95 } });
    expect(result(d)?.decisionSnapshot?.grossRewardRisk).toBe(2);
    expect(result(d)?.usesPreBreakevenStop).toBe(true);
  });
  it.each([{}, false, '', { originalStopLossPrice: null }, { originalStopLossPrice: 0 }])('withholds an unproven pre-breakeven stop: %j', be => {
    const d = input(); Object.assign(d.clampedDecision, { breakevenProtect: be });
    expect(result(d)?.decisionSnapshot).toBeNull(); expect(result(d)?.recordedFill).toBeNull();
  });
  it.each([null, '', ' ', false, {}, NaN, Infinity, 0, -1])('does not coerce invalid prices into metrics: %j', bad => {
    const d = input(); Object.assign(d.contextDigest, { price: bad });
    expect(result(d)?.decisionSnapshot).toBeNull();
    expect(result(d)?.recordedFill).not.toBeNull();
  });
  it.each([{ stopLossPrice: 100 }, { stopLossPrice: 101 }, { takeProfitPrice: 99 }, { takeProfitPrice: 100 }])('withholds wrong-side or zero-risk/reward geometry: %j', patch => {
    const d = input(); Object.assign(d.clampedDecision, patch);
    expect(result(d)?.decisionSnapshot).toBeNull();
  });
  it.each(['flat', 'close', null, 'LONG'])('does not invent entry metrics for %j', action => {
    const d = input(); Object.assign(d.clampedDecision, { action }); expect(result(d)).toBeNull();
  });
  it('never substitutes snapshot price for missing fill or a proposal', () => {
    const d = input(); d.outcome = 'proposed'; expect(result(d)?.recordedFill).toBeNull();
    d.outcome = 'executed'; d.entryPrice = ''; expect(result(d)?.recordedFill).toBeNull();
    expect(result(d)?.decisionSnapshot).not.toBeNull();
  });
  it('retains valid gross geometry when fees are unavailable', () => {
    const d = input(); Object.assign(d.contextDigest, { feeRateQuote: { availability: 'unavailable', reason: 'read_failed' } });
    expect(result(d)?.fee.status).toBe('unavailable');
    expect(result(d)?.decisionSnapshot?.grossRewardRisk).toBe(2);
    expect(result(d)?.decisionSnapshot?.quotedFeeRewardRisk).toBeNull();
  });
  it('accepts an explicitly proven zero fee, never an implicit zero', () => {
    const d = input(); Object.assign(d.contextDigest.feeRateQuote, { baseRate: 0, effectiveRate: 0 });
    expect(result(d)?.decisionSnapshot?.quotedFeeRewardRisk).toBe(2);
  });
  it.each([
    { protocol: 'wrong' }, { account: 'wrong' }, { subaccountId: 1 }, { liquidityRole: 'maker' },
    { baseRate: -1 }, { effectiveRate: null }, { effectiveRate: 0.01 }, { provenance: '' },
    { observedAt: null }, { observedAt: Infinity }, { observedAt: Date.parse('2026-01-01T00:02:00Z') },
    { builder: { status: 'unknown' } }, { builder: { status: 'absent', rate: 0 } },
    { builder: { status: 'included', code: 'fixture', rate: 0.001, provenance: 'fixture' } },
  ])('rejects incomplete or mismatched retained fee evidence: %j', patch => {
    const d = input(); Object.assign(d.contextDigest.feeRateQuote, patch);
    expect(result(d)?.fee.status).toBe('unavailable');
    expect(result(d)?.decisionSnapshot?.quotedFeeRewardRisk).toBeNull();
  });
  it('includes an explicitly evidenced builder fee once and checks its identity', () => {
    const d = input();
    Object.assign(d.contextDigest.feeRateIdentity, { builderCode: 'fixture-builder' });
    Object.assign(d.contextDigest.feeRateQuote, { effectiveRate: 0.003,
      builder: { status: 'included', code: 'fixture-builder', rate: 0.002, provenance: 'fixture-builder-quote' } });
    expect(result(d)?.fee).toMatchObject({ status: 'retained_quote', rate: 0.003 });
    Object.assign(d.contextDigest.feeRateIdentity, { builderCode: 'other' });
    expect(result(d)?.fee.status).toBe('unavailable');
  });
  it('does not recertify historical quote freshness or silently substitute a newer rate', () => {
    const d = input(); d.decidedAt = '2026-01-02T00:00:00Z';
    expect(result(d)?.fee).toMatchObject({ status: 'retained_quote', ageAtDecisionMs: 86_400_000 });
    d.decidedAt = 'invalid'; expect(result(d)?.fee.status).toBe('unavailable');
  });
  it('preserves negative expected reward after quoted fees', () => {
    const d = input(); Object.assign(d.contextDigest.feeRateQuote, { baseRate: 0.1, effectiveRate: 0.1 });
    expect(result(d)?.decisionSnapshot?.quotedFeeRewardRisk).toBeLessThan(0);
  });
  it('withholds arithmetic overflow rather than emitting infinity or false zero', () => {
    const d = input(); Object.assign(d.contextDigest.feeRateQuote, { baseRate: Number.MAX_VALUE, effectiveRate: Number.MAX_VALUE });
    expect(result(d)?.decisionSnapshot?.quotedFeeRewardRisk).toBeNull();
  });
  it('does not use model prose, size, current leverage or realized outcomes as geometry', () => {
    const d = input(), original = result(d);
    Object.assign(d.clampedDecision, { rationale: 'R:R is 900:1', leverage: 500, sizePct: 100 });
    Object.assign(d, { realizedPnl: '500000', feesPaid: '100000' });
    expect(result(d)).toEqual(original);
  });
  it('renders basis, fee provenance and limitations without claiming realized net', () => {
    const html = renderToStaticMarkup(createElement(AiTraderBracketMetrics, { decision: input() }));
    for (const text of ['2.00:1 gross at decision', 'Decision snapshot', 'Recorded entry fill', '1.50:1',
      'Quoted-fee estimate', 'Original stop', 'fixture-quote', 'age at decision', 'not realized net R:R']) expect(html).toContain(text);
  });
  it('shows unavailable explicitly and never presents proposal price as a fill', () => {
    const d = input(); d.outcome = 'proposed'; Object.assign(d.contextDigest, { feeRateQuote: null });
    const html = renderToStaticMarkup(createElement(AiTraderBracketMetrics, { decision: d }));
    expect(html).toContain('Fee basis unavailable'); expect(html).toContain('Quoted-fee estimate Unavailable');
    expect(html).not.toContain('Recorded entry fill');
    d.clampedDecision.action = 'flat';
    expect(renderToStaticMarkup(createElement(AiTraderBracketMetrics, { decision: d }))).toBe('');
  });
  it('wires the same component into proposals without changing execute or skip payloads', () => {
    const source = readFileSync(resolve(process.cwd(), 'client/src/components/AiTraderDecisionCard.tsx'), 'utf8');
    expect(source).toContain('<AiTraderBracketMetrics decision={decision} />');
    expect(source.match(/body: JSON.stringify\(\{ decisionId: decision.id \}\)/g)).toHaveLength(2);
    expect(source).not.toContain('decisionBracketMetrics(');
  });
});

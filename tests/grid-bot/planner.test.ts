import { plannerRegime } from '../../server/grid-planner/regime';
import { PlannerRangeFacts } from '../../server/grid-planner/range-facts';
import { PlannerCharts } from '../../server/grid-planner/chart';
import type { PlannerCandle } from '../../server/grid-planner/types';
import type { ProvenancedOHLCV } from '../../server/lab/datafeed';
import { describe, it, expect, vi } from 'vitest';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import type { PlannerDeps, PlannerQuery } from '../../server/grid-planner/types';
import { marketSnapshot } from '../../server/grid-planner/market-snapshot';
import { previewGrid } from '../../server/grid-planner/preview';
import { proposedPlannerStop, plannerRangeAround, plannerOverlays, plannerLevelMessage } from '../../client/src/lib/grid-planner-view';
const now = 1_800_000_000_000;
export const row = (): ProtocolMarket => ({ internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', fullName: 'Bitcoin', maxLeverage: 50, maxLeverageSource: 'venue',
  constraintObservation: observePacificaConstraints({ tick_size: '0.1', lot_size: '0.01', min_order_size: '10' }, 'BTC-PERP', now),
  constraintAuthority: { state: 'unavailable', venue: 'pacifica', market: 'BTC-PERP', source: '/info', reason: 'EXAMPLE', refreshFailed: false },
  isActive: true, category: ['crypto'], maintenanceMarginWeight: 0.01, riskTier: 'recommended', estimatedSlippagePct: 0.01 });
export const deps = (): PlannerDeps => ({ now: () => now, getMarkets: vi.fn(async () => [row()]),
  cachedReference: vi.fn(() => ({ price: 100, observedAt: now })), candles: vi.fn(async () => []) });
const query: PlannerQuery = { market: 'BTC-PERP', side: 'long', lower: '80', upper: '120', intervals: 4, entryScale: 'flat', profitScale: 'flat',
  seed: true, investment: '1000', leverage: '1', stop: '70', fee: null };
describe('Pacifica authority and honest planner verdicts', () => {
  it('shows actual quantized minimum-capital lines when entered investment fails, with an honest chart explanation', () => {
    const underfunded = previewGrid({ ...query, investment: '0.01' }, marketSnapshot(row(), deps()), now);
    expect(underfunded.state).toBe('rejected'); expect(underfunded.requestedPlan).toBeNull();
    expect(underfunded.minimumPlan).not.toBeNull();
    expect(plannerOverlays(underfunded, now + underfunded.validForMs, now)).toEqual(underfunded.minimumPlan!.lines);
    expect(plannerLevelMessage(underfunded, now + underfunded.validForMs, now, query, false, '')).toContain('minimum investment, not your entered investment');
    expect(plannerOverlays(underfunded, now + underfunded.validForMs, now + underfunded.validForMs)).toEqual([]);
  });
  it('shows server geometry after a failed fee assumption without saying checks passed, and never invents lines for invalid stops', () => {
    const m = marketSnapshot(row(), deps()), costly = previewGrid({ ...query, fee: '1' }, m, now);
    expect(costly.state).toBe('rejected'); expect(costly.requestedPlan).not.toBeNull();
    expect(plannerOverlays(costly, now + costly.validForMs, now)).toEqual(costly.requestedPlan!.lines);
    expect(plannerLevelMessage(costly, now + costly.validForMs, now, query, false, '')).toContain('Checks did not pass');
    const invalidStop = previewGrid({ ...query, stop: '100' }, m, now);
    expect(plannerOverlays(invalidStop, now + invalidStop.validForMs, now)).toEqual([]);
    expect(plannerLevelMessage(invalidStop, now + invalidStop.validForMs, now, query, false, '')).toContain('Stop must align');
  });
  it.each(['long', 'short'] as const)('engine quote weighting matches distance labels for %s entries and starting-position exits', side => {
    const m = marketSnapshot(row(), deps());
    for (const scale of ['flat', 'ascending', 'descending'] as const) {
      const result = previewGrid({ ...query, side, entryScale: scale, profitScale: scale, stop: side === 'long' ? '70' : '130', fee: '0' }, m, now);
      expect(result.state).toBe('diagnostic');
      const plan = result.requestedPlan!; expect(plan).not.toBeNull();
      for (const role of ['entry', 'seed_exit'] as const) {
        const lines = plan.lines.filter(l => l.role === role).sort((a, b) => Math.abs(Number(b.price) - 100) - Math.abs(Number(a.price) - 100));
        expect(lines).toHaveLength(2);
        const far = Number(lines[0].notional), near = Number(lines[1].notional);
        if (scale === 'ascending') expect(far).toBeGreaterThan(near);
        else if (scale === 'descending') expect(far).toBeLessThan(near);
        else expect(Math.abs(far - near)).toBeLessThan(1.2);
        expect(lines.every(l => role === 'entry' ? (side === 'long' ? Number(l.price) < 100 : Number(l.price) > 100)
          : (side === 'long' ? Number(l.price) > 100 : Number(l.price) < 100))).toBe(true);
      }
      expect(Number(plan.seedQuantity)).toBeCloseTo(plan.lines.filter(l => l.role === 'seed_exit').reduce((sum, l) => sum + Number(l.quantity), 0), 8);
    }
    const withoutSeed = previewGrid({ ...query, side, seed: false, stop: side === 'long' ? '70' : '130', fee: '0' }, m, now).requestedPlan!;
    expect(withoutSeed.seedQuantity).toBe('0'); expect(withoutSeed.lines.some(l => l.role === 'seed_exit')).toBe(false);
  });
  it('uses original observation clocks and refuses to fabricate missing maxima', () => {
    const m = marketSnapshot(row(), deps());
    expect(m.constraints).toMatchObject({ state: 'available', value: { tick: '0.1', lot: '0.01', minimumQuote: '10', observedAt: now,
      maxLeverage: { state: 'available', value: '50' }, maximumQuote: { state: 'unavailable' }, priceBounds: { state: 'unavailable' }, restrictions: { state: 'unavailable' } } });
    expect(previewGrid({ ...query, fee: '0' }, m, now).state).toBe('diagnostic');
  });
  for (const key of ['tick', 'lot', 'openingMinimum'] as const) it(`missing ${key} never uses legacy fallback`, () => {
    const r = row(); r.constraintObservation![key] = null;
    Object.assign(r, { tickSize: 0.1, lotSize: 0.01, minOrderSizeUsd: 10 });
    expect(marketSnapshot(r, deps()).constraints.state).toBe('unavailable');
  });
  it('rejects wrong units, identity, copied clocks, failed refresh, stale and future observations', () => {
    const corruptions = [(r: ProtocolMarket) => { r.constraintObservation!.tick!.unit = 'base'; },
      (r: ProtocolMarket) => { r.constraintObservation!.market = 'ETH-PERP'; },
      (r: ProtocolMarket) => { r.constraintObservation!.expiresAt++; },
      (r: ProtocolMarket) => { r.constraintObservation!.refreshFailed = true; },
      (r: ProtocolMarket) => { r.constraintObservation!.observedAt = now - 300_001; r.constraintObservation!.expiresAt = now - 1; },
      (r: ProtocolMarket) => { r.constraintObservation!.observedAt++; r.constraintObservation!.expiresAt++; }];
    for (const corrupt of corruptions) { const r = row(); corrupt(r); expect(marketSnapshot(r, deps()).constraints.state).toBe('unavailable'); }
  });
  it('canonicalizes valid exact scientific venue decimals and rejects compatibility leverage', () => {
    const r = row(); r.constraintObservation = observePacificaConstraints({ tick_size: '1e-1', lot_size: '1e-2', min_order_size: '1e1' }, r.internalSymbol, now);
    r.maxLeverageSource = 'fallback';
    expect(marketSnapshot(r, deps()).constraints).toMatchObject({ state: 'available', value: { tick: '0.1', lot: '0.01', maxLeverage: { state: 'unavailable' } } });
  });
  it('cached reference is usable at 60 seconds but unavailable one millisecond later; unknown is not zero', () => {
    const d = deps(); d.cachedReference = () => ({ price: 100, observedAt: now - 60_000 });
    expect(marketSnapshot(row(), d).reference.state).toBe('available'); d.now = () => now + 1;
    expect(marketSnapshot(row(), d).reference).toMatchObject({ state: 'unavailable' });
    d.cachedReference = () => ({ price: 0, observedAt: now }); expect(marketSnapshot(row(), d).reference.state).toBe('unavailable');
  });
  it('keeps blank fee unknown and explicit zero visibly an assumption', () => {
    const m = marketSnapshot(row(), deps()), blank = previewGrid(query, m, now), zero = previewGrid({ ...query, fee: '0' }, m, now);
    expect(blank.fee).toEqual({ state: 'unknown' }); expect(blank.assumedMinimum.state).toBe('unavailable'); expect(blank.feeRows).toEqual([]);
    expect(zero.fee).toEqual({ state: 'assumption', rate: '0', label: 'Your assumption — not a venue quote' });
    expect(zero.feeRows.every(r => r.assumedRoundTripFee === '0')).toBe(true);
    expect(zero.stop.state).toBe('unavailable');
  });
  it('fee failure retains requested diagnostic quantities and rows; underfunding labels a separate minimum plan', () => {
    const m = marketSnapshot(row(), deps()), failed = previewGrid({ ...query, fee: '1' }, m, now);
    expect(failed.state).toBe('rejected'); expect(failed.requestedPlan).not.toBeNull(); expect(failed.feeRows.some(r => !r.clears)).toBe(true);
    const low = previewGrid({ ...query, investment: '0.01' }, m, now);
    expect(low).toMatchObject({ state: 'rejected', requestedPlan: null, minimum: { state: 'available' } }); expect(low.minimumPlan).not.toBeNull();
  });
  it('rejects invalid stops and leverage and invalidates expired references', () => {
    const m = marketSnapshot(row(), deps());
    expect(previewGrid({ ...query, stop: '80' }, m, now).state).toBe('rejected');
    expect(previewGrid({ ...query, stop: '70.01' }, m, now).state).toBe('rejected');
    expect(previewGrid({ ...query, leverage: '51' }, m, now).state).toBe('rejected');
    expect(previewGrid(query, m, now + 60_001)).toMatchObject({ state: 'unavailable', requestedPlan: null, validForMs: 0 });
  });
  it('primary range and suggested-stop shortcuts remain proposals checked by the server', () => {
    const m = marketSnapshot(row(), deps());
    const range = plannerRangeAround(m, now + 60_000, now, 10)!;
    for (const side of ['long', 'short'] as const) {
      const stop = proposedPlannerStop(range.lower, range.upper, side, '0.1')!;
      const result = previewGrid({ ...query, ...range, side, stop, fee: '0' }, m, now);
      expect(result.state).toBe('diagnostic'); expect(result.requestedPlan).not.toBeNull();
      expect(result.stop.state).toBe('unavailable');
      expect(previewGrid({ ...query, ...range, side, stop }, m, now + 60_001).state).toBe('unavailable');
    }
  });
});


describe('Persistent finalized timeframe ADX and independent auto-range', () => {
  const history = (count = 100): ProvenancedOHLCV[] => {
    const duration = 3_600_000, end = Math.floor(now / duration) * duration;
    return Array.from({length:count},(_,i)=>({time:end-(count-i)*duration,open:100,high:102,low:98,close:100,volume:1,
      provenance:{source:'okx',venue:'okx',basis:'perp',proxy:'direct',finality:'finalized',timeSemantic:'open_time'}}));
  };
  it('computes a valid 28-candle advisory and preserves selected market and timeframe provenance',()=>{
    expect(plannerRegime('BTC-PERP','1h',history(28),now)).toMatchObject({state:'available',adx:0,label:'ranging',market:'BTC-PERP',timeframe:'1h',venue:'okx',bars:28});
    expect(plannerRegime('BTC-PERP','1h',history(27),now)).toEqual({state:'unavailable',reason:'ADX needs 28 bars'});
    expect(plannerRegime('BTC-PERP','4h',history(),now).state).toBe('unavailable');
    const bars=history();bars.forEach((b,i)=>{b.open=100+i;b.close=101+i;b.high=102+i;b.low=99+i;});
    expect(plannerRegime('BTC-PERP','1h',bars,now)).toMatchObject({state:'available',label:'trending'});
  });
  it.each(['forming','spot','proxy','mixed','gap','nan','volume','stale'])('reports UNKNOWN for %s observations',kind=>{
    const bars=history();if(kind==='forming')bars[99].provenance.finality='forming';if(kind==='spot')bars[0].provenance.basis='spot';if(kind==='proxy')bars[0].provenance.proxy='proxy';
    if(kind==='mixed')bars[0].provenance.venue='gate';if(kind==='gap')bars[3].time+=1;if(kind==='nan')bars[1].high=NaN;if(kind==='volume')bars[1].volume=-1;if(kind==='stale')bars.forEach(b=>b.time-=3_600_000);
    expect(plannerRegime('BTC-PERP','1h',bars,now).state).toBe('unavailable');
  });
  it('retains ADX when structural range detection has insufficient bars and respects cancellation',async()=>{
    const d={...deps(),rangeCandles:vi.fn(async()=>history(28))},reader=new PlannerRangeFacts();
    const value=await reader.read(row(),'1h',100,d,new AbortController().signal);
    expect(value.regime.state).toBe('available');expect(value.range.state).toBe('unavailable');expect(value.validForMs).toBeGreaterThan(0);
    const controller=new AbortController();controller.abort();await expect(reader.read(row(),'1h',100,d,controller.signal)).rejects.toThrow();
  });
  it.each(['okx','gate','hyperliquid','pacifica'] as const)('chart and ADX share the exact cached %s history without an independent source read',async venue=>{
    const candles: PlannerCandle[] = history().map(c => venue === 'pacifica'
      ? { ...c, provenance: { ...c.provenance, source: 'pacifica', venue: 'pacifica' } }
      : { ...c, provenance: { ...c.provenance, source: venue, venue } });
    const d = { ...deps(), candles: vi.fn(async () => candles), rangeCandles: vi.fn(async () => []) };
    const charts = new PlannerCharts(d), signal = new AbortController().signal;
    const [chart, rangeChart] = await Promise.all([charts.read('BTC-PERP','1h',100,signal), charts.read('BTC-PERP','1h',100,signal)]);
    const result = await new PlannerRangeFacts().read(row(),'1h',100,d,signal,rangeChart);
    expect(chart.state).toBe('available');
    expect(result.regime).toMatchObject({ state:'available', venue, bars:100, latestFinalizedTime:candles.at(-1)!.time });
    expect(d.candles).toHaveBeenCalledTimes(1); expect(d.rangeCandles).not.toHaveBeenCalled();
  });
});

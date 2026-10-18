import { plannerRegime } from '../../server/grid-planner/regime';
import { PlannerRangeFacts, timeWindowRange } from '../../server/grid-planner/range-facts';
import { PlannerCharts } from '../../server/grid-planner/chart';
import type { PlannerCandle } from '../../server/grid-planner/types';
import type { ProvenancedOHLCV } from '../../server/lab/datafeed';
import { describe, it, expect, vi } from 'vitest';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import type { PlannerDeps, PlannerQuery } from '../../server/grid-planner/types';
import { marketSnapshot } from '../../server/grid-planner/market-snapshot';
import { previewGrid } from '../../server/grid-planner/preview';
import { proposedPlannerStop, plannerRangeAround, plannerOverlays, plannerLevelMessage, plannerIssue, plannerVenueChecks, isPlannerMarket, plannerMinimumRows } from '../../client/src/lib/grid-planner-view';
import { calculateGrid, minimumInvestment } from '../../server/grid-bot/engine';
import { explainPlannerIssue, dollars } from '../../server/grid-planner/order-explanation';
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
  it('carries published USD maximum, zero-inclusive price bounds and execution facts with original source and clock', () => {
    const r = row();
    r.constraintObservation = observePacificaConstraints({ tick_size: '0.1', lot_size: '0.01', min_order_size: '10',
      max_order_size: '5000000', min_tick: '0', max_tick: '1000000', isolated_only: false, instrument_type: 'perpetual', execution_modes: ['orderbook'] }, r.internalSymbol, now);
    const market = marketSnapshot(r, deps());
    expect(market.constraints).toMatchObject({ state: 'available', value: { observedAt: now, expiresAt: now + 300_000, source: '/info',
      maximumQuote: { state: 'available', value: '5000000' }, priceBounds: { state: 'available', value: { minimum: '0', maximum: '1000000' } }, restrictions: { state: 'available', value: 'unrestricted' } } });
    expect(isPlannerMarket(market)).toBe(true);
    expect(previewGrid({ ...query, fee: '0' }, market, now)).toMatchObject({ state: 'hypothetical_checks_passed', reasons: [] });
    r.constraintObservation.planning!.maximumQuote = ' 5000000'; r.constraintObservation.planning!.minimumPrice = '-1';
    r.constraintObservation.planning!.executionModes = [];
    const invalid = marketSnapshot(r, deps());
    expect(invalid.constraints).toMatchObject({ value: { maximumQuote: { state: 'unavailable' }, priceBounds: { state: 'unavailable' }, restrictions: { state: 'unavailable' } } });
    for (const maximum of ['1e999999999', '1e-999999999']) {
      r.constraintObservation.planning!.maximumQuote = maximum;
      expect(marketSnapshot(r, deps()).constraints).toMatchObject({ value: { maximumQuote: { state: 'unavailable' } } });
    }
    r.constraintObservation.planning!.maximumQuote = '5e6';
    expect(marketSnapshot(r, deps()).constraints).toMatchObject({ value: { maximumQuote: { state: 'available', value: '5000000' } } });
  });
  it('keeps unpublished order-time limits neutral and enforces published limits', () => {
    const market = marketSnapshot(row(), deps());
    expect(previewGrid({ ...query, fee: '0' }, market, now).reasons).toEqual([]);
    expect(plannerVenueChecks(market).slice(0, 3).map(row => row.value)).toEqual(Array(3).fill('Not checked — refresh market data'));
    if (market.constraints.state !== 'available') throw Error('EXAMPLE');
    const c = market.constraints.value;
    for (const change of [{ maximumQuote: { state: 'available' as const, value: '20' } },
      { priceBounds: { state: 'available' as const, value: { minimum: '85', maximum: '115' } } },
      { restrictions: { state: 'available' as const, value: 'isolated_only' } }]) {
      const result = previewGrid(query, { ...market, constraints: { state: 'available', value: { ...c, ...change } } }, now);
      expect(result.state).toBe('rejected'); expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).not.toMatch(/observed|shared authority|lot-rounded/i);
    }
  });
  it.each(['long','short'] as const)('preserves unmarked v2 %s previews and their reserved minimum', side => {
    const market=marketSnapshot(row(),deps());
    if(market.constraints.state!=='available')throw Error('EXAMPLE');
    const c=market.constraints.value;
    for(const seed of [false,true]){
      const result=previewGrid({...query,side,seed,stop:side==='long'?'70':'130'},market,now,{leanSizingCreation:false});
      expect(result.requestedPlan?.policyVersion).toBe('2.0.0');expect(result.requestedPlan?.cycles).toHaveLength(4);
      const input={side,seed,lower:query.lower,upper:query.upper,start:'100',intervals:query.intervals,entryScale:query.entryScale,profitScale:query.profitScale,
        leverage:query.leverage,tick:c.tick,lot:c.lot,minimumQuote:c.minimumQuote,investmentStep:'0.01',transferFloor:'0',effectiveMakerCostRate:null};
      const expected=minimumInvestment({...input,policyVersion:'2.0.0'}),legacy=minimumInvestment({...input,policyVersion:'1.0.0'});
      expect(expected.ok).toBe(true);expect(legacy.ok).toBe(true);if(!expected.ok||!legacy.ok)return;
      expect(result.minimum).toEqual({state:'available',value:expected.investment});
      expect(Number(expected.investment)).toBeGreaterThan(Number(legacy.investment));
      expect(plannerMinimumRows(result)).toEqual([{label:'Minimum investment',value:`${Number(expected.investment)} USDC`}]);
      const underfunded=previewGrid({...query,side,seed,stop:side==='long'?'70':'130',investment:'0.01'},market,now,{leanSizingCreation:false});
      expect(underfunded.minimumPlan?.policyVersion).toBe('2.0.0');
      expect(plannerMinimumRows(underfunded)).toEqual(plannerMinimumRows(result));
    }
  });
  it('explains an insufficient cycling budget with the Investment action', () => {
    const result = previewGrid({ ...query, investment: '10' }, marketSnapshot(row(), deps()), now);
    expect(result.reasons).toEqual(['The investment cannot cover all cycling orders across the range. Raise the investment, use fewer grids, or use more leverage.']);
    expect(plannerIssue(result.reasons[0])).toMatchObject({ setting: 'Investment', field: 'grid-investment' });
  });
  it('routes the maximum-order message to Investment even when it mentions leverage', () => {
    const market = marketSnapshot(row(), deps());
    if (market.constraints.state !== 'available') throw Error('EXAMPLE');
    market.constraints.value.maximumQuote = { state: 'available', value: '20' };
    const result = previewGrid(query, market, now);
    expect(result.reasons[0]).toContain('maximum. Lower the investment or leverage');
    expect(plannerIssue(result.reasons[0])).toMatchObject({ setting: 'Investment', field: 'grid-investment' });
    expect(plannerIssue('Leverage must be at least 1')).toMatchObject({ setting: 'Leverage', field: 'grid-leverage' });
  });
  it.each(['long', 'short'] as const)('display-only rejected-line values match engine quantities for %s and every scale', side => {
    for (const seed of [false, true]) for (const scale of ['flat', 'ascending', 'descending'] as const) {
      const input = { side, seed, lower: '80', upper: '120', start: '100', intervals: 4, entryScale: scale, profitScale: scale,
        investment: '1000', leverage: '3', tick: '0.1', lot: '0.01', minimumQuote: '10', investmentStep: '0.01', transferFloor: '0' };
      const actual = calculateGrid(input); if (!actual.ok) throw Error('EXAMPLE');
      for (const line of actual.plan.lines.filter(line => line.role === 'entry')) {
        const explanation = explainPlannerIssue({ code: 'underfunded', reason: 'Lot-rounded line is below the opening minimum', ordinal: line.ordinal }, input);
        expect(explanation).toContain(`about $${dollars(line.notional)},`);
      }
    }
  });
  it('returns engine prices before investment without calculating sizes, minimums, fees or stop clearance', () => {
    const m = marketSnapshot(row(), deps()), input = { ...query, investment: '' };
    const geometry = previewGrid(input, m, now), sized = previewGrid(query, m, now);
    expect(geometry).toMatchObject({ state: 'diagnostic', requestedPlan: null, minimumPlan: null,
      minimum: { state: 'unavailable', reason: 'Enter an investment to see order sizes' },
      assumedMinimum: { state: 'unavailable' }, fee: { state: 'unknown' }, feeRows: [], stop: { state: 'unavailable' } });
    expect(geometry.geometry).toEqual({ state: 'available', value: sized.requestedPlan!.lines.map(({ ordinal, price }) => ({ ordinal, price })) });
    expect(plannerOverlays(geometry, now + geometry.validForMs, now)).toEqual(geometry.geometry?.state === 'available' ? geometry.geometry.value : []);
    expect(plannerLevelMessage(geometry, now + geometry.validForMs, now, input, false, '')).toBe('Enter an investment to see order sizes');
    expect(plannerOverlays(geometry, now + geometry.validForMs, now + geometry.validForMs)).toEqual([]);
    const withoutSizing = previewGrid({ ...input, leverage: '', stop: '', fee: 'EXAMPLE' }, { ...m, reference: { state: 'unavailable', reason: 'EXAMPLE' } }, now);
    expect(withoutSizing.geometry).toEqual(geometry.geometry); expect(withoutSizing.fee.state).toBe('unknown');
  });
  it('keeps invalid or expired geometry unavailable and never interprets a bad investment as absent', () => {
    const m = marketSnapshot(row(), deps());
    for (const change of [{ lower: '120', upper: '80' }, { lower: '100', upper: '100.1' }, { intervals: 101 }, { lower: 'EXAMPLE' }]) {
      const result = previewGrid({ ...query, investment: '', ...change }, m, now);
      expect(result.state).toBe('rejected'); expect(result.geometry?.state).toBe('unavailable');
    }
    for (const investment of ['0', '-1', 'EXAMPLE']) expect(previewGrid({ ...query, investment }, m, now).state).toBe('rejected');
    if (m.constraints.state !== 'available') throw Error('EXAMPLE missing fixture constraints');
    const c = m.constraints.value;
    expect(previewGrid({ ...query, investment: '' }, { ...m, constraints: { state: 'available', value: { ...c, expiresAt: now + 300_000 } } }, now).validForMs).toBe(60_000);
    for (const at of [c.observedAt - 1, c.expiresAt, c.expiresAt + 1])
      expect(previewGrid({ ...query, investment: '' }, m, at).geometry?.state).toBe('unavailable');
    expect(previewGrid({ ...query, investment: '' }, { ...m, market: 'ETH-PERP' }, now).state).toBe('unavailable');
    expect(previewGrid({ ...query, investment: '' }, { ...m, constraints: { state: 'unavailable', reason: 'EXAMPLE' } }, now).state).toBe('unavailable');
  });
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
  it.each(['long', 'short'] as const)('legacy engine quote weighting matches distance labels for %s entries and starting-position exits', side => {
    const m = marketSnapshot(row(), deps());
    for (const scale of ['flat', 'ascending', 'descending'] as const) {
      const result = previewGrid({ ...query, side, entryScale: scale, profitScale: scale, stop: side === 'long' ? '70' : '130', fee: '0' }, m, now, {cycleV2Creation:false});
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
    const withoutSeed = previewGrid({ ...query, side, seed: false, stop: side === 'long' ? '70' : '130', fee: '0' }, m, now, {cycleV2Creation:false}).requestedPlan!;
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
  it.each(['okx', 'gate', 'hyperliquid', 'pacifica'] as const)('uses last-week high/low and a half ATR buffer on shared %s chart history', async venue => {
    const candles: PlannerCandle[] = history(252).map(c => venue === 'pacifica'
      ? { ...c, provenance: { ...c.provenance, source: 'pacifica', venue: 'pacifica' } }
      : { ...c, provenance: { ...c.provenance, source: venue, venue } });
    candles[0].high = 500; // Context must not become the selected period's high.
    const d = { ...deps(), candles: vi.fn(async () => candles), rangeCandles: vi.fn(async () => []) };
    const charts = new PlannerCharts(d), signal = new AbortController().signal;
    const [chart, rangeChart] = await Promise.all([charts.read('BTC-PERP', '1h', 252, signal), charts.read('BTC-PERP', '1h', 252, signal)]);
    const result = await new PlannerRangeFacts().read(row(), '1h', 168, d, signal, rangeChart, 'week');
    expect(chart).toMatchObject({ state: 'available', actualBars: 252, partial: false });
    expect(result.regime).toMatchObject({ state: 'available', venue, bars: 200 });
    expect(result.range).toMatchObject({ state: 'available', includedBars: 168, lowerPrice: '96', upperPrice: '104', atr: '4', buffer: '2' });
    expect(d.candles).toHaveBeenCalledTimes(1); expect(d.rangeCandles).not.toHaveBeenCalled();
  });
  it('covers a six-bar last day on 4h using context for ATR and the unchanged ADX minimum', async () => {
    const duration = 14_400_000, end = Math.floor(now / duration) * duration;
    const candles = history().map((c, i) => ({ ...c, time: end - (100 - i) * duration }));
    const d = { ...deps(), rangeCandles: vi.fn(async () => candles) };
    const result = await new PlannerRangeFacts().read(row(), '4h', 6, d, new AbortController().signal, undefined, 'day');
    expect(result.range).toMatchObject({ state: 'available', includedBars: 6, lowerPrice: '96', upperPrice: '104' });
    expect(result.regime).toMatchObject({ state: 'available', bars: 100 });
    expect(d.rangeCandles).toHaveBeenCalledWith('BTC-PERP', '4h', 100, expect.any(AbortSignal));
  });
  it('keeps independent ADX while explaining incomplete period coverage', async () => {
    const d = { ...deps(), rangeCandles: vi.fn(async () => history(28)) };
    const result = await new PlannerRangeFacts().read(row(), '1h', 168, d, new AbortController().signal, undefined, 'week');
    expect(result.regime.state).toBe('available'); expect(result.range.state).toBe('unavailable');
    if (result.range.state === 'unavailable') expect(result.range.reason).toContain('okx returned 28 of 168 finalized bars');
  });
  it.each(['gap', 'mixed', 'forming', 'stale'] as const)('refuses a %s time window instead of presenting a narrower auto-range', kind => {
    const candles = history(1080);
    if (kind === 'gap') candles[400].time += 1;
    if (kind === 'mixed') candles[400].provenance.venue = 'gate';
    if (kind === 'forming') candles[500].provenance.finality = 'forming';
    if (kind === 'stale') candles.forEach(c => { c.time -= 3_600_000; });
    expect(timeWindowRange('BTC-PERP', '1h', 'month', candles, now).state).toBe('unavailable');
  });
  it('computes a valid 28-candle advisory and preserves selected market and timeframe provenance',()=>{
    expect(plannerRegime('BTC-PERP','1h',history(28),now)).toMatchObject({state:'available',adx:0,label:'ranging',market:'BTC-PERP',timeframe:'1h',venue:'okx',bars:28});
    expect(plannerRegime('BTC-PERP','1h',history(27),now)).toEqual({state:'unavailable',reason:'ADX needs 28 bars'});
    expect(plannerRegime('BTC-PERP','4h',history(),now).state).toBe('unavailable');
    const bars=history();bars.forEach((b,i)=>{b.open=100+i;b.close=101+i;b.high=102+i;b.low=99+i;});
    expect(plannerRegime('BTC-PERP','1h',bars,now)).toMatchObject({state:'available',label:'trending'});
  });
  it('distinguishes short history from excessive history, unsupported timeframes and invalid clocks',()=>{
    expect(plannerRegime('BTC-PERP','1h',history(201),now)).toEqual({state:'unavailable',reason:'ADX history exceeds 200 bars'});
    expect(plannerRegime('BTC-PERP','EXAMPLE',history(),now)).toEqual({state:'unavailable',reason:'ADX timeframe is unsupported'});
    for(const clock of [NaN,Infinity,now+0.5,Number.MAX_SAFE_INTEGER+1])
      expect(plannerRegime('BTC-PERP','1h',history(),clock)).toEqual({state:'unavailable',reason:'ADX clock is invalid'});
    expect(plannerRegime('BTC-PERP','EXAMPLE',history(27),now)).toEqual({state:'unavailable',reason:'ADX timeframe is unsupported'});
    expect(plannerRegime('BTC-PERP','1h',history(27),NaN)).toEqual({state:'unavailable',reason:'ADX clock is invalid'});
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

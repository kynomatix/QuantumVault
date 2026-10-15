import { describe, expect, it } from 'vitest';
import { GRID_RUNTIME_POLICY as P, GRID_RECYCLER_MAX_AGE_MS, gridWalletEntryGate, gridExposureLimit, gridRecyclerGate, gridStopReachable, gridFirstPlacementGate, gridAdxLabel } from '../../server/grid-bot/runtime-policy.js';
describe('approved policy boundaries', () => {
  it('C2 uses the full configured investment times leverage, including ceilings above the old pilot',()=>{
    expect(P.exposure).toEqual({ceiling:'configured_investment_times_leverage'});
    expect(Object.isFrozen(P.exposure)).toBe(true);
    expect(gridExposureLimit('25',10)).toBe('250');expect(gridExposureLimit('100',10)).toBe('1000');
    expect(gridExposureLimit('1000',20)).toBe('20000');expect(gridExposureLimit('0.01',1)).toBe('0.01');
    expect(gridExposureLimit('123.45',3)).toBe('370.35');
    for(const investment of ['0','-1','NaN','Infinity',''])expect(gridExposureLimit(investment,10)).toBeNull();
    for(const leverage of [0,-1,1.5,NaN,Infinity])expect(gridExposureLimit('100',leverage)).toBeNull();
  });
  it('pins mandatory stops, geometry, cadence and final-bar range rules', () => {
    expect(P.version).toBe('1.0.0'); expect(P.caps).toMatchObject({ ordinaryRestingPerBot: 100, sharedProtectionReserve: 5, intervals: 100, lines: 101 });
    expect(P.monitor).toMatchObject({ intervalMs: 15_000, globalStartSpacingMs: 1000, globalConcurrency: 1, perBotExclusion: true, catchUp: false, skipPriceMaxAgeMs: 5000, accountPositionsEveryMs: 60_000 });
    expect(P.range.timeframes).toEqual(['15m', '1h', '4h']); expect(P.range.selectableBars).toEqual([100, 200]);
    expect(P.range).toMatchObject({ walkbackMaximumBars: 400, partialFallback: false, intrabarEscapeStrictlyAboveAtr: 3, driftEscapeStrictlyAboveAtr: 6 });
    expect(P.stop).toMatchObject({ mandatory: true, reduceOnly: true, canDisable: false, atrBuffers: { '15m': '0.90', '1h': '0.75', '4h': '0.75' }, daily: 'UNKNOWN' });
    expect(P.canary).toMatchObject({ durationMs: 1_800_000, cleanTicks: 2, fullReconcileAtOrAfterBoundary: true, unresolvedRestartsCleanWindow: true });
    expect(P.breaker).toMatchObject({ qualifyingFailures: 5, expectedAloCrossCounts: false, resetRequiresAuthoritativeHealth: true });
    expect(P.adx).toMatchObject({ period: 14, minimumBars: 28, consecutiveDistinctCandles: 2, executionAuthority: false });
    expect(Object.isFrozen(P)).toBe(true); expect(Object.isFrozen(P.range.timeframes)).toBe(true);
  });
  it.each([null, '', 'NaN', '0.049999', '-0.1'])('unknown or below-floor wallet balance denies entries (%s)', value => { expect(gridWalletEntryGate(value).entryAllowed).toBe(false); });
  it('wallet boundary preserves warning versus entry floor', () => {
    expect(gridWalletEntryGate('0.05')).toMatchObject({ entryAllowed: true, warning: true });
    expect(gridWalletEntryGate('0.10')).toMatchObject({ entryAllowed: true, warning: false });
    expect(P.wallet.exitsKeepIndependentAuthority).toBe(true);
  });
  it('keeps canary qualification evidence without a reduced size budget', () => {
    expect(P.canary).not.toHaveProperty('targetFraction');expect(P.canary).not.toHaveProperty('maximumUsd');
    expect(P.canary.shrinkOrders).toBe(false); expect(P.canary.reduceOnlyExitDoubleCount).toBe(false);
  });
  it('recycler proof must be current, true, and deployment-bound for each create', () => {
    const r = { reuse: 'true', recycle: true, deployment: 'EXAMPLE_DEPLOYMENT', expectedDeployment: 'EXAMPLE_DEPLOYMENT', checkedAt: 1000 };
    expect(gridRecyclerGate(r, 1000)).toBe(true);
    expect(GRID_RECYCLER_MAX_AGE_MS).toBe(5000);
    expect(gridRecyclerGate({ ...r, checkedAt: 999 }, 1000)).toBe(true);
    expect(gridRecyclerGate(r, 6000)).toBe(true);
    expect(gridRecyclerGate(r, 6001)).toBe(false);
    expect(gridRecyclerGate({ ...r, checkedAt: 1001 }, 1000)).toBe(false);
    for(const invalid of [NaN,Infinity,1000.5]){
      expect(gridRecyclerGate({ ...r, checkedAt: invalid }, 1000)).toBe(false);
      expect(gridRecyclerGate(r, invalid)).toBe(false);
    }
    expect(gridRecyclerGate({ ...r, reuse: 'false' }, 1000)).toBe(false);
    expect(gridRecyclerGate({ ...r, expectedDeployment: 'EXAMPLE_OTHER' }, 1000)).toBe(false);
  });
  const stop = { side: 'long' as const, entry: '100', stop: '90', liquidation: '80', tick: '1', validatedClearance: '2', boundedAdverseExitPrice: '89', enabled: true, reduceOnly: true };
  it('requires both long/short stop reachability including bounded adverse exit and tick-aware positive clearance', () => {
    expect(gridStopReachable(stop)).toBe(true);
    expect(gridStopReachable({ ...stop, side: 'short', stop: '110', liquidation: '120', boundedAdverseExitPrice: '111' })).toBe(true);
    expect(gridStopReachable({ ...stop, boundedAdverseExitPrice: '81' })).toBe(false);
    expect(gridStopReachable({ ...stop, stop: '90.5' })).toBe(false);
    expect(gridStopReachable({ ...stop, validatedClearance: '0' })).toBe(false);
    expect(gridStopReachable({ ...stop, enabled: false })).toBe(false);
    expect(gridStopReachable({ ...stop, reduceOnly: false })).toBe(false);
    expect(gridStopReachable({ ...stop, liquidation: '' })).toBe(false);
    expect(gridStopReachable({ ...stop, stop: '101' })).toBe(false);
  });
  it('first placement accepts exact deviation cap but rejects stale book, side/range change and half-spacing overflow', () => {
    const p = { confirmedPrice: '100', bookPrice: '100.1', smallestSpacingFraction: '0.002', observedAt: 1000,
      source: '/book', identityValid: true, sideFlip: false, rangeValid: true };
    expect(gridFirstPlacementGate(p, 6000)).toBe(true);
    expect(gridFirstPlacementGate(p, 6001)).toBe(false);
    expect(gridFirstPlacementGate({ ...p, sideFlip: true }, 1000)).toBe(false);
    expect(gridFirstPlacementGate({ ...p, rangeValid: false }, 1000)).toBe(false);
    expect(gridFirstPlacementGate({ ...p, smallestSpacingFraction: '0.001' }, 1000)).toBe(false);
    expect(gridFirstPlacementGate({ ...p, bookPrice: '100.10001' }, 1000)).toBe(false);
    expect(gridFirstPlacementGate({ ...p, source: 'cache' }, 1000)).toBe(false);
  });
  it.each([[19.99, 'ranging'], [20, 'transitional'], [25, 'transitional'], [25.01, 'trending'], [null, 'UNKNOWN'], [NaN, 'UNKNOWN']])('ADX remains advisory at %s', (value, expected) => {
    expect(gridAdxLabel(value as number | null)).toBe(expected); expect(P.adx.creationAdvisoryOnly).toBe(true);
  });
});

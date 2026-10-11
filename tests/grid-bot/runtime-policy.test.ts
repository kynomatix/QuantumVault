import { describe, expect, it } from 'vitest';
import { GRID_RUNTIME_POLICY as P, gridWalletEntryGate, gridCanaryBudget, gridCanaryAdmission, gridRecyclerGate, gridStopReachable, gridFirstPlacementGate, gridAdxLabel } from '../../server/grid-bot/runtime-policy.js';
describe('approved policy boundaries', () => {
  it('pins versioned pilot, mandatory stops, geometry, cadence and final-bar range rules', () => {
    expect(P.version).toBe('1.0.0'); expect(P.caps).toMatchObject({ ordinaryRestingPerBot: 20, sharedProtectionReserve: 5, intervals: 100, lines: 101, pilotBotsPerQuotaDomain: 2 });
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
  it('canary uses both hard caps, includes seed/commitments and never rounds minimums upward', () => {
    expect(gridCanaryBudget('100')).toBe('25'); expect(gridCanaryBudget('2000')).toBe('250');
    expect(gridCanaryAdmission('100', '15', ['10'], '25')).toBe(true);
    expect(gridCanaryAdmission('100', '15', ['10.000001'], '25')).toBe(false);
    expect(gridCanaryAdmission('100', '0', ['25'], '25.01')).toBe(false);
    expect(gridCanaryAdmission('2000', '251', [], '1')).toBe(false);
    expect(gridCanaryAdmission('0', '0', [], '0')).toBe(false);
    expect(P.canary.shrinkOrders).toBe(false); expect(P.canary.reduceOnlyExitDoubleCount).toBe(false);
  });
  it('recycler proof must be current, true, and deployment-bound for each create', () => {
    const r = { reuse: 'true', recycle: true, deployment: 'EXAMPLE_DEPLOYMENT', expectedDeployment: 'EXAMPLE_DEPLOYMENT', checkedAt: 1000 };
    expect(gridRecyclerGate(r, 1000)).toBe(true);
    expect(gridRecyclerGate({ ...r, checkedAt: 999 }, 1000)).toBe(false);
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

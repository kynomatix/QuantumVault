import Decimal from 'decimal.js';
import { createHash } from 'node:crypto';
import { GRID_CAPS } from './grid-caps.js';
const D = Decimal.clone({ precision: 100 });
/** Owner policy 1.0.0, 2026-09-09; H.5 settles only the resting-capacity proof. No feature flag is enabled here. */
export const GRID_RUNTIME_POLICY = Object.freeze({
  version: '1.0.0', approvedOn: '2026-09-09', capacityRuling: 'H.5/2026-09-28', caps: GRID_CAPS,
  quota: Object.freeze({ observedSameDeploymentRequired: false, planningCredits: 300, windowSeconds: 60,
    fixedShare: '0.5', ledgerScope: 'pacifica_master_postgresql', uncertainClaimsRetained: true,
    durable429Backoff: true, sharedNonGridDemandRequired: false }), // Owner ruling 2026-10-12; Signal/AI unchanged.
  monitor: Object.freeze({ intervalMs: 15_000, conditionalOnMeasuredWorkload: true, globalStartSpacingMs: 1000,
    globalConcurrency: 1, perBotExclusion: true, catchUp: false, optionalHeavyMovementFraction: '0.001',
    skipPriceMaxAgeMs: 5000, mandatoryReconciliationNeverSkipped: true, riskEveryMs: 15_000,
    accountPositionsEveryMs: 60_000, accountPositionsOnAnomaly: true }), // 7–11
  breaker: Object.freeze({ qualifyingFailures: 5, expectedAloCrossCounts: false, resetRequiresAuthoritativeHealth: true,
    persistAcrossRestart: true, pauseEntriesAndNotify: true }), // 12
  wallet: Object.freeze({ warningSol: '0.10', entryMinimumSol: '0.05', unknownDeniesEntry: true, exitsKeepIndependentAuthority: true }), // 13–14
  fill: Object.freeze({ lifecycleThreshold: '0.98', retainActualResidual: true, profitFromActualQuantizedFill: true }), // 15
  firstPlacement: Object.freeze({ source: '/book', maxAgeMs: 5000, maxDeviationFraction: '0.001',
    spacingFractionMultiplier: '0.5', sideFlipOrInvalidRangeAborts: true, equalityAllowed: true, geometryImmutable: true }), // 16–17
  fees: Object.freeze({ liveFallback: false, retainedQuoteRequired: true }), // 18
  recycler: Object.freeze({ reuseOnCreate: true, recycleOnDelete: true, justInTimeEveryCreate: true, deploymentBound: true }), // 19–20
  exposure: Object.freeze({ ceiling: 'configured_investment_times_leverage' }), // Owner ruling 2026-10-15
  canary: Object.freeze({ unchangedQuantizedSubset: true,
    includeSeedOpenRiskAndCommitments: true, reduceOnlyExitDoubleCount: false, shrinkOrders: false,
    durationMs: 30 * 60_000, startsOnVenueConfirmation: true, fullReconcileAtOrAfterBoundary: true, cleanTicks: 2,
    qualifyingWindowRequires: Object.freeze(['zero_unresolved', 'zero_429', 'zero_qualifying_breaker_failures',
      'order_position_ledger_parity', 'current_fees_minimums_leverage', 'current_recycler']), notificationRequired: false,
    unresolvedRestartsCleanWindow: true, retainHistoricalIncidents: true }), // 21–23
  range: Object.freeze({ timeframes: Object.freeze(['15m', '1h', '4h'] as const), defaultBars: 100,
    selectableBars: Object.freeze([100, 200]), finalizedDirectPerpetualRequired: true, partialFallback: false,
    walkbackMaximumBars: 400, boundedBySuppliedHistory: true, atrPeriod: 14, intrabarEscapeStrictlyAboveAtr: 3,
    driftEscapeStrictlyAboveAtr: 6 }), // 24–28
  stop: Object.freeze({ atrBuffers: Object.freeze({ '15m': '0.90', '1h': '0.75', '4h': '0.75' }), daily: 'UNKNOWN',
    long: 'structuralLow-buffer', short: 'structuralHigh+buffer', mandatory: true, reduceOnly: true,
    canDisable: false, positiveTickAwareLiquidationClearance: true, unknownExecutionInputsDeny: true,
    triggerLatchesEntriesOff: true, terminalRequiresConfirmedStopCancelCloseSweep: true, bandExit: 'pause_hold' }), // 29–30,38
  adx: Object.freeze({ sameSelectedFinalizedDirectPerpetualTimeframe: true, period: 14, minimumBars: 28,
    rangingBelow: 20, transitionalThrough: 25, unknownExplicit: true, creationAdvisoryOnly: true,
    oncePerNewFinalCandleAndStartup: true, consecutiveDistinctCandles: 2, reverseOrReturnCandles: 2,
    persistentDedupe: 'bot+policy+candle', unknownBreaksRun: true, executionAuthority: false }), // 31–37
});
export const GRID_RUNTIME_POLICY_DIGEST = createHash('sha256').update(JSON.stringify(GRID_RUNTIME_POLICY)).digest('hex');
const decimal = (x: string) => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(x) && x.length <= 80 ? new D(x) : null;
/** The confirmed bot configuration owns its notional ceiling, at every lifecycle stage. */
export function gridExposureLimit(investment: string, leverage: number): string | null {
  const d = decimal(investment);
  return d && d.gt(0) && Number.isSafeInteger(leverage) && leverage > 0 ? d.mul(leverage).toFixed() : null;
}
export function gridWalletEntryGate(sol: string | null) {
  const d = sol === null ? null : decimal(sol);
  return { entryAllowed: !!d && d.gte('.05'), warning: !!d && d.lt('.10'), reason: !d ? 'wallet_balance_unknown' : d.lt('.05') ? 'wallet_entry_reserve' : null };
}
export const GRID_RECYCLER_MAX_AGE_MS = 5000;
export function gridRecyclerGate(input: { reuse: unknown; recycle: unknown; deployment: string; expectedDeployment: string; checkedAt: number }, now: number): boolean {
  const yes = (v: unknown) => v === true || v === 'true';
  return yes(input.reuse) && yes(input.recycle) && !!input.deployment && input.deployment === input.expectedDeployment
    && Number.isSafeInteger(now) && Number.isSafeInteger(input.checkedAt)
    && input.checkedAt <= now && now - input.checkedAt <= GRID_RECYCLER_MAX_AGE_MS;
}
/** adverseExitUsd and clearance are validated execution inputs, not a guessed percent buffer. */
export function gridStopReachable(input: { side: 'long' | 'short'; entry: string; stop: string; liquidation: string; tick: string;
  validatedClearance: string; boundedAdverseExitPrice: string; reduceOnly: boolean; enabled: boolean }): boolean {
  const ds = [input.entry, input.stop, input.liquidation, input.tick, input.validatedClearance, input.boundedAdverseExitPrice].map(decimal);
  if (!input.enabled || !input.reduceOnly || ds.some(d => !d || !d.gt(0))) return false;
  const [entry, stop, liquidation, tick, clearance, adverse] = ds as Decimal[];
  if (!stop.mod(tick).eq(0) || clearance.lt(tick)) return false;
  return input.side === 'long' ? stop.lt(entry) && adverse.lte(stop) && adverse.minus(liquidation).gte(clearance)
    : input.side === 'short' && stop.gt(entry) && adverse.gte(stop) && liquidation.minus(adverse).gte(clearance);
}
export function gridFirstPlacementGate(input: { confirmedPrice: string; bookPrice: string; smallestSpacingFraction?: string; smallestSpacingPrice?: string;
  observedAt: number; source: string; identityValid: boolean; sideFlip: boolean; rangeValid: boolean }, now: number): boolean {
  const a = decimal(input.confirmedPrice), b = decimal(input.bookPrice);
  if (!a || !b || !a.gt(0) || !b.gt(0)) return false;
  const s = decimal(input.smallestSpacingPrice ?? input.smallestSpacingFraction ?? '');
  // Quantized price distances keep half-spacing equality exact even when distance/start is a repeating decimal.
  const withinCap = !!s && s.gt(0) && (input.smallestSpacingPrice !== undefined
    ? b.minus(a).abs().lte(D.min(a.mul('.001'), s.mul('.5')))
    : b.minus(a).abs().div(a).lte(D.min('.001', s.mul('.5'))));
  return withinCap && input.source === '/book' && input.identityValid
    && !input.sideFlip && input.rangeValid && Number.isSafeInteger(now) && Number.isSafeInteger(input.observedAt)
    && now >= input.observedAt && now - input.observedAt <= 5000;
}
export function gridAdxLabel(value: number | null): 'ranging' | 'transitional' | 'trending' | 'UNKNOWN' {
  return value === null || !Number.isFinite(value) || value < 0 || value > 100 ? 'UNKNOWN' : value < 20 ? 'ranging' : value <= 25 ? 'transitional' : 'trending';
}

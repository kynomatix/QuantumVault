import { assertSnapshot, signed, unsigned, type AccountingSnapshot, type AccountingTarget, type PositionEpoch } from './accounting-contract';

export function phoenixEquity(target: AccountingTarget, s: AccountingSnapshot, now: number) {
  assertSnapshot(s, target, now);
  const assets = [s.walletUsdcMicros, s.walletCollateralValueMicros, s.parkedValueMicros, s.externalDebtMicros,
    s.queuedWithdrawalMicros, s.freeMarginMicros];
  for (const value of assets) if (value !== null) unsigned(value);
  for (const value of [s.venueEquityMicros, s.unrealizedPnlMicros]) if (value !== null) signed(value);
  const operations = new Set<string>();
  for (const t of s.inTransit) {
    if (!t.operationId || !t.reference || operations.has(t.operationId)) throw new Error('Duplicate/unbound transit claim');
    operations.add(t.operationId); if (t.valueMicros !== null) unsigned(t.valueMicros);
  }
  const components = [s.walletUsdcMicros, s.walletCollateralValueMicros, s.venueEquityMicros, s.parkedValueMicros,
    ...s.inTransit.map(t => t.valueMicros)];
  const known = s.externalDebtMicros !== null && components.every(v => v !== null);
  return { venue: 'phoenix' as const, observedAt: s.observedAt, slot: s.slot, reference: s.reference,
    status: known ? 'complete' as const : 'unknown' as const,
    totalEquityMicros: known ? (components.reduce<bigint>((n, v) => n + signed(v!), 0n) - unsigned(s.externalDebtMicros!)).toString() : null,
    walletCashMicros: s.walletUsdcMicros, walletCollateralValueMicros: s.walletCollateralValueMicros,
    venueEquityMicros: s.venueEquityMicros, freeMarginMicros: s.freeMarginMicros,
    queuedWithdrawalMicros: s.queuedWithdrawalMicros, pendingReturns: s.inTransit,
    parkedValueMicros: s.parkedValueMicros, externalDebtMicros: s.externalDebtMicros,
    unrealizedPnlMicros: s.unrealizedPnlMicros,
    sizingAuthority: false as const, creatorPayoutsEnabled: false as const };
}

/** Incumbent creator-earnings/obligation/claim semantics are unresolved. This is
 * provenance for a FUTURE ledger binding, never a payable or a payment claim. */
export function phoenixPayoutProvenance(target: AccountingTarget, epoch: PositionEpoch,
  subscriber: { botId: string; payerWallet: string; creatorWallet: string; subscriptionId: string } | null) {
  if (subscriber && (subscriber.botId !== target.botId || subscriber.payerWallet !== target.ownerWallet
    || !subscriber.creatorWallet || !subscriber.subscriptionId || subscriber.creatorWallet === subscriber.payerWallet)) throw new Error('Phoenix subscriber/payer mismatch');
  return { venue: 'phoenix' as const, botId: target.botId, trader: target.identity.traderAccountAddress,
    positionEpoch: epoch.id, fillEventIds: epoch.eventIds, payerWallet: target.ownerWallet,
    subscription: subscriber, netRealizedPnlMicros: epoch.status === 'closed' ? epoch.netPnlMicros : null,
    venueFeesMicros: epoch.feeMicros, fundingMicros: epoch.fundingMicros,
    state: 'disabled_prerequisite' as const, payableMicros: null, flightFeeMicros: '0',
    requiresFundedWalletCash: true };
}

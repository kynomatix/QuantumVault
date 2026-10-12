import { assertBorrowSnapshot, borrowHash, raw, validateBorrowIntent, type BorrowSnapshot, type PhoenixBorrowIntent } from './borrow-contract';
import type { ParkingIntent, ParkingLeg, ParkingRecord, ParkingSnapshot } from './parking-contract';
import type { CarryEconomics } from './carry-policy';
import type { PerBotPositionHealth } from '../../vault/borrow-health';

export interface CarryConsent {
  closeOrderId: string; positionEpoch: string;
  /** Explicit immutable choice, separate from any recommendation. */
  choice: 'carry' | 'repay'; allowRepay: boolean; expiresAt: number;
  reserveRaw: string; maxRepayRaw: string;
  horizonSeconds: number; maxQueueSeconds: number; maxQueueCostUsd: number;
  /** Server-resolved existing bot loan only. Never an open/grow instruction. */
  loan: PhoenixBorrowIntent;
}
export interface CarryFacts {
  parking: ParkingSnapshot; lender: BorrowSnapshot; health: PerBotPositionHealth;
  close: { orderId: string; positionEpoch: string; authoritative: boolean; fullyClosed: boolean };
  /** Persisted opt-ins re-read, not the original HTTP body. */
  autoRepayEnabled: boolean;
  economics: CarryEconomics;
}
export function validateCarryConsent(i: ParkingIntent) {
  const c = i.carry;
  if (i.action !== 'carry' || !c || !c.closeOrderId || !c.positionEpoch || !['carry','repay'].includes(c.choice)
    || typeof c.allowRepay !== 'boolean' || !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= 0
    || !Number.isFinite(c.horizonSeconds) || c.horizonSeconds <= 0 || !Number.isFinite(c.maxQueueSeconds) || c.maxQueueSeconds <= 0
    || !Number.isFinite(c.maxQueueCostUsd) || c.maxQueueCostUsd < 0 || c.loan.action !== 'repay' || c.loan.automation
    || c.loan.botId !== i.botId || c.loan.ownerWallet !== i.ownerWallet || borrowHash(c.loan.identity) !== borrowHash(i.identity)
    || c.loan.consent.accountCollateral || c.loan.consent.deployBorrowed || !c.loan.consent.reserve
    || c.loan.collateralRaw !== '0' || (c.choice === 'repay' && !c.allowRepay)) throw new Error('Invalid carry consent');
  validateBorrowIntent(c.loan); raw(c.reserveRaw); raw(c.maxRepayRaw);
}
export function assertCarryFacts(i: ParkingIntent, f: CarryFacts, now: number) {
  validateCarryConsent(i);
  const c = i.carry!;
  assertBorrowSnapshot(c.loan,f.lender,now,5000);
  if (!Number.isSafeInteger(f.lender.observedAt) || now - f.lender.observedAt >= 5000
    || !Number.isSafeInteger(f.lender.oracleObservedAt) || f.lender.oracleObservedAt > now || now - f.lender.oracleObservedAt >= 5000
    || f.health.status !== 'available' || f.health.borrowPositionId !== c.loan.botLoanId || f.health.venuePositionId !== c.loan.botVenueId
    || f.health.collateralMint !== c.loan.collateralMint || f.health.liveDebtRaw !== f.lender.debtRaw
    || f.health.liveCollateralRaw !== f.lender.collateralRaw || f.parking.walletUsdc !== f.lender.walletUsdcRaw
    || f.parking.pendingReturnUsdc !== f.lender.queuedUsdcRaw
    || !f.close.authoritative || !f.close.fullyClosed || f.close.orderId !== c.closeOrderId || f.close.positionEpoch !== c.positionEpoch) throw new Error('Fresh close, debt and health authority required');
  if (f.economics.destination !== i.destination || f.economics.horizonSeconds !== c.horizonSeconds
    || f.economics.maxQueueSeconds !== c.maxQueueSeconds || f.economics.maxQueueCostUsd !== c.maxQueueCostUsd
    || f.economics.debtUsd !== Number(raw(f.lender.debtRaw!)) / 1e6
    || f.economics.healthSummary.headline.band !== f.health.band || f.economics.healthSummary.headline.actionBlocked
    || f.economics.history.some(o => o.bot_id !== i.botId || o.intent.ownerWallet !== i.ownerWallet
      || borrowHash(o.intent.identity) !== borrowHash(i.identity))) throw new Error('Carry economics binding mismatch');
  const held = f.parking.holdings.filter(h => raw(h.tokenUnits) > 0n);
  if (held.length > 1 || (held[0]?.asset ?? null) !== f.economics.parkedAsset) throw new Error('Parked asset authority unavailable');
}
export function carryRepayIntent(r: ParkingRecord, leg: ParkingLeg): PhoenixBorrowIntent {
  if (!r.intent.carry || leg.kind !== 'repay' || !leg.targetFinalDebtRaw) throw new Error('Carry repayment leg required');
  return {...r.intent.carry.loan,requestKey:leg.key,amountRaw:leg.amount,collateralRaw:'0',
    automation:{kind:'carry',targetFinalDebtRaw:leg.targetFinalDebtRaw,parkingIntentId:r.id}};
}

import type { PhoenixTraderIdentity } from '../../../shared/phoenix-read-contract';
import { assertPhoenixIdentity } from './identity';
import { orderIntentHash } from './order-contract';

export interface AccountingTarget { botId: string; ownerWallet: string; identity: PhoenixTraderIdentity }
export interface EventOrder { slot: string; slotIndex: number; instructionIndex: number; eventIndex: number }
/** Signed USDC micro-units. Fees are costs (negative means maker rebate);
 * funding is a credit (negative means payment). Gross PnL excludes BOTH. */
export interface AccountingEvent extends EventOrder {
  id: string; trader: string; market: string; signature: string; timestamp: number;
  source: string; reference: string;
  kind: 'fill' | 'liquidation' | 'adl' | 'funding';
  beforeLots: string; afterLots: string;
  orderId: string | null; fillId: string | null;
  /** Funding can settle after flat; bind its economic epoch independently of current lots. */
  fundingEpochOpeningEventId: string | null;
  grossPnlMicros: string | null; feeMicros: string | null; fundingMicros: string | null;
  feeTierReference: string | null;
}
export interface AccountingSnapshot {
  venue: 'phoenix'; trader: string; slot: string; observedAt: number;
  source: string; reference: string; finalized: true; complete: true; refreshFailed: false;
  /** Explicit signed lots for EVERY market, from the same finalized account context. */
  positions: Record<string, string>;
  walletUsdcMicros: string | null;
  walletCollateralValueMicros: string | null;
  venueEquityMicros: string | null; freeMarginMicros: string | null;
  /** Queue is a memorandum subset of venue equity/collateral, NEVER added. */
  queuedWithdrawalMicros: string | null;
  /** Only finalized claims already debited from venue and absent from both wallets. */
  inTransit: { operationId: string; reference: string; valueMicros: string | null }[];
  parkedValueMicros: string | null; externalDebtMicros: string | null;
  unrealizedPnlMicros: string | null;
}
export interface AccountingOrigin {
  registrationSignature: string; slot: string; reference: string; flat: true;
}
export interface HistoryPage {
  trader: string; origin: AccountingOrigin; throughSlot: string;
  cursor: string | null; nextCursor: string | null; hasMore: boolean;
  /** Provider attests fills, liquidations/ADL AND funding indexed through this slot.
   * REST hasMore=false alone does not establish this property. */
  indexedThroughSlot: string; finalized: true; complete: true; reference: string;
  events: AccountingEvent[];
}
export interface PositionEpoch {
  id: string; market: string; side: 'long' | 'short'; openedAt: number; closedAt: number | null;
  openingEventId: string; closingEventId: string | null; eventIds: string[];
  baseLots: string; grossPnlMicros: string | null; feeMicros: string | null;
  fundingMicros: string | null; netPnlMicros: string | null;
  status: 'open' | 'closed'; accounting: 'complete' | 'incomplete'; liquidation: boolean;
  feeTierReferences: string[];
}
export function signed(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|-?[1-9][0-9]{0,38})$/.test(value)) throw new Error('Invalid accounting integer');
  return BigInt(value);
}
export function unsigned(value: string): bigint {
  const n = signed(value); if (n < 0n) throw new Error('Negative unsigned accounting value'); return n;
}
export function accountingId(value: unknown): string { return `phoenix:${orderIntentHash(value)}`; }
export function assertTarget(target: AccountingTarget) {
  assertPhoenixIdentity(target.identity);
  if (!target.botId || !target.ownerWallet) throw new Error('Accounting owner missing');
}
export function compareEvent(a: EventOrder, b: EventOrder): number {
  const x = unsigned(a.slot), y = unsigned(b.slot);
  return x < y ? -1 : x > y ? 1 : a.slotIndex - b.slotIndex || a.instructionIndex - b.instructionIndex || a.eventIndex - b.eventIndex;
}
export function assertEvent(e: AccountingEvent, target: AccountingTarget) {
  unsigned(e.slot); signed(e.beforeLots); signed(e.afterLots);
  if (e.trader !== target.identity.traderAccountAddress || !e.id || !e.market || !e.signature || !e.source || !e.reference
    || !['fill', 'liquidation', 'adl', 'funding'].includes(e.kind)
    || ![e.slotIndex, e.instructionIndex, e.eventIndex, e.timestamp].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Unbound accounting event');
  for (const v of [e.grossPnlMicros, e.feeMicros, e.fundingMicros]) if (v !== null) signed(v);
  if (e.kind === 'funding') {
    if (e.beforeLots !== e.afterLots || !e.fundingEpochOpeningEventId || e.grossPnlMicros !== '0' || e.feeMicros !== '0') throw new Error('Invalid funding settlement');
  } else if (e.fundingEpochOpeningEventId !== null || (e.fillId !== null && !e.fillId) || e.beforeLots === e.afterLots || e.fundingMicros !== '0') throw new Error('Invalid fill identity or quantity');
}
export function assertSnapshot(s: AccountingSnapshot, target: AccountingTarget, now: number) {
  assertTarget(target); unsigned(s.slot);
  if (s.venue !== 'phoenix' || s.trader !== target.identity.traderAccountAddress || s.finalized !== true
    || s.complete !== true || s.refreshFailed !== false || !s.source || !s.reference
    || !Number.isSafeInteger(s.observedAt) || !Number.isSafeInteger(now) || s.observedAt > now || now - s.observedAt >= 30_000) throw new Error('Phoenix accounting snapshot unavailable');
  if (!s.positions || Array.isArray(s.positions)) throw new Error('Positions missing');
  for (const [market, lots] of Object.entries(s.positions)) { if (!market) throw new Error('Market missing'); signed(lots); }
}

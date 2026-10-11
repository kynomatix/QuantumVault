import { identity, intent, now } from './phoenix-orders';
import type { AccountingEvent, AccountingSnapshot, HistoryPage } from '../../server/protocol/phoenix/accounting-contract';
import type { AccountingRepository, AccountingState } from '../../server/protocol/phoenix/accounting-service';
export { now, identity };
export const target = { botId: intent().botId, ownerWallet: intent().ownerWallet, identity };
export const origin = { registrationSignature: 'EXAMPLE-register-signature'.padEnd(64,'X'), slot: '1', reference: 'EXAMPLE-registration', flat: true as const };
export function event(n: number, before: string, after: string, patch: Partial<AccountingEvent> = {}): AccountingEvent {
  return { id: `EXAMPLE-event-${n}`, trader: identity.traderAccountAddress, market: 'SOL', signature: `EXAMPLE-signature-${n}`,
    timestamp: now - 1000 + n, slot: String(n + 1), slotIndex: 0, instructionIndex: 0, eventIndex: 0,
    source: 'EXAMPLE-chain', reference: `EXAMPLE-reference-${n}`, kind: 'fill', beforeLots: before, afterLots: after,
    orderId: `EXAMPLE-order-${n}`, fillId: `EXAMPLE-fill-${n}`, fundingEpochOpeningEventId: null, grossPnlMicros: '0', feeMicros: '10', fundingMicros: '0',
    feeTierReference: 'EXAMPLE-account-tier', ...patch };
}
export function snapshot(positions: Record<string, string> = {}, patch: Partial<AccountingSnapshot> = {}): AccountingSnapshot {
  return { venue: 'phoenix', trader: identity.traderAccountAddress, slot: '100', observedAt: now, source: 'EXAMPLE-chain',
    reference: 'EXAMPLE-snapshot', finalized: true, complete: true, refreshFailed: false, positions,
    walletUsdcMicros: '100', walletCollateralValueMicros: '200', venueEquityMicros: '1000', freeMarginMicros: '800',
    queuedWithdrawalMicros: '250', inTransit: [], parkedValueMicros: '300', externalDebtMicros: '50', unrealizedPnlMicros: '60', ...patch };
}
export function page(events: AccountingEvent[], patch: Partial<HistoryPage> = {}): HistoryPage {
  return { trader: identity.traderAccountAddress, origin, throughSlot: '100', cursor: null, nextCursor: null,
    hasMore: false, indexedThroughSlot: '100', finalized: true, complete: true, reference: 'EXAMPLE-history', events, ...patch };
}
export class MemoryAccountingStore implements AccountingRepository {
  state: AccountingState = { revision: 0, status: 'unknown', origin: null, events: [], epochs: [], snapshot: null };
  async read() { return structuredClone(this.state); }
  async commit(_target: unknown, revision: number, next: AccountingState) {
    if (this.state.revision !== revision) throw new Error('stale'); this.state = structuredClone(next);
  }
  async invalidate(_target: unknown, revision: number) {
    if (this.state.revision === revision) { this.state.status = 'unknown'; this.state.revision++; }
  }
}

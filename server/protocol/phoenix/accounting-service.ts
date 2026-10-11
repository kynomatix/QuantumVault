import { assertSnapshot, assertTarget, unsigned, type AccountingEvent, type AccountingOrigin,
  type AccountingSnapshot, type AccountingTarget, type HistoryPage, type PositionEpoch } from './accounting-contract';
import { orderIntentHash } from './order-contract';
import { enrichEvent, reducePhoenixHistory } from './accounting-reducer';
import { phoenixEquity } from './accounting-equity';

export interface AccountingState {
  revision: number; status: 'complete' | 'unknown'; origin: AccountingOrigin | null;
  events: AccountingEvent[]; epochs: PositionEpoch[]; snapshot: AccountingSnapshot | null;
}
export interface AccountingRepository {
  read(target: AccountingTarget): Promise<AccountingState>;
  commit(target: AccountingTarget, expectedRevision: number, next: AccountingState): Promise<void>;
  invalidate(target: AccountingTarget, expectedRevision: number): Promise<void>;
}
export interface PhoenixAccountingIO {
  snapshot(target: AccountingTarget): Promise<AccountingSnapshot>;
  /** Full replay from registration, including overlap, after EVERY reconnect.
   * Must reject truncated, unavailable, or not-yet-indexed history. */
  history(target: AccountingTarget, throughSlot: string, cursor: string | null): Promise<HistoryPage>;
}
export class PhoenixAccountingService {
  constructor(private readonly store: AccountingRepository, private readonly io: PhoenixAccountingIO, private readonly now = Date.now) {}
  async reconcile(target: AccountingTarget) {
    target = structuredClone(target); assertTarget(target);
    const prior = await this.store.read(target);
    try {
      const snapshot = await this.io.snapshot(structuredClone(target)); assertSnapshot(snapshot, target, this.now());
      if (prior.snapshot && unsigned(snapshot.slot) < unsigned(prior.snapshot.slot)) throw new Error('Accounting watermark regressed');
      let cursor: string | null = null, origin: AccountingOrigin | null = null;
      const cursors = new Set<string>(), incoming = new Map<string, AccountingEvent>();
      for (let pages = 0; ; pages++) {
        if (pages >= 128) throw new Error('History exceeds bounded replay budget');
        const p = await this.io.history(structuredClone(target), snapshot.slot, cursor);
        if (p.trader !== target.identity.traderAccountAddress || p.throughSlot !== snapshot.slot || p.cursor !== cursor
          || p.finalized !== true || p.complete !== true || !p.reference || !p.origin?.registrationSignature || !p.origin.reference
          || p.origin.flat !== true || unsigned(p.indexedThroughSlot) < unsigned(snapshot.slot)
          || unsigned(p.origin.slot) > unsigned(snapshot.slot) || !Array.isArray(p.events) || p.events.length > 1000
          || typeof p.hasMore !== 'boolean' || p.hasMore !== (p.nextCursor !== null)
          || (p.nextCursor !== null && (typeof p.nextCursor !== 'string' || !p.nextCursor || cursors.has(p.nextCursor)))) throw new Error('Incomplete Phoenix history page');
        if ((origin && orderIntentHash(origin) !== orderIntentHash(p.origin))
          || (prior.origin && orderIntentHash(prior.origin) !== orderIntentHash(p.origin))) throw new Error('History origin changed');
        origin = p.origin;
        for (const event of p.events) {
          if (unsigned(event.slot) < unsigned(origin.slot)) throw new Error('Event precedes registration');
          const existing = incoming.get(event.id);
          incoming.set(event.id, existing ? enrichEvent(existing, event) : event);
        }
        if (!p.hasMore) break;
        cursor = p.nextCursor!; cursors.add(cursor);
      }
      // Missing an old round trip would not change today's lots. Retained events
      // therefore also have to be present in every authoritative full replay.
      for (const e of prior.events) {
        const next = incoming.get(e.id); if (!next) throw new Error('History backfill lost an event');
        incoming.set(e.id, enrichEvent(e, next));
      }
      const events = [...incoming.values()];
      const epochs = reducePhoenixHistory(target, events, snapshot, this.now());
      const equity = phoenixEquity(target, snapshot, this.now());
      await this.store.commit(target, prior.revision, { revision: prior.revision + 1, status: 'complete', origin, events, epochs, snapshot });
      return { synced: true, discrepancy: false, epochs, equity, liquidation: epochs.some(e => e.liquidation) };
    } catch {
      await this.store.invalidate(target, prior.revision);
      return { synced: false, discrepancy: true, epochs: null, equity: null };
    }
  }
}

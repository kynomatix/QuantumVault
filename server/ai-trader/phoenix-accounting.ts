import type { AccountingState } from '../protocol/phoenix/accounting-service';
import { assertSnapshot, signed } from '../protocol/phoenix/accounting-contract';
import { reducePhoenixHistory } from '../protocol/phoenix/accounting-reducer';
import { orderIntentHash } from '../protocol/phoenix/order-contract';
import type { PhoenixOrderRecord } from '../protocol/phoenix/order-store';

/** Attribute the complete U07/U08 economic epoch to both durable order fills.
 * Venue acknowledgements, mark prices and a matching flat balance cannot do so. */
export function phoenixAiClosedAccounting(state: AccountingState, entry: PhoenixOrderRecord,
  close: PhoenixOrderRecord, now: number) {
  const i = entry.intent, target = { botId: i.botId, ownerWallet: i.ownerWallet, identity: i.identity };
  if (state.status !== 'complete' || !state.snapshot || !state.origin || close.intent.botId !== i.botId
    || close.intent.ownerWallet !== i.ownerWallet || close.intent.market !== i.market
    || orderIntentHash(close.intent.identity) !== orderIntentHash(i.identity)) throw new Error('Phoenix AI accounting unknown');
  assertSnapshot(state.snapshot, target, now);
  if (orderIntentHash(reducePhoenixHistory(target, state.events, state.snapshot, now)) !== orderIntentHash(state.epochs)) throw new Error('Phoenix AI accounting epochs changed');
  const fillEvents = (o: PhoenixOrderRecord) => {
    if (!o.data.orderId || !o.data.fills?.length) throw new Error('Phoenix AI accounting fill identity missing');
    return o.data.fills.map(f => {
      const matches = state.events.filter(e => e.market === i.market && e.orderId === o.data.orderId && e.fillId === f.fillId);
      if (matches.length !== 1) throw new Error('Phoenix AI accounting fill incomplete');
      return matches[0];
    });
  };
  const entries = fillEvents(entry), exits = fillEvents(close);
  const epochs = state.epochs.filter(e => e.market === i.market && e.status === 'closed'
    && e.accounting === 'complete' && entries.some(x => x.id === e.openingEventId)
    && exits.some(x => x.id === e.closingEventId) && [...entries, ...exits].every(x => e.eventIds.includes(x.id)));
  if (epochs.length !== 1 || epochs[0].closedAt === null || epochs[0].netPnlMicros === null || epochs[0].feeMicros === null) throw new Error('Phoenix AI accounting epoch unavailable');
  const e = epochs[0], pnl = signed(e.netPnlMicros!), fees = signed(e.feeMicros!);
  if (pnl > BigInt(Number.MAX_SAFE_INTEGER) || pnl < -BigInt(Number.MAX_SAFE_INTEGER)
    || fees > BigInt(Number.MAX_SAFE_INTEGER) || fees < 0n) throw new Error('Phoenix AI accounting display overflow');
  return { realizedPnl: Number(pnl) / 1000000, feesPaid: Number(fees) / 1000000,
    closedAt: new Date(e.closedAt!), liquidation: e.liquidation };
}

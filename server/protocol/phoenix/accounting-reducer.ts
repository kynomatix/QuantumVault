import { accountingId, assertEvent, assertSnapshot, compareEvent, signed, unsigned,
  type AccountingEvent, type AccountingTarget, type AccountingSnapshot, type PositionEpoch } from './accounting-contract';

const add = (a: string | null, b: string | null) => a === null || b === null ? null : (signed(a) + signed(b)).toString();
const abs = (v: bigint) => v < 0n ? -v : v;

/** Rebuild from immutable registration-flat history. Arrival order is irrelevant.
 * Each epoch runs from first open, through adds/partial closes, to flat. A flip
 * ends the old epoch and starts another with the residual of the SAME fill. */
export function reducePhoenixHistory(target: AccountingTarget, events: AccountingEvent[], snapshot: AccountingSnapshot, now: number): PositionEpoch[] {
  assertSnapshot(snapshot, target, now);
  const sorted = [...events].sort(compareEvent), epochs: PositionEpoch[] = [];
  const active = new Map<string, PositionEpoch>(), positions = new Map<string, bigint>(), ids = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i]; assertEvent(e, target);
    if (ids.has(e.id) || (i > 0 && compareEvent(sorted[i - 1], e) === 0) || unsigned(e.slot) > unsigned(snapshot.slot)
      || e.timestamp > snapshot.observedAt || (i > 0 && e.timestamp < sorted[i - 1].timestamp)) throw new Error('Duplicate or unordered accounting identity');
    ids.add(e.id);
    const before = signed(e.beforeLots), after = signed(e.afterLots);
    if ((positions.get(e.market) ?? 0n) !== before) throw new Error('Phoenix history gap or missing opening basis');
    let epoch = active.get(e.market);
    const open = (suffix: string, lots: bigint) => {
      const row: PositionEpoch = { id: accountingId([target.identity, e.market, e.id, suffix]), market: e.market,
        side: lots > 0n ? 'long' : 'short', openedAt: e.timestamp, closedAt: null, openingEventId: e.id,
        closingEventId: null, eventIds: [], baseLots: lots.toString(), grossPnlMicros: '0', feeMicros: '0',
        fundingMicros: '0', netPnlMicros: '0', status: 'open', accounting: 'complete', liquidation: false, feeTierReferences: [] };
      epochs.push(row); active.set(e.market, row); return row;
    };
    const accumulate = (row: PositionEpoch, gross: string | null, fee: string | null, funding: string | null) => {
      row.eventIds.push(e.id); row.grossPnlMicros = add(row.grossPnlMicros, gross);
      row.feeMicros = add(row.feeMicros, fee); row.fundingMicros = add(row.fundingMicros, funding);
      if (e.feeTierReference && !row.feeTierReferences.includes(e.feeTierReference)) row.feeTierReferences.push(e.feeTierReference);
      row.liquidation ||= e.kind === 'liquidation' || e.kind === 'adl';
      row.accounting = [row.grossPnlMicros, row.feeMicros, row.fundingMicros].includes(null) ? 'incomplete' : 'complete';
      row.netPnlMicros = row.accounting === 'complete'
        ? (signed(row.grossPnlMicros!) - signed(row.feeMicros!) + signed(row.fundingMicros!)).toString() : null;
    };
    if (e.kind === 'funding') {
      const fundedEpoch = epochs.find(row => row.market === e.market && row.openingEventId === e.fundingEpochOpeningEventId);
      if (!fundedEpoch) throw new Error('Funding epoch unknown');
      accumulate(fundedEpoch, '0', '0', e.fundingMicros); continue;
    }
    if (before === 0n) epoch = open('open', after);
    if (!epoch) throw new Error('Opening epoch missing');
    // Opening/add fills cannot introduce realized profit without a reduction.
    const reduction = before !== 0n && (after === 0n || (before > 0n) !== (after > 0n) || abs(after) < abs(before));
    if (!reduction && e.grossPnlMicros !== null && e.grossPnlMicros !== '0') throw new Error('Unexpected PnL on an opening fill');
    const flip = before !== 0n && after !== 0n && (before > 0n) !== (after > 0n);
    const fee = flip && e.feeMicros !== null ? (signed(e.feeMicros) * abs(before) / abs(after - before)).toString() : e.feeMicros;
    accumulate(epoch, e.grossPnlMicros, fee, '0');
    epoch.baseLots = flip ? '0' : e.afterLots;
    if (after === 0n || flip) {
      epoch.status = 'closed'; epoch.closedAt = e.timestamp; epoch.closingEventId = e.id; active.delete(e.market);
    }
    if (flip) {
      const next = open('flip', after);
      accumulate(next, '0', e.feeMicros === null ? null : (signed(e.feeMicros) - signed(fee!)).toString(), '0');
    }
    positions.set(e.market, after);
  }
  for (const market of new Set([...positions.keys(), ...Object.keys(snapshot.positions)])) {
    if ((positions.get(market) ?? 0n) !== signed(snapshot.positions[market] ?? '0')) throw new Error('Delayed history or inconsistent finalized position');
  }
  return epochs;
}

/** Known numeric fields may be filled in later, never silently rewritten. */
export function enrichEvent(previous: AccountingEvent, next: AccountingEvent): AccountingEvent {
  const old = { ...previous }, candidate = { ...next };
  for (const key of ['grossPnlMicros', 'feeMicros', 'fundingMicros', 'feeTierReference', 'fillId'] as const) {
    if (old[key] === null) old[key] = candidate[key];
  }
  if (JSON.stringify(Object.entries(old).sort()) !== JSON.stringify(Object.entries(candidate).sort())) throw new Error('Conflicting Phoenix history event');
  return candidate;
}

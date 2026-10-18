import Decimal from 'decimal.js';
import { replayGridCycles, type CycleReplayInput, type CycleOperation } from './cycle-replay';
const D = Decimal.clone({ precision: 200 });
export interface CycleCapacity {
  envelope: string; ceiling: string; held: string; reserved: string; used: string; remaining: string; breached: boolean;
}
/** Rebuilt exclusively from immutable requests and reconciled fills under the bot lock.
 * No quota is money: an owner gets a reservation only when its whole request is admitted. */
export function cycleCapacity(input: CycleReplayInput, mark: string, candidate?: CycleOperation): CycleCapacity | undefined {
  if (input.policy.sizingVersion !== 'lean-1') return undefined;
  const replay = replayGridCycles(input);
  if (!replay.ok) throw Error(replay.reason);
  const envelope = new D(input.policy.safetyEnvelopePrice!), ceiling = new D(input.policy.totalInvestment).mul(input.policy.leverage);
  if (!envelope.gt(0) || !new D(mark).isFinite() || !new D(mark).gt(0)) throw Error('Cycle capacity price unavailable');
  const held = replay.cycles.reduce((s, c) => s.plus(c.held), new D(0));
  const operations = [...new Map(input.operations.map(o => [o.id, o])).values()];
  let reserved = new D(0);
  for (const op of operations.filter(o => !o.reduceOnly)) {
    const progress = input.progress.find(p => p.operationId === op.id);
    let amount = new D(op.size); // Unknown, submitted and uncertain terminal requests retain their FULL amount.
    // Even a live partial cancellation needs a reconciled terminal proof to release money.
    if (progress?.state === 'live') amount = amount.minus(progress.filledSize!);
    else if (progress?.state === 'terminal'
      && Number.isSafeInteger(progress.terminalAt) && Number.isSafeInteger(progress.historyThrough)
      && progress.terminalAt! >= op.preparedAt && progress.historyThrough! >= progress.terminalAt!
      && progress.historyThrough! <= progress.observedAt
      && input.fills.filter(f => f.operationId === op.id).every(f => f.time <= progress.terminalAt!)) amount = new D(0);
    reserved = reserved.plus(amount);
  }
  if (candidate && !candidate.reduceOnly) {
    if (operations.some(o => o.id === candidate.id) || !new D(candidate.size).gt(0)) throw Error('Duplicate or invalid capacity candidate');
    reserved = reserved.plus(candidate.size);
  }
  const used = held.plus(reserved).mul(envelope);
  const breached = new D(mark).gt(envelope) || input.fills.some(f => f.leg === 'entry' && new D(f.price).gt(envelope))
    || operations.some(o => !o.reduceOnly && o.price !== null && new D(o.price).gt(envelope))
    || !!candidate && !candidate.reduceOnly && candidate.price !== null && new D(candidate.price).gt(envelope);
  return { envelope: envelope.toFixed(), ceiling: ceiling.toFixed(), held: held.mul(envelope).toFixed(), reserved: reserved.mul(envelope).toFixed(),
    used: used.toFixed(), remaining: D.max(0, ceiling.minus(used)).toFixed(), breached };
}
export function requireCycleCapacity(capacity: CycleCapacity | undefined) {
  if (capacity && (capacity.breached || new D(capacity.used).gt(capacity.ceiling))) throw Error('Waiting for room');
}

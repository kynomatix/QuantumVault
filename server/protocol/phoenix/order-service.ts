import { admitPhoenixOrder, orderIntentHash, validateOrderIntent, type PhoenixOrderIntent, type PhoenixOrderAuthority } from './order-contract';
import { signOrderTransaction, validateOrderPin, type PhoenixOrderPin } from './order-builder';
import type { OrderRepository, PhoenixOrderRecord, PhoenixFill } from './order-store';
import { units } from './funding-contract';

export interface PhoenixOrderReceipt {
  venue: 'phoenix'; trader: string; market: string; intentId: string; signature: string;
  orderId: string; positionEpoch: string; source: string; reference: string;
  landed: boolean; complete: boolean; fills: PhoenixFill[];
}
export interface PhoenixOrderIO {
  /** Fresh authoritative metadata/account-tier fees/free margin and execution quote, never display data. */
  snapshot(intent: PhoenixOrderIntent): Promise<PhoenixOrderAuthority>;
  /** Uses U04 durable funding with executionOrderId=record.id and fixed request keys.
   * Must return only after settlement; U10 unpark joins here under the same durable intent. */
  fund(record: PhoenixOrderRecord): Promise<void>;
  lifetime(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  blockHeight(): Promise<number>;
  /** Production implementation must use custody.withPhoenixBotSigner. No runtime is installed. */
  withSigner<T>(intent: PhoenixOrderIntent, sign: (secret: Uint8Array) => T): Promise<T>;
  submit(transaction: string): Promise<string>;
  receipt(record: PhoenixOrderRecord): Promise<PhoenixOrderReceipt | null>;
}

/** Accepted != landed != filled. One claimed attempt, no blind resend on any failure. */
export class PhoenixOrderService {
  private readonly pin: PhoenixOrderPin;
  constructor(private readonly store: OrderRepository, private readonly io: PhoenixOrderIO,
    pin: PhoenixOrderPin, private readonly entryEnabled = () => false, private readonly now = Date.now) {
    this.pin = structuredClone(pin);
  }
  async execute(input: PhoenixOrderIntent): Promise<PhoenixOrderRecord> {
    const i = structuredClone(input); validateOrderIntent(i);
    const previous = await this.store.find(i);
    if (previous) return this.reconcile(i, previous.id);
    if (i.action === 'entry' && !this.entryEnabled()) throw new Error('Phoenix entry disabled');
    const admission = admitPhoenixOrder(i, await this.io.snapshot(structuredClone(i)), this.now());
    validateOrderPin(i, admission, this.pin);
    const prepared = await this.store.prepare(i, admission);
    if (!prepared.created) return this.reconcile(i, prepared.record.id);
    let record = prepared.record;
    try {
      if (i.action === 'entry' && !this.entryEnabled()) return await this.store.change(record, 'rejected', { reason: 'Entry disabled before funding' });
      // Refresh before the first money side effect as DB lock acquisition may have waited.
      const preFunding = admitPhoenixOrder(i, await this.io.snapshot(structuredClone(i)), this.now());
      validateOrderPin(i, preFunding, this.pin);
      if (units(preFunding.fundingShortfallMicros) > 0n) {
        record = await this.store.change(record, 'funding', { admission: preFunding });
        if (!this.entryEnabled()) throw new Error('Entry disabled before funding');
        await this.io.fund(structuredClone(record));
      }
      const lifetime = await this.io.lifetime();
      const latest = admitPhoenixOrder(i, await this.io.snapshot(structuredClone(i)), this.now(), true);
      if (latest.authority.assetId !== admission.authority.assetId || latest.authority.tickSize !== admission.authority.tickSize
        || latest.authority.baseLotsDecimals !== admission.authority.baseLotsDecimals
        || latest.authority.position.epoch !== admission.authority.position.epoch) throw new Error('Phoenix execution identity changed');
      if (i.action === 'entry' && !this.entryEnabled()) throw new Error('Phoenix entry disabled before signing');
      record = await this.store.change(record, 'signing', { admission: latest });
      const signed = await this.io.withSigner(structuredClone(i), secret => {
        if (i.action === 'entry' && !this.entryEnabled()) throw new Error('Phoenix entry disabled at signer');
        return signOrderTransaction(i, latest, this.pin, lifetime, secret, this.now());
      });
      const { transaction, ...attempt } = signed;
      // Store the signature before send. A lost DB acknowledgement NEVER authorizes send.
      record = await this.store.change(record, 'submission_pending', { attempt });
      const height = await this.io.blockHeight();
      admitPhoenixOrder(i, latest.authority, this.now(), true);
      if (!Number.isSafeInteger(height) || height < 0 || height > lifetime.lastValidBlockHeight
        || (i.action === 'entry' && !this.entryEnabled())) throw new Error('Order lifetime/entry revoked');
      if (await this.io.submit(transaction) !== signed.signature) throw new Error('Unexpected order signature');
      record = await this.store.change(record, 'accepted');
    } catch {
      const current = await this.store.read(i, record.id);
      if (['admitted', 'signing'].includes(current.state) && !current.data.attempt && record.state !== 'funding') {
        // Admission/signing rejection has no sent transaction. Funding may still need recovery.
        if (current.state === 'admitted') return this.store.change(current, 'rejected', { reason: 'Admission revoked before side effects' });
      }
      if (['funding', 'signing', 'submission_pending', 'accepted'].includes(current.state)) {
        return this.store.change(current, 'unknown', { reason: 'Outcome requires authoritative recovery; do not resubmit' });
      }
      return current;
    }
    return this.reconcile(i, record.id);
  }
  /** U07 handoff: exact fills and remaining quantity, no invented average or flat proof. */
  async reconcile(i: PhoenixOrderIntent, id: string): Promise<PhoenixOrderRecord> {
    const record = await this.store.read(i, id);
    if (['settled', 'rejected'].includes(record.state) || !record.data.attempt) return record;
    let r: PhoenixOrderReceipt | null;
    try { r = await this.io.receipt(structuredClone(record)); } catch { return record; }
    if (!r) return record;
    try {
      if (r.venue !== 'phoenix' || r.trader !== i.identity.traderAccountAddress || r.market !== i.market || r.intentId !== id
        || r.signature !== record.data.attempt.signature || !r.orderId || !r.source || !r.reference || !r.landed
        || r.positionEpoch !== record.data.admission.authority.position.epoch || !Array.isArray(r.fills)) throw new Error('Unbound Phoenix receipt');
      if (record.data.orderId && record.data.orderId !== r.orderId) throw new Error('Order identity changed');
      const fills = new Map<string, PhoenixFill>();
      let filled = 0n;
      for (const f of [...(record.data.fills || []), ...r.fills]) {
        if (!f.fillId || f.orderId !== r.orderId || units(f.baseLots) === 0n || units(f.quoteMicros) === 0n
          || !/^-?(0|[1-9][0-9]{0,19})$/.test(f.feeMicros) || f.feeMicros.includes('\n')) throw new Error('Invalid actual fill');
        if (fills.has(f.fillId)) {
          if (orderIntentHash(fills.get(f.fillId)) !== orderIntentHash(f)) throw new Error('Conflicting fill identity');
          continue;
        }
        fills.set(f.fillId, f); filled += units(f.baseLots);
      }
      const requested = units(record.data.admission.packet.numBaseLots);
      if (filled > requested) throw new Error('Fill exceeds intent');
      if (r.complete && filled > 0n && filled < units(record.data.admission.packet.minBaseLotsToFill)) throw new Error('Venue fill violated minimum policy');
      return await this.store.change(record, r.complete ? 'settled' : 'landed', { orderId: r.orderId, fills: [...fills.values()],
        remainingLots: (requested - filled).toString(),
        remainingPositionLots: i.action === 'close' ? (units(record.data.admission.authority.position.baseLots) - filled).toString() : filled.toString(),
        positionEpoch: r.positionEpoch, outcomeSource: r.source, outcomeReference: r.reference });
    } catch { return this.store.read(i, id); }
  }
}

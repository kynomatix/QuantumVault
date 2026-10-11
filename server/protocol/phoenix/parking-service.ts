import { units } from './funding-contract';
import { assertParkingSnapshot, minUnits, parkingAuthorized, validateParkingIntent,
  type ParkingIntent, type ParkingLeg, type ParkingReceipt, type ParkingRecord, type ParkingSnapshot } from './parking-contract';

export interface ParkingRepository {
  prepare(intent: ParkingIntent): Promise<ParkingRecord>;
  read(intent: ParkingIntent): Promise<ParkingRecord>;
  claim(record: ParkingRecord, leg: ParkingLeg): Promise<ParkingRecord>;
  observe(record: ParkingRecord, receipt: ParkingReceipt): Promise<ParkingRecord>;
  finish(record: ParkingRecord, state: 'completed' | 'cancelled' | 'attention'): Promise<ParkingRecord>;
}
export interface PhoenixParkingIO {
  snapshot(intent: ParkingIntent): Promise<ParkingSnapshot>;
  /** A claimed leg is submitted once. Funding uses U04; vault implementations MUST
   * persist the signed attempt before send and measure finalized token deltas.
   * Never install legacy parkUsdc/unparkToUsdc as a retryable implementation. */
  submit(record: ParkingRecord, leg: ParkingLeg): Promise<void>;
  /** Read-only, including when disabled. Missing/timeout is pending, never unsent. */
  receipt(record: ParkingRecord, leg: ParkingLeg): Promise<ParkingReceipt | null>;
}

/** One durable owner for the entire settlement chain. No timer, signing key, or
 * production IO is installed here. One tick advances at most one money leg. */
export class PhoenixParkingService {
  constructor(private readonly store: ParkingRepository, private readonly io: PhoenixParkingIO,
    private readonly enabled = () => false, private readonly now = Date.now) {}
  async start(input: ParkingIntent) {
    const i = structuredClone(input); validateParkingIntent(i);
    if (!this.enabled()) throw new Error('Phoenix parking disabled');
    const s = await this.io.snapshot(i); assertParkingSnapshot(s, i, this.now());
    if (!parkingAuthorized(i, s)) throw new Error('Phoenix parking not authorized');
    await this.store.prepare(i);
    return this.resume(i);
  }
  async resume(input: ParkingIntent): Promise<ParkingRecord> {
    const i = structuredClone(input); validateParkingIntent(i);
    let r = await this.store.read(i);
    if (r.state !== 'active') return r;
    const pending = r.legs.find(l => !l.receipt || l.receipt.state === 'pending');
    if (pending) {
      // A crash between claim and submit cannot authorize a second submit.
      let receipt: ParkingReceipt | null;
      try { receipt = await this.io.receipt(r, pending.leg); } catch { return r; }
      if (!receipt) return r;
      r = await this.store.observe(r, receipt);
      if (receipt.state === 'pending') return r;
      if (receipt.state === 'dropped') return this.store.finish(r, 'attention');
      if (receipt.spent !== pending.leg.amount) return this.store.finish(r, 'attention');
    }
    if (!this.enabled()) return r;
    const lastSlot = r.legs.at(-1)?.receipt?.slot ?? '0';
    const s = await this.io.snapshot(i); assertParkingSnapshot(s, i, this.now(), lastSlot);
    if (!parkingAuthorized(i, s)) return this.store.finish(r, 'cancelled');
    if (units(s.pendingReturnUsdc) > 0n) return r;
    const leg = this.next(r, s);
    if (leg === 'attention') return this.store.finish(r, 'attention');
    if (!leg) return this.store.finish(r, 'completed');
    if (!this.enabled()) return r;
    r = await this.store.claim(r, leg);
    // Claim checks current stored opt-in/lifecycle under the shared bot lock.
    // On any lost acknowledgement or send timeout the claim survives for observation.
    try { if (this.enabled()) await this.io.submit(r, leg); } catch { /* uncertain; observe only */ }
    return r;
  }
  private next(r: ParkingRecord, s: ParkingSnapshot): ParkingLeg | 'attention' | null {
    const i = r.intent, cap = units(i.maxUsdc);
    const made = (kind: ParkingLeg['kind']) => r.legs.find(l => l.leg.kind === kind);
    const leg = (kind: ParkingLeg['kind'], amount: bigint, asset: string | null = null, parentKey?: string): ParkingLeg =>
      ({ key: `${r.id}:${r.legs.length}`, kind, amount: amount.toString(), asset, ...(parentKey ? { parentKey } : {}) });
    if (i.action !== 'entry') {
      if (made('park')) return null;
      const withdrawal = made('withdraw'), unwrap = made('unwrap');
      if (withdrawal && !unwrap) return leg('unwrap', units(withdrawal.receipt!.received), null, withdrawal.leg.key);
      if (i.action === 'idle' && !withdrawal && units(s.walletUsdc) < cap && units(s.withdrawableUsdc) > 0n) {
        return leg('withdraw', minUnits(cap - units(s.walletUsdc), units(s.withdrawableUsdc)));
      }
      // An unwrap receipt proves the venue return reached THIS bot wallet. Queued
      // collateral never enters this budget; bounded post-borrow never withdraws.
      const amount = minUnits(cap, units(s.walletUsdc));
      return amount > 0n ? leg('park', amount, i.destination) : 'attention';
    }
    const target = units(i.requiredMarginUsdc!);
    if (made('deposit')) return units(s.freeMarginUsdc) >= target ? null : 'attention';
    const redeemed = new Set(r.legs.filter(l => l.leg.kind === 'unpark').map(l => l.leg.asset));
    const shortfall = target > units(s.freeMarginUsdc) ? target - units(s.freeMarginUsdc) : 0n;
    if (shortfall > cap) return 'attention';
    const need = shortfall > units(s.walletUsdc) ? shortfall - units(s.walletUsdc) : 0n;
    if (i.mode === 'all' || need > 0n) {
      // Disabled-but-held assets remain redeemable; never filter by deposit enabled.
      const held = s.holdings.find(h => !redeemed.has(h.asset) && h.redeemable && units(h.tokenUnits) > 0n && units(h.valueUsdc) > 0n);
      if (held) {
        const tokens = units(held.tokenUnits), value = units(held.valueUsdc);
        const amount = i.mode === 'all' ? tokens : minUnits(tokens, (need * tokens * 102n + value * 100n - 1n) / (value * 100n));
        return leg('unpark', amount, held.asset);
      }
    }
    if (!shortfall) return null;
    // Short or partial swaps cannot authorize the quoted deposit or an order.
    if (units(s.walletUsdc) < shortfall) return 'attention';
    return leg('deposit', shortfall);
  }
}

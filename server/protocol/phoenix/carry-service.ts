import { phoenixCanaryAllows } from './rollout';
import { assertCarryFacts, type CarryFacts } from './carry-contract';
import { recommendPhoenixCarry } from './carry-policy';
import { assertParkingSnapshot, minUnits, validateParkingIntent, type ParkingIntent, type ParkingLeg, type ParkingRecord } from './parking-contract';
import type { ParkingRepository, PhoenixParkingIO } from './parking-service';
import { raw } from './borrow-contract';

export interface PhoenixCarrySource {
  /** Fresh authenticated complete U06/U08, U11 lender, persisted consent and U04
   * observations. No receipt, health or rate is accepted from a client body. */
  facts(i: ParkingIntent): Promise<CarryFacts>;
}

/** The U10 journal owns the whole close -> withdraw -> unwrap -> one spend.
 * Its bot lock excludes entry, parking, debt and lifecycle races across workers. */
export class PhoenixCarryService {
  constructor(private readonly store: ParkingRepository, private readonly io: PhoenixParkingIO,
    private readonly source: PhoenixCarrySource, private readonly enabled = () => false, private readonly now = Date.now) {}
  private allowed(i: ParkingIntent, l?: ParkingLeg) {
    if (l && ['repay','withdraw','unwrap'].includes(l.kind)) return true;
    return this.enabled() && phoenixCanaryAllows('carry', {ownerWallet:i.ownerWallet,botId:i.botId,parkUsdcMicros:i.maxUsdc});
  }
  private async fresh(i: ParkingIntent, slot = '0') {
    const f = await this.source.facts(i);
    assertParkingSnapshot(f.parking,i,this.now(),slot); assertCarryFacts(i,f,this.now());
    return f;
  }
  async start(input: ParkingIntent) {
    const i = structuredClone(input); validateParkingIntent(i);
    if (!i.carry || !this.allowed(i)) throw new Error('Phoenix carry disabled');
    await this.fresh(i);
    await this.store.prepare(i);
    return this.resume(i);
  }
  async resume(input: ParkingIntent): Promise<ParkingRecord> {
    const i = structuredClone(input); validateParkingIntent(i);
    if (!i.carry) throw new Error('Carry intent required');
    let r = await this.store.read(i);
    if (r.state !== 'active') return r;
    const pending = r.legs.find(l => !l.receipt || l.receipt.state === 'pending');
    if (pending) {
      // Observation survives opt-out, expiry, kill switches and restarts. Never
      // infer unsent from a timeout, missing signature or unchanged balance.
      let receipt;
      try { receipt = await this.io.receipt(r,pending.leg); } catch { return r; }
      if (!receipt) return r;
      r = await this.store.observe(r,receipt);
      if (receipt.state === 'pending') return r;
      if (receipt.state === 'dropped' || (pending.leg.kind !== 'repay' && receipt.spent !== pending.leg.amount)) return this.store.finish(r,'attention');
    }
    if (r.legs.some(l => ['park','repay'].includes(l.leg.kind))) return this.store.finish(r,'completed');
    const f = await this.fresh(i,r.legs.at(-1)?.receipt?.slot ?? '0');
    const c = i.carry;
    if (this.now() >= c.expiresAt || f.parking.destination !== i.destination
      || (c.choice === 'carry' ? !f.parking.autoPark : !c.allowRepay || !f.autoRepayEnabled)) return this.store.finish(r,'cancelled');
    // Do not spend into a pending/changed queue. Cash is measured again only
    // AFTER its terminal receipt; a dropped return never satisfies a repayment.
    if (raw(f.parking.pendingReturnUsdc) > 0n) return r;
    const leg = this.next(r,f);
    if (leg === 'attention') return this.store.finish(r,'attention');
    if (!leg) return this.store.finish(r,'completed');
    if (!this.allowed(i,leg)) return r;
    r = await this.store.claim(r,leg);
    try { await this.authorize(r); await this.io.submit(r,leg); } catch { /* durable claim: observe only */ }
    return r;
  }
  /** Mandatory U10 vault pre-sign/pre-send hook and U11 automatic authorizer.
   * Recomputes economics on the actual capped amount every time; never uses
   * the recommendation that was displayed when consent was first recorded. */
  async authorize(r: ParkingRecord) {
    const latest = await this.store.read(r.intent);
    const last = latest.legs.at(-1);
    if (latest.id !== r.id || latest.state !== 'active' || !last || last.receipt
      || last.leg.key !== r.legs.at(-1)?.leg.key) throw new Error('Carry claim unavailable');
    const f = await this.fresh(latest.intent,latest.legs.at(-2)?.receipt?.slot ?? '0');
    const c = latest.intent.carry!;
    if (this.now() >= c.expiresAt || f.parking.destination !== latest.intent.destination) throw new Error('Carry consent expired or destination changed');
    if (last.leg.kind === 'repay') {
      if (!c.allowRepay || !f.autoRepayEnabled || raw(last.leg.amount) > raw(c.maxRepayRaw)
        || raw(last.leg.amount) > raw(f.parking.walletUsdc)) throw new Error('Authorized repayment cash unavailable');
    } else if (!this.allowed(latest.intent,last.leg) || (c.choice === 'carry' ? !f.parking.autoPark : !f.autoRepayEnabled || !c.allowRepay)) throw new Error('Carry opt-in revoked');
    // Re-run selection against the PRE-leg record; compare the exact leg terms.
    const before = {...latest,legs:latest.legs.slice(0,-1)};
    const selected = this.next(before,f);
    if (!selected || selected === 'attention' || selected.kind !== last.leg.kind || selected.amount !== last.leg.amount
      || selected.asset !== last.leg.asset) throw new Error('Carry decision changed before spend');
    if (last.leg.kind === 'repay' && raw(f.lender.debtRaw!) < raw(last.leg.amount) + raw(last.leg.targetFinalDebtRaw!)) throw new Error('Repayment debt floor changed');
  }
  private next(r: ParkingRecord, f: CarryFacts): ParkingLeg | 'attention' | null {
    const i = r.intent, c = i.carry!, s = f.parking;
    const leg = (kind: ParkingLeg['kind'], amount: bigint, asset: string | null = null, extra = {}): ParkingLeg =>
      ({key:`${r.id}:${r.legs.length}`,kind,amount:amount.toString(),asset,...extra});
    const withdrawal = r.legs.find(l => l.leg.kind === 'withdraw');
    if (withdrawal && !r.legs.some(l => l.leg.kind === 'unwrap')) {
      return leg('unwrap',raw(withdrawal.receipt!.received),null,{parentKey:withdrawal.leg.key});
    }
    const recommendation = recommendPhoenixCarry(f.economics,this.now());
    const repay = c.choice === 'repay' || recommendation.action === 'repay';
    if (raw(s.pendingReturnUsdc) > 0n) return 'attention';
    if (repay && (!c.allowRepay || !f.autoRepayEnabled)) return 'attention';
    if (!repay && recommendation.action !== 'park') return recommendation.action === 'hold' ? null : 'attention';
    const cap = minUnits(raw(i.maxUsdc),repay ? minUnits(raw(c.maxRepayRaw),raw(f.lender.debtRaw!)) : raw(i.maxUsdc));
    const reserve = repay ? 0n : raw(c.reserveRaw);
    const wallet = raw(s.walletUsdc), cash = wallet > reserve ? wallet - reserve : 0n;
    if (!withdrawal && cash < cap && raw(s.withdrawableUsdc) > 0n) {
      return leg('withdraw',minUnits(cap - cash,raw(s.withdrawableUsdc)));
    }
    const amount = minUnits(cap,cash);
    if (amount === 0n) return 'attention';
    if (repay) return leg('repay',amount,null,{targetFinalDebtRaw:(raw(f.lender.debtRaw!) - amount).toString()});
    if (!s.destinationEnabled || !s.autoPark || f.economics.parkedAsset || f.economics.principalRaw !== amount.toString()) return 'attention';
    return leg('park',amount,i.destination);
  }
}

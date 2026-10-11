import type { Pool, PoolClient } from 'pg';
import { phoenixIntentHash, type PhoenixIntent } from './operation-store';
import { phoenixIdentityFromBot } from './identity';
import { assertPhoenixNewRisk } from './lifecycle';
import { units } from './funding-contract';
import { validateParkingIntent, type ParkingIntent, type ParkingLeg, type ParkingReceipt, type ParkingRecord } from './parking-contract';
import type { ParkingRepository } from './parking-service';
import { vaultLockKey } from '../../vault/scope';

export function verifyParkingReceipt(leg: ParkingLeg, r: ParkingReceipt) {
  if (!r || r.key !== leg.key || r.finalized !== true || !r.source || !r.reference
    || !['pending','settled','dropped'].includes(r.state) || units(r.spent) > units(leg.amount)) throw new Error('Invalid parking receipt');
  units(r.slot); units(r.received);
  if (r.state !== 'settled' && (r.spent !== '0' || r.received !== '0')) throw new Error('Pending return is not cash');
  if (r.state === 'settled' && (!units(r.spent) || !units(r.received)
    || (['deposit','unwrap'].includes(leg.kind) && (r.spent !== leg.amount || r.received !== leg.amount))
    || (leg.kind === 'withdraw' && units(r.received) > units(r.spent)))) throw new Error('Invalid measured settlement');
}

/** All callers hold the U02 bot row lock before invoking this helper. An unsigned
 * park can be cancelled by entry; once ANY leg is claimed entry must wait. */
export async function excludePhoenixParking(c: PoolClient, botId: string, cancelUnsigned = false, parkingId?: string) {
  const schema = await c.query("SELECT to_regclass('phoenix_parking_intents') AS table_name");
  if (!schema.rows[0]?.table_name) { if (parkingId) throw new Error('Parking schema unavailable'); return; }
  const { rows } = await c.query("SELECT * FROM phoenix_parking_intents WHERE bot_id=$1 AND state IN ('active','attention') FOR UPDATE", [botId]);
  for (const r of rows) {
    if (r.id === parkingId) continue;
    if (cancelUnsigned && r.state === 'active' && r.legs.length === 0) {
      await c.query("UPDATE phoenix_parking_intents SET state='cancelled',revision=revision+1 WHERE id=$1", [r.id]);
    } else throw new Error('Phoenix parking settlement pending');
  }
}

export async function assertParkingFundingChild(c: PoolClient, i: PhoenixIntent) {
  const { rows: [r] } = await c.query('SELECT * FROM phoenix_parking_intents WHERE id=$1 AND bot_id=$2', [i.parkingIntentId, i.botId]);
  const last = (r?.legs as ParkingRecord['legs'] | undefined)?.at(-1);
  if (!r || r.state !== 'active' || !last || (last.receipt && last.receipt.state !== 'pending')
    || r.intent_hash !== phoenixIntentHash(r.intent) || r.intent.ownerWallet !== i.ownerWallet
    || phoenixIntentHash(r.intent.identity) !== phoenixIntentHash(i.identity as any)
    || last.leg.key !== i.requestKey || last.leg.kind !== i.funding?.leg
    || last.leg.amount !== i.funding.grossBaseUnits || r.intent.executionOrderId !== i.executionOrderId
    || !['withdraw','unwrap','deposit'].includes(last.leg.kind)) throw new Error('Parking funding binding mismatch');
  await assertPhoenixNewRisk(c, i.botId);
  const { rows: [b] } = await c.query('SELECT auto_park_idle,park_destination_asset FROM trading_bots WHERE id=$1', [i.botId]);
  if (r.intent.action === 'idle' && b.auto_park_idle !== true) throw new Error('Parking opt-out before funding');
  if (r.intent.action !== 'entry' && b.park_destination_asset && b.park_destination_asset !== r.intent.destination) throw new Error('Parking destination changed');
}

export class PhoenixParkingStore implements ParkingRepository {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  /** Server-owned recovery enumeration includes opted-out and archived bots. */
  async pending(limit = 100): Promise<ParkingIntent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid parking recovery limit');
    const c = await this.pool.connect();
    try { return (await c.query("SELECT intent FROM phoenix_parking_intents WHERE state='active' ORDER BY updated_at LIMIT $1", [limit])).rows.map(r => r.intent); }
    finally { c.release(); }
  }
  private async locked<T>(i: ParkingIntent, fn: (c: PoolClient, bot: any) => Promise<T>): Promise<T> {
    validateParkingIntent(i);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [b] } = await c.query('SELECT * FROM trading_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE', [i.botId, i.ownerWallet]);
      if (!b || b.active_protocol !== 'phoenix') throw new Error('Phoenix parking bot not owned');
      const identity = phoenixIdentityFromBot({ id: b.id, walletAddress: b.wallet_address, activeProtocol: b.active_protocol,
        protocolSubaccountId: b.protocol_subaccount_id, derivationIndex: b.derivation_index, derivationPathVersion: b.derivation_path_version,
        phoenixAuthorityWallet: b.phoenix_authority_wallet, phoenixTraderAccount: b.phoenix_trader_account,
        phoenixNetwork: b.phoenix_network, phoenixProgramAddress: b.phoenix_program_address,
        phoenixPortfolioIndex: b.phoenix_portfolio_index, phoenixSubaccountIndex: b.phoenix_subaccount_index });
      if (phoenixIntentHash(identity as any) !== phoenixIntentHash(i.identity as any)) throw new Error('Parking identity changed');
      const result = await fn(c, b); await c.query('COMMIT'); return result;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  private verify(r: ParkingRecord, i: ParkingIntent) {
    if (!r || r.intent_hash !== phoenixIntentHash(i as any) || r.intent_hash !== phoenixIntentHash(r.intent as any)) throw new Error('Parking replay mismatch');
    return r;
  }
  private async current(c: PoolClient, i: ParkingIntent) {
    return this.verify((await c.query('SELECT * FROM phoenix_parking_intents WHERE bot_id=$1 AND request_key=$2 FOR UPDATE', [i.botId, i.requestKey])).rows[0], i);
  }
  private async authorize(c: PoolClient, b: any, i: ParkingIntent, id?: string) {
    await assertPhoenixNewRisk(c, i.botId);
    if (i.action === 'idle' && b.auto_park_idle !== true) throw new Error('Parking opt-out');
    if (i.action !== 'entry' && b.park_destination_asset && b.park_destination_asset !== i.destination) throw new Error('Parking destination changed');
    await excludePhoenixParking(c, i.botId, false, id);
    const orders = (await c.query("SELECT * FROM phoenix_order_intents WHERE bot_id=$1 AND state NOT IN ('settled','rejected')", [i.botId])).rows;
    if (i.action === 'entry') {
      if (orders.length !== 1 || orders[0].id !== i.executionOrderId || orders[0].state !== 'funding'
        || orders[0].intent.action !== 'entry' || units(i.maxUsdc) > units(orders[0].data.admission.fundingShortfallMicros)
        || i.requiredMarginUsdc !== orders[0].data.admission.requiredMarginMicros) throw new Error('Parking entry authority unavailable');
    } else if (orders.length) throw new Error('Parking conflicts with pending order');
    const pending = await c.query(`SELECT 1 FROM phoenix_operations WHERE bot_id=$1 AND state NOT IN ('completed','failed','dropped')
      AND ($2::text IS NULL OR intent->>'parkingIntentId' IS DISTINCT FROM $2)`, [i.botId, id ?? null]);
    if (pending.rows.length) throw new Error('Phoenix transfer/protection unresolved');
  }
  async prepare(input: ParkingIntent) {
    const i = structuredClone(input);
    return this.locked(i, async (c, b) => {
      const { rows: [old] } = await c.query('SELECT * FROM phoenix_parking_intents WHERE bot_id=$1 AND request_key=$2', [i.botId, i.requestKey]);
      if (old) return this.verify(old, i);
      await this.authorize(c, b, i);
      // One explicit borrow authorization can never be consumed by another request.
      if (i.borrowAuthorizationId && (await c.query("SELECT 1 FROM phoenix_parking_intents WHERE bot_id=$1 AND intent->>'borrowAuthorizationId'=$2", [i.botId, i.borrowAuthorizationId])).rows.length) throw new Error('Borrow park authorization consumed');
      const { rows: [r] } = await c.query(`INSERT INTO phoenix_parking_intents(bot_id,request_key,intent,intent_hash)
        VALUES($1,$2,$3,$4) RETURNING *`, [i.botId, i.requestKey, i, phoenixIntentHash(i as any)]);
      return r as ParkingRecord;
    });
  }
  async read(i: ParkingIntent) { return this.locked(structuredClone(i), c => this.current(c, i)); }
  async claim(input: ParkingRecord, inputLeg: ParkingLeg) {
    const r = structuredClone(input), leg = structuredClone(inputLeg);
    return this.locked(r.intent, async (c, b) => {
      const current = await this.current(c, r.intent);
      this.revision(current, r);
      if (current.legs.some(l => !l.receipt || l.receipt.state !== 'settled') || !units(leg.amount)
        || leg.key !== `${r.id}:${r.legs.length}`) throw new Error('Parking leg already claimed or invalid');
      const allowed = r.intent.action === 'entry' ? ['unpark','deposit'] : r.intent.action === 'idle' ? ['withdraw','unwrap','park'] : ['park'];
      if (!allowed.includes(leg.kind) || (leg.kind !== 'unpark' && units(leg.amount) > units(r.intent.maxUsdc))
        || (['park','unpark'].includes(leg.kind) ? !leg.asset : leg.asset !== null)
        || (leg.kind === 'park' && leg.asset !== r.intent.destination)
        || current.legs.some(l => l.leg.kind === leg.kind && (leg.kind !== 'unpark' || l.leg.asset === leg.asset))) throw new Error('Parking leg exceeds intent');
      const parent = current.legs.find(l => l.leg.key === leg.parentKey);
      if (leg.kind === 'unwrap' ? (!parent || parent.leg.kind !== 'withdraw' || parent.receipt?.received !== leg.amount) : !!leg.parentKey) throw new Error('Parking settlement parent mismatch');
      await this.authorize(c, b, r.intent, r.id);
      // Same scope/asset lock namespace as vault cost basis, plus durable whole-bot ownership.
      await c.query('SELECT pg_advisory_xact_lock($1)', [vaultLockKey(r.intent.ownerWallet, r.intent.botId, leg.asset ?? 'USDC')]);
      return this.write(c, r, 'active', [...current.legs, { leg }]);
    });
  }
  async observe(input: ParkingRecord, inputReceipt: ParkingReceipt) {
    const r = structuredClone(input), receipt = structuredClone(inputReceipt);
    return this.locked(r.intent, async c => {
      const current = await this.current(c, r.intent); this.revision(current, r);
      const last = current.legs.at(-1);
      if (!last || (last.receipt && last.receipt.state !== 'pending')) throw new Error('Parking receipt already terminal');
      verifyParkingReceipt(last.leg, receipt);
      if (last.receipt && units(receipt.slot) < units(last.receipt.slot)) throw new Error('Parking receipt regressed');
      last.receipt = receipt;
      return this.write(c, r, 'active', current.legs);
    });
  }
  async recordVaultAttempt(input: ParkingRecord, attempt: NonNullable<ParkingRecord['legs'][number]['attempt']>) {
    const r = structuredClone(input), a = structuredClone(attempt);
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(a.signature) || a.signature.includes('\n')
      || !/^[a-f0-9]{64}$/.test(a.transactionHash) || a.transactionHash.length !== 64) throw new Error('Invalid vault attempt');
    units(a.lastValidBlockHeight);
    return this.locked(r.intent, async (c, b) => {
      const current = await this.current(c, r.intent); this.revision(current, r);
      await this.authorize(c, b, r.intent, r.id);
      const last = current.legs.at(-1);
      if (!last || !['park','unpark'].includes(last.leg.kind) || last.attempt || last.receipt) throw new Error('Vault attempt already claimed');
      last.attempt = a;
      return this.write(c, r, 'active', current.legs);
    });
  }
  async finish(r: ParkingRecord, state: 'completed' | 'cancelled' | 'attention') {
    return this.locked(r.intent, async c => {
      const current = await this.current(c, r.intent); this.revision(current, r);
      if (current.legs.some(l => !l.receipt || l.receipt.state === 'pending')) throw new Error('Unsettled parking cannot release ownership');
      return this.write(c, r, state, current.legs);
    });
  }
  private revision(a: ParkingRecord, b: ParkingRecord) {
    if (a.id !== b.id || a.revision !== b.revision || a.state !== 'active') throw new Error('Stale parking claim');
  }
  private async write(c: PoolClient, r: ParkingRecord, state: ParkingRecord['state'], legs: ParkingRecord['legs']) {
    return (await c.query(`UPDATE phoenix_parking_intents SET state=$2,legs=$3,revision=revision+1,updated_at=now()
      WHERE id=$1 RETURNING *`, [r.id, state, JSON.stringify(legs)])).rows[0] as ParkingRecord;
  }
}

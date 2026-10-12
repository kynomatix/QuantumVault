import type { Pool, PoolClient } from 'pg';
import { phoenixIdentityFromBot } from './identity';
import { assertPhoenixNewRisk } from './lifecycle';
import { addsBorrowRisk, borrowHash, validateBorrowIntent, type PhoenixBorrowIntent } from './borrow-contract';
import { AUTO_TOPUP_COOLDOWN_MS } from '../../vault/auto-topup';
import { assertCarryRepaymentChild } from './parking-store';

export interface BorrowLeg {
  termsHash: string; terms: Record<string, unknown>; state: 'claimed' | 'completed' | 'absent';
  signature?: string; lastValidBlockHeight?: number; result?: any; proofReference?: string;
}
export interface BorrowRecord {
  id: string; status: string;
  metadata: { intent: PhoenixBorrowIntent; intentHash: string; legs: Record<string, BorrowLeg> };
}
export interface BorrowRepository {
  prepare(i: PhoenixBorrowIntent): Promise<BorrowRecord>;
  read(i: PhoenixBorrowIntent): Promise<BorrowRecord>;
  claim(i: PhoenixBorrowIntent, key: string, terms: Record<string, unknown>): Promise<{ execute: boolean; leg: BorrowLeg; previous?: BorrowLeg }>;
  signature(i: PhoenixBorrowIntent, key: string, signature: string, lastValidBlockHeight: number): Promise<void>;
  complete(i: PhoenixBorrowIntent, key: string, result: unknown): Promise<void>;
  finish(i: PhoenixBorrowIntent, success: boolean): Promise<void>;
}
const operationType = 'phoenix_external_debt';
const requestId = (i: PhoenixBorrowIntent) => `phoenix:${i.botId}:${i.requestKey}`;

/** Called under the U04/U05/U10 bot row lock. Unknown state is an obligation,
 * never a reason to release the bot wallet or reserve to another spend path. */
export async function excludePhoenixBorrow(c: PoolClient, botId: string, child?: { borrowIntentId?: string; borrowReserveRaw?: string; feeBaseUnits?: string; requestKey: string; amountBaseUnits: string; kind: string }, protectWallet = true) {
  const schema = await c.query("SELECT to_regclass('borrow_operations') AS operations, to_regclass('borrow_positions') AS positions");
  if (!schema.rows[0]?.operations) return; // Pre-lender schemas used by earlier isolated fixtures.
  const { rows } = await c.query(`SELECT id,status,metadata FROM borrow_operations WHERE operation_type=$1
    AND metadata->'intent'->>'botId'=$2 ORDER BY created_at DESC`, [operationType, botId]);
  if (child?.borrowIntentId) {
    const r = rows.find(r => r.id === child.borrowIntentId), i = r?.metadata?.intent;
    const leg = r?.metadata?.legs?.deposit;
    if (!r || r.status === 'completed' || borrowHash(i) !== r.metadata.intentHash || i.action !== 'deploy'
      || leg?.state !== 'claimed' || leg.terms.requestKey !== child.requestKey
      || leg.terms.amountRaw !== child.amountBaseUnits || child.kind !== 'deposit' || child.feeBaseUnits !== '0' || child.borrowReserveRaw !== i.reserveRaw) throw new Error('Debt funding child binding mismatch');
    return;
  }
  if (rows.some(r => r.status !== 'completed')) throw new Error('Phoenix borrowing settlement pending');
  if (protectWallet && schema.rows[0]?.positions) {
    const debt = await c.query(`SELECT 1 FROM borrow_positions WHERE trading_bot_id=$1
      AND (status <> 'closed' OR debt_amount_raw IS NULL OR collateral_amount_raw IS NULL
        OR debt_amount_raw::numeric <> 0 OR collateral_amount_raw::numeric <> 0) LIMIT 1`, [botId]);
    if (debt.rows.length) throw new Error('Phoenix liquid reserve protected; use the debt-authorized funding path');
  }
}

/** Reuses the existing journal and unique wallet/request index. No schema change. */
export class PhoenixBorrowStore implements BorrowRepository {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  private async locked<T>(i: PhoenixBorrowIntent, work: (c: PoolClient) => Promise<T>) {
    validateBorrowIntent(i);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Account collateral is shared across bots. Take the account lock FIRST.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`phoenix-lender:${i.ownerWallet}:${i.accountAuthority}`]);
      const { rows: [b] } = await c.query('SELECT * FROM trading_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE', [i.botId,i.ownerWallet]);
      if (!b || b.active_protocol !== 'phoenix') throw new Error('Phoenix borrowing bot not owned');
      const identity = phoenixIdentityFromBot({ id: b.id, walletAddress: b.wallet_address, activeProtocol: b.active_protocol,
        protocolSubaccountId: b.protocol_subaccount_id, derivationIndex: b.derivation_index, derivationPathVersion: b.derivation_path_version,
        phoenixAuthorityWallet: b.phoenix_authority_wallet, phoenixTraderAccount: b.phoenix_trader_account,
        phoenixNetwork: b.phoenix_network, phoenixProgramAddress: b.phoenix_program_address,
        phoenixPortfolioIndex: b.phoenix_portfolio_index, phoenixSubaccountIndex: b.phoenix_subaccount_index });
      if (borrowHash(identity) !== borrowHash(i.identity)) throw new Error('Phoenix loan authority changed');
      const result = await work(c); await c.query('COMMIT'); return result;
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  private async current(c: PoolClient, i: PhoenixBorrowIntent): Promise<BorrowRecord> {
    const { rows: [r] } = await c.query('SELECT * FROM borrow_operations WHERE wallet_address=$1 AND client_request_id=$2 FOR UPDATE', [i.ownerWallet,requestId(i)]);
    if (!r || r.operation_type !== operationType || r.metadata.intentHash !== borrowHash(i)
      || borrowHash(r.metadata.intent) !== borrowHash(i)) throw new Error('Borrow replay identity mismatch');
    return r;
  }
  private async automaticOptIn(c: PoolClient, i: PhoenixBorrowIntent) {
    if (!i.automation) return;
    if (i.automation.kind === 'carry') await assertCarryRepaymentChild(c,i);
    const {rows:[b]} = await c.query('SELECT auto_collateral_top_up,auto_repay_enabled FROM trading_bots WHERE id=$1',[i.botId]);
    if (!(i.action === 'topup' ? b?.auto_collateral_top_up : b?.auto_repay_enabled)) throw new Error('Automatic defense opt-in revoked');
  }
  async prepare(input: PhoenixBorrowIntent) {
    const i = structuredClone(input);
    return this.locked(i, async c => {
      const exists = await c.query('SELECT 1 FROM borrow_operations WHERE wallet_address=$1 AND client_request_id=$2', [i.ownerWallet,requestId(i)]);
      if (exists.rows.length) return this.current(c,i);
      await this.automaticOptIn(c,i);
      if (addsBorrowRisk(i.action)) await assertPhoenixNewRisk(c,i.botId);
      for (const [loanId,venueId,botId] of [[i.accountLoanId,i.accountVenueId,null],[i.botLoanId,i.botVenueId,i.botId]] as const) {
        if (!loanId) continue;
        const { rows: [loan] } = await c.query('SELECT * FROM borrow_positions WHERE id=$1 AND wallet_address=$2',[loanId,i.ownerWallet]);
        if (!loan || loan.trading_bot_id !== botId || loan.venue_position_id !== String(venueId)
          || loan.collateral_mint !== i.collateralMint || loan.kind !== 'borrow' || loan.debt_venue !== 'jupiter_lend') throw new Error('Bound external loan identity unavailable');
      }
      const busy = await c.query(`SELECT 1 FROM borrow_operations WHERE operation_type=$1 AND status <> 'completed'
        AND wallet_address=$2 AND (metadata->'intent'->>'botId'=$3 OR metadata->'intent'->>'accountAuthority'=$4) LIMIT 1`,
      [operationType,i.ownerWallet,i.botId,i.accountAuthority]);
      if (busy.rows.length) throw new Error('Account collateral or bot already reserved by an unresolved journal');
      for (const [table, done] of [['phoenix_operations',"'completed','failed','dropped'"],['phoenix_order_intents',"'settled','rejected'"],['phoenix_parking_intents',"'completed','cancelled'"]]) {
        const found = await c.query('SELECT to_regclass($1) AS name',[table]);
        const parentId = table === 'phoenix_parking_intents' && i.automation?.kind === 'carry' ? i.automation.parkingIntentId : null;
        if (found.rows[0]?.name && (await c.query(`SELECT 1 FROM ${table} WHERE bot_id=$1 AND state NOT IN (${done}) AND ($2::text IS NULL OR id::text <> $2) LIMIT 1`,[i.botId,parentId])).rows.length) throw new Error('Phoenix settlement pending before lender operation');
      }
      if (i.automation) {
        const claimed = await c.query(`UPDATE borrow_positions SET last_auto_topup_attempt_at=now()
          WHERE id=$1 AND trading_bot_id=$2 AND status='open' AND kind='borrow'
          AND (last_auto_topup_attempt_at IS NULL OR last_auto_topup_attempt_at <= now() - ($3 * interval '1 millisecond')) RETURNING id`,
          [i.botLoanId,i.botId,AUTO_TOPUP_COOLDOWN_MS]);
        if (!claimed.rows.length) throw new Error('Automatic defense cooldown or loan unavailable');
      }
      const { rows: [r] } = await c.query(`INSERT INTO borrow_operations (wallet_address,borrow_position_id,operation_type,client_request_id,status,step,metadata)
        VALUES ($1,$2,$3,$4,'pending','phoenix', $5) RETURNING *`, [i.ownerWallet,i.botLoanId,operationType,requestId(i), {intent:i,intentHash:borrowHash(i),legs:{}}]);
      return r as BorrowRecord;
    });
  }
  read(i: PhoenixBorrowIntent) { return this.locked(i,c => this.current(c,i)); }
  private async update(i: PhoenixBorrowIntent, work: (r: BorrowRecord, c: PoolClient) => void | Promise<void>) {
    return this.locked(i, async c => {
      const r = await this.current(c,i); await work(r,c);
      await c.query('UPDATE borrow_operations SET metadata=$2,status=$3,updated_at=now() WHERE id=$1',[r.id,r.metadata,r.status]);
    });
  }
  async claim(i: PhoenixBorrowIntent, key: string, terms: Record<string, unknown>) {
    let result!: {execute: boolean; leg: BorrowLeg; previous?: BorrowLeg};
    await this.update(i,async (r,c) => {
      const old = r.metadata.legs[key];
      if (old && old.termsHash !== borrowHash(terms)) throw new Error('Lender leg replay terms changed');
      if (old?.state === 'claimed') throw new Error('Lender leg outcome unknown; reconcile before resuming');
      if (old?.state === 'completed') { result = {execute:false,leg:old}; return; }
      await this.automaticOptIn(c,i);
      if (r.status === 'completed') throw new Error('Completed borrowing journal is immutable');
      const leg: BorrowLeg = {termsHash:borrowHash(terms),terms:structuredClone(terms),state:'claimed'};
      r.metadata.legs[key] = leg; result = {execute:true,leg,previous:old};
    });
    return result;
  }
  signature(i: PhoenixBorrowIntent, key: string, signature: string, lastValidBlockHeight: number) {
    return this.update(i,async (r,c) => {
      await this.automaticOptIn(c,i);
      const l = r.metadata.legs[key];
      if (l?.state !== 'claimed' || l.signature || !signature || !Number.isSafeInteger(lastValidBlockHeight)) throw new Error('Invalid lender write-ahead signature');
      l.signature = signature; l.lastValidBlockHeight = lastValidBlockHeight;
    });
  }
  complete(i: PhoenixBorrowIntent, key: string, result: unknown) {
    return this.update(i,r => {
      const l = r.metadata.legs[key];
      if (l?.state !== 'claimed') throw new Error('Lender leg not claimed');
      l.state = 'completed'; l.result = result;
    });
  }
  finish(i: PhoenixBorrowIntent, success: boolean) {
    return this.update(i,r => {
      if (r.status === 'completed') return;
      if (success && Object.values(r.metadata.legs).some(l => l.state === 'claimed')) throw new Error('Unreconciled lender leg');
      r.status = success ? 'completed' : 'needs_attention';
    });
  }
  /** The verifier is a server-owned finalized RPC/transaction decoder, never an
   * HTTP receipt or balance delta. Expiry alone is insufficient to prove absence. */
  async reconcile(i: PhoenixBorrowIntent, key: string, verify: (leg: BorrowLeg) => Promise<{
    termsHash: string; reference: string; finalized: true; outcome: 'completed' | 'absent'; result?: unknown;
  } | null>) {
    const before = (await this.read(i)).metadata.legs[key];
    if (before?.state !== 'claimed') throw new Error('No uncertain lender leg');
    const proof = await verify(structuredClone(before));
    if (!proof || proof.finalized !== true || proof.termsHash !== before.termsHash || !proof.reference
      || (proof.outcome === 'completed' && proof.result === undefined)) throw new Error('Authoritative lender reconciliation unavailable');
    await this.update(i,r => {
      const current = r.metadata.legs[key];
      if (borrowHash(current) !== borrowHash(before)) throw new Error('Stale reconciliation');
      current.state = proof.outcome; current.result = proof.result; current.proofReference = proof.reference;
    });
  }
}

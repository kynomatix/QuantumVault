import {refuseRescueMutation} from './rescue-recovery';
import {createHash} from 'node:crypto';
import Decimal from 'decimal.js';
import type {PoolClient} from 'pg';
import {fencedTransaction,walletFences,type ClientLane} from './transaction';
import {identityFences,launchIdentityFences} from './identity-locks';
import {waitGridWorkerFence} from '../grid-bot/worker-ownership';
import {issueStartConsent,storedStartConsent,verifyStartConsent,type StoredStartConsent} from './consent';
import {canonicalGridPolicy,verifyGridPolicyHmac,type GridPolicy} from '../grid-bot/policy-hmac';
import {retainedGridPolicy} from '../grid-bot/retained-policy';
import {loadActiveGridLevels} from '../grid-bot/active-epoch';
import {preflightGridLaunch,type LaunchFacts} from '../grid-bot/launch-preflight';
import {aggregateReservationFence,allReservationTotals,calculateSpending,withinSpendingCaps,type SpendingFacts} from './spending';
import {localContext} from './host';
import type {GridIncidents} from './incidents';

export const START_RESULT_CODES = ['authority_refused','consent_expired','policy_changed','facts_unavailable','spending_limit','entries_paused','observer_fenced'] as const;
export type StartResultCode = typeof START_RESULT_CODES[number];
export class StartRefusal extends Error { constructor(readonly code:StartResultCode){super(messages[code]);} }
export interface ConfirmStart {confirmed:true;requestKey:string;draftRevision:string;serverIntentDigest:string}
export interface StartRequestView {requestKey:string;state:'pending'|'admitted'|'complete'|'superseded'|'refused'|'expired';reason?:string}
const messages:Record<StartResultCode,string>={authority_refused:'Start authority is no longer available. Review the draft again.',
  consent_expired:'The Start confirmation expired. Review and confirm again.',policy_changed:'The setup changed. Review and confirm again.',
  facts_unavailable:'Fresh exchange information is unavailable. Review and confirm again.',spending_limit:'The retained spending limit does not allow this Start.',
  entries_paused:'New entries are paused. Start can be confirmed after the pause is cleared.',observer_fenced:'The worker is checking exchange state. Start can be confirmed after those checks finish.'};
function view(r:Record<string,any>):StartRequestView {
  if(!['pending','admitted','complete','superseded','refused','expired'].includes(r.state))throw Error('GRID_REQUEST_STATE');
  const reason=r.state==='expired'?messages.consent_expired:r.state==='superseded'?messages.policy_changed:
    r.state==='refused'?messages[r.result_code as StartResultCode]??messages.authority_refused:undefined;
  return {requestKey:r.request_key,state:r.state,...(reason?{reason}:{})};
}
export function spendingPolicyDigest(policy:GridPolicy):string {
  const canonical=canonicalGridPolicy(policy);if(!canonical)throw new StartRefusal('policy_changed');
  return createHash('sha256').update('grid-spending-v1\n'+canonical).digest('hex');
}
async function signedPolicy(c:PoolClient,botId:string,umk:Buffer) {
  const bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1 FOR UPDATE',[botId])).rows[0];
  if(!bot)throw new StartRefusal('authority_refused');
  const policy=retainedGridPolicy(bot,(await loadActiveGridLevels(c,botId,'policy')).rows);
  if(!verifyGridPolicyHmac(policy,umk,bot.policy_hmac).ok)throw new StartRefusal('policy_changed');
  return {bot,policy};
}
async function externalHost(c:PoolClient) {
  return (await c.query(`SELECT *,lease_expires_at>clock_timestamp() AS holder_live,
    date_trunc('milliseconds',clock_timestamp()) AS db_now FROM grid_worker_host WHERE singleton_id=1`)).rows[0];
}
function entryGates(h:Record<string,any>|undefined) {
  if(!h||h.execution_mode!=='external'||h.run_mode!=='trading'||!h.execution_enabled||h.drain_requested
    ||!h.authority_tracking_enabled||h.start_scope!=='owner_allowlist')throw new StartRefusal('authority_refused');
  if(h.entries_paused)throw new StartRefusal('entries_paused');
  if(h.observer_fenced)throw new StartRefusal('observer_fenced');
}
async function expirePending(c:PoolClient,owner:string,botId:string) {
  await c.query(`UPDATE grid_worker_requests SET state='expired',completed_at=clock_timestamp(),result_code='consent_expired'
    WHERE owner_wallet=$1 AND bot_id=$2 AND state='pending' AND expires_at<=clock_timestamp()`,[owner,botId]);
}
/** MAIN data plane: no lease, signer, custody or reservation imports with side effects. */
export class MainStartRequests {
  constructor(private readonly lane:ClientLane,private readonly terminate:(pid:number)=>Promise<void>){}
  async external():Promise<boolean>{if(process.env.GRID_REMOTE_WORKER_ENABLED!=='true')return false;return fencedTransaction(this.lane,async c=>{
    if(!(await c.query("SELECT to_regclass('grid_worker_host') IS NOT NULL AS present")).rows[0]?.present)return false;
    return (await externalHost(c))?.execution_mode==='external';
  },{terminate:this.terminate});}
  async states(owner:string,botIds:readonly string[]):Promise<Record<string,{startState:StartRequestView['state'];startMessage?:string}>>{
    return fencedTransaction(this.lane,async c=>{
      const rows=(await c.query(`SELECT DISTINCT ON (r.bot_id) r.bot_id,r.request_key,r.result_code,
        CASE WHEN r.state='pending' AND r.expires_at<=clock_timestamp() THEN 'expired' ELSE r.state END AS state
        FROM grid_worker_requests r JOIN grid_bots b ON b.id=r.bot_id AND b.wallet_address=r.owner_wallet
        WHERE r.owner_wallet=$1 AND r.bot_id IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb)) AND r.action='start'
        ORDER BY r.bot_id,r.created_at DESC,r.id DESC`,[owner,JSON.stringify(botIds)])).rows;
      return Object.fromEntries(rows.map(r=>{const v=view(r);return [r.bot_id,{startState:v.state,startMessage:v.reason}];}));
    },{terminate:this.terminate});
  }
  async confirm(owner:string,botId:string,input:ConfirmStart,umk:Buffer):Promise<StartRequestView>{
    if(input.confirmed!==true||!input.requestKey||input.requestKey.length>200)throw new StartRefusal('authority_refused');
    return fencedTransaction(this.lane,async c=>{
      await walletFences(c,[owner]);await identityFences(c,[botId],[]);
      await refuseRescueMutation(c,botId);
      const h=await externalHost(c);entryGates(h);
      if(h.owner_wallet!==owner)throw new StartRefusal('authority_refused');
      await expirePending(c,owner,botId);
      const {policy,bot}=await signedPolicy(c,botId,umk);
      const result=await issueStartConsent(c,{owner,botId,requestKey:input.requestKey,draftRevision:input.draftRevision,
        serverIntentDigest:input.serverIntentDigest.toLowerCase(),policyHmac:String(bot.policy_hmac).toLowerCase(),spendingPolicyDigest:spendingPolicyDigest(policy)},umk);
      return view((await c.query('SELECT state,request_key,result_code FROM grid_worker_requests WHERE id=$1',[result.id])).rows[0]);
    },{terminate:this.terminate});
  }
  async recover(owner:string,botId:string,requestKey:string):Promise<StartRequestView|null>{
    return fencedTransaction(this.lane,async c=>{
      await walletFences(c,[owner]);await identityFences(c,[botId],[]);
      await expirePending(c,owner,botId);
      const r=(await c.query(`SELECT r.state,r.request_key,r.result_code FROM grid_worker_requests r
        JOIN grid_bots b ON b.id=r.bot_id AND b.wallet_address=r.owner_wallet
        WHERE r.owner_wallet=$1 AND r.bot_id=$2 AND r.request_key=$3 AND r.action='start'`,[owner,botId,requestKey])).rows[0];
      return r?view(r):null;
    },{terminate:this.terminate});
  }
}

export interface WorkerRequestContext {bootId:string;epoch:string}
/** Discovery holds no row locks. After the aggregate and wallet locks, every identity is reread. */
async function requestLocks(c:PoolClient,id:string) {
  const before=(await c.query('SELECT owner_wallet,bot_id FROM grid_worker_requests WHERE id=$1',[id])).rows[0];
  if(!before)throw new StartRefusal('authority_refused');
  await aggregateReservationFence(c);await walletFences(c,[before.owner_wallet]);
  await waitGridWorkerFence(c,before.bot_id);await launchIdentityFences(c,before.bot_id);
  const row=(await c.query('SELECT * FROM grid_worker_requests WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!row||row.owner_wallet!==before.owner_wallet||row.bot_id!==before.bot_id)throw new StartRefusal('authority_refused');
  return row;
}
async function workerHost(c:PoolClient,holder:WorkerRequestContext,protective=false) {
  const h=await externalHost(c);
  if(!protective)entryGates(h);
  if(!h||h.execution_mode!=='external')throw new StartRefusal('authority_refused');
  if(!h.holder_live||h.holder_role!=='grid-worker'||h.holder_boot_id!==holder.bootId||String(h.fencing_epoch)!==holder.epoch)throw new StartRefusal('authority_refused');
  await localContext(c,'start',holder);return h;
}
async function verified(c:PoolClient,row:Record<string,any>,umk:Buffer,states:readonly string[]) {
  const consent=storedStartConsent(row);await verifyStartConsent(c,consent,umk,states);
  const {policy,bot}=await signedPolicy(c,row.bot_id,umk);
  if(spendingPolicyDigest(policy)!==consent.consent.spendingPolicyDigest)throw new StartRefusal('policy_changed');
  return {consent,policy,bot};
}
/** No scheduler and no custody call. A returned admission exists only after COMMIT. */
export class WorkerStartRequests {
  constructor(private readonly lane:ClientLane,private readonly terminate:(pid:number)=>Promise<void>,private readonly incidents:Pick<GridIncidents,'record'>){}
  /** A failed Start may release only a locked, custody-free and operation-free reservation. */
  async releaseFailedZeroState(id:string,holder:WorkerRequestContext):Promise<boolean>{
    return fencedTransaction(this.lane,async c=>{
      const row=await requestLocks(c,id);await workerHost(c,holder,true);
      if(row.action!=='start'||row.state!=='admitted')return false;
      const bot=(await c.query('SELECT status,protocol_subaccount_id FROM grid_bots WHERE id=$1 FOR UPDATE',[row.bot_id])).rows[0];
      if(!bot||bot.protocol_subaccount_id!==null||!['draft','failed'].includes(bot.status))return false;
      const used=(await c.query(`SELECT
        EXISTS(SELECT 1 FROM grid_launch_accounts WHERE bot_id=$1)
        OR EXISTS(SELECT 1 FROM protocol_subaccounts WHERE bot_id=$1::text)
        OR EXISTS(SELECT 1 FROM grid_operations WHERE bot_id=$1)
        OR EXISTS(SELECT 1 FROM grid_execution_claims WHERE bot_id=$1)
        OR EXISTS(SELECT 1 FROM grid_worker_send_audit WHERE bot_id=$1) AS used`,[row.bot_id])).rows[0];
      if(used.used)return false;
      const proofDigest=createHash('sha256').update(JSON.stringify({kind:'failed_start_zero_state_v1',botId:row.bot_id,requestId:id,
        custody:false,operations:false,claims:false,audits:false})).digest('hex');
      const changed=await c.query(`UPDATE grid_worker_reservations SET state='released',terminal_proof_digest=$2,updated_at=clock_timestamp()
        WHERE start_request_id=$1 AND state IN ('held','uncertain') RETURNING bot_id`,[id,proofDigest]);
      if(changed.rowCount!==1)return false;
      await c.query("UPDATE grid_worker_requests SET state='complete',result_code='failed_start_zero_state',completed_at=clock_timestamp() WHERE id=$1",[id]);
      return true;
    },{terminate:this.terminate});
  }
  async admit(id:string,holder:WorkerRequestContext,umk:Buffer,facts:LaunchFacts,spending:SpendingFacts):Promise<StoredStartConsent> {
    try{return await fencedTransaction(this.lane,async c=>{
      const row=await requestLocks(c,id),h=await workerHost(c,holder);
      const {consent,policy,bot}=await verified(c,row,umk,['pending','admitted']);
      const wallet=(await c.query('SELECT agent_public_key,umk_version FROM wallets WHERE address=$1',[row.owner_wallet])).rows[0];
      if(!wallet||bot.wallet_address!==facts.agentGeneration.wallet||facts.agentGeneration.masterAccount!==facts.masterAccount
        ||wallet.agent_public_key!==facts.masterAccount||wallet.umk_version!==facts.agentGeneration.umkVersion)throw new StartRefusal('authority_refused');
      const reservation=(await c.query('SELECT start_request_id,state FROM grid_worker_reservations WHERE bot_id=$1 FOR UPDATE',[row.bot_id])).rows[0];
      if(row.state==='admitted'){
        if(!reservation||reservation.start_request_id!==id||!['held','uncertain'].includes(reservation.state))throw new StartRefusal('authority_refused');
        return consent;
      }
      if(reservation)throw new StartRefusal('authority_refused'); // Lifetime identity is never reused, including released rows.
      const now=new Date(h.db_now).getTime();
      if(!preflightGridLaunch(policy,consent.consent.policyHmac,umk,facts,now).ok)throw new StartRefusal('facts_unavailable');
      const r=calculateSpending(policy.totalInvestment,policy.leverage,spending,now);
      if(!withinSpendingCaps(r,{startScope:h.start_scope,perBotCap:h.per_bot_cap_usd,globalCeiling:h.global_ceiling_usd},await allReservationTotals(c)))throw new StartRefusal('spending_limit');
      await c.query("UPDATE grid_worker_requests SET state='admitted',admitted_at=clock_timestamp() WHERE id=$1 AND state='pending'",[id]);
      await c.query(`INSERT INTO grid_worker_reservations(bot_id,start_request_id,owner_wallet,wallet_generation,policy_digest,scope_revision,
        investment_usd,leverage,budget_notional_usd,observed_exposure_usd,reserve_usd,cash_commitment_usd,fee_reserve_usd,state,facts_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[row.bot_id,id,row.owner_wallet,row.wallet_generation,
        row.spending_policy_digest,row.scope_revision,r.investment,r.leverage,r.budget,r.exposure,r.reserve,r.cash,r.fees,r.uncertain?'uncertain':'held',new Date(r.factsAt)]);
      return {...consent,state:'admitted'};
    },{terminate:this.terminate});}catch(error){
      const code=error instanceof StartRefusal?error.code:error instanceof Error&&error.message==='GRID_CONSENT_EXPIRED'?'consent_expired':'authority_refused';
      await this.refuse(id,code);throw error;
    }
  }
  private async refuse(id:string,code:StartResultCode) {
    // Admission has already rolled back. This write and the independent incident cannot roll back with it.
    try{await fencedTransaction(this.lane,async c=>{
      await requestLocks(c,id);
      await c.query(`UPDATE grid_worker_requests SET state=$2,completed_at=clock_timestamp(),result_code=$3
        WHERE id=$1 AND state='pending'`,[id,code==='consent_expired'?'expired':'refused',code]);
    },{terminate:this.terminate});}finally{await this.incidents.record({code:'authority_refused',dedupKey:'grid-worker:request:'+id});}
  }
  /** Reconciliation may increase held risk even while entries are paused. Never forces a close. */
  async refresh(id:string,holder:WorkerRequestContext,facts:SpendingFacts):Promise<void>{
    const above=await fencedTransaction(this.lane,async c=>{
      const row=await requestLocks(c,id),h=await workerHost(c,holder,true);
      const held=(await c.query("SELECT * FROM grid_worker_reservations WHERE bot_id=$1 AND start_request_id=$2 AND state IN ('held','uncertain') FOR UPDATE",[row.bot_id,id])).rows[0];
      if(!held)throw new StartRefusal('authority_refused');
      const r=calculateSpending(held.investment_usd,held.leverage,facts,new Date(h.db_now).getTime());
      await c.query(`UPDATE grid_worker_reservations SET observed_exposure_usd=$2,reserve_usd=$3,cash_commitment_usd=$4,
        fee_reserve_usd=$5,state=$6,facts_at=$7,updated_at=clock_timestamp() WHERE bot_id=$1 AND state IN ('held','uncertain')`,
        [row.bot_id,r.exposure,r.reserve,r.cash,r.fees,r.uncertain?'uncertain':'held',new Date(r.factsAt)]);
      return {aboveBudget:r.aboveBudget,botId:String(row.bot_id)};
    },{terminate:this.terminate});
    if(above.aboveBudget)await this.incidents.record({code:'exposure_above_budget',dedupKey:'grid-worker:exposure:'+id,botId:above.botId});
  }
}
/** U4 must call within its locked custody/final-send transaction. Expiry does not strand admitted work. */
export async function verifyAdmittedStart(c:PoolClient,id:string,holder:WorkerRequestContext,umk:Buffer):Promise<StoredStartConsent> {
  const row=await requestLocks(c,id);await workerHost(c,holder);
  const r=(await c.query(`SELECT state,start_request_id,observed_exposure_usd>budget_notional_usd AS over_budget,
    facts_at<=clock_timestamp() AND facts_at>clock_timestamp()-interval '5 seconds' AS fresh
    FROM grid_worker_reservations WHERE bot_id=$1 FOR UPDATE`,[row.bot_id])).rows[0];
  if(!r||r.start_request_id!==id||!['held','uncertain'].includes(r.state))throw new StartRefusal('authority_refused');
  if(!r.fresh)throw new StartRefusal('authority_refused');
  if(r.over_budget)throw new StartRefusal('spending_limit');
  const {consent}=await verified(c,row,umk,['admitted']);
  const h=await externalHost(c),totals=await allReservationTotals(c);
  if(h.global_ceiling_usd!==null&&(new Decimal(totals.reserve).gt(h.global_ceiling_usd)||new Decimal(totals.cash).gt(h.global_ceiling_usd)))throw new StartRefusal('spending_limit');
  return consent;
}

/** U4/U6 call only at the END of the same locked terminal settlement transaction, after N18 release. */
export async function releaseTerminalReservation(c:PoolClient,id:string,holder:WorkerRequestContext):Promise<string>{
  const row=await requestLocks(c,id),h=await workerHost(c,holder,true);
  const terminal=(await c.query(`SELECT b.status,a.account,a.master_account,a.released_at,p.status AS pool_status,p.bot_id AS pool_bot,
    p.wallet_address,p.agent_public_key,p.last_verified_empty_at,l.terminal_proof,m.observation,m.reconciled_at,
    EXISTS(SELECT 1 FROM grid_operations o WHERE o.bot_id=b.id AND o.state IN ('prepared','submitted','unconfirmed')) AS unresolved,
    EXISTS(SELECT 1 FROM grid_execution_claims x WHERE x.bot_id=b.id AND NOT x.slot_released) AS claimed
    FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id JOIN protocol_subaccounts p ON p.id=a.protocol_subaccount_id
    JOIN grid_lifecycle l ON l.bot_id=b.id JOIN grid_monitor_state m ON m.bot_id=b.id WHERE b.id=$1 FOR UPDATE OF b,a,p,l,m`,[row.bot_id])).rows[0];
  const proof=terminal?.terminal_proof,observation=terminal?.observation,now=new Date(h.db_now).getTime();
  if(!terminal||terminal.status!=='stopped'||!terminal.released_at||terminal.pool_status!=='spare'||terminal.pool_bot!==null
    ||terminal.wallet_address!==row.owner_wallet||terminal.agent_public_key!==terminal.master_account||terminal.unresolved||terminal.claimed
    ||!terminal.last_verified_empty_at||!proof||proof.state!=='empty'||proof.account!==terminal.account||proof.masterAccount!==terminal.master_account
    ||!Number.isSafeInteger(proof.observedAt)||proof.observedAt>now||now-proof.observedAt>=5000||proof.expiresAt<=now
    ||!observation?.inventoryComplete||observation.account!==terminal.account||!Array.isArray(observation.orders)||observation.orders.length!==0
    ||new Date(terminal.reconciled_at).getTime()>now||now-new Date(terminal.reconciled_at).getTime()>=5000
    ||!observation.position||!new Decimal(observation.position.size).isZero())throw new StartRefusal('authority_refused');
  const proofDigest=createHash('sha256').update(JSON.stringify(proof)).digest('hex');
  const released=await c.query(`UPDATE grid_worker_reservations SET state='released',terminal_proof_digest=$2,updated_at=clock_timestamp()
    WHERE bot_id=$1 AND start_request_id=$3 AND state IN ('held','uncertain') RETURNING bot_id`,[row.bot_id,proofDigest,id]);
  if(released.rowCount!==1)throw new StartRefusal('authority_refused');
  await c.query("UPDATE grid_worker_requests SET state='complete',completed_at=clock_timestamp() WHERE id=$1 AND state='admitted'",[id]);
  return proofDigest;
}

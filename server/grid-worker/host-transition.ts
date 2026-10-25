import type {PoolClient} from 'pg';
import Decimal from 'decimal.js';
import {ownerParamsDigest,canonicalOwnerParams} from './owner-auth';
import {requireVerifiedOwner,type VerifiedOwnerContext} from './owner-receipts';
import {mainReadinessIdentity} from './main-readiness-identity';
import {identityMatches,type WorkerBuildIdentity} from './build-identity';
import {aggregateReservationFence} from './spending';
import {walletFences,type ClientLane} from './transaction';
import {waitGridWorkerFence} from '../grid-bot/worker-ownership';
import {identityFences} from './identity-locks';
import {localContext} from './host';
import {readQuotaPolicies} from './quota';
import {validateQuotaPolicies} from './quota-policy';
import {OWNER_MASTER_PUBLIC_KEYS} from './owner-master-keys';

export interface TransitionParams {
  executionMode:'external';runMode:'test'|'trading';executionEnabled:boolean;legacyControlsEnabled:boolean;drainRequested:boolean;
  commitHash:string;treeHash:string;lockfileSha256:string;expectedFencingEpoch:string;expectedScopeRevision:string;
}
interface Account {account:string;master:string}
export interface TransitionEvidence {accounts:Account[];observedAt:number;flat:boolean}
type Read=(master:string,path:string,params:Record<string,string>)=>Promise<unknown>;
const accountSql=`SELECT account,master FROM (
  SELECT a.account,a.master_account AS master FROM grid_launch_accounts a
  UNION SELECT p.protocol_subaccount_id AS account,p.agent_public_key AS master
    FROM grid_bots b JOIN protocol_subaccounts p ON p.id=b.protocol_subaccount_id
    WHERE p.protocol='pacifica'
) identities ORDER BY account,master`;
/** Venue reads finish before the exclusive transaction. Retained identities are rechecked inside it. */
export async function collectTransitionEvidence(lane:ClientLane,read:Read):Promise<TransitionEvidence>{
  const c=await lane.connect();let accounts:Account[];
  try{accounts=(await c.query<Account>(accountSql)).rows;}finally{c.release();}
  if(accounts.length>100||accounts.some(a=>!a.account||!a.master||!OWNER_MASTER_PUBLIC_KEYS.includes(a.master)))throw Error('GRID_TRANSITION_SCOPE');
  const observedAt=Date.now();let flat=true;
  for(const a of accounts){
    const raw=await Promise.all([read(a.master,'/account',{account:a.account}),read(a.master,'/orders',{account:a.account}),read(a.master,'/positions',{account:a.account})]);
    const [balance,orders,positions]=raw as Record<string,any>[];
    for(const r of [balance,orders,positions])if(!r||r.success!==true||r.error!=null||r.partial===true||r.has_more===true||r.complete===false)throw Error('GRID_TRANSITION_EVIDENCE');
    if(!Array.isArray(orders.data)||!Array.isArray(positions.data)||orders.data.length||positions.data.length)flat=false;
    if(!balance.data||!['balance','pending_balance'].every(k=>typeof balance.data[k]==='string'&&new Decimal(balance.data[k]).isZero()))flat=false;
  }
  return {accounts,observedAt,flat};
}
export interface TransitionResult {executionMode:string;runMode:string;executionEnabled:boolean;entriesPaused:true;fencingEpoch:string;scopeRevision:string}
export function transitionView(h:Record<string,any>):TransitionResult {
  if(h.entries_paused!==true)throw Error('GRID_TRANSITION_READBACK');
  return {executionMode:h.execution_mode,runMode:h.run_mode,executionEnabled:h.execution_enabled,entriesPaused:true,
    fencingEpoch:String(h.fencing_epoch),scopeRevision:String(h.scope_revision)};
}
export function exactTransitionReadback(h:Record<string,any>|undefined,p:TransitionParams):boolean {
  return !!h&&h.execution_mode===p.executionMode&&h.run_mode===p.runMode&&h.execution_enabled===p.executionEnabled
    &&h.legacy_controls_enabled===p.legacyControlsEnabled&&h.drain_requested===p.drainRequested&&h.entries_paused===true
    &&String(h.fencing_epoch)===(BigInt(p.expectedFencingEpoch)+1n).toString()
    &&String(h.scope_revision)===(BigInt(p.expectedScopeRevision)+1n).toString()&&identityMatches(h,p);
}
/** Caller holds the exclusive host fence. No network, signing or automatic rollback here. */
export async function transitionHost(c:PoolClient,owner:VerifiedOwnerContext,p:TransitionParams,e:TransitionEvidence,
  identity:WorkerBuildIdentity=mainReadinessIdentity):Promise<TransitionResult>{
  requireVerifiedOwner(owner,'host_transition','all');canonicalOwnerParams('host_transition',p);
  if(owner.paramsDigest!==ownerParamsDigest('host_transition',p))throw Error('GRID_RECEIPT_PARAMS');
  if(!identityMatches({commit_hash:p.commitHash,tree_hash:p.treeHash,lockfile_sha256:p.lockfileSha256},identity))throw Error('GRID_TRANSITION_IDENTITY');
  await aggregateReservationFence(c);
  const wallets=(await c.query('SELECT address FROM wallets ORDER BY address')).rows.map(r=>r.address as string);
  await walletFences(c,wallets);
  const bots=(await c.query('SELECT id FROM grid_bots ORDER BY id')).rows.map(r=>r.id as string);
  for(const id of bots)await waitGridWorkerFence(c,id);
  const pools=(await c.query('SELECT protocol_subaccount_id AS id FROM grid_launch_accounts UNION SELECT protocol_subaccount_id AS id FROM grid_bots WHERE protocol_subaccount_id IS NOT NULL ORDER BY id')).rows.map(r=>Number(r.id));
  await identityFences(c,bots,pools);
  const h=(await c.query('SELECT *,lease_expires_at>clock_timestamp() AS holder_live,clock_timestamp() AS db_now FROM grid_worker_host WHERE singleton_id=1 FOR UPDATE')).rows[0];
  const now=new Date(h?.db_now).getTime();
  if(!OWNER_MASTER_PUBLIC_KEYS.length||!h||h.drain_requested||h.owner_wallet!==owner.ownerWallet||!h.authority_tracking_enabled||h.holder_live||!h.entries_paused
    ||String(h.fencing_epoch)!==p.expectedFencingEpoch||String(h.scope_revision)!==p.expectedScopeRevision
    ||!Number.isSafeInteger(e.observedAt)||now<e.observedAt||now-e.observedAt>=5000||!e.flat)throw Error('GRID_TRANSITION_NOT_READY');
  if(p.executionMode!=='external'||p.drainRequested||p.legacyControlsEnabled!==true
    ||!(h.execution_mode==='legacy'&&p.runMode==='test'&&!p.executionEnabled
      ||h.execution_mode==='external'&&h.run_mode==='test'&&!h.execution_enabled&&p.runMode==='trading'&&p.executionEnabled))throw Error('GRID_TRANSITION_DIRECTION');
  const accounts=(await c.query<Account>(accountSql)).rows;
  if(JSON.stringify(accounts)!==JSON.stringify(e.accounts))throw Error('GRID_TRANSITION_EVIDENCE_CHANGED');
  const refusal=(await c.query(`SELECT
    EXISTS(SELECT 1 FROM wallets w LEFT JOIN grid_worker_wallet_authority a ON a.wallet_address=w.address WHERE a.wallet_address IS NULL)
    OR EXISTS(SELECT 1 FROM grid_bots b LEFT JOIN protocol_subaccounts p ON p.id=b.protocol_subaccount_id WHERE b.protocol_subaccount_id IS NOT NULL AND (p.id IS NULL OR p.protocol<>'pacifica' OR p.protocol_subaccount_id IS NULL OR p.agent_public_key IS NULL))
    OR EXISTS(SELECT 1 FROM grid_bots WHERE status NOT IN ('draft','failed','stopped') OR lease_expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM grid_operations WHERE state IN ('prepared','submitted','unconfirmed'))
    OR EXISTS(SELECT 1 FROM grid_execution_claims WHERE NOT slot_released)
    OR EXISTS(SELECT 1 FROM grid_worker_send_audit WHERE signed_expires_at>clock_timestamp() OR outcome='unknown')
    OR EXISTS(SELECT 1 FROM grid_worker_reservations WHERE state IN ('held','uncertain'))
    OR EXISTS(SELECT 1 FROM grid_worker_incidents WHERE severity='critical' AND (acknowledged_at IS NULL OR resolved_at IS NULL)) AS refused`)).rows[0];
  if(refusal.refused)throw Error('GRID_TRANSITION_LIABILITY');
  validateQuotaPolicies(await readQuotaPolicies(c),now);
  await c.query("SELECT grid_worker_consume_receipt($1::uuid,'host_transition','all',$2)",[owner.receiptId,owner.paramsDigest]);
  await c.query("SELECT set_config('qv.grid_worker_ready','true',true),set_config('qv.grid_worker_owner_verified','true',true)");
  await localContext(c,'transition');
  const changed=(await c.query(`UPDATE grid_worker_host SET execution_mode='external',run_mode=$1,execution_enabled=$2,legacy_controls_enabled=true,
    commit_hash=$3,tree_hash=$4,lockfile_sha256=$5,fencing_epoch=fencing_epoch+1,scope_revision=scope_revision+1,
    holder_boot_id=NULL,holder_role=NULL,lease_expires_at='-infinity' WHERE singleton_id=1 RETURNING *`,
    [p.runMode,p.executionEnabled,p.commitHash,p.treeHash,p.lockfileSha256])).rows[0];
  return transitionView(changed);
}

import {retainedGridPolicy as decodeRetainedGridPolicy} from './retained-policy';
import DecimalBase from 'decimal.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type {LaunchFacts} from './provision';
import type {GridAccount} from './custody';
import {canonicalGridPolicy,verifyGridPolicyHmac,type GridPolicy} from './policy-hmac';
import {createGridFeeQuote} from './fee-authority';
import {gridBookFact} from './first-placement';
import {readGridMargin} from './margin';
import {observePacificaConstraints,checkEntryConstraints} from '../protocol/market-constraints';
import {parseGridVenueOrders} from './order-identity';
import {gridCapacitySnapshot} from './capacity';
import {gridRecyclerGate,gridWalletEntryGate} from './runtime-policy';
import {createGridSolReader} from './sol-authority';
import type {GridLaunchReads} from './launch-reads';
import type {GridLaunchStorage} from './launch-storage';
import {GridLaunchTransientError} from './launch-storage';
import type {GridLifecycleDeps,GridResumeRisk} from './lifecycle-service';
import type {GridMonitorStorage} from './monitor-storage';
import {durableGridUmk} from './service';
import {GridLaunchAuthority,retainedGridPolicy,gridProductionResume as resumeCore,type GridLaunchSecurity} from './launch-authority-core';
export * from './launch-authority-core';
const sharedSol=createGridSolReader(async wallet=>(await import('../solana-balance-read')).getAgentSolBalanceLamportsStrict(wallet));
/** Existing wrapped UMK plus exact V3 agent key; no session or legacy-key fallback. */
export async function unlockGridLaunchAgent(wallet:string,umk:Buffer):Promise<GridLaunchSecurity|null>{
  const [{storage},{decryptAgentKeyV3}]=await Promise.all([import('../storage'),import('../session-v3')]);
  const row=await storage.getWallet(wallet);
  if(!row||row.address!==wallet||!row.executionEnabled||row.emergencyStopTriggered||!row.umkEncryptedForExecution||!row.agentPublicKey||!row.agentPrivateKeyEncryptedV3
    ||!Number.isSafeInteger(row.umkVersion)||row.umkVersion<1||!Buffer.isBuffer(umk)||umk.length!==32||!/^[a-fA-F0-9]{64}$/.test(process.env.SERVER_EXECUTION_KEY??''))return null;
  let signingKey:Buffer|undefined;
  try{
    signingKey=decryptAgentKeyV3(umk,row.agentPrivateKeyEncryptedV3,wallet);if(signingKey.length!==64)return null;
    const pair=nacl.sign.keyPair.fromSeed(signingKey.subarray(0,32));
    try{if(bs58.encode(pair.publicKey)!==row.agentPublicKey||!Buffer.from(pair.publicKey).equals(signingKey.subarray(32)))return null;}finally{pair.secretKey.fill(0);}
    const retained=signingKey;signingKey=undefined;
    return {signingKey:retained,masterAccount:row.agentPublicKey,umkVersion:row.umkVersion,cleanup:()=>retained.fill(0),current:async()=>{
      const current=await storage.getWallet(wallet);
      return !!current&&current.executionEnabled&&!current.emergencyStopTriggered&&current.umkVersion===row.umkVersion&&current.agentPublicKey===row.agentPublicKey
        &&current.umkEncryptedForExecution===row.umkEncryptedForExecution&&current.agentPrivateKeyEncryptedV3===row.agentPrivateKeyEncryptedV3;
    }};
  }catch{return null;}finally{signingKey?.fill(0);}
}
export function productionGridLaunchAuthority(reads:GridLaunchReads,ledger:GridLaunchStorage):GridLaunchAuthority{
  return new GridLaunchAuthority({reads,unlock:unlockGridLaunchAgent,sol:sharedSol,now:Date.now,environment:()=>({
    REUSE_ON_CREATE:process.env.REUSE_ON_CREATE,RECYCLE_ON_DELETE:process.env.RECYCLE_ON_DELETE,
    REPLIT_DEPLOYMENT:process.env.REPLIT_DEPLOYMENT,GRID_RECYCLER_DEPLOYMENT:process.env.GRID_RECYCLER_DEPLOYMENT}),
    capacity:(master,account)=>ledger.transaction(async c=>({
      activeBots:Number((await c.query(`SELECT count(*) AS count FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id
        WHERE a.master_account=$1 AND a.released_at IS NULL AND b.status=ANY($2::text[])`,[master,['provisioning','canary','active','pausing','paused','resuming','reconciling','range_exhausted','stopping']])).rows[0].count),
      reservations:(await c.query(`SELECT c.operation_id AS id,c.slots FROM grid_execution_claims c JOIN grid_operations o ON o.id=c.operation_id
        WHERE c.master_account=$1 AND c.account=$2 AND NOT c.slot_released AND c.slots>0 AND o.state IN ('prepared','submitted','unconfirmed')`,[master,account])).rows
    })),
    reusable:(wallet,master)=>ledger.transaction(async c=>(await c.query(`SELECT p.protocol_subaccount_id AS account FROM protocol_subaccounts p
      WHERE p.wallet_address=$1 AND p.protocol='pacifica' AND p.agent_public_key=$2 AND p.status='spare' AND p.bot_id IS NULL
      AND p.derivation_index IS NULL AND p.aad_version=1 AND p.last_verified_empty_at IS NOT NULL AND p.subaccount_key_encrypted_v3 IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM grid_launch_accounts a WHERE a.protocol_subaccount_id=p.id AND a.released_at IS NULL)`,[wallet,master])).rows.map(r=>r.account))});
}
let defaultAuthority:Promise<GridLaunchAuthority>|undefined;
export function defaultGridLaunchAuthority(){
  return defaultAuthority??=Promise.all([import('../db'),import('./launch-storage'),import('./launch-reads'),import('../protocol/pacifica/pacifica-transport')])
    .then(([{pool},{GridLaunchStorage},{GridLaunchReads},{pacificaTransportAuthority}])=>{const ledger=new GridLaunchStorage(pool);return productionGridLaunchAuthority(new GridLaunchReads(pacificaTransportAuthority(),ledger,'0.5'),ledger);})
    .catch(error=>{defaultAuthority=undefined;throw error;});
}


export function gridProductionResume(storage:Pick<GridMonitorStorage,'snapshot'>,authority:GridLaunchAuthority,security=durableGridUmk){return resumeCore(storage,authority,security);}

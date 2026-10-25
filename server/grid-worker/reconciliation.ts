import {balanceReplay,type BalanceProof} from './balance-history';
import {ownedBalanceEvents,retainedBalanceFills} from './balance-ledger';
import {balancePages,matchBalanceTrades} from './balance-trades';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import type {GridObservation} from '../grid-bot/reconciliation';
import type {GridLaunchReads} from '../grid-bot/launch-reads';
import type {GridMonitorReads} from '../grid-bot/monitor-reads';
import type {GridRuntimeDependencies} from '../grid-bot/runtime-dependencies';
import {gridSignedInventory} from '../grid-bot/provision-evidence';
import {OWNER_MASTER_PUBLIC_KEYS} from './owner-master-keys';
import {fencedTransaction} from './transaction';
import type {GridIncidents} from './incidents';
export const RECONCILIATION_STREAMS=['orders','fills','transfers','withdrawals'] as const;
export interface ReconciliationAccount {account:string;master_account:string;bot_id:string|null;wallet_address:string;market:string|null;created_at:Date|string|null}
export function inventoryMismatch(venue:readonly string[],database:readonly string[]):boolean {
  return new Set(venue).size!==venue.length||new Set(database).size!==database.length
    ||venue.some(a=>!database.includes(a))||database.some(a=>!venue.includes(a));
}
/** A stored cursor alone cannot refresh coverage; every complete watermark needs a fresh full replay. */
export function reconciliationFresh(observation:GridObservation|null,account:ReconciliationAccount,now=Date.now()):boolean {
  const history=observation?.history,from=account.created_at===null?NaN:new Date(account.created_at).getTime();
  return !!observation&&observation.inventoryComplete&&observation.account===account.account
    &&observation.symbol===account.market?.replace(/-PERP$/,'')&&Number.isSafeInteger(observation.observedAt)
    &&observation.observedAt<=now&&now-observation.observedAt<5000&&!!history&&history.inclusive===true
    &&history.from===from&&Number.isSafeInteger(history.through)&&history.through>=from&&history.through<=observation.observedAt
    &&Number.isSafeInteger(history.publicationLagMs)&&history.publicationLagMs>=0&&history.publicationLagMs<=120000
    &&history.through<=observation.observedAt-history.publicationLagMs&&now-history.through<history.publicationLagMs+5000;
}
/** Bounded, venue-first inventory. Missing/deleted DB assignments are evidence, never silently skipped. */
export class WorkerReconciliation {
  constructor(private pool:Pool,private terminate:(pid:number)=>Promise<void>,private reads:GridLaunchReads,
    private observations:GridMonitorReads,private security:GridRuntimeDependencies,private incidents:GridIncidents,
    private ownerKeys:readonly string[]=OWNER_MASTER_PUBLIC_KEYS){}
  async pass(signal:AbortSignal):Promise<boolean>{
    const accounts=(await this.pool.query<ReconciliationAccount>(`SELECT p.protocol_subaccount_id AS account,p.agent_public_key AS master_account,
      a.bot_id,p.wallet_address,b.market,b.created_at FROM protocol_subaccounts p LEFT JOIN grid_launch_accounts a ON a.protocol_subaccount_id=p.id
      LEFT JOIN grid_bots b ON b.id=a.bot_id WHERE p.protocol='pacifica' AND p.protocol_subaccount_id IS NOT NULL
      AND p.agent_public_key=ANY($1::text[]) ORDER BY p.id LIMIT 101`,[this.ownerKeys])).rows;
    const outside=(await this.pool.query(`SELECT 1 FROM grid_bots b LEFT JOIN wallets w ON w.address=b.wallet_address
      WHERE w.agent_public_key IS NULL OR NOT(w.agent_public_key=ANY($1::text[]))
      UNION ALL SELECT 1 FROM grid_launch_accounts a WHERE NOT(a.master_account=ANY($1::text[])) LIMIT 1`,[this.ownerKeys])).rowCount;
    if(outside){await this.incidents.record({code:'reconciliation_unavailable',dedupKey:'grid-worker:outside-owner-scope'});return false;}
    if(accounts.length>100){await this.incidents.record({code:'reconciliation_unavailable',dedupKey:'grid-worker:inventory-bound'});return false;}
    let clean=this.ownerKeys.length>0;
    if(!clean)await this.incidents.record({code:'reconciliation_unavailable',dedupKey:'grid-worker:owner-master-unconfirmed'});
    const masters=new Set(this.ownerKeys);
    if(masters.size>10){await this.incidents.record({code:'reconciliation_unavailable',dedupKey:'grid-worker:master-bound'});return false;}
    let totalAccounts=0;
    for(const master of masters){
      signal.throwIfAborted();const retained=accounts.filter(a=>a.master_account===master);
      let inventory:string[]|null=null;
      if(this.ownerKeys.includes(master)){
        const wallets=(await this.pool.query('SELECT address FROM wallets WHERE agent_public_key=$1 LIMIT 2',[master])).rows;
        if(wallets.length===1){const key=await this.security.umk(wallets[0].address);let agent:Awaited<ReturnType<GridRuntimeDependencies['unlock']>>=null;
          try{if(key){agent=await this.security.unlock(wallets[0].address,key.umk);
            if(agent?.masterAccount===master&&await agent.current())inventory=gridSignedInventory(await this.reads.subaccounts(master,agent.signingKey,signal),master);
          }}catch{signal.throwIfAborted();}finally{agent?.cleanup();key?.cleanup();}
        }
      }
      const mismatch=inventory!==null&&inventoryMismatch(inventory,retained.map(a=>a.account));
      const all=[...retained,...(inventory??[]).filter(a=>!retained.some(r=>r.account===a)).map(account=>({account,master_account:master,bot_id:null,wallet_address:'',market:null,created_at:null}))];
      if(!inventory||mismatch){clean=false;await this.incidents.record({code:'reconciliation_unavailable',dedupKey:'grid-worker:inventory:'+createHash('sha256').update(master).digest('hex')});}
      if((totalAccounts+=all.length+1)>100){await this.incidents.record({code:'reconciliation_unavailable',dedupKey:'grid-worker:venue-inventory-bound'});return false;}
      all.push({account:master,master_account:master,bot_id:null,wallet_address:'',market:null,created_at:null});
      for(const account of all){
        signal.throwIfAborted();let observation:Awaited<ReturnType<GridMonitorReads['observe']>>|null=null;
        if(inventory&&!mismatch&&account.bot_id&&account.market&&account.created_at){
          try{observation=await this.observations.observe({account:account.account,masterAccount:master,symbol:account.market.replace(/-PERP$/,''),from:new Date(account.created_at).getTime(),through:Date.now()},signal);}catch{signal.throwIfAborted();}
        }
        let balance:BalanceProof|null=null;
        if(inventory&&!mismatch)try{balance=await balanceReplay(this.reads,master,account.account,signal,async()=>{
          const owned=await ownedBalanceEvents(this.pool,account.account);
          const fills=await retainedBalanceFills(this.pool,account.account);
          const trades=await balancePages(this.reads,master,account.account,'/trades/history',signal);
          const funding=await balancePages(this.reads,master,account.account,'/funding/history',signal);
          return [...owned,...matchBalanceTrades(account.account,trades,funding,fills)];
        });}catch{signal.throwIfAborted();}
        for(const identity of balance?.unexplained??[])await this.incidents.record({code:'audit_mismatch',dedupKey:'balance-unexplained:'+account.account+':'+identity,botId:account.bot_id??undefined,evidenceDigest:balance!.evidenceDigest});
        for(const id of balance?.unpublished??[])await this.incidents.record({code:'audit_mismatch',dedupKey:'own-transfer-unpublished:'+id,botId:account.bot_id??undefined,evidenceDigest:balance!.evidenceDigest});
        const latched=(await this.pool.query("SELECT 1 FROM grid_worker_incidents WHERE code='audit_mismatch' AND acknowledged_at IS NULL LIMIT 1")).rowCount;
        if(latched)clean=false;
        for(const stream of RECONCILIATION_STREAMS){
          const money=stream==='transfers'||stream==='withdrawals';
          const complete=!latched&&(money?balance?.complete===true:reconciliationFresh(observation,account));
          if(!account.bot_id&&!money)continue;
          const state=mismatch?'mismatch':complete?'complete':'incomplete';
          if(!complete)clean=false;
          const evidenceDigest=createHash('sha256').update(JSON.stringify({stream,state,observation:complete?observation:null,balanceEvidenceDigest:balance?.evidenceDigest})).digest('hex');
          await fencedTransaction(this.pool,async c=>{
            await c.query(`INSERT INTO grid_worker_reconciliation(account,master_account,bot_id,stream,state,last_attempt_at,last_complete_at,covered_through_at,evidence_digest,cursor)
              VALUES($1,$2,$3,$4,$5,clock_timestamp(),CASE WHEN $6 THEN clock_timestamp() END,$7,$8,$9)
              ON CONFLICT(account,stream) DO UPDATE SET master_account=EXCLUDED.master_account,bot_id=EXCLUDED.bot_id,state=EXCLUDED.state,
              last_attempt_at=EXCLUDED.last_attempt_at,last_complete_at=CASE WHEN $6 THEN EXCLUDED.last_complete_at ELSE grid_worker_reconciliation.last_complete_at END,
              covered_through_at=CASE WHEN $6 THEN EXCLUDED.covered_through_at ELSE grid_worker_reconciliation.covered_through_at END,
              evidence_digest=EXCLUDED.evidence_digest,cursor=CASE WHEN $6 THEN EXCLUDED.cursor ELSE grid_worker_reconciliation.cursor END`,
              [account.account,master,account.bot_id,stream,state,complete,complete?new Date(money?balance!.observedAt:observation!.history!.through):null,evidenceDigest,complete&&!money?observation!.history!.lastId??null:null]);
          },{terminate:this.terminate});
        }
      }
    }
    if(!clean)await this.incidents.record({code:'reconciliation_unavailable',dedupKey:'grid-worker:reconciliation-unavailable'});
    return clean;
  }
}

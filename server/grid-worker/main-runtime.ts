import {restoreProviderCostLatches,bindProviderCostIncidents} from './provider-cost-incidents';
import {pacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import {MainQuotaGuard,installMainQuotaGuard} from './main-quota-guard';
import {mainQuota} from './main-quota';
import {installMainQuotaAccounts} from './main-quota-scope';
import type {Pool} from 'pg';
import {fencedTransaction,type ClientLane} from './transaction';
import {tightenHost} from './host';
import {independentLane,backendTerminator} from './lanes';
let timer:ReturnType<typeof setTimeout>|undefined;
let ownerWallet:string|null=null;
export const mainOwnerWallet=()=>ownerWallet;
/** Only tightens. Clearing MAIN's flag can never clear the durable pause. */
export async function relayMainEntriesPause(lane:ClientLane,terminate:(pid:number)=>Promise<void>,paused:boolean){
  if(!paused)return;
  await fencedTransaction(lane,async c=>{
    if((await c.query("SELECT to_regclass('grid_worker_host') IS NOT NULL AS present")).rows[0]?.present)
      await tightenHost(c,{pause:true});
  },{terminate,tightening:true});
}
/** No lease import or mutation. Even an unavailable host suppresses local money when the flag is on. */
export async function startMainQuotaRefresh(pool:Pool){
  if((process.env.GRID_REMOTE_WORKER_ENABLED!=='true'&&process.env.GRID_ENTRIES_PAUSED!=='true')||timer)return;
  const lane=independentLane(pool),terminate=backendTerminator(independentLane(pool));
  const guard=new MainQuotaGuard(independentLane(pool),Date.now,()=>mainQuota.install([]));
  installMainQuotaGuard(guard);
  bindProviderCostIncidents(pool,pacificaTransportAuthority());
  const refresh=async()=>{
    try{await relayMainEntriesPause(lane,terminate,process.env.GRID_ENTRIES_PAUSED==='true');}
    catch{/* Retry on the next tick; local entry gates remain closed. */}
    if(process.env.GRID_REMOTE_WORKER_ENABLED==='true'){
      try{await restoreProviderCostLatches(pool);await guard.refresh();}catch{mainQuota.install([]);timer=setTimeout(()=>{void refresh();},5000);timer.unref();return;}
      try{installMainQuotaAccounts((await pool.query("SELECT protocol_subaccount_id AS account,agent_public_key AS master_account FROM protocol_subaccounts WHERE protocol='pacifica' AND protocol_subaccount_id IS NOT NULL")).rows);}
      catch{/* Retain the last verified child identities. */}
      try{mainQuota.install((await pool.query('SELECT * FROM grid_worker_quota_policy WHERE valid_until>clock_timestamp()')).rows);}
      catch{mainQuota.install([]);}
      try{ownerWallet=(await pool.query(`SELECT o.wallet_address FROM grid_worker_owner o JOIN grid_worker_host h
        ON h.singleton_id=o.singleton_id AND h.owner_wallet=o.wallet_address WHERE o.singleton_id=1`)).rows[0]?.wallet_address??null;}
      catch{ownerWallet=null;}
    }else ownerWallet=null;
    timer=setTimeout(()=>{void refresh();},5000);timer.unref();
  };
  await refresh();
}
export const mainMoneySuppressed=()=>process.env.GRID_REMOTE_WORKER_ENABLED==='true';

import {loadActiveGridLevels} from './active-epoch';

import type { GridMonitorStorage } from './monitor-storage';
import type { GridLaunchReads } from './launch-reads';
import { GridLifecycleStorage } from './lifecycle-storage';
import { GridMoveStorage, GridMoveError } from './move-storage';
import type {GridRuntimeDependencies} from './runtime-dependencies';
import type {PlannerCandle} from '../grid-planner/types';
import { retainedGridPolicy } from './retained-policy';
import { verifyGridPolicyHmac } from './policy-hmac';



export function createGridMoveCore(storage:GridMonitorStorage,reads:GridLaunchReads,dependencies:GridRuntimeDependencies,candlesRead:(symbol:string,timeframe:string,bars:number,end:number,signal:AbortSignal)=>Promise<PlannerCandle[]>){
  const authority=dependencies.authority(reads,storage.launch);
  return new GridMoveStorage(new GridLifecycleStorage(storage),async(wallet,id,signal)=>{
    const snapshot=await storage.launch.transaction(async c=>({
      bot:(await c.query('SELECT b.*,a.account,a.master_account,a.reused FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id AND a.released_at IS NULL WHERE b.id=$1 AND b.wallet_address=$2',[id,wallet])).rows[0],
      levels:(await loadActiveGridLevels(c,id,'all')).rows,
    }));
    if(!snapshot.bot)throw new GridMoveError('Bot account unavailable');
    const key=await dependencies.umk(wallet);if(!key)throw new GridMoveError('Execution authority unavailable');
    try{
      const bot=snapshot.bot,policy=retainedGridPolicy(bot,snapshot.levels);
      if(!verifyGridPolicyHmac(policy,key.umk,bot.policy_hmac).ok)throw new GridMoveError('Retained policy cannot be verified');
      const candles=await candlesRead(bot.market.replace(/-PERP$/,''),bot.chart_timeframe,200,Date.now(),signal);
      const {facts,risk}=await authority.collect(wallet,policy,{botId:id,wallet,account:bot.account,masterAccount:bot.master_account,leaseToken:bot.lease_token??'',reused:bot.reused===true},key.umk,signal);
      signal.throwIfAborted();
      return {facts,risk,candles,umk:key.umk,cleanup:key.cleanup};
    }catch(error){key.cleanup();throw error;}
  });
}


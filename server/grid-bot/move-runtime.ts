import {loadActiveGridLevels} from './active-epoch';
import { pacificaTransportAuthority } from '../protocol/pacifica/pacifica-transport';
import type { GridMonitorStorage } from './monitor-storage';
import type { GridLaunchReads } from './launch-reads';
import { GridLifecycleStorage } from './lifecycle-storage';
import { GridMoveStorage, GridMoveError } from './move-storage';
import { productionGridLaunchAuthority } from './launch-authority';
import { retainedGridPolicy } from './retained-policy';
import { verifyGridPolicyHmac } from './policy-hmac';
import { durableGridUmk } from './service';
import { pacificaPlannerCandles } from '../grid-planner/pacifica-candles';

export function createGridMoveStorage(storage:GridMonitorStorage,reads:GridLaunchReads){
  const authority=productionGridLaunchAuthority(reads,storage.launch);
  return new GridMoveStorage(new GridLifecycleStorage(storage),async(wallet,id,signal)=>{
    const snapshot=await storage.launch.transaction(async c=>({
      bot:(await c.query('SELECT b.*,a.account,a.master_account,a.reused FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id AND a.released_at IS NULL WHERE b.id=$1 AND b.wallet_address=$2',[id,wallet])).rows[0],
      levels:(await loadActiveGridLevels(c,id,'all')).rows,
    }));
    if(!snapshot.bot)throw new GridMoveError('Bot account unavailable');
    const key=await durableGridUmk(wallet);if(!key)throw new GridMoveError('Execution authority unavailable');
    try{
      const bot=snapshot.bot,policy=retainedGridPolicy(bot,snapshot.levels);
      if(!verifyGridPolicyHmac(policy,key.umk,bot.policy_hmac).ok)throw new GridMoveError('Retained policy cannot be verified');
      const candles=await pacificaPlannerCandles(bot.market.replace(/-PERP$/,''),bot.chart_timeframe,200,Date.now(),signal);
      const {facts,risk}=await authority.collect(wallet,policy,{botId:id,wallet,account:bot.account,masterAccount:bot.master_account,leaseToken:bot.lease_token??'',reused:bot.reused===true},key.umk,signal);
      signal.throwIfAborted();
      return {facts,risk,candles,umk:key.umk,cleanup:key.cleanup};
    }catch(error){key.cleanup();throw error;}
  });
}

let singleton:Promise<GridMoveStorage>|undefined;
export function productionGridMoves(){
  return singleton??=Promise.all([import('../db'),import('./launch-storage'),import('./monitor-storage'),import('./launch-reads')]).then(([{pool},{GridLaunchStorage},{GridMonitorStorage},{GridLaunchReads}])=>{const ledger=new GridLaunchStorage(pool);return createGridMoveStorage(new GridMonitorStorage(ledger),new GridLaunchReads(pacificaTransportAuthority(),ledger,'0.5'));});
}

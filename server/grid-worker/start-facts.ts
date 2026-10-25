import type {Pool} from 'pg';
import Decimal from 'decimal.js';
import {retainedGridPolicy} from '../grid-bot/retained-policy';
import {loadActiveGridLevels} from '../grid-bot/active-epoch';
import {verifyGridPolicyHmac} from '../grid-bot/policy-hmac';
import type {GridRuntimeDependencies} from '../grid-bot/runtime-dependencies';
import type {GridLaunchReads} from '../grid-bot/launch-reads';
import type {GridLaunchStorage} from '../grid-bot/launch-storage-core';
import type {StartFacts} from './start-queue';

/** Initial Start only. An existing account or any attempted operation needs recovery, not a new reservation. */
export const initialStartZeroSql=`SELECT
  EXISTS(SELECT 1 FROM grid_launch_accounts WHERE bot_id=$1)
  OR EXISTS(SELECT 1 FROM protocol_subaccounts WHERE bot_id=$1::text)
  OR EXISTS(SELECT 1 FROM grid_operations WHERE bot_id=$1)
  OR EXISTS(SELECT 1 FROM grid_worker_send_audit WHERE bot_id=$1) AS used`;
export async function collectStartFacts(pool:Pool,security:GridRuntimeDependencies,reads:GridLaunchReads,ledger:GridLaunchStorage,
  botId:string,umk:Buffer,signal:AbortSignal):Promise<StartFacts>{
  const c=await pool.connect();let bot:Record<string,any>,policy;
  try{
    bot=(await c.query('SELECT * FROM grid_bots WHERE id=$1',[botId])).rows[0];
    if(!bot||!['draft','failed'].includes(bot.status)||bot.protocol_subaccount_id!==null
      ||(await c.query(initialStartZeroSql,[botId])).rows[0].used)throw Error('GRID_START_ZERO_STATE_REQUIRED');
    policy=retainedGridPolicy(bot,(await loadActiveGridLevels(c,botId,'policy')).rows);
    if(!verifyGridPolicyHmac(policy,umk,bot.policy_hmac).ok)throw Error('GRID_START_POLICY_CHANGED');
  }finally{c.release();}
  const launch=await security.authority(reads,ledger).observe(bot.wallet_address,policy,null,umk,signal);
  // No custody, fills, open orders or funding obligation exists for this new bot.
  // Reserve both entry and exit fees against the entire authorized notional.
  const feeReserve=new Decimal(policy.totalInvestment).mul(policy.leverage).mul(launch.margin.feeRate).mul(2).toFixed();
  return {launch,spending:{complete:true,observedAt:launch.observedAt,quoteDecimals:6,positionNotional:'0',orders:[],entries:[],
    feeReserve,fundingReserve:'0',remainingSlippageReserve:'0',uncertainTransfers:[]}};
}

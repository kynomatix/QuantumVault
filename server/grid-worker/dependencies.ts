import bs58 from 'bs58';
import nacl from 'tweetnacl';
import Decimal from 'decimal.js';
import type {Pool} from 'pg';
import {getExecutionUmk,readExecutionWallet} from '../execution/umk';
import {decryptAgentKeyV3} from '../execution/agent-key';
import {GridLaunchAuthority} from '../grid-bot/launch-authority-core';
import type {GridRuntimeDependencies} from '../grid-bot/runtime-dependencies';
import {PacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import {createGridMoveCore} from '../grid-bot/move-core';
import {validateCandles} from '../grid-planner/chart';
import type {PlannerCandle} from '../grid-planner/types';
import {workerFetch} from './transport';
import type {WorkerQuota} from './quota';

/** No MAIN defaults, sessions, canonical UMK, general adapter or background service. */
export function workerDependencies(pool:Pool,quota:Pick<WorkerQuota,'debit'|'rateLimited'>,env:Readonly<NodeJS.ProcessEnv>):GridRuntimeDependencies {
  const fetcher=workerFetch(quota),transport=new PacificaTransportAuthority(env.PACIFICA_API_KEY);
  const environment={REUSE_ON_CREATE:env.REUSE_ON_CREATE,RECYCLE_ON_DELETE:env.RECYCLE_ON_DELETE,REPLIT_DEPLOYMENT:env.REPLIT_DEPLOYMENT,GRID_RECYCLER_DEPLOYMENT:env.GRID_RECYCLER_DEPLOYMENT};
  const dependencies:GridRuntimeDependencies={
    umk:wallet=>getExecutionUmk(pool,wallet),
    async unlock(wallet,umk){
      const row=await readExecutionWallet(pool,wallet);
      if(!row?.executionEnabled||row.emergencyStopTriggered||!row.umkEncryptedForExecution||!row.agentPrivateKeyEncryptedV3||!row.agentPublicKey||!row.umkVersion)return null;
      let key:Buffer|undefined;
      try{
        key=decryptAgentKeyV3(umk,row.agentPrivateKeyEncryptedV3,wallet);
        if(key.length!==64)return null;
        const pair=nacl.sign.keyPair.fromSeed(key.subarray(0,32));
        try{if(bs58.encode(pair.publicKey)!==row.agentPublicKey||!Buffer.from(pair.publicKey).equals(key.subarray(32)))return null;}finally{pair.secretKey.fill(0);}
        const retained=key;key=undefined;
        return {masterAccount:row.agentPublicKey,umkVersion:row.umkVersion,signingKey:retained,cleanup:()=>retained.fill(0),current:async()=>{
          const current=await readExecutionWallet(pool,wallet);
          return !!current?.executionEnabled&&!current.emergencyStopTriggered&&current.umkVersion===row.umkVersion
            &&current.agentPublicKey===row.agentPublicKey&&current.umkEncryptedForExecution===row.umkEncryptedForExecution
            &&current.agentPrivateKeyEncryptedV3===row.agentPrivateKeyEncryptedV3;
        }};
      }catch{return null;}finally{key?.fill(0);}
    },
    transport,fetcher,environment,
    async sol(wallet,signal){
      const endpoint=new URL(env.HELIUS_API_KEY?'https://mainnet.helius-rpc.com/':'https://api.mainnet-beta.solana.com/');
      if(env.HELIUS_API_KEY)endpoint.searchParams.set('api-key',env.HELIUS_API_KEY);
      const url=endpoint.href;
      const started=Date.now(),response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},signal,
        body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getBalance',params:[wallet,{commitment:'confirmed'}]})});
      const result=await response.json();
      if(!response.ok||result.error||!Number.isSafeInteger(result.result?.value)||result.result.value<0||Date.now()-started>=5000)return null;
      return {balance:new Decimal(result.result.value).div(1e9).toFixed(),observedAt:started};
    },
    authority:(reads,ledger)=>new GridLaunchAuthority({reads,unlock:(wallet,key)=>dependencies.unlock(wallet,key),sol:(wallet,signal)=>dependencies.sol(wallet,signal),now:Date.now,environment:()=>environment,
      capacity:(master,account)=>ledger.transaction(async c=>({
        activeBots:Number((await c.query(`SELECT count(*) AS count FROM grid_bots b JOIN grid_launch_accounts a ON a.bot_id=b.id
          WHERE a.master_account=$1 AND a.released_at IS NULL AND b.status NOT IN ('draft','failed','stopped')`,[master])).rows[0].count),
        reservations:(await c.query(`SELECT c.operation_id AS id,c.slots FROM grid_execution_claims c JOIN grid_operations o ON o.id=c.operation_id
          WHERE c.master_account=$1 AND c.account=$2 AND NOT c.slot_released AND c.slots>0 AND o.state IN ('prepared','submitted','unconfirmed')`,[master,account])).rows})),
      reusable:(wallet,master)=>ledger.transaction(async c=>(await c.query(`SELECT p.protocol_subaccount_id AS account FROM protocol_subaccounts p
        WHERE p.wallet_address=$1 AND p.protocol='pacifica' AND p.agent_public_key=$2 AND p.status='spare' AND p.bot_id IS NULL
        AND p.derivation_index IS NULL AND p.aad_version=1 AND p.last_verified_empty_at IS NOT NULL AND p.subaccount_key_encrypted_v3 IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM grid_launch_accounts a WHERE a.protocol_subaccount_id=p.id AND a.released_at IS NULL)`,[wallet,master])).rows.map(r=>r.account))}),
    move:(storage,reads,claim,signal)=>createGridMoveCore(storage,reads,dependencies,async(symbol,timeframe,bars,end,abort)=>{
      const duration:Record<string,number>={'15m':900000,'1h':3600000,'4h':14400000,'1d':86400000},step=duration[timeframe];
      if(!step||bars!==200)return [];
      const start=Math.floor(end/step)*step-bars*step;
      const raw=await reads.json(claim.masterAccount,'/kline',{symbol,interval:timeframe,start_time:String(start),end_time:String(end-1),limit:String(bars)},abort) as {success:boolean;data:Record<string,any>[]};
      if(raw?.success!==true||!Array.isArray(raw.data)||raw.data.length!==bars)return [];
      const candles:PlannerCandle[]=[];
      for(const row of raw.data){
        if(row.s!==symbol||row.i!==timeframe||!Number.isSafeInteger(row.t)||row.t<start||row.t>=end||row.t%step!==0
          ||![row.t+step,row.t+step-1].includes(row.T)||!['o','h','l','c','v'].every(k=>typeof row[k]==='string'&&/^(0|[1-9]\d*)(\.\d+)?$/.test(row[k])))return [];
        candles.push({time:row.t,open:Number(row.o),high:Number(row.h),low:Number(row.l),close:Number(row.c),volume:Number(row.v),
          provenance:{source:'pacifica',venue:'pacifica',basis:'perp',proxy:'direct',timeSemantic:'open_time',finality:row.t+step<=end?'finalized':'forming'}});
      }
      candles.sort((a,b)=>a.time-b.time);return validateCandles(candles,end)?candles:[];
    }).activate(claim,signal),
  };
  return dependencies;
}

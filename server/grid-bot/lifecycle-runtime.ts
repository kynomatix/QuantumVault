import { createGridMoveStorage } from './move-runtime';
import {createGridSolReader} from './sol-authority';
const sharedGridSol=createGridSolReader(async wallet=>(await import('../solana-balance-read')).getAgentSolBalanceLamportsStrict(wallet));
import {GridLifecycleService,type GridLifecycleDeps,type GridSettlementFact} from './lifecycle-service';
import {GridLifecycleStorage} from './lifecycle-storage';
import type {GridMonitorStorage,GridMonitorClaim} from './monitor-storage';
import type {GridMonitorReads} from './monitor-reads';
import type {GridLaunchReads} from './launch-reads';
import {GridCustody} from './custody';
import {GridPacificaSender,reconcileGridLimit} from './execution';
import {reconcileGridReduction,freshGridFact} from './lifecycle-policy';
import {reconcileGridLaunch} from './launch-reconciliation';
import {validGridHistory,type GridObservation} from './reconciliation';
import {durableGridUmk} from './service';
import {pacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import Decimal from 'decimal.js';
import {GridFirstPlacementAuthority} from './first-placement';
import {productionGridLaunchAuthority,gridProductionResume,unlockGridLaunchAgent} from './launch-authority';
import {recoverGridTransfer} from './transfer-recovery';
import {observePacificaConstraints,checkEntryConstraints} from '../protocol/market-constraints';

/** Full-account facts, never a single balance interpreted as transfer or settlement evidence. */
export function gridTerminalFact(raw:unknown,claim:GridMonitorClaim,o:GridObservation,start:number,recycler:GridSettlementFact['recycler'],now:number):GridSettlementFact|null{
  const r=raw as {success?:unknown;data?:Record<string,unknown>},d=r?.data;
  const decimal=(v:unknown)=>typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v);
  if(r?.success!==true||!d||!freshGridFact(d.updated_at as number,now)||!freshGridFact(o.observedAt,now)||o.account!==claim.account||!o.inventoryComplete
    ||!validGridHistory(o.history,start,now)||!o.position||!new Decimal(o.position.size).isZero()||o.orders.some(x=>['open','partially_filled'].includes(x.status))
    ||d.positions_count!==0||d.orders_count!==0||d.stop_orders_count!==0||!Array.isArray(d.spot_balances)||d.spot_balances.length!==0
    ||!['balance','available_to_withdraw','account_equity','pending_balance','pending_interest','spot_collateral','spot_market_value','total_margin_used'].every(k=>decimal(d[k]))
    ||!['pending_balance','pending_interest','spot_collateral','spot_market_value','total_margin_used'].every(k=>new Decimal(d[k] as string).isZero())
    ||!new Decimal(d.balance as string).eq(d.account_equity as string))return null;
  return {account:claim.account,masterAccount:claim.masterAccount,balance:d.balance as string,withdrawable:d.available_to_withdraw as string,
    observedAt:d.updated_at as number,settlementComplete:true,source:'pacifica:/account+retained-operation-ledger+'+o.history.source,recycler};
}
export function gridLifecycleRuntime(storage:GridMonitorStorage,reads:GridMonitorReads,json:GridLaunchReads,authorities:Partial<Pick<GridLifecycleDeps,'resume'|'settlement'|'sol'|'recover'>>={}){
  const custody=new GridCustody(storage.launch),sender=new GridPacificaSender(pacificaTransportAuthority(),fetch,new GridFirstPlacementAuthority(storage.launch,json),storage.launch),lifecycle=new GridLifecycleStorage(storage);
  const observe=async(claim:GridMonitorClaim,signal:AbortSignal)=>{
    const {bot}=await storage.snapshot(claim),symbol=bot.market.replace(/-PERP$/,''),from=new Date(bot.created_at).getTime();
    try{return await reads.observe({...claim,symbol,from,through:Date.now()},signal);}catch{
      signal.throwIfAborted();return {account:claim.account,symbol,observedAt:Date.now(),inventoryComplete:false,orders:[],trades:[],history:null,position:null,mark:await reads.mark(claim.masterAccount,symbol,signal)} as GridObservation;
    }
  };
  const withKey=async<T>(claim:GridMonitorClaim,work:(identity:Awaited<ReturnType<GridCustody['recover']>>,umk:Buffer)=>Promise<T>)=>{
    const {bot}=await storage.snapshot(claim),security=await durableGridUmk(bot.wallet_address);if(!security)throw Error('Grid durable signing authority unavailable');
    try{return await work(await custody.recover(claim.id,bot.wallet_address,claim.leaseToken),security.umk);}finally{security.cleanup();}
  };
  const service=new GridLifecycleService({storage:lifecycle,observe,move:(claim,signal)=>createGridMoveStorage(storage,json).activate(claim,signal),
    marketTick:async(claim,signal)=>{
      const {bot}=await storage.snapshot(claim),started=Date.now(),raw=await json.json(claim.masterAccount,'/info',{},signal) as {success?:boolean;data?:Record<string,unknown>[]};
      signal.throwIfAborted();
      const rows=raw?.success===true&&Array.isArray(raw.data)?raw.data.filter(x=>x.symbol===bot.market.replace(/-PERP$/,'')):[];
      if(rows.length!==1||!checkEntryConstraints(observePacificaConstraints(rows[0],bot.market,started),bot.market,Date.now()).ok)return null;
      return typeof rows[0].tick_size==='string'?rows[0].tick_size:null;
    },
    sol:authorities.sol??((claim,signal)=>sharedGridSol(claim.masterAccount,signal)),
    resume:authorities.resume??gridProductionResume(storage,productionGridLaunchAuthority(json,storage.launch)),
    send:(claim,r)=>withKey(claim,(identity,umk)=>custody.withSecret(identity,umk,secret=>sender.send(r,secret,undefined,claim.leaseToken))),
    recover:authorities.recover??(async(claim,op,signal)=>{
      const r=op.exact_request;
      if(r.kind==='fund'||r.kind==='sweep')return recoverGridTransfer(storage,json,claim,op,()=>withKey(claim,async(identity,umk)=>{
        const agent=await unlockGridLaunchAgent(identity.wallet,umk);
        try{
          if(!agent||agent.masterAccount!==claim.masterAccount||!await agent.current())throw Error('Grid master signing authority unavailable');
          const raw=await json.subaccounts(claim.masterAccount,agent.signingKey,signal);
          if(!await agent.current())throw Error('Grid master generation changed');return raw;
        }finally{agent?.cleanup();}
      }),signal);
      const o=await observe(claim,signal);if(!o.inventoryComplete)return {state:'unknown'};
      if(r.kind==='limit')return reconcileGridLimit(r,o.orders);
      if(r.kind==='cancel'||r.kind==='close')return reconcileGridReduction(r,o.orders);
      if(r.kind==='seed')return reconcileGridLaunch(r,{kind:'seed',account:claim.account,complete:true,orders:o.orders,observedAt:o.observedAt},Date.now());
      return {state:'unknown'};}),
    settlement:authorities.settlement??(async(claim,signal)=>{const {bot}=await storage.snapshot(claim),o=await observe(claim,signal);
      const raw=await json.json(claim.masterAccount,'/account',{account:claim.account},signal);
      return gridTerminalFact(raw,claim,o,new Date(bot.created_at).getTime(),{reuse:process.env.REUSE_ON_CREATE,recycle:process.env.RECYCLE_ON_DELETE,
        deployment:process.env.REPLIT_DEPLOYMENT??'',expectedDeployment:process.env.GRID_RECYCLER_DEPLOYMENT??'',checkedAt:Date.now()},Date.now());}),
    recycle:(claim,id,proof)=>withKey(claim,(identity,umk)=>custody.recycleStopped(identity,umk,id,proof))
  });
  return {service,lifecycle};
}

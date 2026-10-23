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
const D=DecimalBase.clone({precision:200});
const AGE=5000;
type Row=Record<string,unknown>;
export class GridLaunchAuthorityUnavailable extends Error {
  constructor(reason:string){super(reason);this.name='GridLaunchAuthorityUnavailable';}
}
const deny=(reason:string):never=>{throw new GridLaunchAuthorityUnavailable(reason);};
export function retainedGridPolicy(bot:Record<string,any>,levels:Record<string,any>[]){
  try{return decodeRetainedGridPolicy(bot,levels);}catch{return deny('Grid retained policy unavailable.');}
}
const object=(v:unknown):Row=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Row:deny('Grid observation shape unavailable.');
function envelope(raw:unknown,account?:string):unknown{
  const r=object(raw);
  if(r.success!==true||r.error!==null||r.partial===true||r.complete===false||r.has_more===true||r.next_cursor!=null
    ||account!==undefined&&r.account!==undefined&&r.account!==account)deny('Grid observation incomplete or identity changed.');
  return r.data;
}
function accountData(raw:unknown,account:string):Row{
  const d=object(envelope(raw,account));
  if(d.account!==undefined&&d.account!==account||d.subaccount_id!=null)deny('Grid account identity changed.');
  return d;
}
function rows(raw:unknown,account?:string):Row[]{
  const d=envelope(raw,account);if(!Array.isArray(d))return deny('Grid inventory unavailable.');
  return d.map(v=>{const r=object(v);if(account!==undefined&&r.account!==undefined&&r.account!==account)deny('Grid row identity changed.');return r;});
}
function decimal(v:unknown,positive=false,signed=false):string{
  if(typeof v!=='string'||v.length>80||v.trim()!==v||!(signed?/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/:/^(?:0|[1-9]\d*)(?:\.\d+)?$/).test(v)
    ||!new D(v).isFinite()||positive&&!new D(v).gt(0))return deny('Grid exact decimal unavailable.');
  return v;
}
function fresh(at:unknown,now:number):number{
  if(!Number.isSafeInteger(at)||(at as number)<0||(at as number)>now||now-(at as number)>=AGE)return deny('Grid observation stale or timestamp unavailable.');
  return at as number;
}
export interface GridLaunchSecurity {
  masterAccount:string;umkVersion:number;signingKey:Uint8Array;current():Promise<boolean>;cleanup():void;
}
export interface GridLaunchAuthorityDeps {
  reads:Pick<GridLaunchReads,'json'|'subaccounts'|'quota'|'ready'>;
  unlock(wallet:string,umk:Buffer):Promise<GridLaunchSecurity|null>;
  sol(wallet:string,signal:AbortSignal):Promise<{balance:string;observedAt:number}|null>;
  reusable(wallet:string,masterAccount:string):Promise<string[]>;
  capacity(masterAccount:string,account:string):Promise<{activeBots:number;reservations:{id:string;slots:number}[]}>;
  environment():Pick<NodeJS.ProcessEnv,'REUSE_ON_CREATE'|'RECYCLE_ON_DELETE'|'REPLIT_DEPLOYMENT'|'GRID_RECYCLER_DEPLOYMENT'>;
  now():number;
}
/** Raw, identity-bound observations. Failure grants no partial LaunchFacts. */
export class GridLaunchAuthority {
  constructor(private deps:GridLaunchAuthorityDeps){}
  async observe(wallet:string,policy:GridPolicy,account:GridAccount|null,umk:Buffer,signal=new AbortController().signal):Promise<LaunchFacts>{
    return (await this.collect(wallet,policy,account,umk,signal)).facts;
  }
  async collect(wallet:string,policy:GridPolicy,account:GridAccount|null,umk:Buffer,signal:AbortSignal):Promise<{facts:LaunchFacts;risk:GridResumeRisk}>{
    signal.throwIfAborted();if(!canonicalGridPolicy(policy))deny('Grid retained policy unavailable.');
    const started=this.deps.now(),security=await this.deps.unlock(wallet,umk);
    if(!security)return deny('Durable Grid agent generation unavailable.');
    try{
      const master=security.masterAccount,target=account?.account??master,symbol=policy.market.replace(/-PERP$/,'');
      if(!master||account&&(account.wallet!==wallet||account.botId!==policy.id||account.masterAccount!==master||target===master||!account.leaseToken))deny('Grid retained account identity changed.');
      const env=this.deps.environment();
      const recycler={reuse:env.REUSE_ON_CREATE,recycle:env.RECYCLE_ON_DELETE,deployment:env.REPLIT_DEPLOYMENT??'',expectedDeployment:env.GRID_RECYCLER_DEPLOYMENT??'',checkedAt:started};
      if(!this.deps.reads.ready()
        ||!gridRecyclerGate(recycler,this.deps.now()))return deny('Grid transport or recycler authority unavailable.');
      // Settle every read before releasing the signing key, including failure/abort paths.
      const jobs=[
        ()=>this.deps.reads.json(master,'/account',{account:master},signal),
        ()=>this.deps.reads.json(master,'/account',{account:target},signal),
        ()=>this.deps.reads.json(master,'/account/settings',{account:target},signal),
        ()=>this.deps.reads.json(master,'/info',{},signal),()=>this.deps.reads.json(master,'/book',{symbol},signal),
        ()=>this.deps.reads.json(master,'/orders',{account:target},signal),()=>this.deps.reads.json(master,'/positions',{account:target},signal),
        ()=>this.deps.reads.subaccounts(master,security.signingKey,signal),()=>this.deps.sol(master,signal),()=>this.deps.reusable(wallet,master),
        ()=>this.deps.capacity(master,target)
      ];
      const settled=await Promise.allSettled(jobs.map(job=>Promise.resolve().then(job)));signal.throwIfAborted();
      if(settled.some(r=>r.status==='rejected'&&r.reason instanceof GridLaunchTransientError))throw new GridLaunchTransientError('Fresh Grid launch reads are waiting for durable quota authority.');
      if(settled.some(r=>r.status==='rejected'))deny('Fresh Grid launch observations unavailable.');
      const values=settled.map(r=>(r as PromiseFulfilledResult<unknown>).value);
      const [rawMaster,rawTarget,rawSettings,rawInfo,rawBook,rawOrders,rawPositions,rawInventory,rawSol,rawReusable,rawCapacity]=values;
      const now=this.deps.now(),m=accountData(rawMaster,master),a=accountData(rawTarget,target),settings=accountData(rawSettings,target);
      const masterAt=fresh(m.updated_at,now),accountAt=fresh(a.updated_at,now);
      const withdrawable=decimal(m.available_to_withdraw),available=decimal(a.available_to_spend);
      decimal(a.maker_fee,false,true);decimal(a.taker_fee);
      const info=rows(rawInfo).filter(r=>r.symbol===symbol);
      if(info.length!==1)deny('Grid market identity unavailable.');const market=info[0];
      const constraints=observePacificaConstraints(market,policy.market,started);
      if(!checkEntryConstraints(constraints,policy.market,now).ok)deny('Grid market constraints unavailable.');
      const tick=decimal(market.tick_size,true),lot=decimal(market.lot_size,true),minimumQuote=decimal(market.min_order_size,true),maximumQuote=decimal(market.max_order_size,true),minimumPrice=decimal(market.min_tick,true),maximumPrice=decimal(market.max_tick,true);
      if(!Number.isSafeInteger(market.max_leverage)||(market.max_leverage as number)<1||new D(maximumQuote).lt(minimumQuote)||new D(maximumPrice).lt(minimumPrice))deny('Grid market limits unavailable.');
      const marginSettings=settings.margin_settings;
      if(!Array.isArray(marginSettings))return deny('Grid margin settings unavailable.');
      const matching=marginSettings.map(object).filter(r=>r.symbol===symbol);
      // Do not turn Pacifica's omitted default row into actual account leverage authority.
      if(matching.length!==1||typeof matching[0].isolated!=='boolean'||!Number.isSafeInteger(matching[0].leverage)||(matching[0].leverage as number)<1)deny('Explicit Grid leverage and margin mode unavailable.');
      const restrictions=market.instrument_type==='perpetual'&&market.isolated_only===false&&matching[0].isolated===false?'unrestricted':
        market.isolated_only===true||matching[0].isolated===true?'restricted':'unknown';
      if(restrictions!=='unrestricted')deny('Grid cross-margin market restriction authority unavailable.');
      const book=gridBookFact(rawBook,symbol,started,now);if(!book)deny('Fresh Grid book unavailable.');
      const fee=(role:'maker'|'taker',intent:'entry'|'profit')=>{
        const result=createGridFeeQuote({account:target,subaccountId:null,market:policy.market,liquidityRole:role,builderCode:null,intent},a,null,null,started,AGE);
        if(result.availability!=='available')return deny('Current Grid account fees unavailable.');return result.quote;
      };
      const margin=await readGridMargin({json:async(_master,path,params)=>{
        if(_master!==master||params.account!==target)deny('Grid margin identity changed.');
        return path==='/account'?rawTarget:path==='/account/settings'?rawSettings:deny('Grid margin source unavailable.');
      }},{kind:'limit',botId:policy.id,account:target,masterAccount:master,path:'/orders/create',operationType:'create_order',timestamp:started,expiryMs:AGE,data:{symbol,reduce_only:false},authority:{}});
      if(!margin||margin.available!==available||margin.leverage!==String(matching[0].leverage))deny('Strict C1 Grid margin authority unavailable.');
      margin!.observedAt=started;fresh(margin!.accountUpdatedAt,now);
      const inventory=object(envelope(rawInventory,master)),subaccounts=inventory.subaccounts;
      if(inventory.account!==undefined&&inventory.account!==master||!Array.isArray(subaccounts))return deny('Grid master subaccount inventory unavailable.');
      const addresses=subaccounts.map((v:unknown)=>{const r=object(v);if(typeof r.address!=='string'||!r.address||r.address.trim()!==r.address||r.address===master)return deny('Grid subaccount address unavailable.');return r.address;});
      if(addresses.length>10||new Set(addresses).size!==addresses.length||account&&!addresses.includes(target))deny('Grid subaccount inventory identity changed.');
      const orders=rows(rawOrders,target);const parsed=parseGridVenueOrders(orders);
      if(!Number.isSafeInteger(a.orders_count)||a.orders_count!==parsed.length)deny('Grid full-account order inventory unavailable.');
      const positions=rows(rawPositions,target);
      if(!Number.isSafeInteger(a.positions_count)||a.positions_count!==positions.length||new Set(positions.map(p=>p.symbol)).size!==positions.length)deny('Grid full-account position inventory unavailable.');
      for(const p of positions){if(typeof p.symbol!=='string'||!p.symbol||!['bid','ask'].includes(p.side as string))deny('Grid position identity unavailable.');decimal(p.amount);}
      const position=positions.find(p=>p.symbol===symbol);
      // Absence is zero only with a fresh explicit full-account zero count, as in the monitor.
      if(!position&&positions.length!==0)deny('Grid market flatness unavailable.');
      const positionSize=position?decimal(position.amount):'0';
      const liquidationPrice=position&&new D(positionSize).gt(0)?decimal(position.liquidation_price,true):null;
      const positionAt=position?fresh(position.updated_at,now):accountAt;
      if(position&&new D(positionSize).gt(0)&&(position.side==='bid'?'long':'short')!==policy.direction)deny('Grid actual position direction changed.');
      const sol=rawSol as {balance:string;observedAt:number}|null;
      if(!sol||!gridWalletEntryGate(decimal(sol.balance)).entryAllowed)deny('Strict Grid SOL reserve unavailable.');fresh(sol!.observedAt,now);
      if(!Array.isArray(rawReusable)||rawReusable.some(v=>typeof v!=='string'))deny('Grid reuse inventory unavailable.');
      const quota=await this.deps.reads.quota(master);decimal(quota.observedCredits,true);decimal(quota.availableGridCredits);
      if(!await security.current())deny('Grid execution or agent generation changed.');signal.throwIfAborted();
      const observedAt=Math.min(started,masterAt,accountAt,book!.observedAt,positionAt,sol!.observedAt);fresh(observedAt,this.deps.now());
      const retained=rawCapacity as Awaited<ReturnType<GridLaunchAuthorityDeps['capacity']>>;
      const capacity=gridCapacitySnapshot({owner:master,account:target,subaccountId:null,domain:master,expectedDomain:master,observedAt,expiresAt:observedAt+AGE,complete:true,
        orders:parsed.map(o=>({orderId:o.orderId,category:'unclassified' as const})),reservations:retained.reservations,activeBots:retained.activeBots,now:this.deps.now()});
      // Reservations and aggregate pilot exposure are checked under the existing C2 storage locks.
      if(capacity.observedUse.availability!=='available')deny('Grid order capacity unavailable.');
      return {facts:{observedAt,expiresAt:observedAt+AGE,masterAccount:master,account:account?.account??null,market:policy.market,
        bookPrice:book!.price,bookSource:'/book',tick,lot,minimumQuote,maximumQuote,minimumPrice,maximumPrice,maxLeverage:String(market.max_leverage),restrictions,
        maker:fee('maker','entry'),profit:fee('maker','profit'),taker:fee('taker','entry'),masterWithdrawable:withdrawable,sol:sol!.balance,
        availableSlots:capacity.restingCapacity.provenFloor-parsed.length,subaccountCount:addresses.length,reusableAccountAvailable:(rawReusable as string[]).some(x=>addresses.includes(x)),
        ...quota,transportReady:true,inventoryComplete:true,recycler,margin:margin!,agentGeneration:{wallet,masterAccount:master,umkVersion:security.umkVersion}},
        risk:{account:target,symbol,positionSize,liquidationPrice,observedAt:Math.min(started,positionAt),source:'pacifica:/positions.liquidation_price+/account.positions_count'}};
    }catch(error){signal.throwIfAborted();if(error instanceof GridLaunchAuthorityUnavailable||error instanceof GridLaunchTransientError)throw error;return deny('Grid launch authority unavailable.');}
    finally{security.cleanup();}
  }
}

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

/** UMK ownership transfers only on success; lifecycle cleans it after the resume checks. */
export function gridProductionResume(storage:Pick<GridMonitorStorage,'snapshot'>,authority:GridLaunchAuthority,security=durableGridUmk):GridLifecycleDeps['resume']{
  return async(claim,signal)=>{
    let key:Awaited<ReturnType<typeof security>>=null;
    try{
      const snapshot=await storage.snapshot(claim),bot=snapshot.bot,policy=retainedGridPolicy(bot,snapshot.levels);
      if(bot.id!==claim.id||bot.account!==claim.account||bot.master_account!==claim.masterAccount||!bot.policy_hmac) return null;
      key=await security(bot.wallet_address);if(!key)return null;
      if(!verifyGridPolicyHmac(policy,key.umk,bot.policy_hmac).ok)return null;
      const account:GridAccount={botId:claim.id,wallet:bot.wallet_address,masterAccount:claim.masterAccount,account:claim.account,leaseToken:claim.leaseToken,reused:bot.reused===true};
      const {facts,risk}=await authority.collect(bot.wallet_address,policy,account,key.umk,signal);
      if(facts.margin?.leverage!==String(policy.leverage))return null;
      const latest=await storage.snapshot(claim);
      if(latest.bot.policy_hmac!==bot.policy_hmac||latest.bot.wallet_address!==bot.wallet_address||latest.bot.account!==claim.account||latest.bot.master_account!==claim.masterAccount
        ||latest.bot.status!==bot.status||canonicalGridPolicy(retainedGridPolicy(latest.bot,latest.levels))!==canonicalGridPolicy(policy))return null;
      fresh(facts.observedAt,Date.now());signal.throwIfAborted();const retained=key;key=null;
      return {policy,policyHmac:bot.policy_hmac,umk:retained.umk,facts,risk,cleanup:retained.cleanup};
    }catch(error){signal.throwIfAborted();if(error instanceof GridLaunchTransientError)throw error;return null;}finally{key?.cleanup();}
  };
}

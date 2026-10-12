import Decimal from 'decimal.js';
import {PacificaSigner,buildSigningMessage} from '../protocol/pacifica/pacifica-signer';
import {PacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import {GridLaunchStorage,GridLaunchTransientError,requestDigest,type ExactGridRequest,type GridClaim,type DurableGridOperation} from './launch-storage';
import type {GridVenueOrder} from './order-identity';

const endpoints={create:['/account/subaccount/create','subaccount_confirm'],fund:['/account/subaccount/transfer','transfer_funds'],
  leverage:['/account/leverage','update_leverage'],seed:['/orders/create_market','create_market_order'],
  limit:['/orders/create','create_order'],cancel:['/orders/cancel','cancel_order'],close:['/orders/create_market','create_market_order'],sweep:['/account/subaccount/transfer','transfer_funds']} as const;
export function validExactRequest(r:ExactGridRequest):boolean{
  const expected=endpoints[r.kind];
  if(!expected || r.path!==expected[0] || r.operationType!==expected[1] || !r.account || !r.masterAccount || r.account===r.masterAccount)return false;
  const d=r.data;
  if(['signature','timestamp','expiry_window','account','agent_wallet','type'].some(k=>k in d))return false;
  if(r.kind==='limit')return d.tif==='ALO' && typeof d.reduce_only==='boolean' && typeof d.client_order_id==='string' && !!d.symbol;
  if(r.kind==='seed')return d.slippage_percent==='0.5' && d.reduce_only===false && typeof d.client_order_id==='string' && !!d.symbol;
  if(r.kind==='close')return d.slippage_percent==='0.5'&&d.reduce_only===true&&typeof d.client_order_id==='string'&&!!d.symbol&&['bid','ask'].includes(String(d.side))&&typeof d.amount==='string'&&new Decimal(d.amount).gt(0);
  if(r.kind==='sweep')return d.to_account===r.masterAccount&&typeof d.amount==='string'&&new Decimal(d.amount).gt(0)&&r.authority.settlementComplete===true;
  if(r.kind==='fund')return d.to_account===r.account && typeof d.amount==='string' && new Decimal(d.amount).gt(0);
  if(r.kind==='create')return Object.keys(d).length===0;
  return true;
}
/** Only this Grid-specific boundary signs and posts. No enrollment, leverage or legacy adapter side effects. */
export class GridPacificaSender {
  constructor(private transport:PacificaTransportAuthority,private fetcher:typeof fetch=fetch){}
  async send(r:ExactGridRequest,subaccountSecret:Buffer,masterSecret?:Buffer):Promise<{rateLimited:boolean;terminalTransferDigest?:string}>{
    if(!validExactRequest(r) || this.transport.keyStatus!=='present')throw Error('Grid transport authority unavailable');
    const sub=new PacificaSigner(subaccountSecret);
    if(sub.getPublicKey()!==r.account)throw Error('Grid signing account mismatch');
    let body:Record<string,unknown>;
    if(r.kind==='create' || r.kind==='fund'){
      if(!masterSecret)throw Error('Grid master authority unavailable');const master=new PacificaSigner(masterSecret);
      if(master.getPublicKey()!==r.masterAccount)throw Error('Grid master identity mismatch');
      if(r.kind==='create'){
        const subSignature=sub.signMessage(buildSigningMessage('subaccount_initiate',{account:r.masterAccount},r.timestamp,r.expiryMs));
        const mainSignature=master.signMessage(buildSigningMessage('subaccount_confirm',{signature:subSignature},r.timestamp,r.expiryMs));
        body={main_account:r.masterAccount,subaccount:r.account,main_signature:mainSignature,sub_signature:subSignature,timestamp:r.timestamp,expiry_window:r.expiryMs};
      }else body={...r.data,account:r.masterAccount,agent_wallet:null,signature:master.signMessage(buildSigningMessage(r.operationType,r.data,r.timestamp,r.expiryMs)),timestamp:r.timestamp,expiry_window:r.expiryMs};
    }else body={...r.data,account:r.account,agent_wallet:null,signature:sub.signMessage(buildSigningMessage(r.operationType,r.data,r.timestamp,r.expiryMs)),timestamp:r.timestamp,expiry_window:r.expiryMs};
    const url='https://api.pacifica.fi/api/v1'+r.path;
    // One bounded request only. Header/HTTP success alone never settles money or an order.
    const response=this.transport.response(await this.fetcher(url,this.transport.restInit(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)})));
    if((r.kind==='fund'||r.kind==='sweep')&&response.status===200){
      const result=await response.json() as {success?:unknown;error?:unknown;data?:{success?:unknown;error?:unknown}};
      // Pacifica documents this exact nested envelope as "Transfer completed successfully".
      // The digest binds this in-flight result to the retained signed request, never a later balance guess.
      if(result?.success===true&&result.error===null&&result.data?.success===true&&result.data.error===null)
        return {rateLimited:false,terminalTransferDigest:requestDigest(r)};
    }else await response.body?.cancel().catch(()=>undefined);
    return {rateLimited:response.status===429};
  }
}
export type GridReconciliation={state:'unknown'}|{state:'confirmed'|'rejected'|'expected_alo_cross';requestDigest:string;releaseSlot:boolean;orderId?:string;orderStatus?:GridVenueOrder['status']};
export interface GridExecutionDeps {
  storage:Pick<GridLaunchStorage,'read'|'prepare'|'submit'|'settle'> & Partial<Pick<GridLaunchStorage,'expirePrepared'>>;
  now?:()=>number;
  preflight:(r:ExactGridRequest)=>Promise<boolean>;
  send:(r:ExactGridRequest)=>Promise<{rateLimited:boolean;terminalTransferDigest?:string}>;
  reconcile:(op:DurableGridOperation)=>Promise<GridReconciliation>;
}
export class GridExecution {
  constructor(private deps:GridExecutionDeps){}
  async run(key:string,request:ExactGridRequest,claim:GridClaim,leaseToken:string):Promise<'confirmed'|'pending'|'failed'|'not_sent'>{
    // A restart reads the retained payload; it cannot refresh identity/timestamp and resend.
    let op=await this.deps.storage.read(request.botId,key);
    if(op){
      if(op.exact_request_digest!==requestDigest(request))throw Error('Grid retry payload changed');
      if(op.state==='confirmed')return 'confirmed';
      if(op.state==='failed')return op.failure_classification==='expected_rejection'?'pending':'failed';
      if(op.state==='submitted'||op.state==='unconfirmed')return this.reconcile(op);
      if(op.state==='prepared'&&this.deps.storage.expirePrepared&&request.timestamp+request.expiryMs<=(this.deps.now?.()??Date.now())){
        return await this.deps.storage.expirePrepared(op,leaseToken)?'failed':'not_sent';
      }
    }
    if(!validExactRequest(request) || !await this.deps.preflight(request))return 'not_sent';
    try{op??=await this.deps.storage.prepare(key,request,claim,leaseToken);}
    catch(error){if(error instanceof GridLaunchTransientError)return 'pending';throw error;}
    if(op.state!=='prepared')return this.reconcile(op);
    // Re-read current authority after the transaction and immediately before acquiring send permission.
    if(!await this.deps.preflight(op.exact_request))return 'not_sent';
    if(!await this.deps.storage.submit(op,leaseToken))return 'not_sent';
    let rateLimited=false,terminalTransferDigest:string|undefined;
    try {const sent=await this.deps.send(structuredClone(op.exact_request));rateLimited=sent.rateLimited;terminalTransferDigest=sent.terminalTransferDigest;}
    catch {/* Includes crash/timeout after POST. Only exact reconciliation may resolve it. */}
    if((request.kind==='fund'||request.kind==='sweep')&&terminalTransferDigest===op.exact_request_digest){
      await this.deps.storage.settle(op,{state:'confirmed',reason:null,releaseSlot:true});return 'confirmed';
    }
    await this.deps.storage.settle(op,{state:'unconfirmed',reason:rateLimited?'quota':'unknown',releaseSlot:false,rateLimited});
    return this.reconcile({...op,state:'unconfirmed'});
  }
  private async reconcile(op:DurableGridOperation):Promise<'confirmed'|'pending'|'failed'>{
    let result:GridReconciliation;try{result=await this.deps.reconcile(op);}catch{return 'pending';}
    if(result.state==='unknown' || result.requestDigest!==op.exact_request_digest)return 'pending';
    await this.deps.storage.settle(op,{state:result.state==='confirmed'?'confirmed':'failed',
      reason:result.state==='confirmed'?null:result.state==='expected_alo_cross'?'expected_rejection':'venue_rejection',releaseSlot:result.releaseSlot,orderId:result.orderId,orderStatus:result.orderStatus});
    return result.state==='confirmed'?'confirmed':result.state==='expected_alo_cross'?'pending':'failed';
  }
}
/** ALO crossing is an exact, documented history result, never inferred from an HTTP error string. */
export function reconcileGridLimit(r:ExactGridRequest,rows:GridVenueOrder[]|null):GridReconciliation{
  if(r.kind!=='limit'||rows===null)return {state:'unknown'};
  const d=r.data,matches=rows.filter(o=>o.clientOrderId===d.client_order_id);
  if(matches.length!==1)return {state:'unknown'};const o=matches[0];
  if(o.symbol!==d.symbol || (o.side==='long'?'bid':'ask')!==d.side || o.reduceOnly!==d.reduce_only
    || o.orderType!=='limit' || !new Decimal(o.price).eq(String(d.price)) || !new Decimal(o.amount).eq(String(d.amount))
    || o.createdAt<r.timestamp || o.createdAt>r.timestamp+r.expiryMs)return {state:'unknown'};
  const exact={requestDigest:requestDigest(r),releaseSlot:['filled','cancelled','rejected'].includes(o.status),orderId:o.orderId,orderStatus:o.status};
  if(o.status==='rejected'&&o.reason==='post_only_rejected'&&new Decimal(o.filledAmount).eq(0))return {...exact,state:'expected_alo_cross'};
  if(o.status==='rejected'&&new Decimal(o.filledAmount).eq(0))return {...exact,state:'rejected'};
  if(o.status==='cancelled'||o.status==='open'||o.status==='partially_filled'||o.status==='filled'&&new Decimal(o.filledAmount).eq(o.amount))return {...exact,state:'confirmed'};
  return {state:'unknown'};
}

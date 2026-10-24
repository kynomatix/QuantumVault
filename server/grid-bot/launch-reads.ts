import type {PacificaTransportAuthority} from '../protocol/pacifica/pacifica-transport';
import type {GridLaunchStorage} from './launch-storage-core';
import {GridLaunchTransientError} from './launch-storage-core';
import Decimal from 'decimal.js';
import {PacificaSigner,OPERATION_TYPES} from '../protocol/pacifica/pacifica-signer';

/** All launch observations/reconciliation reads use the Unit 2 transport and the same durable master budget. */
export class GridLaunchReads {
  private measured:{credits:string;remaining:string;at:number}|null=null;
  constructor(private transport:PacificaTransportAuthority,private ledger:Pick<GridLaunchStorage,'claimRead'|'recordRateLimit'> & Partial<Pick<GridLaunchStorage,'availableCredits'>>,private share:string,private fetcher:typeof fetch=fetch){}
  ready(){return this.transport.keyStatus==='present';}
  private ceiling(){
    const now=Date.now(),q=this.transport.quota.snapshot();
    if(this.measured&&now-this.measured.at>=60_000)this.measured=null;
    if(q.availability==='observed'){
      // Remaining credits also lower the shared ceiling; the fixed half-share and
      // durable claims then debit reads/execution from that bound, not a reusable balance.
      const remaining=new Decimal(q.remainingDeciCredits!).div(10).floor().toFixed(),credits=Decimal.min(300,new Decimal(q.quotaDeciCredits!).div(10),remaining).toFixed();
      this.measured={credits:Decimal.min(this.measured?.credits??'300',credits).toFixed(),remaining:Decimal.min(this.measured?.remaining??remaining,remaining).toFixed(),at:this.measured?.at??now};
    }
    return this.measured;
  }
  /** ASSUMED 300-credit policy. Measured observations may only reduce it. */
  async quota(masterAccount:string){
    if(!this.ready()||!new Decimal(this.share).eq('0.5')||!this.ledger.availableCredits)throw Error('Grid quota authority unavailable');
    const q=this.ceiling(),observed=q?.credits??'300';
    let available=new Decimal(await this.ledger.availableCredits(masterAccount,observed));
    if(q)available=Decimal.min(available,q.remaining);
    return {observedCredits:observed,availableGridCredits:Decimal.max(0,available).toFixed()};
  }
  async json(masterAccount:string,path:string,params:Record<string,string>,signal?:AbortSignal):Promise<unknown>{
    if(this.transport.keyStatus!=='present'||!/^\/[a-z_]+(?:\/[a-z_]+)*$/.test(path))throw Error('Grid read authority unavailable');
    const url=new URL('https://api.pacifica.fi/api/v1'+path);for(const [k,v] of Object.entries(params))url.searchParams.set(k,v);
    return this.request(masterAccount,url,{method:'GET'},signal);
  }
  /** The only signed read: never expose its signature or secret in retained facts. */
  async subaccounts(masterAccount:string,secret:Uint8Array,signal?:AbortSignal):Promise<unknown>{
    const signer=new PacificaSigner(secret);
    if(signer.getPublicKey()!==masterAccount)throw Error('Grid inventory signer identity conflict');
    const signed=signer.sign(OPERATION_TYPES.LIST_SUBACCOUNTS,{},5000);
    return this.request(masterAccount,new URL('https://api.pacifica.fi/api/v1/account/subaccount/list'),
      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({account:masterAccount,signature:signed.signature,timestamp:signed.timestamp,expiry_window:signed.expiryWindow})},signal);
  }
  private async request(masterAccount:string,url:URL,init:RequestInit,signal?:AbortSignal):Promise<unknown>{
    if(!masterAccount||!this.ready())throw Error('Grid read authority unavailable');
    signal?.throwIfAborted();
    const observed=this.ceiling()?.credits??'300';
    await this.ledger.claimRead(masterAccount,'1',observed,this.share);
    signal?.throwIfAborted();
    let response:Response;
    try{response=this.transport.response(await this.fetcher(url,this.transport.restInit(url.toString(),{...init,signal:signal?AbortSignal.any([signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)})));}
    catch{signal?.throwIfAborted();throw Error('Grid observation transport unavailable');}
    this.ceiling();
    if(response.status===429){
      await this.ledger.recordRateLimit(masterAccount);
      await response.body?.cancel().catch(()=>undefined);
      throw new GridLaunchTransientError('Durable Grid rate-limit backoff');
    }
    if(!response.ok){await response.body?.cancel().catch(()=>undefined);throw Error('Grid observation unavailable');}
    return response.json();
  }
}

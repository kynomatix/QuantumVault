import Decimal from 'decimal.js';
import type {GridAccount,GridEmptyProof} from './custody';
import type {LaunchEvidence} from './launch-reconciliation';
import type {ExactGridRequest} from './launch-storage';

const object=(v:unknown):Record<string,unknown>|null=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
function data(raw:unknown,account:string){
  const r=object(raw),d=object(r?.data);
  return r?.success===true&&r.error===null&&r.partial!==true&&r.complete!==false&&r.has_more!==true&&r.next_cursor==null
    &&(r.account===undefined||r.account===account)&&d&&d.partial!==true&&d.complete!==false&&d.has_more!==true&&d.next_cursor==null
    &&(d.account===undefined||d.account===account)&&d.subaccount_id==null?d:null;
}
export function gridSignedInventory(raw:unknown,master:string):string[]|null{
  const d=data(raw,master);if(!d||!Array.isArray(d.subaccounts))return null;
  const accounts:string[]=[];
  for(const value of d.subaccounts){const address=object(value)?.address;
    if(typeof address!=='string'||!address||address.trim()!==address||address===master||accounts.includes(address))return null;
    accounts.push(address);
  }
  return accounts.length<=10?accounts:null;
}
/** Absence comes only from signed complete inventory. Zero comes only from explicit full-account fields. */
export function gridProvisionEmpty(a:GridAccount,inventory:unknown,raw:unknown,started:number,now:number):GridEmptyProof{
  const proof:GridEmptyProof={account:a.account,masterAccount:a.masterAccount,state:'unknown',observedAt:started,expiresAt:started+5000};
  if(!Number.isSafeInteger(started)||started>now||now-started>=5000)return proof;
  const accounts=gridSignedInventory(inventory,a.masterAccount);if(!accounts)return proof;
  if(!accounts.includes(a.account))return {...proof,state:a.reused?'unknown':'absent'};
  const d=data(raw,a.account);if(!d||!Number.isSafeInteger(d.updated_at)||(d.updated_at as number)>now||now-(d.updated_at as number)>=5000)return proof;
  const zero=(v:unknown)=>typeof v==='string'&&/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v)&&new Decimal(v).isZero();
  const fields=['balance','available_to_withdraw','account_equity','available_to_spend','pending_balance','pending_interest','spot_collateral','spot_market_value','total_margin_used'];
  if(!fields.every(k=>zero(d[k]))||!['positions_count','orders_count','stop_orders_count'].every(k=>d[k]===0)
    ||!Array.isArray(d.spot_balances)||d.spot_balances.length)return proof;
  return {...proof,state:'empty',observedAt:Math.min(started,d.updated_at as number),expiresAt:Math.min(started,d.updated_at as number)+5000};
}
export function gridProvisionRecoveryEvidence(r:ExactGridRequest,raw:unknown,started:number,now:number):LaunchEvidence|null{
  if(!Number.isSafeInteger(started)||started<r.timestamp||started>now||now-started>=5000)return null;
  if(r.kind==='create'){
    const accounts=gridSignedInventory(raw,r.masterAccount);
    return accounts?{kind:'create',account:r.account,masterAccount:r.masterAccount,complete:true,accounts,observedAt:started}:null;
  }
  if(r.kind!=='leverage')return null;
  const d=data(raw,r.account);if(!d||!Array.isArray(d.margin_settings))return null;
  const matching=d.margin_settings.map(object).filter(row=>row?.symbol===r.data.symbol);
  const setting=matching.length===1?matching[0]:null;
  return setting&&setting.isolated===false&&Number.isSafeInteger(setting.leverage)&&(setting.leverage as number)>0
    ?{kind:'leverage',account:r.account,symbol:String(r.data.symbol),leverage:setting.leverage as number,observedAt:started}:null;
}

import Decimal from 'decimal.js';
import type {ExactGridRequest} from './launch-storage';
import type {GridLaunchReads} from './launch-reads';
const D=Decimal.clone({precision:200});
export const GRID_MARGIN_BUFFER='1.02';
export const GRID_MARGIN_MAX_AGE_MS=5000;
export class GridMarginDenied extends Error {}
export interface GridMarginReading {account:string;symbol:string;available:string;leverage:string;feeRate:string;observedAt:number;accountUpdatedAt:number}
export const gridAddsExposure=(r:ExactGridRequest)=>r.kind==='seed'||r.kind==='limit'&&r.data.reduce_only===false;
function decimal(v:unknown){if(typeof v!=='string'||v.length>80||! /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v))throw Error('Unknown margin decimal');return new D(v);}
export function gridRequiredMargin(r:ExactGridRequest,reading:GridMarginReading):string{
  if(!gridAddsExposure(r))return '0';
  const price=decimal(r.kind==='seed'?r.authority.seedWorstPrice:r.data.price),size=decimal(r.data.amount),leverage=decimal(reading.leverage),fee=decimal(reading.feeRate);
  if(!price.gt(0)||!size.gt(0)||!leverage.gte(1)||fee.gte(1))throw Error('Unknown incremental margin');
  const notional=price.mul(size);return notional.div(leverage).plus(notional.mul(fee)).mul(GRID_MARGIN_BUFFER).toFixed();
}
export function gridMarginAllowed(r:ExactGridRequest,reading:GridMarginReading|null,committed:string,now:number,expectedLeverage?:unknown):boolean{
  if(!gridAddsExposure(r))return true;
  try{return !!reading&&r.account!==r.masterAccount&&reading.account===r.account&&reading.symbol===r.data.symbol
    &&Number.isSafeInteger(now)&&[reading.observedAt,reading.accountUpdatedAt].every(t=>Number.isSafeInteger(t)&&t<=now&&now-t<=GRID_MARGIN_MAX_AGE_MS)
    &&(expectedLeverage===undefined||decimal(String(expectedLeverage)).eq(reading.leverage))
    &&decimal(reading.available).minus(decimal(committed)).gte(gridRequiredMargin(r,reading));}catch{return false;}
}
function data(v:unknown):any{const r=v as any;if(r?.success!==true||!r.data||typeof r.data!=='object')throw Error('Margin observation unavailable');return r.data;}
/** Pacifica documents available_to_spend as equity available for margin use:
 * https://docs.pacifica.fi/api-documentation/api/rest-api/account/get-account-info
 * Existing precedent: pacifica-adapter.ts getAccountInfo maps it to availableMargin,
 * and ai-trader/executor.ts sizes real trades with that value. This bot reads its
 * own isolated account afresh; no main-account collateral or cached alias fallback.
 * Grid pays venue fees only; builder approvals are not margin authority. */
export async function readGridMargin(reads:Pick<GridLaunchReads,'json'>,r:ExactGridRequest):Promise<GridMarginReading|null>{
  if(!gridAddsExposure(r)||'builder_code' in r.data)return null;
  try{
    const started=Date.now(),params={account:r.account};
    const [rawAccount,rawSettings]=await Promise.all([
      reads.json(r.masterAccount,'/account',params),reads.json(r.masterAccount,'/account/settings',params)]);
    const a=data(rawAccount),s=data(rawSettings);
    if(a.account!==undefined&&a.account!==r.account||s.account!==undefined&&s.account!==r.account||!Array.isArray(s.margin_settings))return null;
    const settings=s.margin_settings.filter((x:any)=>x.symbol===r.data.symbol);
    if(settings.length!==1||!Number.isSafeInteger(settings[0].leverage)||settings[0].leverage<1)return null;
    // Use the larger execution fee, even for an ALO entry; rebates never fund entry risk.
    const maker=typeof a.maker_fee==='string'&&a.maker_fee.startsWith('-')?(decimal(a.maker_fee.slice(1)),new D(0)):decimal(a.maker_fee);
    const fee=D.max(maker,decimal(a.taker_fee));
    if(fee.gte(1))return null;
    decimal(a.available_to_spend);
    return {account:r.account,symbol:String(r.data.symbol),available:a.available_to_spend,leverage:String(settings[0].leverage),feeRate:fee.toFixed(),observedAt:started,accountUpdatedAt:a.updated_at};
  }catch{return null;}
}

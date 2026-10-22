import {describe,it,expect,vi} from 'vitest';
import {gridRequiredMargin,gridMarginAllowed,readGridMargin} from '../../server/grid-bot/margin';
import type {ExactGridRequest} from '../../server/grid-bot/launch-storage';
const r:ExactGridRequest={kind:'limit',botId:'EXAMPLE',account:'EXAMPLE_SUB',masterAccount:'EXAMPLE_MASTER',path:'/orders/create',operationType:'create_order',timestamp:1000,expiryMs:5000,data:{symbol:'BTC',price:'100',amount:'2',reduce_only:false},authority:{}};
const reading=()=>({account:r.account,symbol:'BTC',available:'102.204',leverage:'2',feeRate:'0.001',observedAt:1000,accountUpdatedAt:1000});
describe('incremental exact-subaccount margin',()=>{
  it('rejects legacy builder-bearing entries before any reads',async()=>{
    const json=vi.fn();expect(await readGridMargin({json},{...r,data:{...r.data,builder_code:'CARRY'}})).toBeNull();expect(json).not.toHaveBeenCalled();
  });
  it('allows equality including current leverage, fees and the two percent buffer',()=>{expect(gridRequiredMargin(r,reading())).toBe('102.204');expect(gridMarginAllowed(r,reading(),'0',1000,2)).toBe(true);expect(gridMarginAllowed(r,{...reading(),available:'102.203999999999999999'},'0',1000,2)).toBe(false);});
  it('deducts outstanding commitments and uses the seed worst price',()=>{expect(gridMarginAllowed(r,{...reading(),available:'202.204'},'100',1000,2)).toBe(true);expect(gridMarginAllowed(r,reading(),'0.000000000000000001',1000,2)).toBe(false);expect(gridRequiredMargin({...r,kind:'seed',authority:{seedWorstPrice:'110'}},reading())).toBe('112.4244');});
  it.each([null,{...reading(),account:'EXAMPLE_MASTER'},{...reading(),symbol:'ETH'},{...reading(),observedAt:999},{...reading(),accountUpdatedAt:999},{...reading(),available:100 as any},{...reading(),leverage:'0'},{...reading(),feeRate:'NaN'}])('denies unknown, stale and mismatched authority',v=>expect(gridMarginAllowed(r,v,'0',6000,2)).toBe(false));
  it('rejects leverage drift but keeps reduce-only and close recovery available without margin',()=>{expect(gridMarginAllowed(r,reading(),'0',1000,3)).toBe(false);for(const x of [{...r,data:{...r.data,reduce_only:true}},{...r,kind:'close' as const}])expect(gridMarginAllowed(x,null,'0',9999)).toBe(true);});
  it('reads only the bot account and uses venue fees without approval reads',async()=>{
    const json=vi.fn(async(_m:string,path:string,params:any)=>{expect(params.account).toBe(r.account);expect(['/account','/account/settings']).toContain(path);return {success:true,data:path==='/account'?{available_to_spend:'1000',maker_fee:'-0.0001',taker_fee:'0.001',updated_at:Date.now()}:path==='/account/settings'?{margin_settings:[{symbol:'BTC',leverage:2}]}:[{builder_code:'CARRY',max_fee_rate:'0.002'}]};});
    const v=await readGridMargin({json},r);expect(v?.feeRate).toBe('0.001');expect(v?.available).toBe('1000');expect(json).toHaveBeenCalledTimes(2);
  });
  it('has no settings/default leverage or malformed account fallback',async()=>{for(const data of [{},{margin_settings:[]},{margin_settings:[{symbol:'BTC',leverage:2},{symbol:'BTC',leverage:2}]}])expect(await readGridMargin({json:async()=>({success:true,data})},r)).toBeNull();});
});

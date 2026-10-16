import { expect, it, vi } from 'vitest';
import { createPhoenixNativeAccountingIO } from '../../server/protocol/phoenix/accounting-production';
import { PhoenixAccountingService } from '../../server/protocol/phoenix/accounting-service';
import { target, now, MemoryAccountingStore } from '../helpers/phoenix-accounting';
import { authority } from '../helpers/phoenix-orders';
import { PHOENIX_MARKETS } from '../../server/protocol/phoenix/markets';
function fixture() {
  const reader={read:vi.fn(async()=>({authority:authority(),trader:{positions:[{assetId:PHOENIX_MARKETS.find(m=>m.market==='SOL')!.assetId,base:-4n}]}}))};
  const request=vi.fn(async()=>new Response('{}'));
  const io=createPhoenixNativeAccountingIO(reader as any,async()=> 'SOL',request as any);
  return {reader,request,io};
}
it('reads native signed position lots while equity, claims, debt and funding remain unknown',async()=>{
  const f=fixture(),s=await f.io.snapshot(target);expect(s.positions.SOL).toBe('-4');expect(s.externalDebtMicros).toBeNull();expect(s.walletUsdcMicros).toBeNull();expect(s.venueEquityMicros).toBeNull();expect(s.inTransit[0].valueMicros).toBeNull();
  expect(f.reader.read).toHaveBeenCalledWith(target.identity,'SOL','sell','0',false,false);
});
it('uses all three pinned native routes but never calls empty pages proof of complete history',async()=>{
  const f=fixture();await expect(f.io.history(target,'100',null)).rejects.toThrow('COMPLETENESS_UNPROVEN');
  const urls=f.request.mock.calls.map(c=>String((c as any[])[0]));expect(urls).toHaveLength(3);
  expect(urls.some(u=>u.includes('/trades_v2?limit=100&trader_pda_index=0'))).toBe(true);
  expect(urls.some(u=>u.includes('/funding-history?limit=100&traderPdaIndex=0'))).toBe(true);
  expect(urls.some(u=>u.includes('/collateral-history?limit=100'))).toBe(true);
  for(const call of f.request.mock.calls as any[])expect(call[1]).toMatchObject({credentials:'omit',redirect:'error'});
});
it('invalidates cached accounting instead of fabricating zero totals after missing history or watermarks',async()=>{
  const f=fixture(),store=new MemoryAccountingStore();store.state.status='complete';
  const result=await new PhoenixAccountingService(store,f.io,()=>now).reconcile(target);
  expect(result).toMatchObject({synced:false,discrepancy:true,equity:null,epochs:null});expect(store.state.status).toBe('unknown');
  f.request.mockRejectedValueOnce(new Error('EXAMPLE-network'));
  await expect(f.io.history(target,'100',null)).rejects.toThrow('HISTORY_UNAVAILABLE');
});

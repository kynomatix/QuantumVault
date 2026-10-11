import { describe, expect, it, vi } from 'vitest';
import { PhoenixFundingService } from '../../server/protocol/phoenix/funding-service';
import { validateFundingIntent, type FundingIntent } from '../../server/protocol/phoenix/funding-contract';
import { PhoenixParkingExecutor } from '../../server/protocol/phoenix/parking-executor';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
import { carryFixture, CarryMemory } from '../helpers/phoenix-carry';
import { now, identity } from '../helpers/phoenix-orders';

vi.mock('../../server/protocol/phoenix/funding-builder',()=>({prepareFundingTransaction:()=>({}),
  signFundingTransaction:()=>({signature:'EXAMPLE-signature',transaction:'EXAMPLE-wire',lastValidBlockHeight:'100',
    blockhash:'EXAMPLE-blockhash',transactionHash:'EXAMPLE-transaction-hash'})}));
function fixture() {
  const intent:FundingIntent={botId:'EXAMPLE-bot',ownerWallet:'EXAMPLE-owner',requestKey:'EXAMPLE-withdraw',identity,kind:'withdraw',
    mint:PHOENIX_PUBLIC_ADDRESSES.usdcMint,amountBaseUnits:'100',feeBaseUnits:'0',destination:identity.authorityWalletAddress,
    parkingIntentId:'EXAMPLE-parent',carryIntentId:'EXAMPLE-parent',funding:{leg:'withdraw',sourceWallet:identity.authorityWalletAddress,
      grossBaseUnits:'100',minimumBaseUnits:'1',maxGasLamports:'10000',quoteSource:'EXAMPLE-source',quoteReference:'EXAMPLE-reference',quoteExpiresAt:Date.now()+60000}};
  let record:any={id:'EXAMPLE-child',bot_id:intent.botId,intent,revision:0,state:'prepared'};
  const operations:any={prepare:async()=>({operation:record}),read:async()=>({operation:record,attempt:record.state==='prepared'?undefined:{signature:'EXAMPLE-signature'}}),
    annotatePrepared:async()=>record,recordAttempt:vi.fn(async()=>{record={...record,state:'submission_pending'};return{created:true};}),
    observe:async()=>record,fundingHistory:async()=>[]};
  const io:any={lifetime:async()=>({blockhash:'EXAMPLE-blockhash',lastValidBlockHeight:100}),blockHeight:async()=>1,
    quote:async(i:FundingIntent)=>({minimumBaseUnits:'1',feeBaseUnits:'0',grossBaseUnits:'100',netBaseUnits:'100',gasLamports:'1',rentLamports:'0',
      availableLamports:'100',availableBaseUnits:'100',source:i.funding.quoteSource,reference:i.funding.quoteReference,expiresAt:i.funding.quoteExpiresAt}),
    withSigner:vi.fn(async(_i,sign)=>sign(new Uint8Array(64))),submit:vi.fn(async()=>'EXAMPLE-signature'),signature:async()=>'unknown'};
  return{intent,operations,io,service:()=>new PhoenixFundingService(operations,io,{} as any,()=>true)};
}
describe('U13 pre-sign and pre-send boundaries',()=>{
  it('requires the carry flag to be tied to a withdrawal/unwrap parking parent',()=>{
    const x=fixture();expect(()=>validateFundingIntent({...x.intent,parkingIntentId:undefined})).toThrow('carry');
    expect(()=>validateFundingIntent({...x.intent,funding:{...x.intent.funding,leg:'deposit'}})).toThrow('carry');
  });
  it('never signs carry funding without its fresh authorizer',async()=>{
    const x=fixture();await expect(x.service().create(x.intent)).rejects.toThrow('authorization unavailable');
    expect(x.io.withSigner).not.toHaveBeenCalled();expect(x.io.submit).not.toHaveBeenCalled();
  });
  it.each([2,3])('stops at authorization %s if queue/rates/consent changed during asynchronous work',async failAt=>{
    const x=fixture();let checks=0;x.io.authorizeCarrySettlement=async()=>{if(++checks===failAt)throw new Error('EXAMPLE-queue-changed');};
    await expect(x.service().create(x.intent)).rejects.toThrow('queue-changed');
    expect(x.io.withSigner).toHaveBeenCalledTimes(1);expect(x.io.submit).not.toHaveBeenCalled();
  });
  it('keeps ordinary U04 funding behavior when no carry parent is present',async()=>{
    const x=fixture();delete x.intent.carryIntentId;delete x.intent.parkingIntentId;
    await x.service().create(x.intent);expect(x.io.submit).toHaveBeenCalledTimes(1);
  });
  it('vault prepare failure and a late opt-out cannot send or silently retry a park',async()=>{
    const {i,f}=carryFixture(),store=new CarryMemory();let r=await store.prepare(i);
    const leg={key:`${r.id}:0`,kind:'park' as const,amount:'40000000',asset:'EXAMPLE-yield'};r=await store.claim(r,leg);
    const vault={prepare:vi.fn().mockRejectedValue(new Error('EXAMPLE-failed-park')),submit:vi.fn(),receipt:vi.fn()},write=vi.fn();
    const authorize=vi.fn(async()=>{});
    const executor=new PhoenixParkingExecutor(async()=>f.parking,{recordVaultAttempt:write},{create:vi.fn(),resume:vi.fn()},
      {fundingHistory:async()=>[]},vi.fn(),vault,()=>true,()=>now,authorize);
    await expect(executor.submit(r,leg)).rejects.toThrow('failed-park');expect(vault.submit).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();
    vault.prepare.mockResolvedValue({transaction:'EXAMPLE',signature:'EXAMPLE',lastValidBlockHeight:'100'});
    authorize.mockImplementation(async()=>{throw new Error('EXAMPLE-optout');});
    await expect(executor.submit(r,leg)).rejects.toThrow('optout');expect(vault.submit).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { identity } from '../helpers/phoenix-orders';
import { PhoenixFundingService } from '../../server/protocol/phoenix/funding-service';
import { PhoenixDebtFunding, lenderWithdrawalMeasurement } from '../../server/protocol/phoenix/borrow-funding';
import { validateFundingIntent, type FundingIntent } from '../../server/protocol/phoenix/funding-contract';
import { PHOENIX_PUBLIC_ADDRESSES } from '../../server/protocol/phoenix/sdk-boundary';
vi.mock('../../server/protocol/phoenix/funding-builder',()=>({
  prepareFundingTransaction:()=>({}),signFundingTransaction:()=>({signature:'EXAMPLE-signature',transaction:'EXAMPLE-wire',lastValidBlockHeight:'100',blockhash:'EXAMPLE-blockhash',transactionHash:'EXAMPLE-transaction-hash'}),
}));
function fixture() {
  const intent: FundingIntent={botId:'EXAMPLE-bot',ownerWallet:'EXAMPLE-owner',requestKey:'EXAMPLE-deposit',identity,kind:'deposit',
    mint:PHOENIX_PUBLIC_ADDRESSES.usdcMint,amountBaseUnits:'100',feeBaseUnits:'0',destination:identity.traderAccountAddress,
    borrowIntentId:'EXAMPLE-parent',borrowReserveRaw:'110',funding:{leg:'deposit',sourceWallet:identity.authorityWalletAddress,
      grossBaseUnits:'100',minimumBaseUnits:'1',maxGasLamports:'10000',quoteSource:'EXAMPLE-source',quoteReference:'EXAMPLE-reference',quoteExpiresAt:Date.now()+60000}};
  let record:any={id:'EXAMPLE-child',bot_id:intent.botId,intent,revision:0,state:'prepared'};
  const operations:any={prepare:async()=>({operation:record}),read:async()=>({operation:record,attempt:record.state === 'prepared' ? undefined : {signature:'EXAMPLE-signature'}}),
    annotatePrepared:async()=>record,recordAttempt:async()=>{record={...record,state:'submission_pending'};return {created:true};},
    observe:async()=>record,fundingHistory:async()=>[]};
  const io:any={lifetime:async()=>({blockhash:'EXAMPLE-blockhash',lastValidBlockHeight:100}),blockHeight:async()=>1,
    quote:async(i:FundingIntent)=>({minimumBaseUnits:'1',feeBaseUnits:'0',grossBaseUnits:'100',netBaseUnits:'100',gasLamports:'1',rentLamports:'0',
      availableLamports:'100',availableBaseUnits:'210',source:i.funding.quoteSource,reference:i.funding.quoteReference,expiresAt:i.funding.quoteExpiresAt}),
    withSigner:vi.fn(async(_i,sign)=>sign(new Uint8Array(64))),submit:vi.fn(async()=> 'EXAMPLE-signature'),signature:async()=> 'unknown'};
  return {intent,operations,io,service:()=>new PhoenixFundingService(operations,io,{} as any,()=>true)};
}
describe('U11 debt-backed U04 settlement boundary',()=>{
  it('rejects borrowing child with an absent, zero or repurposed reserve',()=>{
    const {intent}=fixture();
    expect(()=>validateFundingIntent({...intent,borrowReserveRaw:undefined})).toThrow('reserve');
    expect(()=>validateFundingIntent({...intent,borrowReserveRaw:'0'})).toThrow('reserve');
    expect(()=>validateFundingIntent({...intent,parkingIntentId:'EXAMPLE-other'})).toThrow('reserve');
  });
  it('checks the reserve against the live U04 quote instead of only original admission',async()=>{
    const f=fixture(),quote=f.io.quote;
    f.io.quote=async(i:FundingIntent)=>({...await quote(i),availableBaseUnits:'209'});
    await expect(f.service().preview(f.intent)).rejects.toThrow('reserve');
    expect(f.io.withSigner).not.toHaveBeenCalled();expect(f.io.submit).not.toHaveBeenCalled();
  });
  it('will not sign a debt-backed deposit without a server policy authorizer',async()=>{
    const f=fixture();await expect(f.service().create(f.intent)).rejects.toThrow('authorization unavailable');
    expect(f.io.withSigner).not.toHaveBeenCalled();expect(f.io.submit).not.toHaveBeenCalled();
  });
  it('rechecks the lender policy after signing and stops before send when coverage changes',async()=>{
    const f=fixture();let checks=0;f.io.authorizeBorrowDeployment=async()=>{if(++checks===2)throw new Error('EXAMPLE-coverage-lost');};
    await expect(f.service().create(f.intent)).rejects.toThrow('coverage-lost');
    expect(checks).toBe(2);expect(f.io.withSigner).toHaveBeenCalledTimes(1);expect(f.io.submit).not.toHaveBeenCalled();
  });
  it('preserves ordinary non-debt U04 behavior without requiring a lender authorizer',async()=>{
    const f=fixture();delete f.intent.borrowIntentId;delete f.intent.borrowReserveRaw;
    await f.service().create(f.intent);expect(f.io.withSigner).toHaveBeenCalledTimes(1);expect(f.io.submit).toHaveBeenCalledTimes(1);
  });
  it('observes the existing U04 child rather than recreating it after a restart',async()=>{
    const f=fixture();const op={id:'EXAMPLE-child',request_key:f.intent.requestKey,intent:f.intent,state:'completed'} as any;
    const create=vi.fn(),resume=vi.fn(async()=>op),build=vi.fn();
    const adapter=new PhoenixDebtFunding({create,resume},{fundingHistory:async()=>[op]},build);
    const parent={botId:f.intent.botId,ownerWallet:f.intent.ownerWallet,identity,amountRaw:'100',reserveRaw:'110'} as any;
    expect(await adapter.deposit(parent,{borrowIntentId:'EXAMPLE-parent',requestKey:f.intent.requestKey,amountRaw:'100'})).toMatchObject({success:true,finalized:true});
    expect(create).not.toHaveBeenCalled();expect(build).not.toHaveBeenCalled();expect(resume).toHaveBeenCalledTimes(1);
    await expect(adapter.deposit({...parent,reserveRaw:'1'},{borrowIntentId:'EXAMPLE-parent',requestKey:f.intent.requestKey,amountRaw:'100'})).rejects.toThrow('binding');
  });
  it('does not manufacture measured delay from queued or dropped requests',()=>{
    expect(lenderWithdrawalMeasurement([])).toBeNull();
    const f=fixture();
    for(const state of ['queued','dropped']) expect(lenderWithdrawalMeasurement([{id:'EXAMPLE-withdraw',state,created_at:new Date(),intent:{...f.intent,funding:{...f.intent.funding,leg:'withdraw'}},
      observation:{funding:{requestedAt:100,queuedAt:200,droppedAt:300}}} as any])).toBeNull();
  });
});

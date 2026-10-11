import { randomUUID } from 'node:crypto';
import { createGridFeeQuote } from '../../server/grid-bot/fee-authority';
import type { GridDraftAuthority, GridDraftDeps } from '../../server/grid-bot/draft-service';
import type { GridPolicy } from '../../server/grid-bot/policy-hmac';
import type { GridIntent } from '../../shared/grid-draft';
export const clock=1_800_000_000_000;
export const intent:GridIntent={schemaVersion:1,protocol:'pacifica',market:'BTC-PERP',timeframe:'1h',lookback:100,rangeSource:'manual',lowerPrice:'90',upperPrice:'110',stopPrice:'80',gridCount:4,direction:'long',entryScaleType:'flat',profitScaleType:'flat',totalInvestment:'100',leverage:'1',seedAtCreation:true};
export function authority():GridDraftAuthority {
  const fee=(liquidityRole:'maker'|'taker',purpose:'entry'|'profit')=>{const r=createGridFeeQuote({account:'EXAMPLE',subaccountId:null,market:'BTC-PERP',liquidityRole,builderCode:'CARRY',intent:purpose},
    {account:'EXAMPLE',maker_fee:'0.0001',taker_fee:'0.0002'},[{builder_code:'CARRY',fee_rate:'0.0001'}],[{builder_code:'CARRY',max_fee_rate:'0.001'}],clock);if(r.availability!=='available')throw Error();return r.quote;};
  return {market:{market:'BTC-PERP',name:'Bitcoin',protocolSymbol:'BTC',constraints:{state:'available',value:{tick:'0.01',lot:'0.001',minimumQuote:'1',observedAt:clock,expiresAt:clock+60_000,
    maxLeverage:{state:'available',value:'10'},maximumQuote:{state:'available',value:'1000000'},priceBounds:{state:'available',value:{minimum:'1',maximum:'1000000'}},restrictions:{state:'available',value:'unrestricted'},source:'/info',venue:'pacifica'}},
    reference:{state:'available',value:{price:'100',observedAt:clock,expiresAt:clock+60_000,label:'Cached Pacifica book reference price'}}},referenceAccount:'EXAMPLE',entryFee:fee('maker','entry'),profitFee:fee('maker','profit'),seedFee:fee('taker','entry'),
    stop:{state:'available',liquidation:'50',validatedClearance:'1',boundedAdverseExitPrice:'79',observedAt:clock,expiresAt:clock+15_000,source:'EXAMPLE:validated-risk-proof'},autoRange:null};
}
export function policy():GridPolicy {return {id:randomUUID(),protocol:'pacifica',market:'BTC-PERP',direction:'long',upperPrice:'110.00000000',lowerPrice:'90.00000000',startPrice:'100.00000000',gridCount:1,totalInvestment:'100.00',leverage:1,entryScaleType:'flat',profitScaleType:'flat',policyVersion:'1.0.0',feePolicyVersion:'1.0.0',runtimePolicyVersion:'1.0.0',stopLossPercent:'20.0000',stopLossPrice:'80.00000000',seedAtCreation:false,levels:[{ordinal:1,price:'90.00000000',size:'1.00000000',side:'buy',reduceOnly:false},{ordinal:2,price:'110.00000000',size:'0.00000000',side:'buy',reduceOnly:false}]};}
export const umk=()=>Buffer.alloc(32,7);

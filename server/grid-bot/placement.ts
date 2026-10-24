import type { GridPolicy } from './policy-hmac';
import {gridClientOrderId,prepareGridOrder,validatePreparedGridOrder,type GridOrderIntent,type PreparedGridOrder} from './order-identity';
import type {MarketConstraintObservation} from '../protocol/market-constraints';
import type {GridFeeQuote} from './fee-authority';
import type {GridAccount} from './custody';
import {GridExecution} from './execution';
import type {ExactGridRequest,GridClaim} from './launch-storage-core';
import type {WindowAction,WindowLevel} from './window';
import {GRID_TRANSPORT_BATCH_ACTIONS} from '../../shared/grid-capacity';

export function gridLevelRequest(input:{account:GridAccount;level:WindowLevel;market:string;protocolSymbol:string;signerGeneration:string;deployment:string;
  fee:GridFeeQuote;constraint:MarketConstraintObservation;now:number;authority:Record<string,unknown>}):ExactGridRequest{
  const {account:a,level:l}=input;
  const intent:GridOrderIntent={...(l.cycle?{runtimePolicyVersion:(input.authority.policy as GridPolicy | undefined)?.runtimePolicyVersion ?? '2.0.0'}:{}),account:a.account,subaccountId:null,market:input.market,protocolSymbol:input.protocolSymbol,
    signerPublicKey:a.account,signerGeneration:input.signerGeneration,deployment:input.deployment,endpoint:'https://api.pacifica.fi/api/v1/orders/create',
    clientOrderId:gridClientOrderId({botId:a.botId,level:l.ordinal,attempt:l.attempt,leg:l.reduceOnly?'profit':'entry',epochId:(input.authority.policy as GridPolicy|undefined)?.epochAuthority?.epochId}),
    side:l.side==='buy'?'long':'short',price:l.price,amount:l.size,reduceOnly:l.reduceOnly,signingTimestamp:input.now,signingExpiryMs:5000};
  const prepared=prepareGridOrder(intent,input.fee,input.constraint,input.now),{account:_account,subaccount_id:_sub,...data}=prepared.unsigned;
  return {kind:'limit',botId:a.botId,account:a.account,masterAccount:a.masterAccount,path:'/orders/create',operationType:'create_order',timestamp:input.now,expiryMs:5000,data,
    authority:{...input.authority,prepared,levelId:l.id,levelAttempt:l.attempt,...(l.cycle?{cycle:l.cycle,...(!l.reduceOnly?{initialCredit:l.initialCredit,recycleAllocations:l.recycleAllocations}:{})}:{})}};
}
export function validGridLevelAuthority(r:ExactGridRequest,current:Parameters<typeof validatePreparedGridOrder>[1],now:number):boolean{
  const p=r.authority.prepared as PreparedGridOrder|undefined;if(!p || r.kind!=='limit')return false;
  const {account:_a,subaccount_id:_s,...data}=p.unsigned;
  return r.account===p.intent.account && r.timestamp===p.intent.signingTimestamp && r.expiryMs===p.intent.signingExpiryMs
    && Object.keys(data).length===Object.keys(r.data).length && Object.entries(data).every(([k,v])=>r.data[k]===v)
    && validatePreparedGridOrder(p,current,now);
}
/** Re-observation and exact preparation happen per action, never once for an entire chunk. */
export async function executeGridWindow(chunks:WindowAction[][],execution:Pick<GridExecution,'run'>,
  prepare:(action:WindowAction)=>Promise<{key:string;request:ExactGridRequest;claim:GridClaim;leaseToken:string}>){
  if(chunks.some(c=>c.length>GRID_TRANSPORT_BATCH_ACTIONS))throw Error('Grid transport chunk exceeds '+GRID_TRANSPORT_BATCH_ACTIONS+' actions');
  const actions=chunks.flat();
  // The planner puts exits first; defend this invariant at the execution boundary too.
  let sawEntry=false;
  for(const a of actions){if(a.kind==='place'&&!a.level.reduceOnly)sawEntry=true;
    else if(sawEntry)throw Error('Risk-reducing actions must precede entries');}
  let confirmed=0;
  for(const action of actions){const p=await prepare(action),result=await execution.run(p.key,p.request,p.claim,p.leaseToken);
    if(result!=='confirmed')return {confirmed,state:result};confirmed++;}
  return {confirmed,state:'confirmed' as const};
}

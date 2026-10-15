import {describe,it,expect} from 'vitest';
import Decimal from 'decimal.js';
import {GridNumber,gridPnl,type GridEconomicFill} from '../../server/grid-bot/pnl';
import {pairGridFills,reconcileGridObservation,type GridObservation,type ReconciliationOperation} from '../../server/grid-bot/reconciliation';
import {planGridRebalance} from '../../server/grid-bot/rebalance';
import {requestDigest} from '../../server/grid-bot/launch-storage';
const fill=(changes:Partial<GridEconomicFill>={}):GridEconomicFill=>({tradeId:'1',operationId:'EXAMPLE_OP',orderId:'10',levelId:'EXAMPLE_LEVEL',time:1000,leg:'entry',size:'1',price:'100',fee:'1',...changes});
const operation=():ReconciliationOperation=>{const request={kind:'limit' as const,botId:'EXAMPLE_BOT',account:'EXAMPLE_ACCOUNT',masterAccount:'EXAMPLE_MASTER',path:'/orders/create',operationType:'create_order',timestamp:900,expiryMs:5000,data:{client_order_id:'EXAMPLE_CLOID',symbol:'BTC',side:'bid',reduce_only:false,price:'100',amount:'1'},authority:{}};
return {id:'EXAMPLE_OP',state:'confirmed',exact_request:request,exact_request_digest:requestDigest(request),failure_classification:null,venue_order_id:'10',level_id:'EXAMPLE_LEVEL'};};
const observation=():GridObservation=>({account:'EXAMPLE_ACCOUNT',symbol:'BTC',observedAt:2000,inventoryComplete:true,history:{from:0,through:2000,inclusive:true,publicationLagMs:0,source:'EXAMPLE_AUTHORITY'},mark:null,
  position:{direction:'long',size:'0.98'},trades:[{tradeId:'1',orderId:'10',clientOrderId:'EXAMPLE_CLOID',symbol:'BTC',side:'open_long',time:1000,size:'0.98',price:'100',fee:'0.01'}],
  orders:[{orderId:'10',clientOrderId:'EXAMPLE_CLOID',symbol:'BTC',side:'long',price:'100',amount:'1',filledAmount:'0.98',cancelledAmount:'0',reduceOnly:false,orderType:'limit',createdAt:900,updatedAt:1000,status:'partially_filled'}]});
const reconcile=(o=observation(),prior:GridEconomicFill[]=[])=>reconcileGridObservation({account:'EXAMPLE_ACCOUNT',symbol:'BTC',direction:'long',start:0,now:2000,operations:[operation()],prior,observation:o});
describe('Grid exact economic ledger',()=>{
  it('charges actual fees and basis on partial long closes',()=>{const p=gridPnl('long',[fill({size:'2'}),fill({tradeId:'2',time:1100,leg:'exit',price:'110'})],{price:'120',observedAt:2000});expect(p).toMatchObject({quantity:'1',costBasis:'100.5',realised:'8.5',unrealised:'19.5',total:'28',fees:'2',breakeven:'100.5',label:'PnL excludes funding'});});
  it('handles short economics and exact flat cycles',()=>{const p=gridPnl('short',[fill(),fill({tradeId:'2',leg:'exit',price:'90',time:2000})],null);expect(p).toMatchObject({quantity:'0',costBasis:'0',realised:'8',averageEntry:null,breakeven:null,unrealised:null,total:null,cycles:1});});
  it('deduplicates trades and rejects conflicting economics',()=>{expect(gridPnl('long',[fill(),fill()],null).quantity).toBe('1');expect(()=>gridPnl('long',[fill(),fill({fee:'2'})],null)).toThrow('Conflicting');});
  it('sorts chronological fills before deriving cost basis',()=>{expect(gridPnl('long',[fill({tradeId:'2',leg:'exit',time:2000}),fill()],null).cycles).toBe(1);});
  it('rejects overclosing without inventing a position',()=>{expect(()=>gridPnl('long',[fill({leg:'exit'})],null)).toThrow('overclose');});
  it('does not depend on mutable global Decimal configuration',()=>{const original=Decimal.precision;Decimal.set({precision:3});try{expect(gridPnl('long',[fill({size:'0.000000000000000001',price:'12345678901234567890',fee:'0'})],null).costBasis).toBe('12.34567890123456789');}finally{Decimal.set({precision:original});}});
  it('rounds exact rationals half even only at output',()=>{expect(new GridNumber(1n,3n).dto()).toBe('0.333333333333333333');expect(new GridNumber(5n,10n**19n).dto()).toBe('0');expect(new GridNumber(15n,10n**19n).dto()).toBe('0.000000000000000002');});
  it.each(['1\n','NaN','1e4','-1',' 1','01'])('rejects inexact input %j',bad=>{expect(()=>gridPnl('long',[fill({size:bad})],null)).toThrow();});
});
describe('Grid reconciliation facts and entry barriers',()=>{
  it('duplicate trade pages change balances once and retain 98% residual identity',()=>{const o=observation();o.trades.push({...o.trades[0]});const result=reconcile(o);expect(result.fills).toHaveLength(1);expect(result.pnl.quantity).toBe('0.98');expect(result.owned[0]).toMatchObject({operationId:'EXAMPLE_OP',remaining:'0.02'});expect(result.entriesAllowed).toBe(true);expect(reconcile(o,result.fills).pnl.fees).toBe('0.01');});
  it('blocks entries for a position mismatch',()=>{const o=observation();o.position!.size='0.97';expect(reconcile(o).entriesAllowed).toBe(false);});
  it('missing position is unavailable, not zero',()=>{const o=observation();o.position=null;expect(reconcile(o).reasons).toContain('position_mismatch_or_unavailable');});
  it('a final page cannot establish safe-through authority',()=>{const o=observation();o.history=null;expect(reconcile(o).reasons).toContain('history_safe_through_unavailable');});
  it('a vanished order is never a synthetic fill',()=>{const o=observation();o.orders=[];const r=reconcile(o);expect(r.pnl.quantity).toBe('0.98');expect(r.reasons).toContain('vanished_order_unresolved');});
  it('blocks opaque orphan orders without adopting or canceling them',()=>{const o=observation();o.orders.push({...o.orders[0],orderId:'11',clientOrderId:'EXAMPLE_OTHER'});expect(reconcile(o).reasons).toContain('opaque_orphan_order');});
  it('rejects conflicting page identities',()=>{const o=observation();o.trades.push({...o.trades[0],size:'0.5'});expect(()=>reconcile(o)).toThrow('Conflicting');});
  it('missing fills cannot be inferred from order filledAmount',()=>{const o=observation();o.trades=[];const r=reconcile(o);expect(r.fills).toHaveLength(0);expect(r.reasons).toContain('order_trade_mismatch');});
  it('does not leak an observation across accounts',()=>{const o=observation();o.account='EXAMPLE_OTHER';expect(()=>reconcile(o)).toThrow('authority');});
  it('rejects stale snapshots',()=>{expect(()=>reconcileGridObservation({account:'EXAMPLE_ACCOUNT',symbol:'BTC',direction:'long',start:0,now:10000,operations:[operation()],prior:[],observation:observation()})).toThrow('authority');});
  it('records seed economics with no fabricated level identity',()=>{const op=operation();op.exact_request.kind='seed';op.level_id=null;const r=reconcileGridObservation({account:'EXAMPLE_ACCOUNT',symbol:'BTC',direction:'long',start:0,now:2000,operations:[op],prior:[],observation:observation()});expect(r.fills[0].levelId).toBeNull();expect(r.pnl.quantity).toBe('0.98');});
  it('does not round a sub-output-precision position into a match',()=>{const o=observation();o.trades[0].size='0.0000000000000000001';o.orders[0].filledAmount=o.trades[0].size;o.position!.size='0';expect(reconcile(o).reasons).toContain('position_mismatch_or_unavailable');});
});
describe('Grid actual-fill pairing and local diff',()=>{
  it.each([{direction:'long' as const,side:'buy' as const,price:'101'},{direction:'short' as const,side:'sell' as const,price:'99'}])('holds crossed $side entries for a fresh maker opportunity',({direction,side,price})=>{
    const result=planGridRebalance({direction,levels:[{id:'EXAMPLE_CROSSED',ordinal:1,price,size:'1',side,reduceOnly:false,attempt:0,status:'pending'}],fills:[],reserved:[],owned:[],positionSize:'0',bookPrice:'100',lot:'0.01',minimumQuote:'1',freeSlots:24,inventoryComplete:true,entriesAllowed:true,canaryRemaining:'250'});
    expect(result.chunks.flat()).toEqual([]);
  });
  it('reserves only remaining actual lots, including fractional residuals',()=>{expect(pairGridFills([fill({size:'0.98'})],[{tradeId:'1',size:'0.50'}],'1','0.1','1')).toEqual([{tradeId:'1',size:'0.4'}]);});
  it('caps exits by venue position and refuses double allocations',()=>{expect(pairGridFills([fill()],[],'2','0.1','0.4')).toEqual([{tradeId:'1',size:'0.4'}]);expect(()=>pairGridFills([fill()],[{tradeId:'1',size:'2'}],'1','0.1','1')).toThrow();});
  it('places the adjacent profit leg from fills while preserving the partial entry',()=>{
    const entry={id:'EXAMPLE_LEVEL',ordinal:1,price:'100',size:'1',side:'buy' as const,reduceOnly:false,attempt:0,status:'partially_filled'};
    const result=planGridRebalance({direction:'long',levels:[entry,{...entry,id:'EXAMPLE_EXIT',ordinal:2,price:'110',size:'0',status:'pending'}],fills:[fill({size:'0.98'})],reserved:[],owned:[{levelId:entry.id,orderId:'10',clientOrderId:'EXAMPLE_CLOID',remaining:'0.02',reduceOnly:false}],positionSize:'0.98',bookPrice:'105',lot:'0.01',minimumQuote:'1',freeSlots:24,inventoryComplete:true,entriesAllowed:false,canaryRemaining:'0'});
    // Entry is cancelled first because entries are blocked; its actual residual is retained until settlement.
    expect(result.chunks[0][0].kind).toBe('cancel');expect(result.allocations.EXAMPLE_EXIT).toEqual([{tradeId:'1',size:'0.98'}]);
  });
});

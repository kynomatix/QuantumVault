import { describe, expect, it } from 'vitest';
import { reducePhoenixHistory, enrichEvent } from '../../server/protocol/phoenix/accounting-reducer';
import { phoenixEquity, phoenixPayoutProvenance } from '../../server/protocol/phoenix/accounting-equity';
import { mapPhoenixFill, usdMicros, type RiseAccountingFill } from '../../server/protocol/phoenix/accounting-reader';
import { readPhoenixAccounting, displayMicros } from '../../server/protocol/phoenix/accounting-runtime';
import { PhoenixAccountingService } from '../../server/protocol/phoenix/accounting-service';
import type { TradingBot } from '../../shared/schema';
import { event, snapshot, page, target, now, MemoryAccountingStore } from '../helpers/phoenix-accounting';

describe('Phoenix exact open-to-flat accounting', () => {
  it('combines adds and partial closes, signed maker fees and funding into one epoch', () => {
    const events = [event(1,'0','10'), event(2,'10','15',{ feeMicros: '-3' }),
      event(3,'15','15',{kind:'funding', fillId:null, feeMicros:'0', fundingMicros:'-20',fundingEpochOpeningEventId:'EXAMPLE-event-1'}),
      event(4,'15','5',{grossPnlMicros:'300'}), event(5,'5','0',{grossPnlMicros:'100'})];
    const rows = reducePhoenixHistory(target, events.reverse(), snapshot(), now);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status:'closed', baseLots:'0', grossPnlMicros:'400',feeMicros:'27',fundingMicros:'-20',netPnlMicros:'353',accounting:'complete' });
    expect(rows[0].eventIds).toEqual([1,2,3,4,5].map(n=>`EXAMPLE-event-${n}`));
    expect(rows[0].feeTierReferences).toEqual(['EXAMPLE-account-tier']);
  });
  it('does not let a historical close flatten a later opening', () => {
    const rows = reducePhoenixHistory(target,[event(3,'0','7'),event(2,'10','0'),event(1,'0','10')],snapshot({SOL:'7'}),now);
    expect(rows.map(e=>e.status)).toEqual(['closed','open']); expect(rows[0].id).not.toBe(rows[1].id);
  });
  it('splits flips with exact signed fee conservation and assigns realized PnL to the old epoch', () => {
    const rows=reducePhoenixHistory(target,[event(1,'0','3'),event(2,'3','-2',{feeMicros:'-7',grossPnlMicros:'50'})],snapshot({SOL:'-2'}),now);
    expect(rows[0]).toMatchObject({status:'closed',feeMicros:'6',netPnlMicros:'44'});
    expect(rows[1]).toMatchObject({status:'open',side:'short',feeMicros:'-3',netPnlMicros:'3'});
  });
  it.each(['liquidation','adl'] as const)('recognizes external %s close once',kind=>{
    const rows=reducePhoenixHistory(target,[event(1,'0','-2'),event(2,'-2','0',{kind,grossPnlMicros:'-100'})],snapshot(),now);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({liquidation:true,status:'closed',netPnlMicros:'-120'});
  });
  it.each(['grossPnlMicros','feeMicros','fundingMicros'] as const)('keeps missing %s incomplete',key=>{
    const close=key==='fundingMicros' ? event(2,'2','2',{kind:'funding',feeMicros:'0',fundingMicros:null,fundingEpochOpeningEventId:'EXAMPLE-event-1'}) : event(2,'2','0',{[key]:null});
    const rows=reducePhoenixHistory(target,[event(1,'0','2'),close],snapshot(key==='fundingMicros'?{SOL:'2'}:{}),now);
    expect(rows[0].netPnlMicros).toBeNull(); expect(rows[0].accounting).toBe('incomplete');
  });
  it.each([
    [event(1,'2','0')], [event(1,'0','2'),event(1,'0','2')],
    [event(1,'0','2'),event(2,'3','0')], [event(1,'0','2',{grossPnlMicros:'1'})],
    [event(1,'0','2',{trader:'EXAMPLE-wrong'})], [event(1,'0','2',{slot:'101'})],
    [event(1,'0','2',{timestamp:now+1})],
  ])('rejects a gap, duplicate, identity or impossible realization %#',(...events)=>{
    expect(()=>reducePhoenixHistory(target,events,snapshot(),now)).toThrow();
  });
  it('accepts only null-to-known enrichment',()=>{
    expect(enrichEvent(event(1,'0','2',{feeMicros:null}),event(1,'0','2')).feeMicros).toBe('10');
    expect(()=>enrichEvent(event(1,'0','2'),event(1,'0','2',{feeMicros:'11'}))).toThrow();
  });
  it('attributes late funding to the closed epoch after a new position opens',()=>{
    const rows=reducePhoenixHistory(target,[event(1,'0','2'),event(2,'2','0',{grossPnlMicros:'100'}),event(3,'0','5'),
      event(4,'5','5',{kind:'funding',feeMicros:'0',fundingMicros:'-7',fundingEpochOpeningEventId:'EXAMPLE-event-1'})],snapshot({SOL:'5'}),now);
    expect(rows[0]).toMatchObject({status:'closed',netPnlMicros:'73',fundingMicros:'-7'});
    expect(rows[1]).toMatchObject({status:'open',fundingMicros:'0',netPnlMicros:'-10'});
  });
  it('accepts attributed funding after flat and rejects unbound funding',()=>{
    const funding=event(3,'0','0',{kind:'funding',feeMicros:'0',fundingMicros:'5',fundingEpochOpeningEventId:'EXAMPLE-event-1'});
    expect(reducePhoenixHistory(target,[event(1,'0','2'),event(2,'2','0'),funding],snapshot(),now)[0].netPnlMicros).toBe('-15');
    expect(()=>reducePhoenixHistory(target,[event(1,'0','2'),event(2,'2','0'),{...funding,fundingEpochOpeningEventId:null}],snapshot(),now)).toThrow();
  });
});
describe('equity components and payout provenance',()=>{
  it('counts each custody component once, with queue/margin/uPnL memorandum only',()=>{
    const eq=phoenixEquity(target,snapshot(),now);
    expect(eq.totalEquityMicros).toBe('1550'); expect(eq.sizingAuthority).toBe(false);
  });
  it.each(['walletUsdcMicros','walletCollateralValueMicros','venueEquityMicros','parkedValueMicros','externalDebtMicros'] as const)('unavailable %s is unknown',key=>{
    expect(phoenixEquity(target,snapshot({}, {[key]:null}),now).totalEquityMicros).toBeNull();
  });
  it('pending returns without valuation never inflate equity or fund payment',()=>{
    const eq=phoenixEquity(target,snapshot({}, {inTransit:[{operationId:'EXAMPLE-withdraw',reference:'EXAMPLE-pending',valueMicros:null}]}),now);
    expect(eq.totalEquityMicros).toBeNull(); expect(eq.creatorPayoutsEnabled).toBe(false);
  });
  it('rejects duplicate transit claims and stale or refreshed-failed snapshots',()=>{
    const claim={operationId:'EXAMPLE-withdraw',reference:'EXAMPLE-pending',valueMicros:null};
    expect(()=>phoenixEquity(target,snapshot({}, {inTransit:[claim,claim]}),now)).toThrow();
    expect(()=>phoenixEquity(target,snapshot(),now+30000)).toThrow();
    expect(()=>phoenixEquity(target,snapshot({}, {refreshFailed:true as never}),now)).toThrow();
  });
  it('separates subscriber payer and fees and never produces a payable',()=>{
    const epoch=reducePhoenixHistory(target,[event(1,'0','1'),event(2,'1','0',{grossPnlMicros:'100'})],snapshot(),now)[0];
    const binding={botId:target.botId,payerWallet:target.ownerWallet,creatorWallet:'EXAMPLE-creator',subscriptionId:'EXAMPLE-subscription'};
    expect(phoenixPayoutProvenance(target,epoch,binding)).toMatchObject({netRealizedPnlMicros:'80',venueFeesMicros:'20',payableMicros:null,flightFeeMicros:'0',state:'disabled_prerequisite'});
    expect(()=>phoenixPayoutProvenance(target,epoch,{...binding,payerWallet:'EXAMPLE-wrong'})).toThrow();
    expect(()=>phoenixPayoutProvenance(target,epoch,{...binding,creatorWallet:target.ownerWallet})).toThrow();
  });
});
describe('native fill mapping',()=>{
  const raw: RiseAccountingFill={traderId:7,traderPdaIndex:0,subaccountIndex:0,marketSymbol:'SOL',signature:'EXAMPLE-fill-signature',fillId:null,
    timestamp:now-1,slot:'50',slotIndex:0,instructionIndex:0,eventIndex:1,baseLotsBefore:'0',baseLotsAfter:'2',baseLotsDelta:'2',
    realizedPnl:'0',fees:'-0.000003',orderSequenceNumber:2,tradeType:'limit'};
  const evidence={traderId:7,source:'EXAMPLE-venue',reference:'EXAMPLE-record',feeTierReference:'EXAMPLE-tier',pnlBasis:'gross_excluding_fees_and_funding' as const,feesAreSignedCosts:true as const};
  it('uses native coordinates as stable identity and keeps signed rebates',()=>{
    const fill=mapPhoenixFill(target,raw,evidence);
    expect(fill.feeMicros).toBe('-3'); expect(fill.id).toBe(mapPhoenixFill(target,{...raw,fillId:'EXAMPLE-fill'},evidence).id);
  });
  it('rejects cross-trader records, imprecise money and unsafe sequence numbers',()=>{
    expect(()=>mapPhoenixFill(target,{...raw,traderId:8},evidence)).toThrow();
    expect(()=>mapPhoenixFill(target,{...raw,orderSequenceNumber:Number.MAX_SAFE_INTEGER+1},evidence)).toThrow();
    expect(()=>usdMicros('1.0000001')).toThrow(); expect(usdMicros(null)).toBeNull();
    expect(usdMicros('9007199254740993.000001')).toBe('9007199254740993000001');
  });
});
describe('read models never invent deposit basis or stale equity',()=>{
  const i=target.identity;
  const bot={id:target.botId,walletAddress:target.ownerWallet,activeProtocol:'phoenix',derivationIndex:1,derivationPathVersion:1,
    protocolSubaccountId:i.traderAccountAddress,phoenixAuthorityWallet:i.authorityWalletAddress,phoenixTraderAccount:i.traderAccountAddress,
    phoenixNetwork:i.network,phoenixProgramAddress:i.programAddress,phoenixPortfolioIndex:0,phoenixSubaccountIndex:0} as TradingBot;
  it('reports exact closed performance and refuses stale live totals',async()=>{
    const store=new MemoryAccountingStore();
    await new PhoenixAccountingService(store,{snapshot:async()=>snapshot(),history:async()=>page([event(1,'0','2'),event(2,'2','0',{grossPnlMicros:'100'})])},()=>now).reconcile(target);
    const fresh=await readPhoenixAccounting(bot,store,now);
    expect(fresh.performance).toMatchObject({closedPositions:1,winningPositions:1,netRealizedPnlMicros:'80',venueFeesMicros:'20'});
    const stale=await readPhoenixAccounting(bot,store,now+30000);
    expect(stale.equity).toBeNull(); expect(stale.performance.netRealizedPnlMicros).toBeNull(); expect(stale.history).toHaveLength(1);
  });
  it('returns unknown for first boot and declines inexact display conversions',async()=>{
    expect((await readPhoenixAccounting(bot,new MemoryAccountingStore(),now)).performance.closedPositions).toBeNull();
    expect(displayMicros('9007199254740993')).toBeNull(); expect(displayMicros('-1000001')).toBe(-1.000001);
  });
});

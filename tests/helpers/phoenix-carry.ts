import { authority, identity, now } from './phoenix-orders';
import { defenseFacts } from './phoenix-defense';
import type { CarryFacts } from '../../server/protocol/phoenix/carry-contract';
import type { ParkingIntent, ParkingLeg, ParkingReceipt, ParkingRecord } from '../../server/protocol/phoenix/parking-contract';
import type { ParkingRepository } from '../../server/protocol/phoenix/parking-service';
import { phoenixIntentHash } from '../../server/protocol/phoenix/operation-store';
import { verifyParkingReceipt } from '../../server/protocol/phoenix/parking-store';

export function carryFixture() {
  const d = defenseFacts();
  const i: ParkingIntent = {botId:d.intent.botId,ownerWallet:d.intent.ownerWallet,requestKey:'EXAMPLE-carry',identity,
    action:'carry',destination:'EXAMPLE-yield',maxUsdc:'40000000',mode:'shortfall',carry:{closeOrderId:'EXAMPLE-close',
      positionEpoch:'EXAMPLE-position-epoch',choice:'carry',allowRepay:true,expiresAt:now+60000,reserveRaw:'10000000',maxRepayRaw:'30000000',
      horizonSeconds:31536000,maxQueueSeconds:300,maxQueueCostUsd:1,
      loan:{...d.intent,consent:{accountCollateral:false,reserve:true,deployBorrowed:false}}}};
  const health = {...d.health,band:'healthy' as const,healthFactor:2};
  const f: CarryFacts = {autoRepayEnabled:true,health,lender:d.snapshot,
    close:{orderId:'EXAMPLE-close',positionEpoch:'EXAMPLE-position-epoch',authoritative:true,fullyClosed:true},
    parking:{botId:i.botId,authority:identity.authorityWalletAddress,trader:identity.traderAccountAddress,observedAt:now,slot:'100',
      complete:true,marketsComplete:true,source:'EXAMPLE-reader',reference:'EXAMPLE-proof',autoPark:true,entryAuthorized:true,
      lifecycleActive:true,destination:i.destination,destinationEnabled:true,walletUsdc:'50000000',withdrawableUsdc:'40000000',
      pendingReturnUsdc:'0',freeMarginUsdc:'0',protections:[authority().protection!],holdings:[]},
    economics:{yieldTable:{'EXAMPLE-yield':{apy:20,apyBase:20,apyReward:0,method:'trailing',asOf:now}},
      assets:[{key:'EXAMPLE-yield',displayName:'Example yield',mint:'EXAMPLE-mint',decimals:6,route:'jupiter',valuation:'market_quote',
        defaultEligible:false,riskClass:'stable',mayLoseValue:false,apyLabel:'EXAMPLE',tag:'EXAMPLE',riskNote:'EXAMPLE',enabled:true} as any],
      healthSummary:{applicable:true,positions:[health],headline:{band:'healthy',healthFactor:2,actionBlocked:false}},
      borrowApr:0.02,rateObservedAt:now,debtUsd:90,principalRaw:'40000000',destination:'EXAMPLE-yield',parkedAsset:null,
      history:[{id:'EXAMPLE-measurement',bot_id:i.botId,state:'completed',intent:{ownerWallet:i.ownerWallet,identity,funding:{leg:'withdraw'}},
        observation:{funding:{requestedAt:now-61000,completedAt:now-1000}}} as any],
      costs:{principalRaw:'40000000',destination:'EXAMPLE-yield',roundTripUsd:0.01,observedAt:now,expiresAt:now+60000,
        source:'EXAMPLE-route-quotes',reference:'EXAMPLE-round-trip'},horizonSeconds:31536000,pendingQueueAgeSeconds:0,
      maxQueueSeconds:300,maxQueueCostUsd:1,maxAgeMs:60000,measurementMaxAgeMs:86400000}};
  return {i,f};
}
export class CarryMemory implements ParkingRepository {
  r!: ParkingRecord;
  async prepare(i: ParkingIntent) {
    if (this.r) { if (this.r.intent_hash !== phoenixIntentHash(i as any)) throw new Error('replay'); return this.read(); }
    this.r = {id:'EXAMPLE-parent',intent:structuredClone(i),intent_hash:phoenixIntentHash(i as any),revision:0,state:'active',legs:[]};
    return this.read();
  }
  async read() { return structuredClone(this.r); }
  check(r: ParkingRecord) { if (r.revision !== this.r.revision || this.r.state !== 'active') throw new Error('stale'); }
  async claim(r: ParkingRecord, leg: ParkingLeg) { this.check(r); this.r.legs.push({leg}); this.r.revision++; return this.read(); }
  async observe(r: ParkingRecord, receipt: ParkingReceipt) { this.check(r); verifyParkingReceipt(this.r.legs.at(-1)!.leg,receipt);
    this.r.legs.at(-1)!.receipt=receipt; this.r.revision++; return this.read(); }
  async finish(r: ParkingRecord, state: 'completed'|'cancelled'|'attention') { this.check(r); this.r.state=state; this.r.revision++; return this.read(); }
}

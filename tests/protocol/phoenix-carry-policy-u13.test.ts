import { describe, expect, it } from 'vitest';
import { recommendPhoenixCarry } from '../../server/protocol/phoenix/carry-policy';
import { carryFixture } from '../helpers/phoenix-carry';
import { now } from '../helpers/phoenix-orders';
import { phoenixCarryCapabilities } from '../../server/protocol/phoenix/carry-runtime';
import { decideCarryTrade } from '../../server/vault/carry-trade-advisor';

describe('U13 measured carry advice',()=>{
  it('does not advise repayment with zero debt in a sub-healthy band',()=>{
    const e=carryFixture().f.economics; e.debtUsd=0;
    expect(recommendPhoenixCarry(e,now).action).toBe('hold');
    expect(recommendPhoenixCarry(e,now).message).toContain('No debt');
  });
  it('is unavailable for live use even with the environment gate alone',()=>{
    expect(phoenixCarryCapabilities({PHOENIX_CARRY_ENABLED:'true'})).toMatchObject({enabled:false,automaticBorrowing:false,recovery:false});
  });
  it('uses observed U04 delay and exact route costs, exposes no consent or amount',()=>{
    const e=carryFixture().f.economics, r=recommendPhoenixCarry(e,now);
    expect(r.action).toBe('park');expect(r.observedDelaySeconds).toBe(60);expect(r.queueCostUsd).toBeGreaterThan(0);
    expect(r.estimatedNetUsd).toBeLessThan(40*(0.20-0.02));expect(r.message).toContain('not guaranteed');
    expect(r).not.toHaveProperty('amount');expect(r).not.toHaveProperty('consent');
  });
  it.each(['apr','yield','cost','delay','stale_rate','stale_yield','stale_cost','stale_delay','unsafe_units'])(
    'never carries with unknown or stale %s',field=>{
      const e=carryFixture().f.economics;
      if(field==='apr')e.borrowApr=null;
      if(field==='yield')e.yieldTable['EXAMPLE-yield'].method='accruing';
      if(field==='cost')e.costs=null;
      if(field==='delay')e.history=[];
      if(field==='stale_rate')e.rateObservedAt=now-60000;
      if(field==='stale_yield')e.yieldTable['EXAMPLE-yield'].asOf=now-60000;
      if(field==='stale_cost')e.costs!.expiresAt=now;
      if(field==='stale_delay')(e.history[0].observation!.funding as any).completedAt=now-86400000;
      if(field==='unsafe_units')e.principalRaw='9007199254740992';
      expect(recommendPhoenixCarry(e,now).action).toBe('unavailable');
    });
  it.each(['queued','dropped'])('does not count %s as a measured return',state=>{
    const e=carryFixture().f.economics;e.history[0].state=state as any;expect(recommendPhoenixCarry(e,now).action).toBe('unavailable');
  });
  it('charges fees that erase the spread and respects queue cost and age limits',()=>{
    const e=carryFixture().f.economics;e.costs!.roundTripUsd=10;
    expect(recommendPhoenixCarry(e,now)).toMatchObject({action:'repay',reason:'negative_net_carry'});
    e.costs!.roundTripUsd=0.01;e.pendingQueueAgeSeconds=301;
    expect(recommendPhoenixCarry(e,now)).toMatchObject({action:'unavailable',reason:'queue_limit'});
    e.pendingQueueAgeSeconds=0;e.maxQueueCostUsd=0;
    expect(recommendPhoenixCarry(e,now).reason).toBe('queue_limit');
  });
  it('puts health ahead of unknown rates without treating advice as spend consent',()=>{
    const e=carryFixture().f.economics;e.borrowApr=null;e.costs=null;e.healthSummary.headline.band='urgent';
    expect(recommendPhoenixCarry(e,now).action).toBe('repay');
    e.healthSummary.headline.actionBlocked=true;expect(recommendPhoenixCarry(e,now).action).toBe('unavailable');
  });
  it('preserves an existing asset rather than selecting a new higher yield destination',()=>{
    const e=carryFixture().f.economics;e.parkedAsset=e.destination;e.destination='EXAMPLE-other';
    expect(recommendPhoenixCarry(e,now)).toMatchObject({action:'hold',parkedAsset:'EXAMPLE-yield',destination:'EXAMPLE-other'});
  });
  it('leaves the incumbent advice unchanged and creates no debt from a debt-free bot',()=>{
    const e=carryFixture().f.economics;
    const input={rankedYields:[],borrowApr:e.borrowApr,healthSummary:e.healthSummary,debtUsd:e.debtUsd};
    const before=decideCarryTrade(input);recommendPhoenixCarry(e,now);expect(decideCarryTrade(input)).toEqual(before);
    e.debtUsd=0;expect(recommendPhoenixCarry(e,now).action).toBe('hold');
  });
});

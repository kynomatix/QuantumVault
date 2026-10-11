// Primitive tests use an explicit trusted rollout fixture; U16 tests exercise the real owner gate.
vi.mock('../../server/protocol/phoenix/rollout', async importOriginal => ({
  ...await importOriginal<typeof import('../../server/protocol/phoenix/rollout')>(),
  phoenixCanaryAllows: () => true, phoenixExposureAllows: () => true, phoenixFeatureEnabled: () => true,
}));
import { describe, expect, it, vi } from 'vitest';
import { PhoenixParkingService, PhoenixParkingUnsent, type ParkingRepository } from '../../server/protocol/phoenix/parking-service';
import { verifyParkingReceipt } from '../../server/protocol/phoenix/parking-store';
import { phoenixIntentHash } from '../../server/protocol/phoenix/operation-store';
import { assertParkingSnapshot, parkingAuthorized, type ParkingIntent, type ParkingLeg, type ParkingReceipt, type ParkingRecord, type ParkingSnapshot } from '../../server/protocol/phoenix/parking-contract';
import { phoenixParkingEnabled, createPhoenixParkingRuntime } from '../../server/protocol/phoenix/parking-runtime';
import { authority, identity, now } from '../helpers/phoenix-orders';

function intent(patch: Partial<ParkingIntent> = {}): ParkingIntent {
  return { botId: 'EXAMPLE-bot', ownerWallet: 'EXAMPLE-owner', requestKey: 'EXAMPLE-park', identity,
    action: 'idle', maxUsdc: '100', destination: 'EXAMPLE-yield', mode: 'shortfall', ...patch };
}
function snapshot(): ParkingSnapshot {
  return { botId: 'EXAMPLE-bot', authority: identity.authorityWalletAddress, trader: identity.traderAccountAddress,
    observedAt: now, slot: '100', complete: true, marketsComplete: true, source: 'EXAMPLE-reader', reference: 'EXAMPLE-proof',
    autoPark: true, entryAuthorized: true, lifecycleActive: true, destination: 'EXAMPLE-yield', destinationEnabled: true,
    walletUsdc: '0', withdrawableUsdc: '100', pendingReturnUsdc: '0', freeMarginUsdc: '0',
    protections: [authority().protection!], holdings: [] };
}
class Memory implements ParkingRepository {
  r!: ParkingRecord;
  async prepare(i: ParkingIntent) {
    if (this.r) { if (this.r.intent_hash !== phoenixIntentHash(i as any)) throw new Error('replay'); return structuredClone(this.r); }
    this.r = { id: 'EXAMPLE-id', intent: structuredClone(i), intent_hash: phoenixIntentHash(i as any), revision: 0, state: 'active', legs: [] };
    return structuredClone(this.r);
  }
  async read() { return structuredClone(this.r); }
  check(r: ParkingRecord) { if (r.revision !== this.r.revision || this.r.state !== 'active') throw new Error('stale'); }
  async claim(r: ParkingRecord, leg: ParkingLeg) { this.check(r); this.r.legs.push({ leg }); this.r.revision++; return this.read(); }
  async observe(r: ParkingRecord, receipt: ParkingReceipt) { this.check(r); verifyParkingReceipt(this.r.legs.at(-1)!.leg, receipt);
    this.r.legs.at(-1)!.receipt = receipt; this.r.revision++; return this.read(); }
  async finish(r: ParkingRecord, state: ParkingRecord['state']) { this.check(r); this.r.state = state; this.r.revision++; return this.read(); }
}
function fixture(patch: Partial<ParkingIntent> = {}) {
  const i = intent(patch), s = snapshot(), store = new Memory();
  let receipt: ParkingReceipt | null = null;
  const io = { snapshot: vi.fn(async () => structuredClone(s)), submit: vi.fn(async () => {}), receipt: vi.fn(async () => receipt) };
  let enabled = true;
  const service = () => new PhoenixParkingService(store, io, () => enabled, () => now);
  const settle = (state: ParkingReceipt['state'] = 'settled', received?: string, spent?: string) => {
    const l = store.r.legs.at(-1)!.leg;
    receipt = { key: l.key, state, received: received ?? (state === 'settled' ? l.amount : '0'),
      spent: spent ?? (state === 'settled' ? l.amount : '0'), finalized: true, slot: '100', source: 'EXAMPLE-chain', reference: 'EXAMPLE-tx' };
  };
  return { i, s, store, io, service, settle, disable: () => { enabled = false; } };
}
const entry = { action: 'entry' as const, executionOrderId: 'EXAMPLE-order', requiredMarginUsdc: '100', destination: null };

describe('U10 pre-activation recovery', () => {
  it('denies post-borrow parking when either authorization binding is missing', () => {
    const i = intent({ action: 'post_borrow' }), s = snapshot();
    expect(parkingAuthorized(i, s)).toBe(false);
    i.borrowAuthorizationId = 'EXAMPLE-borrow';
    expect(parkingAuthorized(i, s)).toBe(false);
    s.borrow = { authorizationId: 'EXAMPLE-borrow', parkAuthorized: true, creditedUsdc: '100' };
    expect(parkingAuthorized(i, s)).toBe(true);
    i.borrowAuthorizationId = undefined;
    expect(parkingAuthorized(i, s)).toBe(false);
  });
  it('binds post-borrow parking to the completed authorization without idle opt-in',async()=>{
    const start=vi.fn(async()=>{}), i=intent({action:'post_borrow',borrowAuthorizationId:'EXAMPLE-borrow'});
    const runtime=createPhoenixParkingRuntime({start} as any,{idleIntent:async()=>null,postBorrowIntent:async()=>i,pending:async()=>[],report:()=>{}});
    const bot={id:i.botId,walletAddress:i.ownerWallet,activeProtocol:'phoenix',autoParkIdle:false} as any;
    await runtime.postBorrow(bot,'EXAMPLE-borrow'); expect(start).toHaveBeenCalledWith(i);
    await expect(runtime.postBorrow(bot,'EXAMPLE-other')).rejects.toThrow('binding');
  });
  it('completes empty idle work without blocking entry', async () => {
    const f=fixture(); f.s.withdrawableUsdc='0';
    expect((await f.service().start(f.i)).state).toBe('completed');
    expect(f.io.submit).not.toHaveBeenCalled();
  });
  it('retries a proven unsent leg under a fresh key', async () => {
    const f=fixture(); f.io.submit.mockRejectedValueOnce(new PhoenixParkingUnsent('EXAMPLE-pre-dispatch'));
    await f.service().start(f.i);
    expect(f.store.r.legs[0].receipt?.state).toBe('unsent');
    await f.service().resume(f.i);
    expect(f.io.submit).toHaveBeenCalledTimes(2);
    expect(f.store.r.legs.map(l=>l.leg.key)).toEqual(['EXAMPLE-id:0','EXAMPLE-id:1']);
  });
  it('holds an ambiguous failure with no receipt', async () => {
    const f=fixture(); f.io.submit.mockRejectedValueOnce(new Error('EXAMPLE-lost-ack'));
    await f.service().start(f.i); await f.service().resume(f.i);
    expect(f.io.submit).toHaveBeenCalledTimes(1);
    expect(f.store.r.state).toBe('active');
  });
});

describe('U10 settlement-aware bot parking', () => {
  it('continues journaled redemption after rollback but never starts the following entry deposit', async () => {
    const f = fixture({...entry,maxUsdc:'60'}); f.s.freeMarginUsdc='40';
    f.s.holdings=[{asset:'EXAMPLE-disabled',tokenUnits:'100',valueUsdc:'100',redeemable:true}];
    await f.store.prepare(f.i); f.disable();
    await f.service().resume(f.i);
    expect(f.store.r.legs[0].leg.kind).toBe('unpark'); expect(f.io.submit).toHaveBeenCalledTimes(1);
    f.settle('settled','61'); f.s.walletUsdc='61'; await f.service().resume(f.i);
    expect(f.store.r.legs).toHaveLength(1); expect(f.io.submit).toHaveBeenCalledTimes(1);
    expect(f.store.r.state).toBe('active');
  });
  it('is off by default even if an environment switch is set without reviewed bindings', async () => {
    expect(phoenixParkingEnabled({})).toBe(false);
    expect(phoenixParkingEnabled({ PHOENIX_PARKING_ENABLED: 'true' })).toBe(false);
    const f = fixture(); await expect(new PhoenixParkingService(f.store, f.io).start(f.i)).rejects.toThrow('disabled');
    expect(f.io.submit).not.toHaveBeenCalled();
  });
  it('waits for queue, then unwraps and parks only confirmed wallet cash across restart', async () => {
    const f = fixture(); await f.service().start(f.i);
    expect(f.store.r.legs[0].leg.kind).toBe('withdraw');
    f.settle('pending'); f.s.pendingReturnUsdc = '100';
    await f.service().resume(f.i); await f.service().resume(f.i);
    expect(f.io.submit).toHaveBeenCalledTimes(1);
    f.settle(); f.s.pendingReturnUsdc = '0'; await f.service().resume(f.i);
    expect(f.store.r.legs.at(-1)!.leg.kind).toBe('unwrap');
    f.settle(); f.s.walletUsdc = '100'; f.s.withdrawableUsdc = '0'; await f.service().resume(f.i);
    expect(f.store.r.legs.at(-1)!.leg).toMatchObject({ kind: 'park', amount: '100', asset: 'EXAMPLE-yield' });
    f.settle('settled', '98'); await f.service().resume(f.i);
    expect(f.store.r.state).toBe('completed'); expect(f.io.submit).toHaveBeenCalledTimes(3);
  });
  it('uses net withdrawal proceeds after a queue fee', async () => {
    const f = fixture(); await f.service().start(f.i); f.settle('settled', '95'); await f.service().resume(f.i);
    expect(f.store.r.legs.at(-1)!.leg.amount).toBe('95');
    f.settle(); f.s.walletUsdc = '95'; await f.service().resume(f.i);
    expect(f.store.r.legs.at(-1)!.leg).toMatchObject({ kind: 'park', amount: '95' });
  });
  it.each(['autoPark','destinationEnabled','lifecycleActive'] as const)('checks %s before starting the next leg', async field => {
    const f = fixture(); await f.service().start(f.i); f.settle(); f.s[field] = false;
    await f.service().resume(f.i); expect(f.store.r.state).toBe('cancelled'); expect(f.io.submit).toHaveBeenCalledTimes(1);
  });
  it('observes opt-out queued returns without submitting unwrap', async () => {
    const f = fixture(); await f.service().start(f.i); f.settle('pending'); f.s.autoPark = false;
    await f.service().resume(f.i); expect(f.store.r.state).toBe('active');
    f.settle(); await f.service().resume(f.i); expect(f.store.r.state).toBe('cancelled'); expect(f.io.submit).toHaveBeenCalledTimes(1);
  });
  it('does not substitute another destination after the user changes it', async () => {
    const f = fixture(); await f.service().start(f.i); f.settle(); f.s.destination = 'EXAMPLE-other';
    await f.service().resume(f.i); expect(f.store.r.state).toBe('cancelled');
  });
  it.each(['stale','positions','book','protection','incomplete','wrong-wallet'])('denies %s proof before any leg', async defect => {
    const f = fixture();
    if (defect === 'stale') f.s.observedAt -= 5000;
    if (defect === 'positions') f.s.protections[0].position = { side: 'long', baseLots: '1', epoch: 'EXAMPLE-epoch', sequence: 1 };
    if (defect === 'book') f.s.protections[0].orderbookOrderIds = ['EXAMPLE-order'];
    if (defect === 'protection') f.s.protections[0].legs = [{} as any];
    if (defect === 'incomplete') f.s.marketsComplete = false as any;
    if (defect === 'wrong-wallet') f.s.authority = 'EXAMPLE-other';
    await expect(f.service().start(f.i)).rejects.toThrow(); expect(f.io.submit).not.toHaveBeenCalled();
  });
  it('never blindly retries a timed-out send on a new service instance', async () => {
    const f = fixture(); f.io.submit.mockRejectedValue(new Error('EXAMPLE-timeout'));
    await f.service().start(f.i); await f.service().resume(f.i); await f.service().resume(f.i);
    expect(f.io.submit).toHaveBeenCalledTimes(1); expect(f.store.r.state).toBe('active');
  });
  it('retains a dropped queue for attention instead of vaulting its requested amount', async () => {
    const f = fixture(); await f.service().start(f.i); f.settle('dropped'); await f.service().resume(f.i);
    expect(f.store.r.state).toBe('attention'); expect(f.io.submit).toHaveBeenCalledTimes(1);
  });
  it('continues the confirmed return and unwrap with the feature gate off, then stops new parking', async () => {
    const f = fixture(); await f.service().start(f.i); f.disable(); f.settle(); await f.service().resume(f.i);
    expect(f.store.r.legs[0].receipt?.state).toBe('settled');
    expect(f.store.r.legs.at(-1)!.leg.kind).toBe('unwrap'); expect(f.io.submit).toHaveBeenCalledTimes(2);
    f.settle(); f.s.walletUsdc='100'; await f.service().resume(f.i);
    expect(f.io.submit).toHaveBeenCalledTimes(2); expect(f.store.r.state).toBe('active');
  });
  it('serializes concurrent resumes so only one vault leg is submitted', async () => {
    const f = fixture(); f.s.walletUsdc = '100'; await f.store.prepare(f.i);
    await Promise.allSettled([f.service().resume(f.i), f.service().resume(f.i)]);
    expect(f.io.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps the settled slot floor when retrying an unsent leg', async () => {
    const f = fixture(); await f.service().start(f.i); f.settle();
    f.io.submit.mockRejectedValueOnce(new PhoenixParkingUnsent('EXAMPLE-pre-dispatch'));
    await f.service().resume(f.i);
    expect(f.store.r.legs.at(-1)!.receipt?.state).toBe('unsent');
    f.s.slot = '99';
    await expect(f.service().resume(f.i)).rejects.toThrow();
    expect(f.io.submit).toHaveBeenCalledTimes(2);
    f.s.slot = '100'; await f.service().resume(f.i);
    expect(f.io.submit).toHaveBeenCalledTimes(3);
  });
  it('keeps a partial swap for attention and never deposits quoted proceeds', async () => {
    const f = fixture(entry); f.s.holdings = [{ asset: 'EXAMPLE-disabled', tokenUnits: '100', valueUsdc: '100', redeemable: true }];
    await f.service().start(f.i); f.settle('settled', '40', '50'); f.s.walletUsdc = '40';
    await f.service().resume(f.i); expect(f.store.r.state).toBe('attention'); expect(f.io.submit).toHaveBeenCalledTimes(1);
  });
  it('short realized proceeds refuse a deposit and retain custody', async () => {
    const f = fixture(entry); f.s.holdings = [{ asset: 'EXAMPLE-held', tokenUnits: '100', valueUsdc: '100', redeemable: true }];
    await f.service().start(f.i); f.settle('settled', '90'); f.s.walletUsdc = '90';
    await f.service().resume(f.i); expect(f.store.r.state).toBe('attention');
  });
  it('redeems disabled-but-held assets, deposits the shortfall, then requires refreshed margin', async () => {
    const f = fixture({ ...entry, maxUsdc: '60' }); f.s.freeMarginUsdc = '40';
    f.s.holdings = [{ asset: 'EXAMPLE-disabled', tokenUnits: '100', valueUsdc: '100', redeemable: true }];
    await f.service().start(f.i); expect(f.store.r.legs[0].leg.amount).toBe('62');
    f.settle('settled', '61'); f.s.walletUsdc = '61'; await f.service().resume(f.i);
    expect(f.store.r.legs.at(-1)!.leg).toMatchObject({ kind: 'deposit', amount: '60' });
    f.settle(); f.s.freeMarginUsdc = '100'; await f.service().resume(f.i); expect(f.store.r.state).toBe('completed');
  });
  it('all-out redeems each held asset but deposits only the approved entry budget', async () => {
    const f = fixture({ ...entry, mode: 'all' });
    f.s.holdings = ['EXAMPLE-a','EXAMPLE-b'].map(asset => ({ asset, tokenUnits: '200', valueUsdc: '200', redeemable: true }));
    await f.service().start(f.i); f.settle(); f.s.walletUsdc = '200'; await f.service().resume(f.i);
    expect(f.store.r.legs.at(-1)!.leg.asset).toBe('EXAMPLE-b'); f.settle(); f.s.walletUsdc = '400'; await f.service().resume(f.i);
    expect(f.store.r.legs.at(-1)!.leg).toMatchObject({ kind: 'deposit', amount: '100' });
  });
  it('rejects an entry deposit whose receipt did not refresh usable margin', async () => {
    const f = fixture(entry); f.s.walletUsdc = '100'; await f.service().start(f.i); f.settle(); await f.service().resume(f.i);
    expect(f.store.r.state).toBe('attention');
  });
  it('parks only separately authorized borrowed cash with general auto-park off', async () => {
    const f = fixture({ action: 'post_borrow', borrowAuthorizationId: 'EXAMPLE-borrow', maxUsdc: '25' });
    f.s.autoPark = false; f.s.walletUsdc = '1000'; f.s.borrow = { authorizationId: 'EXAMPLE-borrow', creditedUsdc: '25', parkAuthorized: true };
    await f.service().start(f.i); expect(f.store.r.legs[0].leg).toMatchObject({ kind: 'park', amount: '25' });
  });
  it('requires separate post-borrow authorization and respects its revocation', async () => {
    const f = fixture({ action: 'post_borrow', borrowAuthorizationId: 'EXAMPLE-borrow' });
    f.s.autoPark = true; await expect(f.service().start(f.i)).rejects.toThrow('authorized');
  });
  it('rejects queued receipts that purport to deliver spendable cash', () => {
    expect(() => verifyParkingReceipt({ key: 'EXAMPLE-leg', kind: 'withdraw', amount: '100', asset: null },
      { key: 'EXAMPLE-leg', state: 'pending', spent: '0', received: '100', finalized: true, slot: '1', source: 'EXAMPLE-source', reference: 'EXAMPLE-ref' })).toThrow('not cash');
  });
  it('rejects a regressed finalized observation', () => { const s = snapshot(); expect(() => assertParkingSnapshot(s, intent(), now, '101')).toThrow(); });
});

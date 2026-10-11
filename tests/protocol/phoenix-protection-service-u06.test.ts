import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PhoenixProtectionService, type ProtectionIO, type ProtectionRepository } from '../../server/protocol/phoenix/protection-service';
import { phoenixIntentHash, type PhoenixIntent, type PhoenixAttemptInput, type StoredPhoenixOperation } from '../../server/protocol/phoenix/operation-store';
import { PhoenixSafetyService } from '../../server/protocol/phoenix/safety-service';
import { phoenixSafetyUnavailable } from '../../server/protocol/phoenix/safety-routes';
import { type ProtectionProgress } from '../../server/protocol/phoenix/protection-contract';
import { authority, intent, key, lifetime, now, pin } from '../helpers/phoenix-orders';
import { snapshot, request, leg } from '../helpers/phoenix-protection';

const copy = structuredClone;
class MemoryOperations implements ProtectionRepository {
  op?: StoredPhoenixOperation; attempt?: PhoenixAttemptInput; inFlight = false; lostClaim = false;
  async findProtection(r: ReturnType<typeof request>) {
    if (!this.op) return null;
    if (JSON.stringify(this.op.intent.protection!.request) !== JSON.stringify(r)) throw new Error('replay');
    return copy(this.op);
  }
  async prepare(i: PhoenixIntent) {
    if (this.op) return { operation: copy(this.op), created: false };
    this.op = { id: 'EXAMPLE-operation', bot_id: i.botId, request_key: i.requestKey, kind: i.kind, intent: copy(i), intent_hash: phoenixIntentHash(i),
      state: 'prepared', revision: 0, created_at: new Date(now), observation: { protection: { step: 0, before: i.protection!.before,
        after: i.protection!.before, remainingLegs: i.protection!.before.legs, allOrdersCancelled: false, protected: false } } };
    return { operation: copy(this.op), created: true };
  }
  async read() { return { operation: copy(this.op!), attempt: this.attempt && copy(this.attempt) }; }
  async annotatePrepared(_b: string, _o: string, _id: string, revision: number, data: Record<string, unknown>) {
    if (this.op!.revision !== revision || this.op!.state !== 'prepared') throw new Error('CAS');
    this.op!.observation = copy(data); this.op!.revision++; return copy(this.op!);
  }
  async recordAttempt(_b: string, _o: string, _id: string, revision: number, attempt: PhoenixAttemptInput) {
    if (this.op!.revision !== revision || this.op!.state !== 'prepared') throw new Error('CAS');
    this.attempt = copy(attempt); this.op!.state = 'submission_pending'; this.op!.revision++;
    if (this.lostClaim) throw new Error('lost DB acknowledgement');
    return { created: true, attempt: {} as any };
  }
  async observe(_b: string, _o: string, _id: string, revision: number, state: any, evidence: any) {
    if (this.op!.revision !== revision) throw new Error('CAS');
    this.op!.state = state; this.op!.observation = copy(evidence); this.op!.revision++; return copy(this.op!);
  }
  async protectionInFlight() { return this.inFlight; }
}
function fixture() {
  const store = new MemoryOperations(); let s = snapshot();
  let sends = 0, signs = 0, reads = 0, failTp = false, timeout = false, staleAfter = false, flipAfter = false;
  let receiptOutcome: 'confirmed' | 'failed' = 'confirmed';
  let readHook: ((count: number) => void) | undefined;
  const io: ProtectionIO = {
    snapshot: async () => { reads++; readHook?.(reads); return copy(s); },
    lifetime: async () => lifetime, blockHeight: async () => 100,
    withSigner: async (_r, fn) => { signs++; return fn(key.secretKey); },
    submit: async () => {
      sends++;
      expect(store.op!.state).toBe('submission_pending');
      const progress = store.op!.observation!.protection as ProtectionProgress;
      const c = store.op!.intent.protection!.commands[progress.step];
      receiptOutcome = failTp && c.kind === 'place' && c.role === 'tp' ? 'failed' : 'confirmed';
      if (receiptOutcome === 'confirmed') {
        if (c.kind === 'cancel-book') s.orderbookOrderIds = [];
        if (c.kind === 'cancel-conditional') s.legs = s.legs.filter(l => l.surface !== 'conditional' || l.index !== c.index);
        if (c.kind === 'cancel-standalone') s.legs = s.legs.filter(l => l.surface !== 'standalone' || l.direction !== c.direction);
        if (c.kind === 'place') s.legs.push(leg({ index: c.role === 'sl' ? 2 : 3, sequence: String(sends + 2), direction: c.direction,
          side: c.side, triggerTicks: c.triggerTicks, executionTicks: c.executionTicks, remainingLots: c.baseLots }));
      }
      if (!staleAfter) s.slot = String(100 + sends);
      if (flipAfter) { s.position.side = 'short'; s.position.sequence = 2; s.position.epoch = 'EXAMPLE-flipped'; }
      return store.attempt!.signature;
    },
    receipt: async (op, attempt) => timeout ? null : { venue: 'phoenix', trader: s.trader, operationId: op.id, intentHash: op.intent_hash,
      signature: attempt.signature, finalized: true, slot: String(100 + sends), outcome: receiptOutcome, source: 'EXAMPLE-chain', reference: 'EXAMPLE-receipt' },
  };
  const service = () => new PhoenixProtectionService(store, io, pin, () => now);
  return { store, io, service, state: () => s, setState: (value: typeof s) => { s = value; }, sends: () => sends, signs: () => signs,
    failTp: () => { failTp = true; }, timeout: (value = true) => { timeout = value; }, staleAfter: () => { staleAfter = true; },
    flipAfter: () => { flipAfter = true; }, readHook: (fn: (count: number) => void) => { readHook = fn; } };
}
const progress = (op: StoredPhoenixOperation) => op.observation!.protection as ProtectionProgress;

describe('U06 durable replacement, cancellation and safety recovery', () => {
  it('replaces and proves both intended legs with before/after authoritative state', async () => {
    const f = fixture(); f.state().legs = [leg()];
    const op = await f.service().execute(request());
    expect(op.state).toBe('completed'); expect(f.sends()).toBe(3);
    expect(progress(op)).toMatchObject({ step: 3, protected: true, allOrdersCancelled: false });
    expect(progress(op).before.legs).toHaveLength(1); expect(progress(op).remainingLegs).toHaveLength(2);
    expect(progress(op).after.position).toEqual(progress(op).before.position);
  });
  it('persists which leg remains after a partial replace failure', async () => {
    const f = fixture(); f.state().legs = [leg()]; f.failTp();
    const op = await f.service().execute(request());
    expect(op.state).toBe('failed'); expect(progress(op).protected).toBe(false);
    expect(progress(op).remainingLegs).toHaveLength(1);
    expect(progress(op).remainingLegs[0]).toMatchObject({ direction: 'less', triggerTicks: '14000', remainingLots: '200' });
    expect(progress(op).before.legs).toHaveLength(1);
  });
  it('does not resubmit after a timeout or restart and resumes only after an exact receipt', async () => {
    const f = fixture(); f.timeout();
    const op = await f.service().execute(request());
    expect(op.state).toBe('submission_pending'); expect(f.sends()).toBe(1);
    await f.service().execute(request()); expect(f.sends()).toBe(1);
    f.timeout(false); expect((await f.service().execute(request())).state).toBe('prepared');
    expect((await f.service().execute(request())).state).toBe('completed'); expect(f.sends()).toBe(2);
  });
  it('never sends after losing the durable signature claim acknowledgement', async () => {
    const f = fixture(); f.store.lostClaim = true; f.timeout();
    expect((await f.service().execute(request())).state).toBe('submission_pending');
    expect(f.sends()).toBe(0); await f.service().execute(request()); expect(f.sends()).toBe(0);
  });
  it('requires post-transaction state at or beyond the finalized receipt slot', async () => {
    const f = fixture(); f.staleAfter();
    const op = await f.service().execute(request());
    expect(op.state).toBe('submission_pending'); expect(progress(op).protected).toBe(false);
    expect(f.sends()).toBe(1);
  });
  it('records a flip after placement instead of claiming protection on the new side', async () => {
    const f = fixture(); f.flipAfter();
    const op = await f.service().execute(request());
    expect(op.state).toBe('failed'); expect(progress(op).protected).toBe(false);
    expect(progress(op).after.position.side).toBe('short'); expect(f.sends()).toBe(1);
  });
  it('refuses replacement when remaining quantity changes before signing', async () => {
    const f = fixture(); f.readHook(n => { if (n === 3) f.state().position.baseLots = '50'; });
    const op = await f.service().execute(request());
    expect(op.state).toBe('failed'); expect(f.signs()).toBe(0); expect(f.sends()).toBe(0);
  });
  it('does not cancel a reused conditional index', async () => {
    const f = fixture(); f.state().legs = [leg()];
    f.readHook(n => { if (n === 2) f.state().legs[0].sequence = '20'; });
    const op = await f.service().execute(request({ action: 'cancel' }));
    expect(op.state).toBe('failed'); expect(f.sends()).toBe(0);
    expect(progress(op).remainingLegs[0].sequence).toBe('20');
  });
  it('handles a parent-fill/cancel race by rereading children, without a duplicate cancel', async () => {
    const f = fixture(); f.state().orderbookOrderIds = ['EXAMPLE-parent']; f.state().legs = [leg({ parentOrderId: 'EXAMPLE-parent' })];
    f.readHook(n => { if (n === 4) f.state().legs = []; });
    const op = await f.service().execute(request({ action: 'pause' }));
    expect(op.state).toBe('completed'); expect(progress(op).allOrdersCancelled).toBe(true); expect(f.sends()).toBe(1);
  });
  it('cancels book, orphan conditional and standalone surfaces before reporting all cancelled', async () => {
    const f = fixture(); f.state().orderbookOrderIds = ['EXAMPLE-parent']; f.state().standaloneFunder = key.publicKey.toBase58();
    f.state().legs = [leg({ parentOrderId: 'EXAMPLE-orphan' }), leg({ surface: 'standalone', index: 0, sequence: '2' })];
    const op = await f.service().execute(request({ action: 'pause' }));
    expect(op.state).toBe('completed'); expect(f.sends()).toBe(3); expect(progress(op).allOrdersCancelled).toBe(true);
    expect(progress(op).remainingLegs).toEqual([]);
  });
  it('does not claim cancellation while another placement can still land', async () => {
    const f = fixture(); f.store.inFlight = true;
    const op = await f.service().execute(request({ action: 'pause' }));
    expect(op.state).toBe('failed'); expect(progress(op).allOrdersCancelled).toBe(false);
  });
  it('refuses a replay payload change and cannot authorize a send from an incomplete snapshot', async () => {
    const f = fixture(); f.timeout(); await f.service().execute(request());
    await expect(f.service().execute(request({ action: 'cancel' }))).rejects.toThrow('replay');
    const g = fixture(); g.state().complete = false as any;
    await expect(g.service().execute(request())).rejects.toThrow('unavailable'); expect(g.signs()).toBe(0);
  });
  it('keeps pause close accessible even when cancellation is unavailable', async () => {
    let closed = 0;
    const a = authority(); delete a.protection; a.position.side = 'long'; a.position.baseLots = '200';
    const i = intent({ action: 'close', side: 'sell', protection: undefined });
    const service = new PhoenixSafetyService({ execute: async () => { closed++; return { state: 'unknown', data: {} } as any; } },
      { execute: async () => { throw new Error('partial API'); } }, { before: async () => a, after: async () => null }, () => now);
    const result = await service.pause(request({ action: 'pause' }), i);
    expect(closed).toBe(1); expect(result.allOrdersCancelled).toBe(false); expect(result.positionClosed).toBe(false);
  });
  it('requires final position proof, not an accepted/partial close receipt', async () => {
    const a = authority(); a.position.side = 'long'; a.position.baseLots = '200';
    const after = authority(); delete after.protection;
    const order = { state: 'settled', data: { remainingPositionLots: '0', attempt: { signature: 'EXAMPLE-signature' } } } as any;
    const reads = { before: async () => a, after: async () => ({ signature: 'EXAMPLE-signature', finalized: true as const, source: 'EXAMPLE-chain', reference: 'EXAMPLE-proof', authority: after }) };
    const service = new PhoenixSafetyService({ execute: async () => order }, { execute: async () => { throw new Error('unused'); } }, reads, () => now);
    const i = intent({ action: 'close', side: 'sell' });
    expect((await service.close(i)).positionClosed).toBe(true);
    after.position.side = 'long'; after.position.baseLots = '10'; expect((await service.close(i)).positionClosed).toBe(false);
    after.position.side = 'flat'; after.position.baseLots = '0'; order.state = 'accepted'; expect((await service.close(i)).positionClosed).toBe(false);
  });
  it('dispatches owned Phoenix safety routes before generic custody and keeps activation disabled', () => {
    const routes = readFileSync(new URL('../../server/routes.ts', import.meta.url), 'utf8');
    for (const route of ['close-position', 'close-market-position', 'set-tpsl', 'cancel-tpsl']) {
      const part = routes.slice(routes.indexOf(`app.post("/api/trading-bots/:id/${route}"`));
      expect(part.indexOf('phoenixSafetyUnavailable')).toBeLessThan(part.indexOf('storage.getWallet'));
      expect(part.indexOf('bot.walletAddress !== req.walletAddress')).toBeLessThan(part.indexOf('phoenixSafetyUnavailable'));
    }
    const pause = routes.slice(routes.indexOf('app.patch("/api/trading-bots/:id"'));
    expect(pause.indexOf("phoenixSafetyUnavailable('pause')")).toBeLessThan(pause.indexOf('// PAUSE BOT = CLOSE POSITION'));
    expect(phoenixSafetyUnavailable('pause')).toMatchObject({ allOrdersCancelled: false, positionClosed: false, protectionState: 'unknown' });
  });
});

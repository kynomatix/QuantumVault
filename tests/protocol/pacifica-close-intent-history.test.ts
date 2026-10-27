import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../server/trading/close-intent-store', () => ({ closeIntentStore: {} }));
vi.mock('../../server/trading/signal-bot-close-intent-accounting', () => ({ accountDurableClose: vi.fn() }));
import { closeObjectiveMet, closeReleaseEvidence } from '../../server/trading/signal-bot-close-intent';
import { classifyCloseFetchFailure } from '../../server/protocol/pacifica/close-send-outcome';
import { intent, snapshot, orders } from '../helpers/close-intent-fixtures';

afterEach(() => vi.useRealTimers());
describe('B1 release evidence, without an order-history retry authority', () => {
  it('releases only expired, independently observed original-account exposure', () => {
    const row = intent();
    expect(closeReleaseEvidence(row, Date.now(), snapshot(), snapshot(), orders())).toBe(true);
  });
  const mutations = {
    'missing admitted header': (r: any) => { delete r.attempt_log[0].timestamp; },
    'incomplete attempt log': (r: any) => { r.attempt_count = 2; },
    'contradictory evidence': (r: any) => { r.last_evidence.contradiction = true; },
    'missing numeric lower bound': (r: any) => { r.last_evidence = {}; r.position_epoch.strictBaseline = null; },
  };
  it.each(Object.entries(mutations))('denies %s', (_label, mutate) => {
    const r = intent(); mutate(r); expect(closeReleaseEvidence(r, Date.now(), snapshot(), snapshot(), orders())).toBe(false);
  });
  it.each(['account','environment','complete','fresh','noDedup','lastOrderId','venueClockMs','dispatchedAt'])(
    'denies each invalid position-read clause: %s', field => {
      const a = snapshot(), b = snapshot();
      (b.evidence as any)[field] = field === 'lastOrderId' ? 6 : field === 'venueClockMs' ? undefined : field === 'dispatchedAt' ? Date.now() - 400000 : false;
      expect(closeReleaseEvidence(intent(), Date.now(), a, b, orders())).toBe(false);
    });
  it('denies a repeated request, changed exposure and a missing exact decimal', () => {
    const a = snapshot(), b = snapshot(); b.evidence.requestId = a.evidence.requestId;
    expect(closeReleaseEvidence(intent(), Date.now(), a, b, orders())).toBe(false);
    expect(closeReleaseEvidence(intent(), Date.now(), snapshot(), snapshot('0.5'), orders())).toBe(false);
    const numericOnly = snapshot(); delete numericOnly.positions[0].sizeBaseExact;
    expect(closeReleaseEvidence(intent(), Date.now(), snapshot(), numericOnly, orders())).toBe(false);
  });
  it.each(['account','environment','complete','fresh','noDedup','lastOrderId','dispatchedAt','receivedAt'])(
    'denies each invalid open-order clause: %s', field => {
      const o = orders(); (o as any)[field] = field === 'lastOrderId' ? 6 : field === 'dispatchedAt' ? Date.now() - 400000 : field === 'receivedAt' ? 0 : false;
      expect(closeReleaseEvidence(intent(), Date.now(), snapshot(), snapshot(), o)).toBe(false);
    });
  it('uses the maximum expiry from all attempts and DB time, not an advanced local clock', () => {
    const r = intent(), now = Date.now();
    r.attempt_log[0].timestamp = now - 100000;
    vi.useFakeTimers(); vi.setSystemTime(now + 90000);
    const a = snapshot(), b = snapshot(); a.evidence.venueClockMs = now - 90000; b.evidence.venueClockMs = now - 90000;
    expect(closeReleaseEvidence(r, now, a, b, orders())).toBe(false);
    expect(closeReleaseEvidence(r, now + 400000, a, b, orders())).toBe(false);
  });
  it('permits resting TP/SL and limit orders, while a live market order blocks', () => {
    const o = orders(); o.orders = ['limit','stop_loss_market','take_profit_market'].map(orderType => ({ market: 'BTC-PERP', orderType }));
    expect(closeReleaseEvidence(intent(), Date.now(), snapshot(), snapshot(), o)).toBe(true);
    o.orders.push({ market: 'BTC-PERP', orderType: 'market' });
    expect(closeReleaseEvidence(intent(), Date.now(), snapshot(), snapshot(), o)).toBe(false);
  });
  it('requires acknowledged order identity plus a post-receipt exact objective', () => {
    const r = intent(); expect(closeObjectiveMet(r, snapshot('0'))).toBe(false);
    r.attempt_log[0].outcome = { kind: 'acknowledged', orderId: 'EXAMPLE_ORDER' }; r.attempt_log[0].receivedAt = Date.now() - 10;
    expect(closeObjectiveMet(r, snapshot('0'))).toBe(true);
    r.close_kind = 'partial'; r.requested_size_base = '0.25';
    expect(closeObjectiveMet(r, snapshot('0.75'))).toBe(true);
    expect(closeObjectiveMet(r, snapshot('0'))).toBe(false);
    r.attempt_log[0].receivedAt = Date.now() + 100;
    expect(closeObjectiveMet(r, snapshot('0.75'))).toBe(false);
  });
});
describe('typed pre-entry failures', () => {
  it.each(['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT'])(
    'allows exactly cause.code %s', code => expect(classifyCloseFetchFailure({ cause: { code } }).kind).toBe('not_entered'));
  it.each(['ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','AbortError','socket hang up','EXAMPLE'])(
    'keeps %s ambiguous', code => expect(classifyCloseFetchFailure({ cause: { code }, name: code }).kind).toBe('ambiguous'));
  it('does not trust an unwrapped top-level code', () => expect(classifyCloseFetchFailure({ code: 'ENOTFOUND' }).kind).toBe('ambiguous'));
});

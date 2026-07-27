/**
 * WO2B2DC3 — Cutover verification for agent-sol-withdraw-client.ts
 *
 * Covers: exact key names / field names / origins (no provisional variants);
 * HTTP 200-only success; pending / re-key / manual_review classification;
 * ledger blockers (all four types) block NEW loop_return but not Check/Retry;
 * malformed debit in malformedKeys; negative deficit + debit request IDs;
 * cleanup paths (persist fail / remove fail / success); truly concurrent same-
 * credit race under real queued exclusive lock; lock unavailable = zero money
 * effects; file-system scanner checks; finalization mismatch preservation;
 * persistence-before-request; replay; adoption; migration; idempotency;
 * stale amount binds inside lock; balance cap (capLamports) option; hostile
 * ledger validation (cross-prefix / suffix mismatch); withdraw_conflict terminal
 * clear; UUID/min/round-trip record validation; insecure random blocked; cleanup
 * evidence non-blocking (malformed_record_cleaned + invalid_request_record);
 * coordinateMigrateLegacy locked; debit-persist and clear-failure one-debit
 * invariants; full lifecycle proof (blocked→invalid_request_record→cleanup→
 * success); countBlockingAnomalies UI helper; capProvider post-credit ordering,
 * failure/null/zero retention, concurrent waiter skip.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  coordinateWithdraw,
  coordinateCheckRetry,
  coordinateCleanupMalformed,
  coordinateLoopReturn,
  coordinateMigrateLegacy,
  readActiveRecordForDisplay,
  readLedgerViewForDisplay,
  countBlockingAnomalies,
  migrateLegacyPendingReturn,
  putLedgerEntry,
  writeAnomaly,
  fnv1a,
  requestKey,
  creditKey,
  debitKey,
  anomalyKeyFor,
  legacyPendingReturnKey,
  DURABLE_WITHDRAW_ENDPOINT,
  MIN_WITHDRAW_LAMPORTS,
  lamportsToSolDisplay,
  solNumberToLamports,
  lamportsRoundTripExactly,
  computeReturnLamports,
  maxSendableLamportsFromSol,
  type DurableWithdrawRecord,
  type StorageLike,
  type LedgerEntry,
  type CoordinatorOutcome,
} from '@/lib/agent-sol-withdraw-client';

// ─── FakeStorage ─────────────────────────────────────────────────────────────

class FakeStorage implements StorageLike {
  private map = new Map<string, string>();
  ops: Array<{ op: 'get' | 'set' | 'remove'; key: string }> = [];
  failSetFor: ((k: string) => boolean) | null = null;
  failRemoveFor: ((k: string) => boolean) | null = null;
  failGetFor: ((k: string) => boolean) | null = null;
  failEnumerate = false;

  get length() { return this.map.size; }
  key(i: number) {
    if (this.failEnumerate) throw new Error('enumerate failed');
    const keys = Array.from(this.map.keys());
    return i < keys.length ? keys[i] : null;
  }
  getItem(k: string): string | null {
    if (this.failGetFor?.(k)) throw new Error(`get failed: ${k}`);
    this.ops.push({ op: 'get', key: k });
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.ops.push({ op: 'set', key: k });
    if (this.failSetFor?.(k)) throw new Error('QuotaExceededError');
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.ops.push({ op: 'remove', key: k });
    if (this.failRemoveFor?.(k)) throw new Error('remove failed');
    this.map.delete(k);
  }
  raw(k: string) { return this.map.get(k) ?? null; }
  put(k: string, v: string) { this.map.set(k, v); }
  delete(k: string) { this.map.delete(k); }
  clearOps() { this.ops = []; }
  allKeys() { return Array.from(this.map.keys()); }
}

// ─── Lock helpers ─────────────────────────────────────────────────────────────

function setGlobalNavigator(value: unknown) {
  Object.defineProperty(globalThis, 'navigator', {
    value,
    configurable: true,
    writable: true,
  });
}
function installFakeLock(impl: (name: string, opts: unknown, fn: () => Promise<unknown>) => Promise<unknown>) {
  setGlobalNavigator({ locks: { request: impl } });
}
function useSequentialLock() {
  installFakeLock((_n, _o, fn) => fn());
}
function useLockUnavailable() {
  // navigator exists but locks is absent → helper sees nav?.locks as undefined.
  setGlobalNavigator({ locks: undefined });
}
function useLockThrows() {
  installFakeLock(async () => { throw new DOMException('Lock request failed', 'NotSupportedError'); });
}

/**
 * A real single-slot queued exclusive lock — second caller's fn() does NOT
 * start until the first caller's fn() fully resolves. Used for concurrent tests.
 */
function makeSingleQueuedExclusiveLock(): { request: (name: string, opts: unknown, fn: () => Promise<unknown>) => Promise<unknown> } {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    request: (_name: string, _opts: unknown, fn: () => Promise<unknown>): Promise<unknown> => {
      const result = chain.then(() => fn());
      // Chain absorbs errors so the next queued caller can still run.
      chain = result.then(() => {}, () => {});
      return result;
    },
  };
}

// ─── Fetch mock helpers ───────────────────────────────────────────────────────

type MockResp = { status: number; json: () => Promise<unknown> };
const mkRes = (status: number, body: unknown): MockResp => ({ status, json: async () => body });

function capturedFetch(responses: MockResp[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let idx = 0;
  const fn = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return responses[idx++] ?? mkRes(500, { error: 'no more responses' });
  };
  return { fn, calls };
}

const WALLET = 'Wallet11111111111111111111111111111111111111';
const AM = 5_000_000n; // 0.005 SOL

function successBody(r: DurableWithdrawRecord, sig = 'sig-ok') {
  return { success: true, state: 'succeeded', clientRequestId: r.clientRequestId, withdrawnLamports: r.amountLamports, signature: sig };
}
function pendingBody(r: DurableWithdrawRecord) {
  return { state: 'pending', pending: true, clientRequestId: r.clientRequestId, message: 'Processing' };
}
function rekeBody(r: DurableWithdrawRecord) {
  return { state: 'pending', pending: true, clientRequestId: r.clientRequestId, error: 'Idempotency key already used. Replaying the same request is safe.' };
}
function manualBody(r: DurableWithdrawRecord) {
  return { state: 'pending', pending: true, clientRequestId: r.clientRequestId, message: 'Manual review needed.' };
}
function failedBody(r: DurableWithdrawRecord) {
  return { state: 'failed', terminal: true, clientRequestId: r.clientRequestId, error: 'Withdrawal failed.' };
}

/**
 * Directly place a record in storage for test setup (bypasses lock).
 * Default clientRequestId is crypto.randomUUID() to satisfy the UUID-form
 * validation added in C2; override with a specific UUID if the test needs
 * to check the exact value.
 */
function placeRecord(s: FakeStorage, overrides: Partial<DurableWithdrawRecord> & { amountLamports: string }): DurableWithdrawRecord {
  const rec: DurableWithdrawRecord = {
    version: 1,
    clientRequestId: crypto.randomUUID(),
    walletAddress: WALLET,
    origin: 'wallet_management',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  s.put(requestKey(WALLET), JSON.stringify(rec));
  return rec;
}

beforeEach(() => {
  useSequentialLock();
});

// ─── A: Storage key exact names ───────────────────────────────────────────────

describe('A — storage key names', () => {
  it('requestKey uses canonical namespace (no provisional qv:solw:v1)', () => {
    const k = requestKey(WALLET);
    expect(k).toBe(`qv-agent-sol-withdraw:v1:${WALLET}`);
    expect(k).not.toContain('qv:solw:v1');
    expect(k).not.toContain('solw');
  });

  it('creditKey uses correct prefix', () => {
    const k = creditKey(WALLET, 'mysig');
    expect(k).toBe(`qv-loop-return-credit:v1:${WALLET}:mysig`);
    expect(k).not.toContain(':solw:');
  });

  it('debitKey uses correct prefix', () => {
    const k = debitKey(WALLET, 'req-xyz');
    expect(k).toBe(`qv-loop-return-debit:v1:${WALLET}:req-xyz`);
  });

  it('anomalyKeyFor uses correct prefix with fnv1a seed suffix', () => {
    const k = anomalyKeyFor(WALLET, 'test_code', 'some-seed');
    expect(k.startsWith(`qv-loop-return-anomaly:v1:${WALLET}:`)).toBe(true);
    expect(k).not.toContain(':solw:');
    expect(k).toContain(fnv1a('some-seed'));
  });

  it('legacyPendingReturnKey unchanged', () => {
    expect(legacyPendingReturnKey(WALLET)).toBe(`qv-loop-pending-return:${WALLET}`);
  });
});

// ─── B: Record field exact names ─────────────────────────────────────────────

describe('B — record field names', () => {
  it('record written by coordinateWithdraw has exact field names', async () => {
    const s = new FakeStorage();
    let captured: DurableWithdrawRecord | null = null;
    await coordinateWithdraw(WALLET, AM, 'wallet_management', {
      storage: s,
      fetchImpl: async () => {
        const raw = s.raw(requestKey(WALLET));
        captured = raw ? JSON.parse(raw) : null;
        return mkRes(200, successBody(captured!));
      },
    });
    expect(captured).not.toBeNull();
    expect(captured!.version).toBe(1);
    expect(typeof captured!.clientRequestId).toBe('string');
    expect(captured!.walletAddress).toBe(WALLET);
    expect(typeof captured!.amountLamports).toBe('string');
    // no provisional field names
    expect((captured as unknown as Record<string, unknown>).lamports).toBeUndefined();
    expect((captured as unknown as Record<string, unknown>).wallet).toBeUndefined();
  });

  it('wallet_management origin stored correctly (not wallet_mgmt)', async () => {
    const s = new FakeStorage();
    let captured: DurableWithdrawRecord | null = null;
    await coordinateWithdraw(WALLET, AM, 'wallet_management', {
      storage: s,
      fetchImpl: async () => {
        captured = JSON.parse(s.raw(requestKey(WALLET))!);
        return mkRes(200, successBody(captured!));
      },
    });
    expect(captured!.origin).toBe('wallet_management');
    expect(captured!.origin).not.toBe('wallet_mgmt');
  });

  it('loop_return origin stored correctly', async () => {
    const s = new FakeStorage();
    const creditSig = 'sig-credit-x1';
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: String(AM), at: new Date().toISOString(),
    } satisfies LedgerEntry));

    let captured: DurableWithdrawRecord | null = null;
    await coordinateWithdraw(WALLET, AM, 'loop_return', {
      storage: s,
      fetchImpl: async () => {
        captured = JSON.parse(s.raw(requestKey(WALLET))!);
        return mkRes(200, successBody(captured!));
      },
    });
    expect(captured!.origin).toBe('loop_return');
    expect(captured!.origin).not.toBe('loop_mgmt');
  });
});

// ─── C: HTTP status gating ────────────────────────────────────────────────────

describe('C — HTTP status gating', () => {
  it('HTTP 200 + success shape → success outcome', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const { fn } = capturedFetch([mkRes(200, successBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('success');
    if (out.outcome === 'success') expect(out.amountLamports).toBe(String(AM));
    // record cleared on success
    expect(s.raw(requestKey(WALLET))).toBeNull();
  });

  it('HTTP 201 + success shape → NOT success (record retained)', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const { fn } = capturedFetch([mkRes(201, successBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).not.toBe('success');
    // record retained
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('HTTP 500 + success shape → NOT success (record retained)', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const { fn } = capturedFetch([mkRes(500, successBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).not.toBe('success');
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('HTTP 200 + wrong withdrawnLamports → mismatched (record retained)', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const wrongBody = { success: true, state: 'succeeded', clientRequestId: rec.clientRequestId, withdrawnLamports: '1', signature: 'sig' };
    const { fn } = capturedFetch([mkRes(200, wrongBody)]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('mismatched');
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('terminal failure on any status clears record (no debit written)', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM), origin: 'loop_return' });
    const { fn } = capturedFetch([mkRes(400, failedBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('terminal_failure');
    expect(s.raw(requestKey(WALLET))).toBeNull();
    // no debit written on terminal failure
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.debitLamports).toBe(0n);
  });
});

// ─── D: Pending classification ────────────────────────────────────────────────

describe('D — pending classification', () => {
  it('202 + pending:true + exact ID → pending with message', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const { fn } = capturedFetch([mkRes(202, pendingBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('pending');
    expect(s.raw(requestKey(WALLET))).not.toBeNull(); // retained
  });

  it('400 + pending:true + exact ID → pending with original re-key error text preserved', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const { fn } = capturedFetch([mkRes(400, rekeBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('pending');
    if (out.outcome === 'pending') {
      // original error text preserved (not replaced with generic)
      expect(out.message).toContain('Idempotency key');
    }
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('409 + pending:true + exact ID → manual_review', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const { fn } = capturedFetch([mkRes(409, manualBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('manual_review');
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('400 without pending:true is not classified as pending', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const body = { error: 'validation error' };
    const { fn } = capturedFetch([mkRes(400, body)]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).not.toBe('pending');
  });
});

// ─── E: Ledger blockers ───────────────────────────────────────────────────────

describe('E — ledger blockers block new loop_return, not Check/Retry', () => {
  it('anomaly blocks coordinateWithdraw with loop_return origin, zero fetches', async () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'test_code', 'seed-x', { note: 'blocker' });
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateWithdraw(WALLET, AM, 'loop_return', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('blocked_by_ledger');
    expect(calls).toHaveLength(0);
  });

  it('malformed key at credit prefix blocks new loop_return', async () => {
    const s = new FakeStorage();
    s.put(creditKey(WALLET, 'badsig'), 'THIS IS NOT JSON');
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateWithdraw(WALLET, AM, 'loop_return', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('blocked_by_ledger');
    expect(calls).toHaveLength(0);
  });

  it('malformed key at debit prefix blocks new loop_return', async () => {
    const s = new FakeStorage();
    s.put(debitKey(WALLET, 'req-broken'), '{ invalid }');
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateWithdraw(WALLET, AM, 'loop_return', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('blocked_by_ledger');
    expect(calls).toHaveLength(0);
  });

  it('negative ledger balance blocks new loop_return', async () => {
    // More debit than credit
    const s = new FakeStorage();
    const creditSig = 'sig-c1';
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: '1000', at: new Date().toISOString(),
    } satisfies LedgerEntry));
    s.put(debitKey(WALLET, 'req-d1'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'req-d1', origin: 'loop_return', lamports: '5000000', at: new Date().toISOString(),
    } satisfies LedgerEntry));
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateWithdraw(WALLET, AM, 'loop_return', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('blocked_by_ledger');
    expect(calls).toHaveLength(0);
  });

  it('unreadable storage enumeration blocks new loop_return', async () => {
    const s = new FakeStorage();
    // Seed one credit so storage.length > 0 and the enumeration loop actually
    // calls storage.key(i), which triggers the failEnumerate throw.
    s.put(creditKey(WALLET, 'seed-sig'), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: 'seed-sig', lamports: '1000', at: new Date().toISOString(),
    } satisfies LedgerEntry));
    s.failEnumerate = true;
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateWithdraw(WALLET, AM, 'loop_return', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('blocked_by_ledger');
    expect(calls).toHaveLength(0);
  });

  it('anomaly does NOT block coordinateCheckRetry of active record', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM), origin: 'loop_return' });
    writeAnomaly(s, WALLET, 'test_code', 'seed-x', { note: 'blocker' });
    const { fn } = capturedFetch([mkRes(200, successBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('success');
  });

  it('malformed key does NOT block coordinateCheckRetry of active record', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM), origin: 'loop_return' });
    s.put(debitKey(WALLET, 'bad'), 'NOT_JSON');
    const { fn } = capturedFetch([mkRes(200, successBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('success');
  });

  it('negative balance does NOT block coordinateCheckRetry of active record', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM), origin: 'loop_return' });
    s.put(debitKey(WALLET, 'big'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'big', origin: 'loop_return', lamports: '999999999', at: new Date().toISOString(),
    } satisfies LedgerEntry));
    const { fn } = capturedFetch([mkRes(200, successBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('success');
  });

  it('wallet_management origin ignores ledger blockers (no ledger check)', async () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'test_code', 'seed-x', { note: 'blocker' });
    const { fn, calls } = capturedFetch([]);
    // wallet_management coordinateWithdraw: no active record → creates new one
    // Ledger blockers only apply to loop_return origin
    const out = await coordinateWithdraw(WALLET, AM, 'wallet_management', {
      storage: s,
      fetchImpl: async () => {
        const raw = s.raw(requestKey(WALLET));
        const rec = JSON.parse(raw!) as DurableWithdrawRecord;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
    expect(calls).toHaveLength(0); // capturedFetch not used — own fetchImpl above
  });
});

// ─── F: Malformed debit in malformedKeys (not omitted) ───────────────────────

describe('F — malformed debit included in malformedKeys', () => {
  it('malformed debit key appears in malformedKeys, not summed', () => {
    const s = new FakeStorage();
    // Valid credit
    const creditSig = 'sig-ok';
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: '10000', at: new Date().toISOString(),
    } satisfies LedgerEntry));
    // Malformed debit (wrong JSON structure — missing requestId)
    s.put(debitKey(WALLET, 'malformed-req'), '{"v":1,"kind":"debit","lamports":"not-a-number"}');
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.malformedKeys).toHaveLength(1);
    expect(ledger.malformedKeys[0]).toContain(debitKey(WALLET, 'malformed-req').replace(`${WALLET}:`, `${WALLET}:`));
    // Malformed key is a blocker but not summed into debit
    expect(ledger.debitLamports).toBe(0n);
    expect(ledger.creditLamports).toBe(10000n);
    expect(ledger.negative).toBe(false); // malformed does not count as negative
  });
});

// ─── G: Exact negative deficit + debit request IDs ───────────────────────────

describe('G — negative deficit and debit request IDs', () => {
  it('reports exact deficit and debit request IDs when ledger is negative', () => {
    const s = new FakeStorage();
    // credit = 1000 lamports
    const sig1 = 'sig-c1';
    s.put(creditKey(WALLET, sig1), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: sig1, lamports: '1000', at: new Date().toISOString(),
    } satisfies LedgerEntry));
    // debit 1 = 2000 lamports
    s.put(debitKey(WALLET, 'req-A'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'req-A', origin: 'loop_return', lamports: '2000', at: new Date().toISOString(),
    } satisfies LedgerEntry));
    // debit 2 = 1000 lamports
    s.put(debitKey(WALLET, 'req-B'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'req-B', origin: 'loop_return', lamports: '1000', at: new Date().toISOString(),
    } satisfies LedgerEntry));

    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.negative).toBe(true);
    expect(ledger.creditLamports).toBe(1000n);
    expect(ledger.debitLamports).toBe(3000n);
    expect(ledger.deficitLamports).toBe(2000n);
    expect(ledger.availableLamports).toBe(-2000n);
    expect(ledger.debitRequestIds).toContain('req-A');
    expect(ledger.debitRequestIds).toContain('req-B');
    expect(ledger.debitRequestIds).toHaveLength(2);
  });
});

// ─── H: Active record retry under ledger blockers ────────────────────────────

describe('H — coordinateWithdraw adopts active record and drives (bypasses blockers)', () => {
  it('coordinateWithdraw with active loop_return record + anomaly → drives (not blocked)', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM), origin: 'loop_return' });
    writeAnomaly(s, WALLET, 'test_code', 'seed', { note: 'blocker' });
    const { fn } = capturedFetch([mkRes(200, successBody(rec))]);
    // coordinateWithdraw adopts the active record → bypasses ledger blocker check
    const out = await coordinateWithdraw(WALLET, AM, 'loop_return', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('success');
  });

  it('coordinateWithdraw with active wallet_management record → drives regardless of origin mismatch', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM), origin: 'wallet_management' });
    const { fn } = capturedFetch([mkRes(200, successBody(rec))]);
    const out = await coordinateWithdraw(WALLET, AM, 'wallet_management', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('success');
  });
});

// ─── I: Malformed cleanup ─────────────────────────────────────────────────────

describe('I — coordinateCleanupMalformed', () => {
  it('nothing_to_clean when no record exists', async () => {
    const s = new FakeStorage();
    const out = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(out.outcome).toBe('nothing_to_clean');
  });

  it('valid_record_kept when active record is valid', async () => {
    const s = new FakeStorage();
    placeRecord(s, { amountLamports: String(AM) });
    const out = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(out.outcome).toBe('valid_record_kept');
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('cleaned: persists anomaly evidence then removes record', async () => {
    const s = new FakeStorage();
    s.put(requestKey(WALLET), '{ bad json ~~ }');
    const out = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(out.outcome).toBe('cleaned');
    // record removed
    expect(s.raw(requestKey(WALLET))).toBeNull();
    // anomaly evidence persisted (something in anomaly prefix)
    const anomalyKey = s.allKeys().find(k => k.startsWith(`qv-loop-return-anomaly:v1:${WALLET}:`));
    expect(anomalyKey).toBeDefined();
    // zero network calls (cleanup is storage-only — fetchImpl not in opts type)
    const sets = s.ops.filter(o => o.op === 'set');
    expect(sets.length).toBeGreaterThan(0); // anomaly written, not just removed
  });

  it('persist_failed_retained when anomaly write fails', async () => {
    const s = new FakeStorage();
    s.put(requestKey(WALLET), '{ bad json ~~ }');
    s.failSetFor = (k) => k.includes('anomaly');
    const out = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(out.outcome).toBe('persist_failed_retained');
    // record NOT removed
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('remove_failed_retained when remove fails after anomaly write succeeds', async () => {
    const s = new FakeStorage();
    s.put(requestKey(WALLET), '{ bad json ~~ }');
    s.failRemoveFor = (k) => k === requestKey(WALLET);
    const out = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(out.outcome).toBe('remove_failed_retained');
    // record still present (remove failed)
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('cleanup is storage-only (fetchImpl not in opts type)', async () => {
    const s = new FakeStorage();
    s.put(requestKey(WALLET), 'INVALID');
    // coordinateCleanupMalformed opts has no fetchImpl — the function never calls fetch.
    const out = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(out.outcome).toBe('cleaned');
    expect(s.raw(requestKey(WALLET))).toBeNull();
  });
});

// ─── J: Truly concurrent two-tab (real queued exclusive lock) ─────────────────

describe('J — truly concurrent two-tab: one credit, one fetch, one debit, zero availability', () => {
  it('second caller is NOT in lock body while first holds fetch gate; one credit, one debit', async () => {
    const lock = makeSingleQueuedExclusiveLock();
    setGlobalNavigator({ locks: lock });

    const s = new FakeStorage();
    const creditSig = 'sig-conc-j1';
    const proceeds = 5_000_000n;
    // Pre-seed the credit so it's available when the first caller's lock body starts.
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: String(proceeds), at: new Date().toISOString(),
    } satisfies LedgerEntry));

    let fetchCount = 0;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>(r => { releaseFetch = r; });
    let firstRecord: DurableWithdrawRecord | null = null;

    const fetchImpl = async () => {
      fetchCount++;
      if (!firstRecord) firstRecord = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
      await fetchGate; // hold until explicitly released
      return mkRes(200, successBody(firstRecord!));
    };

    // Launch CONCURRENTLY — neither is awaited before the other is started.
    const p1 = coordinateLoopReturn(WALLET, creditSig, proceeds, { storage: s, fetchImpl });
    const p2 = coordinateLoopReturn(WALLET, creditSig, proceeds, { storage: s, fetchImpl });

    // Yield to microtasks: p1's lock body runs and suspends at fetchGate.
    // p2 is queued on the lock chain and has NOT entered its body.
    await new Promise(r => setTimeout(r, 10));

    // p1 has fetched (fetchCount=1), p2 has NOT entered the lock body yet.
    expect(fetchCount).toBe(1);

    // Release p1's fetch gate → p1 finishes → chain unblocks → p2 enters.
    releaseFetch();

    const [out1, out2] = await Promise.all([p1, p2]);

    expect(out1.outcome).toBe('success');
    // p2 entered the lock AFTER p1's debit was written → available = 0.
    expect(out2.outcome).toBe('no_funds_available');
    // Still only one fetch total.
    expect(fetchCount).toBe(1);

    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(proceeds);
    expect(ledger.debitLamports).toBe(proceeds);
    expect(ledger.availableLamports).toBe(0n);

    useSequentialLock();
  });
});

// ─── K: Lock unavailable / throws ────────────────────────────────────────────

describe('K — lock unavailable: coordination_unavailable, zero money effects', () => {
  it('coordinateWithdraw with no locks API → coordination_unavailable', async () => {
    useLockUnavailable();
    const s = new FakeStorage();
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateWithdraw(WALLET, AM, 'wallet_management', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('coordination_unavailable');
    expect(calls).toHaveLength(0);
    expect(s.raw(requestKey(WALLET))).toBeNull(); // no write
    useSequentialLock();
  });

  it('coordinateCheckRetry with locks that throw → coordination_unavailable', async () => {
    useLockThrows();
    const s = new FakeStorage();
    placeRecord(s, { amountLamports: String(AM) });
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('coordination_unavailable');
    expect(calls).toHaveLength(0);
    useSequentialLock();
  });

  it('coordinateLoopReturn with no locks API → coordination_unavailable, zero credit written', async () => {
    useLockUnavailable();
    const s = new FakeStorage();
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateLoopReturn(WALLET, 'sig-xyz', 5_000_000n, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('coordination_unavailable');
    expect(calls).toHaveLength(0);
    // No credit key written (lock unavailable path exits before any storage writes)
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(0n);
    useSequentialLock();
  });

  it('coordinateCleanupMalformed with no locks API → coordination_unavailable', async () => {
    useLockUnavailable();
    const s = new FakeStorage();
    s.put(requestKey(WALLET), 'BAD');
    const out = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(out.outcome).toBe('coordination_unavailable');
    expect(s.raw(requestKey(WALLET))).toBe('BAD'); // unchanged
    useSequentialLock();
  });
});

// ─── L: Scanner / file-system checks ─────────────────────────────────────────

const clientDir = join(process.cwd(), 'client/src');
const helperFile = join(clientDir, 'lib/agent-sol-withdraw-client.ts');
const helperContent = readFileSync(helperFile, 'utf8');

function scanClientFiles(dir: string, results: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      scanClientFiles(full, results);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

describe('L — scanner / file-system checks', () => {
  it('DURABLE_WITHDRAW_ENDPOINT path appears ONLY in agent-sol-withdraw-client.ts', () => {
    const allFiles = scanClientFiles(clientDir);
    const withPath = allFiles.filter(f => {
      if (f === helperFile) return false; // exclude the helper itself
      return readFileSync(f, 'utf8').includes('/api/agent/withdraw-sol');
    });
    expect(withPath).toHaveLength(0);
  });

  it('confirm-sol-withdraw endpoint appears ZERO times in all client files', () => {
    const allFiles = scanClientFiles(clientDir);
    const withConfirm = allFiles.filter(f => readFileSync(f, 'utf8').includes('/api/agent/confirm-sol-withdraw'));
    expect(withConfirm).toHaveLength(0);
  });

  it('no provisional qv:solw:v1 key namespace in any client file', () => {
    const allFiles = scanClientFiles(clientDir);
    const withProvisional = allFiles.filter(f => readFileSync(f, 'utf8').includes('qv:solw:v1'));
    expect(withProvisional).toHaveLength(0);
  });

  it('[C1:FETCH-BEGIN] and [C1:FETCH-END] markers appear in helper file', () => {
    expect(helperContent).toContain('[C1:FETCH-BEGIN]');
    expect(helperContent).toContain('[C1:FETCH-END]');
  });

  it('fetch call is between [C1:FETCH-BEGIN] and [C1:FETCH-END] markers', () => {
    const begin = helperContent.indexOf('[C1:FETCH-BEGIN]');
    const end = helperContent.indexOf('[C1:FETCH-END]');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const region = helperContent.slice(begin, end);
    expect(region).toContain('DURABLE_WITHDRAW_ENDPOINT');
    expect(region).toContain('doFetch(');
  });

  it('provisional coordinator file is absent from client/src', () => {
    const allFiles = scanClientFiles(clientDir);
    const provisional = allFiles.filter(f => f.includes('agent-sol-withdraw-coordinator'));
    expect(provisional).toHaveLength(0);
  });

  it('UI surfaces do not call beginWithdraw, driveWithdraw, readActiveRecord, recordLoopCloseCredit', () => {
    const uiFiles = [
      join(process.cwd(), 'client/src/pages/WalletManagement.tsx'),
      join(process.cwd(), 'client/src/components/LoopVaultControls.tsx'),
    ];
    const banned = ['beginWithdraw(', 'driveWithdraw(', 'recordLoopCloseCredit(', 'noteMissingCloseSignature('];
    for (const f of uiFiles) {
      const c = readFileSync(f, 'utf8');
      for (const b of banned) {
        expect(c, `${f} must not contain ${b}`).not.toContain(b);
      }
    }
  });

  it('helper file has no signTransaction / sendTransaction / confirmTransaction (browser wallet authority)', () => {
    expect(helperContent).not.toContain('signTransaction');
    expect(helperContent).not.toContain('sendTransaction');
    expect(helperContent).not.toContain('confirmTransaction');
  });

  it('LoopVaultControls uses activeReturn.amountLamports not activeReturn.lamports in JSX', () => {
    const lvc = readFileSync(join(process.cwd(), 'client/src/components/LoopVaultControls.tsx'), 'utf8');
    // Must not use the old .lamports field accessor in JSX context (after closing paren = not amountLamports)
    expect(lvc).not.toMatch(/activeReturn\.lamports[^A]/);
    // Must use the correct field name
    expect(lvc).toContain('activeReturn.amountLamports');
  });

  it('LoopVaultControls recovery row condition includes storageUnreadable and malformedKeys checks', () => {
    const lvc = readFileSync(join(process.cwd(), 'client/src/components/LoopVaultControls.tsx'), 'utf8');
    expect(lvc).toContain('storageUnreadable');
    expect(lvc).toContain('malformedKeys');
  });

  it('LoopVaultControls imports coordinateMigrateLegacy not migrateLegacyPendingReturn for the mount call', () => {
    const lvc = readFileSync(join(process.cwd(), 'client/src/components/LoopVaultControls.tsx'), 'utf8');
    expect(lvc).toContain('coordinateMigrateLegacy');
    // coordinateMigrateLegacy should be called in the mount effect
    expect(lvc).toContain('void coordinateMigrateLegacy(');
  });
});

// ─── M: Finalization mismatch preservation ────────────────────────────────────

describe('M — finalization mismatch: replacement / same-ID-diff-amount never clears', () => {
  it('success while slot holds a DIFFERENT record → success_unfinalized with anomaly', async () => {
    // Place A, server responds success for A, but B is in the slot when finalize runs.
    const s2 = new FakeStorage();
    const recA2 = placeRecord(s2, { amountLamports: String(AM) });
    const recB2: DurableWithdrawRecord = {
      version: 1, clientRequestId: 'crid-DIFFERENT', walletAddress: WALLET,
      amountLamports: String(AM), origin: 'wallet_management', createdAt: new Date().toISOString(),
    };
    const fetchWithSwap = async () => {
      // After server responds, swap in B2 (simulates another tab writing while response in-flight)
      s2.put(requestKey(WALLET), JSON.stringify(recB2));
      return mkRes(200, successBody(recA2));
    };
    const out = await coordinateCheckRetry(WALLET, { storage: s2, fetchImpl: fetchWithSwap });
    // Record B2 is now in slot; finalize sees mismatch → anomaly, success_unfinalized
    expect(out.outcome).toBe('success_unfinalized');
    if (out.outcome === 'success_unfinalized') {
      expect(out.reason).toBe('record_mismatch_preserved');
    }
    // B2 still in slot (not cleared)
    expect(s2.raw(requestKey(WALLET))).toBe(JSON.stringify(recB2));
  });
});

// ─── N: Prior retained cells ──────────────────────────────────────────────────

describe('N — prior retained cells', () => {
  it('persistence-before-request: record in storage BEFORE first fetch fires', async () => {
    const s = new FakeStorage();
    let presentBeforeFetch = false;
    let captured: DurableWithdrawRecord | null = null;
    await coordinateWithdraw(WALLET, AM, 'wallet_management', {
      storage: s,
      fetchImpl: async () => {
        const raw = s.raw(requestKey(WALLET));
        presentBeforeFetch = raw !== null;
        captured = raw ? JSON.parse(raw) : null;
        return mkRes(200, successBody(captured!));
      },
    });
    expect(presentBeforeFetch).toBe(true);
    expect(captured?.version).toBe(1);
    expect(captured?.walletAddress).toBe(WALLET);
    expect(captured?.amountLamports).toBe(String(AM));
  });

  it('replay: same clientRequestId sent on repeated coordinateCheckRetry calls', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const crids: string[] = [];
    const fn = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      crids.push(body.clientRequestId as string);
      return mkRes(202, pendingBody(rec));
    };
    await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(crids).toHaveLength(2);
    expect(crids[0]).toBe(crids[1]);
    expect(crids[0]).toBe(rec.clientRequestId);
  });

  it('adoption: coordinateWithdraw drives existing active record instead of creating new', async () => {
    const s = new FakeStorage();
    // Use a UUID-form ID so readRecordFromStorage accepts it as active.
    const existingCrid = crypto.randomUUID();
    const existing = placeRecord(s, { amountLamports: String(AM * 2n), clientRequestId: existingCrid });
    const crids: string[] = [];
    const fn = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      crids.push(body.clientRequestId as string);
      return mkRes(200, successBody(existing));
    };
    const out = await coordinateWithdraw(WALLET, AM, 'wallet_management', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('success');
    expect(crids[0]).toBe(existingCrid); // drove the EXISTING record, not a new one
  });

  it('migration: legacy pending-return value becomes ledger credit, old key removed', () => {
    const s = new FakeStorage();
    s.put(legacyPendingReturnKey(WALLET), '0.5'); // 0.5 SOL = 500_000_000 lamports
    const result = migrateLegacyPendingReturn(WALLET, s);
    expect(result.status).toBe('migrated');
    if (result.status === 'migrated') {
      expect(result.lamports).toBe('500000000');
    }
    // old key removed
    expect(s.raw(legacyPendingReturnKey(WALLET))).toBeNull();
    // credit exists
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(500_000_000n);
  });

  it('idempotency: credit with same sig twice → second is already, no conflict', () => {
    const s = new FakeStorage();
    const sig = 'sig-idem-x1';
    const entry: LedgerEntry = {
      v: 1, kind: 'credit', source: 'loop_close', sig, lamports: '1000', at: new Date().toISOString(),
    };
    const r1 = putLedgerEntry(s, WALLET, creditKey(WALLET, sig), entry);
    const r2 = putLedgerEntry(s, WALLET, creditKey(WALLET, sig), entry);
    expect(r1).toBe('ok');
    expect(r2).toBe('already');
    // no anomaly written
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.anomalies).toHaveLength(0);
    expect(ledger.creditLamports).toBe(1000n);
  });

  it('no_active_record: coordinateCheckRetry with empty storage → no_active_record', async () => {
    const s = new FakeStorage();
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('no_active_record');
    expect(calls).toHaveLength(0);
  });

  it('missing sig noted as anomaly when coordinateLoopReturn called without sig', async () => {
    const s = new FakeStorage();
    const out = await coordinateLoopReturn(WALLET, undefined, 5_000_000n, { storage: s, fetchImpl: async () => mkRes(200, {}) });
    expect(out.outcome).toBe('missing_sig_noted');
    // anomaly written, no credit written
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(0n);
    expect(ledger.anomalies.length).toBeGreaterThan(0);
  });
});

// ─── O: Stale amount binds to ledger availability inside the lock ─────────────

describe('O — coordinateWithdraw loop_return: stale amount binds to ledger availability', () => {
  it('proposed > available → effective amount capped at available (not proposed)', async () => {
    const s = new FakeStorage();
    const creditSig = 'sig-cap-o1';
    const available = 3_000_000n;
    const proposed = 8_000_000n; // intentionally larger than available
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: String(available), at: new Date().toISOString(),
    } satisfies LedgerEntry));
    let capturedLamports: string | null = null;
    const out = await coordinateWithdraw(WALLET, proposed, 'loop_return', {
      storage: s,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        capturedLamports = rec.amountLamports;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
    expect(capturedLamports).toBe('3000000'); // capped at available, not proposed
    if (out.outcome === 'success') expect(out.amountLamports).toBe('3000000');
  });

  it('proposed === available → sends exact amount unchanged', async () => {
    const s = new FakeStorage();
    const sig = 'sig-exact-o2';
    const amount = 5_000_000n;
    s.put(creditKey(WALLET, sig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig, lamports: String(amount), at: new Date().toISOString(),
    } satisfies LedgerEntry));
    let capturedLamports: string | null = null;
    const out = await coordinateWithdraw(WALLET, amount, 'loop_return', {
      storage: s,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        capturedLamports = rec.amountLamports;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
    expect(capturedLamports).toBe(String(amount));
  });

  it('proposed > 0 but availability consumed → no_funds_available, zero fetch', async () => {
    const s = new FakeStorage();
    // No credits in ledger → available = 0
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateWithdraw(WALLET, AM, 'loop_return', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('no_funds_available');
    expect(calls).toHaveLength(0);
  });
});

// ─── P: Truly concurrent coordinateWithdraw loop_return ──────────────────────

describe('P — concurrent coordinateWithdraw loop_return: stale amount, one fetch, one debit', () => {
  it('two concurrent calls: first succeeds, second sees zero availability (no fetch)', async () => {
    const lock = makeSingleQueuedExclusiveLock();
    setGlobalNavigator({ locks: lock });

    const s = new FakeStorage();
    const creditSig = 'sig-conc-p2';
    const proceeds = 5_000_000n;
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: String(proceeds), at: new Date().toISOString(),
    } satisfies LedgerEntry));

    let fetchCount = 0;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>(r => { releaseFetch = r; });
    let firstRecord: DurableWithdrawRecord | null = null;

    const fetchImpl = async () => {
      fetchCount++;
      if (!firstRecord) firstRecord = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
      await fetchGate;
      return mkRes(200, successBody(firstRecord!));
    };

    // Both propose the full amount; after lock wait, second sees 0 available.
    const p1 = coordinateWithdraw(WALLET, proceeds, 'loop_return', { storage: s, fetchImpl });
    const p2 = coordinateWithdraw(WALLET, proceeds, 'loop_return', { storage: s, fetchImpl });

    await new Promise(r => setTimeout(r, 10));
    expect(fetchCount).toBe(1); // only p1's fetch has fired

    releaseFetch();
    const [out1, out2] = await Promise.all([p1, p2]);

    expect(out1.outcome).toBe('success');
    expect(out2.outcome).toBe('no_funds_available');
    expect(fetchCount).toBe(1); // still exactly one fetch

    useSequentialLock();
  });
});

// ─── Q: Balance cap for coordinateLoopReturn ─────────────────────────────────

describe('Q — coordinateLoopReturn capLamports option', () => {
  it('cap < available: credit fully persisted; only cap amount is sent', async () => {
    const s = new FakeStorage();
    const sig = 'sig-cap-q1';
    const proceeds = 5_000_000n;
    const cap = 3_000_000n; // less than proceeds
    let capturedLamports: string | null = null;
    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capLamports: cap,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        capturedLamports = rec.amountLamports;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
    expect(capturedLamports).toBe('3000000'); // capped at cap
    // Credit fully recorded, debit only for cap
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(proceeds);
    expect(ledger.debitLamports).toBe(cap);
    expect(ledger.availableLamports).toBe(proceeds - cap); // remainder still available
  });

  it('cap = 0 → credit retained, no fetch fired', async () => {
    const s = new FakeStorage();
    const sig = 'sig-cap-q2';
    const proceeds = 5_000_000n;
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capLamports: 0n,
      fetchImpl: fn,
    });
    expect(out.outcome).toBe('no_funds_available');
    expect(calls).toHaveLength(0);
    // Credit is retained for manual return later
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(proceeds);
    expect(ledger.debitLamports).toBe(0n);
  });

  it('cap negative → credit retained, no fetch fired', async () => {
    const s = new FakeStorage();
    const sig = 'sig-cap-q3';
    const proceeds = 5_000_000n;
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capLamports: -1n,
      fetchImpl: fn,
    });
    expect(out.outcome).toBe('no_funds_available');
    expect(calls).toHaveLength(0);
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(proceeds); // retained
  });

  it('no cap option → sends full available amount', async () => {
    const s = new FakeStorage();
    const sig = 'sig-cap-q4';
    const proceeds = 5_000_000n;
    let capturedLamports: string | null = null;
    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        capturedLamports = rec.amountLamports;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
    expect(capturedLamports).toBe('5000000'); // full available (no cap)
  });
});

// ─── R: Hostile ledger validation (cross-prefix / suffix mismatch) ────────────

describe('R — hostile ledger validation: cross-prefix and suffix-mismatched entries → malformedKeys', () => {
  it('debit-kind entry at credit-prefix key → malformedKeys (kind mismatch), not summed', () => {
    const s = new FakeStorage();
    s.put(creditKey(WALLET, 'bad-kind'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'bad-kind', origin: 'loop_return', lamports: '5000', at: new Date().toISOString(),
    } as LedgerEntry));
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.malformedKeys.length).toBeGreaterThan(0);
    expect(ledger.creditLamports).toBe(0n);
    expect(ledger.debitLamports).toBe(0n);
  });

  it('credit entry with sig different from key suffix → malformedKeys (suffix mismatch)', () => {
    const s = new FakeStorage();
    // Key has suffix 'key-sig', but entry.sig is 'different-sig'
    s.put(creditKey(WALLET, 'key-sig'), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: 'different-sig', lamports: '5000', at: new Date().toISOString(),
    } as LedgerEntry));
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.malformedKeys.length).toBeGreaterThan(0);
    expect(ledger.creditLamports).toBe(0n);
  });

  it('debit entry with requestId different from key suffix → malformedKeys', () => {
    const s = new FakeStorage();
    s.put(debitKey(WALLET, 'req-key'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'req-other', origin: 'loop_return', lamports: '5000', at: new Date().toISOString(),
    } as LedgerEntry));
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.malformedKeys.length).toBeGreaterThan(0);
    expect(ledger.debitLamports).toBe(0n);
  });

  it('debit entry with non-loop_return origin → malformedKeys', () => {
    const s = new FakeStorage();
    s.put(debitKey(WALLET, 'req-wm'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'req-wm', origin: 'wallet_management', lamports: '5000', at: new Date().toISOString(),
    } as LedgerEntry));
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.malformedKeys.length).toBeGreaterThan(0);
    expect(ledger.debitLamports).toBe(0n);
  });

  it('debit entry with zero lamports → malformedKeys (zero debit is invalid)', () => {
    const s = new FakeStorage();
    s.put(debitKey(WALLET, 'req-zero'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'req-zero', origin: 'loop_return', lamports: '0', at: new Date().toISOString(),
    } as LedgerEntry));
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.malformedKeys.length).toBeGreaterThan(0);
    expect(ledger.debitLamports).toBe(0n);
  });

  it('anomaly-kind entry at credit-prefix key → malformedKeys, NOT counted as anomaly', () => {
    const s = new FakeStorage();
    s.put(creditKey(WALLET, 'not-an-anomaly'), JSON.stringify({
      v: 1, kind: 'anomaly', code: 'test_code', detail: 'test', at: new Date().toISOString(),
    } as LedgerEntry));
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.malformedKeys.length).toBeGreaterThan(0);
    expect(ledger.creditLamports).toBe(0n);
    expect(ledger.anomalies).toHaveLength(0); // not counted (wrong prefix)
  });

  it('anomaly entry at anomaly-prefix with wrong code in suffix → malformedKeys', () => {
    const s = new FakeStorage();
    const k = anomalyKeyFor(WALLET, 'real_code', 'seed');
    // Tamper: put an entry with different code than what the key encodes
    s.put(k, JSON.stringify({
      v: 1, kind: 'anomaly', code: 'tampered_code', detail: 'test', at: new Date().toISOString(),
    } as LedgerEntry));
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.malformedKeys.length).toBeGreaterThan(0);
    expect(ledger.anomalies).toHaveLength(0);
  });

  it('valid credit co-exists with cross-prefix entry; only valid credit is summed', () => {
    const s = new FakeStorage();
    const sig = 'sig-valid-r';
    s.put(creditKey(WALLET, sig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig, lamports: '10000', at: new Date().toISOString(),
    } as LedgerEntry));
    // Cross-prefix: debit-kind at credit-prefix
    s.put(creditKey(WALLET, 'cross-kind'), JSON.stringify({
      v: 1, kind: 'debit', requestId: 'cross-kind', origin: 'loop_return', lamports: '9999', at: new Date().toISOString(),
    } as LedgerEntry));
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(10000n); // only valid credit counted
    expect(ledger.debitLamports).toBe(0n);
    expect(ledger.malformedKeys).toHaveLength(1);
  });
});

// ─── S: withdraw_conflict terminal behavior ───────────────────────────────────

describe('S — withdraw_conflict is terminal: clear + no debit + fresh-ID guidance', () => {
  it('withdraw_conflict on exact ID → terminal_failure cleared, no debit, fresh-ID hint in message', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM), origin: 'loop_return' });
    const conflictBody = {
      state: 'failed', terminal: true, clientRequestId: rec.clientRequestId,
      error: 'The slot is occupied.', step: 'withdraw_conflict',
    };
    const { fn } = capturedFetch([mkRes(400, conflictBody)]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('terminal_failure');
    if (out.outcome === 'terminal_failure') {
      expect(out.cleared).toBe(true);
      // Message must include fresh-ID guidance
      const msg = out.message.toLowerCase();
      expect(msg).toMatch(/fresh|new|cleanup|slot/);
    }
    // Record cleared
    expect(s.raw(requestKey(WALLET))).toBeNull();
    // No debit written (terminal failure, not success)
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.debitLamports).toBe(0n);
  });

  it('withdraw_conflict on mismatched ID → mismatched (not terminal), record retained', async () => {
    const s = new FakeStorage();
    placeRecord(s, { amountLamports: String(AM) });
    const conflictBody = {
      state: 'failed', terminal: true, clientRequestId: 'completely-different-id',
      error: 'Slot occupied.', step: 'withdraw_conflict',
    };
    const { fn } = capturedFetch([mkRes(400, conflictBody)]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    // Mismatched ID → mismatched, not terminal_failure
    expect(out.outcome).toBe('mismatched');
    // Record retained
    expect(s.raw(requestKey(WALLET))).not.toBeNull();
  });

  it('standard terminal failure (no step field) also clears the record', async () => {
    const s = new FakeStorage();
    const rec = placeRecord(s, { amountLamports: String(AM) });
    const { fn } = capturedFetch([mkRes(400, failedBody(rec))]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('terminal_failure');
    if (out.outcome === 'terminal_failure') expect(out.cleared).toBe(true);
    expect(s.raw(requestKey(WALLET))).toBeNull();
  });
});

// ─── T: UUID / min-lamports / round-trip validation; insecure random blocked ─

describe('T — record validation: UUID form, min-lamports, round-trip; insecure random → null', () => {
  it('stored record with non-UUID clientRequestId treated as no active record', async () => {
    const s = new FakeStorage();
    const rec: DurableWithdrawRecord = {
      version: 1, clientRequestId: 'crid-not-a-uuid', // fails UUID validation
      walletAddress: WALLET, amountLamports: String(AM), origin: 'wallet_management',
      createdAt: new Date().toISOString(),
    };
    s.put(requestKey(WALLET), JSON.stringify(rec));
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    // Invalid record → no active record (treated as invalid)
    expect(out.outcome).toBe('no_active_record');
    expect(calls).toHaveLength(0);
  });

  it('stored record with amountLamports below MIN_WITHDRAW_LAMPORTS treated as invalid', async () => {
    const s = new FakeStorage();
    const rec: DurableWithdrawRecord = {
      version: 1, clientRequestId: crypto.randomUUID(),
      walletAddress: WALLET, amountLamports: '100', // below MIN (1000)
      origin: 'wallet_management', createdAt: new Date().toISOString(),
    };
    s.put(requestKey(WALLET), JSON.stringify(rec));
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateCheckRetry(WALLET, { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('no_active_record');
    expect(calls).toHaveLength(0);
  });

  it('record created by coordinator has UUID v4-form clientRequestId', async () => {
    const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const s = new FakeStorage();
    let capturedId = '';
    await coordinateWithdraw(WALLET, AM, 'wallet_management', {
      storage: s,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        capturedId = rec.clientRequestId;
        return mkRes(200, successBody(rec));
      },
    });
    expect(UUID_V4_RE.test(capturedId)).toBe(true);
  });

  it('when crypto is absent → persist_failed, zero fetch, zero storage write', async () => {
    const origCrypto = (globalThis as { crypto?: Crypto }).crypto;
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
      const s = new FakeStorage();
      const { fn, calls } = capturedFetch([]);
      const out = await coordinateWithdraw(WALLET, AM, 'wallet_management', { storage: s, fetchImpl: fn });
      expect(out.outcome).toBe('persist_failed');
      expect(calls).toHaveLength(0);
      expect(s.raw(requestKey(WALLET))).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: origCrypto, configurable: true, writable: true });
    }
  });
});

// ─── U: Cleanup evidence is non-blocking ─────────────────────────────────────

describe('U — malformed_record_cleaned and invalid_request_record do not block future loop returns', () => {
  it('after successful cleanup, loop return proceeds without blocked_by_ledger', async () => {
    const s = new FakeStorage();
    // Place a malformed record and clean it
    s.put(requestKey(WALLET), '{ malformed garbage }');
    const cleanOut = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(cleanOut.outcome).toBe('cleaned');

    // Evidence is present
    const ledger1 = readLedgerViewForDisplay(WALLET, s);
    expect(ledger1.anomalies.some(a => a.code === 'malformed_record_cleaned')).toBe(true);

    // Now seed a credit and run a loop return — cleanup evidence must NOT block
    const sig = 'sig-post-cleanup';
    const proceeds = 5_000_000n;
    s.put(creditKey(WALLET, sig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig, lamports: String(proceeds), at: new Date().toISOString(),
    } satisfies LedgerEntry));
    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        return mkRes(200, successBody(rec));
      },
    });
    // Must NOT be blocked by the cleanup evidence
    expect(out.outcome).toBe('success');
  });

  it('invalid_request_record evidence does not block future loop_return', async () => {
    const s = new FakeStorage();
    // Directly seed invalid_request_record anomaly (as written when a loop-return
    // attempt encounters a malformed request slot)
    writeAnomaly(s, WALLET, 'invalid_request_record', 'some-raw-content', { raw: 'bad-record', note: 'audit' });
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.anomalies.some(a => a.code === 'invalid_request_record')).toBe(true);

    // Now seed a credit — invalid_request_record must NOT block loop return
    const sig = 'sig-post-irr';
    const proceeds = 5_000_000n;
    s.put(creditKey(WALLET, sig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig, lamports: String(proceeds), at: new Date().toISOString(),
    } satisfies LedgerEntry));
    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
  });

  it('entry_conflict (true accounting anomaly) still blocks new loop_return', async () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'entry_conflict', 'some-seed', { note: 'real conflict' });
    const { fn, calls } = capturedFetch([]);
    const out = await coordinateWithdraw(WALLET, AM, 'loop_return', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('blocked_by_ledger');
    expect(calls).toHaveLength(0);
  });
});

// ─── V: coordinateMigrateLegacy (locked migration) ───────────────────────────

describe('V — coordinateMigrateLegacy: async locked wrapper for migrateLegacyPendingReturn', () => {
  it('migrates legacy value under lock and returns migrated status', async () => {
    const s = new FakeStorage();
    s.put(legacyPendingReturnKey(WALLET), '0.5'); // 0.5 SOL
    const result = await coordinateMigrateLegacy(WALLET, s);
    expect(result.status).toBe('migrated');
    if (result.status === 'migrated') expect(result.lamports).toBe('500000000');
    expect(s.raw(legacyPendingReturnKey(WALLET))).toBeNull();
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(500_000_000n);
  });

  it('no legacy key → returns none', async () => {
    const s = new FakeStorage();
    const result = await coordinateMigrateLegacy(WALLET, s);
    expect(result.status).toBe('none');
  });

  it('concurrent calls under real queued lock: exactly one credit written (idempotent)', async () => {
    const lock = makeSingleQueuedExclusiveLock();
    setGlobalNavigator({ locks: lock });

    const s = new FakeStorage();
    s.put(legacyPendingReturnKey(WALLET), '0.5');

    const [r1, r2] = await Promise.all([
      coordinateMigrateLegacy(WALLET, s),
      coordinateMigrateLegacy(WALLET, s),
    ]);

    // One of them migrated; the other found the key already gone
    expect([r1.status, r2.status]).toContain('migrated');
    expect(s.raw(legacyPendingReturnKey(WALLET))).toBeNull();
    // Exactly one credit entry (idempotent second call: 'already')
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(500_000_000n);

    useSequentialLock();
  });

  it('lock unavailable → returns none (idempotent; will succeed on next call)', async () => {
    useLockUnavailable();
    const s = new FakeStorage();
    s.put(legacyPendingReturnKey(WALLET), '0.1');
    const result = await coordinateMigrateLegacy(WALLET, s);
    // Lock unavailable → none (the value stays in place for the next call)
    expect(result.status).toBe('none');
    useSequentialLock();
  });
});

// ─── W: Debit-persist-failure then same-ID one debit ─────────────────────────

describe('W — debit-persist-failure then retry: exactly one debit, not two', () => {
  it('first call: server success + debit write fails → success_unfinalized; retry: same ID, one debit', async () => {
    const s = new FakeStorage();
    const creditSig = 'sig-dbpf-w1';
    const proceeds = 5_000_000n;
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: String(proceeds), at: new Date().toISOString(),
    } satisfies LedgerEntry));

    let firstRec: DurableWithdrawRecord | null = null;

    // First call: server returns success, but debit writes fail
    const out1 = await coordinateLoopReturn(WALLET, creditSig, proceeds, {
      storage: s,
      fetchImpl: async () => {
        firstRec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        s.failSetFor = (k) => k.startsWith('qv-loop-return-debit:');
        return mkRes(200, successBody(firstRec!));
      },
    });
    expect(out1.outcome).toBe('success_unfinalized');
    if (out1.outcome === 'success_unfinalized') expect(out1.reason).toBe('debit_persist_failed');

    // Record NOT cleared (debit failed)
    expect(s.raw(requestKey(WALLET))).not.toBeNull();

    // Restore normal writes
    s.failSetFor = null;

    // Retry (same record ID): server returns success again, debit is now 'already' (idempotent)
    const out2 = await coordinateCheckRetry(WALLET, {
      storage: s,
      fetchImpl: async () => mkRes(200, successBody(firstRec!)),
    });
    expect(out2.outcome).toBe('success');

    // Exactly one debit
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.debitLamports).toBe(proceeds);
    expect(ledger.debitRequestIds).toHaveLength(1);
    expect(ledger.debitRequestIds[0]).toBe(firstRec!.clientRequestId);
  });
});

// ─── X: Clear-failure then same-ID one debit ─────────────────────────────────

describe('X — clear-failure then retry: record stays but debit is idempotent', () => {
  it('first call: debit ok + clear fails → success_unfinalized; retry: same ID, one debit total', async () => {
    const s = new FakeStorage();
    const creditSig = 'sig-clf-x1';
    const proceeds = 5_000_000n;
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: String(proceeds), at: new Date().toISOString(),
    } satisfies LedgerEntry));

    let firstRec: DurableWithdrawRecord | null = null;

    // First call: debit succeeds, record clear fails
    const out1 = await coordinateLoopReturn(WALLET, creditSig, proceeds, {
      storage: s,
      fetchImpl: async () => {
        firstRec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        s.failRemoveFor = (k) => k === requestKey(WALLET);
        return mkRes(200, successBody(firstRec!));
      },
    });
    expect(out1.outcome).toBe('success_unfinalized');
    if (out1.outcome === 'success_unfinalized') expect(out1.reason).toBe('clear_failed');

    // Record still present (remove failed)
    expect(s.raw(requestKey(WALLET))).not.toBeNull();

    // Restore normal removes
    s.failRemoveFor = null;

    // Retry: drives same record; server returns success; debit is 'already' → still one debit
    const out2 = await coordinateCheckRetry(WALLET, {
      storage: s,
      fetchImpl: async () => mkRes(200, successBody(firstRec!)),
    });
    expect(out2.outcome).toBe('success');

    // Still exactly one debit (idempotent)
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.debitLamports).toBe(proceeds);
    expect(ledger.debitRequestIds).toHaveLength(1);
  });
});

// ─── Y: Full lifecycle: malformed→blocked_invalid_record→cleanup→success ──────

describe('Y — full lifecycle: malformed record → blocked attempt writes invalid_request_record → cleanup → later return succeeds', () => {
  it('both audit entries remain after success; neither blocks; exactly one fetch+debit', async () => {
    const s = new FakeStorage();
    const creditSig = 'sig-lifecycle-y1';
    const proceeds = 5_000_000n;

    // Seed a credit
    s.put(creditKey(WALLET, creditSig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig: creditSig, lamports: String(proceeds), at: new Date().toISOString(),
    } satisfies LedgerEntry));

    // Place a malformed record to trigger blocked_invalid_record
    s.put(requestKey(WALLET), '{ malformed json !!! }');

    // Attempt: blocked; writes invalid_request_record anomaly; zero fetches
    const { fn: fn1, calls: calls1 } = capturedFetch([]);
    const out1 = await coordinateLoopReturn(WALLET, creditSig, proceeds, { storage: s, fetchImpl: fn1 });
    expect(out1.outcome).toBe('blocked_invalid_record');
    expect(calls1).toHaveLength(0);

    // invalid_request_record written as non-blocking audit evidence
    const ledger1 = readLedgerViewForDisplay(WALLET, s);
    expect(ledger1.anomalies.some(a => a.code === 'invalid_request_record')).toBe(true);
    // It does NOT block (countBlockingAnomalies ignores it)
    expect(countBlockingAnomalies(ledger1)).toBe(0);

    // Explicit cleanup: writes malformed_record_cleaned, removes slot
    const cleanOut = await coordinateCleanupMalformed(WALLET, { storage: s });
    expect(cleanOut.outcome).toBe('cleaned');
    expect(s.raw(requestKey(WALLET))).toBeNull();

    const ledger2 = readLedgerViewForDisplay(WALLET, s);
    expect(ledger2.anomalies.some(a => a.code === 'malformed_record_cleaned')).toBe(true);
    expect(countBlockingAnomalies(ledger2)).toBe(0); // neither audit entry blocks

    // Later loop return: slot is clear → one fetch + one debit → success
    let fetchCount = 0;
    const out2 = await coordinateLoopReturn(WALLET, creditSig, proceeds, {
      storage: s,
      fetchImpl: async () => {
        fetchCount++;
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out2.outcome).toBe('success');
    expect(fetchCount).toBe(1);

    // Both audit entries remain; exactly one debit; neither blocks
    const ledger3 = readLedgerViewForDisplay(WALLET, s);
    expect(ledger3.anomalies.some(a => a.code === 'invalid_request_record')).toBe(true);
    expect(ledger3.anomalies.some(a => a.code === 'malformed_record_cleaned')).toBe(true);
    expect(countBlockingAnomalies(ledger3)).toBe(0);
    expect(ledger3.debitLamports).toBe(proceeds);
    expect(ledger3.debitRequestIds).toHaveLength(1);
  });
});

// ─── Z: countBlockingAnomalies helper ────────────────────────────────────────

describe('Z — countBlockingAnomalies: non-blocking codes excluded from count', () => {
  it('invalid_request_record anomaly → countBlockingAnomalies returns 0', () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'invalid_request_record', 'seed-irr', { note: 'blocked attempt' });
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.anomalies.some(a => a.code === 'invalid_request_record')).toBe(true);
    expect(countBlockingAnomalies(ledger)).toBe(0);
  });

  it('malformed_record_cleaned anomaly → countBlockingAnomalies returns 0', () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'malformed_record_cleaned', 'seed-mrc', { note: 'cleaned' });
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(countBlockingAnomalies(ledger)).toBe(0);
  });

  it('entry_conflict anomaly → countBlockingAnomalies returns 1 (blocking)', () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'entry_conflict', 'seed-ec', { note: 'real conflict' });
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(countBlockingAnomalies(ledger)).toBe(1);
  });

  it('mix: entry_conflict + two non-blocking → countBlockingAnomalies returns 1', () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'entry_conflict', 'seed-ec2', { note: 'real conflict' });
    writeAnomaly(s, WALLET, 'invalid_request_record', 'seed-irr2', { note: 'blocked' });
    writeAnomaly(s, WALLET, 'malformed_record_cleaned', 'seed-mrc2', { note: 'cleaned' });
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(countBlockingAnomalies(ledger)).toBe(1); // only entry_conflict
    expect(ledger.anomalies.length).toBe(3); // all three visible
  });

  it('invalid_request_record alone does NOT block coordinateWithdraw loop_return', async () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'invalid_request_record', 'seed-irr3', { note: 'audit' });
    const sig = 'sig-z-no-block';
    const proceeds = 5_000_000n;
    s.put(creditKey(WALLET, sig), JSON.stringify({
      v: 1, kind: 'credit', source: 'loop_close', sig, lamports: String(proceeds), at: new Date().toISOString(),
    } satisfies LedgerEntry));
    const out = await coordinateWithdraw(WALLET, proceeds, 'loop_return', {
      storage: s,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
  });

  it('both non-blocking codes present together → countBlockingAnomalies returns 0', () => {
    const s = new FakeStorage();
    writeAnomaly(s, WALLET, 'invalid_request_record', 'seed-both1', { note: 'blocked' });
    writeAnomaly(s, WALLET, 'malformed_record_cleaned', 'seed-both2', { note: 'cleaned' });
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(countBlockingAnomalies(ledger)).toBe(0);
  });
});

// ─── AA: capProvider post-credit ordering and failure retention ───────────────

describe('AA — coordinateLoopReturn capProvider: post-credit invocation, failure/null/zero retention, concurrent-waiter skip', () => {
  it('provider is invoked AFTER credit is durably present in storage', async () => {
    const s = new FakeStorage();
    const sig = 'sig-aa1';
    const proceeds = 5_000_000n;
    let creditLamportsAtProviderTime = 0n;

    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capProvider: async () => {
        // Credit must already be in storage when provider runs
        creditLamportsAtProviderTime = readLedgerViewForDisplay(WALLET, s).creditLamports;
        return proceeds; // uncapped
      },
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
    // Provider saw the credit already durably recorded
    expect(creditLamportsAtProviderTime).toBe(proceeds);
  });

  it('provider throws → no_funds_available, credit retained, zero fetch', async () => {
    const s = new FakeStorage();
    const sig = 'sig-aa2';
    const proceeds = 5_000_000n;
    const { fn, calls } = capturedFetch([]);

    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capProvider: async () => { throw new Error('balance fetch failed'); },
      fetchImpl: fn,
    });
    expect(out.outcome).toBe('no_funds_available');
    expect(calls).toHaveLength(0);
    // Credit retained
    expect(readLedgerViewForDisplay(WALLET, s).creditLamports).toBe(proceeds);
  });

  it('provider returns null → no_funds_available, credit retained, zero fetch', async () => {
    const s = new FakeStorage();
    const sig = 'sig-aa3';
    const proceeds = 5_000_000n;
    const { fn, calls } = capturedFetch([]);

    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capProvider: async () => null,
      fetchImpl: fn,
    });
    expect(out.outcome).toBe('no_funds_available');
    expect(calls).toHaveLength(0);
    expect(readLedgerViewForDisplay(WALLET, s).creditLamports).toBe(proceeds);
  });

  it('provider returns 0n → no_funds_available, credit retained, zero fetch', async () => {
    const s = new FakeStorage();
    const sig = 'sig-aa4';
    const proceeds = 5_000_000n;
    const { fn, calls } = capturedFetch([]);

    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capProvider: async () => 0n,
      fetchImpl: fn,
    });
    expect(out.outcome).toBe('no_funds_available');
    expect(calls).toHaveLength(0);
    expect(readLedgerViewForDisplay(WALLET, s).creditLamports).toBe(proceeds);
  });

  it('provider returns negative → no_funds_available, credit retained, zero fetch', async () => {
    const s = new FakeStorage();
    const sig = 'sig-aa5';
    const proceeds = 5_000_000n;
    const { fn, calls } = capturedFetch([]);

    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capProvider: async () => -1n,
      fetchImpl: fn,
    });
    expect(out.outcome).toBe('no_funds_available');
    expect(calls).toHaveLength(0);
    expect(readLedgerViewForDisplay(WALLET, s).creditLamports).toBe(proceeds);
  });

  it('concurrent waiter at zero availability: never invokes capProvider', async () => {
    const lock = makeSingleQueuedExclusiveLock();
    setGlobalNavigator({ locks: lock });

    const s = new FakeStorage();
    const creditSig = 'sig-aa-conc';
    const proceeds = 5_000_000n;

    let providerCallCount = 0;
    let firstRecord: DurableWithdrawRecord | null = null;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>(r => { releaseFetch = r; });

    const capProvider = async (): Promise<bigint | null> => {
      providerCallCount++;
      return proceeds; // uncapped
    };
    const fetchImpl = async () => {
      if (!firstRecord) firstRecord = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
      await fetchGate; // hold first caller until explicitly released
      return mkRes(200, successBody(firstRecord!));
    };

    // Launch both concurrently; neither awaited before the other starts
    const p1 = coordinateLoopReturn(WALLET, creditSig, proceeds, { storage: s, capProvider, fetchImpl });
    const p2 = coordinateLoopReturn(WALLET, creditSig, proceeds, { storage: s, capProvider, fetchImpl });

    await new Promise(r => setTimeout(r, 10));
    // p1 entered lock, called provider once, is suspended at fetchGate
    expect(providerCallCount).toBe(1);

    releaseFetch();
    const [out1, out2] = await Promise.all([p1, p2]);

    expect(out1.outcome).toBe('success');
    // p2 entered lock after p1's debit; availability = 0 → short-circuits before provider
    expect(out2.outcome).toBe('no_funds_available');
    // Provider called exactly once (p2's lock body exited early)
    expect(providerCallCount).toBe(1);

    // Ledger: one debit, credit preserved as-is
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(proceeds);
    expect(ledger.debitLamports).toBe(proceeds);
    expect(ledger.availableLamports).toBe(0n);

    useSequentialLock();
  });

  it('capProvider cap < available: only cap amount sent, remainder stays', async () => {
    const s = new FakeStorage();
    const sig = 'sig-aa-partial';
    const proceeds = 5_000_000n;
    const cap = 3_000_000n;
    let capturedLamports: string | null = null;

    const out = await coordinateLoopReturn(WALLET, sig, proceeds, {
      storage: s,
      capProvider: async () => cap,
      fetchImpl: async () => {
        const rec = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
        capturedLamports = rec.amountLamports;
        return mkRes(200, successBody(rec));
      },
    });
    expect(out.outcome).toBe('success');
    expect(capturedLamports).toBe('3000000'); // capped
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(proceeds);
    expect(ledger.debitLamports).toBe(cap);
    expect(ledger.availableLamports).toBe(proceeds - cap);
  });
});

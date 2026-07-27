/**
 * WO2B2DC1 — Cutover verification for agent-sol-withdraw-client.ts
 *
 * Covers: exact key names / field names / origins (no provisional variants);
 * HTTP 200-only success; pending / re-key / manual_review classification;
 * ledger blockers (all four types) block NEW loop_return but not Check/Retry;
 * malformed debit in malformedKeys; negative deficit + debit request IDs;
 * cleanup paths (persist fail / remove fail / success); two-concurrent same-
 * credit race under sequential lock; lock unavailable = zero money effects;
 * file-system scanner checks; finalization mismatch preservation; persistence-
 * before-request; replay; adoption; migration; idempotency.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  coordinateWithdraw,
  coordinateCheckRetry,
  coordinateCleanupMalformed,
  coordinateLoopReturn,
  readActiveRecordForDisplay,
  readLedgerViewForDisplay,
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

/** Directly place a record in storage for test setup (bypasses lock). */
function placeRecord(s: FakeStorage, overrides: Partial<DurableWithdrawRecord> & { amountLamports: string }): DurableWithdrawRecord {
  const rec: DurableWithdrawRecord = {
    version: 1,
    clientRequestId: `crid-test-${Math.random().toString(36).slice(2)}`,
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
    // Malformed debit (wrong JSON structure)
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
    // debit 1 = 3000 lamports
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
    // zero network calls
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

  it('cleanup makes zero fetch calls', async () => {
    const s = new FakeStorage();
    s.put(requestKey(WALLET), 'INVALID');
    const { fn, calls } = capturedFetch([]);
    await coordinateCleanupMalformed(WALLET, { storage: s, fetchImpl: fn });
    expect(calls).toHaveLength(0);
  });
});

// ─── J: Two concurrent same-credit (sequential lock simulation) ───────────────

describe('J — two tabs same-credit: one fetch, one debit, zero residual availability', () => {
  it('second coordinateLoopReturn with same sig sees zero available after first succeeds', async () => {
    const creditSig = 'sig-joint-x1';
    const proceeds = 5_000_000n;

    // Use a simulated sequential lock: first caller runs to completion, then second.
    let firstRecord: DurableWithdrawRecord | null = null;
    const s = new FakeStorage();
    let fetchCount = 0;

    const fetchImpl = async () => {
      fetchCount++;
      if (firstRecord === null) {
        firstRecord = JSON.parse(s.raw(requestKey(WALLET))!) as DurableWithdrawRecord;
      }
      return mkRes(200, successBody(firstRecord!));
    };

    // First call: credit recorded, record created, fetched, debit written.
    const out1 = await coordinateLoopReturn(WALLET, creditSig, proceeds, { storage: s, fetchImpl });
    expect(out1.outcome).toBe('success');
    expect(fetchCount).toBe(1);

    // Second call: same sig (credit already), re-derives ledger inside lock.
    // Debit from first success consumed the credit → available = 0.
    const out2 = await coordinateLoopReturn(WALLET, creditSig, proceeds, { storage: s, fetchImpl });
    expect(out2.outcome).toBe('no_funds_available');
    // No second fetch fired.
    expect(fetchCount).toBe(1);

    // Ledger: one credit, one debit, balance = 0.
    const ledger = readLedgerViewForDisplay(WALLET, s);
    expect(ledger.creditLamports).toBe(proceeds);
    expect(ledger.debitLamports).toBe(proceeds);
    expect(ledger.availableLamports).toBe(0n);
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
});

// ─── M: Finalization mismatch preservation ────────────────────────────────────

describe('M — finalization mismatch: replacement / same-ID-diff-amount never clears', () => {
  it('success while slot holds a DIFFERENT record → success_unfinalized with anomaly', async () => {
    const s = new FakeStorage();
    // Place record A in the slot
    const recA = placeRecord(s, { amountLamports: String(AM) });
    // The server returns success for A, but before finalization we swap in record B
    // We test this by using a custom fetchImpl that swaps the record mid-flight
    const recB = placeRecord(s, { amountLamports: String(AM * 2n), clientRequestId: 'crid-B' });
    // Restore A for the fetch so the server matches A, but slot holds B
    s.put(requestKey(WALLET), JSON.stringify(recA));

    const { fn } = capturedFetch([mkRes(200, successBody(recA))]);
    // Read A, drive it to success. After response received, re-place B in slot to simulate race.
    // We can't easily inject mid-flight storage mutation, so instead we test the finalize guard
    // by having the slot hold B when finalize runs.
    // We simulate by directly placing B in the slot BEFORE calling coordinateCheckRetry,
    // but coordinateWithdraw reads the slot first, gets A, then on finalize re-reads and finds B.
    // To do this cleanly: place A first, call coordinateCheckRetry.
    // Inside the lock, coordinateCheckRetry reads slot → A, drives → success,
    // then on finalize re-reads slot → should still be A.
    // The race scenario: we can test by having fetchImpl mutate storage:
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
    const existing = placeRecord(s, { amountLamports: String(AM * 2n), clientRequestId: 'existing-crid' });
    const crids: string[] = [];
    const fn = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      crids.push(body.clientRequestId as string);
      return mkRes(200, successBody(existing));
    };
    const out = await coordinateWithdraw(WALLET, AM, 'wallet_management', { storage: s, fetchImpl: fn });
    expect(out.outcome).toBe('success');
    expect(crids[0]).toBe('existing-crid'); // drove the EXISTING record, not a new one
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

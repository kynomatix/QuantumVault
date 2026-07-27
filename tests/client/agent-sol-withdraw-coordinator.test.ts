/**
 * WO2B2D — Durable client SOL-withdrawal coordinator: focused regression tests.
 *
 * Exercises the PRODUCTION coordinator module (client/src/lib/
 * agent-sol-withdraw-coordinator.ts) the two surfaces import — no test-local
 * re-implementation — plus structural assertions on the actual surface
 * sources proving the wiring:
 *   (a) request record persisted + read back BEFORE any network call;
 *       same-ID + exact-amount replay; conservative outcome classification
 *       (pending/re-key/manual-review/auth/network/parse/mismatched/unknown
 *       all retain the record);
 *   (b) append-only cross-tab-safe proceeds ledger: idempotent replay,
 *       conflict→anomaly (never overwrite), BigInt availability, negative
 *       discrepancy surfaced exactly and never clamped;
 *   (c) deterministic legacy pending-return migration (float artifacts,
 *       exponential notation, invalid values preserved with anomalies);
 *   (d) marked-region wiring checks (non-vacuous), a source scanner that
 *       provably catches a forbidden browser send nested one helper deep,
 *       proof the durable endpoint is called only from the coordinator, and
 *       proof the neutralized legacy confirm endpoint has zero client callers.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import {
  beginWithdraw,
  driveWithdraw,
  readActiveRecord,
  classifyWithdrawResponse,
  deriveAvailability,
  recordLoopCloseCredit,
  noteMissingCloseSignature,
  migrateLegacyPendingReturn,
  putLedgerEntry,
  computeReturnLamports,
  maxSendableLamportsFromSol,
  lamportsToSolDisplay,
  lamportsToSolNumber,
  lamportsRoundTripExactly,
  solNumberToLamports,
  requestKey,
  ledgerPrefix,
  creditSigKey,
  legacyCreditKey,
  debitKey,
  legacyPendingReturnKey,
  DURABLE_WITHDRAW_ENDPOINT,
  MIN_WITHDRAW_LAMPORTS,
  type StorageLike,
  type DurableWithdrawRecord,
  type LedgerEntry,
} from '@/lib/agent-sol-withdraw-coordinator';

const WALLET = 'TestWa11etAddr1111111111111111111111111111';

// ── Test doubles ─────────────────────────────────────────────────────────────

class FakeStorage implements StorageLike {
  private map = new Map<string, string>();
  /** Ordered op log — proves persistence precedes any network call. */
  ops: Array<{ op: string; key: string }> = [];
  failSetFor: ((key: string) => boolean) | null = null;
  failRemoveFor: ((key: string) => boolean) | null = null;
  /** Simulates another tab's write landing between our setItem and read-back. */
  overwriteAfterSet: { key: string; value: string } | null = null;
  getItem(key: string): string | null {
    this.ops.push({ op: 'get', key });
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.ops.push({ op: 'set', key });
    if (this.failSetFor?.(key)) throw new Error('QuotaExceededError');
    this.map.set(key, value);
    if (this.overwriteAfterSet && this.overwriteAfterSet.key === key) {
      this.map.set(key, this.overwriteAfterSet.value); // interloping tab wins the race
      this.overwriteAfterSet = null;
    }
  }
  removeItem(key: string): void {
    this.ops.push({ op: 'remove', key });
    if (this.failRemoveFor?.(key)) throw new Error('storage locked');
    this.map.delete(key);
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
  raw(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  put(key: string, value: string): void {
    this.map.set(key, value);
  }
  keys(): string[] {
    return Array.from(this.map.keys());
  }
}

type MockResponse = { status: number; json: () => Promise<unknown> };
const mkRes = (status: number, body: unknown): MockResponse => ({ status, json: async () => body });
const badJsonRes = (status: number): MockResponse => ({
  status,
  json: async () => {
    throw new SyntaxError('Unexpected token < in JSON');
  },
});

/** Sequential fetch mock: replays the last response when calls exceed the list. */
function fetchSeq(...responses: Array<MockResponse | Error>) {
  const calls: Array<{ url: string; body: { clientRequestId: string; amount: number }; headers: Record<string, string> }> = [];
  const fn = async (url: string, init: { body: string; headers: Record<string, string> }): Promise<MockResponse> => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  };
  return { fn, calls };
}

// Server response fixtures (shapes pinned to server/vault/agent-sol-withdraw.ts).
const succeededBody = (r: DurableWithdrawRecord, over?: Partial<Record<string, unknown>>) => ({
  success: true,
  state: 'succeeded',
  clientRequestId: r.id,
  signature: 'SigSucceeded111',
  withdrawnLamports: r.lamports,
  withdrawnSol: lamportsToSolDisplay(r.lamports),
  message: 'Withdrawal completed.',
  ...over,
});
const pendingBody = (r: DurableWithdrawRecord) => ({
  success: false,
  state: 'pending',
  pending: true,
  clientRequestId: r.id,
  message: 'Withdrawal is still being processed; retry with the same clientRequestId.',
});
const manualReviewBody = (r: DurableWithdrawRecord) => ({
  success: false,
  state: 'pending',
  pending: true,
  manualReview: true,
  clientRequestId: r.id,
  message: 'This withdrawal needs manual review; nothing further will be sent automatically.',
});
const failedBody = (r: DurableWithdrawRecord, step: string) => ({
  success: false,
  state: 'failed',
  terminal: true,
  clientRequestId: r.id,
  step,
  error: 'The withdrawal transaction failed on-chain; no funds moved.',
});

function begin(storage: FakeStorage, lamports: bigint, origin: 'wallet_mgmt' | 'loop_return'): DurableWithdrawRecord {
  const res = beginWithdraw(storage, WALLET, lamports, origin);
  if (res.status !== 'created') throw new Error(`begin failed: ${res.status}`);
  return res.record;
}

const ledgerCreditEntry = (sig: string, lamports: string): string =>
  JSON.stringify({ v: 1, kind: 'credit', source: 'loop_close', sig, lamports, at: '2026-07-27T00:00:00.000Z' });

// ── A. Durable request record ────────────────────────────────────────────────

describe('durable request record', () => {
  it('persists and reads back {UUID, exact lamports, wallet, origin} BEFORE the first request', async () => {
    const storage = new FakeStorage();
    const record = begin(storage, 123_456_789n, 'wallet_mgmt');
    // Persisted + read back already, with zero network involvement.
    const reqOps = storage.ops.filter((o) => o.key === requestKey(WALLET));
    expect(reqOps.some((o) => o.op === 'set')).toBe(true);
    expect(reqOps.findIndex((o) => o.op === 'get' && reqOps.indexOf(o) > reqOps.findIndex((x) => x.op === 'set'))).toBeGreaterThan(-1);
    const read = readActiveRecord(storage, WALLET);
    expect(read.status).toBe('active');
    if (read.status === 'active') {
      expect(read.record.id).toBe(record.id);
      expect(read.record.lamports).toBe('123456789');
      expect(read.record.wallet).toBe(WALLET);
      expect(read.record.origin).toBe('wallet_mgmt');
    }
    // The request that eventually goes out reproduces the EXACT lamports.
    const { fn, calls } = fetchSeq(mkRes(202, pendingBody(record)));
    await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(DURABLE_WITHDRAW_ENDPOINT);
    expect(calls[0].body.clientRequestId).toBe(record.id);
    expect(Math.round(calls[0].body.amount * 1e9)).toBe(123_456_789);
  });

  it('round-trips awkward lamport amounts exactly through the SOL-number wire format', () => {
    for (const lam of ['1000', '123456789', '999999999999', '2039280', '1']) {
      expect(lamportsRoundTripExactly(lam)).toBe(true);
      expect(Math.round(lamportsToSolNumber(lam) * 1e9)).toBe(Number(lam));
    }
    expect(solNumberToLamports(0.1234)).toBe(123_400_000n);
    expect(solNumberToLamports(0)).toBeNull();
    expect(solNumberToLamports(-1)).toBeNull();
    expect(solNumberToLamports(Number.NaN)).toBeNull();
  });

  it('a persistence failure means NO record and NO network call may ever happen', () => {
    const storage = new FakeStorage();
    storage.failSetFor = (k) => k === requestKey(WALLET);
    const res = beginWithdraw(storage, WALLET, 50_000n, 'wallet_mgmt');
    expect(res.status).toBe('persist_failed');
    expect(readActiveRecord(storage, WALLET).status).toBe('none');
  });

  it('rejects below-minimum and non-representable amounts before persisting anything', () => {
    const storage = new FakeStorage();
    expect(beginWithdraw(storage, WALLET, 999n, 'wallet_mgmt').status).toBe('invalid_amount');
    expect(beginWithdraw(storage, WALLET, 9_007_199_254_740_993n, 'wallet_mgmt').status).toBe('invalid_amount');
    expect(readActiveRecord(storage, WALLET).status).toBe('none');
  });

  it('replays the SAME id and amount on every retry', async () => {
    const storage = new FakeStorage();
    const record = begin(storage, 777_000n, 'loop_return');
    const { fn, calls } = fetchSeq(mkRes(202, pendingBody(record)), mkRes(202, pendingBody(record)));
    await driveWithdraw(storage, record, { fetchImpl: fn });
    const again = readActiveRecord(storage, WALLET);
    expect(again.status).toBe('active');
    if (again.status === 'active') await driveWithdraw(storage, again.record, { fetchImpl: fn });
    expect(calls).toHaveLength(2);
    expect(calls[1].body.clientRequestId).toBe(record.id);
    expect(calls[1].body.amount).toBe(calls[0].body.amount);
  });

  it('cross-surface adoption: the second surface adopts the SAME valid record instead of minting a new one', () => {
    const storage = new FakeStorage();
    const record = begin(storage, 555_000n, 'loop_return');
    const adopted = beginWithdraw(storage, WALLET, 999_999n, 'wallet_mgmt'); // different args must NOT matter
    expect(adopted.status).toBe('active_exists');
    if (adopted.status === 'active_exists') {
      expect(adopted.record.id).toBe(record.id);
      expect(adopted.record.lamports).toBe('555000');
      expect(adopted.record.origin).toBe('loop_return');
    }
  });

  it('an unreadable stored record blocks new withdrawals and is preserved with a visible anomaly', () => {
    const storage = new FakeStorage();
    storage.put(requestKey(WALLET), '{not json');
    const res = beginWithdraw(storage, WALLET, 50_000n, 'wallet_mgmt');
    expect(res.status).toBe('blocked_invalid_record');
    expect(storage.raw(requestKey(WALLET))).toBe('{not json'); // evidence preserved
    const view = deriveAvailability(storage, WALLET);
    expect(view.anomalies.some((a) => a.code === 'invalid_request_record')).toBe(true);
  });
});

// ── B. Conservative response classification ─────────────────────────────────

describe('conservative response classification', () => {
  const retainedCases: Array<{
    name: string;
    make: (r: DurableWithdrawRecord) => MockResponse | Error;
    outcome: string;
  }> = [
    { name: 'pending 202', make: (r) => mkRes(202, pendingBody(r)), outcome: 'pending' },
    { name: 'manual review 409', make: (r) => mkRes(409, manualReviewBody(r)), outcome: 'manual_review' },
    { name: 'auth 401 (re-key)', make: () => mkRes(401, { error: 'Session expired' }), outcome: 'auth' },
    { name: 'auth 403', make: () => mkRes(403, { error: 'Forbidden' }), outcome: 'auth' },
    { name: 'network failure', make: () => new Error('fetch failed'), outcome: 'network' },
    { name: 'unparseable body', make: () => badJsonRes(500), outcome: 'parse' },
    { name: 'unknown validation shape', make: () => mkRes(400, { success: false, error: 'Valid amount required' }), outcome: 'unknown' },
    { name: 'response for a different clientRequestId', make: (r) => mkRes(200, succeededBody(r, { clientRequestId: 'someone-else' })), outcome: 'mismatched' },
    { name: 'success with different lamports', make: (r) => mkRes(200, succeededBody(r, { withdrawnLamports: '1' })), outcome: 'mismatched' },
    { name: 'success with null lamports (unverifiable amount)', make: (r) => mkRes(200, succeededBody(r, { withdrawnLamports: null })), outcome: 'mismatched' },
    { name: 'terminal withdraw_conflict (id bound elsewhere)', make: (r) => mkRes(409, { ...failedBody(r, 'withdraw_conflict'), error: 'clientRequestId is already bound to a different withdrawal' }), outcome: 'conflict' },
  ];

  for (const c of retainedCases) {
    it(`${c.name} → outcome '${c.outcome}' and the record is RETAINED`, async () => {
      const storage = new FakeStorage();
      const record = begin(storage, 250_000n, 'wallet_mgmt');
      const { fn } = fetchSeq(c.make(record) as MockResponse);
      const out = await driveWithdraw(storage, record, { fetchImpl: fn });
      expect(out.outcome).toBe(c.outcome);
      expect((out as { retained: boolean }).retained).toBe(true);
      const read = readActiveRecord(storage, WALLET);
      expect(read.status).toBe('active');
      if (read.status === 'active') expect(read.record.id).toBe(record.id);
    });
  }

  it('mismatched and conflict outcomes leave visible anomaly entries', async () => {
    const storage = new FakeStorage();
    const record = begin(storage, 250_000n, 'wallet_mgmt');
    const { fn } = fetchSeq(
      mkRes(200, succeededBody(record, { withdrawnLamports: '1' })),
      mkRes(409, { ...failedBody(record, 'withdraw_conflict') }),
    );
    await driveWithdraw(storage, record, { fetchImpl: fn });
    await driveWithdraw(storage, record, { fetchImpl: fn });
    const view = deriveAvailability(storage, WALLET);
    expect(view.anomalies.some((a) => a.code === 'response_mismatch')).toBe(true);
    expect(view.anomalies.some((a) => a.code === 'withdraw_conflict')).toBe(true);
  });

  it('matched explicit terminal failure clears the record (no debit is ever written)', async () => {
    const storage = new FakeStorage();
    const record = begin(storage, 250_000n, 'loop_return');
    const { fn } = fetchSeq(mkRes(400, failedBody(record, 'withdraw_failed_onchain')));
    const out = await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(out.outcome).toBe('terminal_failure');
    expect((out as { cleared: boolean }).cleared).toBe(true);
    expect(readActiveRecord(storage, WALLET).status).toBe('none');
    expect(storage.raw(debitKey(WALLET, record.id))).toBeNull();
  });

  it('matched success for a wallet_mgmt record clears it WITHOUT a loop debit', async () => {
    const storage = new FakeStorage();
    const record = begin(storage, 250_000n, 'wallet_mgmt');
    const { fn } = fetchSeq(mkRes(200, succeededBody(record)));
    const out = await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(out.outcome).toBe('success');
    expect(readActiveRecord(storage, WALLET).status).toBe('none');
    expect(storage.raw(debitKey(WALLET, record.id))).toBeNull();
  });

  it('classifyWithdrawResponse is pure and matches drive outcomes for the success case', () => {
    const record: DurableWithdrawRecord = {
      v: 1, id: 'abc', wallet: WALLET, lamports: '5000', origin: 'loop_return', createdAt: 'now',
    };
    expect(classifyWithdrawResponse(record, succeededBody(record)).kind).toBe('matched_success');
    expect(classifyWithdrawResponse(record, pendingBody(record)).kind).toBe('pending');
    expect(classifyWithdrawResponse(record, manualReviewBody(record)).kind).toBe('manual_review');
    expect(classifyWithdrawResponse(record, failedBody(record, 'withdraw_expired')).kind).toBe('matched_terminal_failure');
    expect(classifyWithdrawResponse(record, failedBody(record, 'withdraw_conflict')).kind).toBe('conflict');
    expect(classifyWithdrawResponse(record, null).kind).toBe('unknown');
    expect(classifyWithdrawResponse(record, 'nonsense').kind).toBe('unknown');
  });
});

// ── C. Loop-origin completion + persistence-failure finalization ────────────

describe('loop-origin success finalization', () => {
  it('ANY surface completing a loop-origin request gets the debit written+verified BEFORE clearing', async () => {
    const storage = new FakeStorage();
    storage.put(creditSigKey(WALLET, 'sigClose1'), ledgerCreditEntry('sigClose1', '900000'));
    const record = begin(storage, 900_000n, 'loop_return');
    // Drive it exactly the way Wallet Management does — same shared coordinator call.
    const { fn } = fetchSeq(mkRes(200, succeededBody(record)));
    const out = await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(out.outcome).toBe('success');
    const debitRaw = storage.raw(debitKey(WALLET, record.id));
    expect(debitRaw).not.toBeNull();
    expect(JSON.parse(debitRaw!)).toMatchObject({ kind: 'debit', requestId: record.id, lamports: '900000' });
    expect(readActiveRecord(storage, WALLET).status).toBe('none');
    expect(deriveAvailability(storage, WALLET).availableLamports).toBe(0n);
  });

  it('debit persistence failure RETAINS the request; a later same-ID drive finalizes locally without a duplicate debit', async () => {
    const storage = new FakeStorage();
    storage.put(creditSigKey(WALLET, 'sigClose2'), ledgerCreditEntry('sigClose2', '400000'));
    const record = begin(storage, 400_000n, 'loop_return');
    storage.failSetFor = (k) => k === debitKey(WALLET, record.id);
    const { fn, calls } = fetchSeq(mkRes(200, succeededBody(record)), mkRes(200, succeededBody(record)));
    const first = await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(first.outcome).toBe('success_unfinalized');
    expect((first as { reason: string }).reason).toBe('debit_persist_failed');
    expect(readActiveRecord(storage, WALLET).status).toBe('active'); // kept for same-ID finalization
    // Storage heals; the SAME id is driven again (idempotent server replay).
    storage.failSetFor = null;
    const second = await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(second.outcome).toBe('success');
    expect(calls.map((c) => c.body.clientRequestId)).toEqual([record.id, record.id]);
    const debits = storage.keys().filter((k) => k.startsWith(`${ledgerPrefix(WALLET)}debit:`));
    expect(debits).toHaveLength(1);
    expect(readActiveRecord(storage, WALLET).status).toBe('none');
  });

  it('record-clear failure after a recorded debit stays retained and replays to a clean finish with ONE debit', async () => {
    const storage = new FakeStorage();
    const record = begin(storage, 300_000n, 'loop_return');
    storage.failRemoveFor = (k) => k === requestKey(WALLET);
    const { fn } = fetchSeq(mkRes(200, succeededBody(record)), mkRes(200, succeededBody(record)));
    const first = await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(first.outcome).toBe('success_unfinalized');
    expect((first as { reason: string }).reason).toBe('clear_failed');
    storage.failRemoveFor = null;
    const second = await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(second.outcome).toBe('success');
    expect(storage.keys().filter((k) => k.startsWith(`${ledgerPrefix(WALLET)}debit:`))).toHaveLength(1);
  });

  it('abandoned-record retry after server cleanup: the same id is re-posted and a fresh matched success completes it', async () => {
    const storage = new FakeStorage();
    const record = begin(storage, 600_000n, 'loop_return');
    const { fn, calls } = fetchSeq(
      mkRes(202, pendingBody(record)), // original attempt: parked server-side
      mkRes(200, succeededBody(record)), // after cleanup the re-POST is adopted as a fresh create
    );
    const first = await driveWithdraw(storage, record, { fetchImpl: fn });
    expect(first.outcome).toBe('pending');
    const read = readActiveRecord(storage, WALLET);
    expect(read.status).toBe('active');
    const second = await driveWithdraw(storage, (read as { record: DurableWithdrawRecord }).record, { fetchImpl: fn });
    expect(second.outcome).toBe('success');
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.body.clientRequestId)).size).toBe(1);
  });
});

// ── D. Append-only ledger ────────────────────────────────────────────────────

describe('append-only proceeds ledger', () => {
  it('identical credit replay is idempotent (one entry, one sum)', () => {
    const storage = new FakeStorage();
    expect(recordLoopCloseCredit(storage, WALLET, 'sigA', 500n)).toBe('ok');
    expect(recordLoopCloseCredit(storage, WALLET, 'sigA', 500n)).toBe('already');
    const view = deriveAvailability(storage, WALLET);
    expect(view.creditLamports).toBe(500n);
    expect(storage.keys().filter((k) => k.startsWith(`${ledgerPrefix(WALLET)}credit:`))).toHaveLength(1);
  });

  it('a conflicting credit NEVER overwrites — original preserved, anomaly visible', () => {
    const storage = new FakeStorage();
    expect(recordLoopCloseCredit(storage, WALLET, 'sigA', 500n)).toBe('ok');
    const before = storage.raw(creditSigKey(WALLET, 'sigA'));
    expect(recordLoopCloseCredit(storage, WALLET, 'sigA', 999n)).toBe('conflict');
    expect(storage.raw(creditSigKey(WALLET, 'sigA'))).toBe(before);
    const view = deriveAvailability(storage, WALLET);
    expect(view.creditLamports).toBe(500n);
    expect(view.anomalies.some((a) => a.code === 'entry_conflict')).toBe(true);
  });

  it('rejects invalid credits (no signature / zero lamports) without touching storage', () => {
    const storage = new FakeStorage();
    expect(recordLoopCloseCredit(storage, WALLET, '', 500n)).toBe('invalid');
    expect(recordLoopCloseCredit(storage, WALLET, 'sigA', 0n)).toBe('invalid');
    expect(deriveAvailability(storage, WALLET).entries).toHaveLength(0);
  });

  it('missing close signature records a VISIBLE anomaly instead of inventing a credit key', () => {
    const storage = new FakeStorage();
    noteMissingCloseSignature(storage, WALLET, 123n, 'close-op-1');
    const view = deriveAvailability(storage, WALLET);
    expect(view.creditLamports).toBe(0n);
    expect(view.anomalies.some((a) => a.code === 'credit_missing_sig')).toBe(true);
  });

  it('interleaved cross-tab credit arriving DURING a pending drive is neither lost nor overwritten', async () => {
    const storage = new FakeStorage();
    expect(recordLoopCloseCredit(storage, WALLET, 'sigA', 500n)).toBe('ok');
    const firstRaw = storage.raw(creditSigKey(WALLET, 'sigA'));
    const record = begin(storage, 500n * 1000n, 'loop_return'); // any active request
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = async (): Promise<MockResponse> => {
      await gate;
      return mkRes(202, pendingBody(record));
    };
    const driving = driveWithdraw(storage, record, { fetchImpl });
    // "Other tab": append-only write of a NEW entry under its own key.
    storage.put(creditSigKey(WALLET, 'sigB'), ledgerCreditEntry('sigB', '700'));
    release();
    const out = await driving;
    expect(out.outcome).toBe('pending');
    const view = deriveAvailability(storage, WALLET);
    expect(view.creditLamports).toBe(1200n);
    expect(storage.raw(creditSigKey(WALLET, 'sigA'))).toBe(firstRaw); // untouched
  });

  it('debits > credits → exact negative discrepancy, never clamped; return sizing yields zero', () => {
    const storage = new FakeStorage();
    const entry: LedgerEntry = { v: 1, kind: 'debit', requestId: 'r1', origin: 'loop_return', lamports: '800', at: 'x' };
    expect(putLedgerEntry(storage, WALLET, debitKey(WALLET, 'r1'), entry)).toBe('ok');
    expect(recordLoopCloseCredit(storage, WALLET, 'sigA', 300n)).toBe('ok');
    const view = deriveAvailability(storage, WALLET);
    expect(view.negative).toBe(true);
    expect(view.availableLamports).toBe(-500n);
    expect(view.deficitLamports).toBe(500n);
    expect(computeReturnLamports(view.availableLamports, 10_000n)).toBe(0n);
  });

  it('malformed ledger payloads are surfaced (never deleted) and excluded from sums', () => {
    const storage = new FakeStorage();
    storage.put(`${ledgerPrefix(WALLET)}credit:sig:weird`, 'not json at all');
    expect(recordLoopCloseCredit(storage, WALLET, 'sigA', 300n)).toBe('ok');
    const view = deriveAvailability(storage, WALLET);
    expect(view.creditLamports).toBe(300n);
    expect(view.malformedKeys).toHaveLength(1);
    expect(storage.raw(`${ledgerPrefix(WALLET)}credit:sig:weird`)).toBe('not json at all');
  });

  it('balance is a CAP only — it can shrink a return but never create availability', () => {
    expect(computeReturnLamports(1_000_000n, 400_000n)).toBe(400_000n);
    expect(computeReturnLamports(400_000n, 1_000_000n)).toBe(400_000n);
    expect(computeReturnLamports(400_000n, 0n)).toBe(0n);
    expect(computeReturnLamports(0n, 1_000_000n)).toBe(0n);
    expect(maxSendableLamportsFromSol(0.01, 0.006)).toBe(4_000_000n);
    expect(maxSendableLamportsFromSol(0.005, 0.006)).toBe(0n);
    expect(maxSendableLamportsFromSol(null, 0.006)).toBe(0n);
    expect(maxSendableLamportsFromSol(Number.NaN, 0.006)).toBe(0n);
  });
});

// ── E. Legacy pending-return migration ───────────────────────────────────────

describe('legacy pending-return migration', () => {
  const cases: Array<{ raw: string; lamports: string }> = [
    { raw: '0.1234', lamports: '123400000' },
    { raw: ' 0.25 ', lamports: '250000000' },
    { raw: '0.30000000000000004', lamports: '300000000' }, // float artifact
    { raw: '1e-9', lamports: '1' }, // exponential notation
    { raw: '1.5e2', lamports: '150000000000' },
    { raw: '0', lamports: '0' },
  ];
  for (const c of cases) {
    it(`migrates ${JSON.stringify(c.raw)} → ${c.lamports} lamports, credit persisted BEFORE old key removal`, () => {
      const storage = new FakeStorage();
      storage.put(legacyPendingReturnKey(WALLET), c.raw);
      const res = migrateLegacyPendingReturn(storage, WALLET);
      expect(res.status).toBe('migrated');
      if (res.status === 'migrated') expect(res.lamports).toBe(c.lamports);
      expect(storage.raw(legacyPendingReturnKey(WALLET))).toBeNull();
      const credit = storage.raw(legacyCreditKey(WALLET));
      expect(credit).not.toBeNull();
      expect(JSON.parse(credit!)).toMatchObject({ kind: 'credit', source: 'legacy_migration', lamports: c.lamports });
      // Idempotent: nothing left to migrate, credit unchanged.
      expect(migrateLegacyPendingReturn(storage, WALLET).status).toBe('none');
    });
  }

  const invalids = ['', '   ', 'abc', '-1', 'NaN', 'Infinity', '-Infinity', '1e300'];
  for (const raw of invalids) {
    it(`preserves invalid legacy value ${JSON.stringify(raw)} with a visible anomaly and NO guessed credit`, () => {
      const storage = new FakeStorage();
      storage.put(legacyPendingReturnKey(WALLET), raw);
      const res = migrateLegacyPendingReturn(storage, WALLET);
      expect(res.status).toBe('invalid_preserved');
      expect(storage.raw(legacyPendingReturnKey(WALLET))).toBe(raw); // old state preserved
      expect(storage.raw(legacyCreditKey(WALLET))).toBeNull(); // no credit invented
      const view = deriveAvailability(storage, WALLET);
      expect(view.anomalies.some((a) => a.code === 'legacy_invalid')).toBe(true);
      expect(view.creditLamports).toBe(0n);
    });
  }

  it('completes a crash-interrupted migration (credit written, old key still present) without doubling', () => {
    const storage = new FakeStorage();
    storage.put(legacyPendingReturnKey(WALLET), '0.5');
    expect(migrateLegacyPendingReturn(storage, WALLET).status).toBe('migrated');
    // Crash replay: old key reappears with the SAME value.
    storage.put(legacyPendingReturnKey(WALLET), '0.5');
    expect(migrateLegacyPendingReturn(storage, WALLET).status).toBe('migrated');
    expect(deriveAvailability(storage, WALLET).creditLamports).toBe(500_000_000n);
  });

  it('a DIFFERENT legacy value against an existing legacy credit is preserved as a conflict anomaly', () => {
    const storage = new FakeStorage();
    storage.put(legacyPendingReturnKey(WALLET), '0.5');
    expect(migrateLegacyPendingReturn(storage, WALLET).status).toBe('migrated');
    storage.put(legacyPendingReturnKey(WALLET), '0.7');
    const res = migrateLegacyPendingReturn(storage, WALLET);
    expect(res.status).toBe('conflict_preserved');
    expect(storage.raw(legacyPendingReturnKey(WALLET))).toBe('0.7'); // preserved
    expect(deriveAvailability(storage, WALLET).creditLamports).toBe(500_000_000n); // original credit intact
    expect(deriveAvailability(storage, WALLET).anomalies.some((a) => a.code === 'entry_conflict')).toBe(true);
  });

  it('credit persistence failure keeps the old key untouched', () => {
    const storage = new FakeStorage();
    storage.put(legacyPendingReturnKey(WALLET), '0.5');
    storage.failSetFor = (k) => k === legacyCreditKey(WALLET);
    expect(migrateLegacyPendingReturn(storage, WALLET).status).toBe('persist_failed');
    expect(storage.raw(legacyPendingReturnKey(WALLET))).toBe('0.5');
  });
});

// ── F. Marked-region wiring + forbidden-send scanner ─────────────────────────

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const COORD_REL = 'client/src/lib/agent-sol-withdraw-coordinator.ts';
const WM_REL = 'client/src/pages/WalletManagement.tsx';
const LOOP_REL = 'client/src/components/LoopVaultControls.tsx';
const readRel = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const FORBIDDEN_SEND_TOKENS = [
  'sendRawTransaction',
  'signAndSendTransaction',
  'signTransaction(',
  'Transaction.from',
  'VersionedTransaction',
  'confirmTransactionWithFallback',
  'confirmTransactionFast',
  'atob(',
];

function extractRegion(src: string, tag: string): string {
  const b = `[WO2B2D:${tag}-BEGIN]`;
  const e = `[WO2B2D:${tag}-END]`;
  const i = src.indexOf(b);
  const j = src.indexOf(e);
  if (i === -1 || j === -1 || j <= i) throw new Error(`marked region ${tag} missing or inverted`);
  if (src.indexOf(b, i + b.length) !== -1 || src.indexOf(e, j + e.length) !== -1) {
    throw new Error(`marked region ${tag} duplicated`);
  }
  return src.slice(i, j);
}

/** Brace-matched body of `const NAME = …{…}` / `function NAME(…){…}`. */
function helperBody(src: string, name: string): string | null {
  for (const p of [`const ${name} = `, `function ${name}(`, `async function ${name}(`]) {
    const at = src.indexOf(p);
    if (at === -1) continue;
    const braceStart = src.indexOf('{', at);
    if (braceStart === -1) continue;
    let depth = 0;
    for (let i = braceStart; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(braceStart, i + 1);
      }
    }
  }
  return null;
}

/**
 * Scanner: flags forbidden browser-send tokens inside a marked region, OR
 * inside the body of any helper (defined anywhere in the file set) that the
 * region calls — i.e. a send hidden one helper deep is still caught.
 */
function scanWithdrawRegions(files: Record<string, string>, tags: Record<string, string[]>): string[] {
  const findings: string[] = [];
  for (const [file, regionTags] of Object.entries(tags)) {
    const src = files[file];
    if (!src) throw new Error(`scanner missing file ${file}`);
    for (const tag of regionTags) {
      const region = extractRegion(src, tag);
      for (const tok of FORBIDDEN_SEND_TOKENS) {
        if (region.includes(tok)) findings.push(`${file}:${tag}:direct:${tok}`);
      }
      const called = new Set<string>();
      for (const m of region.matchAll(/(?<![.\w])([A-Za-z_$][\w$]*)\s*\(/g)) called.add(m[1]);
      for (const name of called) {
        for (const [helperFile, helperSrc] of Object.entries(files)) {
          const body = helperBody(helperSrc, name);
          if (!body) continue;
          for (const tok of FORBIDDEN_SEND_TOKENS) {
            if (body.includes(tok)) findings.push(`${file}:${tag}:via:${name}@${helperFile}:${tok}`);
          }
        }
      }
    }
  }
  return findings;
}

function walkClientSrc(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) out.push(p);
    }
  };
  walk(join(ROOT, 'client/src'));
  return out;
}

describe('marked-region wiring (non-vacuous)', () => {
  const coordSrc = readRel(COORD_REL);
  const wmSrc = readRel(WM_REL);
  const loopSrc = readRel(LOOP_REL);

  it('all three marked regions exist exactly once and are substantive', () => {
    const coord = extractRegion(coordSrc, 'COORDINATOR-FETCH');
    const wm = extractRegion(wmSrc, 'WALLET-MGMT');
    const loop = extractRegion(loopSrc, 'LOOP-RETURN');
    expect(coord.length).toBeGreaterThan(200);
    expect(wm.length).toBeGreaterThan(1000);
    expect(loop.length).toBeGreaterThan(1000);
  });

  it('Wallet Management region drives the shared coordinator (not a private flow)', () => {
    const region = extractRegion(wmSrc, 'WALLET-MGMT');
    for (const token of ['beginWithdraw(', 'driveWithdraw(', 'readActiveRecord(', "'wallet_mgmt'", 'walletAuthHeaders()']) {
      expect(region, `WALLET-MGMT region must contain ${token}`).toContain(token);
    }
  });

  it('Loop region records the credit, migrates legacy state, and drives the shared coordinator', () => {
    const region = extractRegion(loopSrc, 'LOOP-RETURN');
    for (const token of [
      'recordLoopCloseCredit(',
      'noteMissingCloseSignature(',
      'migrateLegacyPendingReturn(',
      'deriveAvailability(',
      'beginWithdraw(',
      'driveWithdraw(',
      '"loop_return"',
      'computeReturnLamports(',
    ]) {
      expect(region, `LOOP-RETURN region must contain ${token}`).toContain(token);
    }
  });

  it('coordinator fetch region targets the durable endpoint and the whole module is send-free', () => {
    const region = extractRegion(coordSrc, 'COORDINATOR-FETCH');
    expect(region).toContain('DURABLE_WITHDRAW_ENDPOINT');
    for (const tok of FORBIDDEN_SEND_TOKENS) {
      expect(coordSrc, `coordinator must not contain ${tok}`).not.toContain(tok);
    }
  });

  it('region extraction is non-vacuous: tampered sources fail loudly', () => {
    expect(() => extractRegion(wmSrc.replace('[WO2B2D:WALLET-MGMT-BEGIN]', ''), 'WALLET-MGMT')).toThrow();
    expect(() => extractRegion(`${wmSrc}\n// [WO2B2D:WALLET-MGMT-BEGIN]`, 'WALLET-MGMT')).toThrow(/duplicated/);
  });
});

describe('forbidden browser-send scanner', () => {
  it('catches a direct in-region send', () => {
    const files = {
      'surface.tsx': `
        // [WO2B2D:FIXTURE-BEGIN]
        const go = async () => { const sig = await connection.sendRawTransaction(bytes); };
        // [WO2B2D:FIXTURE-END]
      `,
    };
    const findings = scanWithdrawRegions(files, { 'surface.tsx': ['FIXTURE'] });
    expect(findings.some((f) => f.includes('direct:sendRawTransaction'))).toBe(true);
  });

  it('catches a forbidden send nested ONE HELPER DEEP behind the region', () => {
    const files = {
      'surface.tsx': `
        // [WO2B2D:FIXTURE-BEGIN]
        const onClick = async () => { await doSend(); };
        // [WO2B2D:FIXTURE-END]
        const doSend = async () => {
          const tx = Transaction.from(buf);
          return connection.sendRawTransaction(tx.serialize());
        };
      `,
    };
    const findings = scanWithdrawRegions(files, { 'surface.tsx': ['FIXTURE'] });
    expect(findings.some((f) => f.includes('via:doSend@surface.tsx:sendRawTransaction'))).toBe(true);
    expect(findings.some((f) => f.includes('via:doSend@surface.tsx:Transaction.from'))).toBe(true);
  });

  it('passes a clean fixture (no false positives on coordinator-style code)', () => {
    const files = {
      'surface.tsx': `
        // [WO2B2D:FIXTURE-BEGIN]
        const onClick = async () => { await driveIt(); };
        // [WO2B2D:FIXTURE-END]
        const driveIt = async () => fetch('/api/x', { method: 'POST' });
      `,
    };
    expect(scanWithdrawRegions(files, { 'surface.tsx': ['FIXTURE'] })).toEqual([]);
  });

  it('REAL surfaces + coordinator scan clean, including one-helper-deep', () => {
    const files = {
      [WM_REL]: readRel(WM_REL),
      [LOOP_REL]: readRel(LOOP_REL),
      [COORD_REL]: readRel(COORD_REL),
    };
    const findings = scanWithdrawRegions(files, {
      [WM_REL]: ['WALLET-MGMT'],
      [LOOP_REL]: ['LOOP-RETURN'],
      [COORD_REL]: ['COORDINATOR-FETCH'],
    });
    expect(findings).toEqual([]);
  });
});

describe('endpoint call-site proofs (whole client/src sweep)', () => {
  const files = walkClientSrc();

  it('the durable endpoint literal appears ONLY in the shared coordinator', () => {
    const offenders = files
      .filter((p) => readFileSync(p, 'utf8').includes('/api/agent/withdraw-sol'))
      .map((p) => relative(ROOT, p).replace(/\\/g, '/'));
    expect(offenders).toEqual([COORD_REL]);
  });

  it('the neutralized legacy confirm endpoint has ZERO client callers', () => {
    const offenders = files
      .filter((p) => readFileSync(p, 'utf8').includes('/api/agent/confirm-sol-withdraw'))
      .map((p) => relative(ROOT, p).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('sanity: the sweep actually reads real files (non-vacuous)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((p) => relative(ROOT, p).replace(/\\/g, '/') === COORD_REL)).toBe(true);
  });
});

// ── G. Cross-tab record safety (compare-and-delete + ownership gate) ────────

describe('cross-tab record safety', () => {
  it('completing request A NEVER clears a different active record B (in-flight swap)', async () => {
    const storage = new FakeStorage();
    const A = begin(storage, 500_000n, 'loop_return');
    const B: DurableWithdrawRecord = { v: 1, id: 'tab2-winner', wallet: WALLET, lamports: '777000', origin: 'wallet_mgmt', createdAt: 'x' };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = async (): Promise<MockResponse> => {
      await gate;
      return mkRes(200, succeededBody(A));
    };
    const driving = driveWithdraw(storage, A, { fetchImpl });
    // Another tab replaces the slot with B while A's request is in flight.
    storage.put(requestKey(WALLET), JSON.stringify(B));
    release();
    const out = await driving;
    expect(out.outcome).toBe('success'); // A is finalized…
    const stored = readActiveRecord(storage, WALLET);
    expect(stored.status).toBe('active'); // …but B is untouched
    if (stored.status === 'active') expect(stored.record.id).toBe('tab2-winner');
    expect(storage.raw(requestKey(WALLET))).toBe(JSON.stringify(B));
    expect(storage.raw(debitKey(WALLET, A.id))).not.toBeNull(); // A's loop debit recorded
    expect(deriveAvailability(storage, WALLET).anomalies.some((a) => a.code === 'record_superseded')).toBe(true);
  });

  it('terminal failure for A also preserves B (compare-and-delete on the failure path)', async () => {
    const storage = new FakeStorage();
    const A = begin(storage, 500_000n, 'wallet_mgmt');
    const B: DurableWithdrawRecord = { v: 1, id: 'tab2-winner', wallet: WALLET, lamports: '888000', origin: 'loop_return', createdAt: 'x' };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchImpl = async (): Promise<MockResponse> => {
      await gate;
      return mkRes(400, failedBody(A, 'withdraw_failed_onchain'));
    };
    const driving = driveWithdraw(storage, A, { fetchImpl });
    storage.put(requestKey(WALLET), JSON.stringify(B));
    release();
    const out = await driving;
    expect(out.outcome).toBe('terminal_failure');
    expect((out as { cleared: boolean }).cleared).toBe(false); // B was NOT deleted
    expect(storage.raw(requestKey(WALLET))).toBe(JSON.stringify(B));
    expect(deriveAvailability(storage, WALLET).anomalies.some((a) => a.code === 'record_superseded')).toBe(true);
  });

  it('a stale record is refused BEFORE any network call', async () => {
    const storage = new FakeStorage();
    const A = begin(storage, 500_000n, 'wallet_mgmt');
    const B: DurableWithdrawRecord = { ...A, id: 'tab2-newer' };
    storage.put(requestKey(WALLET), JSON.stringify(B));
    const { fn, calls } = fetchSeq(mkRes(200, succeededBody(A)));
    const out = await driveWithdraw(storage, A, { fetchImpl: fn });
    expect(out.outcome).toBe('stale_record');
    expect((out as { currentRecordId: string | null }).currentRecordId).toBe('tab2-newer');
    expect(calls).toHaveLength(0); // no fetch fired
    expect(storage.raw(requestKey(WALLET))).toBe(JSON.stringify(B));
  });

  it('a record already finalized in another tab is not re-driven (zero fetches)', async () => {
    const storage = new FakeStorage();
    const A = begin(storage, 500_000n, 'wallet_mgmt');
    storage.removeItem(requestKey(WALLET)); // other tab completed + cleared it
    const { fn, calls } = fetchSeq(mkRes(200, succeededBody(A)));
    const out = await driveWithdraw(storage, A, { fetchImpl: fn });
    expect(out.outcome).toBe('stale_record');
    expect((out as { currentRecordId: string | null }).currentRecordId).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('dual-begin write race: the loser adopts the winner (single ID, no duplicate request)', () => {
    const storage = new FakeStorage();
    const B: DurableWithdrawRecord = { v: 1, id: 'winner-from-tab2', wallet: WALLET, lamports: '900000', origin: 'loop_return', createdAt: 'x' };
    // The other tab's write lands between our setItem and read-back verify.
    storage.overwriteAfterSet = { key: requestKey(WALLET), value: JSON.stringify(B) };
    const res = beginWithdraw(storage, WALLET, 500_000n, 'wallet_mgmt');
    expect(res.status).toBe('active_exists');
    if (res.status === 'active_exists') {
      expect(res.record.id).toBe('winner-from-tab2');
      expect(res.record.lamports).toBe('900000');
    }
    expect(storage.raw(requestKey(WALLET))).toBe(JSON.stringify(B)); // winner untouched
  });
});

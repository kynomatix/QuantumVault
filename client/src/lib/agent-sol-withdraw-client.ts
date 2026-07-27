/**
 * WO2B2DC1 — Canonical client coordinator for agent-wallet SOL withdrawals.
 *
 * Both client surfaces that return agent-wallet SOL to the user's wallet
 * (Wallet Management "Withdraw SOL" and the SOL Loop "Return to Wallet")
 * drive the SAME wallet-scoped durable request record through the
 * server-executed withdrawal endpoint. The browser never decodes, signs,
 * sends, or confirms a withdrawal transaction, and never calls the
 * neutralized legacy confirm endpoint.
 *
 * Durability contract:
 *  - A request record is persisted AND read back BEFORE the first request.
 *    Retries replay the same clientRequestId + exact amountLamports.
 *  - HTTP 200 + success:true + state:'succeeded' + exact-ID + exact-lamports
 *    is the ONLY success shape. Any success-shaped body on a non-200 status
 *    retains the record, writes no debit, and clears nothing.
 *  - Terminal failure (state:'failed' + terminal:true + exact-ID) is the
 *    ONLY clear other than success; it does not write a debit.
 *  - All other responses (auth/network/parse/mismatch/pending/unknown) retain.
 *
 * Web Locks serialization:
 *  - All coordinator actions that read/create/drive/finalize the request or
 *    append ledger entries go through the exclusive lock
 *    qv-agent-sol-withdraw:v1:<walletAddress>:lock.
 *  - If navigator.locks is unavailable or acquisition throws → fail closed
 *    with outcome 'coordination_unavailable' and zero money effects.
 *  - No fallback to localStorage lease, version CAS, or BroadcastChannel.
 *
 * Ledger blockers:
 *  - Any anomaly, malformed key, unreadable storage, or negative balance
 *    blocks creating a NEW loop_return request.
 *  - These blockers NEVER prevent Check/Retry of an existing valid request.
 *
 * Finalization:
 *  - Compares the complete stored record (version + clientRequestId +
 *    walletAddress + amountLamports + origin) — not just the ID.
 *    A superseded/replacement record is preserved with an anomaly; the
 *    outcome is never falsely reported as 'cleared'.
 */

// ─── Types & constants ──────────────────────────────────────────────────────

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export type WithdrawOrigin = 'wallet_management' | 'loop_return';

export interface DurableWithdrawRecord {
  version: 1;
  clientRequestId: string;
  walletAddress: string;
  /** Exact positive integer lamports as a decimal string. */
  amountLamports: string;
  origin: WithdrawOrigin;
  createdAt: string;
}

export type LedgerEntry =
  | { v: 1; kind: 'credit'; source: 'loop_close'; sig: string; lamports: string; at: string }
  | { v: 1; kind: 'credit'; source: 'legacy_migration'; raw: string; lamports: string; at: string }
  | { v: 1; kind: 'debit'; requestId: string; origin: WithdrawOrigin; lamports: string; at: string }
  | { v: 1; kind: 'anomaly'; code: string; detail: string; at: string };

export interface LedgerView {
  creditLamports: bigint;
  debitLamports: bigint;
  /** credits − debits; may be negative — never clamped. */
  availableLamports: bigint;
  negative: boolean;
  deficitLamports: bigint;
  anomalies: Array<{ key: string; code: string; detail: string }>;
  /** Keys holding unparseable or foreign payloads — surfaced, never deleted. */
  malformedKeys: string[];
  /** Debit request IDs parsed from debit entries (for deficit display). */
  debitRequestIds: string[];
  entries: Array<{ key: string; entry: LedgerEntry }>;
  /** True when the storage enumeration or a key read failed entirely. */
  storageUnreadable: boolean;
}

export type ActiveRecordRead =
  | { status: 'none' }
  | { status: 'active'; record: DurableWithdrawRecord }
  | { status: 'invalid'; raw: string }
  | { status: 'unreadable' };

export type CoordinatorOutcome =
  | { outcome: 'success'; signature: string | null; amountLamports: string; message: string }
  | { outcome: 'success_unfinalized'; reason: 'debit_persist_failed' | 'debit_conflict' | 'clear_failed' | 'record_mismatch_preserved'; message: string }
  | { outcome: 'terminal_failure'; cleared: boolean; message: string }
  | { outcome: 'pending'; message: string; signature: string | null }
  | { outcome: 'manual_review'; message: string; signature: string | null }
  | { outcome: 'conflict'; message: string }
  | { outcome: 'mismatched'; message: string }
  | { outcome: 'auth'; message: string }
  | { outcome: 'network'; message: string }
  | { outcome: 'parse'; message: string }
  | { outcome: 'unknown'; message: string }
  | { outcome: 'coordination_unavailable'; message: string }
  | { outcome: 'no_active_record'; message: string }
  | { outcome: 'blocked_invalid_record'; message: string }
  | { outcome: 'blocked_by_ledger'; reason: string; message: string }
  | { outcome: 'persist_failed'; message: string }
  | { outcome: 'invalid_amount'; reason: string; message: string }
  | { outcome: 'no_funds_available'; message: string }
  | { outcome: 'missing_sig_noted'; message: string }
  | { outcome: 'credit_persist_failed'; message: string };

export type CleanupOutcome =
  | { outcome: 'nothing_to_clean' }
  | { outcome: 'valid_record_kept' }
  | { outcome: 'cleaned' }
  | { outcome: 'persist_failed_retained'; message: string }
  | { outcome: 'remove_failed_retained'; message: string }
  | { outcome: 'coordination_unavailable'; message: string };

export type PutEntryStatus = 'ok' | 'already' | 'conflict' | 'persist_failed';

export type LegacyMigrationResult =
  | { status: 'none' }
  | { status: 'migrated'; lamports: string }
  | { status: 'migrated_key_stuck'; lamports: string }
  | { status: 'invalid_preserved'; reason: string; raw: string }
  | { status: 'conflict_preserved'; raw: string }
  | { status: 'persist_failed'; raw: string };

/**
 * The server-executed withdrawal endpoint. This constant is the ONLY place
 * this path may appear in client code (enforced by tests).
 */
export const DURABLE_WITHDRAW_ENDPOINT = '/api/agent/withdraw-sol';

export const MIN_WITHDRAW_LAMPORTS = 1000n;

// ─── Storage key builders ───────────────────────────────────────────────────

export const requestKey = (walletAddress: string) =>
  `qv-agent-sol-withdraw:v1:${walletAddress}`;

const creditPrefix = (walletAddress: string) =>
  `qv-loop-return-credit:v1:${walletAddress}:`;
const debitPrefix = (walletAddress: string) =>
  `qv-loop-return-debit:v1:${walletAddress}:`;
const anomalyPrefix = (walletAddress: string) =>
  `qv-loop-return-anomaly:v1:${walletAddress}:`;

export const creditKey = (walletAddress: string, sig: string) =>
  `${creditPrefix(walletAddress)}${sig}`;
export const debitKey = (walletAddress: string, requestId: string) =>
  `${debitPrefix(walletAddress)}${requestId}`;
export const anomalyKeyFor = (walletAddress: string, code: string, seed: string) =>
  `${anomalyPrefix(walletAddress)}${code}:${fnv1a(seed)}`;

export const legacyPendingReturnKey = (walletAddress: string) =>
  `qv-loop-pending-return:${walletAddress}`;

const lockName = (walletAddress: string) =>
  `qv-agent-sol-withdraw:v1:${walletAddress}:lock`;

// ─── Pure helpers ───────────────────────────────────────────────────────────

const isDigits = (s: unknown): s is string =>
  typeof s === 'string' && /^\d+$/.test(s);

const capText = (v: unknown, max = 400): string => {
  const s =
    typeof v === 'string'
      ? v
      : (() => {
          try { return JSON.stringify(v) ?? String(v); } catch { return String(v); }
        })();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** FNV-1a 32-bit — deterministic short subkeys for anomaly entries. */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const lamportsToSolNumber = (lamports: string): number => Number(lamports) / 1e9;

export function lamportsRoundTripExactly(lamports: string): boolean {
  if (!isDigits(lamports)) return false;
  const n = Number(lamports);
  if (!Number.isSafeInteger(n)) return false;
  return Math.round((n / 1e9) * 1e9) === n;
}

export function solNumberToLamports(sol: number): bigint | null {
  if (typeof sol !== 'number' || !Number.isFinite(sol) || sol <= 0) return null;
  const lam = Math.round(sol * 1e9);
  if (!Number.isSafeInteger(lam) || lam <= 0) return null;
  if (!lamportsRoundTripExactly(String(lam))) return null;
  return BigInt(lam);
}

export function lamportsToSolDisplay(lamports: bigint | string): string {
  const v = typeof lamports === 'bigint' ? lamports : BigInt(lamports);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function computeReturnLamports(available: bigint, cap: bigint): bigint {
  if (available <= 0n || cap <= 0n) return 0n;
  return available < cap ? available : cap;
}

export function maxSendableLamportsFromSol(
  solBalance: number | null | undefined,
  reserveSol: number,
): bigint {
  if (typeof solBalance !== 'number' || !Number.isFinite(solBalance)) return 0n;
  const lam = Math.round((solBalance - reserveSol) * 1e9);
  if (!Number.isSafeInteger(lam) || lam <= 0) return 0n;
  return BigInt(lam);
}

function genClientRequestId(): string {
  const c: Crypto | undefined = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const nowIso = (): string => new Date().toISOString();

// ─── Guarded storage primitives ─────────────────────────────────────────────

function safeGet(
  storage: StorageLike,
  key: string,
): { ok: true; value: string | null } | { ok: false } {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false };
  }
}

function safeSetVerified(storage: StorageLike, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
  } catch {
    return false;
  }
  const back = safeGet(storage, key);
  return back.ok && back.value === value;
}

function safeRemoveVerified(storage: StorageLike, key: string): boolean {
  try {
    storage.removeItem(key);
  } catch {
    return false;
  }
  const back = safeGet(storage, key);
  return back.ok && back.value === null;
}

// ─── Append-only ledger ──────────────────────────────────────────────────────

function parseEntry(raw: string): LedgerEntry | null {
  try {
    const v = JSON.parse(raw) as LedgerEntry;
    if (!v || typeof v !== 'object' || (v as { v?: unknown }).v !== 1) return null;
    if (v.kind === 'credit') {
      if (!isDigits(v.lamports)) return null;
      if (v.source === 'loop_close' && typeof v.sig !== 'string') return null;
      if (v.source === 'legacy_migration' && typeof v.raw !== 'string') return null;
      if (v.source !== 'loop_close' && v.source !== 'legacy_migration') return null;
      return v;
    }
    if (v.kind === 'debit') {
      if (!isDigits(v.lamports) || typeof v.requestId !== 'string') return null;
      return v;
    }
    if (v.kind === 'anomaly') {
      if (typeof v.code !== 'string' || typeof v.detail !== 'string') return null;
      return v;
    }
    return null;
  } catch {
    return null;
  }
}

function entryEquivalent(a: LedgerEntry, b: LedgerEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'credit' && b.kind === 'credit') {
    if (a.source !== b.source || a.lamports !== b.lamports) return false;
    if (a.source === 'loop_close' && b.source === 'loop_close') return a.sig === b.sig;
    if (a.source === 'legacy_migration' && b.source === 'legacy_migration') return a.raw === b.raw;
    return false;
  }
  if (a.kind === 'debit' && b.kind === 'debit') {
    return a.requestId === b.requestId && a.lamports === b.lamports && a.origin === b.origin;
  }
  if (a.kind === 'anomaly' && b.kind === 'anomaly') {
    return a.code === b.code && a.detail === b.detail;
  }
  return false;
}

export function putLedgerEntry(
  storage: StorageLike,
  walletAddress: string,
  key: string,
  entry: LedgerEntry,
): PutEntryStatus {
  const existing = safeGet(storage, key);
  if (!existing.ok) return 'persist_failed';
  if (existing.value !== null) {
    const parsed = parseEntry(existing.value);
    if (parsed && entryEquivalent(parsed, entry)) return 'already';
    writeAnomaly(storage, walletAddress, 'entry_conflict', `${key}|${JSON.stringify(entry)}`, {
      key,
      existing: capText(existing.value, 200),
      attempted: capText(JSON.stringify(entry), 200),
    });
    return 'conflict';
  }
  return safeSetVerified(storage, key, JSON.stringify(entry)) ? 'ok' : 'persist_failed';
}

export function writeAnomaly(
  storage: StorageLike,
  walletAddress: string,
  code: string,
  seed: string,
  detail: unknown,
): void {
  const key = anomalyKeyFor(walletAddress, code, seed);
  const entry: LedgerEntry = {
    v: 1, kind: 'anomaly', code, detail: capText(detail), at: nowIso(),
  };
  const existing = safeGet(storage, key);
  if (!existing.ok || existing.value !== null) return; // first-write-wins
  safeSetVerified(storage, key, JSON.stringify(entry));
}

function deriveAvailabilityInternal(
  storage: StorageLike,
  walletAddress: string,
): LedgerView {
  const prefixes = [creditPrefix(walletAddress), debitPrefix(walletAddress), anomalyPrefix(walletAddress)];
  const keys: string[] = [];
  let storageUnreadable = false;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && prefixes.some((p) => k.startsWith(p))) keys.push(k);
    }
  } catch {
    storageUnreadable = true;
  }
  let credit = 0n;
  let debit = 0n;
  const anomalies: LedgerView['anomalies'] = [];
  const malformedKeys: string[] = [];
  const debitRequestIds: string[] = [];
  const entries: LedgerView['entries'] = [];
  for (const key of keys.sort()) {
    const raw = safeGet(storage, key);
    if (!raw.ok) { storageUnreadable = true; continue; }
    if (raw.value === null) continue;
    const entry = parseEntry(raw.value);
    if (!entry) {
      malformedKeys.push(key); // malformed debit stays in malformedKeys, never omitted
      continue;
    }
    entries.push({ key, entry });
    if (entry.kind === 'credit') credit += BigInt(entry.lamports);
    else if (entry.kind === 'debit') {
      debit += BigInt(entry.lamports);
      debitRequestIds.push(entry.requestId);
    } else {
      anomalies.push({ key, code: entry.code, detail: entry.detail });
    }
  }
  const available = credit - debit;
  return {
    creditLamports: credit, debitLamports: debit,
    availableLamports: available, negative: available < 0n,
    deficitLamports: available < 0n ? -available : 0n,
    anomalies, malformedKeys, debitRequestIds, entries, storageUnreadable,
  };
}

// ─── Record read/write ───────────────────────────────────────────────────────

function readRecordFromStorage(
  storage: StorageLike,
  walletAddress: string,
): ActiveRecordRead {
  const read = safeGet(storage, requestKey(walletAddress));
  if (!read.ok) return { status: 'unreadable' };
  if (read.value === null) return { status: 'none' };
  try {
    const r = JSON.parse(read.value) as DurableWithdrawRecord;
    const idOk =
      typeof r.clientRequestId === 'string' &&
      r.clientRequestId.trim().length >= 1 &&
      r.clientRequestId.trim().length <= 128 &&
      r.clientRequestId === r.clientRequestId.trim();
    const originOk = r.origin === 'wallet_management' || r.origin === 'loop_return';
    if (
      r && typeof r === 'object' && r.version === 1 && idOk &&
      r.walletAddress === walletAddress && isDigits(r.amountLamports) &&
      BigInt(r.amountLamports) > 0n && originOk && typeof r.createdAt === 'string'
    ) {
      return { status: 'active', record: r };
    }
    return { status: 'invalid', raw: read.value };
  } catch {
    return { status: 'invalid', raw: read.value };
  }
}

function writeRecordToStorage(
  storage: StorageLike,
  record: DurableWithdrawRecord,
): boolean {
  return safeSetVerified(storage, requestKey(record.walletAddress), JSON.stringify(record));
}

// ─── HTTP classification ─────────────────────────────────────────────────────

type Classified =
  | { kind: 'matched_success'; signature: string | null }
  | { kind: 'matched_terminal_failure'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'pending'; message: string; signature: string | null }
  | { kind: 'manual_review'; message: string; signature: string | null }
  | { kind: 'mismatched'; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'unknown'; message: string };

/**
 * Status-aware classification. HTTP 200 + success:true + state:'succeeded' +
 * exact clientRequestId + exact withdrawnLamports is the ONLY success shape.
 * A success-shaped body on any non-200 status RETAINS the record.
 *
 * Pending requires pending:true + exact ID on expected 202 / 400 / 409 status.
 * Terminal failure (state:'failed' + terminal:true + exact ID) clears on any
 * status.
 */
function classifyHttpResponse(
  status: number,
  body: unknown,
  record: DurableWithdrawRecord,
): Classified {
  if (status === 401 || status === 403) {
    return { kind: 'auth', message: 'Session expired — reconnect your wallet, then retry.' };
  }
  if (!body || typeof body !== 'object') {
    return { kind: 'unknown', message: `Unrecognized server response: ${capText(body, 120)}` };
  }
  const b = body as Record<string, unknown>;
  const crid = typeof b.clientRequestId === 'string' ? b.clientRequestId : null;

  // Terminal failure — any status, exact ID.
  if (b.state === 'failed' && b.terminal === true && crid === record.clientRequestId) {
    const msg = capText(b.error ?? 'The withdrawal failed; no funds were moved.');
    if (b.step === 'withdraw_conflict') return { kind: 'conflict', message: msg };
    return { kind: 'matched_terminal_failure', message: msg };
  }

  // Success — ONLY on HTTP 200 with full shape match.
  if (status === 200 && b.success === true && b.state === 'succeeded' && crid === record.clientRequestId) {
    const wl = b.withdrawnLamports;
    if (isDigits(wl) && BigInt(wl) === BigInt(record.amountLamports)) {
      return { kind: 'matched_success', signature: typeof b.signature === 'string' ? b.signature : null };
    }
    return {
      kind: 'mismatched',
      message: 'Server reports success but for a different amount; keeping the record for review.',
    };
  }

  // Success-shaped on non-200 → mismatched (retained — never clear).
  if (status !== 200 && b.success === true && b.state === 'succeeded') {
    return {
      kind: 'mismatched',
      message: `Server returned success on HTTP ${status} (expected 200); keeping the record for review.`,
    };
  }

  // Pending — requires pending:true + exact ID on expected status codes.
  if (b.state === 'pending' && b.pending === true && crid === record.clientRequestId) {
    const sig = typeof b.signature === 'string' ? b.signature : null;
    if (status === 409) {
      const msg = capText(b.message ?? 'Manual review required.');
      return { kind: 'manual_review', message: msg, signature: sig };
    }
    if (status === 400) {
      // Re-key: preserve the truthful server error text.
      const msg = capText(b.error ?? b.message ?? 'The request needs to be re-sent with a new key; retrying is safe.');
      return { kind: 'pending', message: msg, signature: sig };
    }
    if (status === 202) {
      const msg = capText(b.message ?? 'Withdrawal is still being processed.');
      return { kind: 'pending', message: msg, signature: sig };
    }
  }

  // ID mismatch with a non-empty crid.
  if (crid !== null && crid !== record.clientRequestId) {
    return {
      kind: 'mismatched',
      message: 'Server answered for a different withdrawal request; keeping this one for retry.',
    };
  }

  return { kind: 'unknown', message: capText(b.error ?? b.message ?? 'Unrecognized server response.') };
}

// ─── Finalization (complete record) ─────────────────────────────────────────

type FinalizeResult = 'cleared' | 'superseded' | 'clear_failed';

/**
 * Compares the COMPLETE stored record (version + clientRequestId + walletAddress
 * + amountLamports + origin — createdAt excluded) before removing. A different
 * or unreadable stored record is NEVER deleted; a first-write-wins anomaly is
 * written and 'superseded' is returned.
 */
function finalizeRecord(
  storage: StorageLike,
  record: DurableWithdrawRecord,
): FinalizeResult {
  const key = requestKey(record.walletAddress);
  const read = safeGet(storage, key);
  if (!read.ok) return 'clear_failed';
  if (read.value === null) return 'cleared'; // already finalized — idempotent

  let matches = false;
  try {
    const stored = JSON.parse(read.value) as DurableWithdrawRecord;
    matches =
      stored.version === record.version &&
      stored.clientRequestId === record.clientRequestId &&
      stored.walletAddress === record.walletAddress &&
      stored.amountLamports === record.amountLamports &&
      stored.origin === record.origin;
  } catch {
    matches = false;
  }

  if (!matches) {
    writeAnomaly(
      storage, record.walletAddress,
      'record_finalize_mismatch',
      `${record.clientRequestId}|${capText(read.value, 60)}`,
      {
        finalizedId: record.clientRequestId,
        storedRecord: capText(read.value, 200),
        note: 'Finalization found a different record in the slot; nothing was deleted.',
      },
    );
    return 'superseded';
  }
  return safeRemoveVerified(storage, key) ? 'cleared' : 'clear_failed';
}

// ─── Ledger blocker check ────────────────────────────────────────────────────

function ledgerBlocksNewLoopReturn(
  view: LedgerView,
): { blocked: false } | { blocked: true; reason: string } {
  if (view.storageUnreadable) return { blocked: true, reason: 'storage_unreadable' };
  if (view.malformedKeys.length > 0) return { blocked: true, reason: 'malformed_entries' };
  if (view.anomalies.length > 0) return { blocked: true, reason: 'anomalies_present' };
  if (view.negative) return { blocked: true, reason: 'negative_balance' };
  return { blocked: false };
}

// ─── Inner drive (inside lock, no re-lock) ───────────────────────────────────

interface FetchOpts {
  fetchImpl?: (url: string, init: {
    method: string;
    credentials: 'include';
    headers: Record<string, string>;
    body: string;
  }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  headers?: Record<string, string>;
}

async function innerDrive(
  storage: StorageLike,
  record: DurableWithdrawRecord,
  fetchOpts?: FetchOpts,
): Promise<CoordinatorOutcome> {
  const doFetch = fetchOpts?.fetchImpl ?? ((u: string, i: Parameters<typeof fetch>[1]) => fetch(u, i));

  // [C1:FETCH-BEGIN] — the sole client call to the server-executed withdrawal
  // endpoint. The browser posts intent only; the server executes and confirms
  // the on-chain transaction. No browser decode/sign/send/confirm here.
  let res: { status: number; json: () => Promise<unknown> };
  try {
    res = await doFetch(DURABLE_WITHDRAW_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(fetchOpts?.headers ?? {}),
      },
      body: JSON.stringify({
        clientRequestId: record.clientRequestId,
        amount: lamportsToSolNumber(record.amountLamports),
      }),
    });
  } catch (e) {
    return {
      outcome: 'network',
      message: capText((e as Error)?.message ?? 'Network error', 200),
    };
  }
  // [C1:FETCH-END]

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      outcome: 'parse',
      message: 'Unreadable server response; the withdrawal request is kept for retry.',
    };
  }

  const c = classifyHttpResponse(res.status, body, record);

  switch (c.kind) {
    case 'matched_success': {
      // For loop_return origin: write debit BEFORE finalization.
      if (record.origin === 'loop_return') {
        const entry: LedgerEntry = {
          v: 1, kind: 'debit', requestId: record.clientRequestId,
          origin: record.origin, lamports: record.amountLamports, at: nowIso(),
        };
        const put = putLedgerEntry(storage, record.walletAddress, debitKey(record.walletAddress, record.clientRequestId), entry);
        if (put === 'persist_failed') {
          return {
            outcome: 'success_unfinalized', reason: 'debit_persist_failed',
            message: 'Withdrawal completed on-chain; retry to finish local bookkeeping (same request, no new withdrawal).',
          };
        }
        if (put === 'conflict') {
          return {
            outcome: 'success_unfinalized', reason: 'debit_conflict',
            message: 'Withdrawal completed, but local records disagree; kept visible for review.',
          };
        }
      }
      const fin = finalizeRecord(storage, record);
      if (fin === 'superseded') {
        return {
          outcome: 'success_unfinalized', reason: 'record_mismatch_preserved',
          message: 'Withdrawal completed; a different request occupies the slot — kept for review.',
        };
      }
      if (fin === 'clear_failed') {
        return {
          outcome: 'success_unfinalized', reason: 'clear_failed',
          message: 'Withdrawal completed; retry to clear the finished request (no new withdrawal will be made).',
        };
      }
      return {
        outcome: 'success',
        signature: c.signature,
        amountLamports: record.amountLamports,
        message: `Withdrew ${lamportsToSolDisplay(record.amountLamports)} SOL to your wallet.`,
      };
    }
    case 'matched_terminal_failure': {
      const fin = finalizeRecord(storage, record);
      return {
        outcome: 'terminal_failure',
        cleared: fin === 'cleared',
        message: c.message,
      };
    }
    case 'conflict': {
      writeAnomaly(storage, record.walletAddress, 'withdraw_conflict', `${record.clientRequestId}|conflict`, {
        requestId: record.clientRequestId, message: c.message,
      });
      return { outcome: 'conflict', message: c.message };
    }
    case 'mismatched': {
      writeAnomaly(storage, record.walletAddress, 'response_mismatch', `${record.clientRequestId}|${c.message.slice(0, 40)}`, {
        requestId: record.clientRequestId, message: c.message,
      });
      return { outcome: 'mismatched', message: c.message };
    }
    case 'pending':
      return { outcome: 'pending', message: c.message, signature: c.signature };
    case 'manual_review':
      return { outcome: 'manual_review', message: c.message, signature: c.signature };
    case 'auth':
      return { outcome: 'auth', message: c.message };
    default:
      return { outcome: 'unknown', message: c.message };
  }
}

// ─── Web Lock wrapper ────────────────────────────────────────────────────────

interface LockManager {
  request<T>(
    name: string,
    opts: { mode: 'exclusive' },
    fn: () => Promise<T>,
  ): Promise<T>;
}

async function withWalletLock<T>(
  walletAddress: string,
  fn: () => Promise<T>,
): Promise<T | { outcome: 'coordination_unavailable'; message: string }> {
  const nav = (globalThis as { navigator?: { locks?: LockManager } }).navigator;
  const locks = nav?.locks;
  if (!locks) {
    return {
      outcome: 'coordination_unavailable',
      message: 'Your browser does not support the Web Locks API. Update your browser or use a different one to perform SOL withdrawals.',
    };
  }
  try {
    return await locks.request(lockName(walletAddress), { mode: 'exclusive' }, fn);
  } catch (e) {
    return {
      outcome: 'coordination_unavailable',
      message: `Could not acquire withdrawal coordination lock: ${capText((e as Error)?.message ?? String(e), 150)}`,
    };
  }
}

// ─── Coordinator options ─────────────────────────────────────────────────────

export interface CoordinatorOpts extends FetchOpts {
  storage?: StorageLike;
}

function resolveStorage(opts?: CoordinatorOpts): StorageLike {
  return opts?.storage ?? window.localStorage;
}

// ─── High-level coordinator actions (all under exclusive Web Lock) ───────────

/**
 * Create (or adopt) + drive the wallet's single durable withdrawal request.
 * For 'loop_return' origin: also checks ledger blockers before creating a new
 * request. An existing valid record is ALWAYS adopted and driven first,
 * regardless of origin — the slot holds one request at a time.
 */
export async function coordinateWithdraw(
  walletAddress: string,
  amountLamports: bigint,
  origin: WithdrawOrigin,
  opts?: CoordinatorOpts,
): Promise<CoordinatorOutcome> {
  if (!walletAddress) return { outcome: 'invalid_amount', reason: 'no_wallet', message: 'No wallet address.' };
  if (amountLamports < MIN_WITHDRAW_LAMPORTS) {
    return { outcome: 'invalid_amount', reason: 'below_min', message: 'Amount below the server minimum.' };
  }
  const lamStr = amountLamports.toString();
  if (!lamportsRoundTripExactly(lamStr)) {
    return { outcome: 'invalid_amount', reason: 'not_representable', message: 'Amount cannot be represented exactly.' };
  }

  const storage = resolveStorage(opts);
  const lockResult = await withWalletLock(walletAddress, async (): Promise<CoordinatorOutcome> => {
    // Re-read inside the lock.
    const existing = readRecordFromStorage(storage, walletAddress);
    if (existing.status === 'active') {
      // Adopt existing record — drive it, do not overwrite with the input amount.
      return innerDrive(storage, existing.record, opts);
    }
    if (existing.status === 'invalid' || existing.status === 'unreadable') {
      if (existing.status === 'invalid') {
        writeAnomaly(storage, walletAddress, 'invalid_request_record', existing.raw, {
          raw: capText(existing.raw, 200), note: 'Malformed record preserved; cleanup required before new request.',
        });
      }
      return {
        outcome: 'blocked_invalid_record',
        message: 'A stored withdrawal record could not be read; it was preserved. Use the cleanup action before starting a new withdrawal.',
      };
    }
    // No existing record.
    if (origin === 'loop_return') {
      const ledger = deriveAvailabilityInternal(storage, walletAddress);
      const block = ledgerBlocksNewLoopReturn(ledger);
      if (block.blocked) {
        return {
          outcome: 'blocked_by_ledger',
          reason: block.reason,
          message: 'Return blocked: local ledger has ' + block.reason.replace(/_/g, ' ') +
            '. Resolve the issue shown in the recovery row before starting a new return.',
        };
      }
    }
    const record: DurableWithdrawRecord = {
      version: 1, clientRequestId: genClientRequestId(),
      walletAddress, amountLamports: lamStr, origin, createdAt: nowIso(),
    };
    if (!writeRecordToStorage(storage, record)) {
      return {
        outcome: 'persist_failed',
        message: 'Could not save the withdrawal request. Free some browser storage, then try again.',
      };
    }
    return innerDrive(storage, record, opts);
  });
  return lockResult as CoordinatorOutcome;
}

/**
 * Drive the wallet's existing durable request without creating a new one.
 * Both surfaces use this for Check / Retry.
 */
export async function coordinateCheckRetry(
  walletAddress: string,
  opts?: CoordinatorOpts,
): Promise<CoordinatorOutcome> {
  if (!walletAddress) return { outcome: 'no_active_record', message: 'No wallet address.' };
  const storage = resolveStorage(opts);
  const lockResult = await withWalletLock(walletAddress, async (): Promise<CoordinatorOutcome> => {
    const existing = readRecordFromStorage(storage, walletAddress);
    if (existing.status !== 'active') {
      return { outcome: 'no_active_record', message: 'No active withdrawal request found.' };
    }
    return innerDrive(storage, existing.record, opts);
  });
  return lockResult as CoordinatorOutcome;
}

/**
 * Cleanup a malformed (unreadable) request record under the exclusive lock:
 * persist bounded evidence under the anomaly prefix, then remove and verify.
 * Makes ZERO network calls. If evidence persist or removal fails, retains.
 */
export async function coordinateCleanupMalformed(
  walletAddress: string,
  opts?: { storage?: StorageLike },
): Promise<CleanupOutcome> {
  if (!walletAddress) return { outcome: 'nothing_to_clean' };
  const storage = opts?.storage ?? window.localStorage;
  const lockResult = await withWalletLock(walletAddress, async (): Promise<CleanupOutcome> => {
    const read = readRecordFromStorage(storage, walletAddress);
    if (read.status === 'none') return { outcome: 'nothing_to_clean' };
    if (read.status === 'active') return { outcome: 'valid_record_kept' };

    const rawValue = read.status === 'invalid' ? read.raw : '(unreadable)';
    // Persist bounded evidence under anomaly prefix.
    const evidenceKey = anomalyKeyFor(walletAddress, 'malformed_record_cleaned', rawValue);
    const evidence: LedgerEntry = {
      v: 1, kind: 'anomaly', code: 'malformed_record_cleaned',
      detail: capText({ raw: capText(rawValue, 200), note: 'Malformed request record removed via explicit cleanup action.' }),
      at: nowIso(),
    };
    const evidenceOk = safeSetVerified(storage, evidenceKey, JSON.stringify(evidence));
    if (!evidenceOk) {
      return {
        outcome: 'persist_failed_retained',
        message: 'Could not persist cleanup evidence; the malformed record was retained.',
      };
    }
    // Verify evidence is readable.
    const evidenceBack = safeGet(storage, evidenceKey);
    if (!evidenceBack.ok || evidenceBack.value === null) {
      return {
        outcome: 'persist_failed_retained',
        message: 'Cleanup evidence did not read back; the malformed record was retained.',
      };
    }
    // Remove and verify.
    if (!safeRemoveVerified(storage, requestKey(walletAddress))) {
      return {
        outcome: 'remove_failed_retained',
        message: 'Could not remove the malformed record; it was retained.',
      };
    }
    return { outcome: 'cleaned' };
  });
  return lockResult as CleanupOutcome;
}

/**
 * Loop close/unwind continuation: record the signature-keyed credit (if sig
 * provided), re-derive state, adopt an existing request or create at most one
 * new one (subject to ledger blockers), then drive. A second tab waiting on
 * the same lock re-derives after the first; if the first's matched success
 * consumed the credit (debit written), the waiter's available balance is 0
 * and no new request is created.
 */
export async function coordinateLoopReturn(
  walletAddress: string,
  sig: string | undefined,
  proceedsLamports: bigint,
  opts?: CoordinatorOpts,
): Promise<CoordinatorOutcome> {
  if (!walletAddress) return { outcome: 'no_funds_available', message: 'No wallet address.' };
  const storage = resolveStorage(opts);

  const lockResult = await withWalletLock(walletAddress, async (): Promise<CoordinatorOutcome> => {
    // 1. Record the credit if a valid signature and positive proceeds.
    if (proceedsLamports > 0n) {
      if (typeof sig === 'string' && sig.trim().length > 0) {
        const entry: LedgerEntry = {
          v: 1, kind: 'credit', source: 'loop_close', sig, lamports: proceedsLamports.toString(), at: nowIso(),
        };
        const put = putLedgerEntry(storage, walletAddress, creditKey(walletAddress, sig), entry);
        if (put === 'persist_failed') {
          return {
            outcome: 'credit_persist_failed',
            message: 'Could not record the SOL proceeds credit. The funds are in the agent wallet; use Return to Wallet to recover them.',
          };
        }
        // 'ok' | 'already' | 'conflict' — proceed; if conflict an anomaly was written.
      } else {
        // Missing signature: record anomaly, no credit.
        writeAnomaly(
          storage, walletAddress, 'credit_missing_sig',
          `close-${proceedsLamports.toString()}|${Date.now()}`,
          {
            lamports: proceedsLamports.toString(),
            note: 'Close/unwind reported SOL proceeds without a tx signature; credit not recorded.',
          },
        );
        return {
          outcome: 'missing_sig_noted',
          message: 'Close reported SOL proceeds without a transaction signature; nothing was auto-sent. The recovery row shows the situation.',
        };
      }
    }

    // 2. Re-derive inside the lock (second tab sees the debit the first tab wrote).
    const ledger = deriveAvailabilityInternal(storage, walletAddress);

    // 3. Adopt any existing valid request first (bypasses ledger blockers).
    const existing = readRecordFromStorage(storage, walletAddress);
    if (existing.status === 'active') {
      return innerDrive(storage, existing.record, opts);
    }
    if (existing.status === 'invalid' || existing.status === 'unreadable') {
      if (existing.status === 'invalid') {
        writeAnomaly(storage, walletAddress, 'invalid_request_record', existing.raw, {
          raw: capText(existing.raw, 200), note: 'Malformed record preserved; cleanup required.',
        });
      }
      return {
        outcome: 'blocked_invalid_record',
        message: 'A stored withdrawal record could not be read; use the cleanup action.',
      };
    }

    // 4. Check ledger blockers for creating a new request.
    const block = ledgerBlocksNewLoopReturn(ledger);
    if (block.blocked) {
      return {
        outcome: 'blocked_by_ledger',
        reason: block.reason,
        message: 'Auto-return blocked: ledger has ' + block.reason.replace(/_/g, ' ') + '. The recovery row shows available actions.',
      };
    }

    // 5. Cap-only sizing: ledger availability caps the amount; balance is NOT a source.
    const amt = ledger.availableLamports;
    if (amt < MIN_WITHDRAW_LAMPORTS) {
      return { outcome: 'no_funds_available', message: 'Nothing to return yet.' };
    }
    const lamStr = amt.toString();
    if (!lamportsRoundTripExactly(lamStr)) {
      return { outcome: 'invalid_amount', reason: 'not_representable', message: 'Amount cannot be represented exactly.' };
    }

    // 6. Create and drive.
    const record: DurableWithdrawRecord = {
      version: 1, clientRequestId: genClientRequestId(),
      walletAddress, amountLamports: lamStr, origin: 'loop_return', createdAt: nowIso(),
    };
    if (!writeRecordToStorage(storage, record)) {
      return {
        outcome: 'persist_failed',
        message: 'Could not save the return request. Free some browser storage, then retry.',
      };
    }
    return innerDrive(storage, record, opts);
  });
  return lockResult as CoordinatorOutcome;
}

// ─── Display-only reads (no lock needed — reads are idempotent) ──────────────

export function readActiveRecordForDisplay(
  walletAddress: string,
  storage?: StorageLike,
): ActiveRecordRead {
  if (!walletAddress) return { status: 'none' };
  return readRecordFromStorage(storage ?? window.localStorage, walletAddress);
}

export function readLedgerViewForDisplay(
  walletAddress: string,
  storage?: StorageLike,
): LedgerView {
  return deriveAvailabilityInternal(storage ?? window.localStorage, walletAddress);
}

// ─── Storage-only legacy migration (no lock — idempotent, mount-safe) ────────

/**
 * One-time deterministic migration of the legacy wallet-scoped numeric
 * pending-return value into an append-only ledger credit. The credit is
 * persisted and read back BEFORE the old key is removed; invalid/negative/
 * empty/non-finite state is preserved with a visible anomaly — never guessed.
 * Safe to call without the lock on mount: credit key is per-sig/deterministic.
 */
export function migrateLegacyPendingReturn(
  walletAddress: string,
  storage?: StorageLike,
): LegacyMigrationResult {
  const st = storage ?? window.localStorage;
  const oldKey = legacyPendingReturnKey(walletAddress);
  const rawRead = safeGet(st, oldKey);
  if (!rawRead.ok || rawRead.value === null) return { status: 'none' };
  const raw = rawRead.value;
  const trimmed = raw.trim();

  const invalid = (reason: string): LegacyMigrationResult => {
    writeAnomaly(st, walletAddress, 'legacy_invalid', `${oldKey}|${raw}`, {
      reason, raw: capText(raw, 100), note: 'Old pending-return value preserved; no credit was guessed.',
    });
    return { status: 'invalid_preserved', reason, raw };
  };

  if (trimmed === '') return invalid('empty');
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return invalid('non_finite');
  if (n < 0) return invalid('negative');
  const lam = Math.round(n * 1e9);
  if (!Number.isSafeInteger(lam) || lam < 0) return invalid('unsafe_lamports');

  const legacyCreditKeyStr = `${creditPrefix(walletAddress)}legacy_migration`;
  const entry: LedgerEntry = {
    v: 1, kind: 'credit', source: 'legacy_migration', raw: trimmed, lamports: String(lam), at: nowIso(),
  };
  const put = putLedgerEntry(st, walletAddress, legacyCreditKeyStr, entry);
  if (put === 'persist_failed') return { status: 'persist_failed', raw };
  if (put === 'conflict') return { status: 'conflict_preserved', raw };
  if (!safeRemoveVerified(st, oldKey)) return { status: 'migrated_key_stuck', lamports: String(lam) };
  return { status: 'migrated', lamports: String(lam) };
}

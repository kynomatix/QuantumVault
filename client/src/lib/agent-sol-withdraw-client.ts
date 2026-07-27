/**
 * WO2B2DC3 — Canonical client coordinator for agent-wallet SOL withdrawals.
 *
 * Both client surfaces (Wallet Management "Withdraw SOL" and SOL Loop
 * "Return to Wallet") drive the same wallet-scoped durable request record
 * through the server-executed withdrawal endpoint. The browser never decodes,
 * signs, sends, or confirms a withdrawal transaction.
 *
 * Changes from C2 → C3:
 *  - invalid_request_record added to NON_BLOCKING_ANOMALY_CODES: it is audit
 *    evidence from a blocked attempt, not an unresolved accounting error. The
 *    malformed request slot is checked before the ledger blocker, so the slot
 *    remains gated until cleanup succeeds.
 *  - countBlockingAnomalies() exported: authoritative helper for UI surfaces so
 *    they exclude non-blocking evidence from button-disabled / warning counts.
 *  - capProvider option added to CoordinatorOpts: async provider invoked AFTER
 *    the close credit is durably recorded inside the lock, eliminating the
 *    pre-credit crash window present when balance was fetched before the call.
 *    Provider throw / null / non-positive → credit retained, zero fetches.
 *    Concurrent waiter at zero availability never invokes the provider.
 *
 * Changes from C1 → C2:
 *  - Stale-amount correction: coordinateWithdraw for loop_return binds the
 *    proposed amount to min(proposed, current ledger availability) inside the
 *    lock before creating a record.
 *  - Balance-as-cap restored: coordinateLoopReturn accepts opts.capLamports;
 *    credit is persisted before cap lookup; cap=0 retains credit with zero fetch.
 *  - withdraw_conflict is now terminal (clear + no debit), not a permanent blocker.
 *  - Ledger validation: every entry is validated against its key prefix AND
 *    suffix (sig/requestId must match). Cross-prefix, suffix mismatch, wrong
 *    origin, zero debit lamports → malformedKeys, not summed.
 *  - Record validation: UUID v4 form, amount >= MIN_WITHDRAW_LAMPORTS, exact
 *    SOL round-trip. genClientRequestId returns null when no secure source.
 *  - Cleanup evidence (malformed_record_cleaned) is non-blocking for future
 *    loop returns.
 *  - Legacy migration runs under the exclusive wallet lock (coordinateMigrateLegacy).
 *
 * Durability contract:
 *  - Record persisted AND read back BEFORE first fetch. Retries replay same ID+lamports.
 *  - HTTP 200 + success:true + state:'succeeded' + exact-ID + exact-lamports = only success.
 *  - Terminal failure (state:'failed' + terminal:true + exact-ID) = only clear (no debit).
 *  - All other responses retain.
 *
 * Web Locks:
 *  - All mutations go through qv-agent-sol-withdraw:v1:<wallet>:lock (exclusive).
 *  - Unavailable or throws → coordination_unavailable, zero money effects.
 *  - No fallback (no CAS, no BroadcastChannel, no lease).
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
  /** Keys holding unparseable or cross-prefix/suffix-mismatched payloads — surfaced, never deleted. */
  malformedKeys: string[];
  /** Debit request IDs parsed from valid debit entries (for deficit display). */
  debitRequestIds: string[];
  entries: Array<{ key: string; entry: LedgerEntry }>;
  /** True when storage enumeration or a key read failed entirely. */
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

/** UUID v4 regex — the only form generated by crypto.randomUUID / crypto.getRandomValues. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuidV4Form = (s: string): boolean => UUID_V4_RE.test(s);

/**
 * Returns a UUID v4 string using only secure platform randomness.
 * Returns null if neither crypto.randomUUID nor crypto.getRandomValues is available —
 * callers MUST fail closed (no persist, no fetch) in this case.
 */
function genClientRequestId(): string | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c) return null;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  if (typeof c.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const h = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return null; // No secure randomness — caller must fail closed.
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

// ─── Ledger entry parsing ────────────────────────────────────────────────────

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

// ─── Ledger entry validation (prefix + suffix + identity binding) ────────────

/**
 * Validates that a parsed LedgerEntry is consistent with its storage key:
 *  - Credit-prefix keys must hold credit entries; loop_close sig must match
 *    key suffix exactly; lamports must be positive. Legacy migration uses the
 *    deterministic suffix 'legacy_migration' and may have zero lamports.
 *  - Debit-prefix keys must hold debit entries with positive lamports,
 *    loop_return origin, and requestId exactly matching the key suffix.
 *  - Anomaly-prefix keys must hold anomaly entries whose suffix is
 *    code:8hexchars (fnv1a hash).
 *
 * Returns false for cross-prefix kind, suffix mismatch, wrong origin/amount —
 * these go to malformedKeys and are never summed.
 */
function validateLedgerEntry(
  key: string,
  entry: LedgerEntry,
  walletAddress: string,
): boolean {
  const cp = creditPrefix(walletAddress);
  const dp = debitPrefix(walletAddress);
  const ap = anomalyPrefix(walletAddress);

  if (key.startsWith(cp)) {
    if (entry.kind !== 'credit') return false;
    const suffix = key.slice(cp.length);
    if (entry.source === 'loop_close') {
      if (!entry.sig || entry.sig.trim().length === 0) return false;
      if (suffix !== entry.sig) return false; // key suffix must match sig exactly
      if (!isDigits(entry.lamports) || BigInt(entry.lamports) <= 0n) return false;
    } else if (entry.source === 'legacy_migration') {
      if (suffix !== 'legacy_migration') return false; // deterministic, single key per wallet
      if (!isDigits(entry.lamports)) return false; // zero allowed for 0-SOL legacy
    } else {
      return false;
    }
    return true;
  }

  if (key.startsWith(dp)) {
    if (entry.kind !== 'debit') return false;
    const suffix = key.slice(dp.length);
    if (!entry.requestId || entry.requestId.trim().length === 0) return false;
    if (suffix !== entry.requestId) return false; // key suffix must match requestId exactly
    if (entry.origin !== 'loop_return') return false;
    if (!isDigits(entry.lamports) || BigInt(entry.lamports) <= 0n) return false;
    return true;
  }

  if (key.startsWith(ap)) {
    if (entry.kind !== 'anomaly') return false;
    const suffix = key.slice(ap.length);
    if (!entry.code || entry.code.length === 0) return false;
    // suffix must be code:fnv1a_hash where fnv1a_hash is exactly 8 lowercase hex chars
    const lastColon = suffix.lastIndexOf(':');
    if (lastColon < 0) return false;
    const codePart = suffix.slice(0, lastColon);
    const hashPart = suffix.slice(lastColon + 1);
    if (codePart !== entry.code) return false;
    if (!/^[0-9a-f]{8}$/.test(hashPart)) return false;
    return true;
  }

  return false; // Unknown prefix — should not reach here under normal operation.
}

// ─── Append-only ledger ──────────────────────────────────────────────────────

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
    // Reject cross-prefix/suffix-mismatched entries as malformed (not just unparseable).
    if (!entry || !validateLedgerEntry(key, entry, walletAddress)) {
      malformedKeys.push(key);
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
      isUuidV4Form(r.clientRequestId);
    const originOk = r.origin === 'wallet_management' || r.origin === 'loop_return';
    const lamOk =
      isDigits(r.amountLamports) &&
      BigInt(r.amountLamports) >= MIN_WITHDRAW_LAMPORTS &&
      lamportsRoundTripExactly(r.amountLamports);
    if (
      r && typeof r === 'object' && r.version === 1 && idOk &&
      r.walletAddress === walletAddress && lamOk && originOk &&
      typeof r.createdAt === 'string'
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
  | { kind: 'pending'; message: string; signature: string | null }
  | { kind: 'manual_review'; message: string; signature: string | null }
  | { kind: 'mismatched'; message: string }
  | { kind: 'auth'; message: string }
  | { kind: 'unknown'; message: string };

/**
 * Status-aware classification. HTTP 200 + success:true + state:'succeeded' +
 * exact clientRequestId + exact withdrawnLamports = the ONLY success shape.
 * Success-shaped body on non-200 retains the record.
 *
 * Any exact-ID terminal failure (state:'failed' + terminal:true), including
 * step:'withdraw_conflict', is matched_terminal_failure — the record is cleared,
 * no debit is written, and the message includes fresh-ID guidance.
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

  // Terminal failure — any status, exact ID. Includes withdraw_conflict.
  if (b.state === 'failed' && b.terminal === true && crid === record.clientRequestId) {
    const baseMsg = capText(b.error ?? 'The withdrawal failed; no funds were moved.');
    const freshIdNote = b.step === 'withdraw_conflict'
      ? ' Use a fresh request ID for the next attempt — the cleanup button frees the slot.'
      : '';
    return { kind: 'matched_terminal_failure', message: baseMsg + freshIdNote };
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
      // Re-key: preserve the truthful server error text verbatim.
      const msg = capText(b.error ?? b.message ?? 'The request needs to be re-sent with a new key; retrying is safe.');
      return { kind: 'pending', message: msg, signature: sig };
    }
    if (status === 202) {
      const msg = capText(b.message ?? 'Withdrawal is still being processed.');
      return { kind: 'pending', message: msg, signature: sig };
    }
  }

  // Mismatched ID (non-empty crid that differs from ours).
  if (crid !== null && crid !== record.clientRequestId) {
    return {
      kind: 'mismatched',
      message: 'Server answered for a different withdrawal request; keeping this one for retry.',
    };
  }

  return { kind: 'unknown', message: capText(b.error ?? b.message ?? 'Unrecognized server response.') };
}

// ─── Finalization (complete record comparison) ───────────────────────────────

type FinalizeResult = 'cleared' | 'superseded' | 'clear_failed';

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

/**
 * Anomaly codes that represent resolved audit evidence, NOT unresolved
 * accounting errors. These do NOT block new loop_return request creation.
 *
 *  - malformed_record_cleaned: written by coordinateCleanupMalformed on success.
 *  - invalid_request_record: written when coordinateWithdraw/coordinateLoopReturn
 *    encounters a malformed request slot. The slot check itself (step 1:
 *    blocked_invalid_record) gates all new requests until cleanup succeeds, so
 *    this anomaly remaining in the ledger after cleanup is safe audit evidence.
 */
const NON_BLOCKING_ANOMALY_CODES = new Set([
  'malformed_record_cleaned',
  'invalid_request_record',
]);

/**
 * Returns the count of anomalies that actually block new loop-return request
 * creation. Excludes non-blocking audit evidence codes so UI surfaces can
 * show truthful button-disabled states and "needs review" counts.
 *
 * Exported so LoopVaultControls and other surfaces can reuse the same
 * authoritative classification logic rather than rolling their own count.
 */
export function countBlockingAnomalies(view: LedgerView): number {
  return view.anomalies.filter(a => !NON_BLOCKING_ANOMALY_CODES.has(a.code)).length;
}

function ledgerBlocksNewLoopReturn(
  view: LedgerView,
): { blocked: false } | { blocked: true; reason: string } {
  if (view.storageUnreadable) return { blocked: true, reason: 'storage_unreadable' };
  if (view.malformedKeys.length > 0) return { blocked: true, reason: 'malformed_entries' };
  if (countBlockingAnomalies(view) > 0) return { blocked: true, reason: 'anomalies_present' };
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
      // For loop_return: write debit BEFORE finalization.
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
      message: 'Your browser does not support the Web Locks API. Update your browser or use a different one.',
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
  /**
   * Optional balance cap for coordinateLoopReturn (in lamports).
   *  - Provided and positive: send min(ledger_availability, capLamports).
   *  - Provided and <= 0: credit retained for manual recovery, zero withdrawal fetches.
   *  - Omitted: uncapped (all ledger availability sent).
   * Retained for deterministic tests. Production auto-return should use capProvider instead.
   */
  capLamports?: bigint | null;
  /**
   * Async cap provider for coordinateLoopReturn, invoked AFTER the close credit
   * is durably recorded inside the exclusive lock — no pre-credit crash window.
   * Takes precedence over capLamports when both are supplied.
   *
   *  - Returns positive bigint → cap applied (send min(availability, cap)).
   *  - Returns null / 0n / negative / throws → credit retained, no request, zero fetches.
   *  - A concurrent waiter already at zero availability never invokes the provider.
   */
  capProvider?: () => Promise<bigint | null>;
}

function resolveStorage(opts?: CoordinatorOpts): StorageLike {
  return opts?.storage ?? window.localStorage;
}

// ─── High-level coordinator actions (all under exclusive Web Lock) ───────────

/**
 * Create (or adopt) + drive the wallet's single durable withdrawal request.
 *
 * Order inside the lock:
 *  1. Adopt any existing valid record first — regardless of origin or proposed amount.
 *  2. If invalid/unreadable record: blocked_invalid_record.
 *  3. No record + loop_return: re-derive availability, apply blockers, bind effective
 *     amount to min(proposed, available). If effective < MIN: no_funds_available, zero fetches.
 *  4. No record + wallet_management: use proposed amount as-is.
 *  5. Validate effective amount, generate secure ID (fail closed if unavailable),
 *     persist record, drive.
 */
export async function coordinateWithdraw(
  walletAddress: string,
  amountLamports: bigint,
  origin: WithdrawOrigin,
  opts?: CoordinatorOpts,
): Promise<CoordinatorOutcome> {
  if (!walletAddress) return { outcome: 'invalid_amount', reason: 'no_wallet', message: 'No wallet address.' };
  if (amountLamports <= 0n) {
    return { outcome: 'invalid_amount', reason: 'not_positive', message: 'Amount must be positive.' };
  }

  const storage = resolveStorage(opts);
  const lockResult = await withWalletLock(walletAddress, async (): Promise<CoordinatorOutcome> => {
    // 1. Adopt any existing valid record before any new-record validation.
    const existing = readRecordFromStorage(storage, walletAddress);
    if (existing.status === 'active') {
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

    // 2. No existing record. For loop_return: re-derive and stale-amount correct.
    let effectiveLamports = amountLamports;
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
      const available = ledger.availableLamports;
      if (available <= 0n) {
        return { outcome: 'no_funds_available', message: 'No positive ledger availability; nothing to return.' };
      }
      // Bind to current availability — prevents stale proposed amount from exceeding what's tracked.
      effectiveLamports = amountLamports < available ? amountLamports : available;
    }

    // 3. Validate effective amount.
    if (effectiveLamports < MIN_WITHDRAW_LAMPORTS) {
      return origin === 'loop_return'
        ? { outcome: 'no_funds_available', message: 'Available amount is below the server minimum.' }
        : { outcome: 'invalid_amount', reason: 'below_min', message: 'Amount below the server minimum.' };
    }
    const lamStr = effectiveLamports.toString();
    if (!lamportsRoundTripExactly(lamStr)) {
      return { outcome: 'invalid_amount', reason: 'not_representable', message: 'Amount cannot be represented exactly.' };
    }

    // 4. Secure ID — fail closed if unavailable.
    const id = genClientRequestId();
    if (id === null) {
      return {
        outcome: 'persist_failed',
        message: 'Secure randomness is unavailable in this environment; no withdrawal was started. Use a modern browser.',
      };
    }

    const record: DurableWithdrawRecord = {
      version: 1, clientRequestId: id,
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
 * Used for Check / Retry on both surfaces. Never consults ledger blockers.
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
 * Cleanup a malformed (unreadable/invalid) request record under the exclusive lock.
 * Persists bounded evidence under the anomaly prefix (non-blocking code), then
 * removes and verifies. Makes ZERO network calls. Retains on any failure.
 * Successful cleanup evidence (malformed_record_cleaned) does NOT block future
 * loop returns — it is append-only audit evidence, not an unresolved anomaly.
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
    // Persist bounded evidence (non-blocking code — does not block future loop returns).
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
    const evidenceBack = safeGet(storage, evidenceKey);
    if (!evidenceBack.ok || evidenceBack.value === null) {
      return {
        outcome: 'persist_failed_retained',
        message: 'Cleanup evidence did not read back; the malformed record was retained.',
      };
    }
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
 * Loop close/unwind continuation. All steps under the exclusive lock:
 *  1. Record credit (sig-keyed) before any balance/availability lookup.
 *  2. Credit-key conflict → blocked_by_ledger (even if anomaly write fails).
 *  3. Re-derive ledger. Adopt existing valid record (bypasses blockers).
 *  4. Check ledger blockers.
 *  5. Apply opts.capLamports: send min(available, cap). Cap <= 0 retains credit.
 *  6. Create record and drive.
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
    // 1. Record credit under the lock BEFORE balance lookup.
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
        if (put === 'conflict') {
          // Conflict blocks even if anomaly write cannot persist.
          return {
            outcome: 'blocked_by_ledger',
            reason: 'credit_conflict',
            message: 'A conflicting entry exists for this close signature. The recovery row shows available actions.',
          };
        }
        // 'ok' | 'already' — proceed.
      } else {
        writeAnomaly(
          storage, walletAddress, 'credit_missing_sig',
          `close-${proceedsLamports.toString()}|${Date.now()}`,
          { lamports: proceedsLamports.toString(), note: 'Close/unwind reported SOL proceeds without a tx signature.' },
        );
        return {
          outcome: 'missing_sig_noted',
          message: 'Close reported SOL proceeds without a transaction signature; nothing was auto-sent. The recovery row shows the situation.',
        };
      }
    }

    // 2. Re-derive inside the lock (second tab sees the debit the first wrote).
    const ledger = deriveAvailabilityInternal(storage, walletAddress);

    // 3. Adopt any existing valid request (bypasses ledger blockers).
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
      return { outcome: 'blocked_invalid_record', message: 'A stored withdrawal record could not be read; use the cleanup action.' };
    }

    // 4. Check ledger blockers for new request creation.
    const block = ledgerBlocksNewLoopReturn(ledger);
    if (block.blocked) {
      return {
        outcome: 'blocked_by_ledger',
        reason: block.reason,
        message: 'Auto-return blocked: ledger has ' + block.reason.replace(/_/g, ' ') + '. The recovery row shows available actions.',
      };
    }

    // 5. Apply balance cap, then size.
    let amt = ledger.availableLamports;

    // Concurrent-waiter fast-exit: the first caller's debit drained availability
    // to zero. Skip the cap provider entirely — never invoke it at zero availability.
    if (amt <= 0n) {
      return { outcome: 'no_funds_available', message: 'Nothing to return yet.' };
    }

    const capLamports = opts?.capLamports;
    const capProvider = opts?.capProvider;

    if (capProvider != null) {
      // Invoke AFTER credit is durably recorded under the lock — eliminates the
      // pre-credit crash window that existed when balance was fetched before the
      // call. Any failure (throw / null / non-positive) retains the credit and
      // makes zero withdrawal fetches.
      let cap: bigint | null = null;
      try { cap = await capProvider(); } catch { cap = null; }
      if (cap == null || cap <= 0n) {
        return { outcome: 'no_funds_available', message: 'Insufficient agent balance for the reserve; SOL credit retained for manual return.' };
      }
      if (amt > cap) amt = cap;
    } else if (capLamports != null) {
      if (capLamports <= 0n) {
        // Cap is zero or negative — insufficient balance; credit is retained for manual return.
        return { outcome: 'no_funds_available', message: 'Insufficient agent balance for the reserve; SOL credit retained for manual return.' };
      }
      if (amt > capLamports) amt = capLamports;
    }
    if (amt < MIN_WITHDRAW_LAMPORTS) {
      return { outcome: 'no_funds_available', message: 'Nothing to return yet.' };
    }
    const lamStr = amt.toString();
    if (!lamportsRoundTripExactly(lamStr)) {
      return { outcome: 'invalid_amount', reason: 'not_representable', message: 'Amount cannot be represented exactly.' };
    }

    // 6. Secure ID and create.
    const id = genClientRequestId();
    if (id === null) {
      return { outcome: 'persist_failed', message: 'Secure randomness unavailable; return not started.' };
    }
    const record: DurableWithdrawRecord = {
      version: 1, clientRequestId: id,
      walletAddress, amountLamports: lamStr, origin: 'loop_return', createdAt: nowIso(),
    };
    if (!writeRecordToStorage(storage, record)) {
      return { outcome: 'persist_failed', message: 'Could not save the return request. Free some browser storage, then retry.' };
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

// ─── Legacy migration ─────────────────────────────────────────────────────────

/**
 * One-time deterministic migration of the legacy wallet-scoped numeric
 * pending-return value. Exported for direct testing; production surfaces
 * should call coordinateMigrateLegacy to run it under the exclusive lock.
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

/**
 * Locked version of migrateLegacyPendingReturn. Call this from mount effects
 * so concurrent tab mounts cannot produce duplicate credits.
 * If the lock is unavailable, returns { status: 'none' } — the operation is
 * idempotent and will succeed on the next call (deterministic credit key).
 */
export async function coordinateMigrateLegacy(
  walletAddress: string,
  storage?: StorageLike,
): Promise<LegacyMigrationResult> {
  if (!walletAddress) return { status: 'none' };
  const st = storage ?? window.localStorage;
  const lockResult = await withWalletLock(walletAddress, async (): Promise<LegacyMigrationResult> =>
    migrateLegacyPendingReturn(walletAddress, st)
  );
  // Lock unavailable — skip; idempotent, will succeed on next mount call.
  if (lockResult && typeof lockResult === 'object' && 'outcome' in lockResult) {
    return { status: 'none' };
  }
  return lockResult as LegacyMigrationResult;
}

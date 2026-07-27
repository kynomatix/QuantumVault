/**
 * WO2B2D — Shared durable client coordinator for agent-wallet SOL withdrawals.
 *
 * Both client surfaces that return agent-wallet SOL to the user's wallet
 * (Wallet Management "Withdraw SOL" and the SOL Loop "Return to Wallet"
 * flow) drive the SAME wallet-scoped durable request record through the
 * server-executed withdrawal endpoint. The browser never decodes, signs,
 * sends, or confirms a withdrawal transaction, and never calls the
 * neutralized legacy confirm endpoint.
 *
 * Durability contract:
 *  - A request record {id, wallet, lamports, origin} is persisted AND read
 *    back BEFORE the first network request. Retries always replay the same
 *    clientRequestId + exact amount until the server answers with a MATCHED
 *    terminal outcome (same id, and for success the same lamports).
 *  - Cross-tab single-writer discipline: begin ADOPTS an existing record and
 *    adopts the winner when its own write loses a race; drive refuses (no
 *    network call) when the stored record is no longer the one being driven;
 *    finalization is compare-and-delete — completing request A can never
 *    erase a different in-flight record B.
 *  - Conservative classification: pending / re-key (auth) / manual-review /
 *    network / parse / mismatched / unknown outcomes all RETAIN the record.
 *    Nothing is cleared on ambiguity; nothing fires automatically on mount.
 *
 * Loop-proceeds ledger (cross-tab safe):
 *  - Append-only, per-entry localStorage keys — never an aggregate
 *    read-modify-write and never a simulated CAS. Credits are keyed by the
 *    loop close/unwind transaction signature; debits by the durable
 *    withdrawal request id; anomalies get their own deterministic keys.
 *  - All values are exact integer lamport strings; availability is a BigInt
 *    summation over the entries. Replaying an identical entry is a no-op;
 *    a conflicting value NEVER overwrites — it records a visible anomaly.
 *  - A negative balance (debits > credits) is surfaced exactly and blocks
 *    further auto-returns; it is never clamped away.
 */

// ————————————————————————————————————————————————————————————————
// Types & constants
// ————————————————————————————————————————————————————————————————

/** Minimal storage surface (window.localStorage satisfies this). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export type WithdrawOrigin = 'wallet_mgmt' | 'loop_return';

export interface DurableWithdrawRecord {
  v: 1;
  /** clientRequestId replayed verbatim on every retry. */
  id: string;
  wallet: string;
  /** Exact integer lamport amount, as a decimal string. */
  lamports: string;
  origin: WithdrawOrigin;
  createdAt: string;
}

/**
 * The durable server-executed withdrawal endpoint. This constant is the ONLY
 * place the endpoint path may appear in client code (enforced by tests).
 */
export const DURABLE_WITHDRAW_ENDPOINT = '/api/agent/withdraw-sol';

/** Server-side minimum (0.000001 SOL). */
export const MIN_WITHDRAW_LAMPORTS = 1000n;

const KEY_ROOT = 'qv:solw:v1';
export const requestKey = (wallet: string) => `${KEY_ROOT}:req:${wallet}`;
export const ledgerPrefix = (wallet: string) => `${KEY_ROOT}:led:${wallet}:`;
export const creditSigKey = (wallet: string, sig: string) => `${ledgerPrefix(wallet)}credit:sig:${sig}`;
export const legacyCreditKey = (wallet: string) => `${ledgerPrefix(wallet)}credit:legacy`;
export const debitKey = (wallet: string, requestId: string) => `${ledgerPrefix(wallet)}debit:req:${requestId}`;
export const legacyPendingReturnKey = (wallet: string) => `qv-loop-pending-return:${wallet}`;

export type LedgerEntry =
  | { v: 1; kind: 'credit'; source: 'loop_close'; sig: string; lamports: string; at: string }
  | { v: 1; kind: 'credit'; source: 'legacy_migration'; raw: string; lamports: string; at: string }
  | { v: 1; kind: 'debit'; requestId: string; origin: WithdrawOrigin; lamports: string; at: string }
  | { v: 1; kind: 'anomaly'; code: string; detail: string; at: string };

// ————————————————————————————————————————————————————————————————
// Small pure helpers
// ————————————————————————————————————————————————————————————————

const isDigits = (s: unknown): s is string => typeof s === 'string' && /^\d+$/.test(s);

const capText = (v: unknown, max = 400): string => {
  const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } })();
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

/** SOL number the server will convert back with Math.round(amount * 1e9). */
export const lamportsToSolNumber = (lamports: string): number => Number(lamports) / 1e9;

/**
 * True when the lamport string survives the server round-trip EXACTLY:
 * Math.round((lamports/1e9) * 1e9) === lamports, within safe-integer range.
 */
export function lamportsRoundTripExactly(lamports: string): boolean {
  if (!isDigits(lamports)) return false;
  const n = Number(lamports);
  if (!Number.isSafeInteger(n)) return false;
  return Math.round((n / 1e9) * 1e9) === n;
}

/** Exact SOL input (number) → lamports, or null when not exactly representable. */
export function solNumberToLamports(sol: number): bigint | null {
  if (typeof sol !== 'number' || !Number.isFinite(sol) || sol <= 0) return null;
  const lam = Math.round(sol * 1e9);
  if (!Number.isSafeInteger(lam) || lam <= 0) return null;
  if (!lamportsRoundTripExactly(String(lam))) return null;
  return BigInt(lam);
}

/** Display-only: exact lamport string → SOL decimal string (no float math). */
export function lamportsToSolDisplay(lamports: bigint | string): string {
  const v = typeof lamports === 'bigint' ? lamports : BigInt(lamports);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 1_000_000_000n;
  const frac = (abs % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Balance is a CAP only: never creates availability, never inflates. */
export function computeReturnLamports(availableLamports: bigint, capLamports: bigint): bigint {
  if (availableLamports <= 0n || capLamports <= 0n) return 0n;
  return availableLamports < capLamports ? availableLamports : capLamports;
}

/** Agent SOL balance (SOL float) minus the surface's reserve → cap in lamports. */
export function maxSendableLamportsFromSol(solBalance: number | null | undefined, reserveSol: number): bigint {
  if (typeof solBalance !== 'number' || !Number.isFinite(solBalance)) return 0n;
  const lam = Math.round((solBalance - reserveSol) * 1e9);
  if (!Number.isSafeInteger(lam) || lam <= 0) return 0n;
  return BigInt(lam);
}

export function genClientRequestId(): string {
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

// ————————————————————————————————————————————————————————————————
// Guarded storage primitives (every op verified, nothing trusted blindly)
// ————————————————————————————————————————————————————————————————

function safeGet(storage: StorageLike, key: string): { ok: true; value: string | null } | { ok: false } {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false };
  }
}

/** setItem + read-back verify. Returns false on ANY doubt. */
function safeSetVerified(storage: StorageLike, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
  } catch {
    return false;
  }
  const back = safeGet(storage, key);
  return back.ok && back.value === value;
}

/** removeItem + verify gone. Returns false on ANY doubt. */
function safeRemoveVerified(storage: StorageLike, key: string): boolean {
  try {
    storage.removeItem(key);
  } catch {
    return false;
  }
  const back = safeGet(storage, key);
  return back.ok && back.value === null;
}

// ————————————————————————————————————————————————————————————————
// Append-only ledger
// ————————————————————————————————————————————————————————————————

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

/** Identity + value equality, ignoring timestamps — idempotent-replay test. */
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

export type PutEntryStatus = 'ok' | 'already' | 'conflict' | 'persist_failed';

/**
 * Idempotent append: identical replay is a no-op; a conflicting value NEVER
 * overwrites — it records a visible anomaly entry instead. Every write is
 * read back before being trusted.
 */
export function putLedgerEntry(
  storage: StorageLike,
  wallet: string,
  key: string,
  entry: LedgerEntry,
): PutEntryStatus {
  const existing = safeGet(storage, key);
  if (!existing.ok) return 'persist_failed';
  if (existing.value !== null) {
    const parsed = parseEntry(existing.value);
    if (parsed && entryEquivalent(parsed, entry)) return 'already';
    writeAnomaly(storage, wallet, 'entry_conflict', `${key}|${JSON.stringify(entry)}`, {
      key,
      existing: capText(existing.value, 200),
      attempted: capText(JSON.stringify(entry), 200),
    });
    return 'conflict';
  }
  return safeSetVerified(storage, key, JSON.stringify(entry)) ? 'ok' : 'persist_failed';
}

/**
 * Visible anomaly entry with a deterministic key: identical replays collapse
 * to one entry; distinct conflicts get distinct entries. Never throws.
 */
export function writeAnomaly(
  storage: StorageLike,
  wallet: string,
  code: string,
  seed: string,
  detail: unknown,
): void {
  const key = `${ledgerPrefix(wallet)}anomaly:${code}:${fnv1a(seed)}`;
  const entry: LedgerEntry = { v: 1, kind: 'anomaly', code, detail: capText(detail), at: nowIso() };
  const existing = safeGet(storage, key);
  if (!existing.ok) return;
  if (existing.value !== null) return; // deterministic key: first write wins, replays no-op
  safeSetVerified(storage, key, JSON.stringify(entry));
}

export interface LedgerView {
  creditLamports: bigint;
  debitLamports: bigint;
  /** credits − debits; MAY be negative — never clamped. */
  availableLamports: bigint;
  negative: boolean;
  /** Exact deficit when negative, else 0n. */
  deficitLamports: bigint;
  anomalies: Array<{ key: string; code: string; detail: string }>;
  /** Keys holding unparseable/foreign payloads — surfaced, never deleted. */
  malformedKeys: string[];
  entries: Array<{ key: string; entry: LedgerEntry }>;
}

/** Enumerate + BigInt-sum the wallet's ledger. Read-only; cross-tab safe. */
export function deriveAvailability(storage: StorageLike, wallet: string): LedgerView {
  const prefix = ledgerPrefix(wallet);
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
  } catch {
    /* unreadable storage → empty view (fail closed: nothing offered) */
  }
  let credit = 0n;
  let debit = 0n;
  const anomalies: LedgerView['anomalies'] = [];
  const malformedKeys: string[] = [];
  const entries: LedgerView['entries'] = [];
  for (const key of keys.sort()) {
    const raw = safeGet(storage, key);
    if (!raw.ok || raw.value === null) continue;
    const entry = parseEntry(raw.value);
    if (!entry) {
      malformedKeys.push(key);
      continue;
    }
    entries.push({ key, entry });
    if (entry.kind === 'credit') credit += BigInt(entry.lamports);
    else if (entry.kind === 'debit') debit += BigInt(entry.lamports);
    else anomalies.push({ key, code: entry.code, detail: entry.detail });
  }
  const available = credit - debit;
  return {
    creditLamports: credit,
    debitLamports: debit,
    availableLamports: available,
    negative: available < 0n,
    deficitLamports: available < 0n ? -available : 0n,
    anomalies,
    malformedKeys,
    entries,
  };
}

/** Record a loop close/unwind credit, keyed by the on-chain tx signature. */
export function recordLoopCloseCredit(
  storage: StorageLike,
  wallet: string,
  sig: string,
  lamports: bigint,
): PutEntryStatus | 'invalid' {
  if (typeof sig !== 'string' || sig.trim().length === 0 || lamports <= 0n) return 'invalid';
  const entry: LedgerEntry = {
    v: 1,
    kind: 'credit',
    source: 'loop_close',
    sig,
    lamports: lamports.toString(),
    at: nowIso(),
  };
  return putLedgerEntry(storage, wallet, creditSigKey(wallet, sig), entry);
}

/** A close/unwind reported proceeds but no signature: keep it VISIBLE. */
export function noteMissingCloseSignature(
  storage: StorageLike,
  wallet: string,
  lamports: bigint,
  opRef: string,
): void {
  writeAnomaly(storage, wallet, 'credit_missing_sig', `${opRef}|${lamports}`, {
    opRef,
    lamports: lamports.toString(),
    note: 'Close/unwind reported SOL proceeds without a tx signature; credit not recorded.',
  });
}

// ————————————————————————————————————————————————————————————————
// Legacy pending-return migration (deterministic, evidence-preserving)
// ————————————————————————————————————————————————————————————————

export type LegacyMigrationResult =
  | { status: 'none' }
  | { status: 'migrated'; lamports: string }
  | { status: 'migrated_key_stuck'; lamports: string }
  | { status: 'invalid_preserved'; reason: string; raw: string }
  | { status: 'conflict_preserved'; raw: string }
  | { status: 'persist_failed'; raw: string };

/**
 * One deterministic legacy credit from the old wallet-scoped numeric
 * pending-return value. The credit is persisted and read back BEFORE the old
 * key is removed; invalid/unsafe/negative/empty/non-finite state is preserved
 * with a visible anomaly — never replaced with a guessed zero.
 */
export function migrateLegacyPendingReturn(storage: StorageLike, wallet: string): LegacyMigrationResult {
  const oldKey = legacyPendingReturnKey(wallet);
  const rawRead = safeGet(storage, oldKey);
  if (!rawRead.ok || rawRead.value === null) return { status: 'none' };
  const raw = rawRead.value;
  const trimmed = raw.trim();

  const invalid = (reason: string): LegacyMigrationResult => {
    writeAnomaly(storage, wallet, 'legacy_invalid', `${oldKey}|${raw}`, {
      reason,
      raw: capText(raw, 100),
      note: 'Old pending-return value preserved; no credit was guessed.',
    });
    return { status: 'invalid_preserved', reason, raw };
  };

  if (trimmed === '') return invalid('empty');
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return invalid('non_finite');
  if (n < 0) return invalid('negative');
  const lam = Math.round(n * 1e9);
  if (!Number.isSafeInteger(lam) || lam < 0) return invalid('unsafe_lamports');

  const entry: LedgerEntry = {
    v: 1,
    kind: 'credit',
    source: 'legacy_migration',
    raw: trimmed,
    lamports: String(lam),
    at: nowIso(),
  };
  const put = putLedgerEntry(storage, wallet, legacyCreditKey(wallet), entry);
  if (put === 'persist_failed') return { status: 'persist_failed', raw };
  if (put === 'conflict') return { status: 'conflict_preserved', raw };
  // 'ok' | 'already' → the credit is durably readable; only now drop the old key.
  if (!safeRemoveVerified(storage, oldKey)) return { status: 'migrated_key_stuck', lamports: String(lam) };
  return { status: 'migrated', lamports: String(lam) };
}

// ————————————————————————————————————————————————————————————————
// Durable request record
// ————————————————————————————————————————————————————————————————

export type ActiveRecordRead =
  | { status: 'none' }
  | { status: 'active'; record: DurableWithdrawRecord }
  | { status: 'invalid'; raw: string }
  | { status: 'unreadable' };

export function readActiveRecord(storage: StorageLike, wallet: string): ActiveRecordRead {
  const read = safeGet(storage, requestKey(wallet));
  if (!read.ok) return { status: 'unreadable' };
  if (read.value === null) return { status: 'none' };
  try {
    const r = JSON.parse(read.value) as DurableWithdrawRecord;
    const idOk = typeof r.id === 'string' && r.id.trim().length >= 1 && r.id.trim().length <= 128 && r.id === r.id.trim();
    const originOk = r.origin === 'wallet_mgmt' || r.origin === 'loop_return';
    if (
      r && typeof r === 'object' && r.v === 1 && idOk && r.wallet === wallet &&
      isDigits(r.lamports) && BigInt(r.lamports) > 0n && originOk && typeof r.createdAt === 'string'
    ) {
      return { status: 'active', record: r };
    }
    return { status: 'invalid', raw: read.value };
  } catch {
    return { status: 'invalid', raw: read.value };
  }
}

export type BeginResult =
  | { status: 'created'; record: DurableWithdrawRecord }
  | { status: 'active_exists'; record: DurableWithdrawRecord }
  | { status: 'blocked_invalid_record' }
  | { status: 'invalid_amount'; reason: string }
  | { status: 'persist_failed' };

/**
 * Create (or adopt) the wallet's single durable withdrawal record. The record
 * is written and read back verbatim BEFORE any network request may be made.
 * An existing valid record is ALWAYS adopted — never overwritten.
 */
export function beginWithdraw(
  storage: StorageLike,
  wallet: string,
  lamports: bigint,
  origin: WithdrawOrigin,
): BeginResult {
  if (typeof wallet !== 'string' || wallet.length === 0) return { status: 'invalid_amount', reason: 'no_wallet' };
  if (lamports < MIN_WITHDRAW_LAMPORTS) return { status: 'invalid_amount', reason: 'below_min' };
  const lamStr = lamports.toString();
  if (!lamportsRoundTripExactly(lamStr)) return { status: 'invalid_amount', reason: 'not_representable' };

  const existing = readActiveRecord(storage, wallet);
  if (existing.status === 'active') return { status: 'active_exists', record: existing.record };
  if (existing.status === 'invalid' || existing.status === 'unreadable') {
    if (existing.status === 'invalid') {
      writeAnomaly(storage, wallet, 'invalid_request_record', existing.raw, {
        raw: capText(existing.raw, 200),
        note: 'Stored withdrawal record is unreadable; preserved for review.',
      });
    }
    return { status: 'blocked_invalid_record' };
  }

  const record: DurableWithdrawRecord = {
    v: 1,
    id: genClientRequestId(),
    wallet,
    lamports: lamStr,
    origin,
    createdAt: nowIso(),
  };
  if (!safeSetVerified(storage, requestKey(wallet), JSON.stringify(record))) {
    // Write didn't verify. Distinguish "lost a same-instant race to another
    // tab" (a DIFFERENT valid record is now stored → adopt it, single ID)
    // from "storage is broken" (nothing/garbage stored → fail, no request).
    const after = readActiveRecord(storage, wallet);
    if (after.status === 'active') {
      return after.record.id === record.id
        ? { status: 'created', record: after.record }
        : { status: 'active_exists', record: after.record };
    }
    return { status: 'persist_failed' };
  }
  return { status: 'created', record };
}

// ————————————————————————————————————————————————————————————————
// Response classification (pure) + drive
// ————————————————————————————————————————————————————————————————

export type Classified =
  | { kind: 'matched_success'; signature: string | null }
  | { kind: 'matched_terminal_failure'; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'mismatched'; message: string; detailSeed: string }
  | { kind: 'pending'; message: string; signature: string | null }
  | { kind: 'manual_review'; message: string; signature: string | null }
  | { kind: 'unknown'; message: string };

/**
 * Conservative, pure classification of a durable-endpoint response body
 * against the record being driven. ONLY two shapes may end the record's
 * life: a MATCHED success (same id + exact same lamports) and a MATCHED
 * explicit terminal failure. Everything else retains the record.
 */
export function classifyWithdrawResponse(record: DurableWithdrawRecord, body: unknown): Classified {
  if (!body || typeof body !== 'object') {
    return { kind: 'unknown', message: `Unrecognized server response: ${capText(body, 120)}` };
  }
  const b = body as Record<string, unknown>;
  const crid = typeof b.clientRequestId === 'string' ? b.clientRequestId : null;
  if (crid !== null && crid !== record.id) {
    return {
      kind: 'mismatched',
      message: 'Server answered for a different withdrawal request; keeping this one for retry.',
      detailSeed: `crid|${crid}`,
    };
  }
  const state = typeof b.state === 'string' ? b.state : null;
  if (state === 'succeeded' && b.success === true && crid === record.id) {
    const wl = b.withdrawnLamports;
    if (isDigits(wl) && BigInt(wl) === BigInt(record.lamports)) {
      return { kind: 'matched_success', signature: typeof b.signature === 'string' ? b.signature : null };
    }
    return {
      kind: 'mismatched',
      message: 'Server reports success but for a different amount; keeping the record for review.',
      detailSeed: `lamports|${capText(wl, 40)}`,
    };
  }
  if (state === 'failed' && b.terminal === true && crid === record.id) {
    const msg = capText(b.error ?? 'The withdrawal failed; no funds were moved.');
    if (b.step === 'withdraw_conflict') return { kind: 'conflict', message: msg };
    return { kind: 'matched_terminal_failure', message: msg };
  }
  if (state === 'pending' && crid === record.id) {
    const msg = capText(b.message ?? 'Withdrawal is still being processed.');
    const signature = typeof b.signature === 'string' ? b.signature : null;
    if (b.manualReview === true) return { kind: 'manual_review', message: msg, signature };
    return { kind: 'pending', message: msg, signature };
  }
  return { kind: 'unknown', message: capText(b.error ?? b.message ?? 'Unrecognized server response.') };
}

export type DriveOutcome =
  | { outcome: 'success'; retained: false; cleared: true; signature: string | null; lamports: string; message: string }
  | { outcome: 'success_unfinalized'; retained: true; reason: 'debit_persist_failed' | 'debit_conflict' | 'clear_failed'; message: string }
  | { outcome: 'terminal_failure'; retained: boolean; cleared: boolean; message: string }
  | { outcome: 'pending'; retained: true; message: string; signature: string | null }
  | { outcome: 'manual_review'; retained: true; message: string; signature: string | null }
  | { outcome: 'conflict'; retained: true; message: string }
  | { outcome: 'mismatched'; retained: true; message: string }
  | { outcome: 'stale_record'; retained: false; currentRecordId: string | null; message: string }
  | { outcome: 'auth'; retained: true; message: string }
  | { outcome: 'network'; retained: true; message: string }
  | { outcome: 'parse'; retained: true; message: string }
  | { outcome: 'unknown'; retained: true; message: string };

export interface DriveOptions {
  fetchImpl?: (url: string, init: {
    method: string;
    credentials: 'include';
    headers: Record<string, string>;
    body: string;
  }) => Promise<{ status: number; json: () => Promise<unknown> }>;
  headers?: Record<string, string>;
}

type FinalizeResult = 'cleared' | 'superseded' | 'clear_failed';

/**
 * Compare-and-delete for the wallet's single request slot: the key is removed
 * ONLY while it still holds the record being finalized. A different (newer)
 * record is NEVER touched — completing request A must never erase an
 * in-flight request B written by another tab. localStorage has no CAS, so the
 * unavoidable residual window is two adjacent synchronous ops (microseconds)
 * instead of the whole network round-trip; a supersession leaves a visible
 * anomaly, never a deletion.
 */
function finalizeRequestRecord(storage: StorageLike, record: DurableWithdrawRecord): FinalizeResult {
  const key = requestKey(record.wallet);
  const read = safeGet(storage, key);
  if (!read.ok) return 'clear_failed';
  if (read.value === null) return 'cleared'; // already finalized elsewhere — idempotent
  let storedId: string | null = null;
  try {
    const parsed = JSON.parse(read.value) as { id?: unknown };
    storedId = parsed && typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    storedId = null;
  }
  if (storedId !== record.id) {
    // Not ours anymore (superseded by another tab, or unreadable) —
    // preserve whatever is stored and surface the fact.
    writeAnomaly(storage, record.wallet, 'record_superseded', `${record.id}|${capText(read.value, 60)}`, {
      finalizedRequestId: record.id,
      storedRecord: capText(read.value, 200),
      note: 'Request finalized while the slot held a different record; nothing was deleted.',
    });
    return 'superseded';
  }
  return safeRemoveVerified(storage, key) ? 'cleared' : 'clear_failed';
}

/**
 * One explicit check/retry cycle for the durable record: replay the SAME
 * clientRequestId + exact amount, classify conservatively, and finalize the
 * local ledger/record ONLY on matched outcomes. Never called automatically
 * on mount — surfaces invoke it from explicit user actions (or the single
 * post-close auto-return continuation).
 */
export async function driveWithdraw(
  storage: StorageLike,
  record: DurableWithdrawRecord,
  opts?: DriveOptions,
): Promise<DriveOutcome> {
  // Ownership gate: NEVER drive a request the wallet's single durable slot no
  // longer holds — a stale tab must not re-POST an id that was superseded or
  // already finalized elsewhere. No network call is made on refusal.
  const owned = readActiveRecord(storage, record.wallet);
  if (owned.status !== 'active' || owned.record.id !== record.id || owned.record.lamports !== record.lamports) {
    return {
      outcome: 'stale_record',
      retained: false,
      currentRecordId: owned.status === 'active' ? owned.record.id : null,
      message: 'This withdrawal request is no longer the active one; refresh to see the current state.',
    };
  }
  // [WO2B2D:COORDINATOR-FETCH-BEGIN] — the ONLY client call site targeting the
  // durable server-executed withdrawal endpoint (enforced by tests). The
  // browser never sees a transaction: it posts intent, the server executes.
  const doFetch = opts?.fetchImpl ?? ((u, i) => fetch(u, i));
  let res: { status: number; json: () => Promise<unknown> };
  try {
    res = await doFetch(DURABLE_WITHDRAW_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
      body: JSON.stringify({ clientRequestId: record.id, amount: lamportsToSolNumber(record.lamports) }),
    });
  } catch (e) {
    return { outcome: 'network', retained: true, message: capText((e as Error)?.message ?? 'Network error', 200) };
  }
  // [WO2B2D:COORDINATOR-FETCH-END]

  if (res.status === 401 || res.status === 403) {
    return { outcome: 'auth', retained: true, message: 'Session expired — reconnect your wallet, then retry.' };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { outcome: 'parse', retained: true, message: 'Unreadable server response; the withdrawal request is kept for retry.' };
  }

  const c = classifyWithdrawResponse(record, body);
  switch (c.kind) {
    case 'matched_success': {
      if (record.origin === 'loop_return') {
        const entry: LedgerEntry = {
          v: 1,
          kind: 'debit',
          requestId: record.id,
          origin: record.origin,
          lamports: record.lamports,
          at: nowIso(),
        };
        const put = putLedgerEntry(storage, record.wallet, debitKey(record.wallet, record.id), entry);
        if (put === 'persist_failed') {
          return {
            outcome: 'success_unfinalized',
            retained: true,
            reason: 'debit_persist_failed',
            message: 'Withdrawal completed on-chain; retry to finish local bookkeeping (same request, no new withdrawal).',
          };
        }
        if (put === 'conflict') {
          return {
            outcome: 'success_unfinalized',
            retained: true,
            reason: 'debit_conflict',
            message: 'Withdrawal completed, but local records disagree; kept visible for review.',
          };
        }
      }
      if (finalizeRequestRecord(storage, record) === 'clear_failed') {
        return {
          outcome: 'success_unfinalized',
          retained: true,
          reason: 'clear_failed',
          message: 'Withdrawal completed; retry to clear the finished request (no new withdrawal will be made).',
        };
      }
      return {
        outcome: 'success',
        retained: false,
        cleared: true,
        signature: c.signature,
        lamports: record.lamports,
        message: `Withdrew ${lamportsToSolDisplay(record.lamports)} SOL to your wallet.`,
      };
    }
    case 'matched_terminal_failure': {
      const fin = finalizeRequestRecord(storage, record);
      return { outcome: 'terminal_failure', retained: fin === 'clear_failed', cleared: fin === 'cleared', message: c.message };
    }
    case 'conflict': {
      writeAnomaly(storage, record.wallet, 'withdraw_conflict', `${record.id}|conflict`, {
        requestId: record.id,
        message: c.message,
      });
      return { outcome: 'conflict', retained: true, message: c.message };
    }
    case 'mismatched': {
      writeAnomaly(storage, record.wallet, 'response_mismatch', `${record.id}|${c.detailSeed}`, {
        requestId: record.id,
        message: c.message,
      });
      return { outcome: 'mismatched', retained: true, message: c.message };
    }
    case 'pending':
      return { outcome: 'pending', retained: true, message: c.message, signature: c.signature };
    case 'manual_review':
      return { outcome: 'manual_review', retained: true, message: c.message, signature: c.signature };
    default:
      return { outcome: 'unknown', retained: true, message: c.message };
  }
}

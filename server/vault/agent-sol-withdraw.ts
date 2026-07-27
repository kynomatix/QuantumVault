/**
 * server/vault/agent-sol-withdraw.ts — WO2B2B
 *
 * Durable, idempotent, server-executed agent-SOL withdrawal orchestrator for
 * POST /api/agent/withdraw-sol, plus the neutralized legacy confirm endpoint.
 *
 * Contract (one clientRequestId = at most one on-chain transfer):
 *  1. Intent row first (borrow_operations, type 'agent_sol_withdraw'), created
 *     race-safely via the partial UNIQUE index on (wallet, clientRequestId).
 *  2. Pre-broadcast gates: concurrent-op conflict (terminal ALLOWLIST — any
 *     unknown status blocks), strict lamports balance incl. gas reserve, UMK.
 *  3. Signature WRITE-AHEAD under the per-wallet PG advisory lock — recorded
 *     strictly before broadcast, at most once per intent.
 *  4. Exactly-once broadcast of the exact signed bytes (durable executor; a
 *     memo binds the transaction to the clientRequestId).
 *  5. Success + the SOL equity event finalize atomically, exactly once.
 *  6. Ambiguity reconciles the PERSISTED signature — never by balance, never
 *     by scanning equity_events, never with a second send. Malformed
 *     persisted provenance fails CLOSED: zero RPC, zero writes, manual review.
 *
 * Responses NEVER contain transaction bytes. Clients of the legacy
 * build-then-browser-broadcast flow are intentionally broken until WO2B2D.
 */

import { storage, AGENT_SOL_WITHDRAW_OP_TYPE, type AgentSolWithdrawPrecommitOutcome } from '../storage';
import { TERMINAL_OPERATION_STATUSES } from './reset-blockers';
import {
  executeAgentSolWithdrawDurable,
  getAgentSolBalanceLamportsStrict,
  getSignatureStatusStrict,
  getBlockHeightStrict,
  type DurableSolWithdrawResult,
} from '../agent-wallet';
import { getUmkForWebhook, decryptAgentKeyStrict } from '../session-v3';

export { AGENT_SOL_WITHDRAW_OP_TYPE } from '../storage';

/** Gas reserve the agent wallet must retain after the withdrawal (0.005 SOL — legacy parity). */
export const SOL_WITHDRAW_RESERVE_LAMPORTS = 5_000_000n;

/**
 * Expiry slack: a persisted, unknown-to-the-cluster signature is declared
 * expired only when the current block height is STRICTLY greater than
 * lastValidBlockHeight + this slack. Anything earlier is 'still_valid'.
 */
export const SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS = 30;

const MAX_ERROR_LEN = 500;

type BorrowOperationRow = NonNullable<Awaited<ReturnType<typeof storage.getBorrowOperationById>>>;
type PrecommitRejection = Extract<AgentSolWithdrawPrecommitOutcome, { won: false }>;

export interface WithdrawHandlerResult {
  http: number;
  body: Record<string, unknown>;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const safeJson = (v: unknown): string => {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
};
const truncate = (s: string): string => (s.length > MAX_ERROR_LEN ? `${s.slice(0, MAX_ERROR_LEN)}…` : s);

// ————————————————————————————————————————————————————————————————
// Pure helpers (exported for tests)
// ————————————————————————————————————————————————————————————————

export type ParsedWithdrawRequest =
  | { ok: true; clientRequestId: string; lamports: number }
  | { ok: false; error: string };

export function parseWithdrawRequest(body: unknown): ParsedWithdrawRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawCrid = b.clientRequestId;
  if (typeof rawCrid !== 'string') {
    return { ok: false, error: 'clientRequestId is required (string, 1-128 characters)' };
  }
  const clientRequestId = rawCrid.trim();
  if (clientRequestId.length < 1 || clientRequestId.length > 128) {
    return { ok: false, error: 'clientRequestId must be 1-128 characters after trimming' };
  }
  const amount = b.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'Valid amount required' };
  }
  const lamports = Math.round(amount * 1_000_000_000);
  if (!Number.isSafeInteger(lamports) || lamports < 1000) {
    return { ok: false, error: 'Amount too small or not representable (minimum 0.000001 SOL)' };
  }
  if (lamports > Number.MAX_SAFE_INTEGER - Number(SOL_WITHDRAW_RESERVE_LAMPORTS)) {
    return { ok: false, error: 'Amount too large' };
  }
  return { ok: true, clientRequestId, lamports };
}

export type WithdrawProvenance =
  | {
      valid: true;
      signature: string;
      blockhash: string;
      lastValidBlockHeight: number;
      requestedLamports: bigint;
      destinationWallet: string;
      sourceAgentPublicKey: string;
    }
  | { valid: false };

/**
 * Pure provenance selector: an op row is reconcilable ONLY when its persisted
 * broadcast identity is fully coherent. Deliberately NOT step-gated — steps
 * are breadcrumbs, the signature evidence is the truth. Any deviation returns
 * invalid and the caller must fail closed (manual review; no RPC, no writes,
 * and NEVER an automatic mark-failed).
 */
export function selectWithdrawProvenance(op: BorrowOperationRow): WithdrawProvenance {
  const meta = (op.metadata ?? {}) as Record<string, unknown>;
  const sigs = Array.isArray(op.txSignatures) ? op.txSignatures : [];
  const metaSig = meta.withdrawTxSignature;
  if (typeof metaSig !== 'string' || metaSig.length === 0) return { valid: false };
  if (sigs.length === 0 || sigs[sigs.length - 1] !== metaSig) return { valid: false };
  const blockhash = meta.withdrawBlockhash;
  if (typeof blockhash !== 'string' || blockhash.length === 0) return { valid: false };
  const lvbh = meta.withdrawLastValidBlockHeight;
  if (typeof lvbh !== 'number' || !Number.isFinite(lvbh) || lvbh <= 0) return { valid: false };
  if (typeof meta.requestedLamports !== 'string' || meta.requestedLamports.length === 0) return { valid: false };
  let requestedLamports: bigint;
  try {
    requestedLamports = BigInt(meta.requestedLamports);
  } catch {
    return { valid: false };
  }
  if (requestedLamports <= 0n) return { valid: false };
  const destinationWallet = meta.destinationWallet;
  if (typeof destinationWallet !== 'string' || destinationWallet !== op.walletAddress) return { valid: false };
  const sourceAgentPublicKey = meta.sourceAgentPublicKey;
  if (typeof sourceAgentPublicKey !== 'string' || sourceAgentPublicKey.length === 0) return { valid: false };
  return {
    valid: true,
    signature: metaSig,
    blockhash,
    lastValidBlockHeight: lvbh,
    requestedLamports,
    destinationWallet,
    sourceAgentPublicKey,
  };
}

export type WithdrawSignatureVerdict =
  | { verdict: 'landed' }
  | { verdict: 'onchain_failed'; error: string }
  | { verdict: 'still_valid' }
  | { verdict: 'unverifiable'; note: string }
  | { verdict: 'expired' };

/**
 * Classify a persisted broadcast signature by on-chain status. The err field
 * is checked BEFORE confirmationStatus (a landed-but-failed transaction is a
 * definite failure whatever its confirmation level). 'expired' requires the
 * chain height to be STRICTLY greater than lastValidBlockHeight + slack; a
 * transport failure on either read is 'unverifiable' (retry later), never a
 * verdict. A signature SEEN on-chain at 'processed' (or an unknown
 * non-terminal level) is 'still_valid' per contract — 'unverifiable' is
 * reserved for RPC read failures only.
 */
export async function classifyWithdrawSignature(
  signature: string,
  lastValidBlockHeight: number,
): Promise<WithdrawSignatureVerdict> {
  let status: Awaited<ReturnType<typeof getSignatureStatusStrict>>;
  try {
    status = await getSignatureStatusStrict(signature);
  } catch (e) {
    return { verdict: 'unverifiable', note: `status read failed: ${errMsg(e)}` };
  }
  if (status) {
    if (status.err !== null && status.err !== undefined) {
      return { verdict: 'onchain_failed', error: `Transaction failed on-chain: ${safeJson(status.err)}` };
    }
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return { verdict: 'landed' };
    }
    // Seen at 'processed' (or an unknown non-terminal level): live on-chain
    // below our commitment — neither success nor failure, and NOT a transport
    // failure, so per contract this is still_valid (resolve on a later pass).
    return { verdict: 'still_valid' };
  }
  let height: number;
  try {
    height = await getBlockHeightStrict();
  } catch (e) {
    return { verdict: 'unverifiable', note: `block height read failed: ${errMsg(e)}` };
  }
  if (height > lastValidBlockHeight + SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS) {
    return { verdict: 'expired' };
  }
  return { verdict: 'still_valid' };
}

/** Signature evidence = ANY persisted trace of a write-ahead, however partial. */
function hasSignatureEvidence(op: BorrowOperationRow): boolean {
  const sigs = Array.isArray(op.txSignatures) ? op.txSignatures : [];
  if (sigs.length > 0) return true;
  const meta = (op.metadata ?? {}) as Record<string, unknown>;
  return meta.withdrawTxSignature !== undefined;
}

/**
 * Client-safe terminal-failure text keyed by persisted step. The persisted
 * op.error keeps the detailed cause for operators; API bodies must never
 * replay raw DB/RPC/executor text (WO Build 8.3 / matrix #14). Every status
 * this machine writes as 'failed' is provably transfer-free (pre-broadcast
 * no-signature CAS, definite on-chain failure, or strict blockhash expiry),
 * so "no funds moved" is an invariant, not an estimate.
 */
function clientSafeFailureMessage(step: string): string {
  switch (step) {
    case 'withdraw_conflict':
      return 'Another agent-wallet operation is in flight; wait for it to finish, then submit a new withdrawal with a fresh clientRequestId.';
    case 'withdraw_failed_onchain':
      return 'The withdrawal transaction failed on-chain; no funds moved. Submit a new withdrawal with a fresh clientRequestId.';
    case 'withdraw_expired':
      return 'The withdrawal transaction expired without landing; no funds moved. Submit a new withdrawal with a fresh clientRequestId.';
    case 'withdraw_prebroadcast_failed':
      return 'The withdrawal was not broadcast; no funds moved. Submit a new withdrawal with a fresh clientRequestId.';
    default:
      return 'The withdrawal failed; no funds were moved. Submit a new withdrawal with a fresh clientRequestId.';
  }
}

// ————————————————————————————————————————————————————————————————
// Response builders (shared by both handlers; keyed by clientRequestId)
// ————————————————————————————————————————————————————————————————

function responseBuilders(clientRequestId: string) {
  const pending202 = (message: string, signature?: string): WithdrawHandlerResult => ({
    http: 202,
    body: {
      success: false,
      state: 'pending',
      pending: true,
      clientRequestId,
      message,
      ...(signature ? { signature } : {}),
    },
  });

  const terminalFailed = (step: string, error: string, signature?: string): WithdrawHandlerResult => ({
    http: step === 'withdraw_conflict' ? 409 : 400,
    body: {
      success: false,
      state: 'failed',
      terminal: true,
      clientRequestId,
      step,
      error,
      ...(signature ? { signature } : {}),
    },
  });

  const manualReview = (signature?: string): WithdrawHandlerResult => ({
    http: 409,
    body: {
      success: false,
      state: 'pending',
      pending: true,
      manualReview: true,
      clientRequestId,
      message:
        'This withdrawal needs manual review; nothing further will be sent automatically. Contact support with this clientRequestId.',
      ...(signature ? { signature } : {}),
    },
  });

  const succeeded200 = (op: BorrowOperationRow, fallbackSig?: string): WithdrawHandlerResult => {
    const r = (op.result ?? {}) as Record<string, unknown>;
    return {
      http: 200,
      body: {
        success: true,
        state: 'succeeded',
        clientRequestId,
        signature: typeof r.signature === 'string' ? r.signature : fallbackSig ?? null,
        withdrawnLamports: typeof r.withdrawnLamports === 'string' ? r.withdrawnLamports : null,
        withdrawnSol: typeof r.withdrawnSolDisplay === 'string' ? r.withdrawnSolDisplay : null,
        message: 'Withdrawal completed.',
      },
    };
  };

  /**
   * Normalized answer from a stored row WITHOUT any writes or RPC. Pending
   * rows answer 202 (with the persisted signature when coherent) — this path
   * deliberately never re-enters reconciliation, so resolver loops are
   * impossible. Statuses this machine never writes (completed/parked/unknown)
   * fail closed to manual review.
   */
  const storedStateResponse = (op: BorrowOperationRow): WithdrawHandlerResult => {
    if (op.status === 'succeeded') return succeeded200(op);
    if (op.status === 'failed') {
      const step = op.step ?? 'withdraw_prebroadcast_failed';
      return terminalFailed(step, clientSafeFailureMessage(step));
    }
    if (op.status === 'pending') {
      const prov = selectWithdrawProvenance(op);
      return pending202(
        'Withdrawal is still being processed; retry with the same clientRequestId.',
        prov.valid ? prov.signature : undefined,
      );
    }
    return manualReview();
  };

  return { pending202, terminalFailed, manualReview, succeeded200, storedStateResponse };
}

// ————————————————————————————————————————————————————————————————
// POST /api/agent/withdraw-sol
// ————————————————————————————————————————————————————————————————

export async function handleAgentSolWithdraw(
  walletAddress: string,
  body: unknown,
): Promise<WithdrawHandlerResult> {
  const parsed = parseWithdrawRequest(body);
  if (!parsed.ok) {
    return { http: 400, body: { success: false, error: parsed.error } };
  }
  const { clientRequestId, lamports } = parsed;
  const { pending202, terminalFailed, manualReview, succeeded200, storedStateResponse } =
    responseBuilders(clientRequestId);

  const tryTransition = async (
    p: Parameters<typeof storage.transitionAgentSolWithdraw>[0],
  ): Promise<boolean | 'error'> => {
    try {
      return await storage.transitionAgentSolWithdraw(p);
    } catch {
      return 'error';
    }
  };

  const reloadAndResolve = async (operationId: string): Promise<WithdrawHandlerResult> => {
    let fresh: BorrowOperationRow | undefined;
    try {
      fresh = await storage.getBorrowOperationById(operationId);
    } catch {
      fresh = undefined;
    }
    if (!fresh || fresh.walletAddress !== walletAddress) {
      return pending202('Could not load the withdrawal state; retry with the same clientRequestId.');
    }
    if (fresh.status === 'pending') {
      if (hasSignatureEvidence(fresh)) {
        const prov = selectWithdrawProvenance(fresh);
        return pending202(
          'A broadcast for this withdrawal is being reconciled; retry with the same clientRequestId.',
          prov.valid ? prov.signature : undefined,
        );
      }
      return pending202('Withdrawal is still pending; retry with the same clientRequestId.');
    }
    return storedStateResponse(fresh);
  };

  const finalizeLanded = async (operationId: string, signature: string): Promise<WithdrawHandlerResult> => {
    let fin: Awaited<ReturnType<typeof storage.finalizeAgentSolWithdrawSuccess>>;
    try {
      fin = await storage.finalizeAgentSolWithdrawSuccess({
        operationId,
        walletAddress,
        expectedSignature: signature,
      });
    } catch {
      // The transfer landed; recording rolls forward on a later retry.
      return pending202(
        'The transfer landed but recording it has not completed; retry with the same clientRequestId to finish.',
        signature,
      );
    }
    if (fin.outcome === 'finalized' || fin.outcome === 'already_succeeded') {
      return succeeded200(fin.operation, signature);
    }
    if (fin.reason === 'malformed_provenance') {
      return manualReview(signature);
    }
    return await reloadAndResolve(operationId);
  };

  const reconcile = async (op: BorrowOperationRow): Promise<WithdrawHandlerResult> => {
    const prov = selectWithdrawProvenance(op);
    if (!prov.valid) {
      // Malformed persisted provenance: fail CLOSED. Zero RPC probes, zero
      // writes, and NEVER an automatic mark-failed — signed bytes may exist.
      return manualReview();
    }
    const verdict = await classifyWithdrawSignature(prov.signature, prov.lastValidBlockHeight);
    if (verdict.verdict === 'landed') {
      return await finalizeLanded(op.id, prov.signature);
    }
    if (verdict.verdict === 'onchain_failed' || verdict.verdict === 'expired') {
      const step = verdict.verdict === 'onchain_failed' ? 'withdraw_failed_onchain' : 'withdraw_expired';
      const error =
        verdict.verdict === 'onchain_failed'
          ? truncate(verdict.error)
          : `Blockhash window expired without the transaction landing (checked strictly beyond lastValidBlockHeight + ${SOL_WITHDRAW_EXPIRY_SLACK_BLOCKS} blocks).`;
      const ok = await tryTransition({
        operationId: op.id,
        walletAddress,
        toStatus: 'failed',
        step,
        error,
        requireSignature: prov.signature,
      });
      if (ok === 'error') {
        return pending202('The withdrawal outcome is known but recording it failed; retry with the same clientRequestId.', prov.signature);
      }
      if (!ok) return await reloadAndResolve(op.id);
      return terminalFailed(step, clientSafeFailureMessage(step), prov.signature);
    }
    // still_valid | unverifiable — breadcrumb is best-effort, answer is 202.
    const step = verdict.verdict === 'still_valid' ? 'withdraw_still_valid' : 'withdraw_unverifiable';
    try {
      await storage.transitionAgentSolWithdraw({
        operationId: op.id,
        walletAddress,
        step,
        mergeMetadata: {
          lastReconcileVerdict: verdict.verdict,
          lastReconcileAt: new Date().toISOString(),
        },
        requireSignature: prov.signature,
      });
    } catch {
      // best-effort breadcrumb only
    }
    return pending202(
      verdict.verdict === 'still_valid'
        ? 'The withdrawal transaction is still within its validity window; retry shortly with the same clientRequestId.'
        : 'The withdrawal broadcast could not be verified yet; retry with the same clientRequestId.',
      prov.signature,
    );
  };

  const resolveNotBroadcast = async (
    operationId: string,
    error: string,
    rejection: PrecommitRejection | null,
  ): Promise<WithdrawHandlerResult> => {
    let fresh: BorrowOperationRow | undefined;
    try {
      fresh = await storage.getBorrowOperationById(operationId);
    } catch {
      fresh = undefined;
    }
    if (!fresh || fresh.walletAddress !== walletAddress) {
      return pending202('Nothing was broadcast, but the withdrawal state could not be loaded; retry with the same clientRequestId.');
    }
    if (hasSignatureEvidence(fresh)) {
      // A write-ahead exists: this attempt lost the race to a sibling that
      // owns a (possible) broadcast. Reconcile the persisted signature —
      // never terminalize a row that may own live bytes.
      return await reconcile(fresh);
    }
    if (fresh.status !== 'pending') {
      return storedStateResponse(fresh);
    }
    const step = rejection?.reason === 'conflict' ? 'withdraw_conflict' : 'withdraw_prebroadcast_failed';
    const reasonText = rejection ? `signature write-ahead rejected: ${rejection.reason}` : truncate(error);
    const ok = await tryTransition({
      operationId,
      walletAddress,
      toStatus: 'failed',
      step,
      error: reasonText,
      requireNoSignature: true,
    });
    if (ok === 'error') {
      return pending202('Nothing was broadcast; retry with the same clientRequestId.');
    }
    if (!ok) return await reloadAndResolve(operationId);
    return terminalFailed(step, clientSafeFailureMessage(step));
  };

  // ——— Main flow ———

  const wallet = await storage.getWallet(walletAddress);
  if (!wallet) return { http: 404, body: { error: 'Wallet not found' } };
  if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
    return { http: 400, body: { error: 'Agent wallet not initialized' } };
  }
  const agentPublicKey = wallet.agentPublicKey;
  const requestedLamportsStr = String(lamports);

  let intent: Awaited<ReturnType<typeof storage.getOrCreateAgentSolWithdrawIntent>>;
  try {
    intent = await storage.getOrCreateAgentSolWithdrawIntent({
      walletAddress,
      clientRequestId,
      pinned: {
        requestedLamports: requestedLamportsStr,
        destinationWallet: walletAddress,
        sourceAgentPublicKey: agentPublicKey,
      },
    });
  } catch {
    return pending202('Could not create or load the withdrawal intent; nothing was sent. Retry with the same clientRequestId.');
  }
  const op = intent.operation;

  if (op.operationType !== AGENT_SOL_WITHDRAW_OP_TYPE) {
    return terminalFailed(
      'withdraw_conflict',
      'clientRequestId is already used by a different operation type; use a fresh clientRequestId.',
    );
  }

  if (!intent.created) {
    // Adopted an existing intent: its pins are authoritative. Two distinct
    // failure classes here:
    //  1. MALFORMED pins (not even well-formed): corrupted provenance. Fail
    //     CLOSED to manual review — zero writes, zero RPC, and NEVER
    //     fresh-clientRequestId guidance, because a signature write-ahead
    //     (signed bytes) may exist for this row.
    //  2. WELL-FORMED pins that differ from this request: a retry with
    //     different parameters — rejected with fresh-clientRequestId
    //     guidance. Never mutate an existing intent. (Safe: while this row
    //     is non-terminal the concurrent-op gate blocks any new withdrawal.)
    const meta = (op.metadata ?? {}) as Record<string, unknown>;
    let pinsWellFormed = false;
    try {
      pinsWellFormed =
        typeof meta.requestedLamports === 'string' &&
        BigInt(meta.requestedLamports) > 0n &&
        meta.destinationWallet === op.walletAddress &&
        typeof meta.sourceAgentPublicKey === 'string' &&
        meta.sourceAgentPublicKey.length > 0;
    } catch {
      pinsWellFormed = false;
    }
    if (!pinsWellFormed) {
      return manualReview();
    }
    const pinsMatch =
      meta.requestedLamports === requestedLamportsStr &&
      meta.destinationWallet === walletAddress &&
      meta.sourceAgentPublicKey === agentPublicKey;
    if (!pinsMatch) {
      return terminalFailed(
        'withdraw_conflict',
        'clientRequestId is already bound to a different withdrawal (amount, destination, or signer differ). Use a fresh clientRequestId.',
      );
    }
    if (op.status === 'succeeded') return succeeded200(op);
    if (op.status === 'failed') {
      const failedStep = op.step ?? 'withdraw_prebroadcast_failed';
      return terminalFailed(failedStep, clientSafeFailureMessage(failedStep));
    }
    if (op.status !== 'pending') {
      // Statuses this machine never writes — fail closed, no writes.
      return manualReview();
    }
    if (hasSignatureEvidence(op)) {
      return await reconcile(op);
    }
    // Clean pending adopt (e.g. crash before the write-ahead): resume below.
  }

  // ——— Resume gates (clean pending intent, no signature evidence) ———

  // Conflict gate: any OTHER non-terminal agent_sol_withdraw or loop_hop row
  // blocks. Terminal = the explicit allowlist ONLY (unknown statuses BLOCK);
  // a failed read fails closed to a retryable answer.
  let allOps: BorrowOperationRow[];
  try {
    allOps = await storage.getBorrowOperations(walletAddress);
  } catch {
    return pending202('Could not verify concurrent operations; nothing was sent. Retry with the same clientRequestId.');
  }
  const blocker = allOps.find(
    (o) =>
      o.id !== op.id &&
      (o.operationType === AGENT_SOL_WITHDRAW_OP_TYPE || o.operationType === 'loop_hop') &&
      !TERMINAL_OPERATION_STATUSES.has(o.status),
  );
  if (blocker) {
    const ok = await tryTransition({
      operationId: op.id,
      walletAddress,
      toStatus: 'failed',
      step: 'withdraw_conflict',
      error: `Blocked by concurrent operation ${blocker.id} (${blocker.operationType}, status ${blocker.status}).`,
      requireNoSignature: true,
    });
    if (ok === 'error') {
      return pending202('Could not record the withdrawal state; nothing was sent. Retry with the same clientRequestId.');
    }
    if (!ok) return await reloadAndResolve(op.id);
    return terminalFailed('withdraw_conflict', clientSafeFailureMessage('withdraw_conflict'));
  }

  // Balance gate: STRICT lamports read (throws on failure — fail closed to a
  // retryable answer, never assume zero). Requires amount + gas reserve.
  let balanceLamports: bigint;
  try {
    balanceLamports = await getAgentSolBalanceLamportsStrict(agentPublicKey);
  } catch {
    return pending202('Could not read the agent wallet balance; nothing was sent. Retry with the same clientRequestId.');
  }
  const requiredLamports = BigInt(lamports) + SOL_WITHDRAW_RESERVE_LAMPORTS;
  if (balanceLamports < requiredLamports) {
    const ok = await tryTransition({
      operationId: op.id,
      walletAddress,
      toStatus: 'failed',
      step: 'withdraw_prebroadcast_failed',
      error: `Insufficient SOL: balance ${balanceLamports} lamports < requested ${lamports} + reserve ${SOL_WITHDRAW_RESERVE_LAMPORTS} lamports.`,
      requireNoSignature: true,
    });
    if (ok === 'error') {
      return pending202('Could not record the withdrawal state; nothing was sent. Retry with the same clientRequestId.');
    }
    if (!ok) return await reloadAndResolve(op.id);
    return terminalFailed(
      'withdraw_prebroadcast_failed',
      'Insufficient SOL balance (must keep 0.005 SOL reserve for gas). Submit a new withdrawal with a fresh clientRequestId.',
    );
  }

  // UMK gate: no signing material → the op stays pending and the SAME
  // clientRequestId resumes after re-keying. Nothing was sent.
  let umkResult: Awaited<ReturnType<typeof getUmkForWebhook>>;
  try {
    umkResult = await getUmkForWebhook(walletAddress);
  } catch {
    return pending202('Could not access signing material; nothing was sent. Retry with the same clientRequestId.');
  }
  if (!umkResult) {
    return {
      http: 400,
      body: {
        success: false,
        state: 'pending',
        pending: true,
        clientRequestId,
        error: 'Your wallet needs to be re-keyed — please sign out and sign back in.',
      },
    };
  }

  let precommitRejection: PrecommitRejection | null = null;
  let execResult: DurableSolWithdrawResult;
  let agentKeyResult: Awaited<ReturnType<typeof decryptAgentKeyStrict>> = null;
  try {
    agentKeyResult = await decryptAgentKeyStrict(walletAddress, umkResult.umk, wallet, agentPublicKey);
    if (!agentKeyResult) {
      return {
        http: 400,
        body: {
          success: false,
          state: 'pending',
          pending: true,
          clientRequestId,
          error: 'Your wallet needs to be re-keyed — please sign out and sign back in.',
        },
      };
    }
    execResult = await executeAgentSolWithdrawDurable(
      agentPublicKey,
      agentKeyResult.secretKey,
      walletAddress,
      lamports,
      clientRequestId,
      async (precommit) => {
        const outcome = await storage.precommitAgentSolWithdrawSignature({
          operationId: op.id,
          walletAddress,
          signedSourceAgentPublicKey: agentPublicKey,
          signedDestinationWallet: walletAddress,
          precommit,
        });
        if (!outcome.won) {
          precommitRejection = outcome;
          throw new Error(`signature write-ahead rejected: ${outcome.reason}`);
        }
      },
    );
  } finally {
    agentKeyResult?.cleanup();
    umkResult.cleanup();
  }

  if (execResult.state === 'confirmed') {
    return await finalizeLanded(op.id, execResult.signature);
  }
  if (execResult.state === 'failed_on_chain') {
    const ok = await tryTransition({
      operationId: op.id,
      walletAddress,
      toStatus: 'failed',
      step: 'withdraw_failed_onchain',
      error: truncate(execResult.error),
      requireSignature: execResult.signature,
    });
    if (ok === 'error') {
      return pending202(
        'The withdrawal failed on-chain but recording that failed; retry with the same clientRequestId.',
        execResult.signature,
      );
    }
    if (!ok) return await reloadAndResolve(op.id);
    return terminalFailed(
      'withdraw_failed_onchain',
      clientSafeFailureMessage('withdraw_failed_onchain'),
      execResult.signature,
    );
  }
  if (execResult.state === 'ambiguous') {
    // Best-effort breadcrumb; the persisted signature is already the truth.
    try {
      await storage.transitionAgentSolWithdraw({
        operationId: op.id,
        walletAddress,
        step: 'withdraw_ambiguous',
        mergeMetadata: {
          lastAmbiguousError: truncate(execResult.error),
          lastAmbiguousAt: new Date().toISOString(),
        },
        requireSignature: execResult.signature,
      });
    } catch {
      // best-effort breadcrumb only
    }
    return pending202(
      'The broadcast outcome is uncertain; it will be reconciled. Retry with the same clientRequestId to check.',
      execResult.signature,
    );
  }
  return await resolveNotBroadcast(op.id, execResult.error, precommitRejection);
}

// ————————————————————————————————————————————————————————————————
// POST /api/agent/confirm-sol-withdraw (neutralized legacy endpoint)
// ————————————————————————————————————————————————————————————————

/**
 * The legacy browser-broadcast flow POSTed { amount, txSignature } here to
 * record the equity event. That write path is GONE — the durable route
 * records success atomically. This endpoint now:
 *  - with a clientRequestId: reports the stored state (ZERO writes, ZERO RPC);
 *  - without one: answers 410 migrated (legacy bodies can no longer create
 *    ledger entries, spoofed or otherwise).
 */
export async function handleConfirmSolWithdraw(
  walletAddress: string,
  body: unknown,
): Promise<WithdrawHandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawCrid = b.clientRequestId;
  const clientRequestId = typeof rawCrid === 'string' ? rawCrid.trim() : '';
  if (clientRequestId.length < 1 || clientRequestId.length > 128) {
    return {
      http: 410,
      body: {
        migrated: true,
        error:
          'This endpoint no longer records withdrawals. POST /api/agent/withdraw-sol executes and records them server-side; pass a clientRequestId here only to check status.',
      },
    };
  }
  const { pending202, storedStateResponse } = responseBuilders(clientRequestId);
  let op: BorrowOperationRow | undefined;
  try {
    op = await storage.getBorrowOperationByClientRequestId(walletAddress, clientRequestId);
  } catch {
    return pending202('Could not load the withdrawal state; retry.');
  }
  if (!op || op.operationType !== AGENT_SOL_WITHDRAW_OP_TYPE) {
    return { http: 404, body: { error: 'No SOL withdrawal found for this clientRequestId' } };
  }
  return storedStateResponse(op);
}

/**
 * Fail-closed landing confirmation for Flash market open/reduce/close
 * transactions, with a HARD wall-clock deadline.
 *
 * The Flash SDK's sendTransactionV3 submits with skipPreflight=true and
 * returns a signature WITHOUT confirming inclusion, so a dropped or reverted
 * tx would otherwise be reported as a fill and the caller would book a phantom
 * position (or phantom close).
 *
 * Deadline contract (the reason this module exists as a standalone, directly
 * testable unit):
 *  - ONE absolute wall-clock deadline covers the ENTIRE operation — every RPC
 *    call and every sleep. The operation always settles within windowMs plus
 *    scheduling slop, no matter how the RPC behaves.
 *  - Every getSignatureStatuses call is raced against a hard per-call timeout
 *    clamped to the remaining budget. A never-settling RPC request (which
 *    web3.js/undici WILL produce — AbortSignal.timeout has been observed not
 *    to fire in prod) cannot hold the poll past the deadline.
 *  - Transient RPC errors and per-call timeouts keep polling until the
 *    deadline; they are never a verdict by themselves.
 *  - An on-chain error is a DEFINITIVE failure (the tx landed and reverted —
 *    safe to surface as a plain failure).
 *  - No definitive status by the deadline is the fail-closed UNCONFIRMED
 *    verdict: NOT a fill, but also NOT safe to auto-retry, because the tx may
 *    still land inside the blockhash validity window. The verdict message
 *    carries UNCONFIRMED_LANDING_VERDICT_TOKEN so retry gates can hard-exclude
 *    it (see server/protocol/tx-verdicts.ts).
 */
import type { Connection } from "@solana/web3.js";
import { UNCONFIRMED_LANDING_VERDICT_TOKEN } from "../tx-verdicts";

/** ~30s total window: well under the ~60s request-proxy reap so webhook/close
 * routes that block on this still return a real verdict to the caller. */
export const CONFIRM_WINDOW_MS = 30_000;
export const CONFIRM_POLL_INTERVAL_MS = 1_500;
/** Hard cap on any single getSignatureStatuses call. */
export const CONFIRM_RPC_TIMEOUT_MS = 5_000;

export interface ConfirmTxLandedOptions {
  windowMs?: number;
  pollIntervalMs?: number;
  rpcTimeoutMs?: number;
}

export type ConfirmTxLandedResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** true = no definitive status by the deadline (tx may still land);
       *  false = definitive on-chain revert. */
      unconfirmed: boolean;
    };

/** The narrow slice of Connection this module needs (mockable in tests). */
export type SignatureStatusReader = Pick<Connection, "getSignatureStatuses">;

/**
 * Race a promise against a hard timeout. Both settle paths attach handlers to
 * the underlying promise, so a late rejection after the timeout wins is still
 * observed (no unhandled rejection); a late resolution is simply discarded.
 */
function raceWithHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`RPC call exceeded ${ms}ms hard timeout`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function confirmTxLanded(
  connection: SignatureStatusReader,
  signature: string,
  label: string,
  opts?: ConfirmTxLandedOptions,
): Promise<ConfirmTxLandedResult> {
  const windowMs = opts?.windowMs ?? CONFIRM_WINDOW_MS;
  const pollIntervalMs = opts?.pollIntervalMs ?? CONFIRM_POLL_INTERVAL_MS;
  const rpcTimeoutMs = opts?.rpcTimeoutMs ?? CONFIRM_RPC_TIMEOUT_MS;
  const deadlineAt = Date.now() + windowMs;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;

    try {
      const st = await raceWithHardTimeout(
        connection.getSignatureStatuses([signature], { searchTransactionHistory: true }),
        Math.min(rpcTimeoutMs, remainingMs),
      );
      const info = st?.value?.[0];
      if (info?.err) {
        return {
          ok: false,
          unconfirmed: false,
          error: `${label} transaction reverted on-chain (sig ${signature}): ${JSON.stringify(info.err)}`,
        };
      }
      if (info && (info.confirmationStatus === "confirmed" || info.confirmationStatus === "finalized")) {
        return { ok: true };
      }
    } catch {
      /* transient RPC error or per-call hard timeout — keep polling until the deadline */
    }

    const sleepMs = Math.min(pollIntervalMs, deadlineAt - Date.now());
    if (sleepMs <= 0) break;
    await new Promise((r) => setTimeout(r, sleepMs));
  }

  return {
    ok: false,
    unconfirmed: true,
    error:
      `${label} transaction did not confirm on-chain within the verification window (sig ${signature}). ` +
      `Not booked as filled — verify on the exchange before retrying (a late landing is reconciled automatically). ` +
      UNCONFIRMED_LANDING_VERDICT_TOKEN,
  };
}

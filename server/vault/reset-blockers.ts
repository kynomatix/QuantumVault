/**
 * server/vault/reset-blockers.ts — WO2B1
 *
 * Fail-closed ownership guard for Reset Agent Wallet. The reset rotates the
 * agent key that OWNS every vault borrow/loop position and signs every
 * resumable borrow operation; rotating while any such row is non-terminal
 * would strand collateral/debt behind a key we no longer persist.
 *
 * Terminal ALLOWLISTS — never blocklists — so unknown or future statuses
 * block by construction:
 *   - positions:  'closed' | 'failed'
 *   - operations: 'succeeded' | 'completed' | 'failed'
 *
 * The assessment reads BOTH position kinds ('borrow' classic + 'loop')
 * across ALL scopes (account-level and per-bot), and EVERY borrow-operation
 * row for the wallet with NO type, step, or position-link filter: an
 * operation with no position link, a loop hop whose SOURCE position is
 * already closed, and any future operation type (e.g. agent_sol_withdraw)
 * all block while non-terminal. Operations are also the kindless backstop:
 * any live vault machinery writes operation rows, whatever its kind.
 *
 * ANY read failure blocks — an assessment we cannot complete is an
 * assessment that failed closed.
 */
import { storage } from "../storage";

export const TERMINAL_POSITION_STATUSES: ReadonlySet<string> = new Set(["closed", "failed"]);

export const TERMINAL_OPERATION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "completed",
  "failed",
]);

export type ResetBlockerAssessment =
  | { blocked: false }
  | { blocked: true; reason: "active_vault_state" | "vault_state_unreadable" };

/**
 * Assess whether the wallet's vault borrow/loop state permits an agent-wallet
 * reset. Returns a COARSE verdict only — callers must not receive (or leak)
 * row ids, operation types, amounts, or any other private detail.
 */
export async function assessResetBlockers(walletAddress: string): Promise<ResetBlockerAssessment> {
  try {
    const [classicPositions, loopPositions, operations] = await Promise.all([
      storage.getBorrowPositionsAllScopes(walletAddress, "borrow"),
      storage.getBorrowPositionsAllScopes(walletAddress, "loop"),
      storage.getBorrowOperations(walletAddress),
    ]);

    const hasActivePosition = [...classicPositions, ...loopPositions].some(
      (p) => !TERMINAL_POSITION_STATUSES.has(String((p as { status?: unknown }).status ?? "")),
    );
    const hasActiveOperation = operations.some(
      (o) => !TERMINAL_OPERATION_STATUSES.has(String((o as { status?: unknown }).status ?? "")),
    );

    if (hasActivePosition || hasActiveOperation) {
      return { blocked: true, reason: "active_vault_state" };
    }
    return { blocked: false };
  } catch {
    return { blocked: true, reason: "vault_state_unreadable" };
  }
}

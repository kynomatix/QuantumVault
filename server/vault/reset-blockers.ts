/**
 * server/vault/reset-blockers.ts — WO2B1
 *
 * Fail-closed ownership guard for Reset Agent Wallet. The reset rotates the
 * agent key that owns vault state and remains the return destination for linked
 * trading accounts; rotating while either relationship exists can strand value
 * behind a key we no longer persist.
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
import {
  assessResetBlockerRows,
  type ResetBlockerAssessment,
} from "./reset-blocker-policy";

export {
  TERMINAL_OPERATION_STATUSES,
  TERMINAL_POSITION_STATUSES,
  type ResetBlockerAssessment,
} from "./reset-blocker-policy";

/**
 * Assess whether the wallet's vault borrow/loop state permits an agent-wallet
 * reset. Returns a COARSE verdict only — callers must not receive (or leak)
 * row ids, operation types, amounts, or any other private detail.
 */
export async function assessResetBlockers(
  walletAddress: string,
  observedAgentPublicKey: string,
): Promise<ResetBlockerAssessment> {
  try {
    const [
      classicPositions,
      loopPositions,
      operations,
      tradingBots,
      aiTraderBots,
      protocolSubaccounts,
      orphanedSubaccounts,
    ] = await Promise.all([
      storage.getBorrowPositionsAllScopes(walletAddress, "borrow"),
      storage.getBorrowPositionsAllScopes(walletAddress, "loop"),
      storage.getBorrowOperations(walletAddress),
      storage.getTradingBots(walletAddress),
      storage.getAiTraderBotsByWallet(walletAddress),
      storage.getProtocolSubaccountsByWallet(walletAddress),
      storage.getOrphanedSubaccountsByWallet(walletAddress),
    ]);

    return assessResetBlockerRows({
      classicPositions,
      loopPositions,
      operations,
      tradingBots: tradingBots.map((row) => ({
        driftSubaccountId: row.driftSubaccountId,
        protocolSubaccountId: row.protocolSubaccountId,
      })),
      aiTraderBots: aiTraderBots.map((row) => ({
        protocolSubaccountId: row.protocolSubaccountId,
      })),
      protocolSubaccounts: protocolSubaccounts.map((row) => ({
        protocolSubaccountId: row.protocolSubaccountId,
        agentPublicKey: row.agentPublicKey,
        status: row.status,
        subaccountKeyEncryptedV3: row.subaccountKeyEncryptedV3,
        lastVerifiedEmptyAt: row.lastVerifiedEmptyAt,
      })),
      orphanedSubaccounts: orphanedSubaccounts.map((row) => ({
        agentPublicKey: row.agentPublicKey,
      })),
      observedAgentPublicKey,
    });
  } catch {
    return { blocked: true, reason: "vault_state_unreadable" };
  }
}

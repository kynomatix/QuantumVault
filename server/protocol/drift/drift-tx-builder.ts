import type { UserTransactionBuilder } from '../adapter.js';
import type { TransactionBuildResult } from '../protocol-types.js';
import {
  buildDepositTransaction as driftBuildDepositTransaction,
  buildWithdrawTransaction as driftBuildWithdrawTransaction,
  buildTransferToSubaccountTransaction as driftBuildTransferToSubaccountTransaction,
  buildTransferFromSubaccountTransaction as driftBuildTransferFromSubaccountTransaction,
} from '../../drift-service.js';
import {
  USDT_MINT_MAINNET,
  NotSupportedError,
  tryParseCanonicalSubaccountId,
} from './drift-adapter.js';

// ============================================================================
// DriftTxBuilder
//
// Wraps drift-service.ts's user-side transaction builders behind the
// UserTransactionBuilder interface. NOT registered anywhere by this file —
// like DriftAdapter, registration is item 17 (atomic with bundled cleanups).
//
// Interface ↔ drift-service signature gaps:
//   * buildBindAgentWalletTransaction has no Drift analogue (Drift derives
//     subaccount authorities from the main wallet's key — no on-chain bind
//     transaction is needed for any sub). Throws NotSupportedError.
//   * Interface transfer methods take ONE subaccountId arg; drift-service
//     takes an explicit (fromSubId, toSubId) pair. We interpret the
//     interface as: To = move into the named sub (from main, sub 0);
//     From = move out of the named sub (to main, sub 0). This matches the
//     plain-English reading of "transfer to/from subaccount".
//   * subaccountId arrives as a string (interface contract); we parse to
//     number with strict validation — these are write paths, so silently
//     defaulting to 0 on bad input would route real money to the wrong
//     subaccount. Throw on garbage instead.
//
// Per PACIFICA_MIGRATION.md item 16 explicit note: do NOT expose
// buildAgentDriftDepositTransaction / buildAgentDriftWithdrawTransaction.
// Those are dead code — routes.ts has stubs at lines 198/202, and the live
// agent deposit/withdraw paths go through the subprocess executor instead.
// ============================================================================
export class DriftTxBuilder implements UserTransactionBuilder {
  readonly protocolName = 'drift';
  readonly collateralMint = USDT_MINT_MAINNET;
  readonly collateralSymbol = 'USDT';

  async buildBindAgentWalletTransaction(
    _mainWalletAddress: string,
    _agentPublicKey: string,
  ): Promise<TransactionBuildResult> {
    throw new NotSupportedError(
      'drift',
      'buildBindAgentWalletTransaction',
      'Drift derives subaccount authorities from the main wallet key — no on-chain bind transaction exists. The bot-creation flow allocates a numeric subaccount ID (see DriftAdapter.createSubaccount); the on-chain User account is initialized lazily on first deposit by executeAgentDriftDeposit.',
    );
  }

  async buildDepositTransaction(
    walletAddress: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      throw new Error('DriftTxBuilder: invalid deposit amount — must be a positive number');
    }
    return driftBuildDepositTransaction(walletAddress, amountUsdc);
  }

  async buildWithdrawTransaction(
    walletAddress: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      throw new Error('DriftTxBuilder: invalid withdraw amount — must be a positive number');
    }
    return driftBuildWithdrawTransaction(walletAddress, amountUsdc);
  }

  async buildTransferToSubaccountTransaction(
    walletAddress: string,
    subaccountId: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    const targetSubId = this.parseSubaccountIdStrict(subaccountId);
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      throw new Error('DriftTxBuilder: invalid transfer amount — must be a positive number');
    }
    // "To subaccount X" = move from main (sub 0) into sub X. drift-service's
    // builder also handles lazy initialization of the target sub if it
    // doesn't exist yet (see drift-service.ts:2076-2087).
    return driftBuildTransferToSubaccountTransaction(walletAddress, 0, targetSubId, amountUsdc);
  }

  async buildTransferFromSubaccountTransaction(
    walletAddress: string,
    subaccountId: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    const sourceSubId = this.parseSubaccountIdStrict(subaccountId);
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      throw new Error('DriftTxBuilder: invalid transfer amount — must be a positive number');
    }
    // "From subaccount X" = move from sub X back into main (sub 0).
    return driftBuildTransferFromSubaccountTransaction(walletAddress, sourceSubId, 0, amountUsdc);
  }

  // Strict parser — write paths must NOT silently default to subaccount 0
  // on garbage input (would route real money to the wrong subaccount).
  // Stricter than DriftAdapter's parseSubaccountId: empty/undefined is also
  // rejected here because the UserTransactionBuilder interface declares
  // subaccountId as a required string. Uses tryParseCanonicalSubaccountId
  // (digit-only regex + safe-integer check) to reject whitespace, scientific
  // notation, hex, signs, decimals — all forms `Number()` would silently
  // coerce. Read paths in DriftAdapter use a tolerant variant of the same
  // helper; this is intentional.
  private parseSubaccountIdStrict(subaccountId: string): number {
    if (subaccountId === undefined || subaccountId === null || subaccountId === '') {
      throw new Error(
        'DriftTxBuilder: subaccountId is required for transfer transactions',
      );
    }
    const parsed = tryParseCanonicalSubaccountId(subaccountId);
    if (parsed === null) {
      throw new Error(
        `DriftTxBuilder: invalid subaccountId "${subaccountId}" — must be a canonical non-negative integer string (decimal digits only, no whitespace, no scientific/hex notation)`,
      );
    }
    return parsed;
  }
}

/**
 * Flash `UserTransactionBuilder`.
 *
 * The adapter spec (§3 of ADDING_EXCHANGE_ADAPTERS.md) requires every Solana
 * protocol to expose a `UserTransactionBuilder` for the client-side wallet-popup
 * flow (the USER's main wallet signs).
 *
 * Flash's account model is `independent_trader` with WALLET-RESIDENT collateral
 * (§13): there is NO protocol "deposit to free balance" instruction — confirmed
 * against flash-sdk `PerpetualsClient` (it exposes only add/remove-collateral
 * *quotes* for an existing position and LP/stake deposits, no trader-collateral
 * vault deposit). Collateral is plain USDC in the bot wallet, committed at
 * `openPosition` time and returned at `closePosition`.
 *
 * Consequences for the user-signed popup flow:
 *   - Funding a bot = an SPL USDC transfer from the user's main wallet INTO the
 *     bot wallet. That requires the destination bot-wallet address, which is NOT
 *     part of this interface's `(walletAddress, amount)` signature, and is
 *     handled by the server-side provisioning flow instead.
 *   - Withdraw / bind / subaccount-transfer have no on-chain user-signed analog
 *     under this model.
 *
 * So every method here fails CLOSED with an explicit explanation rather than
 * fabricating an instruction — mirroring how `PacificaTxBuilder` throws for its
 * non-applicable (REST-only) methods. Capital movement on Flash goes through
 * `FlashAdapter.executeWithdraw()` (a real SPL transfer) and the provisioning
 * flow, never through this builder.
 */

import type { UserTransactionBuilder } from '../adapter.js';
import type { TransactionBuildResult } from '../protocol-types.js';
import { FLASH_USDC_MINT } from './flash-constants.js';

const NOT_APPLICABLE =
  'Flash uses the independent_trader model with wallet-resident collateral ' +
  '(FLASH_INTEGRATION.md §13): there is no protocol deposit/withdraw/bind/' +
  'subaccount instruction for a user wallet to sign. Fund a bot via an SPL USDC ' +
  'transfer to the bot wallet (provisioning flow); defund via ' +
  'FlashAdapter.executeWithdraw().';

export class FlashTxBuilder implements UserTransactionBuilder {
  readonly protocolName = 'flash';
  readonly collateralMint = FLASH_USDC_MINT;
  readonly collateralSymbol = 'USDC';

  async buildDepositTransaction(
    _walletAddress: string,
    _amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    throw new Error(`FlashTxBuilder.buildDepositTransaction: ${NOT_APPLICABLE}`);
  }

  async buildWithdrawTransaction(
    _walletAddress: string,
    _amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    throw new Error(`FlashTxBuilder.buildWithdrawTransaction: ${NOT_APPLICABLE}`);
  }

  async buildBindAgentWalletTransaction(
    _mainWalletAddress: string,
    _agentPublicKey: string,
  ): Promise<TransactionBuildResult> {
    throw new Error(
      `FlashTxBuilder.buildBindAgentWalletTransaction: ${NOT_APPLICABLE} ` +
      'The bot wallet IS the trader; there is no agent-binding step.',
    );
  }

  async buildTransferToSubaccountTransaction(
    _walletAddress: string,
    _subaccountId: string,
    _amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    throw new Error(`FlashTxBuilder.buildTransferToSubaccountTransaction: ${NOT_APPLICABLE}`);
  }

  async buildTransferFromSubaccountTransaction(
    _walletAddress: string,
    _subaccountId: string,
    _amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    throw new Error(`FlashTxBuilder.buildTransferFromSubaccountTransaction: ${NOT_APPLICABLE}`);
  }
}

export const flashTxBuilder = new FlashTxBuilder();

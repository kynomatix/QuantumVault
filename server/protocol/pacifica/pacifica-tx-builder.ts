import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
} from '@solana/web3.js';
import * as crypto from 'crypto';
import type { UserTransactionBuilder } from '../adapter.js';
import type { TransactionBuildResult } from '../protocol-types.js';
import { PacificaSigner, OPERATION_TYPES } from './pacifica-signer.js';
import { getPrimaryRpcUrl } from '../../rpc-config.js';

const PACIFICA_PROGRAM_ID = new PublicKey('PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH');
const PACIFICA_CENTRAL_STATE = new PublicKey('9Gdmhq4Gv1LnNMp7aiS1HSVd7pNnXNMsbuXALCQRmGjY');
const PACIFICA_USDC_VAULT = new PublicKey('72R843XwZxqWhsJceARQQTTbYtWy6Zw9et2YV4FpRHTa');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const [EVENT_AUTHORITY] = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  PACIFICA_PROGRAM_ID,
);

const DEPOSIT_DISCRIMINATOR = crypto
  .createHash('sha256')
  .update('global:deposit')
  .digest()
  .slice(0, 8);

function getAssociatedTokenAddress(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

function usdcToLamports(amountUsdc: number): bigint {
  return BigInt(Math.round(amountUsdc * 1_000_000));
}

function buildDepositInstruction(
  userPubkey: PublicKey,
  userUsdcAta: PublicKey,
  amountLamports: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(16);
  DEPOSIT_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(amountLamports, 8);

  const keys = [
    { pubkey: userPubkey, isSigner: true, isWritable: true },
    { pubkey: userUsdcAta, isSigner: false, isWritable: true },
    { pubkey: PACIFICA_CENTRAL_STATE, isSigner: false, isWritable: true },
    { pubkey: PACIFICA_USDC_VAULT, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: USDC_MINT, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PACIFICA_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: PACIFICA_PROGRAM_ID,
    data,
  });
}

export class PacificaTxBuilder implements UserTransactionBuilder {
  readonly protocolName = 'pacifica';
  private apiBaseUrl: string;

  constructor(apiBaseUrl: string = 'https://api.pacifica.fi/api/v1') {
    this.apiBaseUrl = apiBaseUrl;
  }

  private getConnection(): Connection {
    return new Connection(getPrimaryRpcUrl(), 'confirmed');
  }

  private async getRecentBlockhash(): Promise<{
    blockhash: string;
    lastValidBlockHeight: number;
  }> {
    const connection = this.getConnection();
    return connection.getLatestBlockhash('confirmed');
  }

  async buildDepositTransaction(
    walletAddress: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    if (!Number.isFinite(amountUsdc) || amountUsdc <= 0) {
      throw new Error('Invalid deposit amount: must be a positive number');
    }
    if (amountUsdc < 10) {
      throw new Error('Pacifica minimum deposit is $10');
    }

    const userPubkey = new PublicKey(walletAddress);
    const userUsdcAta = getAssociatedTokenAddress(USDC_MINT, userPubkey);
    const amountLamports = usdcToLamports(amountUsdc);

    const connection = this.getConnection();

    const [vaultInfo, centralStateInfo, ataInfo] = await Promise.all([
      connection.getAccountInfo(PACIFICA_USDC_VAULT),
      connection.getAccountInfo(PACIFICA_CENTRAL_STATE),
      connection.getAccountInfo(userUsdcAta),
    ]);

    if (!vaultInfo || vaultInfo.owner.toBase58() !== TOKEN_PROGRAM_ID.toBase58()) {
      throw new Error(
        'PacificaTxBuilder: vault account owner mismatch — aborting deposit. ' +
        'Expected owner: ' + TOKEN_PROGRAM_ID.toBase58() + ', ' +
        'got: ' + (vaultInfo ? vaultInfo.owner.toBase58() : 'null'),
      );
    }

    if (vaultInfo.data.length >= 40) {
      const mintFromVault = new PublicKey(vaultInfo.data.slice(0, 32));
      if (mintFromVault.toBase58() !== USDC_MINT.toBase58()) {
        throw new Error(
          'PacificaTxBuilder: vault mint mismatch — aborting deposit. ' +
          'Expected USDC ' + USDC_MINT.toBase58() + ', got: ' + mintFromVault.toBase58(),
        );
      }
    }

    if (!centralStateInfo || centralStateInfo.owner.toBase58() !== PACIFICA_PROGRAM_ID.toBase58()) {
      throw new Error(
        'PacificaTxBuilder: central state owner mismatch — aborting deposit. ' +
        'Expected owner: ' + PACIFICA_PROGRAM_ID.toBase58() + ', ' +
        'got: ' + (centralStateInfo ? centralStateInfo.owner.toBase58() : 'null'),
      );
    }

    if (!ataInfo) {
      throw new Error(
        'PacificaTxBuilder: wallet has no USDC token account at ' + userUsdcAta.toBase58() + '. ' +
        'Fund the wallet with USDC first.',
      );
    }

    const depositIx = buildDepositInstruction(userPubkey, userUsdcAta, amountLamports);

    const { blockhash, lastValidBlockHeight } = await this.getRecentBlockhash();
    const tx = new Transaction();
    tx.recentBlockhash = blockhash;
    tx.feePayer = userPubkey;
    tx.add(depositIx);

    const serialized = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');

    return {
      transaction: serialized,
      blockhash,
      lastValidBlockHeight,
      message: 'Deposit ' + amountUsdc + ' USDC to Pacifica',
    };
  }

  async buildWithdrawTransaction(
    walletAddress: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    throw new Error(
      'PacificaTxBuilder.buildWithdrawTransaction: Pacifica withdrawals are REST API calls ' +
      '(server-side via agent wallet), not on-chain transactions. ' +
      'Use PacificaAdapter.executeWithdraw() instead.',
    );
  }

  async buildBindAgentWalletTransaction(
    mainWalletAddress: string,
    agentPublicKey: string,
  ): Promise<TransactionBuildResult> {
    throw new Error(
      'PacificaTxBuilder.buildBindAgentWalletTransaction: Pacifica agent wallet registration ' +
      'is a REST API call with signature, not an on-chain transaction. ' +
      'Use PacificaAdapter.bindAgentWallet() instead.',
    );
  }

  async buildTransferToSubaccountTransaction(
    walletAddress: string,
    subaccountId: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    throw new Error(
      'PacificaTxBuilder.buildTransferToSubaccountTransaction: Pacifica subaccount transfers ' +
      'are REST API calls, not on-chain transactions. ' +
      'Use PacificaAdapter.transferBetweenSubaccounts() instead.',
    );
  }

  async buildTransferFromSubaccountTransaction(
    walletAddress: string,
    subaccountId: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult> {
    throw new Error(
      'PacificaTxBuilder.buildTransferFromSubaccountTransaction: Pacifica subaccount transfers ' +
      'are REST API calls, not on-chain transactions. ' +
      'Use PacificaAdapter.transferBetweenSubaccounts() instead.',
    );
  }
}

export {
  PACIFICA_PROGRAM_ID,
  PACIFICA_CENTRAL_STATE,
  PACIFICA_USDC_VAULT,
  USDC_MINT,
  EVENT_AUTHORITY,
  DEPOSIT_DISCRIMINATOR,
  buildDepositInstruction,
  getAssociatedTokenAddress,
  usdcToLamports,
};

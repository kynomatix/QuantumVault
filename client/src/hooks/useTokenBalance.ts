import { useCallback, useEffect, useState } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { confirmTransactionWithFallback } from '@/lib/solana-utils';

const MAINNET_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEVNET_USDC_MINT = '8zGuJQqwhZafTah7Uc7Z4tXRnguqkn5KLFAP8oV6PHe2';
const USDC_MINT = MAINNET_USDC_MINT;
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
): PublicKey {
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return address;
}

function createAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedToken, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
}

export function useTokenBalance() {
  const wallet = useSolanaWallet();
  const { connection } = useConnection();
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null);
  const [usdcLoading, setUsdcLoading] = useState(false);
  const [tokenAccountExists, setTokenAccountExists] = useState<boolean | null>(null);
  const [creatingAccount, setCreatingAccount] = useState(false);

  const usdcMint = new PublicKey(USDC_MINT);

  const fetchUsdcBalance = useCallback(async (showLoading = false) => {
    if (!wallet.publicKey) {
      setUsdcBalance(null);
      setTokenAccountExists(null);
      return;
    }

    setUsdcLoading(prev => showLoading || prev);
    try {
      const ata = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
      
      const accountInfo = await connection.getAccountInfo(ata);
      
      if (!accountInfo) {
        setTokenAccountExists(false);
        setUsdcBalance(0);
      } else {
        setTokenAccountExists(true);
        const tokenBalance = await connection.getTokenAccountBalance(ata);
        setUsdcBalance(tokenBalance.value.uiAmount ?? 0);
      }
    } catch (error) {
      console.error('Failed to fetch USDC balance:', error);
    } finally {
      setUsdcLoading(false);
    }
  }, [wallet.publicKey, connection, usdcMint]);

  const createTokenAccount = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signTransaction) {
      throw new Error('Wallet not connected');
    }

    setCreatingAccount(true);
    try {
      const ata = getAssociatedTokenAddressSync(usdcMint, wallet.publicKey);
      
      const accountInfo = await connection.getAccountInfo(ata);
      if (accountInfo) {
        setTokenAccountExists(true);
        return ata;
      }

      const createAtaIx = createAssociatedTokenAccountInstruction(
        wallet.publicKey,
        ata,
        wallet.publicKey,
        usdcMint
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const transaction = new Transaction({
        feePayer: wallet.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(createAtaIx);

      const signedTx = await wallet.signTransaction(transaction);
      const signature = await connection.sendRawTransaction(signedTx.serialize());
      
      await confirmTransactionWithFallback(connection, {
        signature,
        blockhash,
        lastValidBlockHeight,
      });

      setTokenAccountExists(true);
      await fetchUsdcBalance();
      
      return ata;
    } catch (error) {
      console.error('Failed to create token account:', error);
      throw error;
    } finally {
      setCreatingAccount(false);
    }
  }, [wallet.publicKey, wallet.signTransaction, connection, usdcMint, fetchUsdcBalance]);

  useEffect(() => {
    fetchUsdcBalance();
  }, [fetchUsdcBalance]);

  return {
    usdcBalance,
    usdcLoading,
    tokenAccountExists,
    creatingAccount,
    fetchUsdcBalance,
    createTokenAccount,
    usdcMint: USDC_MINT,
  };
}

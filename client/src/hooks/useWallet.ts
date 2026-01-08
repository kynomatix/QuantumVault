import { useCallback, useEffect, useState } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export { useConnection };

export function useWallet() {
  const wallet = useSolanaWallet();
  const { connection } = useConnection();
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  const publicKeyString = wallet.publicKey?.toBase58() || null;

  const shortenedAddress = publicKeyString
    ? `${publicKeyString.slice(0, 4)}...${publicKeyString.slice(-4)}`
    : null;

  const fetchBalance = useCallback(async () => {
    if (!wallet.publicKey) {
      setBalance(null);
      return;
    }

    setBalanceLoading(true);
    try {
      const lamports = await connection.getBalance(wallet.publicKey);
      setBalance(lamports / LAMPORTS_PER_SOL);
    } catch (error) {
      console.error('Failed to fetch balance:', error);
      setBalance(null);
    } finally {
      setBalanceLoading(false);
    }
  }, [wallet.publicKey, connection]);

  useEffect(() => {
    fetchBalance();
    
    if (wallet.publicKey) {
      const id = connection.onAccountChange(wallet.publicKey, () => {
        fetchBalance();
      });
      return () => {
        connection.removeAccountChangeListener(id);
      };
    }
  }, [wallet.publicKey, connection, fetchBalance]);

  return {
    ...wallet,
    publicKeyString,
    shortenedAddress,
    balance,
    balanceLoading,
    fetchBalance,
  };
}

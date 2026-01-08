import { useCallback, useEffect, useState, useRef } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';

export { useConnection };

export function useWallet() {
  const wallet = useSolanaWallet();
  const { connection } = useConnection();
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [sessionConnected, setSessionConnected] = useState(false);
  const lastConnectedWallet = useRef<string | null>(null);

  const publicKeyString = wallet.publicKey?.toBase58() || null;

  const shortenedAddress = publicKeyString
    ? `${publicKeyString.slice(0, 4)}...${publicKeyString.slice(-4)}`
    : null;

  // Register wallet with backend session when connected
  useEffect(() => {
    const registerWallet = async () => {
      if (publicKeyString && publicKeyString !== lastConnectedWallet.current) {
        try {
          const res = await fetch('/api/wallet/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ walletAddress: publicKeyString }),
          });
          if (res.ok) {
            lastConnectedWallet.current = publicKeyString;
            setSessionConnected(true);
          }
        } catch (error) {
          console.error('Failed to register wallet with session:', error);
        }
      } else if (!publicKeyString) {
        lastConnectedWallet.current = null;
        setSessionConnected(false);
      }
    };
    
    registerWallet();
  }, [publicKeyString]);

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
    sessionConnected,
  };
}

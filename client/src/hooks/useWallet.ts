import { useCallback, useEffect, useState, useRef } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

export { useConnection };

// Helper to get referral code from URL
const getReferralCodeFromUrl = (): string | null => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  return params.get('ref');
};

export function useWallet() {
  const wallet = useSolanaWallet();
  const { connection } = useConnection();
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [sessionConnected, setSessionConnected] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [signingInProgress, setSigningInProgress] = useState(false);
  const lastConnectedWallet = useRef<string | null>(null);
  const authAttempted = useRef<Set<string>>(new Set());

  const publicKeyString = wallet.publicKey?.toBase58() || null;

  const shortenedAddress = publicKeyString
    ? `${publicKeyString.slice(0, 4)}...${publicKeyString.slice(-4)}`
    : null;

  // Secure wallet connection with signature verification
  const authenticateWallet = useCallback(async (walletAddress: string): Promise<boolean> => {
    if (!wallet.signMessage) {
      console.error('Wallet does not support message signing');
      return false;
    }

    try {
      setSigningInProgress(true);
      
      // Step 1: Request nonce from server
      const nonceRes = await fetch('/api/auth/nonce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress, purpose: 'unlock_umk' }),
      });
      
      if (!nonceRes.ok) {
        throw new Error('Failed to get signing nonce');
      }
      
      const { nonce, message } = await nonceRes.json();
      
      // Step 2: Sign message with wallet
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await wallet.signMessage(messageBytes);
      const signatureBase58 = bs58.encode(signatureBytes);
      
      // Step 3: Verify signature and complete authentication
      const verifyRes = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          walletAddress,
          nonce,
          signature: signatureBase58,
          purpose: 'unlock_umk',
        }),
      });
      
      if (!verifyRes.ok) {
        const error = await verifyRes.json();
        throw new Error(error.error || 'Signature verification failed');
      }
      
      // Step 4: Also call the legacy connect endpoint for backwards compatibility
      const referredByCode = getReferralCodeFromUrl();
      const connectRes = await fetch('/api/wallet/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          walletAddress,
          referredByCode: referredByCode || undefined,
        }),
      });
      
      if (connectRes.ok) {
        const data = await connectRes.json();
        setReferralCode(data.referralCode || null);
      }
      
      return true;
    } catch (error) {
      console.error('Authentication failed:', error);
      return false;
    } finally {
      setSigningInProgress(false);
    }
  }, [wallet.signMessage]);

  // Register wallet with backend session when connected
  useEffect(() => {
    const registerWallet = async () => {
      if (publicKeyString && publicKeyString !== lastConnectedWallet.current) {
        // Prevent duplicate authentication attempts
        if (authAttempted.current.has(publicKeyString)) {
          return;
        }
        authAttempted.current.add(publicKeyString);
        
        try {
          const success = await authenticateWallet(publicKeyString);
          if (success) {
            lastConnectedWallet.current = publicKeyString;
            setSessionConnected(true);
          }
        } catch (error) {
          console.error('Failed to register wallet with session:', error);
          authAttempted.current.delete(publicKeyString);
        }
      } else if (!publicKeyString) {
        lastConnectedWallet.current = null;
        setSessionConnected(false);
        setReferralCode(null);
        authAttempted.current.clear();
      }
    };
    
    registerWallet();
  }, [publicKeyString, authenticateWallet]);

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
    signingInProgress,
    referralCode,
    authenticateWallet,
  };
}

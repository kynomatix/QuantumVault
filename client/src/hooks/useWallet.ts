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

// Per-wallet auth promise map for single-flight pattern
// This ensures only one auth attempt per wallet address at a time
const authPromiseMap = new Map<string, Promise<boolean>>();

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
  const authSucceeded = useRef<Set<string>>(new Set());
  const authInProgress = useRef<Set<string>>(new Set());
  
  // Stable ref for signMessage to avoid useCallback recreation
  const signMessageRef = useRef(wallet.signMessage);
  signMessageRef.current = wallet.signMessage;

  const publicKeyString = wallet.publicKey?.toBase58() || null;

  const shortenedAddress = publicKeyString
    ? `${publicKeyString.slice(0, 4)}...${publicKeyString.slice(-4)}`
    : null;

  // Secure wallet connection with signature verification
  // Using empty dependency array with ref to prevent useCallback recreation
  const authenticateWallet = useCallback(async (walletAddress: string): Promise<boolean> => {
    const signMessage = signMessageRef.current;
    if (!signMessage) {
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
      
      // Step 2: Sign message with wallet (use ref to avoid stale closure)
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = await signMessage(messageBytes);
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
  }, []); // Empty deps - uses ref for signMessage

  // Register wallet with backend session when connected
  useEffect(() => {
    const registerWallet = async () => {
      if (publicKeyString && publicKeyString !== lastConnectedWallet.current) {
        // Already authenticated successfully in this session - just restore state
        if (authSucceeded.current.has(publicKeyString)) {
          lastConnectedWallet.current = publicKeyString;
          setSessionConnected(true);
          return;
        }
        
        // Prevent duplicate authentication attempts using multiple guards
        // 1. Check refs (per-wallet tracking)
        if (authAttempted.current.has(publicKeyString) || authInProgress.current.has(publicKeyString)) {
          return;
        }
        
        // 2. Check if auth is already in flight for this wallet (single-flight pattern)
        const existingPromise = authPromiseMap.get(publicKeyString);
        if (existingPromise) {
          // Wait for existing auth to complete instead of starting new one
          const success = await existingPromise;
          if (success) {
            authSucceeded.current.add(publicKeyString);
            lastConnectedWallet.current = publicKeyString;
            setSessionConnected(true);
          }
          return;
        }
        
        // Set locks SYNCHRONOUSLY before any async work
        authInProgress.current.add(publicKeyString);
        authAttempted.current.add(publicKeyString);
        
        // Create and store the auth promise for single-flight pattern
        const walletToAuth = publicKeyString;
        const authPromise = (async (): Promise<boolean> => {
          try {
            // First, check if server already has a valid session for this wallet
            // This avoids prompting for signature if already authenticated
            const statusRes = await fetch('/api/auth/status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ walletAddress: walletToAuth }),
            });
            
            if (statusRes.ok) {
              const statusData = await statusRes.json();
              if (statusData.authenticated) {
                // Session already exists - skip signature, just connect
                const referredByCode = getReferralCodeFromUrl();
                const connectRes = await fetch('/api/wallet/connect', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  credentials: 'include',
                  body: JSON.stringify({ 
                    walletAddress: walletToAuth,
                    referredByCode: referredByCode || undefined,
                  }),
                });
                
                if (connectRes.ok) {
                  const data = await connectRes.json();
                  setReferralCode(data.referralCode || null);
                }
                
                return true;
              }
            }
            
            // No existing session - need to authenticate with signature
            return await authenticateWallet(walletToAuth);
          } catch (error) {
            console.error('Failed to register wallet with session:', error);
            return false;
          } finally {
            authInProgress.current.delete(walletToAuth);
            authPromiseMap.delete(walletToAuth);
          }
        })();
        
        // Store the promise BEFORE awaiting so concurrent calls can find it
        authPromiseMap.set(walletToAuth, authPromise);
        
        const success = await authPromise;
        if (success) {
          authSucceeded.current.add(walletToAuth);
          lastConnectedWallet.current = walletToAuth;
          setSessionConnected(true);
        }
      } else if (!publicKeyString) {
        lastConnectedWallet.current = null;
        setSessionConnected(false);
        setReferralCode(null);
        // Only clear on explicit disconnect
        authAttempted.current.clear();
        authSucceeded.current.clear();
        authInProgress.current.clear();
        authPromiseMap.clear();
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

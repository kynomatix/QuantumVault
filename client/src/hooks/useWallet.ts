import { safeResponseJson } from "@/lib/safe-fetch";
import { useCallback, useEffect, useState, useRef } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { queryClient, setActiveWalletAddress } from '@/lib/queryClient';

export { useConnection };

// Helper to get referral code from URL, with a sessionStorage fallback for
// users arriving via a marketplace share link (where the referral code is the
// bot creator's code stashed by MarketplaceBotPage).
const getReferralCodeFromUrl = (): string | null => {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get('ref');
  if (fromUrl) return fromUrl;
  try {
    const raw = sessionStorage.getItem('pendingMarketplaceIntent');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { referralCode?: string | null };
    return parsed?.referralCode || null;
  } catch {
    return null;
  }
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
  const [authError, setAuthError] = useState(false);
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
      
      const { nonce, message } = await safeResponseJson(nonceRes);
      
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
        const error = await safeResponseJson(verifyRes);
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
        const data = await safeResponseJson(connectRes);
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

  // Gesture-driven retry for when the automatic post-connect sign-in failed
  // (e.g. a transient Phantom Mobile Wallet Adapter hiccup). Clears the
  // per-wallet guards and re-runs authentication from a user tap so the wallet's
  // signMessage fires inside an active user gesture.
  const retryAuth = useCallback(async (): Promise<boolean> => {
    if (!publicKeyString) return false;
    const walletToAuth = publicKeyString;
    authAttempted.current.delete(walletToAuth);
    authInProgress.current.delete(walletToAuth);
    authPromiseMap.delete(walletToAuth);
    setAuthError(false);
    authInProgress.current.add(walletToAuth);
    authAttempted.current.add(walletToAuth);
    try {
      const ok = await authenticateWallet(walletToAuth);
      if (ok) {
        authSucceeded.current.add(walletToAuth);
        lastConnectedWallet.current = walletToAuth;
        setSessionConnected(true);
      } else {
        setAuthError(true);
      }
      return ok;
    } finally {
      authInProgress.current.delete(walletToAuth);
    }
  }, [publicKeyString, authenticateWallet]);

  // Register wallet with backend session when connected
  useEffect(() => {
    const registerWallet = async () => {
      // Keep the API layer's wallet header in sync with the connected wallet so
      // every authenticated request fails closed (server 403) if the express
      // session is still pinned to a previously connected wallet.
      setActiveWalletAddress(publicKeyString);

      if (publicKeyString && publicKeyString !== lastConnectedWallet.current) {
        // CRITICAL: Clear all cached queries when switching wallets
        // This prevents stale data from the previous wallet from being displayed
        if (lastConnectedWallet.current !== null) {
          console.log('[Wallet] Wallet changed, clearing query cache');
          queryClient.clear();
          // Drop the "session ready" flag until the NEW wallet re-authenticates.
          // Otherwise effects gated on sessionConnected could run against the
          // previous wallet's server session during the switch window.
          setSessionConnected(false);
        }
        
        // Already authenticated successfully in this session - just restore state
        if (authSucceeded.current.has(publicKeyString)) {
          lastConnectedWallet.current = publicKeyString;
          setSessionConnected(true);
          return;
        }
        
        // Prevent duplicate authentication attempts using multiple guards
        // 1. Check refs (per-wallet tracking)
        if (authAttempted.current.has(publicKeyString) || authInProgress.current.has(publicKeyString)) {
          // If a PRIOR attempt for this wallet already failed (attempted, not in
          // flight, not succeeded) — e.g. the user switched away after a failed
          // sign-in and switched back — restore the error state so the gate shows
          // the retry screen instead of a permanently stuck "Signing in…" spinner.
          if (
            authAttempted.current.has(publicKeyString) &&
            !authInProgress.current.has(publicKeyString) &&
            !authSucceeded.current.has(publicKeyString)
          ) {
            setAuthError(true);
          }
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
          } else {
            setAuthError(true);
          }
          return;
        }
        
        // Clear any prior failure now that a fresh attempt is starting.
        setAuthError(false);

        // Set locks SYNCHRONOUSLY before any async work
        authInProgress.current.add(publicKeyString);
        authAttempted.current.add(publicKeyString);
        
        // Create and store the auth promise for single-flight pattern
        const walletToAuth = publicKeyString;
        const authPromise = (async (): Promise<boolean> => {
          try {
            // First, check if server already has a valid session for this wallet
            // This avoids prompting for signature if already authenticated
            // 15s timeout: this fetch gates the whole connect flow — if the
            // server is degraded (2026-07-19: wedged DB pool held requests
            // ~30s before 500ing), an unbounded wait here leaves the user
            // staring at a dead dashboard with no signature prompt. Timing
            // out falls through to the normal "not authenticated" path.
            const statusRes = await fetch('/api/auth/status', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ walletAddress: walletToAuth }),
              signal: AbortSignal.timeout(15_000),
            });
            
            if (statusRes.ok) {
              const statusData = await safeResponseJson(statusRes);
              if (statusData.authenticated) {
                // The 7-day express-session cookie is still valid — but that only
                // proves identity, NOT that the in-memory SECURITY session (the
                // decrypted UMK every money op needs to sign with the agent key)
                // still exists. That UMK session lives only in server memory, is
                // wiped on every deploy/restart, and expires after a 4h TTL. So a
                // returning user — especially on mobile, where a reconnect is a
                // fresh tap after the in-memory key is long gone — routinely has a
                // live cookie + a DEAD UMK. If we trusted the cookie alone we'd
                // mark the wallet "connected", then fail deep inside a repay/borrow
                // with "No active session". Confirm the UMK session here; if it's
                // gone, re-sign ONCE now (a single signature) so the key is ready
                // BEFORE any money action instead of mid-flow.
                let hasUmkSession = false;
                try {
                  const sessRes = await fetch('/api/auth/session', {
                    credentials: 'include',
                    signal: AbortSignal.timeout(15_000),
                  });
                  if (sessRes.ok) {
                    const sessData = await safeResponseJson(sessRes);
                    hasUmkSession = !!sessData.hasSession;
                  }
                } catch {
                  // Inconclusive check → treat as no UMK and re-sign. Failing toward
                  // a usable session is safer (one extra signature at worst) than
                  // fabricating "connected" and stranding the next money op.
                  hasUmkSession = false;
                }

                if (hasUmkSession) {
                  // Both tiers alive — skip the signature, just (re)bind the wallet.
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
                    const data = await safeResponseJson(connectRes);
                    setReferralCode(data.referralCode || null);
                  }
                  
                  return true;
                }
                // Cookie alive but UMK gone → fall through to re-sign below.
                // authenticateWallet also re-binds the wallet (/api/wallet/connect)
                // on success, so no separate connect call is needed here.
              }
            }
            
            // No usable security session — authenticate with one signature.
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
        } else {
          setAuthError(true);
        }
      } else if (!publicKeyString) {
        // Clear query cache when wallet disconnects
        console.log('[Wallet] Wallet disconnected, clearing query cache');
        queryClient.clear();
        
        lastConnectedWallet.current = null;
        setSessionConnected(false);
        setReferralCode(null);
        setAuthError(false);
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
    authError,
    retryAuth,
    referralCode,
    authenticateWallet,
  };
}

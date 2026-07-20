import { safeResponseJson } from "@/lib/safe-fetch";
import { useCallback, useEffect, useState, useRef } from 'react';
import { useWallet as useSolanaWallet, useConnection } from '@solana/wallet-adapter-react';
import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { queryClient, setActiveWalletAddress } from '@/lib/queryClient';
import { probeSession, onSessionVerdict, getLastSessionVerdict } from '@/lib/session-probe';
import { recordClientEvent } from '@/lib/client-telemetry';

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
// This ensures only one auth attempt per wallet address at a time.
// 'deferred' = the server was unavailable during the session probe — the
// session may be perfectly valid, so nothing failed and no signature was
// requested; session-probe auto-retries and the verdict listener in the hook
// completes the connect when the server answers (2026-07-20 incident).
type AuthFlowOutcome = 'ok' | 'failed' | 'deferred';
const authPromiseMap = new Map<string, Promise<AuthFlowOutcome>>();

export function useWallet() {
  const wallet = useSolanaWallet();
  const { connection } = useConnection();
  const [balance, setBalance] = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [sessionConnected, setSessionConnected] = useState(false);
  const [referralCode, setReferralCode] = useState<string | null>(null);
  const [signingInProgress, setSigningInProgress] = useState(false);
  const [authError, setAuthError] = useState(false);
  // True while the session probe says the SERVER is unavailable (network /
  // 5xx / timeout) during connect — distinct from authError (a failed
  // signature) and from "signing in". The probe auto-retries with bounded
  // backoff; when it lands 'valid' the session completes with no signature.
  const [sessionRecovering, setSessionRecovering] = useState(false);
  const lastConnectedWallet = useRef<string | null>(null);
  // Which wallet's data currently populates the query cache. Unlike
  // lastConnectedWallet this survives disconnects, so we can tell a transient
  // same-wallet drop (keep last-known-good) from a different wallet taking
  // over (must clear).
  const lastDataOwnerWallet = useRef<string | null>(null);
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
    setSessionRecovering(false);
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

      // Telemetry breadcrumb: wallet presence transitions (deduped; a mobile
      // MWA flap shows up as alternating present/absent — a key incident
      // signature we could never prove from prod before).
      recordClientEvent('wallet', publicKeyString ? 'present' : 'absent');

      if (publicKeyString && publicKeyString !== lastConnectedWallet.current) {
        // CRITICAL: Clear all cached queries when a DIFFERENT wallet takes
        // over. Compared against lastDataOwnerWallet (which survives
        // disconnects) rather than lastConnectedWallet (nulled on disconnect)
        // so a disconnect→reconnect with another wallet still clears, while a
        // transient drop + same-wallet reconnect keeps last-known-good data.
        if (lastDataOwnerWallet.current !== null && lastDataOwnerWallet.current !== publicKeyString) {
          console.log('[Wallet] Different wallet connected, clearing query cache');
          queryClient.clear();
          // Drop the "session ready" flag until the NEW wallet re-authenticates.
          // Otherwise effects gated on sessionConnected could run against the
          // previous wallet's server session during the switch window.
          setSessionConnected(false);
        }
        lastDataOwnerWallet.current = publicKeyString;
        
        // Already authenticated successfully in this session - just restore state
        if (authSucceeded.current.has(publicKeyString)) {
          lastConnectedWallet.current = publicKeyString;
          setSessionConnected(true);
          return;
        }

        // Late-mount seed (2026-07-20 incident): auth refs are PER-HOOK-
        // INSTANCE, so a component that mounts after connect (route change,
        // lazy chunk) starts with empty refs and would re-run the whole
        // probe/connect flow — and, in the stranding variants, could wedge on
        // the one-attempt guard and hold sessionConnected=false for its
        // subtree while the app-level instance says true. If the probe layer
        // already has an authoritative 'valid' verdict for THIS wallet, the
        // session is established — adopt it instead of re-authenticating.
        // If the verdict is stale, the next core 401 re-probes and the
        // verdict listener below corrects the state.
        {
          const seeded = getLastSessionVerdict();
          if (seeded?.kind === 'valid' && seeded.walletAddress === publicKeyString) {
            authSucceeded.current.add(publicKeyString);
            authAttempted.current.add(publicKeyString);
            lastConnectedWallet.current = publicKeyString;
            setSessionConnected(true);
            setSessionRecovering(false);
            recordClientEvent('late-mount-seed', 'valid-verdict');
            return;
          }
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
          const outcome = await existingPromise;
          if (outcome === 'ok') {
            authSucceeded.current.add(publicKeyString);
            lastConnectedWallet.current = publicKeyString;
            setSessionConnected(true);
          } else if (outcome === 'failed') {
            setAuthError(true);
          }
          // 'deferred' → server unavailable; the session-probe verdict
          // listener below completes the connect when the server answers.
          return;
        }
        
        // Clear any prior failure now that a fresh attempt is starting.
        setAuthError(false);

        // Set locks SYNCHRONOUSLY before any async work
        authInProgress.current.add(publicKeyString);
        authAttempted.current.add(publicKeyString);
        
        // Create and store the auth promise for single-flight pattern
        const walletToAuth = publicKeyString;
        const authPromise = (async (): Promise<AuthFlowOutcome> => {
          try {
            // ONE authoritative wallet-bound probe (2026-07-20 incident)
            // replaces the old status+session fetch pair. It distinguishes:
            //   valid              → cookie AND UMK alive (server auto-restores
            //                        the UMK from storage where possible) —
            //                        no signature, just (re)bind the wallet;
            //   signature-required → the server authoritatively said so
            //                        (cookie invalid / wallet mismatch / UMK
            //                        genuinely unrestorable) — re-sign ONCE
            //                        now so the key is ready BEFORE any money
            //                        action instead of mid-flow;
            //   server-unavailable → network / 5xx / timeout says NOTHING
            //                        about the session. Do NOT request a
            //                        signature and do NOT fail the connect —
            //                        the probe auto-retries with bounded
            //                        backoff and the verdict listener below
            //                        completes the session when it lands.
            const verdict = await probeSession();

            if (verdict.kind === 'valid') {
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
              
              return 'ok';
            }

            if (verdict.kind === 'server-unavailable') {
              return 'deferred';
            }

            // signature-required (or no-wallet edge) — authenticate with one
            // signature. authenticateWallet also re-binds the wallet
            // (/api/wallet/connect) on success.
            return (await authenticateWallet(walletToAuth)) ? 'ok' : 'failed';
          } catch (error) {
            console.error('Failed to register wallet with session:', error);
            return 'failed';
          } finally {
            authInProgress.current.delete(walletToAuth);
            authPromiseMap.delete(walletToAuth);
          }
        })();
        
        // Store the promise BEFORE awaiting so concurrent calls can find it
        authPromiseMap.set(walletToAuth, authPromise);
        
        const outcome = await authPromise;
        if (outcome === 'ok') {
          authSucceeded.current.add(walletToAuth);
          lastConnectedWallet.current = walletToAuth;
          setSessionConnected(true);
          setSessionRecovering(false);
        } else if (outcome === 'failed') {
          setAuthError(true);
          setSessionRecovering(false);
        } else {
          // 'deferred': server unavailable — nothing failed, no signature was
          // requested. Clear the one-attempt guard so a later probe verdict /
          // reconnect can rerun the flow (a transient outage must never
          // become a permanent one-attempt auth deadlock), and surface the
          // "reconnecting to server" state instead of a sign-in error.
          authAttempted.current.delete(walletToAuth);
          setSessionRecovering(true);
        }
      } else if (!publicKeyString) {
        // Wallet disconnected. Do NOT wipe the query cache here: on mobile the
        // Mobile Wallet Adapter drops the public key transiently (every app
        // switch / page restore), and clearing on each drop erased the user's
        // last-known-good dashboard before reconnect completed — reads then
        // raced a half-established session and rendered a false-empty account
        // (2026-07-19 incident). Cached data stays, marked stale by the UI;
        // the cache is cleared above the moment a DIFFERENT wallet connects,
        // and the session flag below prevents any authed use meanwhile.
        console.log('[Wallet] Wallet disconnected; keeping last-known-good data (marked stale)');
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

  // Session-probe verdict listener (2026-07-20 incident): completes a
  // deferred connect (server was unavailable during the probe) and guarantees
  // recovery from a transient outage without a reload or user tap. A
  // background probe verdict must NEVER auto-fire signMessage (mobile wallets
  // require a user gesture) — 'signature-required' only surfaces the
  // gesture-driven sign-in gate.
  useEffect(() => {
    const unsub = onSessionVerdict((v) => {
      const current = publicKeyString;
      if (!current) return;

      if (v.kind === 'valid' && v.walletAddress === current) {
        authSucceeded.current.add(current);
        authAttempted.current.add(current);
        lastConnectedWallet.current = current;
        setSessionRecovering(false);
        setAuthError(false);
        setSessionConnected(true);
        return;
      }

      if (v.kind === 'signature-required' && v.walletAddress === current) {
        setSessionRecovering(false);
        // If the connect flow itself is mid-flight it will handle the
        // signature; and if the session is already established, the
        // session-expired latch (server-health) drives the reconnect banner.
        if (!authInProgress.current.has(current) && !sessionConnected) {
          // Allow a fresh gesture-driven attempt instead of deadlocking on
          // the one-attempt guard.
          authAttempted.current.delete(current);
          setAuthError(true);
        }
        return;
      }

      if (v.kind === 'server-unavailable' && !sessionConnected) {
        setSessionRecovering(true);
      }
    });
    return unsub;
  }, [publicKeyString, sessionConnected]);

  // Telemetry breadcrumb: sessionConnected transitions. Same-value reports
  // from the many useWallet instances collapse via dedupe; ALTERNATING values
  // (instances disagreeing) flap through — exactly the per-instance
  // divergence evidence the stuck-dashboard incident needs.
  useEffect(() => {
    recordClientEvent('session-connected', String(sessionConnected));
  }, [sessionConnected]);

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
    sessionRecovering,
    retryAuth,
    referralCode,
    authenticateWallet,
  };
}

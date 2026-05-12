import { useMemo, ReactNode, useState, useEffect, useCallback } from 'react';
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  SolanaMobileWalletAdapter,
  SolanaMobileWalletAdapterWalletName,
  createDefaultAddressSelector,
  createDefaultWalletNotFoundHandler,
} from '@solana-mobile/wallet-adapter-mobile';

import '@solana/wallet-adapter-react-ui/styles.css';

interface WalletProviderProps {
  children: ReactNode;
}

// In-memory only. We deliberately do NOT persist authorization between page
// loads or between attempts. Persisting causes the Seeker / Seed Vault "three
// dots forever" hang when a previous attempt left a stale entry whose
// appIdentity (e.g. icon URL) no longer matches the current config — the
// wallet silently rejects the cached auth and the adapter never recovers.
const inMemoryAuthCache = (() => {
  let cached: any = null;
  return {
    get: async () => cached,
    set: async (auth: any) => { cached = auth; },
    clear: async () => { cached = null; },
  };
})();

export function WalletProvider({ children }: WalletProviderProps) {
  // Use our server's RPC proxy to avoid exposing API keys
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setEndpoint(`${window.location.origin}/api/solana-rpc`);
    }
  }, []);

  // One-time cleanup of any stale MWA authorization left in localStorage by
  // previous versions of this provider. Keeps the Seeker out of the bad
  // half-authorized state on first load after this fix ships.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const keysToWipe: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        if (
          k.includes('mobile-wallet-adapter') ||
          k.includes('SolanaMobileWalletAdapterDefaultAuthorizationCache') ||
          k === 'walletName'
        ) {
          keysToWipe.push(k);
        }
      }
      for (const k of keysToWipe) window.localStorage.removeItem(k);
      if (keysToWipe.length > 0) {
        console.log('[WalletProvider] Cleared stale wallet adapter keys:', keysToWipe);
      }
    } catch (e) {
      console.warn('[WalletProvider] localStorage cleanup failed:', e);
    }
  }, []);

  const wallets = useMemo(() => {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://quantumvault.app';
    const mwa = new SolanaMobileWalletAdapter({
      addressSelector: createDefaultAddressSelector(),
      appIdentity: {
        name: 'QuantumVault',
        uri: origin,
        // MUST be relative — Seed Vault throws "identity.icon must be a
        // relative URI" if absolute. The wallet resolves it against `uri`.
        icon: '/favicon.png',
      },
      authorizationResultCache: inMemoryAuthCache,
      // 'mainnet-beta' and 'solana:mainnet' are normalized to the same value
      // internally by chainOrClusterToChainId — either works.
      chain: 'solana:mainnet',
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    });

    // Diagnostic logging on the MWA lifecycle so we can see exactly where
    // things stall on the Seeker if there's still a problem.
    const mwaAny = mwa as any;
    mwaAny.on?.('connect', (pk: any) => {
      console.log('[MWA] connect event, publicKey:', pk?.toBase58?.());
    });
    mwaAny.on?.('disconnect', () => {
      console.log('[MWA] disconnect event');
    });
    mwaAny.on?.('error', (err: any) => {
      console.error('[MWA] error event:', err?.name, err?.message, err);
    });
    mwaAny.on?.('readyStateChange', (state: any) => {
      console.log('[MWA] readyStateChange:', state);
    });

    // Phantom registers itself as a Standard Wallet automatically, so the
    // explicit PhantomWalletAdapter was redundant and was producing the
    // duplicate-wallet warning in the console. Removed.
    return [mwa];
  }, []);

  const onWalletError = useCallback((error: Error) => {
    console.error('[WalletAdapter]', error.name, error.message, error);
  }, []);

  // Conditional autoConnect: ONLY auto-resume the session if the user
  // previously selected MWA on this device — never trigger a fresh
  // auto-association on first visit, which is what was leaving the Seeker
  // adapter in a half-connecting state and causing the "three dots" hang.
  const autoConnect = useCallback(async (adapter: any): Promise<boolean> => {
    if (typeof window === 'undefined') return false;
    const lastWallet = window.localStorage.getItem('walletName');
    if (adapter?.name === SolanaMobileWalletAdapterWalletName) {
      // Only auto-reconnect MWA if the user explicitly chose it before AND
      // we still have an in-memory authorization (which we never do on a
      // fresh page load, since the cache is in-memory only).
      return false;
    }
    return lastWallet === adapter?.name;
  }, []);

  // Wait for endpoint to be available before rendering providers
  if (!endpoint) {
    return null;
  }

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect={autoConnect} onError={onWalletError}>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

import { useMemo, ReactNode, useState, useEffect, useCallback } from 'react';
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  registerMwa,
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
} from '@solana-mobile/wallet-standard-mobile';

import '@solana/wallet-adapter-react-ui/styles.css';

interface WalletProviderProps {
  children: ReactNode;
}

// Module-level guard so registerMwa is invoked exactly once per page load,
// even across React strict-mode double mounts and HMR.
let mwaRegistered = false;

function registerMwaOnce() {
  if (mwaRegistered) return;
  if (typeof window === 'undefined') return;
  if (!window.isSecureContext) {
    console.warn('[MWA] Skipping registration: page is not in a secure context (https required)');
    return;
  }
  try {
    registerMwa({
      appIdentity: {
        name: 'QuantumVault',
        uri: window.location.origin,
        // MUST be a relative path. Seed Vault rejects absolute URLs with
        // "identity.icon must be a relative URI".
        icon: 'favicon.png',
      },
      authorizationCache: createDefaultAuthorizationCache(),
      chains: ['solana:mainnet'],
      chainSelector: createDefaultChainSelector(),
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
      // remoteHostAuthority would enable desktop QR connection via reflector.
      // Leaving unset for now — only mobile (local association) is needed.
    });
    mwaRegistered = true;
    console.log('[MWA] Registered via wallet-standard-mobile');
  } catch (e) {
    console.error('[MWA] registerMwa failed:', e);
  }
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [endpoint, setEndpoint] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setEndpoint(`${window.location.origin}/api/solana-rpc`);
    }
  }, []);

  // One-time cleanup of stale MWA authorization left in localStorage by the
  // previous (legacy) WalletProvider implementation. Prevents the "three dots
  // forever" hang on Seeker caused by mismatched cached appIdentity.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const keysToWipe: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (!k) continue;
        if (
          k.includes('mobile-wallet-adapter') ||
          k.includes('SolanaMobileWalletAdapterDefaultAuthorizationCache')
        ) {
          keysToWipe.push(k);
        }
      }
      for (const k of keysToWipe) window.localStorage.removeItem(k);
      if (keysToWipe.length > 0) {
        console.log('[WalletProvider] Cleared legacy MWA cache keys:', keysToWipe);
      }
    } catch (e) {
      console.warn('[WalletProvider] localStorage cleanup failed:', e);
    }
  }, []);

  // Register MWA via the modern wallet-standard pathway. This makes MWA
  // discoverable through the Wallet Standard, so wallet-adapter-react picks
  // it up automatically alongside Phantom, Jupiter, Solflare, Backpack, etc.
  useEffect(() => {
    registerMwaOnce();
  }, []);

  // Empty wallets array — every wallet (Phantom, Jupiter, Solflare, Backpack,
  // MWA) self-registers via the Wallet Standard and is auto-discovered by
  // useStandardWalletAdapters inside SolanaWalletProvider. Listing wallets
  // explicitly here would just create duplicates.
  const wallets = useMemo(() => [], []);

  const onWalletError = useCallback((error: Error) => {
    console.error('[WalletAdapter]', error.name, error.message, error);
  }, []);

  if (!endpoint) {
    return null;
  }

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect={false} onError={onWalletError}>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

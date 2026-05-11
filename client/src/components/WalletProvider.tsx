import { useMemo, ReactNode, useState, useEffect, useCallback } from 'react';
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolanaMobileWalletAdapter, createDefaultAddressSelector, createDefaultAuthorizationResultCache, createDefaultWalletNotFoundHandler } from '@solana-mobile/wallet-adapter-mobile';

import '@solana/wallet-adapter-react-ui/styles.css';

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  // Use our server's RPC proxy to avoid exposing API keys
  const [endpoint, setEndpoint] = useState<string | null>(null);
  
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setEndpoint(`${window.location.origin}/api/solana-rpc`);
    }
  }, []);

  const wallets = useMemo(
    () => {
      const origin = typeof window !== 'undefined' ? window.location.origin : 'https://quantumvault.app';
      return [
        new SolanaMobileWalletAdapter({
          addressSelector: createDefaultAddressSelector(),
          appIdentity: {
            name: 'QuantumVault',
            uri: origin,
            // Absolute URL — relative paths can be rejected by some MWA wallets
            // (notably Seeker's Seed Vault) during the association handshake.
            icon: `${origin}/favicon.png`,
          },
          authorizationResultCache: createDefaultAuthorizationResultCache(),
          // CAIP-2 chain identifier — required by MWA 2.x compatible wallets
          // (Seeker / newer Seed Vault). The legacy 'mainnet-beta' value is
          // accepted by older wallets but silently fails on newer ones, which
          // looks exactly like the "modal closes, never connects" symptom.
          chain: 'solana:mainnet',
          onWalletNotFound: createDefaultWalletNotFoundHandler(),
        }),
        new PhantomWalletAdapter(),
      ];
    },
    []
  );

  // Surface adapter errors to the console so MWA association failures
  // (cancellation, secure-context issues, etc.) are visible instead of
  // silently dropping the user back to the disconnected state.
  const onWalletError = useCallback((error: Error) => {
    console.error('[WalletAdapter]', error.name, error.message, error);
  }, []);

  // Wait for endpoint to be available before rendering providers
  if (!endpoint) {
    return null;
  }

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider wallets={wallets} autoConnect onError={onWalletError}>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

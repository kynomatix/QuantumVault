import { useMemo, ReactNode, useState, useEffect, useCallback } from 'react';
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  registerMwa,
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
} from '@solana-mobile/wallet-standard-mobile';
import { SolanaMobileWalletAdapterWalletName } from '@solana-mobile/wallet-adapter-mobile';

import '@solana/wallet-adapter-react-ui/styles.css';

interface WalletProviderProps {
  children: ReactNode;
}

// Module-level guard so registerMwa is invoked exactly once per page load,
// even across React strict-mode double mounts and HMR.
let mwaRegistered = false;

// Runs once at module load — BEFORE wallet-adapter's <SolanaWalletProvider>
// reads its persisted "walletName" (it reads via a useState initializer on first
// render). If the last selected wallet was MWA, we drop it so the page never
// silently auto-reconnects MWA on load. That silent reconnect (adapter.autoConnect())
// is what caused the Seeker "three dots forever" hang. We only clear when the
// stored wallet is MWA — every other wallet keeps its normal auto-reconnect.
// With this in place we can safely allow autoConnect=true for MWA, which is what
// makes the wallet modal's user-tap fire adapter.connect() (the connect branch
// in @solana/wallet-adapter-react that hasUserSelectedAWallet gates).
function clearPersistedMwaSelection() {
  if (typeof window === 'undefined') return;
  try {
    // 'walletName' is wallet-adapter-react's default localStorageKey.
    const raw = window.localStorage.getItem('walletName');
    if (!raw) return;
    let parsed: string | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
    if (parsed === SolanaMobileWalletAdapterWalletName) {
      window.localStorage.removeItem('walletName');
      console.log('[WalletProvider] Cleared persisted MWA selection (prevents load-time auto-reconnect)');
    }
  } catch {
    /* ignore */
  }
}
clearPersistedMwaSelection();

// Strip `wallet_uri_base` from every MWA authorization.
//
// When a wallet (e.g. Jupiter) authorizes, it may return a `wallet_uri_base`
// like `https://jup.ag`. The MWA library stores it on its in-memory
// authorization and uses it as the association base for EVERY association after
// the first. With an https base, launchAssociation() does a top-level
// `window.location.assign("https://jup.ag/v1/associate/local?...")`. On the
// Seeker / wallet in-app browser an Android App Link intercepts that and reopens
// the wallet, but in a THIRD-PARTY mobile browser (e.g. Brave) it just navigates
// to the wallet's website -> 404, stranding the user. (The connect itself works:
// the first association uses the `solana-wallet:` custom scheme because the
// in-memory authorization is still empty; it's the SECOND association — our
// post-connect signMessage login — that inherits the https base and redirects.)
//
// Removing wallet_uri_base forces ALL associations through the `solana-wallet:`
// custom scheme, which the OS intercepts via intent WITHOUT replacing the page,
// so the dApp survives the round trip and the wallet returns cleanly. This is
// already how the Seeker path behaves, so it's a no-op there and a fix for
// generic Android browsers.
//
// Implementation note: wallet-standard-mobile passes the SAME authorization
// object reference to `authorizationCache.set()` and to its internal
// `#authorization` assignment within one `Promise.all([... set(auth),
// handleAuthorizationResult(auth)])`, evaluating `set()` first. Deleting the
// field synchronously at the top of `set()` therefore also clears the LIVE
// in-memory value before the next association reads it — not just the persisted
// copy. `get()` strips defensively for the reconnect-from-cache path.
function createWalletUriBaseStrippingAuthorizationCache() {
  const inner = createDefaultAuthorizationCache();
  let loggedStrip = false;
  const strip = <T,>(auth: T): T => {
    if (auth && typeof auth === 'object' && 'wallet_uri_base' in (auth as any)) {
      delete (auth as any).wallet_uri_base;
      if (!loggedStrip) {
        loggedStrip = true;
        console.log('[MWA] Stripped wallet_uri_base; forcing solana-wallet: association scheme');
      }
    }
    return auth;
  };
  return {
    clear: () => inner.clear(),
    get: async () => strip(await inner.get()),
    set: (auth: Parameters<typeof inner.set>[0]) => inner.set(strip(auth)),
  };
}

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
        // MUST be a relative path (resolved against `uri`). Seed Vault rejects
        // absolute URLs with "identity.icon must be a relative URI". This points
        // at the QuantumVault brand mark served at the site root (same icon the
        // PWA manifest uses), NOT the old favicon.png — that file was a leftover
        // Replit logo, which is what showed up in the wallet connect/sign sheet.
        icon: 'icon-192.png',
      },
      authorizationCache: createWalletUriBaseStrippingAuthorizationCache(),
      chains: ['solana:mainnet'],
      chainSelector: createDefaultChainSelector(),
      // Quiet no-op instead of createDefaultWalletNotFoundHandler(). The default
      // pops up "To use mobile wallet adapter, you must have a compatible mobile
      // wallet application installed on your device" (and can redirect to a
      // download page). On the Solana Seeker the wallet (Seed Vault) is built in,
      // so this fires misleadingly when an association just times out / isn't
      // completed in time — confusing users into thinking they have no wallet.
      // Suppress the UI; log only.
      onWalletNotFound: async () => {
        console.warn(
          '[MWA] wallet-not-found handler fired (UI suppressed). Usually means the association timed out or was cancelled, not that no wallet is installed.',
        );
      },
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

  // Allow auto-connect for ALL wallets, including MWA. wallet-adapter-react uses
  // this gate for two distinct branches (see WalletProvider internals):
  //   - user tapped the wallet in the modal  -> adapter.connect()      (we WANT this for MWA)
  //   - silent page-load restore             -> adapter.autoConnect()  (caused MWA "three dots")
  // Returning false for MWA (the previous fix) blocked BOTH, so tapping MWA in
  // the modal did nothing. We now return true for MWA — the unwanted load-time
  // restore is instead prevented surgically by clearPersistedMwaSelection() at
  // module load, so MWA is never the restored wallet on a fresh page.
  const autoConnect = useCallback(async (adapter: any): Promise<boolean> => {
    if (!adapter) return false;
    return true;
  }, []);

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

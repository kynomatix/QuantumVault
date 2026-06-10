import { useEffect, useMemo, useRef, useState } from 'react';
import { useWallet as useSolanaWallet } from '@solana/wallet-adapter-react';

// On-device MWA diagnostic panel (Phase 0). It does NOT change the connect flow —
// it only reports what the device sees so we can pinpoint the failing hop on the
// Seeker. Gated: only renders when the URL has ?mwadebug=1 (or localStorage
// "mwadebug" === "1"). Enable on the phone by appending ?mwadebug=1 to the URL.
function diagEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('mwadebug');
    if (q === '1') {
      window.localStorage.setItem('mwadebug', '1');
      return true;
    }
    if (q === '0') {
      window.localStorage.removeItem('mwadebug');
      return false;
    }
    return window.localStorage.getItem('mwadebug') === '1';
  } catch {
    return false;
  }
}

function detectEnv() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isAndroid = /android/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua);
  const isMobile = isAndroid || isIOS || /mobile/i.test(ua);
  // Android in-app WebViews carry "; wv" in the UA. iOS in-app webviews lack "Safari".
  const isWebView =
    (isAndroid && /;\s*wv\b/i.test(ua)) ||
    (isIOS && !/safari/i.test(ua));
  const inIframe = typeof window !== 'undefined' && window.self !== window.top;
  return { ua, isAndroid, isIOS, isMobile, isWebView, inIframe };
}

export function MwaDiagnostics() {
  const enabled = useMemo(diagEnabled, []);
  const { wallets, wallet, publicKey, connected, connecting, select, connect, signMessage } =
    useSolanaWallet();
  const [log, setLog] = useState<string[]>([]);
  const [minimized, setMinimized] = useState(false);
  const [, force] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);

  const append = (line: string) => {
    const t = new Date().toISOString().slice(11, 23);
    setLog((prev) => [...prev, `${t}  ${line}`]);
    // Fire-and-forget beacon so the phone's connect steps appear in the server
    // logs (its own console never reaches us). Dev-only endpoint; ignore failures.
    try {
      void fetch('/api/mwa-diag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          event: line,
          isSecureContext: typeof window !== 'undefined' ? window.isSecureContext : false,
          ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
        }),
      }).catch(() => {});
    } catch {
      // never let logging break the panel
    }
  };

  // Capture global errors / unhandled rejections so a thrown connect shows here.
  useEffect(() => {
    if (!enabled) return;
    const onErr = (e: ErrorEvent) => append(`window.error: ${e.message}`);
    const onRej = (e: PromiseRejectionEvent) =>
      append(`unhandledrejection: ${String((e as any).reason?.message || e.reason)}`);
    window.addEventListener('error', onErr);
    window.addEventListener('unhandledrejection', onRej);
    return () => {
      window.removeEventListener('error', onErr);
      window.removeEventListener('unhandledrejection', onRej);
    };
  }, [enabled]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // One-time mount beacon: confirms the page loaded on the device + environment.
  useEffect(() => {
    if (!enabled) return;
    const env = detectEnv();
    append(
      `PANEL MOUNTED secure=${typeof window !== 'undefined' ? window.isSecureContext : '?'} ` +
        `mobile=${env.isMobile} android=${env.isAndroid} webView=${env.isWebView} ` +
        `wallets=${wallets.length}`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  if (!enabled) return null;

  const env = detectEnv();

  const doConnect = async (name: string) => {
    try {
      append(`select("${name}")`);
      select(name as any);
      // wallet-adapter needs a tick to apply the selection before connect().
      await new Promise((r) => setTimeout(r, 50));
      append(`connect() …`);
      await connect();
      append(`connect() resolved`);
    } catch (e: any) {
      append(`connect ERROR: ${e?.name || ''} ${e?.message || String(e)}`);
    } finally {
      force((n) => n + 1);
    }
  };

  const doSign = async () => {
    try {
      if (!signMessage) {
        append('signMessage NOT available on this wallet');
        return;
      }
      append('signMessage("QuantumVault test") …');
      const sig = await signMessage(new TextEncoder().encode('QuantumVault MWA test'));
      append(`signMessage OK (${sig.length} bytes)`);
    } catch (e: any) {
      append(`signMessage ERROR: ${e?.name || ''} ${e?.message || String(e)}`);
    }
  };

  return (
    <div
      data-testid="mwa-diagnostics"
      style={{
        position: 'fixed',
        left: 8,
        right: 8,
        bottom: 8,
        zIndex: 99999,
        maxHeight: minimized ? 40 : '70vh',
        overflow: 'hidden',
        background: 'rgba(10,12,24,0.96)',
        color: '#dbe2ff',
        border: '1px solid #5b6cff',
        borderRadius: 10,
        fontSize: 11,
        fontFamily: 'monospace',
        boxShadow: '0 8px 40px rgba(0,0,0,0.6)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '6px 10px',
          borderBottom: minimized ? 'none' : '1px solid #2a3158',
          background: 'rgba(91,108,255,0.15)',
        }}
      >
        <strong>MWA Diagnostics</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            data-testid="button-mwa-diag-minimize"
            onClick={() => setMinimized((m) => !m)}
            style={btn}
          >
            {minimized ? 'expand' : 'min'}
          </button>
        </div>
      </div>

      {!minimized && (
        <div style={{ padding: 10, overflowY: 'auto', maxHeight: 'calc(70vh - 40px)' }}>
          <div style={{ marginBottom: 8, lineHeight: 1.5 }}>
            <Row k="isSecureContext" v={String(window.isSecureContext)} warn={!window.isSecureContext} />
            <Row k="origin" v={window.location.origin} />
            <Row k="mobile" v={String(env.isMobile)} />
            <Row k="android" v={String(env.isAndroid)} />
            <Row k="webView" v={String(env.isWebView)} warn={env.isWebView} />
            <Row k="inIframe" v={String(env.inIframe)} warn={env.inIframe} />
            <Row k="connected" v={String(connected)} />
            <Row k="connecting" v={String(connecting)} />
            <Row k="selected" v={wallet?.adapter?.name || '(none)'} />
            <Row k="publicKey" v={publicKey ? publicKey.toBase58() : '(none)'} />
            <div style={{ marginTop: 6, opacity: 0.8, wordBreak: 'break-all' }}>UA: {env.ua}</div>
          </div>

          <div style={{ marginBottom: 8 }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              Wallets detected: {wallets.length}
            </div>
            {wallets.length === 0 && (
              <div style={{ color: '#ff9a9a' }}>
                No wallets detected — MWA did not register / is not discoverable here.
              </div>
            )}
            {wallets.map((w) => (
              <div
                key={w.adapter.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '3px 0',
                }}
              >
                <span>
                  {w.adapter.name}{' '}
                  <span style={{ opacity: 0.7 }}>[{String(w.readyState)}]</span>
                </span>
                <button
                  data-testid={`button-mwa-connect-${w.adapter.name}`}
                  onClick={() => doConnect(w.adapter.name)}
                  style={btn}
                >
                  connect
                </button>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <button data-testid="button-mwa-sign" onClick={doSign} style={btn}>
              test signMessage
            </button>
            <button data-testid="button-mwa-clear" onClick={() => setLog([])} style={btn}>
              clear log
            </button>
          </div>

          <div
            ref={logRef}
            data-testid="text-mwa-log"
            style={{
              background: '#05070f',
              border: '1px solid #1c2244',
              borderRadius: 6,
              padding: 6,
              maxHeight: 180,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {log.length === 0 ? '(tap a wallet "connect" to begin)' : log.join('\n')}
          </div>
        </div>
      )}
    </div>
  );
}

const btn: React.CSSProperties = {
  background: '#5b6cff',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 11,
  fontFamily: 'monospace',
  cursor: 'pointer',
};

function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ opacity: 0.7, minWidth: 110 }}>{k}</span>
      <span style={{ color: warn ? '#ffce6b' : '#dbe2ff', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}

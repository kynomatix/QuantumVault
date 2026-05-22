import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// Telegram Mini App (Task #136)
//
// Read-only Mini App mounted at /tg, authenticated via Telegram's WebApp
// `initData` HMAC. The page is intentionally self-contained: it does NOT use
// the main app's shadcn shell, WalletProvider, or queryClient defaults, so
// network calls always carry the Authorization: tma <initData> header.
// ---------------------------------------------------------------------------

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        initData: string;
        ready: () => void;
        expand: () => void;
        themeParams?: Record<string, string>;
        colorScheme?: "light" | "dark";
        BackButton?: { hide: () => void };
      };
    };
  }
}

const TELEGRAM_SCRIPT_SRC = "https://telegram.org/js/telegram-web-app.js";

function loadTelegramScript(): Promise<void> {
  return new Promise((resolve) => {
    if (window.Telegram?.WebApp) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TELEGRAM_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = TELEGRAM_SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}

function applyTheme(themeParams?: Record<string, string>) {
  if (!themeParams) return;
  const root = document.documentElement;
  const map: Record<string, string> = {
    bg_color: "--tg-bg",
    secondary_bg_color: "--tg-bg-2",
    text_color: "--tg-text",
    hint_color: "--tg-hint",
    link_color: "--tg-link",
    button_color: "--tg-button",
    button_text_color: "--tg-button-text",
  };
  for (const [k, css] of Object.entries(map)) {
    const v = themeParams[k];
    if (v) root.style.setProperty(css, v);
  }
}

function fmtUsd(n: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const str = abs >= 1000
    ? abs.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : abs.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const sign = n < 0 ? "-" : opts.sign ? "+" : "";
  return `${sign}$${str}`;
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtNum(n: number | null | undefined, digits = 4): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function pnlClass(n: number): string {
  if (n > 0.0001) return "text-emerald-400";
  if (n < -0.0001) return "text-rose-400";
  return "text-[color:var(--tg-hint)]";
}

type Tab = "overview" | "positions" | "bots" | "today";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "positions", label: "Positions" },
  { id: "bots", label: "Bots" },
  { id: "today", label: "Today" },
];

interface OverviewResponse {
  wallets: Array<{
    walletAddress: string;
    walletShort: string;
    totalEquity: number | null;
    pnl24h: number;
    pnl24hPercent: number;
    tradesLast24h: number;
    winning24h: number;
    losing24h: number;
    openPositionCount: number;
  }>;
  totals: {
    totalEquity: number | null;
    pnl24h: number;
    tradesLast24h: number;
    openPositionCount: number;
  };
}

interface PositionsResponse {
  wallets: Array<{
    walletAddress: string;
    walletShort: string;
    positions: Array<{
      botName: string;
      market: string;
      side: "LONG" | "SHORT";
      size: number;
      entryPrice: number;
      markPrice: number;
      unrealizedPnl: number;
    }>;
  }>;
}

interface BotsResponse {
  bots: Array<{
    id: string;
    name: string;
    market: string;
    side: string;
    leverage: number;
    status: "running" | "paused";
    pauseReason: string | null;
    totalPnl: number;
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    lastTradeAt: string | null;
    openPosition: PositionsResponse["wallets"][number]["positions"][number] | null;
  }>;
}

interface TodayResponse {
  wallets: Array<{
    walletAddress: string;
    walletShort: string;
    tradesToday: number;
    realizedPnlToday: number;
    winning: number;
    losing: number;
  }>;
  totals: { tradesToday: number; realizedPnlToday: number; winning: number; losing: number };
}

function useTgFetch<T>(path: string, initData: string | null, enabled: boolean) {
  return useQuery<T>({
    queryKey: ["tg", path, initData],
    enabled: enabled && !!initData,
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await fetch(path, {
        headers: { Authorization: `tma ${initData}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || `Request failed (${res.status})`);
      }
      return res.json() as Promise<T>;
    },
  });
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded bg-white/5 ${className}`} />;
}

function Card({ children, testid }: { children: React.ReactNode; testid?: string }) {
  return (
    <div
      className="rounded-xl border border-white/10 bg-[color:var(--tg-bg-2)] p-4 shadow-sm"
      data-testid={testid}
    >
      {children}
    </div>
  );
}

function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200" data-testid="error-banner">
      <div className="font-medium">Couldn't load</div>
      <div className="mt-1 opacity-80">{message}</div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-3 rounded bg-rose-500/20 px-3 py-1 text-xs hover:bg-rose-500/30"
          data-testid="button-retry"
        >
          Retry
        </button>
      )}
    </div>
  );
}

function OverviewTab({ initData }: { initData: string }) {
  const q = useTgFetch<OverviewResponse>("/api/tg/overview", initData, true);
  if (q.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }
  if (q.error) return <ErrorBanner message={(q.error as Error).message} onRetry={() => q.refetch()} />;
  const data = q.data!;
  return (
    <div className="space-y-3">
      <Card testid="card-totals">
        <div className="text-xs uppercase tracking-wide text-[color:var(--tg-hint)]">Total equity</div>
        <div className="mt-1 text-3xl font-semibold" data-testid="text-total-equity">
          {fmtUsd(data.totals.totalEquity)}
        </div>
        <div className="mt-3 flex items-center gap-4 text-sm">
          <div>
            <div className="text-[color:var(--tg-hint)]">24h PnL</div>
            <div className={`font-medium ${pnlClass(data.totals.pnl24h)}`} data-testid="text-pnl-24h">
              {fmtUsd(data.totals.pnl24h, { sign: true })}
            </div>
          </div>
          <div>
            <div className="text-[color:var(--tg-hint)]">24h trades</div>
            <div className="font-medium" data-testid="text-trades-24h">{data.totals.tradesLast24h}</div>
          </div>
          <div>
            <div className="text-[color:var(--tg-hint)]">Open</div>
            <div className="font-medium" data-testid="text-open-count">{data.totals.openPositionCount}</div>
          </div>
        </div>
      </Card>
      {data.wallets.length > 1 && (
        <div className="space-y-2">
          <div className="px-1 text-xs uppercase tracking-wide text-[color:var(--tg-hint)]">By wallet</div>
          {data.wallets.map(w => (
            <Card key={w.walletAddress} testid={`card-wallet-${w.walletAddress}`}>
              <div className="flex items-center justify-between">
                <div className="font-mono text-sm" data-testid={`text-wallet-${w.walletAddress}`}>{w.walletShort}</div>
                <div className={`text-sm font-medium ${pnlClass(w.pnl24h)}`}>
                  {fmtUsd(w.pnl24h, { sign: true })} ({fmtPct(w.pnl24hPercent)})
                </div>
              </div>
              <div className="mt-2 flex justify-between text-xs text-[color:var(--tg-hint)]">
                <span>Equity {fmtUsd(w.totalEquity)}</span>
                <span>{w.tradesLast24h} trades · {w.openPositionCount} open</span>
              </div>
            </Card>
          ))}
        </div>
      )}
      {data.wallets.length === 0 && (
        <Card><div className="text-sm text-[color:var(--tg-hint)]">No wallet data yet.</div></Card>
      )}
    </div>
  );
}

function PositionsTab({ initData }: { initData: string }) {
  const q = useTgFetch<PositionsResponse>("/api/tg/positions", initData, true);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.error) return <ErrorBanner message={(q.error as Error).message} onRetry={() => q.refetch()} />;
  const data = q.data!;
  const all = data.wallets.flatMap(w => w.positions.map(p => ({ ...p, walletShort: w.walletShort, walletAddress: w.walletAddress })));
  if (all.length === 0) {
    return <Card><div className="text-sm text-[color:var(--tg-hint)]" data-testid="text-no-positions">No open positions.</div></Card>;
  }
  return (
    <div className="space-y-2">
      {all.map((p, i) => (
        <Card key={`${p.walletAddress}-${i}`} testid={`card-position-${p.market}-${i}`}>
          <div className="flex items-start justify-between">
            <div>
              <div className="text-sm font-medium" data-testid={`text-position-market-${i}`}>
                {p.market}{" "}
                <span className={p.side === "LONG" ? "text-emerald-400" : "text-rose-400"}>
                  {p.side}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-[color:var(--tg-hint)]">{p.botName} · {p.walletShort}</div>
            </div>
            <div className={`text-right text-sm font-medium ${pnlClass(p.unrealizedPnl)}`} data-testid={`text-position-pnl-${i}`}>
              {fmtUsd(p.unrealizedPnl, { sign: true })}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
            <div>
              <div className="text-[color:var(--tg-hint)]">Size</div>
              <div>{fmtNum(p.size)}</div>
            </div>
            <div>
              <div className="text-[color:var(--tg-hint)]">Entry</div>
              <div>{fmtUsd(p.entryPrice)}</div>
            </div>
            <div>
              <div className="text-[color:var(--tg-hint)]">Mark</div>
              <div>{fmtUsd(p.markPrice)}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function BotsTab({ initData }: { initData: string }) {
  const q = useTgFetch<BotsResponse>("/api/tg/bots", initData, true);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.error) return <ErrorBanner message={(q.error as Error).message} onRetry={() => q.refetch()} />;
  const bots = q.data?.bots ?? [];
  if (bots.length === 0) {
    return <Card><div className="text-sm text-[color:var(--tg-hint)]" data-testid="text-no-bots">No bots deployed yet.</div></Card>;
  }
  return (
    <div className="space-y-2">
      {bots.map(b => {
        const wr = b.totalTrades > 0 ? (b.winningTrades / b.totalTrades) * 100 : null;
        return (
          <Card key={b.id} testid={`card-bot-${b.id}`}>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-sm font-medium" data-testid={`text-bot-name-${b.id}`}>{b.name}</div>
                <div className="mt-0.5 text-xs text-[color:var(--tg-hint)]">
                  {b.market} · {b.side} · {b.leverage}x
                </div>
              </div>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  b.status === "running"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-amber-500/20 text-amber-300"
                }`}
                data-testid={`status-bot-${b.id}`}
              >
                {b.status === "running" ? "Running" : "Paused"}
              </span>
            </div>
            {b.status === "paused" && b.pauseReason && (
              <div className="mt-2 text-xs text-amber-300/80">⏸ {b.pauseReason}</div>
            )}
            <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[color:var(--tg-hint)]">PnL</div>
                <div className={pnlClass(b.totalPnl)}>{fmtUsd(b.totalPnl, { sign: true })}</div>
              </div>
              <div>
                <div className="text-[color:var(--tg-hint)]">Trades</div>
                <div>{b.totalTrades}</div>
              </div>
              <div>
                <div className="text-[color:var(--tg-hint)]">Win rate</div>
                <div>{wr == null ? "—" : `${wr.toFixed(0)}%`}</div>
              </div>
            </div>
            {b.openPosition && (
              <div className="mt-3 rounded-lg border border-white/10 bg-white/5 p-2 text-xs">
                <div className="flex justify-between">
                  <span>
                    Open {b.openPosition.side} · {fmtNum(b.openPosition.size)} @ {fmtUsd(b.openPosition.entryPrice)}
                  </span>
                  <span className={pnlClass(b.openPosition.unrealizedPnl)}>
                    {fmtUsd(b.openPosition.unrealizedPnl, { sign: true })}
                  </span>
                </div>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function TodayTab({ initData }: { initData: string }) {
  const q = useTgFetch<TodayResponse>("/api/tg/today", initData, true);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (q.error) return <ErrorBanner message={(q.error as Error).message} onRetry={() => q.refetch()} />;
  const data = q.data!;
  return (
    <div className="space-y-3">
      <Card testid="card-today-totals">
        <div className="text-xs uppercase tracking-wide text-[color:var(--tg-hint)]">Today</div>
        <div className="mt-1 flex items-baseline gap-3">
          <div className={`text-3xl font-semibold ${pnlClass(data.totals.realizedPnlToday)}`} data-testid="text-today-pnl">
            {fmtUsd(data.totals.realizedPnlToday, { sign: true })}
          </div>
          <div className="text-xs text-[color:var(--tg-hint)]">realized</div>
        </div>
        <div className="mt-3 flex gap-4 text-sm">
          <div>
            <div className="text-[color:var(--tg-hint)]">Trades</div>
            <div className="font-medium" data-testid="text-today-trades">{data.totals.tradesToday}</div>
          </div>
          <div>
            <div className="text-[color:var(--tg-hint)]">Win / Loss</div>
            <div className="font-medium">
              <span className="text-emerald-400">{data.totals.winning}</span>
              {" / "}
              <span className="text-rose-400">{data.totals.losing}</span>
            </div>
          </div>
        </div>
      </Card>
      {data.wallets.length > 1 && (
        <div className="space-y-2">
          {data.wallets.map(w => (
            <Card key={w.walletAddress} testid={`card-today-wallet-${w.walletAddress}`}>
              <div className="flex items-center justify-between">
                <div className="font-mono text-sm">{w.walletShort}</div>
                <div className={`text-sm font-medium ${pnlClass(w.realizedPnlToday)}`}>
                  {fmtUsd(w.realizedPnlToday, { sign: true })}
                </div>
              </div>
              <div className="mt-1 text-xs text-[color:var(--tg-hint)]">
                {w.tradesToday} trades · {w.winning}W / {w.losing}L
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TelegramMiniApp() {
  const [ready, setReady] = useState(false);
  const [initData, setInitData] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    let mounted = true;
    (async () => {
      await loadTelegramScript();
      if (!mounted) return;
      const wa = window.Telegram?.WebApp;
      if (!wa) {
        setBootError("Telegram WebApp script could not be loaded. Open this page from inside Telegram.");
        setReady(true);
        return;
      }
      try {
        wa.ready();
        wa.expand();
        applyTheme(wa.themeParams);
        wa.BackButton?.hide();
      } catch {
        // best-effort
      }
      const id = wa.initData;
      if (!id) {
        setBootError("Missing Telegram initData. Open this page via the Mini App button in the bot.");
      } else {
        setInitData(id);
      }
      setReady(true);
    })();
    return () => { mounted = false; };
  }, []);

  const themeStyle = useMemo<React.CSSProperties>(() => ({
    minHeight: "100vh",
    background: "var(--tg-bg, #17212b)",
    color: "var(--tg-text, #ffffff)",
  }), []);

  return (
    <div style={themeStyle} data-testid="page-telegram-mini-app">
      <style>{`
        :root {
          --tg-bg: #17212b;
          --tg-bg-2: #1f2c38;
          --tg-text: #ffffff;
          --tg-hint: #8b9aa9;
          --tg-link: #62bcf9;
          --tg-button: #5288c1;
          --tg-button-text: #ffffff;
        }
      `}</style>
      <header className="sticky top-0 z-10 border-b border-white/10 bg-[color:var(--tg-bg)]/95 px-4 py-3 backdrop-blur">
        <div className="text-base font-semibold">QuantumVault</div>
        <div className="text-xs text-[color:var(--tg-hint)]">Read-only dashboard</div>
        <nav className="mt-3 flex gap-1" role="tablist">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                tab === t.id
                  ? "bg-[color:var(--tg-button)] text-[color:var(--tg-button-text)]"
                  : "bg-white/5 text-[color:var(--tg-hint)] hover:bg-white/10"
              }`}
              data-testid={`tab-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="px-4 py-3 pb-8">
        {!ready ? (
          <Skeleton className="h-32" />
        ) : bootError ? (
          <ErrorBanner message={bootError} />
        ) : initData ? (
          <>
            {tab === "overview" && <OverviewTab initData={initData} />}
            {tab === "positions" && <PositionsTab initData={initData} />}
            {tab === "bots" && <BotsTab initData={initData} />}
            {tab === "today" && <TodayTab initData={initData} />}
          </>
        ) : null}
      </main>
    </div>
  );
}

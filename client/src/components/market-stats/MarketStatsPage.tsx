import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, TrendingUp, Users, BarChart3, Shield, Bitcoin } from 'lucide-react';
import type { MarketStats, StatsCard, DowStats } from '@shared/market-stats';
import { walletAuthHeaders, getActiveWalletAddress } from '@/lib/queryClient';
import { currentCard, signedPercent, usd, utcTime } from './format';

function Frame({ title, period, icon, children, footer }: {
  title: string; period: string; icon: ReactNode; children: ReactNode; footer?: ReactNode;
}) {
  return <article aria-label={title} className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card flex flex-col">
    <div className="flex-1 p-5 sm:p-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</h2>
        <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">{period}</span>
      </div>{children}
    </div>
    {footer && <footer className="flex flex-wrap justify-between gap-x-4 gap-y-1 border-t border-border/60 bg-background/20 px-5 py-3 text-[10px] leading-relaxed text-muted-foreground sm:px-6">{footer}</footer>}
  </article>;
}
function Missing({ reason }: { reason: string }) {
  return <div role="status" className="py-5"><p className="text-lg font-semibold text-muted-foreground">Unavailable</p>
    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{reason}</p></div>;
}
function Provenance({ card }: { card: StatsCard<unknown> }) {
  return <><span>{card.asOf !== null ? <>{card.status === 'available' ? 'As of' : 'Last available'} <time dateTime={new Date(card.asOf).toISOString()}>{utcTime(card.asOf)}</time></> : 'No verified observation'}</span>
    <span title={card.basis}>Source: {card.source}</span></>;
}
function Structure({ label, card }: { label: string; card: StatsCard<DowStats> }) {
  const trend = card.status === 'available' ? card.value.trend : null;
  return <div className="border-t border-border/60 py-4 first:border-0 first:pt-0 last:pb-0">
    <div className="mb-2 flex items-center justify-between gap-3"><h3 className="text-sm font-medium">{label}</h3>
      {trend && <span className={`text-sm font-semibold ${trend === 'uptrend' ? 'text-emerald-400' : trend === 'downtrend' ? 'text-rose-400' : 'text-amber-300'}`}>
        {trend === 'uptrend' ? '↗ Uptrend' : trend === 'downtrend' ? '↘ Downtrend' : '↔ Mixed'}</span>}</div>
    {card.status === 'available' ? <>
      <p className="text-xs text-muted-foreground">{trend === 'uptrend' ? 'Higher highs and higher lows — a rising trend.' : trend === 'downtrend' ? 'Lower highs and lower lows — a falling trend.' : 'Highs and lows disagree — no clear trend.'}</p>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">As of {utcTime(card.asOf)} · Last confirmed turn: {utcTime(card.value.lastPivotAt)}</p>
    </> : <><Missing reason={card.reason} />{card.asOf !== null && <p className="text-[10px] text-muted-foreground">Last available: {utcTime(card.asOf)}</p>}</>}
  </div>;
}
function Index({ label, detail, value, purple = false }: { label: string; detail: string; value: number; purple?: boolean }) {
  return <div className="mt-5">
    <div className="mb-2 flex items-end justify-between gap-3"><div><h3 className="text-sm font-medium">{label}</h3><p className="mt-0.5 text-[10px] text-muted-foreground">{detail}</p></div>
      <span className={`text-2xl font-semibold tabular-nums ${purple ? 'text-violet-400' : 'text-emerald-400'}`}>{value.toFixed(0)}</span></div>
    <div role="meter" aria-label={`${label} positioning index`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className="h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${purple ? 'bg-violet-400' : 'bg-emerald-400'}`} style={{ width: `${value}%` }} /></div>
  </div>;
}

export function MarketStatsView({ data, now }: { data: MarketStats; now: number }) {
  const cycle = currentCard(data.cycle, now), cot = currentCard(data.cot, now), funding = currentCard(data.funding, now);
  const weekly = currentCard(data.dow.weekly, now), daily = currentCard(data.dow.daily, now);
  const iconClass = 'h-4 w-4 text-muted-foreground';
  return <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
    <Frame title="BTC market cycle" period="Weekly" icon={<TrendingUp className={iconClass} />} footer={<Provenance card={cycle} />}>
      {cycle.status === 'available' ? <>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className={`text-4xl font-semibold tracking-tight ${cycle.value.regime === 'bull' ? 'text-emerald-400' : 'text-rose-400'}`}>{cycle.value.regime === 'bull' ? '↗ Bull' : '↘ Bear'}</p>
          <div className="text-right"><p className="text-xl font-semibold tabular-nums">{signedPercent(cycle.value.distancePercent)}</p><p className="mt-1 text-[10px] text-muted-foreground">{cycle.value.regime === 'bull' ? 'above' : 'below'} the average</p></div>
        </div>
        <p className="mt-5 text-sm leading-relaxed text-muted-foreground">Last week’s close is {cycle.value.regime === 'bull' ? 'above' : 'below'} its 50-week average.<br />The average smooths out Bitcoin’s longer-term direction.</p>
        <dl className="mt-6 grid grid-cols-2 gap-3 rounded-xl border border-border/60 bg-background/30 p-4">
          <div><dt className="text-[10px] text-muted-foreground">Last completed week’s close</dt><dd className="mt-2 text-lg font-semibold tabular-nums">{usd(cycle.value.lastClose)}</dd></div>
          <div><dt className="text-[10px] text-muted-foreground">50-week simple average</dt><dd className="mt-2 text-lg font-semibold tabular-nums">{usd(cycle.value.movingAverage)}</dd></div>
        </dl>
      </> : <Missing reason={cycle.reason} />}
    </Frame>
    <Frame title="Price structure" period="Weekly + daily" icon={<Activity className={iconClass} />}
      footer={<><span>Dow structure follows confirmed price highs and lows; confirmation lags by three bars.</span><span>Source: {daily.source}</span></>}>
      <Structure label="Weekly" card={weekly} /><Structure label="Daily" card={daily} />
    </Frame>
    <Frame title="Futures positioning" period="Weekly COT" icon={<Users className={iconClass} />} footer={<Provenance card={cot} />}>
      {cot.status === 'available' ? <>
        <p className="text-xs leading-relaxed text-muted-foreground">Commitment of Traders: a weekly report of who holds futures.</p>
        <Index label="Smart" detail="Commercial hedgers" value={cot.value.smartIndex} />
        <Index label="Retail / speculators" detail="Large + small traders; not pure retail" value={cot.value.speculatorIndex} purple />
        <div className="mt-5 rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs">
          <p className="font-medium">Latest flip in stored history</p><p className="mt-1.5 text-muted-foreground">{cot.value.latestFlip
            ? <>Smart crossed {cot.value.latestFlip.state === 'bullish_flip' ? 'above' : 'below'} speculators · {cot.value.latestFlip.reportDate}</>
            : 'No flip in stored history'}</p>
        </div>
        <p className="mt-4 text-[10px] leading-relaxed text-muted-foreground">Each index: 0–100 within its own 120-report range, not a probability.</p>
      </> : <Missing reason={cot.reason} />}
    </Frame>
    <Frame title="Funding & open positions" period="Hourly snapshot" icon={<BarChart3 className={iconClass} />} footer={<Provenance card={funding} />}>
      {funding.status === 'available' ? <>
        <p className="text-xs leading-relaxed text-muted-foreground">Estimated daily funding cost: rate × 24, if the rate stays the same</p>
        <p className="mt-3 text-4xl font-semibold tracking-tight tabular-nums">{signedPercent(funding.value.estimatedDailyPercent, 3)}<span className="ml-2 text-xs font-normal text-muted-foreground">/ day</span></p>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{funding.value.hourlyRate > 0 ? 'Longs pay shorts.' : funding.value.hourlyRate < 0 ? 'Shorts pay longs.' : 'No funding payment at this rate.'}<br />Funding is the payment between the two sides of a contract.</p>
        <div className="mt-6 flex flex-wrap items-end justify-between gap-3 border-t border-border/60 pt-5"><div><h3 className="text-sm font-medium">Open interest</h3><p className="mt-1 text-[10px] text-muted-foreground">Amount in open contracts</p></div>
          <p className="text-2xl font-semibold tabular-nums">{funding.value.openInterestBtc.toLocaleString('en-US', { maximumFractionDigits: 2 })} <span className="text-xs font-normal text-muted-foreground">BTC</span></p></div>
        <p className="mt-5 text-[10px] leading-relaxed text-muted-foreground">Captured at most once per hour. This projects the captured hourly rate; it is not a realized daily rate.</p>
      </> : <Missing reason={funding.reason} />}
    </Frame>
  </div>;
}

export default function MarketStatsPage({ active }: { active: boolean }) {
  const query = useQuery<MarketStats>({
    queryKey: ['/api/market-stats', getActiveWalletAddress()], enabled: active,
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/market-stats', { credentials: 'include', headers: walletAuthHeaders(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(27_000)]) });
      if (!response.ok) throw new Error('Market Stats could not be loaded. Reopen the page to try again.');
      return await response.json();
    },
    staleTime: query => query.state.data ? Math.max(0, query.state.data.expiresAt - query.state.data.serverNow) : 0,
    refetchOnMount: true, refetchOnWindowFocus: true, refetchInterval: false, retry: false,
  });
  const [clock, setClock] = useState(Date.now);
  // Only hide expired observations. This schedules no requests and is not a polling loop.
  useEffect(() => {
    setClock(Date.now());
    const focus = () => setClock(Date.now());
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [query.dataUpdatedAt]);
  const serverClock = query.data ? query.data.serverNow + Math.max(0, clock - query.dataUpdatedAt) : clock;
  useEffect(() => {
    if (!active || !query.data) return;
    const future = [query.data.cycle, query.data.dow.daily, query.data.dow.weekly, query.data.cot, query.data.funding]
      .map(card => card.expiresAt).filter(expiry => expiry > serverClock);
    if (!future.length) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.min(...future) - serverClock + 1);
    return () => clearTimeout(timer);
  }, [active, query.data, serverClock]);
  return <section aria-label="Market Stats" className="max-w-6xl space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-4"><div>
      <h1 className="font-display text-2xl font-bold sm:text-3xl">Market Stats</h1><p className="mt-2 text-sm text-muted-foreground">Bitcoin’s bigger picture, in plain words.</p></div>
      <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-2 text-xs text-muted-foreground"><Bitcoin className="h-4 w-4 text-amber-400" />Bitcoin<span className="mx-1 text-border">/</span>Daily & weekly</div>
    </div>
    {query.isError && <p role="alert" className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">{query.error.message}</p>}
    {query.data ? <MarketStatsView data={query.data} now={serverClock} /> : query.isPending ? <div role="status" aria-label="Loading Market Stats" className="grid gap-5 xl:grid-cols-2">
      {[0, 1, 2, 3].map(i => <div key={i} className="h-72 animate-pulse rounded-2xl border border-border bg-card" />)}<span className="sr-only">Loading Market Stats</span>
    </div> : <Missing reason="No verified market observations are available." />}
    <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><Shield className="h-4 w-4 shrink-0" />Context for your decisions. This page never changes your bots or trading.</p>
  </section>;
}

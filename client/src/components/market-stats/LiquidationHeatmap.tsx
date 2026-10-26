import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Layers } from 'lucide-react';
import type { LiquidationCluster, LiquidationCoverageReason, LiquidationStatsResponse } from '@shared/market-stats';
import { getActiveWalletAddress, walletAuthHeaders } from '@/lib/queryClient';
import LiquidationHeatmapChart from './LiquidationHeatmapChart';

const omissionReasons: Record<LiquidationCoverageReason, string> = {
  disabled: 'source unavailable', deadline: 'source timed out', http: 'source request failed',
  malformed: 'data failed checks', empty: 'no recent data', stale: 'data too old',
  'baseline-only': 'not enough consecutive observations',
};
const money = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const compact = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(n);
function Cluster({ side, cluster }: { side: 'above' | 'below'; cluster: LiquidationCluster | null }) {
  return <div className="rounded-xl border border-border/80 bg-background/40 p-4">
    <p className="text-xs leading-relaxed text-muted-foreground">Largest estimated cluster {side} price:</p>
    {cluster ? <><p className={`mt-2 text-2xl font-semibold tracking-tight ${side === 'above' ? 'text-amber-200' : 'text-emerald-300'}`}>{money((cluster.lower + cluster.upper) / 2)}</p>
      <p className="mt-1 text-xs text-muted-foreground">(about {compact(cluster.notionalUsd)}) · {cluster.side === 'both' ? 'longs and shorts' : `${cluster.side}s`}</p></>
      : <p className="mt-2 text-sm text-muted-foreground">No modelled exposure in range</p>}
  </div>;
}
export function LiquidationHeatmapView({ card, now }: { card: LiquidationStatsResponse; now: number }) {
  const value = card.status === 'available' && now < card.expiresAt ? card.value : null;
  const venueNames = { okx: 'OKX', binance: 'Binance', bybit: 'Bybit', hyperliquid: 'Hyperliquid' };
  const sources = (card.coverage?.venuesUsed ?? ['okx' as const]).map(v => venueNames[v]).join(' + ');
  const method = card.status === 'available' ? card.value.methodologyVersion : 'oi-leverage-v2';
  const utc = (time: number) => new Date(time).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  return <article aria-label="Estimated liquidation zones" className="min-w-0 max-w-full overflow-hidden rounded-2xl border border-border/70 bg-card">
    <div className="p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div>
        <h2 className="flex items-center gap-2 text-base font-semibold"><Layers className="h-4 w-4 text-violet-400" />Estimated liquidation zones</h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Bitcoin · modelled open interest · updated daily</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Sources: {sources}</p>
      </div><span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">Monthly</span></div>
      {value ? <>
        <div className="my-5 grid gap-3 sm:grid-cols-2"><Cluster side="above" cluster={value.summary.above} /><Cluster side="below" cluster={value.summary.below} /></div>
        <p className="mb-5 text-xs leading-relaxed text-muted-foreground">Price often moves towards these pools, but it may pass through them or reverse.</p>
        <LiquidationHeatmapChart data={value} />
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">As of {utc(card.asOf!)} · Range ±25% of last close · Outside range: {compact(value.excludedUsd)} modelled exposure.</p>
      </> : <div role="status" className="my-6 rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
        <p className="font-semibold">Unavailable</p><p className="mt-2 leading-relaxed">{card.status === 'unavailable' ? card.reason : 'The last modelled observation is older than 26 hours.'}</p>
        {card.gaps.length > 0 && <p className="mt-2 text-xs">First missing observations: {card.gaps.slice(0, 3).map(g => `${g.input} at ${new Date(g.time).toISOString().slice(0, 16)} UTC`).join('; ')}. Gaps are not filled.</p>}
      </div>}
      <details className="mt-4 text-xs leading-relaxed text-muted-foreground"><summary className="w-fit cursor-pointer text-violet-300">What this covers</summary>
        <div className="mt-3 space-y-2">
          <p>Method {method} is a model, not real positions and not a forecast. It uses hourly BTC open-interest changes from the sources above. All entries, price sweeps and notionals use OKX BTC-USDT-SWAP candles; other venues may trade at different prices. USDT prices and notionals are shown as USD equivalents, assuming 1 USDT = 1 USD.</p>
          {card.coverage?.venues.filter(v => v.status === 'included').map(v => <p key={v.venue}>
            {venueNames[v.venue]}: observations from {utc(v.firstObservation!)} to {utc(v.lastObservation!)}; {v.gapHours} missing {v.gapHours === 1 ? 'hour' : 'hours'}
            {v.gaps.length > 0 && ` (${v.gaps.slice(0, 2).map(g => g.start === g.end ? utc(g.start) : `${utc(g.start)} to ${utc(g.end)}`).join('; ')}${v.gaps.length > 2 ? '; more gaps' : ''})`}.
            {(v.skippedRows ?? 0) > 0 && ` ${v.skippedRows} ${v.skippedRows === 1 ? 'hour' : 'hours'} skipped after failing checks.`}
            {v.terminalLagHours > 0 && ` Prices continue through the last ${v.terminalLagHours} hours without new open-interest changes.`}
          </p>)}
          {card.coverage?.venues.filter(v => v.status === 'omitted').map(v => <p key={v.venue}>
            {venueNames[v.venue]}: left out ({v.reason ? omissionReasons[v.reason] : 'no usable recent data'}).
          </p>)}
          {card.coverage?.venues.some(v => v.status === 'omitted') && <p>Some venues have no usable recent observations and are left out of this snapshot.</p>}
          {method === 'oi-leverage-v3' && <p>Coverage changes over time; this is not a continuous four-venue history. A venue starts empty at its first observation. Missing interior hours clear only that venue’s positions; the next observation starts a new baseline. Zero bands mean no modelled exposure from observed books, not measured zero open interest at missing venues.</p>}
          <p>Each rise in open interest adds that many BTC at (high + low + close) / 3, with an assumed 50/50 long/short split. Assumed leverage weights: 5x 10%, 10x 30%, 25x 30%, 50x 20%, 100x 10%. Maintenance margin is fixed at 0.5%.</p>
          <p>Long liquidation = entry × (1 − 1 / leverage + 0.005); short = entry × (1 + 1 / leverage − 0.005). These simplified thresholds omit fees, cross margin and venue risk tiers.</p>
          <p>Falling venue open interest scales each live cohort by new OI / previous OI, clamped to 0–1. This assumes closes are spread across all open positions, including the unknown starting book. After entries or closes, the hour’s low sweeps longs and its high sweeps shorts, including new entries in that hour. Bands stop at the first crossing; within-hour ordering is unknown.</p>
          <p>Exposure is calculated hourly. Each 4-hour column shows the last hourly state, never a sum; bands therefore end at 4-hour display resolution. The initial position book is unknown and omitted. The model starts empty 38 days back, with 8 warm-up days before the 30-day view. Earlier surviving positions cannot be reconstructed.</p>
          <p>Notional is remaining BTC × that hour’s close, rounded to USD after adding the venue books. The colour scale is shared across this month and may change after a daily rebuild. The reference line is the last completed close, not a live quote. Missing required OKX hourly inputs make this section unavailable.</p>
        </div>
      </details>
    </div>
    <footer className="border-t border-border/60 bg-background/20 px-5 py-3 text-[10px] leading-relaxed text-muted-foreground sm:px-6">Method: {method} · Daily refresh on request · Hypothetical exposure only</footer>
  </article>;
}
export default function LiquidationHeatmap() {
  const query = useQuery<LiquidationStatsResponse>({
    queryKey: ['/api/market-stats/liquidations', getActiveWalletAddress()],
    queryFn: async ({ signal }) => {
      const response = await fetch('/api/market-stats/liquidations', { credentials: 'include', headers: walletAuthHeaders(), signal: AbortSignal.any([signal, AbortSignal.timeout(27_000)]) });
      if (!response.ok) throw new Error('The modelled liquidation history could not be loaded.');
      return response.json();
    },
    staleTime: q => q.state.data ? Math.max(0, Math.min(q.state.data.expiresAt, (Math.floor(q.state.data.serverNow / 86_400_000) + 1) * 86_400_000) - q.state.data.serverNow) : 0,
    refetchOnMount: true, refetchOnWindowFocus: true, refetchInterval: false, retry: false,
  });
  const [clock, setClock] = useState(Date.now);
  useEffect(() => {
    setClock(Date.now());
    const focus = () => setClock(Date.now()); window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [query.dataUpdatedAt]);
  const now = query.data ? query.data.serverNow + Math.max(0, clock - query.dataUpdatedAt) : clock;
  // A single UI expiry wake-up hides stale data; it never initiates a request.
  useEffect(() => {
    if (!query.data || query.data.expiresAt <= now) return;
    const timeout = setTimeout(() => setClock(Date.now()), query.data.expiresAt - now + 1);
    return () => clearTimeout(timeout);
  }, [query.data, now]);
  if (query.data) return <LiquidationHeatmapView card={query.data} now={now} />;
  if (query.isPending) return <div role="status" className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">Loading estimated liquidation zones…</div>;
  return <LiquidationHeatmapView now={now} card={{ status: 'unavailable', value: null, reason: query.error?.message || 'No verified hourly inputs are available.',
    source: 'OKX BTC-USDT-SWAP', basis: 'oi-leverage-v2', asOf: null, fetchedAt: null, expiresAt: now, serverNow: now, gaps: [] }} />;
}

import { useEffect, useRef, useState } from 'react';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';
import { createSharedTradePriceChart } from './SharedTradePriceChart';
import { earlierChartWindow, mergeNeutralBands } from './signalTradeHistoryWindow';
import { attachTradeBoxes, formatTradePnl as formatPnl, tradeChartMarkers, tradeEntryDirection, type SequentialTradePair } from './signalTradeChartMarkers';
import type { UTCTimestamp } from 'lightweight-charts';
import { BarChart3, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { deriveAiTraderChartPriceFormat } from '@/lib/ai-trader-position-display';

type Execution = { id: string; status: string; side: string; protocol: string | null; protocolMismatch: boolean; kind: string; exactTime: string; displayBarTime: string | null; price: number; size: number; coordinateBasis: string; netPnl: number | null; accountingStatus: string; feeTruthStatus: string; pairingStatus: string; pair?: SequentialTradePair };
type Band = { barTime: string; rowIds: string[]; pairingStatus: 'unproven' };
const NEUTRAL_SPAN = 'rgba(100,116,139,0.25)';
type ChartResponse = {
  market: string; timeframe: string; range: { from: string; to: string; firstEligibleTradeAt: string | null };
  complete: boolean; nextCursor: string | null;
  price: { availability: string; reason: string | null; basisLabel: string; candles: Array<{ time: number; open: number; high: number; low: number; close: number }> };
  executions: Execution[]; bands: Band[]; pairs: SequentialTradePair[];
  totals: { totalTrades: number; winningTrades: number; losingTrades: number; accountingIncompleteTrades: number };
  openPosition: { size: number | null; entryPrice: number | null; attribution: string; unrealizedPnl: null } | null;
};
const DAY = 86_400_000;
export function SignalTradeHistoryChart({ botId }: { botId: string }) {
  return <Dialog>
    <DialogTrigger asChild>
      <Button type="button" size="sm" variant="outline"><BarChart3 className="w-4 h-4" />View chart</Button>
    </DialogTrigger>
    <DialogContent className="w-[95vw] sm:max-w-[min(1400px,95vw)] max-h-[90dvh] flex flex-col overflow-hidden font-sans" aria-describedby={undefined}>
      <DialogHeader className="shrink-0">
        <DialogTitle className="flex items-center gap-2 text-base"><BarChart3 className="w-4 h-4 text-primary" />Trade history chart</DialogTitle>
        <div aria-label="Chart legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground text-left">
          <span className="text-sky-400">↑ Long entry</span>
          <span className="text-violet-400">↓ Short entry</span>
          <span className="text-emerald-500">● Exit win</span>
          <span className="text-red-500">● Exit loss</span>
          <span>● Grey exit: flat or P&L pending</span>
          <span>□ Box: entry to exit paired in order</span>
          <span>Green box: profit · Red box: loss · Grey box: flat</span>
          <span>Grey strip: unpaired trade activity</span>
        </div>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto">
        <TradeHistoryChartContent botId={botId} />
      </div>
    </DialogContent>
  </Dialog>;
}

function formatPrice(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: deriveAiTraderChartPriceFormat(undefined, [value]).precision });
}

function formatSize(value: number) {
  return Math.abs(value).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatTradeTime(value: string) {
  const date = new Date(value);
  return `${date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

function TradeInfoCard({ execution, pinned, onDismiss }: { execution: Execution; pinned: boolean; onDismiss: () => void }) {
  const pair = execution.pairingStatus === 'sequential' ? execution.pair : undefined;
  const direction = pair?.direction ?? tradeEntryDirection(execution);
  const entry = execution.kind === 'entry';
  const exit = execution.kind === 'close';
  const pnl = pair?.netPnl ?? (exit && execution.accountingStatus === 'resolved' ? execution.netPnl : null);
  const entryPrice = pair?.entryPrice ?? (entry ? execution.price : null);
  const exitPrice = pair?.exitPrice ?? (exit ? execution.price : null);
  const entryTime = pair?.entryTime ?? (entry ? execution.exactTime : null);
  const exitTime = pair?.exitTime ?? (exit ? execution.exactTime : null);
  return <div role={pinned ? 'region' : 'tooltip'} aria-label="Chart trade details" className={`absolute left-2 top-2 z-10 w-72 max-w-[calc(100%-1rem)] max-h-[calc(100%-1rem)] rounded-lg border border-border/70 bg-background/95 p-3 shadow-lg text-xs ${pinned ? 'overflow-y-auto' : 'pointer-events-none overflow-hidden'}`}>
    <div className="mb-2 flex items-center justify-between gap-2">
      <strong className={direction === 'Long' ? 'text-sky-400' : direction === 'Short' ? 'text-violet-400' : 'text-foreground'}>
        {pair ? `${direction} trade` : execution.status === 'liquidated' ? 'Liquidated' : direction ? `${direction} entry` : exit ? 'Exit' : 'Trade'}
      </strong>
      {pinned && <button type="button" onClick={onDismiss} className="rounded px-2 py-1 text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2" aria-label="Dismiss chart trade details">Close</button>}
    </div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 tabular-nums">
      <dt className="text-muted-foreground">Direction</dt><dd>{direction ?? 'Unavailable'}</dd>
      <dt className="text-muted-foreground">Entry</dt><dd>{entryPrice !== null ? `$${formatPrice(entryPrice)}` : 'Not linked'}</dd>
      {entryTime && <><dt className="text-muted-foreground">Entry time</dt><dd><time dateTime={entryTime}>{new Date(entryTime).toLocaleString()}</time></dd></>}
      <dt className="text-muted-foreground">Exit</dt><dd>{exitPrice !== null ? `$${formatPrice(exitPrice)}` : 'Not linked'}</dd>
      {exitTime && <><dt className="text-muted-foreground">Exit time</dt><dd><time dateTime={exitTime}>{new Date(exitTime).toLocaleString()}</time></dd></>}
      {!entry && !exit && <><dt className="text-muted-foreground">Recorded price</dt><dd>${formatPrice(execution.price)}</dd><dt className="text-muted-foreground">Recorded time</dt><dd>{new Date(execution.exactTime).toLocaleString()}</dd></>}
      <dt className="text-muted-foreground">Size</dt><dd>{formatSize(execution.size)}</dd>
      <dt className="text-muted-foreground">Net P&L</dt><dd className={pnl !== null && pnl > 0 ? 'text-emerald-500' : pnl !== null && pnl < 0 ? 'text-red-500' : ''}>{pnl !== null ? formatPnl(pnl) : exit ? 'Pending' : 'Unavailable'}</dd>
      <dt className="text-muted-foreground">P&L %</dt><dd>{pair ? `${pair.pnlPercent > 0 ? '+' : ''}${pair.pnlPercent.toFixed(2)}% of entry notional` : 'Unavailable'}</dd>
      <dt className="text-muted-foreground">Time held</dt><dd>{pair ? formatTimeHeld(pair.timeHeldMs) : 'Unavailable'}</dd>
      <dt className="text-muted-foreground">Status</dt><dd className="capitalize">{execution.status}</dd>
    </dl>
    <p className="mt-2 text-[10px] text-muted-foreground">{pair ? 'Entry and exit paired in order.' : 'Entry and exit are not linked for this execution.'} Times are local.{!pinned && ' Click the marker to keep details open.'}</p>
  </div>;
}

function formatTimeHeld(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
  return `${days ? `${days}d ` : ''}${hours || days ? `${hours}h ` : ''}${minutes % 60}m`;
}

function TradeHistoryChartContent({ botId }: { botId: string }) {
  const initialTo = useRef(Date.now());
  const [range, setRange] = useState(() => ({ from: new Date(initialTo.current - 90 * DAY).toISOString(), to: new Date(initialTo.current).toISOString() }));
  const [tf, setTf] = useState<'1d' | '4h'>('1d');
  const [data, setData] = useState<ChartResponse | null>(null);
  const [selected, setSelected] = useState<Execution | null>(null);
  const [hovered, setHovered] = useState<Execution | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [paging, setPaging] = useState(false);
  const priceRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDListElement>(null);
  const requestKey = [botId, tf, range.from, range.to].join(':');
  const currentRequest = useRef({ key: requestKey, generation: 0 });
  if (currentRequest.current.key !== requestKey) currentRequest.current = { key: requestKey, generation: currentRequest.current.generation + 1 };
  const pagingRequest = useRef<number | null>(null);
  function selectExecution(execution: Execution) {
    setSelected(execution);
    requestAnimationFrame(() => detailRef.current?.focus());
  }
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    pagingRequest.current = null; setPaging(false);
    setLoading(true); setData(null); setError(''); setSelected(null); setHovered(null);
    const query = new URLSearchParams({ tf, from: range.from, to: range.to });
    fetch(`/api/trading-bots/${encodeURIComponent(botId)}/trade-chart?${query}`, { credentials: 'include', headers: walletAuthHeaders(), signal: controller.signal })
      .then(async r => { const body = await safeResponseJson(r); if (!r.ok) throw Error(body?.code === 'MARKET_INVARIANT_VIOLATION' ? 'Market invariant violation: stored trades span another market' : body?.error || 'Chart unavailable'); return body as ChartResponse; })
      .then(body => { if (!cancelled) setData(body); })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; controller.abort(); };
  }, [botId, range.from, range.to, tf]);
  useEffect(() => {
    if (!data || !priceRef.current || data.price.availability !== 'available') return;
    const chart = createSharedTradePriceChart(priceRef.current);
    setHovered(null);
    const series = chart.addCandlestickSeries({ upColor: '#38bdf8', downColor: '#7854d4', wickUpColor: '#38bdf8', wickDownColor: '#7854d4', borderVisible: false, priceFormat: deriveAiTraderChartPriceFormat(undefined, data.price.candles.flatMap(c => [c.open, c.high, c.low, c.close])) });
    series.setData(data.price.candles.map(c => ({ ...c, time: c.time as UTCTimestamp })));
    series.setMarkers(tradeChartMarkers(data.executions).map(marker => ({ ...marker, time: marker.time as UTCTimestamp })));
    const detachBoxes = attachTradeBoxes(chart, series, data.pairs, data.price.candles.map(c => c.time), tf === '1d' ? 86_400 : 14_400);
    const byId = new Map(data.executions.map(row => [row.id, row]));
    chart.subscribeCrosshairMove(param => {
      setHovered(param.point && typeof param.hoveredObjectId === 'string' ? byId.get(param.hoveredObjectId) ?? null : null);
    });
    chart.subscribeClick(param => {
      const execution = typeof param.hoveredObjectId === 'string' ? byId.get(param.hoveredObjectId) : undefined;
      // Keep the card on the chart; focusing the list detail would scroll it away.
      setSelected(execution ?? null);
      setHovered(null);
    });
    // A single histogram column occupies exactly one candle bar in the bottom trade lane.
    const bandSeries = chart.addHistogramSeries({ priceScaleId: 'trade-lane', base: 0, color: NEUTRAL_SPAN, priceLineVisible: false, lastValueVisible: false });
    bandSeries.priceScale().applyOptions({ visible: false, scaleMargins: { top: 0.975, bottom: 0.01 } });
    bandSeries.setData(data.bands.map(b => ({ time: (Date.parse(b.barTime) / 1000) as UTCTimestamp, value: 1, color: NEUTRAL_SPAN })));
    chart.timeScale().fitContent();
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        if (priceRef.current) chart.applyOptions({ width: priceRef.current.clientWidth, height: priceRef.current.clientHeight });
      });
    });
    observer.observe(priceRef.current);
    return () => { observer.disconnect(); cancelAnimationFrame(resizeFrame); detachBoxes(); chart.remove(); };
  }, [data?.price.candles, data?.bands, data?.executions, data?.pairs, tf]);
  async function loadMore() {
    if (!data?.nextCursor || pagingRequest.current === currentRequest.current.generation) return;
    const key = currentRequest.current.generation;
    pagingRequest.current = key;
    setPaging(true); setError('');
    try {
      const query = new URLSearchParams({ tf, from: range.from, to: range.to, cursor: data.nextCursor });
      const r = await fetch(`/api/trading-bots/${encodeURIComponent(botId)}/trade-chart?${query}`, { credentials: 'include', headers: walletAuthHeaders() });
      const body = await safeResponseJson(r) as ChartResponse;
      if (currentRequest.current.generation !== key) return;
      if (!r.ok) {
        if ((body as unknown as { code?: string }).code === 'MARKET_INVARIANT_VIOLATION') {
          setData(null);
          throw Error('Market invariant violation: stored trades span another market');
        }
        throw Error('More history unavailable. Retry loading the remaining rows.');
      }
      setData(prev => prev ? { ...prev, complete: body.complete, nextCursor: body.nextCursor, executions: [...prev.executions, ...body.executions], bands: mergeNeutralBands(prev.bands, body.bands) } : body);
    } catch (e) { if (currentRequest.current.generation === key) setError(e instanceof Error ? e.message : 'More history unavailable'); }
    finally { if (pagingRequest.current === key) { pagingRequest.current = null; setPaging(false); } }
  }
  function older() {
    if (data?.nextCursor) return;
    const next = earlierChartWindow(range.from, data?.range.firstEligibleTradeAt ?? null);
    if (next) setRange(next);
  }
  const fromMs = new Date(range.from).getTime();
  const priceVenue = data?.price.basisLabel.match(/^Reference price\s*[—–-]\s*([^\s(]+)/i)?.[1];
  return <section aria-label="Signal Bot trade history chart" className="min-w-0 space-y-3 text-xs">
    <div className="flex flex-wrap gap-2 items-center px-0.5"><strong className="text-sm font-medium mr-auto">{data?.market ?? 'Trade chart'}</strong>
      <div className="flex gap-0.5 rounded-md border border-border/50 p-0.5">
        {(['1d', '4h'] as const).map(timeframe => <Button key={timeframe} type="button" size="sm" variant="ghost" onClick={() => setTf(timeframe)} aria-pressed={tf === timeframe} className={`min-h-0 h-6 px-2 text-xs ${tf === timeframe ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}>{timeframe}</Button>)}
      </div>
      <Button type="button" size="sm" variant="outline" onClick={older} disabled={!data || !!data.nextCursor || !data.range.firstEligibleTradeAt || fromMs <= new Date(data.range.firstEligibleTradeAt).getTime()}>Earlier 90 days</Button>
      <Button type="button" size="sm" variant="outline" onClick={() => setRange({ from: new Date(initialTo.current - 90 * DAY).toISOString(), to: new Date(initialTo.current).toISOString() })} disabled={range.to === new Date(initialTo.current).toISOString()}>Recent 90 days</Button>
    </div>
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <p role="status">{priceVenue ? `Price: ${priceVenue.toUpperCase()} reference` : data ? 'Price unavailable' : 'Loading price…'}</p>
      <p>{new Date(range.from).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })} – {new Date(range.to).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</p>
    </div>
    {loading && <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin" />Loading chart…</p>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {data && <>
      <div className="flex flex-wrap items-center gap-2" aria-label="All-time closed trade statistics">
        <span className="text-muted-foreground">All time</span>
        <Badge variant="secondary" className="text-xs font-medium">Trades {data.totals.totalTrades}</Badge>
        <Badge variant="outline" className="text-xs font-medium text-emerald-500 border-emerald-500/20 bg-emerald-500/5">Wins {data.totals.winningTrades}</Badge>
        <Badge variant="outline" className="text-xs font-medium text-red-500 border-red-500/20 bg-red-500/5">Losses {data.totals.losingTrades}</Badge>
        {data.totals.accountingIncompleteTrades > 0 && <span className="text-muted-foreground">P&L pending: {data.totals.accountingIncompleteTrades}</span>}
      </div>
      {data.price.availability !== 'available' && <p role="status" className="text-muted-foreground">Price unavailable. Trade details remain below.</p>}
      {data.price.availability === 'available' && data.executions.some(e => e.displayBarTime === null) && <p role="status" className="text-muted-foreground">Some trades fall outside the available candles. Their details are listed below.</p>}
      {data.price.availability === 'available' && <div className="relative w-full overflow-hidden" style={{ height: 'min(62vh, 760px)' }}>
        <div ref={priceRef} className="absolute inset-0" aria-label={data.price.basisLabel} onMouseLeave={() => setHovered(null)} />
        {(hovered ?? selected) && <TradeInfoCard execution={(hovered ?? selected)!} pinned={!hovered || hovered.id === selected?.id} onDismiss={() => { setSelected(null); setHovered(null); }} />}
      </div>}
      <p className="text-muted-foreground">Hover or click a marker for trade details, or select a row below. Boxes pair entries and exits in order. Partial closes, adds and unreconciled positions stay on the grey strip.</p>
      {data.openPosition && <p className="rounded-md border bg-muted/20 px-3 py-2 text-xs tabular-nums">Open: {data.openPosition.size === null ? 'Size unavailable' : `${data.openPosition.size < 0 ? 'SHORT' : 'LONG'} ${formatSize(data.openPosition.size)}`} @ {data.openPosition.entryPrice === null ? 'Price unavailable' : formatPrice(data.openPosition.entryPrice)}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground"><span>Trades in this range · Local time</span><span>Arrows show direction · Circles show exit P&L</span></div>
      <div aria-label="Trade execution rows" className="max-h-48 overflow-y-auto rounded-lg border">
        <ul className="divide-y divide-border">{data.executions.map(e => {
          const pnl = e.kind === 'close' && e.accountingStatus === 'resolved' ? e.netPnl : null;
          const side = e.kind === 'close' ? 'CLOSE' : ['LONG', 'BUY'].includes(e.side.toUpperCase()) ? 'LONG' : ['SHORT', 'SELL'].includes(e.side.toUpperCase()) ? 'SHORT' : e.side.toUpperCase();
          return <li key={e.id}><Button type="button" size="sm" variant="ghost" onClick={() => selectExecution(e)} className={`h-auto w-full justify-start flex-wrap whitespace-normal rounded-none px-3 py-2 text-left text-xs font-normal gap-x-3 gap-y-1 ${pnl !== null && pnl > 0 ? 'bg-emerald-500/5' : pnl !== null && pnl < 0 ? 'bg-red-500/5' : 'bg-muted/20'} ${selected?.id === e.id ? 'ring-1 ring-inset ring-primary' : ''}`} aria-label={`${e.status} ${e.side} at ${e.exactTime}`} aria-pressed={selected?.id === e.id}>
            <time dateTime={e.exactTime} title={e.exactTime} className="text-muted-foreground tabular-nums">{formatTradeTime(e.exactTime)}</time>
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 font-medium ${side === 'LONG' ? 'text-emerald-500 border-emerald-500/20' : side === 'SHORT' ? 'text-red-500 border-red-500/20' : 'text-amber-500 border-amber-500/20'}`}>{side}</Badge>
            {['liquidated', 'recovered'].includes(e.status) && <span className="text-muted-foreground capitalize">{e.status}</span>}
            <span className="tabular-nums">{formatSize(e.size)} @ {formatPrice(e.price)}</span>
            {pnl !== null ? <span className={`ml-auto font-medium tabular-nums ${pnl > 0 ? 'text-emerald-500' : pnl < 0 ? 'text-red-500' : 'text-muted-foreground'}`}>{formatPnl(pnl)}</span> : e.kind === 'close' && <span className="ml-auto text-muted-foreground">P&L pending</span>}
          </Button></li>;
        })}</ul>
      </div>
      {data.range.firstEligibleTradeAt === null ? <p className="text-muted-foreground">No executed trades yet.</p> : data.executions.length === 0 && <p className="text-muted-foreground">No trades in this range.</p>}
      {selected && <dl ref={detailRef} tabIndex={-1} aria-label="Recorded trade detail" className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs rounded-lg border bg-muted/20 p-3 break-words focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <dt className="text-muted-foreground">Trade ID</dt><dd>{selected.id}</dd>
        <dt className="text-muted-foreground">Time (UTC)</dt><dd>{selected.exactTime}</dd>
        <dt className="text-muted-foreground">Price · Size</dt><dd>{formatPrice(selected.price)} · {formatSize(selected.size)}</dd>
        <dt className="text-muted-foreground">Side · Status</dt><dd>{selected.side} · {selected.status}</dd>
        <dt className="text-muted-foreground">Venue</dt><dd>{selected.protocol ?? 'Unknown'}{selected.protocolMismatch ? ' (different from current bot venue)' : ''}</dd>
        <dt className="text-muted-foreground">Net P&L</dt><dd>{selected.pair ? formatPnl(selected.pair.netPnl) : selected.accountingStatus === 'resolved' && selected.netPnl !== null ? formatPnl(selected.netPnl) : selected.kind === 'close' ? 'Pending' : '—'}</dd>
        {selected.pair && <>
          <dt className="text-muted-foreground">Pairing</dt><dd>In order · {selected.pair.direction}</dd>
          <dt className="text-muted-foreground">Entry</dt><dd>${formatPrice(selected.pair.entryPrice)} · {new Date(selected.pair.entryTime).toLocaleString()}</dd>
          <dt className="text-muted-foreground">Exit</dt><dd>${formatPrice(selected.pair.exitPrice)} · {new Date(selected.pair.exitTime).toLocaleString()}</dd>
          <dt className="text-muted-foreground">P&L %</dt><dd>{selected.pair.pnlPercent.toFixed(2)}% of entry notional</dd>
          <dt className="text-muted-foreground">Time held</dt><dd>{formatTimeHeld(selected.pair.timeHeldMs)}</dd>
        </>}
      </dl>}
      {data.nextCursor && <div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={paging} onClick={loadMore}>Load more trade rows</Button><span className="text-muted-foreground">More trades available in this range</span></div>}
    </>}
  </section>;
}

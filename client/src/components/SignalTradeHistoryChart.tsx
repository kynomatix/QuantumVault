import { useEffect, useRef, useState } from 'react';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';
import { createSharedTradePriceChart } from './SharedTradePriceChart';
import { earlierChartWindow, mergeNeutralBands } from './signalTradeHistoryWindow';
import { tradeChartMarkers } from './signalTradeChartMarkers';
import type { UTCTimestamp } from 'lightweight-charts';

type Execution = { id: string; status: string; side: string; protocol: string | null; protocolMismatch: boolean; kind: string; exactTime: string; displayBarTime: string | null; price: number; size: number; coordinateBasis: string; netPnl: number | null; accountingStatus: string; feeTruthStatus: string; pairingStatus: string };
type Band = { barTime: string; rowIds: string[]; pairingStatus: 'unproven' };
const NEUTRAL_SPAN = '#64748b'; // One token for light and dark themes.
type ChartResponse = {
  market: string; timeframe: string; range: { from: string; to: string; firstEligibleTradeAt: string | null };
  complete: boolean; nextCursor: string | null;
  price: { availability: string; reason: string | null; basisLabel: string; candles: Array<{ time: number; open: number; high: number; low: number; close: number }> };
  executions: Execution[]; bands: Band[];
  totals: { totalTrades: number; winningTrades: number; losingTrades: number; accountingIncompleteTrades: number };
  openPosition: { size: number | null; entryPrice: number | null; attribution: string; unrealizedPnl: null } | null;
};
const DAY = 86_400_000;
export function SignalTradeHistoryChart({ botId }: { botId: string }) {
  const initialTo = useRef(Date.now());
  const [range, setRange] = useState(() => ({ from: new Date(initialTo.current - 90 * DAY).toISOString(), to: new Date(initialTo.current).toISOString() }));
  const [tf, setTf] = useState<'1d' | '4h'>('1d');
  const [data, setData] = useState<ChartResponse | null>(null);
  const [selected, setSelected] = useState<Execution | null>(null);
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
    setLoading(true); setData(null); setError(''); setSelected(null);
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
    const series = chart.addCandlestickSeries({ upColor: '#38bdf8', downColor: '#7854d4', wickUpColor: '#38bdf8', wickDownColor: '#7854d4', borderVisible: false });
    series.setData(data.price.candles.map(c => ({ ...c, time: c.time as UTCTimestamp })));
    series.setMarkers(tradeChartMarkers(data.executions).map(marker => ({ ...marker, time: marker.time as UTCTimestamp })));
    chart.subscribeClick(param => {
      const execution = data.executions.find(row => row.id === param.hoveredObjectId);
      if (execution) selectExecution(execution);
    });
    // A single histogram column occupies exactly one candle bar in the bottom trade lane.
    const bandSeries = chart.addHistogramSeries({ priceScaleId: 'trade-lane', base: 0, color: NEUTRAL_SPAN, priceLineVisible: false, lastValueVisible: false });
    bandSeries.priceScale().applyOptions({ visible: false, scaleMargins: { top: 0.88, bottom: 0.02 } });
    bandSeries.setData(data.bands.map(b => ({ time: (Date.parse(b.barTime) / 1000) as UTCTimestamp, value: 1, color: NEUTRAL_SPAN })));
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => { if (priceRef.current) chart.applyOptions({ width: priceRef.current.clientWidth }); });
    observer.observe(priceRef.current);
    return () => { observer.disconnect(); chart.remove(); };
  }, [data?.price.candles, data?.bands, data?.executions]);
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
  return <section aria-label="Signal Bot trade history chart" className="space-y-3">
    <div className="flex gap-2 items-center"><strong>{data?.market ?? 'Trade chart'}</strong>
      <button type="button" onClick={() => setTf('1d')} aria-pressed={tf === '1d'} className="px-2 border rounded">1d</button>
      <button type="button" onClick={() => setTf('4h')} aria-pressed={tf === '4h'} className="px-2 border rounded">4h</button>
      <button type="button" onClick={older} disabled={!data || !!data.nextCursor || !data.range.firstEligibleTradeAt || fromMs <= new Date(data.range.firstEligibleTradeAt).getTime()} className="px-2 border rounded">Earlier 90 days</button>
      <button type="button" onClick={() => setRange({ from: new Date(initialTo.current - 90 * DAY).toISOString(), to: new Date(initialTo.current).toISOString() })} disabled={range.to === new Date(initialTo.current).toISOString()} className="px-2 border rounded">Recent 90 days</button>
    </div>
    <p className="text-xs" role="status">{data?.price.basisLabel ?? 'Loading price provenance'} · {data?.complete ? 'Range complete' : 'Partial history: load more rows'} · {range.from.slice(0,10)} to {range.to.slice(0,10)} UTC</p>
    {loading && <p>Loading chart…</p>}{error && <p role="alert">{error}</p>}
    {data && <>
      <p className="text-xs">First eligible recorded trade: {data.range.firstEligibleTradeAt ?? 'none'}{data.range.firstEligibleTradeAt ? ' UTC' : ''}</p>
      <p className="text-xs">All-history canonical closes: {data.totals.totalTrades} | Profitable: {data.totals.winningTrades} | Losing: {data.totals.losingTrades} | Accounting incomplete: {data.totals.accountingIncompleteTrades}</p>
      {data.price.availability !== 'available' && <p role="status">Price unavailable. Trade details remain below.</p>}
      {data.price.availability === 'available' && data.executions.some(e => e.displayBarTime === null) && <p role="status">Some executions have no containing price candle; their recorded details remain below.</p>}
      <div ref={priceRef} className="h-72 w-full" aria-label={data.price.basisLabel} />
      <div aria-label="Trade execution rows" className="max-h-40 overflow-auto rounded border">
        <ul>{data.executions.map(e => <li key={e.id}><button type="button" onClick={() => selectExecution(e)} className={`w-full text-left px-2 py-1 focus:outline focus:outline-2 ${e.kind === 'close' && e.accountingStatus === 'resolved' && e.netPnl !== null && e.netPnl > 0 ? 'border-emerald-600 bg-emerald-600/30' : e.kind === 'close' && e.accountingStatus === 'resolved' && e.netPnl !== null && e.netPnl < 0 ? 'border-red-600 bg-red-600/30' : 'bg-background'}`} aria-label={`${e.status} ${e.side} at ${e.exactTime}`}>
          {e.status === 'liquidated' ? 'L' : e.status === 'recovered' ? 'R' : e.kind === 'close' ? 'X' : e.kind === 'entry' ? 'E' : '?'} · {e.exactTime} · {e.side} · {e.price} × {e.size}
        </button></li>)}</ul>
      </div>
      {data.range.firstEligibleTradeAt === null ? <p>No eligible executed trades.</p> : data.executions.length === 0 && <p>No eligible executed trades in this range.</p>}
      {data.openPosition && <p>Open position: {data.openPosition.size ?? 'size unavailable'} at {data.openPosition.entryPrice ?? 'basis unavailable'}. {data.openPosition.attribution}; unrealized outcome unavailable.</p>}
      {selected && <dl ref={detailRef} tabIndex={-1} aria-label="Recorded trade detail" className="grid grid-cols-2 gap-1 text-xs rounded border p-2"><dt>Row ID</dt><dd>{selected.id}</dd><dt>Exact UTC time</dt><dd>{selected.exactTime}</dd><dt>Price and size</dt><dd>{selected.price} × {selected.size} ({selected.coordinateBasis})</dd><dt>Side and status</dt><dd>{selected.side} · {selected.status}</dd><dt>Recorded protocol</dt><dd>{selected.protocol ?? "unknown"}{selected.protocolMismatch ? " (differs from active bot protocol)" : ""}</dd><dt>Net outcome</dt><dd>{selected.accountingStatus === 'resolved' ? selected.netPnl : selected.accountingStatus} · fee truth: {selected.feeTruthStatus}</dd></dl>}
      {data.nextCursor && <button type="button" disabled={paging} onClick={loadMore} className="border rounded px-2">Load more trade rows</button>}
    </>}
  </section>;
}

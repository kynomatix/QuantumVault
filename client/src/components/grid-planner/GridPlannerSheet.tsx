import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Decimal from 'decimal.js';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { walletAuthHeaders } from '@/lib/queryClient';
import { PLANNING_BANNER, ASSUMPTION_LABEL, feePercentToRate, PlannerRequestGeneration, isPlannerChart,
  isPlannerMarket, isPlannerPreview, plannerOverlays, readableDecimal, readableTime, clientObservationDeadline,
  type PlannerChart, type PlannerMarket, type PlannerPreview } from '@/lib/grid-planner-view';
import { GridPlannerChart } from './GridPlannerChart';

const D = Decimal.clone({ precision: 80 });
const INITIAL = { market: '', side: 'long', lower: '', upper: '', intervals: '10', entryScale: 'flat', profitScale: 'flat',
  seed: true, leverage: '1', investment: '', stop: '', feePercent: '', timeframe: '1h', bars: '100' };
const selectClass = 'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
async function readPlanner(path: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(`/api/grid-planner/${path}`, { method: 'GET', credentials: 'include', headers: walletAuthHeaders(), signal });
  const value = await res.json();
  if (!res.ok) throw new Error(typeof value?.reason === 'string' ? value.reason : `Planner request failed (${res.status})`);
  return value;
}

export function GridPlannerSheet({ open, onOpenChange, identity }: { open: boolean; onOpenChange: (open: boolean) => void; identity: string }) {
  const [form, setForm] = useState(INITIAL), [markets, setMarkets] = useState<PlannerMarket[]>([]);
  const [preview, setPreview] = useState<PlannerPreview | null>(null), [chart, setChart] = useState<PlannerChart | null>(null);
  const [error, setError] = useState(''), [marketError, setMarketError] = useState(''), [chartError, setChartError] = useState('');
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [now, setNow] = useState(Date.now());
  const [previewExpiry, setPreviewExpiry] = useState(0), [chartExpiry, setChartExpiry] = useState(0);
  const [marketClock, setMarketClock] = useState({ serverNow: 0, startedAt: 0 });
  const generation = useRef({ markets: new PlannerRequestGeneration(), chart: new PlannerRequestGeneration(), preview: new PlannerRequestGeneration() });
  const selected = markets.find(m => m.market === form.market);
  const referenceExpiry = selected?.reference.state === 'available' ? clientObservationDeadline(selected.reference.value.expiresAt, marketClock.serverNow, marketClock.startedAt) : 0;
  const constraintExpiry = selected?.constraints.state === 'available' ? clientObservationDeadline(selected.constraints.value.expiresAt, marketClock.serverNow, marketClock.startedAt) : 0;
  const reference = selected?.reference.state === 'available' && now < referenceExpiry ? selected.reference.value : null;
  const invalidate = useCallback(() => { generation.current.preview.invalidate(); setPreview(null); setError(''); }, []);
  const edit = (key: keyof typeof INITIAL, value: string | boolean) => {
    invalidate();
    if (['market', 'timeframe', 'bars'].includes(key)) { generation.current.chart.invalidate(); setChart(null); }
    setForm(previous => ({ ...previous, [key]: value }));
  };
  const query = useMemo(() => {
    try {
      const fee = feePercentToRate(form.feePercent);
      const q = new URLSearchParams({ market: form.market, side: form.side, lower: form.lower, upper: form.upper,
        intervals: form.intervals, entryScale: form.entryScale, profitScale: form.profitScale, seed: String(form.seed),
        leverage: form.leverage, investment: form.investment, stop: form.stop });
      if (fee !== null) q.set('fee', fee);
      return { value: q.toString(), error: '' };
    } catch (e) { return { value: '', error: (e as Error).message }; }
  }, [form]);
  useEffect(() => {
    if (!open) return;
    const token = generation.current.markets.start(), startedAt = Date.now(); setMarketError(''); setMarkets([]);
    readPlanner('markets', token.signal).then(value => {
      if (!token.current()) return;
      if (!value || typeof value !== 'object' || (value as any).state !== 'available' || !Array.isArray((value as any).markets)
        || (value as any).markets.length > 512 || !(value as any).markets.every(isPlannerMarket)
        || !Number.isSafeInteger((value as any).retrievedAt)) throw new Error('Invalid market response');
      setMarketClock({ serverNow: (value as any).retrievedAt, startedAt }); setMarkets((value as any).markets); setNow(Date.now());
    }).catch(e => { if (token.current()) { setMarkets([]); setMarketError(e.message); } });
    return () => generation.current.markets.invalidate();
  }, [open, identity, refresh]);
  useEffect(() => {
    if (!open || !form.market) return;
    const token = generation.current.chart.start(); setChart(null); setChartError('');
    const startedAt = Date.now();
    readPlanner(`chart?${new URLSearchParams({ market: form.market, timeframe: form.timeframe, bars: form.bars })}`, token.signal).then(value => {
      if (!token.current()) return;
      if (!isPlannerChart(value) || value.state === 'available' && (value.market !== form.market || value.timeframe !== form.timeframe || value.requestedBars !== Number(form.bars))) throw new Error('Invalid chart response');
      setChart(value); setChartExpiry(value.state === 'available' ? startedAt + value.validForMs : 0); setNow(Date.now());
    }).catch(e => { if (token.current()) setChartError(e.message); });
    return () => generation.current.chart.invalidate();
  }, [open, identity, form.market, form.timeframe, form.bars, refresh]);
  useEffect(() => {
    generation.current.preview.invalidate(); setPreview(null); setLoading(false);
    if (!open || !form.market || !form.lower || !form.upper || !form.investment || !form.stop || query.error) return;
    const token = generation.current.preview.start(); setLoading(true); setError('');
    const timer = setTimeout(() => {
      const startedAt = Date.now();
      readPlanner(`preview?${query.value}`, token.signal).then(value => {
        if (!token.current()) return;
        if (!isPlannerPreview(value) || value.market.market !== form.market) throw new Error('Invalid preview response');
        // Subtract the whole transit time; client/server wall-clock skew cannot renew authority.
        setPreviewExpiry(startedAt + value.validForMs); setPreview(value); setNow(Date.now());
      }).catch(e => { if (token.current()) setError(e.message); }).finally(() => { if (token.current()) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); generation.current.preview.invalidate(); };
  }, [open, identity, query.value, query.error, refresh]);
  useEffect(() => {
    if (!open) { Object.values(generation.current).forEach(g => g.invalidate()); setPreview(null); setChart(null); return; }
    const deadlines = [previewExpiry, chartExpiry, referenceExpiry, constraintExpiry].filter(t => t > Date.now());
    const timer = deadlines.length ? setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(...deadlines) - Date.now() + 1)) : undefined;
    const wake = () => setNow(Date.now());
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => { clearTimeout(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [open, now, previewExpiry, chartExpiry, referenceExpiry, constraintExpiry]);
  useEffect(() => () => Object.values(generation.current).forEach(g => g.invalidate()), []);
  const preset = (percent: number) => {
    if (!reference) return;
    const price = new D(reference.price), fraction = new D(percent).div(100);
    invalidate(); setForm(previous => ({ ...previous, lower: price.times(new D(1).minus(fraction)).toFixed(18).replace(/\.?0+$/, ''),
      upper: price.times(new D(1).plus(fraction)).toFixed(18).replace(/\.?0+$/, '') }));
  };
  const lines = useMemo(() => plannerOverlays(preview, previewExpiry, now), [preview, previewExpiry, now]);
  const displayPlan = preview?.requestedPlan ?? preview?.minimumPlan;
  const stale = preview !== null && now >= previewExpiry;
  const numberField = (key: keyof typeof INITIAL, label: string) => <div key={key} className="space-y-1"><Label htmlFor={`grid-${key}`}>{label}</Label><Input id={`grid-${key}`} inputMode="decimal" value={String(form[key])} onChange={e => edit(key, e.target.value)} /></div>;
  const choice = (key: keyof typeof INITIAL, label: string, options: string[]) => <div className="space-y-1"><Label htmlFor={`grid-${key}`}>{label}</Label><select id={`grid-${key}`} className={selectClass} value={String(form[key])} onChange={e => edit(key, e.target.value)}>{options.map(o => <option key={o} value={o}>{o[0].toUpperCase() + o.slice(1)}</option>)}</select></div>;
  return <Sheet open={open} onOpenChange={value => { if (!value) Object.values(generation.current).forEach(g => g.invalidate()); onOpenChange(value); }}>
    <SheetContent className="w-full sm:max-w-[1000px] p-0"><div className="h-full overflow-y-auto p-5 sm:p-6 space-y-5">
      <SheetHeader><SheetTitle>Grid Planner</SheetTitle><SheetDescription>Explore a hypothetical Pacifica grid before any live bot is available.</SheetDescription></SheetHeader>
      <p className="rounded-md border border-primary/30 bg-primary/10 p-3 text-sm font-medium">{PLANNING_BANNER}</p>
      <div className="flex items-center justify-between"><p className="text-xs text-muted-foreground">No live capacity, balances or positions are read.</p><Button variant="outline" size="sm" disabled={loading} onClick={() => { invalidate(); generation.current.chart.invalidate(); setChart(null); setRefresh(r => r + 1); }}>Refresh observations</Button></div>
      {marketError && <p role="alert" className="text-sm text-destructive">{marketError}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1"><Label htmlFor="grid-market">Pacifica market</Label><select id="grid-market" className={selectClass} value={form.market} onChange={e => edit('market', e.target.value)}><option value="">Choose a market</option>{markets.map(m => <option key={m.market} value={m.market}>{m.market}{m.constraints.state === 'unavailable' ? ' — sizing unavailable' : ''}</option>)}</select></div>
        {choice('timeframe', 'Candle timeframe', ['15m', '1h', '4h'])}{choice('bars', 'History bars', ['100', '200'])}
      </div>
      {selected && <div className="text-xs space-y-1 text-muted-foreground">
        <p>{reference ? `Cached Pacifica book reference price: ${readableDecimal(reference.price)} · observed ${readableTime(reference.observedAt)}` : `Reference price unavailable: ${selected.reference.state === 'unavailable' ? selected.reference.reason : 'observation expired'}`}</p>
        {selected.constraints.state === 'available' ? <p>Tick {readableDecimal(selected.constraints.value.tick)} · lot {readableDecimal(selected.constraints.value.lot)} base units · opening minimum {readableDecimal(selected.constraints.value.minimumQuote)} USD · observed {readableTime(selected.constraints.value.observedAt)}{now >= constraintExpiry ? ' — observation expired' : ''}. Smallest positive base quantity is derived from the lot lattice.</p> : <p>Sizing unavailable: {selected.constraints.reason}</p>}
      </div>}
      {chartError && <p role="alert" className="text-sm text-destructive">{chartError}</p>}
      <GridPlannerChart chart={chart} lines={lines} stale={now >= chartExpiry} />
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {choice('side', 'Direction', ['long', 'short'])}{numberField('lower', 'Lower price')}{numberField('upper', 'Upper price')}
        {numberField('intervals', 'Grid intervals (1–100)')}{choice('entryScale', 'Entry size scale', ['flat', 'ascending', 'descending'])}{choice('profitScale', 'Seed exit size scale', ['flat', 'ascending', 'descending'])}
        {numberField('investment', 'Investment (USDC, 0.01 increments)')}{numberField('leverage', 'Leverage')}{numberField('stop', 'Proposed stop price')}
      </div>
      <p className="text-xs text-muted-foreground">Ascending allocates more at better prices; descending does the reverse. Stops must lie beyond the loss side of the range. Liquidation reachability remains unknown.</p>
      <div className="flex gap-2 items-center flex-wrap"><span className="text-xs">Range around reference:</span>{[5, 10, 20].map(p => <Button key={p} type="button" size="sm" variant="outline" disabled={!reference} onClick={() => preset(p)}>±{p}%</Button>)}<Label htmlFor="grid-width">Width</Label><input id="grid-width" aria-label="Range half-width percent" type="range" min="1" max="40" defaultValue="10" disabled={!reference} onChange={e => preset(Number(e.target.value))} /></div>
      <Label className="flex gap-2 items-center"><input type="checkbox" checked={form.seed} onChange={e => edit('seed', e.target.checked)} />Model an initial seed position (taker fee unavailable)</Label>
      <div className="space-y-1 max-w-sm">{numberField('feePercent', 'Assumed maker + builder fee per side (%)')}<p className="text-xs text-muted-foreground">{ASSUMPTION_LABEL}. Blank = unknown; 0 = your explicit zero-cost assumption.</p></div>
      {(query.error || error) && <p role="alert" className="text-sm text-destructive">{query.error || error}</p>}
      {loading && <p role="status" className="text-sm">Calculating hypothetical geometry…</p>}
      {preview && <div className="space-y-3 border-t pt-4">
        <p role="status" className="font-medium">{stale ? 'Observation expired — refresh before using this preview' : preview.state === 'rejected' ? 'Requested plan rejected' : preview.state === 'unavailable' ? 'Preview unavailable' : preview.state === 'diagnostic' ? 'Diagnostic geometry — some checks unavailable' : 'Hypothetical checks passed'}</p>
        {preview.reasons.map((reason, i) => <p key={i} className="text-xs text-muted-foreground">{reason}</p>)}
        <p className="text-sm">Hypothetical geometry minimum: {preview.minimum.state === 'available' ? `${readableDecimal(preview.minimum.value)} USDC` : `unavailable — ${preview.minimum.reason}`}. Uses a 0.01 USDC display quantum and no modeled transfer floor; does not establish funding, liquidation safety, live capacity or executable partial fills.</p>
        <p className="text-sm">Minimum with your fee assumption: {preview.assumedMinimum.state === 'available' ? `${readableDecimal(preview.assumedMinimum.value)} USDC` : `unavailable — ${preview.assumedMinimum.reason}`}</p>
        <p className="text-xs text-muted-foreground">{preview.fee.state === 'unknown' ? 'Fee unknown — fee gate was not evaluated.' : ASSUMPTION_LABEL}. Seed taker fees, slippage, venue fee rounding and funding are unavailable. {preview.stop.reason}</p>
        {displayPlan && <><p className="text-xs">{preview.minimumPlan ? 'Diagnostic quantities at the minimum investment; not sized at your requested investment.' : 'Quantities sized at your requested investment.'} Seed quantity: {readableDecimal(displayPlan.seedQuantity)} base units.</p><div className="overflow-x-auto max-h-72"><table className="w-full text-xs text-left"><caption className="text-left py-2">Hypothetical levels ({displayPlan.lines.length} lines)</caption><thead><tr><th className="p-2">Line</th><th className="p-2">Price</th><th className="p-2">Base quantity</th><th className="p-2">Role</th></tr></thead><tbody>{displayPlan.lines.map(line => <tr key={line.ordinal} className="border-t"><td className="p-2">{line.ordinal + 1}</td><td className="p-2 tabular-nums">{readableDecimal(line.price)}</td><td className="p-2 tabular-nums">{readableDecimal(line.quantity)}</td><td className="p-2">{line.role === 'entry' ? 'Entry' : line.role === 'seed_exit' ? 'Seed-backed exit' : 'Virtual line'}</td></tr>)}</tbody></table></div></>}
        {preview.feeRows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-xs text-left"><caption className="text-left py-2">Assumed fees on equal-quantity pairs — {ASSUMPTION_LABEL}</caption><thead><tr><th className="p-2">Entry → exit</th><th className="p-2">Spread</th><th className="p-2">Required spread</th><th className="p-2">Assumed round-trip fee (USDC)</th><th className="p-2">Check</th></tr></thead><tbody>{preview.feeRows.map(row => <tr key={row.ordinal} className="border-t"><td className="p-2">{readableDecimal(row.entryPrice)} → {readableDecimal(row.exitPrice)}</td><td className="p-2">{readableDecimal(row.spread)}</td><td className="p-2">{readableDecimal(row.requiredSpread)}</td><td className="p-2">{readableDecimal(row.assumedRoundTripFee)}</td><td className="p-2">{row.clears ? 'Clears assumption' : 'Fails assumption'}</td></tr>)}</tbody></table></div>}
        <p className="text-xs text-muted-foreground">Policy model: {preview.policy.ordinaryWindow} ordinary window orders, {preview.policy.requiredAvailableSlots} required available slots including {preview.policy.reserveSlots} reserved, up to 100 intervals / 101 lines; transport batches up to 10. Live available slots and venue resting maximum: unknown. Source: {preview.policy.source}.</p>
      </div>}
    </div></SheetContent>
  </Sheet>;
}

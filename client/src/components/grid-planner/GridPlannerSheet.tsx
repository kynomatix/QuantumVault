import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, RefreshCw, SlidersHorizontal, ArrowUpDown, Shield, Layers, Receipt } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { DrawerSettingsPanel } from '@/components/ui/settings-panel';
import { walletAuthHeaders } from '@/lib/queryClient';
import { PLANNING_BANNER, ASSUMPTION_LABEL, feePercentToRate, PlannerRequestGeneration, isPlannerChart,
  isPlannerPreview, plannerOverlays, plannerLevelMessage, readableDecimal, readableTime, clientObservationDeadline,
  RANGE_PRESETS, ORDER_SIZES, plannerShortcutReason, proposedPlannerStop, plannerChartRange, plannerRangeAround,
  type PlannerChart, type PlannerMarket, type PlannerPreview } from '@/lib/grid-planner-view';
import { GridPlannerChart } from './GridPlannerChart';
import { GridPlannerSizeSelect } from './GridPlannerSizeSelect';
import { GridDirectionBadge } from './GridDirectionBadge';
import { PlannerPriceRefresh, watchPlannerPrice, PRICE_BUSY_MESSAGE } from '@/lib/planner-price-refresh';

import { GRID_SETUP_INITIAL as INITIAL, gridSetupForm, gridSetupIntent, isGridRegime, gridMarketChange } from '@/lib/grid-setup-view';
import { gridHistoryWindow } from '../../../../shared/grid-lookback';
import { gridDraftRevision, gridWidth, type GridDraftPreview } from '@/lib/grid-draft-view';
import { GridDraftActions } from '../grid-bot/GridDraftActions';
import { GridRegimeHint } from './GridRegimeHint';
import type { GridIntent } from '../../../../shared/grid-draft';
import type { PlannerRangeFacts } from '../../../../server/grid-planner/range-facts';
type RangeFacts = Awaited<ReturnType<PlannerRangeFacts['read']>>;
async function readPlanner(path: string, signal: AbortSignal, plannerEnabled = true): Promise<unknown> {
  if (!plannerEnabled) {
    const [name, query = ''] = path.split('?'), params = new URLSearchParams(query);
    if (params.has('bars')) { params.set('lookback', params.get('bars')!); params.delete('bars'); }
    path = `${name === 'markets' ? 'setup-markets' : name}?${params}`;
  }
  const res = await fetch(`/api/${plannerEnabled ? 'grid-planner' : 'grid-bots'}/${path}`, { method: 'GET', credentials: 'include', headers: walletAuthHeaders(), signal });
  const value = await res.json();
  if (!res.ok) throw new Error(typeof value?.reason === 'string' ? value.reason : `Planner request failed (${res.status})`);
  return value;
}

function PriceAge({ observedAt, clock }: { observedAt: number; clock: { serverNow: number; startedAt: number } }) {
  const [clientNow, setClientNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClientNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((clock.serverNow + Math.max(0, clientNow - clock.startedAt) - observedAt) / 1000));
  return <>Pacifica book · {seconds}s ago</>;
}

export function GridPlannerSheet({ open, onOpenChange, identity, plannerEnabled = true, createEnabled = false,
  liveEnabled = false, initialIntent, onSaved = () => {} }: { open: boolean; onOpenChange: (open: boolean) => void;
    identity: string; plannerEnabled?: boolean; createEnabled?: boolean; liveEnabled?: boolean; initialIntent?: GridIntent;
    onSaved?: (bot: Record<string, unknown>) => void }) {
  const [form, setForm] = useState(() => gridSetupForm(initialIntent)), [markets, setMarkets] = useState<PlannerMarket[]>([]);
  const [preview, setPreview] = useState<PlannerPreview | null>(null), [chart, setChart] = useState<PlannerChart | null>(null);
  const [error, setError] = useState(''), [marketError, setMarketError] = useState(''), [chartError, setChartError] = useState('');
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [now, setNow] = useState(Date.now());
  const [chartRefresh, setChartRefresh] = useState(0);
  const [previewExpiry, setPreviewExpiry] = useState(0), [chartExpiry, setChartExpiry] = useState(0);
  const [marketClock, setMarketClock] = useState({ serverNow: 0, startedAt: 0 });
  const [expandedSettingsPanel, setExpandedSettingsPanel] = useState<string | null>('direction-size'), [marketLoading, setMarketLoading] = useState(false);
  const [width, setWidth] = useState(10), [rangeShortcut, setRangeShortcut] = useState<number | null>(null);
  const [rangeSource, setRangeSource] = useState<'manual' | 'auto'>(initialIntent?.rangeSource ?? 'manual');
  const [timeRangeApplied, setTimeRangeApplied] = useState(false);
  const manual = useRef({ lower: form.lower, upper: form.upper, stop: form.stop });
  const rangePercent = useRef<number | null>(null);
  const pendingPercent = useRef<{ market: string; percent: number } | null>(null);
  const [rangeNote, setRangeNote] = useState('');
  const [draftBusy, setDraftBusy] = useState(false), [draftPreview, setDraftPreview] = useState<GridDraftPreview | null>(null);
  const [rangeFacts, setRangeFacts] = useState<RangeFacts | null>(null), [rangeExpiry, setRangeExpiry] = useState(0);
  const [rangeBusy, setRangeBusy] = useState(false), [rangeError, setRangeError] = useState('');
  const [autoApplying, setAutoApplying] = useState(false);
  const [rangeRefresh, setRangeRefresh] = useState(0);
  const applyAutoAfterRefresh = useRef(false);
  const generation = useRef({ range: new PlannerRequestGeneration(), markets: new PlannerRequestGeneration(), chart: new PlannerRequestGeneration(), preview: new PlannerRequestGeneration() });
  const priceRefresh = useRef<PlannerPriceRefresh | null>(null);
  const selected = markets.find(m => m.market === form.market);
  const referenceExpiry = selected?.reference.state === 'available' ? clientObservationDeadline(selected.reference.value.expiresAt, marketClock.serverNow, marketClock.startedAt) : 0;
  const constraintExpiry = selected?.constraints.state === 'available' ? clientObservationDeadline(selected.constraints.value.expiresAt, marketClock.serverNow, marketClock.startedAt) : 0;
  const reference = selected?.reference.state === 'available' && now < referenceExpiry ? selected.reference.value : null;
  const lastPrice = selected?.reference.state === 'available' ? selected.reference.value : null;
  const hasEnteredRange = !!gridWidth(form.lower, form.upper, String(width));
  // Editable input proposal only; server checks still decide whether the tick/stop is valid.
  const suggestedStop = selected?.constraints.state === 'available'
    ? proposedPlannerStop(form.lower, form.upper, form.side, selected.constraints.value.tick) : null;
  const effectiveStop = form.stop || suggestedStop || '';
  const historyWindow = gridHistoryWindow(form.timeframe, form.rangeWindow)!;
  const invalidate = useCallback(() => { generation.current.preview.invalidate(); setPreview(null); setError(''); }, []);
  const edit = (key: keyof typeof INITIAL, value: string | boolean) => {
    if (draftBusy) return;
    if (key === 'market') {
      const change = gridMarketChange(form, String(value), rangeSource, rangePercent.current);
      priceRefresh.current?.dispose();
      Object.values(generation.current).forEach(g => g.invalidate());
      invalidate(); setDraftPreview(null); setChart(null); setChartError(''); setRangeFacts(null); setRangeError(''); setRangeBusy(false);
      manual.current = { lower: '', upper: '', stop: '' };
      pendingPercent.current = change.mode === 'percent' && value ? { market: String(value), percent: rangePercent.current! } : null;
      applyAutoAfterRefresh.current = change.mode === 'auto' && !!value; setAutoApplying(applyAutoAfterRefresh.current);
      setRangeShortcut(null); setRangeNote(change.note); setForm(change.form); return;
    }
    applyAutoAfterRefresh.current = false;
    setAutoApplying(false);
    priceRefresh.current?.cancelShortcut();
    invalidate();
    if (['lower', 'upper', 'stop'].includes(key)) {
      setRangeSource('manual'); manual.current = { lower: form.lower, upper: form.upper, stop: form.stop, [key]: value } as typeof manual.current;
    }
    if (['lower', 'upper'].includes(key)) { rangePercent.current = null; pendingPercent.current = null; setRangeNote(''); }
    if (['timeframe', 'rangeWindow'].includes(key)) {
      generation.current.range.invalidate(); setRangeFacts(null); setRangeError(''); setRangeBusy(false);
      if (rangeSource === 'auto') { applyAutoAfterRefresh.current = true; setAutoApplying(true); }
    }
    if (['timeframe', 'rangeWindow'].includes(key)) { generation.current.chart.invalidate(); setChart(null); setChartError(''); }
    if (['lower', 'upper'].includes(key)) setRangeShortcut(null);
    setForm(previous => ({ ...previous, [key]: value,
      ...(['timeframe', 'rangeWindow'].includes(key) && rangeSource === 'auto' ? { lower: '', upper: '', stop: '' } : {}),
      ...(key === 'side' && rangeSource === 'auto' && rangeFacts?.range.state === 'available'
        ? { stop: value === 'long' ? rangeFacts.range.longStop : rangeFacts.range.shortStop } : {}) }));
  };
  const refreshObservations = () => {
    if (draftBusy) return;
    setRangeFacts(null);
    priceRefresh.current?.dispose();
    Object.values(generation.current).forEach(g => g.invalidate());
    setPreview(null); setChart(null); setMarkets([]); setError(''); setChartError(''); setNow(Date.now());
    setRefresh(r => r + 1);
  };
  const query = useMemo(() => {
    try {
      const fee = feePercentToRate(form.feePercent);
      const q = new URLSearchParams({ market: form.market, side: form.side, lower: form.lower, upper: form.upper,
        intervals: form.intervals, entryScale: form.entryScale, profitScale: form.profitScale, seed: String(form.seed),
        leverage: form.leverage, investment: form.investment, stop: effectiveStop });
      if (fee !== null) q.set('fee', fee);
      return { value: q.toString(), error: '' };
    } catch (e) { return { value: '', error: (e as Error).message }; }
  }, [form, effectiveStop]);
  useEffect(() => {
    if (!open) return;
    const controller = new PlannerPriceRefresh(form.market,
      signal => readPlanner(form.market ? `markets?${new URLSearchParams({ market: form.market })}` : 'markets', signal, plannerEnabled),
      observation => {
        setMarketClock(observation); setMarkets(observation.markets); setNow(Date.now());
        const pending = pendingPercent.current, market = observation.markets.find(m => m.market === form.market);
        if (pending?.market !== form.market || !market || market.reference.state !== 'available') return;
        const deadline = clientObservationDeadline(market.reference.value.expiresAt, observation.serverNow, observation.startedAt);
        const range = plannerRangeAround(market, deadline, Date.now(), pending.percent);
        if (!range) return;
        pendingPercent.current = null; manual.current = { ...range, stop: manual.current.stop };
        invalidate(); setRangeNote(''); setRangeSource('manual'); setWidth(pending.percent); setRangeShortcut(pending.percent);
        setForm(previous => previous.market === pending.market ? { ...previous, ...range } : previous);
      },
      (busy, reason) => { setMarketLoading(busy); setMarketError(reason); setNow(Date.now()); });
    priceRefresh.current = controller;
    const stop = watchPlannerPrice(controller);
    return () => { stop(); if (priceRefresh.current === controller) priceRefresh.current = null; };
  }, [open, identity, form.market, refresh, plannerEnabled]);
  useEffect(() => { setMarkets([]); setMarketError(''); setNow(Date.now()); }, [open, identity]);
  useEffect(() => {
    if (!open || !form.market) return;
    const request = generation.current.chart.start(); setChart(null); setChartError('');
    const startedAt = Date.now();
    readPlanner(`chart?${new URLSearchParams({ market: form.market, timeframe: form.timeframe, period: form.rangeWindow })}`, request.signal, plannerEnabled).then(value => {
      if (!request.current()) return;
      if (!isPlannerChart(value)) throw new Error('Invalid chart response');
      if (value.state === 'available') {
        if (value.market !== form.market) throw new Error('Invalid chart response');
        if (value.timeframe !== form.timeframe) throw new Error('Invalid chart response');
        if (value.requestedBars !== historyWindow.chartBars) throw new Error('Invalid chart response');
      }
      setChart(value); setChartExpiry(value.state === 'available' ? startedAt + value.validForMs : 0); setNow(Date.now());
    }).catch(e => { if (request.current()) setChartError(e.message); });
    return () => generation.current.chart.invalidate();
  }, [open, identity, form.market, form.timeframe, form.rangeWindow, refresh, chartRefresh, plannerEnabled]);
  useEffect(() => {
    generation.current.preview.invalidate(); setPreview(null); setLoading(false);
    if (!open || !plannerEnabled || !form.market || query.error) return;
    if (!form.lower || !form.upper || !form.investment || !effectiveStop) return;
    const request = generation.current.preview.start(); setLoading(true); setError('');
    const timer = setTimeout(() => {
      const startedAt = Date.now();
      readPlanner(`preview?${query.value}`, request.signal).then(value => {
        if (!request.current()) return;
        if (!isPlannerPreview(value) || value.market.market !== form.market) throw new Error('Invalid preview response');
        // Subtract the whole transit time; client/server wall-clock skew cannot renew authority.
        setPreviewExpiry(startedAt + value.validForMs); setPreview(value); setNow(Date.now());
      }).catch(e => { if (request.current()) setError(e.message); }).finally(() => { if (request.current()) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); generation.current.preview.invalidate(); };
  }, [open, identity, query.value, query.error, refresh, referenceExpiry, constraintExpiry, plannerEnabled]);
  useEffect(() => {
    if (!open) { Object.values(generation.current).forEach(g => g.invalidate()); setPreview(null); setChart(null); setExpandedSettingsPanel('direction-size'); return; }
    const deadlines = [previewExpiry, chartExpiry, referenceExpiry, constraintExpiry, rangeExpiry].filter(t => t > Date.now());
    const timer = deadlines.length ? setTimeout(() => setNow(Date.now()), Math.max(1, Math.min(...deadlines) - Date.now() + 1)) : undefined;
    const wake = () => setNow(Date.now());
    window.addEventListener('focus', wake); document.addEventListener('visibilitychange', wake);
    return () => { clearTimeout(timer); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, [open, now, previewExpiry, chartExpiry, referenceExpiry, constraintExpiry, rangeExpiry]);
  useEffect(() => () => Object.values(generation.current).forEach(g => g.invalidate()), []);
  useEffect(() => {
    if (draftBusy) { priceRefresh.current?.cancelShortcut(); applyAutoAfterRefresh.current = false; }
  }, [draftBusy]);
  useEffect(() => {
    setRangeFacts(null); setRangeError(''); setRangeBusy(false);
    if (!open || !form.market) return;
    const request = generation.current.range.start(), startedAt = Date.now(); setRangeBusy(true);
    readPlanner(`range?${new URLSearchParams({ market: form.market, timeframe: form.timeframe, period: form.rangeWindow })}`, request.signal, plannerEnabled)
      .then(value => {
        if (!request.current()) return;
        const facts = value as RangeFacts;
        if (!facts || facts.state !== 'available' || facts.market !== form.market || facts.timeframe !== form.timeframe
          || facts.requestedBars !== historyWindow.rangeBars || !Number.isFinite(facts.validForMs) || facts.validForMs <= 0 || facts.validForMs > 60_000
          || !isGridRegime(facts.regime, form.market, form.timeframe) || !facts.range
          || !['available', 'unavailable'].includes(facts.range.state)) throw Error('Invalid range advisory response');
        if (facts.range.state === 'available' && ![facts.range.lowerPrice, facts.range.upperPrice, facts.range.longStop, facts.range.shortStop]
          .every(v => typeof v === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && Number(v) > 0 && Number.isFinite(Number(v)))) throw Error('Invalid suggested prices');
        setRangeFacts(facts); setRangeExpiry(startedAt + facts.validForMs); setNow(Date.now());
        if (applyAutoAfterRefresh.current && Date.now() < startedAt + facts.validForMs) {
          applyAutoAfterRefresh.current = false;
          if (facts.range.state === 'unavailable') setRangeError(facts.range.reason);
          else {
            const r = facts.range; invalidate(); setRangeSource('auto'); setTimeRangeApplied(true); setRangeShortcut(null); setRangeNote('');
            setForm(previous => ({ ...previous, lower: r.lowerPrice, upper: r.upperPrice, stop: previous.side === 'long' ? r.longStop : r.shortStop }));
          }
        }
      }).catch(e => { if (request.current()) setRangeError(e.message); })
      .finally(() => { if (request.current()) { setRangeBusy(false); setAutoApplying(false); } });
    return () => generation.current.range.invalidate();
  }, [open, identity, form.market, form.timeframe, form.rangeWindow, refresh, rangeRefresh, plannerEnabled]);
  const autoRange = () => {
    if (draftBusy || rangeBusy) return;
    pendingPercent.current = null; rangePercent.current = null;
    if (!rangeFacts || Date.now() >= rangeExpiry) {
      if (rangeSource === 'manual') manual.current = { lower: form.lower, upper: form.upper, stop: form.stop };
      setRangeSource('auto');
      priceRefresh.current?.cancelShortcut(); applyAutoAfterRefresh.current = true; setAutoApplying(true); setRangeRefresh(v => v + 1); return;
    }
    if (rangeFacts.range.state !== 'available') { setRangeError(rangeFacts.range.reason); return; }
    const r = rangeFacts.range;
    if (rangeSource === 'manual') manual.current = { lower: form.lower, upper: form.upper, stop: form.stop };
    priceRefresh.current?.cancelShortcut(); invalidate(); setRangeShortcut(null); setRangeSource('auto'); setTimeRangeApplied(true); setRangeNote('');
    setForm(previous => ({ ...previous, lower: r.lowerPrice, upper: r.upperPrice, stop: previous.side === 'long' ? r.longStop : r.shortStop }));
  };
  const restoreManual = () => {
    if (draftBusy) return;
    pendingPercent.current = null; rangePercent.current = null; applyAutoAfterRefresh.current = false; setAutoApplying(false);
    priceRefresh.current?.cancelShortcut(); invalidate(); setRangeSource('manual'); setRangeShortcut(null);
    setForm(previous => ({ ...previous, ...manual.current }));
  };
  const resizeManual = (percent: number) => {
    if (draftBusy) return;
    const r = gridWidth(form.lower, form.upper, String(percent)); if (!r) return;
    rangePercent.current = percent; pendingPercent.current = null; applyAutoAfterRefresh.current = false; setAutoApplying(false); setRangeNote('');
    priceRefresh.current?.cancelShortcut(); invalidate(); setWidth(percent); setRangeSource('manual'); setRangeShortcut(null);
    manual.current = { lower: r.lowerPrice, upper: r.upperPrice, stop: form.stop };
    setForm(previous => ({ ...previous, lower: r.lowerPrice, upper: r.upperPrice }));
  };
  const preset = (percent: number) => {
    if (draftBusy) return;
    rangePercent.current = percent; pendingPercent.current = null; applyAutoAfterRefresh.current = false; setAutoApplying(false);
    setRangeSource('manual');
    void priceRefresh.current?.apply(percent, range => {
      setRangeNote('');
      invalidate(); setRangeSource('manual'); manual.current = { ...range, stop: form.stop }; setWidth(percent); setRangeShortcut(percent); setForm(previous => ({ ...previous, ...range }));
    });
  };
  const shortcutReason = plannerShortcutReason(form.market, !!reference, marketError, marketLoading);
  const draftIntent = useMemo(() => gridSetupIntent(form, effectiveStop, rangeSource, timeRangeApplied), [form, effectiveStop, rangeSource, timeRangeApplied]);
  const lines = useMemo(() => createEnabled
    ? draftPreview?.state === 'ready' && now < draftPreview.expiresAt && draftPreview.draftRevision === gridDraftRevision(draftIntent)
      ? draftPreview.plan?.lines ?? [] : []
    : plannerEnabled ? plannerOverlays(preview, previewExpiry, now) : [], [createEnabled, plannerEnabled, preview, previewExpiry, now, draftPreview, draftIntent]);
  const regime = rangeFacts && now < rangeExpiry ? rangeFacts.regime : { state: 'unavailable' as const,
    reason: rangeError || (rangeBusy ? 'Loading finalized candles' : !form.market ? 'Choose a market' : 'Observation expired or unavailable; refresh observations') };
  const displayPlan = preview?.requestedPlan ?? preview?.minimumPlan;
  const stale = preview !== null && now >= previewExpiry;
  const range = useMemo(() => plannerChartRange(form.lower, form.upper, effectiveStop), [form.lower, form.upper, effectiveStop]);
  const numberField = (key: keyof typeof INITIAL, label: string, placeholder?: string) => <div className="space-y-1.5">
    <Label htmlFor={`grid-${key}`}>{label}</Label>
    <Input id={`grid-${key}`} inputMode={key === 'intervals' ? 'numeric' : 'decimal'} value={String(form[key])}
      placeholder={placeholder} onChange={e => edit(key, e.target.value)} />
  </div>;
  const retryChart = () => {
    generation.current.chart.invalidate(); setChart(null); setChartError(''); setChartExpiry(0);
    setChartRefresh(previous => previous + 1);
  };
  const choice = (key: keyof typeof INITIAL, label: string, options: readonly { value: string; label: string }[]) => <div className="space-y-1.5">
    <Label htmlFor={`grid-${key}`}>{label}</Label>
    <Select value={String(form[key])} onValueChange={v => edit(key, v)}>
      <SelectTrigger id={`grid-${key}`}><SelectValue /></SelectTrigger>
      <SelectContent>{options.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
  const feesPanel = (draftDetails?: React.ReactNode) => <fieldset disabled={draftBusy}>
    <DrawerSettingsPanel id="fees" title="Fees & data" icon={Receipt} keepMounted
      expandedPanel={expandedSettingsPanel} setExpandedPanel={setExpandedSettingsPanel} testId="grid-advanced-toggle">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {choice('rangeWindow', 'Range based on:', [{ value: 'day', label: 'Last day' }, { value: 'week', label: 'Last week' }, { value: 'month', label: 'Last month' }])}
        {numberField('feePercent', 'Assumed maker + builder fee per side (%)')}
      </div>
      <p className="text-xs text-muted-foreground">Sizes are in USDC; coin amounts are rounded to Pacifica's minimum step.</p>
      <p className="text-xs text-muted-foreground">The number of levels sets the engine's intervals: 1–100 steps produce 2–101 quantized price lines.</p>
      <p className="text-xs text-muted-foreground">The suggested range covers the highs and lows of this period, with a small buffer.</p>
      <p className="text-xs text-muted-foreground">{ASSUMPTION_LABEL}. Blank = unknown; 0 = your explicit zero-cost assumption.</p>
      <div className="space-y-2 border-t border-border/60 pt-4 text-xs text-muted-foreground">
        <h4 className="font-medium text-foreground">Observation and sizing details</h4>
        {selected ? <>
          <p>{reference ? `Cached Pacifica book reference price: ${readableDecimal(reference.price)} · observed ${readableTime(reference.observedAt)}`
            : `Reference price unavailable: ${selected.reference.state === 'unavailable' ? selected.reference.reason : 'observation expired'}`}</p>
          {selected.constraints.state === 'available' ? <p>Tick {readableDecimal(selected.constraints.value.tick)} · lot {readableDecimal(selected.constraints.value.lot)} base units · opening minimum {readableDecimal(selected.constraints.value.minimumQuote)} USD · observed {readableTime(selected.constraints.value.observedAt)}{now >= constraintExpiry ? ' — observation expired' : ''}. Smallest positive base quantity is derived from the lot lattice.</p>
            : <p>Sizing unavailable: {selected.constraints.reason}</p>}
        </> : <p>Choose a market and refresh observations to see tick and lot details.</p>}
        {preview && <p>Policy model: {preview.policy.ordinaryWindow} ordinary window orders, {preview.policy.requiredAvailableSlots} required available slots including {preview.policy.reserveSlots} reserved, up to 100 intervals / 101 lines; transport batches up to 10. Live available slots and venue resting maximum: unknown. Source: {preview.policy.source}.</p>}
      </div>
      {draftDetails}
    </DrawerSettingsPanel>
  </fieldset>;
  return <Sheet open={open} onOpenChange={value => {
    if (draftBusy) return;
    if (!value) { priceRefresh.current?.dispose(); Object.values(generation.current).forEach(g => g.invalidate()); } onOpenChange(value);
  }}>
    <SheetContent className="w-full sm:max-w-[760px] p-0" data-testid="sheet-grid-planner">
      <div className="h-full overflow-y-auto p-5 sm:p-6 space-y-6">
        <SheetHeader className="text-left pr-6">
          <SheetTitle className="flex items-center gap-2 text-xl"><BarChart3 className="h-5 w-5 text-primary" />Grid Bot</SheetTitle>
          <SheetDescription>Choose a price range and explore your grid before starting a bot.</SheetDescription>
          <Badge variant="secondary" className="w-fit mt-2">{liveEnabled ? 'Review your setup before creating a bot' : PLANNING_BANNER}</Badge>
        </SheetHeader>

        <fieldset disabled={draftBusy} className="space-y-6">
        <section aria-label="Market and price" className="rounded-xl border border-border bg-card/40 p-4 flex flex-col sm:flex-row gap-4 sm:items-start sm:justify-between">
          <div className="space-y-1.5 sm:w-64">
            <Label htmlFor="grid-market">Pacifica market</Label>
            <Select value={form.market} onValueChange={v => edit('market', v === '__clear__' ? '' : v)} disabled={marketLoading}>
              <SelectTrigger id="grid-market"><SelectValue placeholder="Choose a market" /></SelectTrigger>
              <SelectContent><SelectItem value="__clear__">Choose a market</SelectItem>{markets.map(m => <SelectItem key={m.market} value={m.market}>
                {m.market}{m.constraints.state === 'unavailable' ? ' — sizing unavailable' : ''}
              </SelectItem>)}</SelectContent>
            </Select>
            {marketLoading && <p role="status" className="text-xs text-muted-foreground">Refreshing market observations…</p>}
            {marketError && <p role={marketError === PRICE_BUSY_MESSAGE ? 'status' : 'alert'}
              className={marketError === PRICE_BUSY_MESSAGE ? 'text-xs text-muted-foreground' : 'text-sm text-destructive'}>{marketError}</p>}
          </div>
          <div className="space-y-1 sm:text-right sm:max-w-[50%]">
            <p className="text-xs text-muted-foreground">{reference ? 'Price now' : lastPrice ? 'Last observed price' : 'Price'}</p>
            <p className="font-semibold text-xl tabular-nums">{lastPrice ? readableDecimal(lastPrice.price) : 'Unavailable'}</p>
            <p className="text-xs text-muted-foreground">{lastPrice ? <PriceAge observedAt={lastPrice.observedAt} clock={marketClock} />
              : marketError === PRICE_BUSY_MESSAGE ? 'Waiting for a fresh observation.'
              : selected ? `Reference price unavailable: ${selected.reference.state === 'unavailable' ? selected.reference.reason : 'observation expired'}`
              : marketLoading ? 'Refreshing price…' : form.market ? 'Market observation unavailable' : 'Choose a market to see its observed price.'}</p>
            <Button type="button" size="sm" variant="outline" disabled={marketLoading} onClick={refreshObservations}>
              <RefreshCw className="h-3.5 w-3.5 mr-2" />Refresh price
            </Button>
          </div>
        </section>

        <section aria-labelledby="grid-range-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id="grid-range-heading" className="text-sm font-semibold">Your range</h3>
            <div className="flex flex-wrap items-center gap-2">
              <span id="grid-timeframe-label" className="text-xs text-muted-foreground">Candle timeframe</span>
              <div role="group" aria-labelledby="grid-timeframe-label" className="flex gap-1">
                {['15m', '1h', '4h'].map(t => <Button key={t} type="button" size="sm" variant={form.timeframe === t ? 'default' : 'outline'}
                  aria-pressed={form.timeframe === t} onClick={() => edit('timeframe', t)}>{t}</Button>)}
              </div>
              <Button type="button" size="sm" variant="ghost" disabled={marketLoading} onClick={refreshObservations}>Refresh observations</Button>
            </div>
          </div>
          <GridPlannerChart chart={chart} lines={lines} range={range} stale={now >= chartExpiry} hasMarket={!!form.market}
            levelMessage={createEnabled ? lines.length ? 'Authoritative draft preview levels used when saving.' : 'Authoritative draft levels require a fresh validated draft preview.'
              : `Hypothetical planner preview. ${plannerLevelMessage(preview, previewExpiry, now, { ...form, stop: effectiveStop }, loading, query.error || error)}`}
            error={chartError} onRetry={retryChart} loading={!!form.market && !chart && !chartError} />
        </section>

        <DrawerSettingsPanel id="range" title="Range" icon={SlidersHorizontal} keepMounted
          expandedPanel={expandedSettingsPanel} setExpandedPanel={setExpandedSettingsPanel} testId="grid-panel-range-toggle">
          <GridRegimeHint timeframe={form.timeframe} regime={regime} />
          {rangeFacts?.range.state === 'available' && now < rangeExpiry && regime.state === 'unavailable' &&
            <p className="text-xs text-muted-foreground">Auto range uses {rangeFacts.range.includedBars} finalized bars.</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={!form.market || rangeBusy} onClick={autoRange}>Suggest auto-range</Button>
            {rangeSource === 'auto' && <Button type="button" variant="ghost" onClick={restoreManual}>Restore entered range</Button>}
            <span className="text-xs text-muted-foreground self-center">{rangeSource === 'auto' ? 'Auto' : 'Manual'}</span>
          </div>
          {rangeError && <p role="status" className="text-xs text-muted-foreground">{rangeError}</p>}
          {rangeNote && <p role="status" className="text-xs text-muted-foreground">{rangeNote}</p>}
          {createEnabled && rangeSource === 'auto' && timeRangeApplied &&
            <p className="text-xs text-muted-foreground">The suggested prices will be saved as an entered range.</p>}
          {rangeFacts?.range.state === 'unavailable' && now < rangeExpiry && !rangeError &&
            <p role="status" className="text-xs text-muted-foreground">{rangeFacts.range.reason}</p>}
          <div className="grid grid-cols-3 gap-2" aria-label="Range presets">
            {RANGE_PRESETS.map(p => <Button key={p.percent} type="button" variant="outline" disabled={!!shortcutReason} aria-describedby="grid-shortcut-hint"
              aria-pressed={rangeShortcut === p.percent} onClick={() => preset(p.percent)}
              className={`h-auto min-h-14 flex-col whitespace-normal px-1 py-2 ${rangeShortcut === p.percent ? 'border-primary/50 bg-primary/10' : ''}`}>
              <span className="font-medium">{p.label}</span>
            </Button>)}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{numberField('lower', 'Lower price')}{numberField('upper', 'Upper price')}</div>
          <div className="rounded-lg border border-border/60 px-3 py-3 space-y-3">
            <div className="flex items-center justify-between gap-2"><Label htmlFor="grid-width">Range width</Label>
              <span className="text-xs text-muted-foreground">±{width}%</span></div>
            <Slider id="grid-width" aria-label="Range half-width percent" min={1} max={40} step={0.5} value={[width]}
              disabled={!hasEnteredRange && !!shortcutReason} aria-describedby="grid-shortcut-hint"
              onValueChange={([value]) => hasEnteredRange ? resizeManual(value) : preset(value)} />
            <p id="grid-shortcut-hint" className="text-xs text-muted-foreground">{hasEnteredRange
              ? 'Around your entered range midpoint. Presets use the current price.'
              : shortcutReason || 'Around the current price. Enter both prices to resize around their midpoint.'}</p>
          </div>
        </DrawerSettingsPanel>

        <DrawerSettingsPanel id="direction-size" title="Order" icon={ArrowUpDown} keepMounted
          expandedPanel={expandedSettingsPanel} setExpandedPanel={setExpandedSettingsPanel} testId="grid-panel-direction-size-toggle">
        <section aria-label="Direction and investment" className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5"><Label id="grid-side-label">Direction</Label>
            <GridDirectionBadge active={open} identity={identity}/>
            <div role="group" aria-labelledby="grid-side-label" className="flex gap-2 rounded-lg border border-border/60 bg-card/40 p-1">
              {['long', 'short'].map(side => <Button key={side} type="button" className="flex-1" variant={form.side === side ? 'default' : 'ghost'}
                aria-pressed={form.side === side} onClick={() => edit('side', side)}>{side === 'long' ? 'Long' : 'Short'}</Button>)}
            </div>
          </div>
          <div className="space-y-1.5">{numberField('investment', 'Investment (USDC)', '100.00')}
            <p className="text-xs text-muted-foreground">Use 0.01 USDC increments.</p></div>
        </section>
        <section aria-label="Leverage" className="space-y-2">
          <div className="flex items-end justify-between gap-3"><Label htmlFor="grid-leverage">Leverage</Label>
            <div className="flex items-center gap-2"><Input id="grid-leverage" className="w-24" inputMode="decimal" value={form.leverage}
              onChange={e => edit('leverage', e.target.value)} /><span className="text-sm text-muted-foreground">×</span></div></div>
          <div className="grid grid-cols-5 gap-2">{['1', '2', '3', '5', '10'].map(value => <Button key={value} type="button" variant="outline"
            aria-pressed={form.leverage === value} className={`px-1 ${form.leverage === value ? 'border-primary/50 bg-primary/10' : ''}`}
            onClick={() => edit('leverage', value)}>{value}×</Button>)}</div>
        </section>

          {numberField('intervals', 'Number of grids (1–100)')}
        </DrawerSettingsPanel>

        <DrawerSettingsPanel id="stop" title="Stop loss" icon={Shield} keepMounted
          expandedPanel={expandedSettingsPanel} setExpandedPanel={setExpandedSettingsPanel} testId="grid-panel-stop-toggle">
          {numberField('stop', 'Custom stop price', suggestedStop ?? 'Enter a proposed stop')}
          <p className="text-xs text-muted-foreground">{form.stop ? 'Your custom stop must align to the venue tick and lie beyond the loss side of the range.'
            : suggestedStop ? `Suggested stop: ${readableDecimal(suggestedStop)}. It is 3% beyond the loss side of your range, rounded outwards to the observed tick.`
            : 'A proposed stop needs observed sizing, or enter a custom stop price.'} A blank custom stop uses the suggested price. Liquidation reachability is unknown.</p>
        </DrawerSettingsPanel>

        <DrawerSettingsPanel id="orders" title="Sizing" icon={Layers} keepMounted
          expandedPanel={expandedSettingsPanel} setExpandedPanel={setExpandedSettingsPanel} testId="grid-panel-orders-toggle">
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3">
              <div className="space-y-1"><Label htmlFor="grid-seed">Start with a position</Label>
                <p className="text-xs text-muted-foreground">When the bot starts, it opens a position at the entry price and takes profit on it bit by bit as price moves your way. Off: the bot only places grid orders.</p>
                <p className="text-xs text-muted-foreground">The taker fee for opening it isn't included.</p></div>
              <Switch id="grid-seed" checked={form.seed} onCheckedChange={v => edit('seed', v)} />
            </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <GridPlannerSizeSelect id="grid-entryScale" label="Grid order sizes" value={form.entryScale} side={form.side} onChange={value => edit('entryScale', value)} />
              <GridPlannerSizeSelect id="grid-profitScale" label="Take-profit sizes" value={form.profitScale} side={form.side}
                startingPosition enabled={form.seed} onChange={value => edit('profitScale', value)} />
          </div>
        </DrawerSettingsPanel>

        {plannerEnabled && <section aria-labelledby="grid-plan-heading" className="rounded-xl border border-primary/20 bg-card/40 p-4 sm:p-5 space-y-4">
          <h3 id="grid-plan-heading" className="text-sm font-semibold">Your plan</h3>
          {(query.error || error) && <p role="alert" className="text-sm text-destructive">{query.error || error}</p>}
          {loading ? <p role="status" className="text-sm">Calculating hypothetical geometry…</p>
            : preview ? <p role="status" className="text-sm font-medium">{stale ? 'Observation expired — refresh before using this preview'
              : preview.state === 'rejected' ? 'Requested plan rejected' : preview.state === 'unavailable' ? 'Preview unavailable'
              : preview.state === 'diagnostic' ? 'Diagnostic geometry — some checks unavailable' : 'Hypothetical checks passed'}</p>
            : <p className="text-sm text-muted-foreground">Choose a market, range and investment to see your plan.{!effectiveStop && ' A proposed stop needs observed sizing, or enter one in Stop loss settings.'}</p>}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div><dt className="text-xs text-muted-foreground">Price levels</dt><dd className="font-medium mt-1">{displayPlan ? `${displayPlan.lines.length} price lines` : 'Awaiting preview'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Range you chose</dt><dd className="font-medium mt-1 break-words">{range ? `${readableDecimal(range.lower)} – ${readableDecimal(range.upper)}` : 'Enter lower and upper prices'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Proposed stop</dt><dd className="font-medium mt-1 break-words">{effectiveStop ? `${readableDecimal(effectiveStop)}${form.stop ? ' · custom' : ' · suggested'}` : 'Unavailable'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Grid order sizes</dt><dd className="font-medium mt-1">{ORDER_SIZES.find(o => o.value === form.entryScale)?.label}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Minimum capital for this geometry</dt><dd className="font-medium mt-1">{preview ? preview.minimum.state === 'available' ? `${readableDecimal(preview.minimum.value)} USDC` : `Unavailable — ${preview.minimum.reason}` : 'Awaiting preview'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Minimum with your fee assumption</dt><dd className="font-medium mt-1">{preview ? preview.assumedMinimum.state === 'available' ? `${readableDecimal(preview.assumedMinimum.value)} USDC` : `Unavailable — ${preview.assumedMinimum.reason}` : form.feePercent === '' ? 'Unknown — no fee assumed' : 'Awaiting preview'}</dd></div>
          </dl>
          <p className="text-xs text-muted-foreground">{form.stop ? 'Your custom stop must align to the venue tick and lie beyond the loss side of the range.'
            : 'The suggested stop is 3% beyond the loss side of your range, rounded outwards to the observed tick. Change it in Stop loss settings.'} Liquidation reachability is unknown.</p>
          {preview?.reasons.map((reason, i) => <p key={i} className="text-xs text-muted-foreground">{reason}</p>)}
          <p className="text-xs text-muted-foreground">{preview?.fee.state === 'unknown' || form.feePercent === '' ? 'Fee unknown — fee gate was not evaluated.' : ASSUMPTION_LABEL} Taker fees for a starting position, slippage, venue fee rounding and funding are unavailable. {preview?.stop.reason}</p>
          <p className="text-xs text-muted-foreground">No profit or fill forecasts. Minimum capital uses a 0.01 USDC display quantum and no modeled transfer floor; it does not establish funding, liquidation safety, live capacity or executable partial fills. This hypothetical plan does not establish live capacity or balances; draft funds are checked separately below.</p>

          {displayPlan && <details className="border-t border-border/60 pt-3">
            <summary className="cursor-pointer text-sm font-medium">View all quantized levels and quantities</summary>
            <p className="text-xs text-muted-foreground mt-3">{stale && 'Expired observation. '}{preview?.minimumPlan ? 'Diagnostic quantities at the minimum investment; not sized at your requested investment.' : 'Quantities sized at your requested investment.'} Starting position quantity: {readableDecimal(displayPlan.seedQuantity)} base units.</p>
            <div className="overflow-x-auto max-h-72 mt-2"><table className="w-full text-xs text-left">
              <caption className="text-left py-2">Hypothetical levels ({displayPlan.lines.length} price lines)</caption>
              <thead><tr><th className="p-2">Level</th><th className="p-2">Price</th><th className="p-2">Base quantity</th><th className="p-2">Role</th></tr></thead>
              <tbody>{displayPlan.lines.map(line => <tr key={line.ordinal} className="border-t border-border/60">
                <td className="p-2">{line.ordinal + 1}</td><td className="p-2 tabular-nums">{readableDecimal(line.price)}</td><td className="p-2 tabular-nums">{readableDecimal(line.quantity)}</td>
                <td className="p-2">{line.role === 'entry' ? 'Entry' : line.role === 'seed_exit' ? 'Take-profit (starting position)' : 'Virtual line'}</td>
              </tr>)}</tbody>
            </table></div>
          </details>}
          {!!preview?.feeRows.length && <details className="border-t border-border/60 pt-3">
            <summary className="cursor-pointer text-sm font-medium">View fee assumption checks</summary>
            <div className="overflow-x-auto mt-2"><table className="w-full text-xs text-left">
              <caption className="text-left py-2">Assumed fees on equal-quantity pairs — {ASSUMPTION_LABEL}</caption>
              <thead><tr><th className="p-2">Entry → exit</th><th className="p-2">Spread</th><th className="p-2">Required spread</th><th className="p-2">Assumed round-trip fee (USDC)</th><th className="p-2">Check</th></tr></thead>
              <tbody>{preview.feeRows.map(row => <tr key={row.ordinal} className="border-t border-border/60">
                <td className="p-2">{readableDecimal(row.entryPrice)} → {readableDecimal(row.exitPrice)}</td><td className="p-2">{readableDecimal(row.spread)}</td>
                <td className="p-2">{readableDecimal(row.requiredSpread)}</td><td className="p-2">{readableDecimal(row.assumedRoundTripFee)}</td><td className="p-2">{row.clears ? 'Clears assumption' : 'Fails assumption'}</td>
              </tr>)}</tbody>
            </table></div>
          </details>}
        </section>}

        </fieldset>
        {createEnabled && <GridDraftActions open={open} intent={draftIntent} onSaved={onSaved} onBusyChange={setDraftBusy}
          onPreview={setDraftPreview} liveEnabled={liveEnabled} rangeBusy={autoApplying} renderDetails={feesPanel} />}
        {!createEnabled && feesPanel()}
        <p className="text-center text-xs text-muted-foreground pb-2">{liveEnabled ? 'Creating a bot saves this reviewed setup through the existing draft path.' : PLANNING_BANNER}</p>
      </div>
    </SheetContent>
  </Sheet>;
}

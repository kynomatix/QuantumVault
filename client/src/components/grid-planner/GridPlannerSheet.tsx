import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, RefreshCw, SlidersHorizontal, ArrowUpDown, Shield, Layers, Receipt } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { DrawerSettingsPanel } from '@/components/ui/settings-panel';
import { walletAuthHeaders } from '@/lib/queryClient';
import { plannerFeeDefault, type PlannerFee } from '../../../../shared/planner-fee';
import { readPlannerFee, plannerFeePercent, plannerFeeLabel, PACIFICA_FEE_SOURCE } from '@/lib/planner-fee-view';
import { ASSUMPTION_LABEL, plannerPreviewQuery, plannerGridCountHint, plannerOrderSizeSummary, plannerOpeningMinimumSummary, PlannerRequestGeneration, isPlannerChart, plannerIssue, plannerMinimumRows,
  isPlannerPreview, plannerOverlays, plannerLevelMessage, plannerVenueChecks, plannerStatus, readableDecimal, readableTime, clientObservationDeadline,
  RANGE_PRESETS, ORDER_SIZES, plannerShortcutReason, proposedPlannerStop, plannerChartRange, plannerRangeAround,
  type PlannerChart, type PlannerMarket, type PlannerPreview } from '@/lib/grid-planner-view';
import { GridPlannerChart } from './GridPlannerChart';
import { GridPlanIssues } from './GridPlanIssues';
import { GridPlannerSizeSelect } from './GridPlannerSizeSelect';
import { GridDirectionSignals } from './GridDirectionSignals';
import { PlannerPriceRefresh, watchPlannerPrice, PRICE_BUSY_MESSAGE } from '@/lib/planner-price-refresh';

import { GRID_SETUP_INITIAL as INITIAL, gridSetupForm, gridSetupIntent, isGridRegime, gridMarketChange,
  gridStoredMarket, gridRememberMarket, gridAvailableMarket } from '@/lib/grid-setup-view';
import { gridHistoryWindow } from '../../../../shared/grid-lookback';
import { gridDraftRevision, gridWidth, type GridDraftPreview } from '@/lib/grid-draft-view';
import { GridDraftActions, type GridDraftContent } from '../grid-bot/GridDraftActions';
import { GridRegimeHint } from './GridRegimeHint';
import { GridRangingFinder } from './GridRangingFinder';
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
  const [form, setForm] = useState(() => gridSetupForm(initialIntent, gridStoredMarket(identity))), [markets, setMarkets] = useState<PlannerMarket[]>([]);
  const [feeDefault, setFeeDefault] = useState<PlannerFee>(null);
  const feeEdited = useRef(false);
  const [feeWasEdited, setFeeWasEdited] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    feeEdited.current = false; setFeeWasEdited(false); setFeeDefault(null);
    setForm(current => ({ ...current, feePercent: '' }));
    const apply = (fee: PlannerFee) => {
      if (controller.signal.aborted) return;
      setFeeDefault(fee);
      if (!feeEdited.current) setForm(current => ({ ...current, feePercent: plannerFeePercent(fee) }));
    };
    fetch('/api/exchange/planner-fee', { credentials: 'include', headers: walletAuthHeaders(), signal: controller.signal })
      .then(async response => { if (!response.ok) throw Error('Fee unavailable'); return response.json(); })
      .then(value => apply(readPlannerFee(value))).catch(() => apply(plannerFeeDefault(null)));
    return () => controller.abort();
  }, [open, identity, initialIntent]);
  const defaultMarketPendingRef = useRef(!initialIntent);
  const [defaultMarketPending, setDefaultMarketPending] = useState(defaultMarketPendingRef.current);
  const observationKey = JSON.stringify([open, identity, form.market, form.timeframe, form.rangeWindow, plannerEnabled]);
  const observationInputKey = useRef(observationKey);
  observationInputKey.current = observationKey;
  const [previewResult, setPreview] = useState<{ inputKey: string; value: PlannerPreview } | null>(null);
  const [chartResult, setChart] = useState<{ inputKey: string; value: PlannerChart } | null>(null);
  const chart = chartResult?.inputKey === observationKey ? chartResult.value : null;
  const previewInputKey = useRef('');
  const [error, setError] = useState(''), [marketError, setMarketError] = useState(''), [chartError, setChartError] = useState('');
  const [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [clock, setNow] = useState(Date.now());
  // Rendering can lag a timer callback past another deadline; never draw using its older clock sample.
  const now = Math.max(clock, Date.now());
  const [chartRefresh, setChartRefresh] = useState(0);
  const [previewExpiry, setPreviewExpiry] = useState(0), [chartExpiry, setChartExpiry] = useState(0);
  const [marketClock, setMarketClock] = useState({ serverNow: 0, startedAt: 0 });
  const [expandedSettingsPanel, setExpandedSettingsPanel] = useState<string | null>('direction-size'), [marketLoading, setMarketLoading] = useState(false);
  const [width, setWidth] = useState(10), [rangeShortcut, setRangeShortcut] = useState<number | null>(null);
  const [rangeSource, setRangeSource] = useState<'manual' | 'auto'>(initialIntent?.rangeSource ?? 'auto');
  const [timeRangeApplied, setTimeRangeApplied] = useState(false);
  const manual = useRef<{ lower: string; upper: string; stop: string } | null>(initialIntent && initialIntent.rangeSource !== 'auto'
    ? { lower: form.lower, upper: form.upper, stop: form.stop } : null);
  const rangePercent = useRef<number | null>(null);
  const pendingPercent = useRef<{ market: string; percent: number } | null>(null);
  const [rangeNote, setRangeNote] = useState('');
  const [draftBusy, setDraftBusy] = useState(false), [draftPreview, setDraftPreview] = useState<GridDraftPreview | null>(null);
  const [rangeResult, setRangeFacts] = useState<{ inputKey: string; value: RangeFacts } | null>(null), [rangeExpiry, setRangeExpiry] = useState(0);
  const rangeFacts = rangeResult?.inputKey === observationKey ? rangeResult.value : null;
  const [rangeBusy, setRangeBusy] = useState(false), [rangeError, setRangeError] = useState('');
  const [autoApplying, setAutoApplying] = useState(!initialIntent);
  const [rangeRefresh, setRangeRefresh] = useState(0);
  const applyAutoAfterRefresh = useRef(!initialIntent);
  const generation = useRef({ range: new PlannerRequestGeneration(), markets: new PlannerRequestGeneration(), chart: new PlannerRequestGeneration(), preview: new PlannerRequestGeneration() });
  const priceRefresh = useRef<PlannerPriceRefresh | null>(null);
  const selected = markets.find(m => m.market === form.market);
  const referenceExpiry = selected?.reference.state === 'available' ? clientObservationDeadline(selected.reference.value.expiresAt, marketClock.serverNow, marketClock.startedAt) : 0;
  const constraintExpiry = selected?.constraints.state === 'available' ? clientObservationDeadline(selected.constraints.value.expiresAt, marketClock.serverNow, marketClock.startedAt) : 0;
  const reference = selected?.reference.state === 'available' && now < referenceExpiry ? selected.reference.value : null;
  const lastPrice = selected?.reference.state === 'available' ? selected.reference.value : null;
  const hasEnteredRange = !!gridWidth(form.lower, form.upper, String(width));
  const hasManualRange = manual.current !== null && !!gridWidth(manual.current.lower, manual.current.upper, String(width));
  // Editable input proposal only; server checks still decide whether the tick/stop is valid.
  const suggestedStop = selected?.constraints.state === 'available'
    ? proposedPlannerStop(form.lower, form.upper, form.side, selected.constraints.value.tick) : null;
  const effectiveStop = form.stop || suggestedStop || '';
  const historyWindow = gridHistoryWindow(form.timeframe, form.rangeWindow)!;
  const invalidate = useCallback(() => { generation.current.preview.invalidate(); setPreview(null); setError(''); }, []);
  useEffect(() => {
    if (open) return;
    // A retained sheet gets one new automatic suggestion on its next open.
    applyAutoAfterRefresh.current = !initialIntent; setAutoApplying(!initialIntent);
    if (initialIntent) return;
    defaultMarketPendingRef.current = true; setDefaultMarketPending(true);
    manual.current = null;
    rangePercent.current = null; pendingPercent.current = null;
    setRangeSource('auto'); setTimeRangeApplied(false); setRangeShortcut(null); setRangeNote('');
    setForm(gridSetupForm(undefined, gridStoredMarket(identity)));
  }, [open, identity, initialIntent]);
  const edit = (key: keyof typeof INITIAL, value: string | boolean) => {
    if (draftBusy) return;
    if (key === 'feePercent') { feeEdited.current = true; setFeeWasEdited(true); }
    if (key === 'market') {
      defaultMarketPendingRef.current = false;
      setDefaultMarketPending(false);
      const change = gridMarketChange(form, String(value), rangeSource, rangePercent.current);
      priceRefresh.current?.dispose();
      Object.values(generation.current).forEach(g => g.invalidate());
      invalidate(); setDraftPreview(null); setChart(null); setChartError(''); setMarketError(''); setRangeFacts(null); setRangeError(''); setRangeBusy(false);
      manual.current = null;
      pendingPercent.current = change.mode === 'percent' && value ? { market: String(value), percent: rangePercent.current! } : null;
      applyAutoAfterRefresh.current = change.mode === 'auto' && !!value; setAutoApplying(applyAutoAfterRefresh.current);
      setRangeShortcut(null); setRangeNote(change.note); setForm(change.form); return;
    }
    priceRefresh.current?.cancelShortcut();
    invalidate();
    if (['lower', 'upper', 'stop'].includes(key)) {
      applyAutoAfterRefresh.current = false; setAutoApplying(false);
      setRangeSource('manual'); manual.current = { lower: form.lower, upper: form.upper, stop: form.stop, [key]: value } as NonNullable<typeof manual.current>;
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
  useEffect(() => {
    if (open) gridRememberMarket(identity, form.market);
  }, [open, identity, form.market]);
  useEffect(() => {
    if (!open || !defaultMarketPending || !markets.length || draftBusy) return;
    const market = gridAvailableMarket(form.market, markets);
    // Use the existing ticker-change handler so any edits made while the list loaded are reset normally.
    if (market !== form.market) { edit('market', market); return; }
    defaultMarketPendingRef.current = false;
    setDefaultMarketPending(false);
  }, [open, identity, defaultMarketPending, markets, form.market, draftBusy]);
  const refreshObservations = () => {
    if (draftBusy) return;
    priceRefresh.current?.dispose();
    Object.values(generation.current).forEach(g => g.invalidate());
    setError(''); setChartError(''); setNow(Date.now());
    setRefresh(r => r + 1);
  };
  const query = useMemo(() => plannerPreviewQuery(form, effectiveStop), [form, effectiveStop]);
  previewInputKey.current = query.value;
  // Hide mismatched results in this render, before effect cleanup can abort the previous request.
  const preview = !query.error && previewResult?.inputKey === query.value ? previewResult.value : null;
  useEffect(() => {
    if (!open) return;
    let obsoleteDefault = false, marketReadSucceeded = false;
    const controller = new PlannerPriceRefresh(form.market,
      // Discover the complete list first: a delisted remembered market would make a targeted read return 404.
      // The ref changes the next scheduled read without restarting this controller after validation.
      signal => readPlanner(!defaultMarketPendingRef.current && form.market ? `markets?${new URLSearchParams({ market: form.market })}` : 'markets', signal, plannerEnabled),
      observation => {
        marketReadSucceeded = true;
        // Suppress only the delisted default's missing-price status while applying its live fallback.
        obsoleteDefault = defaultMarketPendingRef.current && observation.markets.length > 0
          && !observation.markets.some(m => m.market === form.market);
        setMarketClock(observation); setMarkets(observation.markets); setNow(Date.now());
        const pending = pendingPercent.current, market = observation.markets.find(m => m.market === form.market);
        if (pending?.market !== form.market || !market || market.reference.state !== 'available') return;
        const deadline = clientObservationDeadline(market.reference.value.expiresAt, observation.serverNow, observation.startedAt);
        const range = plannerRangeAround(market, deadline, Date.now(), pending.percent);
        if (!range) return;
        pendingPercent.current = null; manual.current = { ...range, stop: manual.current?.stop ?? '' };
        invalidate(); setRangeNote(''); setRangeSource('manual'); setWidth(pending.percent); setRangeShortcut(pending.percent);
        setForm(previous => previous.market === pending.market ? { ...previous, ...range } : previous);
      },
      (busy, reason) => {
        if (busy) marketReadSucceeded = false;
        setMarketLoading(busy); setMarketError(obsoleteDefault ? '' : reason); setNow(Date.now());
        if (!busy && reason && !marketReadSucceeded && !obsoleteDefault) { applyAutoAfterRefresh.current = false; setAutoApplying(false); }
      });
    priceRefresh.current = controller;
    const stop = watchPlannerPrice(controller);
    return () => { stop(); if (priceRefresh.current === controller) priceRefresh.current = null; };
  }, [open, identity, form.market, refresh, plannerEnabled]);
  useEffect(() => { setMarkets([]); setPreview(null); setDraftPreview(null); setChart(null); setRangeFacts(null); setMarketError(''); setNow(Date.now()); }, [open, identity]);
  useEffect(() => {
    setChart(current => current?.inputKey === observationKey ? current : null);
    setRangeFacts(current => current?.inputKey === observationKey ? current : null);
  }, [observationKey]);
  useEffect(() => {
    if (!open || defaultMarketPending || !form.market) return;
    const request = generation.current.chart.start(observationKey); setChartError('');
    const startedAt = Date.now();
    readPlanner(`chart?${new URLSearchParams({ market: form.market, timeframe: form.timeframe, period: form.rangeWindow })}`, request.signal, plannerEnabled).then(value => {
      if (!request.current(observationInputKey.current)) return;
      if (!isPlannerChart(value)) throw new Error('Invalid chart response');
      if (value.state === 'available') {
        if (value.market !== form.market) throw new Error('Invalid chart response');
        if (value.timeframe !== form.timeframe) throw new Error('Invalid chart response');
        if (value.requestedBars !== historyWindow.chartBars) throw new Error('Invalid chart response');
      }
      if (value.state === 'available') { setChart({ inputKey: observationKey, value }); setChartExpiry(startedAt + value.validForMs); }
      else { setChart(current => current?.inputKey === observationKey && current.value.state === 'available' ? current : { inputKey: observationKey, value }); setChartError(value.reason); }
      setNow(Date.now());
    }).catch(e => { if (request.current(observationInputKey.current)) setChartError(e.message); });
    return () => generation.current.chart.invalidate();
  }, [open, identity, form.market, form.timeframe, form.rangeWindow, refresh, chartRefresh, plannerEnabled, defaultMarketPending]);
  useEffect(() => {
    generation.current.preview.invalidate(); setLoading(false);
    if (!open || defaultMarketPending || !plannerEnabled || !form.market || query.error) return;
    if (!form.lower || !form.upper || (form.investment && !effectiveStop)) return;
    const request = generation.current.preview.start(query.value);
    const current = () => request.current(previewInputKey.current);
    setLoading(true); setError('');
    const timer = setTimeout(() => {
      const startedAt = Date.now();
      readPlanner(`preview?${query.value}`, request.signal).then(value => {
        if (!current()) return;
        if (!isPlannerPreview(value) || value.market.market !== form.market) throw new Error('Invalid preview response');
        // Subtract the whole transit time; client/server wall-clock skew cannot renew authority.
        setPreviewExpiry(startedAt + value.validForMs); setPreview({ inputKey: query.value, value }); setNow(Date.now());
      }).catch(e => { if (current()) setError(e.message); }).finally(() => { if (current()) setLoading(false); });
    }, 250);
    return () => { clearTimeout(timer); generation.current.preview.invalidate(); };
  }, [open, identity, query.value, query.error, refresh, referenceExpiry, constraintExpiry, plannerEnabled, defaultMarketPending]);
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
    setRangeError(''); setRangeBusy(false);
    if (!open || defaultMarketPending || !form.market) return;
    const request = generation.current.range.start(observationKey), startedAt = Date.now(); setRangeBusy(true);
    const current = () => request.current(observationInputKey.current);
    readPlanner(`range?${new URLSearchParams({ market: form.market, timeframe: form.timeframe, period: form.rangeWindow })}`, request.signal, plannerEnabled)
      .then(value => {
        if (!current()) return;
        const facts = value as RangeFacts;
        if (!facts || facts.state !== 'available' || facts.market !== form.market || facts.timeframe !== form.timeframe
          || facts.requestedBars !== historyWindow.rangeBars || !Number.isFinite(facts.validForMs) || facts.validForMs <= 0 || facts.validForMs > 60_000
          || !isGridRegime(facts.regime, form.market, form.timeframe) || !facts.range
          || !['available', 'unavailable'].includes(facts.range.state)) throw Error('Invalid range advisory response');
        if (facts.range.state === 'available' && ![facts.range.lowerPrice, facts.range.upperPrice, facts.range.longStop, facts.range.shortStop]
          .every(v => typeof v === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(v) && Number(v) > 0 && Number.isFinite(Number(v)))) throw Error('Invalid suggested prices');
        setRangeFacts({ inputKey: observationKey, value: facts }); setRangeExpiry(startedAt + facts.validForMs); setNow(Date.now());
        const apply = applyAutoAfterRefresh.current;
        applyAutoAfterRefresh.current = false;
        if (apply) {
          if (Date.now() >= startedAt + facts.validForMs) setRangeError('Range observation expired; refresh chart');
          else if (facts.range.state === 'unavailable') setRangeError(facts.range.reason);
          else {
            const r = facts.range; invalidate(); setRangeSource('auto'); setTimeRangeApplied(true); setRangeShortcut(null); setRangeNote('');
            setForm(previous => ({ ...previous, lower: r.lowerPrice, upper: r.upperPrice, stop: previous.side === 'long' ? r.longStop : r.shortStop }));
          }
        }
      }).catch(e => { if (current()) { applyAutoAfterRefresh.current = false; setRangeError(e.message); } })
      .finally(() => { if (current()) { setRangeBusy(false); setAutoApplying(false); } });
    return () => generation.current.range.invalidate();
  }, [open, identity, form.market, form.timeframe, form.rangeWindow, refresh, rangeRefresh, plannerEnabled, defaultMarketPending]);
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
    if (draftBusy || !hasManualRange || !manual.current) return;
    const entered = manual.current;
    pendingPercent.current = null; rangePercent.current = null; applyAutoAfterRefresh.current = false; setAutoApplying(false);
    priceRefresh.current?.cancelShortcut(); invalidate(); setRangeSource('manual'); setRangeShortcut(null);
    setForm(previous => ({ ...previous, ...entered }));
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
  const usingPlannerGeometry = !form.investment && plannerEnabled;
  const lines = useMemo(() => createEnabled && !usingPlannerGeometry
    ? draftPreview?.state === 'ready' && draftPreview.draftRevision === gridDraftRevision(draftIntent)
      ? draftPreview.plan?.lines ?? [] : []
    // Held levels are display only. Expiry still governs shortcuts and draft actions.
    : plannerEnabled ? plannerOverlays(preview, Infinity, now) : [], [createEnabled, usingPlannerGeometry, plannerEnabled, preview, previewExpiry, now, draftPreview, draftIntent]);
  const regime = rangeFacts && now < rangeExpiry ? rangeFacts.regime : { state: 'unavailable' as const,
    reason: rangeError || (rangeBusy ? 'Loading finalized candles' : !form.market ? 'Choose a market' : 'Observation expired or unavailable; refresh chart') };
  const displayPlan = preview?.requestedPlan ?? preview?.minimumPlan;
  const stale = preview !== null && preview.validForMs > 0 && now >= previewExpiry;
  const showIssue = (reason: string) => {
    const issue = plannerIssue(reason);
    setExpandedSettingsPanel(issue.panel);
    requestAnimationFrame(() => {
      const target = issue.field ? document.getElementById(issue.field)
        : document.querySelector<HTMLElement>('[data-testid="grid-advanced-toggle"]');
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target?.focus({ preventScroll: true });
    });
  };
  const issues = [...new Set([query.error || error, ...(preview?.reasons ?? [])].filter(Boolean))];
  const range = useMemo(() => plannerChartRange(form.lower, form.upper, effectiveStop), [form.lower, form.upper, effectiveStop]);
  const numberField = (key: keyof typeof INITIAL, label: string, placeholder?: string) => <div className="space-y-1.5">
    <Label htmlFor={`grid-${key}`}>{label}</Label>
    <Input id={`grid-${key}`} inputMode={key === 'intervals' ? 'numeric' : 'decimal'} value={String(form[key])}
      placeholder={placeholder} onChange={e => edit(key, e.target.value)} />
  </div>;
  const retryChart = () => {
    generation.current.chart.invalidate(); setChartError('');
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
        {numberField('feePercent', 'Maker fee per side (%)')}
      </div>
      <p className="text-xs text-muted-foreground">{feeWasEdited ? 'Your edited maker fee assumption' : plannerFeeLabel(feeDefault)}.
        {feeDefault?.source === 'published' && <> <a href={PACIFICA_FEE_SOURCE} target="_blank" rel="noreferrer" className="underline">Pacifica fee schedule</a></>}
        {' '}You can edit this fee. Builder fees are not included.</p>
      <p className="text-xs text-muted-foreground">Sizes are in USDC; coin amounts are rounded to the exchange's minimum step.</p>
      <p className="text-xs text-muted-foreground">The suggested range covers the highs and lows of this period, with a small buffer.</p>
      <p className="text-xs text-muted-foreground">{ASSUMPTION_LABEL}. Blank = unknown; 0 = your explicit zero-cost assumption.</p>
      <div className="space-y-2 border-t border-border/60 pt-4 text-xs text-muted-foreground">
        <h4 className="font-medium text-foreground">Observation and sizing details</h4>
        {selected ? <>
          <p>{reference ? `Cached Pacifica book reference price: ${readableDecimal(reference.price)} · observed ${readableTime(reference.observedAt)}`
            : `Reference price unavailable: ${selected.reference.state === 'unavailable' ? selected.reference.reason : 'observation expired'}`}</p>
          {selected.constraints.state === 'available' ? <p>Tick {readableDecimal(selected.constraints.value.tick)} · lot {readableDecimal(selected.constraints.value.lot)} base units · opening minimum {readableDecimal(selected.constraints.value.minimumQuote)} USD · observed {readableTime(selected.constraints.value.observedAt)}{now >= constraintExpiry ? ' — observation expired' : ''}. Smallest positive base quantity is derived from the lot lattice.</p>
            : <p>Sizing unavailable: {selected.constraints.reason}</p>}
        </> : <p>Choose a market and refresh its price to see the exchange's price and quantity steps.</p>}
        {selected && plannerVenueChecks(selected).map(row => <p key={row.label}>{row.label}: {row.value}</p>)}
        {preview && <p>Policy model: up to {preview.policy.ordinaryWindow} ordinary resting orders. A full window needs {preview.policy.requiredAvailableSlots} available slots including {preview.policy.reserveSlots} reserved; observed capacity can require a smaller window. Up to {preview.policy.maximumIntervals} grids; transport batches up to {preview.policy.transportBatch}. Live available slots and venue resting maximum: unknown. Source: {preview.policy.source}.</p>}
      </div>
      {draftDetails}
    </DrawerSettingsPanel>
  </fieldset>;
  const handleOpenChange = (value: boolean) => {
    if (draftBusy) return;
    if (!value) {
      priceRefresh.current?.dispose(); Object.values(generation.current).forEach(g => g.invalidate());
      setExpandedSettingsPanel('direction-size');
    }
    onOpenChange(value);
  };
  const renderSetup = ({ details, status, actions, depositDialog }: Partial<GridDraftContent> = {}) =>
    <DialogContent className="max-w-lg sm:max-w-[760px] max-h-[90dvh] flex flex-col" data-testid="sheet-grid-planner">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl"><BarChart3 className="h-5 w-5 text-primary" />Grid Bot</DialogTitle>
          <DialogDescription>Choose a range and plan your grid.</DialogDescription>
          <Badge variant="secondary" className="w-fit mt-1">{liveEnabled ? 'Review your setup before creating a bot' : 'Planning only'}</Badge>
        </DialogHeader>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-3 sm:space-y-5 py-2 pr-1 pb-[max(2rem,env(safe-area-inset-bottom))]">
        <fieldset disabled={draftBusy} className="space-y-3 sm:space-y-6">
        <section aria-label="Market and price" className="rounded-xl border border-border bg-card/40 p-3 sm:p-4 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3">
          <div className="space-y-1.5 sm:w-64 min-w-0">
            <Label htmlFor="grid-market">Pacifica market</Label>
            <Select value={form.market} onValueChange={v => edit('market', v === '__clear__' ? '' : v)} disabled={marketLoading}>
              <SelectTrigger id="grid-market"><SelectValue placeholder="Choose a market">{form.market || undefined}</SelectValue></SelectTrigger>
              <SelectContent><SelectItem value="__clear__">Choose a market</SelectItem>{markets.map(m => <SelectItem key={m.market} value={m.market}>
                {m.market}{m.constraints.state === 'unavailable' ? ' — sizing unavailable' : ''}
              </SelectItem>)}</SelectContent>
            </Select>
            {marketLoading && <p role="status" className="text-xs text-muted-foreground">Refreshing market observations…</p>}
          </div>
          <div className="space-y-1 text-right max-w-40">
            <p className="text-xs text-muted-foreground">{reference ? 'Price now' : lastPrice ? 'Last observed price' : 'Price'}</p>
            <p className="font-semibold text-lg sm:text-xl tabular-nums break-words">{lastPrice ? readableDecimal(lastPrice.price) : '—'}</p>
            <p className="text-xs text-muted-foreground">{lastPrice ? <PriceAge observedAt={lastPrice.observedAt} clock={marketClock} />
              : marketError === PRICE_BUSY_MESSAGE ? 'Waiting for a fresh observation.'
              : marketLoading ? 'Refreshing price…' : !form.market ? 'Choose a market to see its price' : null}</p>
          </div>
          <GridRangingFinder enabled={open && plannerEnabled} identity={identity} timeframe={form.timeframe} disabled={draftBusy}
            onSelect={market => { if (market !== form.market) edit('market', market); }} />
          <Button type="button" size="sm" variant="outline" className="col-span-2 w-full justify-self-end sm:col-span-1 sm:col-start-2 sm:row-start-2 sm:w-auto" disabled={marketLoading} onClick={refreshObservations}>
            <RefreshCw className="h-3.5 w-3.5 mr-2" />Refresh price
          </Button>
          {(marketError || selected?.reference.state === 'unavailable') && <p role={marketError === PRICE_BUSY_MESSAGE ? 'status' : 'alert'}
            className={`col-span-2 text-sm ${marketError === PRICE_BUSY_MESSAGE ? 'text-muted-foreground' : 'text-destructive'}`}>
            {marketError || (selected?.reference.state === 'unavailable' ? selected.reference.reason : '')}</p>}
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
              <Button type="button" size="sm" variant="ghost" disabled={marketLoading} onClick={refreshObservations}>Refresh chart</Button>
            </div>
          </div>
          <GridPlannerChart chart={chart} lines={lines} range={range} period={form.rangeWindow} stale={now >= chartExpiry} hasMarket={!!form.market}
            levelMessage={createEnabled && !usingPlannerGeometry ? lines.length ? 'Authoritative draft preview levels used when saving.' : 'Authoritative draft levels require a fresh validated draft preview.'
              : plannerLevelMessage(preview, previewExpiry, now, { ...form, stop: effectiveStop }, loading, query.error || error)}
            tick={selected?.constraints.state === 'available' ? selected.constraints.value.tick : null}
            previewDetails={<>
              <p>{form.stop ? "Your custom stop must align to the exchange's price step and lie beyond the loss side of the range."
                : "The suggested stop is 3% beyond the loss side of your range, rounded outwards to the exchange's observed price step. Change it in Stop loss settings."}</p>
              <p>{preview?.fee.state === 'unknown' || form.feePercent === '' ? 'No fee assumed — fee checks have not been evaluated.' : ASSUMPTION_LABEL} Taker fees for a starting position, slippage, exchange fee rounding and funding are unavailable. {preview?.stop.reason}</p>
              {preview?.fee.state === 'unknown' && <p>Minimum with your fee assumption: {preview.assumedMinimum.state === 'available' ? `${readableDecimal(preview.assumedMinimum.value)} USDC` : preview.assumedMinimum.reason}</p>}
              <p>No profit or fill forecasts. Minimum investment uses a 0.01 USDC display step. Funding, liquidation safety, available order slots, account balances and partial fills are not checked here; draft funds are checked separately below.</p>
                  {liveEnabled && <p>Create bot asks you to confirm isolated funding and trading, then saves and starts this setup. Save draft keeps it for later.</p>}
            </>}
            error={chartError} onRetry={retryChart} loading={!!form.market && !chart && !chartError} />
        </section>

        <DrawerSettingsPanel id="range" title="Range" icon={SlidersHorizontal} keepMounted
          expandedPanel={expandedSettingsPanel} setExpandedPanel={setExpandedSettingsPanel} testId="grid-panel-range-toggle">
          <GridRegimeHint timeframe={form.timeframe} regime={regime} />
          {rangeFacts?.range.state === 'available' && now < rangeExpiry && regime.state === 'unavailable' &&
            <p className="text-xs text-muted-foreground">Auto range uses {rangeFacts.range.includedBars} finalized bars.</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={!form.market || rangeBusy} onClick={autoRange}>Suggest auto-range</Button>
            <div className="flex items-center gap-2"><Label id="grid-period-label" className="text-xs">Range based on:</Label>
              <div role="group" aria-labelledby="grid-period-label" className="flex rounded-md border border-border/60 p-0.5">
                {(['day', 'week', 'month'] as const).map(period => <Button key={period} type="button" size="sm"
                  variant={form.rangeWindow === period ? 'secondary' : 'ghost'} aria-pressed={form.rangeWindow === period}
                  className="h-7 px-2 text-xs" onClick={() => edit('rangeWindow', period)}>{period === 'day' ? 'Day' : period === 'week' ? 'Week' : 'Month'}</Button>)}
              </div>
            </div>
            {rangeSource === 'auto' && hasManualRange && <Button type="button" variant="ghost" onClick={restoreManual}>Restore entered range</Button>}
            <span className="text-xs text-muted-foreground self-center">{rangeSource === 'auto' ? 'Auto' : 'Manual'}</span>
          </div>
          <p className="text-xs text-muted-foreground">Highs and lows from this period set the range; the candle size sets the safety buffer.</p>
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
          <div className="space-y-2"><Label id="grid-side-label">Direction</Label>
            <GridDirectionSignals active={open} identity={identity} market={defaultMarketPending ? '' : form.market} timeframe={form.timeframe} regime={regime} refresh={refresh}/>
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
          <p className="text-xs text-muted-foreground">{plannerGridCountHint(form.intervals)}</p>
        </DrawerSettingsPanel>

        <DrawerSettingsPanel id="stop" title="Stop loss" icon={Shield} keepMounted
          expandedPanel={expandedSettingsPanel} setExpandedPanel={setExpandedSettingsPanel} testId="grid-panel-stop-toggle">
          {numberField('stop', 'Custom stop price', suggestedStop ?? 'Enter a proposed stop')}
          <p className="text-xs text-muted-foreground">{form.stop ? "Your custom stop must align to the exchange's price step and lie beyond the loss side of the range."
            : suggestedStop ? `Suggested stop: ${readableDecimal(suggestedStop)}. It is 3% beyond the loss side of your range, rounded outwards to the exchange's observed price step.`
            : 'A proposed stop needs observed sizing, or enter a custom stop price.'} A blank custom stop uses the suggested price.</p>
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

        {status}
        {plannerEnabled && <section aria-labelledby="grid-plan-heading" className="rounded-xl border border-primary/20 bg-card/40 p-4 sm:p-5 space-y-4">
          <h3 id="grid-plan-heading" className="text-sm font-semibold">Your plan</h3>
          <GridPlanIssues reasons={issues} onReview={showIssue} />
          {loading && !preview ? <p role="status" className="text-sm">Checking your plan…</p>
            : preview ? <p role="status" className="text-sm font-medium">{plannerStatus(preview, stale)}</p>
            : <p className="text-sm text-muted-foreground">Choose a market, range and investment to see your plan.{!effectiveStop && ' A proposed stop needs observed sizing, or enter one in Stop loss settings.'}</p>}
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div><dt className="text-xs text-muted-foreground">Grids</dt><dd className="font-medium mt-1">{displayPlan ? `${displayPlan.lines.length - 1} grids` : preview?.geometry?.state === 'available' ? `${preview.geometry.value.length - 1} grids` : 'Awaiting preview'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Range you chose</dt><dd className="font-medium mt-1 break-words">{range ? `${readableDecimal(range.lower)} – ${readableDecimal(range.upper)}` : 'Enter lower and upper prices'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Proposed stop</dt><dd className="font-medium mt-1 break-words">{effectiveStop ? `${readableDecimal(effectiveStop)}${form.stop ? ' · custom' : ' · suggested'}` : 'Unavailable'}</dd></div>
            <div><dt className="text-xs text-muted-foreground">Grid order sizes</dt><dd className="font-medium mt-1">{plannerOrderSizeSummary(preview?.requestedPlan, form.entryScale) ?? 'Awaiting a preview at your investment'}</dd></div>
            {plannerMinimumRows(preview).map(row => <div key={row.label}><dt className="text-xs text-muted-foreground">{row.label}</dt><dd className="font-medium mt-1">{row.value}</dd></div>)}
          </dl>
          {plannerOpeningMinimumSummary(preview?.requestedPlan) && <p role="status" className="text-sm">{plannerOpeningMinimumSummary(preview?.requestedPlan)}</p>}
          {(preview?.fee.state === 'unknown' || form.feePercent === '') && <p className="text-xs text-muted-foreground">Fee assumption not set — fees haven't been checked.</p>}

          {displayPlan && <details className="border-t border-border/60 pt-3">
            <summary className="cursor-pointer text-sm font-medium">View all grid levels and quantities</summary>
            <p className="text-xs text-muted-foreground mt-3">{stale && 'Expired market data. '}{preview?.minimumPlan ? 'Quantities at the minimum investment; not sized at your requested investment.' : 'Quantities sized at your requested investment.'} Starting position quantity: {readableDecimal(displayPlan.seedQuantity)} base units.</p>
            <div className="overflow-x-auto max-h-72 mt-2"><table className="w-full text-xs text-left">
              <caption className="text-left py-2">Planned levels ({displayPlan.lines.length} price lines)</caption>
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
        {details ?? feesPanel()}
      </div>
      <DialogFooter className="pt-2 border-t border-border/40 gap-2 sm:gap-0 sm:flex-wrap sm:gap-y-2">
        {!createEnabled && <p id="grid-create-launch-hint" className="text-xs text-muted-foreground sm:order-last sm:basis-full sm:text-right">
          Opens when Grid trading launches
        </p>}
        <Button variant="outline" disabled={draftBusy} onClick={() => handleOpenChange(false)}>Cancel</Button>
        {actions}
        {!createEnabled && <Button type="button" className="bg-gradient-to-r from-primary to-accent" disabled aria-describedby="grid-create-launch-hint">
          Create bot
        </Button>}
      </DialogFooter>
      {depositDialog}
    </DialogContent>;
  return <Dialog open={open} onOpenChange={handleOpenChange}>
    {createEnabled ? <GridDraftActions key={identity} open={open} intent={draftIntent} onSaved={onSaved} onBusyChange={setDraftBusy}
      onPreview={setDraftPreview} liveEnabled={liveEnabled} rangeBusy={autoApplying} onIssue={showIssue} renderDetails={feesPanel} renderLayout={renderSetup} />
      : renderSetup()}
  </Dialog>;
}

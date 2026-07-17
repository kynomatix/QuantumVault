import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
  type CandlestickData,
} from 'lightweight-charts';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2, AlertCircle, BarChart3, Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { walletAuthHeaders } from '@/lib/queryClient';
import { safeResponseJson } from '@/lib/safe-fetch';

// Mirrors AiTraderDrawer.tsx's formatPrice — kept local since it isn't exported
// there (same precedent that file already set for BotManagementDrawer), so
// precision stays correct for low-priced markets instead of a flat toFixed(2).
function formatPrice(price: number | null | undefined): string {
  if (price === undefined || price === null) return '--';
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 10) return price.toFixed(3);
  return price.toFixed(2);
}

function formatUsdSigned(n: number): string {
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

const EXIT_REASON_LABELS: Record<string, string> = {
  sl: 'Stop Loss',
  tp: 'Take Profit',
  ai_close: 'AI Close',
  user_close: 'Manual Close',
  circuit_breaker: 'Circuit Breaker',
  liquidation: 'Liquidation',
};

interface ChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// The platform's four supported AI Trader timeframes — mirrors the server's
// CHART_TIMEFRAME_MS keys (routes.ts); the chart endpoint 400s on anything else.
const CHART_TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
type ChartTf = (typeof CHART_TIMEFRAMES)[number];

function isChartTf(v: string): v is ChartTf {
  return (CHART_TIMEFRAMES as readonly string[]).includes(v);
}

/** A support/resistance level the AI actually saw when it made this decision
 *  (mapped from the decision's contextDigest.htfLevels by the drawer). */
export interface AiChartLevel {
  price: number;
  kind: 'support' | 'resistance';
  touches: number;
}

/**
 * Client-side mirror of WMFormation from wm-detector.ts.
 * Only the fields needed to render the overlay are included.
 */
export interface WMFormationData {
  type: 'W' | 'M';
  extreme1: { price: number; index: number };
  extreme2: { price: number; index: number };
  neckline: { price: number; index: number };
}

interface AiTraderDecisionChartProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  botId: string;
  decisionId: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number | null;
  stopLossPrice: number | null;
  takeProfitPrice: number | null;
  /** Breakeven protect: where the AI originally placed the stop (null = stop never moved). */
  originalStopLossPrice?: number | null;
  /** Breakeven protect: when the stop was moved (drives the SL→BE marker). */
  slMovedAt?: string | number | null;
  realizedPnl: number | null;
  exitReason: string | null;
  market: string;
  timeframe: string;
  decidedAt: string | number | null;
  closedAt: string | number | null;
  markPrice?: number | null;
  unrealizedPnl?: number | null;
  sizeBase?: number | null;
  aiLevels?: AiChartLevel[];
  /** W/M formation the AI detected for this decision (null = no pattern). */
  wmFormation?: WMFormationData | null;
}

function toEpochSeconds(v: string | number | null): number | null {
  if (v === null || v === undefined) return null;
  const ms = typeof v === 'number' ? v : new Date(v).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/** Snaps a target epoch-seconds timestamp to the nearest candle time present in the series. */
function snapToNearestTime(times: number[], targetSec: number): number {
  let nearest = times[0];
  let best = Math.abs(times[0] - targetSec);
  for (const t of times) {
    const d = Math.abs(t - targetSec);
    if (d < best) {
      best = d;
      nearest = t;
    }
  }
  return nearest;
}

/** Index of the candle whose time is nearest the target epoch-seconds timestamp. */
function nearestTimeIndex(times: number[], targetSec: number): number {
  let nearest = 0;
  let best = Math.abs(times[0] - targetSec);
  for (let i = 1; i < times.length; i++) {
    const d = Math.abs(times[i] - targetSec);
    if (d < best) {
      best = d;
      nearest = i;
    }
  }
  return nearest;
}

/**
 * Computes EMA over a closes array.
 * Returns null for warming-up bars (fewer than `period` bars seen so far).
 */
function computeEMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return result;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += closes[i];
  prev /= period;
  result[period - 1] = prev;
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k);
    result[i] = prev;
  }
  return result;
}

/**
 * Computes Bollinger Bands (SMA basis ± mult × std dev).
 * Returns nulls for warming-up bars (< period candles).
 */
function computeBB(
  closes: number[],
  period: number,
  mult: number,
): { upper: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(closes.length).fill(null);
  const lower: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period) return { upper, lower };
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const avg = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - avg) ** 2;
    const std = Math.sqrt(variance / period);
    upper[i] = avg + mult * std;
    lower[i] = avg - mult * std;
  }
  return { upper, lower };
}

export function AiTraderDecisionChart({
  open,
  onOpenChange,
  botId,
  decisionId,
  direction,
  entryPrice,
  exitPrice,
  stopLossPrice,
  takeProfitPrice,
  originalStopLossPrice,
  slMovedAt,
  realizedPnl,
  exitReason,
  market,
  timeframe,
  decidedAt,
  closedAt,
  markPrice,
  unrealizedPnl,
  sizeBase,
  aiLevels,
  wmFormation,
}: AiTraderDecisionChartProps) {
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverCandle, setHoverCandle] = useState<ChartCandle | null>(null);
  // User-selected chart timeframe (MTF zoom-out); starts on the decision's own
  // timeframe and resets to it whenever the dialog opens for a new decision.
  const [tf, setTf] = useState<ChartTf>(isChartTf(timeframe) ? timeframe : '1h');
  // Session-only "big chart" toggle — deliberately NOT persisted anywhere
  // (owner: default small, no extra stored state). Resizing goes through the
  // container's CSS + the ResizeObserver, so toggling never rebuilds the
  // chart and the user's scroll/zoom survives.
  const [expanded, setExpanded] = useState(false);
  // PnL display mode — resets to dollar on each new chart open.
  const [pnlView, setPnlView] = useState<'dollar' | 'percent'>('dollar');
  // W/M pattern overlay toggle — off by default, resets on each new chart.
  const [showPattern, setShowPattern] = useState(false);
  // Holds the lightweight-charts Line series for the W/M overlay so we can
  // toggle its visibility without rebuilding the whole chart.
  const formationSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  // EMA + Bollinger Band series — created in the build effect, toggled in the
  // showPattern effect alongside formationSeriesRef. All start hidden.
  const ema20Ref   = useRef<ISeriesApi<'Line'> | null>(null);
  const ema50Ref   = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200Ref  = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    if (open) {
      setTf(isChartTf(timeframe) ? timeframe : '1h');
      setExpanded(false);
      setPnlView('dollar');
      setShowPattern(false);
    }
  }, [open, decisionId, timeframe]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // Set just before the deep-history backfill replaces the candle state, so the
  // rebuild restores the user's current view (by time, immune to index shifts
  // from prepended history) instead of re-running the default trade framing.
  const preserveViewRef = useRef<{ from: UTCTimestamp; to: UTCTimestamp } | null>(null);
  // Live-refresh bars (10s tail poll while an open trade's chart is on screen),
  // keyed by candle time. Fed straight into the series via series.update() so
  // the chart never tears down mid-watch; kept here so a full rebuild (e.g. a
  // PnL prop tick) can replay them on top of the stale `candles` state.
  const liveBarsRef = useRef<Map<number, ChartCandle>>(new Map());
  // The entry price line — kept in a ref so live PnL prop ticks can update its
  // label in place via applyOptions() instead of tearing the chart down (which
  // would reset the user's scroll/zoom every 10s while they watch a trade).
  const entryLineRef = useRef<IPriceLine | null>(null);
  // Price-line + marker refs for the in-place breakeven-protect update effect.
  // Kept outside the build effect so the BE update can mutate them without
  // rebuilding the chart (which would reset the user's scroll/zoom).
  const slLineRef = useRef<IPriceLine | null>(null);
  const originalSlLineRef = useRef<IPriceLine | null>(null);
  const beTriggerLineRef = useRef<IPriceLine | null>(null);
  type ChartMarker = { time: UTCTimestamp; position: 'belowBar' | 'aboveBar'; shape: string; color: string; text: string; size?: number };
  const markersRef = useRef<ChartMarker[]>([]);
  const candleTimesRef = useRef<number[]>([]);

  // Fetch candles only — every other value (entry/exit/SL/TP/PnL/exitReason)
  // is passed in as a prop from data the drawer already holds.
  useEffect(() => {
    if (!open || !botId || !decisionId) {
      setCandles([]);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCandles([]);
    // A fresh load must never restore a view preserved for a previous decision
    // (rapid close/reopen can leave the ref set if the build effect never ran).
    preserveViewRef.current = null;
    // Live bars belong to the previous decision/timeframe — drop them.
    liveBarsRef.current = new Map();
    (async () => {
      const fetchSpan = async (span: 'trade' | 'deep'): Promise<ChartCandle[]> => {
        const res = await fetch(
          `/api/ai-trader/${botId}/chart?decisionId=${encodeURIComponent(decisionId)}&tf=${encodeURIComponent(tf)}&span=${span}`,
          { credentials: 'include', headers: walletAuthHeaders() }
        );
        const data = await safeResponseJson(res);
        if (!res.ok) throw new Error(data?.error || 'Could not load chart');
        return Array.isArray(data?.candles) ? data.candles : [];
      };
      let fastCount = 0;
      try {
        // Stage 1: tight trade window — fast first paint.
        const fast = await fetchSpan('trade');
        if (cancelled) return;
        fastCount = fast.length;
        setCandles(fast);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          setError(err?.message || 'Could not load chart');
          setLoading(false);
        }
        return;
      }
      try {
        // Stage 2: backfill the deep scroll-back history in the background —
        // usually stitched in before the user starts scrolling left. Failure
        // is non-fatal: the trade window is already on screen.
        const deep = await fetchSpan('deep');
        if (cancelled || deep.length <= fastCount) return;
        if (seriesRef.current && chartRef.current) {
          // Chart is already built — update the candlestick series in-place.
          // setData() replaces the data on the existing series without
          // destroying the chart instance, so the user's scroll/zoom is
          // preserved. This prevents the visible "jump" that the old
          // setCandles() → rebuild path produced.
          const view = chartRef.current.timeScale().getVisibleRange() as
            | { from: UTCTimestamp; to: UTCTimestamp }
            | null;
          seriesRef.current.setData(deep as CandlestickData[]);
          // Replay any live bars already polled so they aren't wiped by setData().
          const lastBase = deep[deep.length - 1]?.time ?? 0;
          const liveReplay = [...liveBarsRef.current.values()]
            .filter((b) => b.time >= lastBase)
            .sort((a, b) => a.time - b.time);
          for (const bar of liveReplay) {
            seriesRef.current.update(bar as CandlestickData);
          }
          // Update the candle-times snapshot used by the in-place BE marker snap.
          candleTimesRef.current = deep.map((c) => c.time);
          // setData() resets the time scale to fitContent — restore the view.
          if (view) {
            try { chartRef.current.timeScale().setVisibleRange(view); } catch {}
          }
        } else {
          // Chart not built yet — fall back to the state-update rebuild path.
          preserveViewRef.current =
            (chartRef.current?.timeScale().getVisibleRange() as
              | { from: UTCTimestamp; to: UTCTimestamp }
              | null) ?? null;
          setCandles(deep);
        }
      } catch {
        // keep the fast window
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, botId, decisionId, tf]);

  // Build the chart once candles are ready. Torn down and rebuilt whenever
  // the underlying decision data changes, and always removed on unmount.
  useEffect(() => {
    if (!open || loading || error || candles.length === 0 || !containerRef.current) return;

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight || 360,
      layout: {
        background: { color: 'transparent' },
        textColor: '#9ca3af',
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.06)' },
        horzLines: { color: 'rgba(255,255,255,0.06)' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: 'rgba(255,255,255,0.12)' },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.12)' },
    });
    chartRef.current = chart;

    const times = candles.map((c) => c.time);
    candleTimesRef.current = times;
    const flatSeries = (price: number) => candles.map((c) => ({ time: c.time as UTCTimestamp, value: price }));

    // Reward/risk zone shading — best-effort, base-library-only (no plugins).
    // A Baseline series filled between the entry price and a flat SL/TP line
    // approximates a shaded band; colors are the same on both sides of the
    // baseline so it reads correctly for both long and short trades.
    if (stopLossPrice != null) {
      const riskZone = chart.addBaselineSeries({
        baseValue: { type: 'price', price: entryPrice },
        topFillColor1: 'rgba(120,84,212,0.15)',
        topFillColor2: 'rgba(120,84,212,0.15)',
        bottomFillColor1: 'rgba(120,84,212,0.15)',
        bottomFillColor2: 'rgba(120,84,212,0.15)',
        topLineColor: 'rgba(0,0,0,0)',
        bottomLineColor: 'rgba(0,0,0,0)',
        lineVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      riskZone.setData(flatSeries(stopLossPrice));
    }
    if (takeProfitPrice != null) {
      const rewardZone = chart.addBaselineSeries({
        baseValue: { type: 'price', price: entryPrice },
        topFillColor1: 'rgba(56,189,248,0.13)',
        topFillColor2: 'rgba(56,189,248,0.13)',
        bottomFillColor1: 'rgba(56,189,248,0.13)',
        bottomFillColor2: 'rgba(56,189,248,0.13)',
        topLineColor: 'rgba(0,0,0,0)',
        bottomLineColor: 'rgba(0,0,0,0)',
        lineVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      rewardZone.setData(flatSeries(takeProfitPrice));
    }

    // Sky blue = bullish, violet = bearish — platform color palette.
    const series = chart.addCandlestickSeries({
      upColor: '#38bdf8',
      downColor: '#7854d4',
      wickUpColor: '#38bdf8',
      wickDownColor: '#7854d4',
      borderVisible: false,
    });
    series.setData(candles as CandlestickData[]);
    seriesRef.current = series;

    // Replay any live-refresh bars newer than (or updating) the last candle in
    // state, so a rebuild between polls doesn't wipe the freshest bars.
    // series.update() only accepts times >= the last set bar — filter to that.
    const lastBaseTime = candles[candles.length - 1]?.time ?? 0;
    const replay = [...liveBarsRef.current.values()]
      .filter((b) => b.time >= lastBaseTime)
      .sort((a, b) => a.time - b.time);
    for (const bar of replay) {
      series.update(bar as CandlestickData);
    }

    // Entry price line — broker-style when open position (WO-8h.1):
    // solid line in direction color, title carries side + size + live P&L.
    const isOpen = realizedPnl === null;
    const entryColor = isOpen
      ? (direction === 'long' ? '#2ec77e' : '#ef5350')
      : '#58a6ff';
    const sizeStr = isOpen && sizeBase != null
      ? ' ' + Number(sizeBase).toPrecision(4)
      : '';
    const pnlStr = isOpen && unrealizedPnl != null
      ? ` ${unrealizedPnl >= 0 ? '+' : '−'}$${Math.abs(unrealizedPnl).toFixed(2)}`
      : '';
    const entryTitle = isOpen
      ? `${direction.toUpperCase()}${sizeStr}${pnlStr}`
      : 'Entry';
    entryLineRef.current = series.createPriceLine({
      price: entryPrice,
      color: entryColor,
      lineStyle: isOpen ? LineStyle.Solid : LineStyle.Dashed,
      lineWidth: isOpen ? 2 : 1,
      title: entryTitle,
    });
    // Breakeven protect: when the stop was ratcheted mid-trade, show BOTH
    // stops — the AI's initial placement (faded) and the moved breakeven stop.
    const slMoved =
      stopLossPrice != null &&
      stopLossPrice > 0 &&
      originalStopLossPrice != null &&
      Number.isFinite(originalStopLossPrice) &&
      originalStopLossPrice > 0 &&
      Math.abs(originalStopLossPrice - stopLossPrice) / stopLossPrice > 1e-9;
    if (slMoved) {
      originalSlLineRef.current = series.createPriceLine({
        price: originalStopLossPrice,
        color: 'rgba(239,83,80,0.45)',
        lineStyle: LineStyle.SparseDotted,
        lineWidth: 1,
        title: 'Initial SL',
      });
    } else {
      originalSlLineRef.current = null;
    }
    if (stopLossPrice != null) {
      slLineRef.current = series.createPriceLine({
        price: stopLossPrice,
        color: '#ef5350',
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        title: slMoved ? 'SL → BE' : 'SL',
      });
    } else {
      slLineRef.current = null;
    }
    if (takeProfitPrice != null) {
      series.createPriceLine({
        price: takeProfitPrice,
        color: '#2ec77e',
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        title: 'TP',
      });
    }
    // Breakeven-protect trigger level: 75% of the way from entry to TP.
    // Only visible while the ratchet hasn't fired yet — once the SL has been
    // moved to BE this line is replaced by the "SL → BE" marker and the moved
    // stop line, so showing it would be redundant clutter.
    beTriggerLineRef.current = null;
    if (!slMoved && takeProfitPrice != null) {
      const beTriggerPrice = entryPrice + 0.75 * (takeProfitPrice - entryPrice);
      if (Number.isFinite(beTriggerPrice) && Math.abs(beTriggerPrice - entryPrice) > 1e-9) {
        beTriggerLineRef.current = series.createPriceLine({
          price: beTriggerPrice,
          color: 'rgba(45,212,191,0.55)',
          lineStyle: LineStyle.SparseDotted,
          lineWidth: 1,
          title: 'BE Trigger',
        });
      }
    }

    // Support/resistance levels the AI actually saw for THIS decision (from the
    // decision's stored context). Deliberately dim + dotted, neutral color so
    // they never compete with SL/TP; axis label off to keep the price axis clean.
    for (const lvl of aiLevels ?? []) {
      if (!Number.isFinite(lvl?.price)) continue;
      series.createPriceLine({
        price: lvl.price,
        color: 'rgba(148,163,184,0.65)',
        lineStyle: LineStyle.Dotted,
        lineWidth: 1,
        axisLabelVisible: false,
        title: `AI ${lvl.kind === 'support' ? 'Sup' : 'Res'}${lvl.touches > 0 ? ` ×${lvl.touches}` : ''}`,
      });
    }

    const markers: Parameters<typeof series.setMarkers>[0] = [];
    const decidedAtSec = toEpochSeconds(decidedAt);
    if (decidedAtSec !== null) {
      markers.push({
        time: snapToNearestTime(times, decidedAtSec) as UTCTimestamp,
        position: direction === 'long' ? 'belowBar' : 'aboveBar',
        shape: direction === 'long' ? 'arrowUp' : 'arrowDown',
        color: '#58a6ff',
        text: 'Entry',
      });
    }
    // Breakeven-protect move marker: pinpoints the candle where the stop was
    // ratcheted to breakeven, so the two SL lines read as before/after.
    const slMovedAtSec = slMoved ? toEpochSeconds(slMovedAt ?? null) : null;
    if (slMovedAtSec !== null && times.length > 0) {
      markers.push({
        time: snapToNearestTime(times, slMovedAtSec) as UTCTimestamp,
        position: direction === 'long' ? 'belowBar' : 'aboveBar',
        shape: 'square',
        color: '#a78bfa',
        text: 'SL → BE',
      });
    }
    const closedAtSec = toEpochSeconds(closedAt);
    if (closedAtSec !== null) {
      markers.push({
        time: snapToNearestTime(times, closedAtSec) as UTCTimestamp,
        position: 'aboveBar',
        shape: 'circle',
        color: '#f0b429',
        text: 'Exit',
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(markers);
    markersRef.current = markers as ChartMarker[];

    // ── W/M formation overlay ─────────────────────────────────────────────────
    // Converts a detector bar-index to an epoch-seconds timestamp.
    // The detector ran on indicatorCandles (INDICATOR_BARS = 400). The last bar
    // (index 399) is approximately decidedAt. Approximation is ≤1 bar off for
    // established markets; markers snap to the nearest real candle anyway.
    formationSeriesRef.current = null;
    if (wmFormation && decidedAtSec !== null && times.length > 0) {
      const INDICATOR_BARS = 400;
      const TF_MS: Record<string, number> = {
        '15m': 15 * 60 * 1000,
        '1h':  60 * 60 * 1000,
        '4h':  4  * 60 * 60 * 1000,
        '1d':  24 * 60 * 60 * 1000,
      };
      const tfMs = TF_MS[timeframe] ?? TF_MS['1h'];
      const tfSec = tfMs / 1000;
      // Compute approximate bar time from index, then SNAP to the nearest
      // actual candle time. Without snapping, a line series data point at a
      // timestamp not present in the candlestick series causes lightweight-charts
      // to insert a new empty time slot, visually splitting the candle columns.
      const barToSnapped = (idx: number): UTCTimestamp => {
        const rawSec = decidedAtSec - (INDICATOR_BARS - 1 - idx) * tfSec;
        return snapToNearestTime(times, rawSec) as UTCTimestamp;
      };

      const e1T = barToSnapped(wmFormation.extreme1.index);
      const nlT = barToSnapped(wmFormation.neckline.index);
      const e2T = barToSnapped(wmFormation.extreme2.index);
      const decidedT = snapToNearestTime(times, decidedAtSec) as UTCTimestamp;

      // Need 3 distinct snapped times; skip drawing if the chart window doesn't
      // reach far enough back to resolve the formation.
      if (new Set([e1T, nlT, e2T]).size >= 3) {
        const isW = wmFormation.type === 'W';
        const fColor = isW ? '#34d399' : '#f87171';   // green for W, red for M

        const fSeries = chart.addLineSeries({
          color: fColor,
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          visible: false,            // toggled in the showPattern effect below
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
        });
        // Draw the formation path: extreme1 → neckline → extreme2 → (decidedAt @ neckline)
        // This traces the W or M shape ending with a horizontal reach to the entry bar.
        // All times are snapped to existing candle slots so no empty columns appear.
        const fData = [
          { time: e1T,       value: wmFormation.extreme1.price },
          { time: nlT,       value: wmFormation.neckline.price },
          { time: e2T,       value: wmFormation.extreme2.price },
          { time: decidedT,  value: wmFormation.neckline.price },
        ];
        fSeries.setData(fData);
        // Neckline as a horizontal price line on the formation series — hides
        // automatically when the series visibility is toggled off.
        fSeries.createPriceLine({
          price: wmFormation.neckline.price,
          color: 'rgba(148,163,184,0.55)',
          lineStyle: LineStyle.Dotted,
          lineWidth: 1,
          title: 'Neckline',
          axisLabelVisible: true,
        });
        // Markers: arrows at the two swing extremes (the double bottom/top),
        // a circle at the intervening neckline pivot.
        const fMarkers: Parameters<typeof fSeries.setMarkers>[0] = [
          {
            time: e1T,
            position: isW ? 'belowBar' : 'aboveBar',
            shape: isW ? 'arrowUp' : 'arrowDown',
            color: fColor,
            size: 1,
            text: isW ? 'B1' : 'T1',
          },
          {
            time: nlT,
            position: isW ? 'aboveBar' : 'belowBar',
            shape: 'circle' as const,
            color: 'rgba(148,163,184,0.9)',
            size: 0.5,
            text: 'NL',
          },
          {
            time: e2T,
            position: isW ? 'belowBar' : 'aboveBar',
            shape: isW ? 'arrowUp' : 'arrowDown',
            color: fColor,
            size: 1,
            text: isW ? 'B2' : 'T2',
          },
        ];
        fMarkers.sort((a, b) => (a.time as number) - (b.time as number));
        fSeries.setMarkers(fMarkers);
        formationSeriesRef.current = fSeries;
      }
    }

    // ── EMAs & Bollinger Bands ────────────────────────────────────────────────
    // Computed from the loaded candles so no server changes or extra fetches are
    // needed. All series start hidden and are toggled by the same TA button that
    // controls the W/M overlay. Labeled with the chart's current timeframe (tf)
    // so the user always knows which resolution these indicators reflect — if
    // they've zoomed out to 4h, the EMA 200 shown is the 4h EMA 200.
    ema20Ref.current = null;
    ema50Ref.current = null;
    ema200Ref.current = null;
    bbUpperRef.current = null;
    bbLowerRef.current = null;
    {
      const closes = candles.map((c) => c.close);

      const makeLine = (
        values: (number | null)[],
        color: string,
        title: string,
        style: LineStyle,
      ): ISeriesApi<'Line'> => {
        const s = chart.addLineSeries({
          color,
          lineWidth: 1,
          lineStyle: style,
          visible: false,
          lastValueVisible: false,
          priceLineVisible: false,
          crosshairMarkerVisible: false,
          title,
        });
        const data = values
          .map((v, i) =>
            v === null ? null : { time: candles[i].time as UTCTimestamp, value: v },
          )
          .filter((x): x is { time: UTCTimestamp; value: number } => x !== null);
        if (data.length > 0) s.setData(data);
        return s;
      };

      const ema20Vals  = computeEMA(closes, 20);
      const ema50Vals  = computeEMA(closes, 50);
      const ema200Vals = computeEMA(closes, 200);
      const { upper: bbUp, lower: bbLow } = computeBB(closes, 20, 2);

      // System-palette colors — same family as the rest of the UI:
      //   EMA 20  → cyan-400   (#22d3ee) — fast, energetic
      //   EMA 50  → indigo-400 (#818cf8) — mid, cool blue-violet
      //   EMA 200 → purple-400 (#c084fc) — slow, authoritative (distinct from violet-400 BE marker)
      //   BB      → slate-500  (#64748b) — neutral channel, doesn't compete with EMA lines
      ema20Ref.current   = makeLine(ema20Vals,  'rgba(34,211,238,0.72)',  `EMA 20 (${tf})`,  LineStyle.Solid);
      ema50Ref.current   = makeLine(ema50Vals,  'rgba(129,140,248,0.72)', `EMA 50 (${tf})`,  LineStyle.Solid);
      ema200Ref.current  = makeLine(ema200Vals, 'rgba(192,132,252,0.68)', `EMA 200 (${tf})`, LineStyle.Solid);
      bbUpperRef.current = makeLine(bbUp,       'rgba(100,116,139,0.55)', `BB+ (${tf})`,     LineStyle.Dashed);
      bbLowerRef.current = makeLine(bbLow,      'rgba(100,116,139,0.55)', `BB− (${tf})`,     LineStyle.Dashed);
    }

    // View priority: (1) restore the exact pre-backfill view when the deep
    // history just stitched in (by time, so prepended bars can't shift it);
    // (2) default framing on the trade itself — NOT fitContent(), which would
    // squash the trade flat against ~900 bars of scroll-back history;
    // (3) fitContent as the last resort when the entry time is unknown.
    const preservedView = preserveViewRef.current;
    preserveViewRef.current = null;
    if (preservedView) {
      try {
        chart.timeScale().setVisibleRange(preservedView);
      } catch {
        chart.timeScale().fitContent();
      }
    } else if (decidedAtSec !== null && times.length > 0) {
      const entryIdx = nearestTimeIndex(times, decidedAtSec);
      const exitIdx = closedAtSec !== null ? nearestTimeIndex(times, closedAtSec) : times.length - 1;
      const from = Math.max(0, entryIdx - 60);
      const to = Math.min(times.length - 1, Math.max(exitIdx, entryIdx) + 40) + 3;
      chart.timeScale().setVisibleLogicalRange({ from, to });
    } else {
      chart.timeScale().fitContent();
    }

    const handleCrosshairMove = (param: Parameters<Parameters<typeof chart.subscribeCrosshairMove>[0]>[0]) => {
      if (!param.time || !seriesRef.current) {
        setHoverCandle(null);
        return;
      }
      const d = param.seriesData.get(seriesRef.current) as CandlestickData | undefined;
      if (!d) {
        setHoverCandle(null);
        return;
      }
      setHoverCandle({ time: d.time as number, open: d.open, high: d.high, low: d.low, close: d.close });
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);

    // Resize is deferred to the next animation frame: resizing the chart's
    // canvases synchronously INSIDE the ResizeObserver callback re-triggers
    // layout mid-delivery, which the browser reports as an uncaught
    // "ResizeObserver loop" error event (a non-Error — it tripped the dev
    // runtime-error overlay when the dialog was expanded).
    let resizeRaf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        if (containerRef.current && chartRef.current === chart) {
          chart.applyOptions({
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight || 360,
          });
        }
      });
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(resizeRaf);
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      entryLineRef.current = null;
      slLineRef.current = null;
      originalSlLineRef.current = null;
      beTriggerLineRef.current = null;
      markersRef.current = [];
      candleTimesRef.current = [];
      formationSeriesRef.current = null;
      ema20Ref.current   = null;
      ema50Ref.current   = null;
      ema200Ref.current  = null;
      bbUpperRef.current = null;
      bbLowerRef.current = null;
      setHoverCandle(null);
    };
    // sizeBase/unrealizedPnl deliberately NOT deps: their ticks update the
    // entry-line label in place (effect below) — a rebuild here would reset
    // the user's scroll/zoom on every live PnL refresh.
    // showPattern deliberately NOT a dep either: the visibility toggle effect
    // below updates formationSeriesRef.current.applyOptions() in place.
    // stopLossPrice/originalStopLossPrice/slMovedAt deliberately NOT deps: the
    // in-place BE-protect effect below mutates the refs without rebuilding.
  }, [open, loading, error, candles, entryPrice, takeProfitPrice, direction, decidedAt, closedAt, realizedPnl, aiLevels, wmFormation, timeframe]);

  // Live entry-line label refresh (open positions only): the drawer re-polls
  // PnL every 10s and passes it through — update the label without a rebuild.
  // pnlView is included so toggling $ ↔ % updates the label in place too.
  useEffect(() => {
    if (!entryLineRef.current || realizedPnl !== null) return;
    const sizeStr = sizeBase != null ? ' ' + Number(sizeBase).toPrecision(4) : '';
    let pnlStr = '';
    if (unrealizedPnl != null) {
      if (pnlView === 'percent' && sizeBase != null && entryPrice > 0) {
        const pct = (unrealizedPnl / (entryPrice * Number(sizeBase))) * 100;
        pnlStr = ` ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
      } else {
        pnlStr = ` ${unrealizedPnl >= 0 ? '+' : '−'}$${Math.abs(unrealizedPnl).toFixed(2)}`;
      }
    }
    entryLineRef.current.applyOptions({
      title: `${direction.toUpperCase()}${sizeStr}${pnlStr}`,
    });
  }, [unrealizedPnl, sizeBase, direction, realizedPnl, pnlView, entryPrice]);

  // In-place breakeven-protect update: when the ratchet fires mid-trade the
  // drawer's 10s poll brings back updated stopLossPrice/originalStopLossPrice/
  // slMovedAt props. Instead of letting those trigger a full chart rebuild (which
  // resets the user's scroll/zoom — bad for a video), we update the three price
  // lines and the marker array directly on the existing chart.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;

    const beActive =
      stopLossPrice != null &&
      stopLossPrice > 0 &&
      originalStopLossPrice != null &&
      Number.isFinite(originalStopLossPrice) &&
      originalStopLossPrice > 0 &&
      Math.abs(originalStopLossPrice - stopLossPrice) / stopLossPrice > 1e-9;

    // 1. Update the current SL line price + label in place.
    if (slLineRef.current && stopLossPrice != null) {
      slLineRef.current.applyOptions({
        price: stopLossPrice,
        title: beActive ? 'SL → BE' : 'SL',
      });
    }

    // 2. Create the faded original-SL ghost line if BE just fired and it didn't
    //    exist yet (the build effect only creates it when slMoved is already true
    //    at open time; mid-trade triggers need to create it here).
    if (beActive && originalStopLossPrice != null && !originalSlLineRef.current) {
      originalSlLineRef.current = series.createPriceLine({
        price: originalStopLossPrice,
        color: 'rgba(239,83,80,0.45)',
        lineStyle: LineStyle.SparseDotted,
        lineWidth: 1,
        title: 'Initial SL',
      });
    }

    // 3. Remove the BE trigger dotted line the moment the ratchet fires.
    if (beActive && beTriggerLineRef.current) {
      series.removePriceLine(beTriggerLineRef.current);
      beTriggerLineRef.current = null;
    }

    // 4. Append the "SL → BE" candle marker to the existing marker array (once).
    const times = candleTimesRef.current;
    const slMovedAtSec = toEpochSeconds(slMovedAt ?? null);
    if (beActive && slMovedAtSec !== null && times.length > 0) {
      const alreadyAdded = markersRef.current.some((m) => m.text === 'SL → BE');
      if (!alreadyAdded) {
        const beMarker: ChartMarker = {
          time: snapToNearestTime(times, slMovedAtSec) as UTCTimestamp,
          position: direction === 'long' ? 'belowBar' : 'aboveBar',
          shape: 'square',
          color: '#a78bfa',
          text: 'SL → BE',
        };
        const updated = [...markersRef.current, beMarker]
          .sort((a, b) => (a.time as number) - (b.time as number));
        markersRef.current = updated;
        series.setMarkers(updated as any);
      }
    }
  }, [stopLossPrice, originalStopLossPrice, slMovedAt, direction]);

  // Toggle the W/M formation overlay + EMA/BB indicator series visibility
  // without rebuilding the chart. All TA indicators share one TA button.
  useEffect(() => {
    const v = { visible: showPattern };
    formationSeriesRef.current?.applyOptions(v);
    ema20Ref.current?.applyOptions(v);
    ema50Ref.current?.applyOptions(v);
    ema200Ref.current?.applyOptions(v);
    bbUpperRef.current?.applyOptions(v);
    bbLowerRef.current?.applyOptions(v);
  }, [showPattern]);

  // Live candle refresh: while the dialog is open on a STILL-OPEN trade, poll
  // the newest few bars every 10s and push them straight into the existing
  // series (no state change → no chart rebuild, the user's scroll/zoom stays
  // put). Stops itself when the trade closes, the dialog closes, or the tab is
  // hidden; errors are silently skipped (next tick retries).
  const hasCandles = candles.length > 0;
  useEffect(() => {
    if (!open || !botId || !decisionId || closedAt !== null || loading || error || !hasCandles) return;
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight || document.hidden || !seriesRef.current) return;
      inFlight = true;
      try {
        const res = await fetch(
          `/api/ai-trader/${botId}/chart?decisionId=${encodeURIComponent(decisionId)}&tf=${encodeURIComponent(tf)}&span=tail`,
          { credentials: 'include', headers: walletAuthHeaders() }
        );
        if (!res.ok) return;
        const data = await safeResponseJson(res);
        const bars: ChartCandle[] = Array.isArray(data?.candles) ? data.candles : [];
        if (cancelled || !seriesRef.current || bars.length === 0) return;
        // Only bars at/after the newest bar already on the chart — the series
        // API rejects out-of-order updates, and older bars are already drawn.
        const lastLive = Math.max(0, ...liveBarsRef.current.keys());
        const lastBase = candles[candles.length - 1]?.time ?? 0;
        const floor = Math.max(lastLive, lastBase);
        for (const bar of bars.sort((a, b) => a.time - b.time)) {
          if (bar.time < floor) continue;
          liveBarsRef.current.set(bar.time, bar);
          seriesRef.current.update(bar as CandlestickData);
        }
      } catch {
        // transient — next tick retries
      } finally {
        inFlight = false;
      }
    };
    const id = setInterval(tick, 10_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [open, botId, decisionId, tf, closedAt, loading, error, hasCandles, candles]);

  const isOpenPosition = realizedPnl === null;
  const pnlValue = isOpenPosition ? (unrealizedPnl ?? null) : realizedPnl;
  const exitReasonLabel = exitReason ? (EXIT_REASON_LABELS[exitReason] ?? exitReason) : null;
  // % of position notional (entry × size). Available only when sizeBase is
  // present (open trades). Closed history rows don't carry sizeBase.
  const canShowPct = pnlValue !== null && sizeBase != null && Number.isFinite(Number(sizeBase)) && entryPrice > 0;
  const pnlPct = canShowPct
    ? (pnlValue! / (entryPrice * Number(sizeBase))) * 100
    : null;
  // Format the PnL for the header readout.
  const pnlDisplay = (() => {
    if (pnlValue === null) return null;
    if (pnlView === 'percent' && pnlPct !== null) {
      return `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;
    }
    return formatUsdSigned(pnlValue);
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={expanded ? 'sm:max-w-[min(1400px,95vw)]' : 'sm:max-w-3xl'}
        data-testid="dialog-ai-trader-chart"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <BarChart3 className="w-4 h-4 text-primary" />
            Chart
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between flex-wrap gap-2 px-0.5">
          <div className="flex items-center gap-2">
            <div className="text-xs text-muted-foreground" data-testid="text-chart-market-timeframe">
              {market} · <span className={direction === 'long' ? 'text-emerald-400' : 'text-red-400'}>{direction.toUpperCase()}</span>
            </div>
            {wmFormation && (
              <button
                type="button"
                onClick={() => setShowPattern((p) => !p)}
                className={`text-[10px] font-medium px-1.5 py-0.5 rounded border transition-colors ${
                  showPattern
                    ? 'bg-sky-500/20 text-sky-400 border-sky-500/40'
                    : 'text-sky-600/70 border-sky-700/40 hover:text-sky-400 hover:border-sky-500/40'
                }`}
                title={`${wmFormation.type === 'W' ? 'W (double bottom)' : 'M (double top)'} pattern overlay`}
                data-testid="button-chart-pattern"
              >
                TA
              </button>
            )}
            <div className="flex items-center gap-0.5 rounded-md border border-border/50 p-0.5" data-testid="chart-timeframe-switcher">
              {CHART_TIMEFRAMES.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTf(t)}
                  disabled={loading}
                  className={`text-[10px] font-medium px-1.5 py-0.5 rounded transition-colors ${
                    tf === t
                      ? 'bg-primary/15 text-primary'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  data-testid={`button-chart-tf-${t}`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {isOpenPosition ? 'Unrealized PnL' : 'Realized PnL'}
            </span>
            {pnlDisplay !== null ? (
              <span
                className={`font-semibold ${pnlValue! >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                data-testid="text-chart-pnl"
              >
                {pnlDisplay}
              </span>
            ) : (
              <span className="text-muted-foreground" data-testid="text-chart-pnl">--</span>
            )}
            {!isOpenPosition && exitReasonLabel && (
              <span className="text-[10px] text-muted-foreground">({exitReasonLabel})</span>
            )}
            {pnlDisplay !== null && (
              <div className="flex gap-0.5" data-testid="toggle-pnl-view">
                <Button
                  type="button"
                  variant={pnlView === 'dollar' ? 'default' : 'outline'}
                  size="sm"
                  className="h-5 px-2 text-xs"
                  onClick={() => setPnlView('dollar')}
                  data-testid="button-pnl-view-dollar"
                >
                  $
                </Button>
                <Button
                  type="button"
                  variant={pnlView === 'percent' ? 'default' : 'outline'}
                  size="sm"
                  className="h-5 px-2 text-xs"
                  disabled={!canShowPct}
                  onClick={() => setPnlView('percent')}
                  title={!canShowPct ? 'Not available for closed trades' : undefined}
                  data-testid="button-pnl-view-percent"
                >
                  %
                </Button>
              </div>
            )}
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              className="ml-1 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
              title={expanded ? 'Smaller chart' : 'Bigger chart'}
              aria-label={expanded ? 'Smaller chart' : 'Bigger chart'}
              data-testid="button-chart-expand"
            >
              {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        <div className="text-[10px] text-muted-foreground px-0.5 h-4" data-testid="text-chart-ohlc-hover">
          {hoverCandle
            ? `O ${formatPrice(hoverCandle.open)}  H ${formatPrice(hoverCandle.high)}  L ${formatPrice(hoverCandle.low)}  C ${formatPrice(hoverCandle.close)}`
            : 'Hover the chart for open/high/low/close'}
        </div>

        {/* overflow-hidden + absolutely-positioned chart mount: the chart's canvas
            has a fixed pixel width, and if it sits in normal flow it props the
            dialog's grid track open when collapsing from expanded — the container
            never shrinks, so the ResizeObserver never tells the chart to scale
            down. Out-of-flow, the container always tracks the dialog width. */}
        <div
          className="relative w-full overflow-hidden"
          style={{ height: expanded ? 'min(62vh, 760px)' : 360 }}
          data-testid="container-ai-trader-chart"
        >
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="state-chart-loading">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading chart…
            </div>
          )}
          {!loading && error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground" data-testid="state-chart-error">
              <AlertCircle className="w-5 h-5 text-amber-400" />
              <span>{error}</span>
            </div>
          )}
          {!loading && !error && candles.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground" data-testid="state-chart-empty">
              No candle data available for this window.
            </div>
          )}
          <div ref={containerRef} className="absolute inset-0" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

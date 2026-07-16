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
import { Loader2, AlertCircle, BarChart3 } from 'lucide-react';
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
}: AiTraderDecisionChartProps) {
  const [candles, setCandles] = useState<ChartCandle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverCandle, setHoverCandle] = useState<ChartCandle | null>(null);
  // User-selected chart timeframe (MTF zoom-out); starts on the decision's own
  // timeframe and resets to it whenever the dialog opens for a new decision.
  const [tf, setTf] = useState<ChartTf>(isChartTf(timeframe) ? timeframe : '1h');

  useEffect(() => {
    if (open) setTf(isChartTf(timeframe) ? timeframe : '1h');
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
        preserveViewRef.current =
          (chartRef.current?.timeScale().getVisibleRange() as { from: UTCTimestamp; to: UTCTimestamp } | null) ?? null;
        setCandles(deep);
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
      height: 360,
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
    const flatSeries = (price: number) => candles.map((c) => ({ time: c.time as UTCTimestamp, value: price }));

    // Reward/risk zone shading — best-effort, base-library-only (no plugins).
    // A Baseline series filled between the entry price and a flat SL/TP line
    // approximates a shaded band; colors are the same on both sides of the
    // baseline so it reads correctly for both long and short trades.
    if (stopLossPrice != null) {
      const riskZone = chart.addBaselineSeries({
        baseValue: { type: 'price', price: entryPrice },
        topFillColor1: 'rgba(239,83,80,0.14)',
        topFillColor2: 'rgba(239,83,80,0.14)',
        bottomFillColor1: 'rgba(239,83,80,0.14)',
        bottomFillColor2: 'rgba(239,83,80,0.14)',
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
        topFillColor1: 'rgba(46,199,164,0.14)',
        topFillColor2: 'rgba(46,199,164,0.14)',
        bottomFillColor1: 'rgba(46,199,164,0.14)',
        bottomFillColor2: 'rgba(46,199,164,0.14)',
        topLineColor: 'rgba(0,0,0,0)',
        bottomLineColor: 'rgba(0,0,0,0)',
        lineVisible: false,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      });
      rewardZone.setData(flatSeries(takeProfitPrice));
    }

    const series = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
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
    if (stopLossPrice != null) {
      series.createPriceLine({
        price: stopLossPrice,
        color: '#ef5350',
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        title: 'SL',
      });
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

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      entryLineRef.current = null;
      setHoverCandle(null);
    };
    // sizeBase/unrealizedPnl deliberately NOT deps: their ticks update the
    // entry-line label in place (effect below) — a rebuild here would reset
    // the user's scroll/zoom on every live PnL refresh.
  }, [open, loading, error, candles, entryPrice, stopLossPrice, takeProfitPrice, direction, decidedAt, closedAt, realizedPnl, aiLevels]);

  // Live entry-line label refresh (open positions only): the drawer re-polls
  // PnL every 10s and passes it through — update the label without a rebuild.
  useEffect(() => {
    if (!entryLineRef.current || realizedPnl !== null) return;
    const sizeStr = sizeBase != null ? ' ' + Number(sizeBase).toPrecision(4) : '';
    const pnlStr = unrealizedPnl != null
      ? ` ${unrealizedPnl >= 0 ? '+' : '−'}$${Math.abs(unrealizedPnl).toFixed(2)}`
      : '';
    entryLineRef.current.applyOptions({
      title: `${direction.toUpperCase()}${sizeStr}${pnlStr}`,
    });
  }, [unrealizedPnl, sizeBase, direction, realizedPnl]);

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="dialog-ai-trader-chart">
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
            {pnlValue !== null ? (
              <span
                className={`font-semibold ${pnlValue >= 0 ? 'text-emerald-400' : 'text-red-400'}`}
                data-testid="text-chart-pnl"
              >
                {formatUsdSigned(pnlValue)}
              </span>
            ) : (
              <span className="text-muted-foreground" data-testid="text-chart-pnl">--</span>
            )}
            {!isOpenPosition && exitReasonLabel && (
              <span className="text-[10px] text-muted-foreground">({exitReasonLabel})</span>
            )}
          </div>
        </div>

        <div className="text-[10px] text-muted-foreground px-0.5 h-4" data-testid="text-chart-ohlc-hover">
          {hoverCandle
            ? `O ${formatPrice(hoverCandle.open)}  H ${formatPrice(hoverCandle.high)}  L ${formatPrice(hoverCandle.low)}  C ${formatPrice(hoverCandle.close)}`
            : 'Hover the chart for open/high/low/close'}
        </div>

        <div className="relative w-full" style={{ height: 360 }} data-testid="container-ai-trader-chart">
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
          <div ref={containerRef} className="w-full h-full" />
        </div>
      </DialogContent>
    </Dialog>
  );
}

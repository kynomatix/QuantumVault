import type { IChartApi, ISeriesApi, ISeriesPrimitive, Logical } from 'lightweight-charts';

export type SequentialTradePair = {
  entryId: string; exitId: string; direction: 'Long' | 'Short';
  entryTime: string; exitTime: string; entryPrice: number; exitPrice: number;
  size: number; addCount: number; liquidated: boolean; netPnl: number; pnlPercent: number; timeHeldMs: number; pairingStatus: 'sequential';
};

/** Native pane primitive repaints with both price/time scales, without adding bars.
 * Interpolate exact execution times within each candle, including same-bar trades.
 * Clip cross-window positions to the available candle interval.
 */
export function attachTradeBoxes(chart: IChartApi, series: ISeriesApi<'Candlestick'>, pairs: readonly SequentialTradePair[], candleTimes: readonly number[], barSeconds: number) {
  if (!candleTimes.length) return () => {};
  const first = candleTimes[0], end = candleTimes[candleTimes.length - 1] + barSeconds;
  const visible = pairs.filter(pair => Date.parse(pair.entryTime) / 1000 < end && Date.parse(pair.exitTime) / 1000 >= first);
  // lightweight-charts 4.2 returns 0 for fractional logicals, so interpolate by
  // hand: whole bar index from the candle list, plus the fraction of a bar.
  const logical = (time: number) => {
    const t = Math.max(first, Math.min(end, time));
    let lo = 0, hi = candleTimes.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candleTimes[mid] <= t) lo = mid; else hi = mid - 1; }
    return lo + Math.min(1, Math.max(0, (t - candleTimes[lo]) / barSeconds));
  };
  const x = (time: number) => {
    const l = logical(time), index = Math.floor(l);
    const base = chart.timeScale().logicalToCoordinate(index as Logical);
    return base === null ? null : base + (l - index) * chart.timeScale().options().barSpacing;
  };
  const onScreen = () => {
    const range = chart.timeScale().getVisibleLogicalRange();
    if (!range) return visible;
    return visible.filter(pair => logical(Date.parse(pair.exitTime) / 1000) >= range.from && logical(Date.parse(pair.entryTime) / 1000) <= range.to);
  };
  const primitive: ISeriesPrimitive = {
    paneViews: () => [{
      zOrder: () => 'bottom',
      renderer: () => ({
        draw(target) {
          target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
            ctx.save();
            ctx.beginPath(); ctx.rect(0, 0, mediaSize.width, mediaSize.height); ctx.clip();
            for (const pair of visible) {
              const left = x(Date.parse(pair.entryTime) / 1000), right = x(Date.parse(pair.exitTime) / 1000);
              const entryY = series.priceToCoordinate(pair.entryPrice), exitY = series.priceToCoordinate(pair.exitPrice);
              if (left === null || right === null || entryY === null || exitY === null) continue;
              const rgb = pair.netPnl > 0 ? '5,150,105' : pair.netPnl < 0 ? '220,38,38' : '100,116,139';
              const top = Math.min(entryY, exitY), width = Math.max(1, right - left), height = Math.max(1, Math.abs(exitY - entryY));
              ctx.fillStyle = `rgba(${rgb},0.15)`;
              ctx.strokeStyle = `rgba(${rgb},0.7)`;
              ctx.lineWidth = 1;
              ctx.fillRect(left, top, width, height); ctx.strokeRect(left, top, width, height);
            }
            ctx.restore();
          });
        },
      }),
    }],
    autoscaleInfo: () => {
      const shown = onScreen();
      return shown.length ? { priceRange: {
        minValue: shown.reduce((min, pair) => Math.min(min, pair.entryPrice, pair.exitPrice), Infinity),
        maxValue: shown.reduce((max, pair) => Math.max(max, pair.entryPrice, pair.exitPrice), -Infinity),
      } } : null;
    },
  };
  series.attachPrimitive(primitive);
  return () => series.detachPrimitive(primitive);
}

export type MarkerRow = { id: string; kind: string; status: string; side: string; displayBarTime: string | null; netPnl: number | null; accountingStatus: string };

export function tradeEntryDirection(row: Pick<MarkerRow, 'kind' | 'side'>): 'Long' | 'Short' | null {
  if (row.kind !== 'entry') return null;
  return ['LONG', 'BUY'].includes(row.side.toUpperCase()) ? 'Long'
    : ['SHORT', 'SELL'].includes(row.side.toUpperCase()) ? 'Short' : null;
}

export function formatTradePnl(value: number) {
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}$${Math.abs(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Chart-series markers stack at candle opens; exact times stay in row detail. */
export function tradeChartMarkers(rows: readonly MarkerRow[]) {
  return rows.filter(row => row.displayBarTime !== null).map(row => {
    const direction = tradeEntryDirection(row);
    const pnl = row.kind === 'close' && row.accountingStatus === 'resolved' && row.netPnl !== null && Number.isFinite(row.netPnl) ? row.netPnl : null;
    return {
      id: row.id,
      time: (Date.parse(row.displayBarTime!) / 1000),
      position: (direction === 'Long' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
      shape: (direction === 'Long' ? 'arrowUp' : direction === 'Short' ? 'arrowDown' : row.kind === 'close' ? 'circle' : 'square') as 'arrowUp' | 'arrowDown' | 'circle' | 'square',
      color: pnl !== null ? pnl > 0 ? '#059669' : pnl < 0 ? '#dc2626' : '#64748b'
        : direction === 'Long' ? '#38bdf8' : direction === 'Short' ? '#a78bfa' : '#64748b',
      text: row.status === 'liquidated' ? `Liquidated${pnl !== null ? ` ${formatTradePnl(pnl)}` : ''}`
        : row.kind === 'close' ? pnl !== null ? formatTradePnl(pnl) : 'Exit · P&L pending'
        : direction ?? (row.kind === 'entry' ? 'Entry' : 'Trade'),
    };
  }).sort((a,b) => a.time-b.time);
}

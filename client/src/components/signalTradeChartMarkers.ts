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

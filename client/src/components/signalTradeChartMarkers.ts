export type MarkerRow = { id: string; kind: string; status: string; displayBarTime: string | null; netPnl: number | null; accountingStatus: string };
/** Chart-series markers stack at candle opens; exact times stay in row detail. */
export function tradeChartMarkers(rows: readonly MarkerRow[]) {
  return rows.filter(row => row.displayBarTime !== null).map(row => ({
    id: row.id,
    time: (Date.parse(row.displayBarTime!) / 1000),
    position: (row.kind === 'entry' ? 'belowBar' : 'aboveBar') as 'belowBar' | 'aboveBar',
    shape: (row.kind === 'entry' ? 'arrowUp' : 'circle') as 'arrowUp' | 'circle',
    color: row.kind === 'close' && row.accountingStatus === 'resolved' && row.netPnl !== null && row.netPnl > 0 ? '#059669' : row.kind === 'close' && row.accountingStatus === 'resolved' && row.netPnl !== null && row.netPnl < 0 ? '#dc2626' : '#64748b',
    text: row.status === 'liquidated' ? 'L' : row.status === 'recovered' ? 'R' : row.kind === 'close' ? 'X' : row.kind === 'entry' ? 'E' : '?',
  })).sort((a,b) => a.time-b.time);
}

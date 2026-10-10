export const CHART_WINDOW_DAYS = 90;
const DAY = 86_400_000;
/** Null means history is empty or the earliest eligible execution is already visible. */
export function earlierChartWindow(from: string, firstEligibleTradeAt: string | null): { from: string; to: string } | null {
  if (firstEligibleTradeAt === null) return null;
  const end = Date.parse(from), first = Date.parse(firstEligibleTradeAt);
  if (!Number.isFinite(end) || !Number.isFinite(first) || end <= first) return null;
  return { from: new Date(Math.max(first, end - CHART_WINDOW_DAYS * DAY)).toISOString(), to: new Date(end).toISOString() };
}

export type NeutralBand = { barTime: string; rowIds: string[]; pairingStatus: 'unproven' };
/** Adjacent SQL pages may split a candle bar; keep one histogram column per bar. */
export function mergeNeutralBands(left: NeutralBand[], right: NeutralBand[]): NeutralBand[] {
  const byTime = new Map<string, NeutralBand>();
  for (const band of [...left, ...right]) {
    const old = byTime.get(band.barTime);
    byTime.set(band.barTime, { barTime: band.barTime, rowIds: [...new Set([...(old?.rowIds ?? []), ...band.rowIds])], pairingStatus: 'unproven' });
  }
  return [...byTime.values()].sort((a, b) => a.barTime.localeCompare(b.barTime));
}

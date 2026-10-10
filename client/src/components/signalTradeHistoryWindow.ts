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

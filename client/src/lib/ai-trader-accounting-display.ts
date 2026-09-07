/** Presentation only: absent accounting is never a zero-valued trade. */
export function accountingNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Other-mode trades are intentionally excluded, not missing from this scope. */
export function performanceCompleteness(value: {
  tradeCount?: unknown;
  omittedUnattributedTrades?: unknown;
  omittedInvalidPnlTrades?: unknown;
}) {
  const counts = [value.tradeCount, value.omittedUnattributedTrades, value.omittedInvalidPnlTrades];
  if (!counts.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
    return { incomplete: true, hasPricedSubtotal: false, missingPnl: null, unattributed: null };
  }
  const [priced, unattributed, missingPnl] = counts as number[];
  const incomplete = unattributed > 0 || missingPnl > 0;
  return { incomplete, hasPricedSubtotal: priced > 0 || !incomplete, missingPnl, unattributed };
}

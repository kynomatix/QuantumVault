// Helpers for interpreting equity_events rows.
//
// The equity_events table doubles as the per-bot "net deposited" ledger: many call
// sites sum a bot's event amounts to derive net-deposited (and from it PnL%, free
// collateral, reconcile gaps). Vault park/unpark rows are INTERNAL reallocations
// (cash <-> yield token inside the SAME wallet), NOT external deposits or
// withdrawals. They carry a positive `amount`, so counting them would inflate
// net-deposited and make a parked bot's PnL read as a false loss. They MUST be
// excluded from every net-deposited sum, while still appearing in event history
// and tax exports.
// UPDATE THIS SET when adding any new vault-internal (cash<->yield) event type,
// or it will silently be counted as a deposit.
export const VAULT_INTERNAL_EVENT_TYPES = new Set<string>(['vault_park', 'vault_unpark']);

export function isVaultInternalEvent(eventType: string | null | undefined): boolean {
  return eventType != null && VAULT_INTERNAL_EVENT_TYPES.has(eventType);
}

/**
 * Sum equity-event amounts that count toward net-deposited. Mirrors the long-standing
 * inline reduce, minus internal Vault park/unpark rows. No-op for any bot that has no
 * vault events (i.e. every bot predating per-bot Vaults).
 */
export function sumNetDepositedFromEvents(
  events: Array<{ eventType?: string | null; amount?: string | null }>,
): number {
  return events.reduce((sum, e) => {
    if (isVaultInternalEvent(e.eventType)) return sum;
    // Guard against a malformed amount: one NaN would otherwise poison the whole
    // sum (s + NaN = NaN) and propagate to PnL%, free collateral, and reconcile.
    const v = parseFloat(e.amount || '0');
    return Number.isFinite(v) ? sum + v : sum;
  }, 0);
}

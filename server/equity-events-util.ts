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
// The same hazard applies to Jupiter Lend borrow/repay: a `borrow` brings USDC
// INTO the wallet but it is a LIABILITY (not the user's own capital), and a
// `repay` pays that liability down. Both carry a positive `amount`, so counting
// either would inflate net-deposited and read as a false PnL swing. They belong
// in the history feed + tax export but never in the deposit denominator.
// SOL Loop Vault events are the same hazard class: loop_open moves wallet SOL
// into SUPPLIED collateral, loop_close / loop_unwind / loop_delever_hold bring
// it back — internal reallocations inside the SAME wallet (and SOL-denominated,
// not USDC), never external deposits or withdrawals. History + tax export only.
// UPDATE THIS SET when adding any new vault-internal (cash<->yield) or
// liability (cash<->debt) event type, or it will silently be counted as a deposit.
// Fixed Yield vault events are the same hazard class again: fy_deposit moves
// wallet USDC into a PT holding, fy_withdraw brings it back — internal
// reallocations inside the SAME wallet, never external deposits/withdrawals.
export const VAULT_INTERNAL_EVENT_TYPES = new Set<string>([
  'vault_park', 'vault_unpark', 'borrow', 'repay',
  'loop_open', 'loop_close', 'loop_unwind', 'loop_delever_hold', 'loop_relever',
  'fy_deposit', 'fy_withdraw',
  // collateral_supplied: collateral moves from agent → lending protocol (internal
  // reallocation). Not a deposit or withdrawal; excluded so it never inflates PnL.
  'collateral_supplied',
]);

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

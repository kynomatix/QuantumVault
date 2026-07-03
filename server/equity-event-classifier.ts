/**
 * Task 119: Single source of truth for classifying equity_events as external
 * flows (true on-chain deposits/withdrawals between the user's main wallet and
 * the agent ATA) vs internal transfers (agent <-> subaccount, auto top-ups,
 * profit reinvestments, exchange-side fees).
 *
 * Trading P&L excludes ALL of these — but the denominator for `%` returns and
 * the snapshot's `netExternalFlow` only see EXTERNAL flows. Misclassifying an
 * internal transfer as external is what caused the May 19→20 phantom drop.
 */

export type EquityEventCategory = 'external_deposit' | 'external_withdraw' | 'internal_transfer' | 'ignore';

const EXTERNAL_DEPOSIT_TYPES = new Set([
  'agent_deposit', // User's main wallet -> agent ATA (USDC)
]);

const EXTERNAL_WITHDRAW_TYPES = new Set([
  'agent_withdraw', // Agent ATA -> user's main wallet (USDC)
]);

const INTERNAL_TRANSFER_TYPES = new Set([
  'drift_deposit',           // Agent ATA -> Drift subaccount
  'drift_withdraw',          // Drift subaccount -> agent ATA
  'auto_topup',              // Auto-deposit from agent ATA when bot needs collateral
  'auto_withdraw',           // Profit auto-withdraw from subaccount -> agent ATA (a.k.a. reinvestment)
  'deposit',                 // Legacy "initial deposit for marketplace subscription" (agent ATA -> bot subaccount)
  'pacifica_withdraw_fee',   // Exchange-side fee on Pacifica withdrawal
  'pacifica_dust_stranded',  // Dust left on exchange after close
  'borrow',                  // Jupiter Lend: USDC borrowed against collateral (a LIABILITY, not a deposit)
  'repay',                   // Jupiter Lend: paying down borrowed-USDC debt
  'loop_open',               // SOL Loop Vault: SOL principal moved into a leveraged LST loop (SOL asset — belt-and-braces; NON_USDC_ASSETS already ignores it)
  'loop_close',              // SOL Loop Vault: full unwind, SOL returned to the agent wallet
  'loop_unwind',             // SOL Loop Vault: partial deleverage, SOL returned to the agent wallet
]);

// Asset-types that are not part of USDC trading P&L (SOL gas tops, etc.).
const NON_USDC_ASSETS = new Set(['SOL']);

export function classifyEquityEvent(event: {
  eventType: string;
  assetType?: string | null;
}): EquityEventCategory {
  if (event.assetType && NON_USDC_ASSETS.has(event.assetType)) return 'ignore';
  if (EXTERNAL_DEPOSIT_TYPES.has(event.eventType)) return 'external_deposit';
  if (EXTERNAL_WITHDRAW_TYPES.has(event.eventType)) return 'external_withdraw';
  if (INTERNAL_TRANSFER_TYPES.has(event.eventType)) return 'internal_transfer';
  // Unknown event types are treated as internal transfers (safe default — they
  // won't bend the % chart or the leaderboard denominator).
  return 'internal_transfer';
}

export function isExternalFlow(event: { eventType: string; assetType?: string | null }): boolean {
  const c = classifyEquityEvent(event);
  return c === 'external_deposit' || c === 'external_withdraw';
}

import type { TradingBot } from '../../../shared/schema';
import { phoenixIdentityFromBot } from './identity';
import { phoenixEquity } from './accounting-equity';
import { signed } from './accounting-contract';
import type { AccountingRepository, PhoenixAccountingService } from './accounting-service';

// No production history provider is installed until native history completeness,
// funding semantics and account-tier evidence are verified for live enablement.
let reconciler: PhoenixAccountingService | null = null;
export function installPhoenixAccountingReconciler(service: PhoenixAccountingService | null) { reconciler = service; }
export function phoenixAccountingTarget(bot: TradingBot) {
  return { botId: bot.id, ownerWallet: bot.walletAddress, identity: phoenixIdentityFromBot(bot) };
}
export async function reconcilePhoenixBotAccounting(bot: TradingBot) {
  if (!reconciler) return { synced: false, discrepancy: true };
  return reconciler.reconcile(phoenixAccountingTarget(bot));
}
export async function readPhoenixAccounting(bot: TradingBot, repository?: AccountingRepository, now = Date.now()) {
  if (!repository) {
    const { pool } = await import('../../db');
    const { PhoenixAccountingStore } = await import('./accounting-store');
    repository = new PhoenixAccountingStore(pool);
  }
  const target = phoenixAccountingTarget(bot), state = await repository.read(target);
  let equity: ReturnType<typeof phoenixEquity> | null = null;
  try { if (state.status === 'complete' && state.snapshot) equity = phoenixEquity(target, state.snapshot, now); } catch { /* stale is unknown */ }
  const closed = state.epochs.filter(e => e.status === 'closed');
  const complete = equity !== null && closed.every(e => e.accounting === 'complete');
  const sum = (key: 'netPnlMicros' | 'feeMicros' | 'fundingMicros') => complete
    ? closed.reduce((n, e) => n + signed(e[key]!), 0n).toString() : null;
  return { venue: 'phoenix' as const, status: equity ? 'reconciled' as const : 'unknown' as const,
    equity, positions: state.epochs.filter(e => e.status === 'open'), history: closed,
    performance: { closedPositions: complete ? closed.length : null,
      winningPositions: complete ? closed.filter(e => signed(e.netPnlMicros!) > 0n).length : null,
      netRealizedPnlMicros: sum('netPnlMicros'), venueFeesMicros: sum('feeMicros'), fundingMicros: sum('fundingMicros'),
      accounting: complete ? 'complete' as const : 'incomplete' as const },
    creatorPayoutsEnabled: false as const, sizingAuthority: false as const };
}
export type PhoenixAccountingDetail = Awaited<ReturnType<typeof readPhoenixAccounting>>;

/** Conversion is display-only; exact accounting stays in decimal integer strings. */
export function displayMicros(value: string | null): number | null {
  if (value === null) return null;
  const n = signed(value); if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(n) / 1_000_000;
}

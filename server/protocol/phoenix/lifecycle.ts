import type { Pool, PoolClient } from 'pg';

export const PHOENIX_RESIDUAL_DOMAINS = [
  'walletTokens', 'solReserve', 'venueMargin', 'positions', 'orders',
  'pendingTransfers', 'parkedValue', 'debt', 'collateral', 'deferredPayouts', 'ingress',
] as const;
export type ResidualDomain = typeof PHOENIX_RESIDUAL_DOMAINS[number];
export interface PhoenixEmptyProof {
  botId: string; authority: string; trader: string; observedAt: number;
  // Each reader must enumerate the entire domain, including unknown tokens,
  // orphan conditionals, disabled vault holdings and legacy payout obligations.
  domains: Partial<Record<ResidualDomain, { complete: boolean; residual: string }>>;
}
export function assessPhoenixEmpty(proof: PhoenixEmptyProof | null, binding: {
  botId: string; authority: string; trader: string;
}, now = Date.now()) {
  if (!proof || proof.botId !== binding.botId || proof.authority !== binding.authority || proof.trader !== binding.trader
    || !Number.isSafeInteger(proof.observedAt) || proof.observedAt > now || now - proof.observedAt > 15_000) {
    return { empty: false, blockers: [...PHOENIX_RESIDUAL_DOMAINS] };
  }
  const blockers = PHOENIX_RESIDUAL_DOMAINS.filter(domain => {
    const value = proof.domains[domain];
    // No dust threshold: rent/gas and sub-minimum cash still require identity.
    return value?.complete !== true || value.residual !== '0';
  });
  return { empty: blockers.length === 0, blockers };
}

export const PHOENIX_RECOVERY_STATUSES = ['phoenix_paused', 'phoenix_archived'] as const;
export function phoenixRiskStopped(status: unknown): boolean {
  return PHOENIX_RECOVERY_STATUSES.some(value => value === status);
}

/** Call only under the U02 bot row lock, at both admission and send claim.
 * Observation and risk-reducing recovery deliberately do not call this gate. */
export async function assertPhoenixNewRisk(client: PoolClient, botId: string): Promise<void> {
  const { rows: [bot] } = await client.query('SELECT * FROM trading_bots WHERE id=$1', [botId]);
  if (!bot || phoenixRiskStopped(bot.subaccount_status)) throw new Error('Phoenix bot is recovery-only');
}

/** Permanent identity retention until venue account deletion/recycling is proven.
 * Archive does not mean flat, settled, swept, or safe to reset the owner wallet. */
export class PhoenixLifecycleStore {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}
  async stop(botId: string, ownerWallet: string, action: 'pause' | 'archive' | 'unsubscribe') {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const { rows: [bot] } = await c.query('SELECT * FROM trading_bots WHERE id=$1 AND wallet_address=$2 FOR UPDATE', [botId, ownerWallet]);
      if (!bot || bot.active_protocol !== 'phoenix') throw new Error('Phoenix bot not owned');
      const status = action === 'pause' && bot.subaccount_status !== 'phoenix_archived' ? 'phoenix_paused' : 'phoenix_archived';
      await c.query(`UPDATE trading_bots SET is_active=false,execution_active=false,auto_park_due_at=NULL,
        subaccount_status=$2,updated_at=now() WHERE id=$1`, [botId, status]);
      // Drain only unsigned entries. Submitted/ambiguous work survives for U07
      // reconciliation; it can never be relabelled as cancelled or empty.
      await c.query(`UPDATE phoenix_order_intents SET state='rejected',revision=revision+1,updated_at=now(),
        data=data || '{"reason":"Phoenix lifecycle stopped new risk"}'::jsonb
        WHERE bot_id=$1 AND intent->>'action'='entry' AND state IN ('admitted','signing') AND NOT (data ? 'attempt')`, [botId]);
      await c.query(`UPDATE trade_retry_queue SET status='failed',last_error='Phoenix recovery uses durable Phoenix operations'
        WHERE bot_id=$1 AND status='pending'`, [botId]);
      if (status === 'phoenix_archived') await c.query('UPDATE published_bots SET is_active=false WHERE trading_bot_id=$1', [botId]);
      // Paused links preserve capital, creator liabilities and subscriber counts.
      await c.query(`UPDATE bot_subscriptions SET status='paused' WHERE subscriber_bot_id=$1 AND status='active'`, [botId]);
      const { rows } = await c.query(`SELECT id FROM phoenix_operations WHERE bot_id=$1 AND state NOT IN ('completed','failed','dropped')
        UNION ALL SELECT id FROM phoenix_order_intents WHERE bot_id=$1 AND state NOT IN ('settled','rejected')`, [botId]);
      await c.query('COMMIT');
      return { botId, venue: 'phoenix' as const, archived: status === 'phoenix_archived', paused: true,
        recoveryRetained: true, pendingOperations: rows.length, settlement: 'unverified' as const,
        emptiness: assessPhoenixEmpty(null, { botId, authority: bot.phoenix_authority_wallet, trader: bot.phoenix_trader_account }),
        hardDeleteAllowed: false, code: 'PHOENIX_RECOVERY_RETAINED',
        message: 'New risk is stopped. Funds, debt, payouts and recovery identity are retained; settlement requires recovery.' };
    } catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
}

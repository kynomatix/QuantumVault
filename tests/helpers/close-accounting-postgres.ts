import type { Pool } from 'pg';

// Each pool has its own search_path. Copy the migrated test database's column definitions,
// defaults, checks and indexes into empty tables in that schema.
export async function installCloseAccountingTables(pool: Pool) {
  const tables = ['wallets', 'trading_bots', 'bot_positions', 'bot_trades', 'bot_subscriptions',
    'published_bots', 'pending_profit_shares', 'webhook_logs', 'platform_cumulative_stats'];
  for (const table of tables) {
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
  }
}

export async function seedCloseBot(pool: Pool, id: string, wallet: string, account: string | null) {
  await pool.query(`INSERT INTO trading_bots
    (id, wallet_address, name, market, webhook_secret, active_protocol, subaccount_auth_mode, protocol_subaccount_id)
    VALUES ($1::text, $2, $1::text, 'BTC-PERP', 'EXAMPLE_' || $1, 'pacifica', 'external_key', $3)`, [id, wallet, account]);
}

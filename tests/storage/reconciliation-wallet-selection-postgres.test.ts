import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

const connection = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../server/db', () => ({
  get db() { return connection.db; }, pool: {},
}));
import { DatabaseStorage } from '../../server/storage';

// Never skip: missing PostgreSQL must fail visibly, not count as proven coverage.
describe('SB07 real PostgreSQL reconciliation wallet selection', () => {
  let pool: Pool;
  let client: PoolClient;
  const storage = new DatabaseStorage();
  const select = () => {
    // The base control must exercise the former selector, never fail on a missing method.
    const selector = storage.getWalletsForReconciliation ?? storage.getWalletsWithActiveBots;
    return selector.call(storage);
  };
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('UNPROVEN: real PostgreSQL unavailable');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 });
    client = await pool.connect();
    await client.query('BEGIN');
    // Transaction-local temporary relations isolate fixtures from concurrent runner suites.
    // Their numeric type is pinned to the live product schema; no persistent DDL is run.
    const columns = await client.query(`SELECT data_type, numeric_precision, numeric_scale, is_nullable
      FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bot_positions' AND column_name = 'base_size'`);
    expect(columns.rows).toEqual([{ data_type: 'numeric', numeric_precision: 20, numeric_scale: 8, is_nullable: 'NO' }]);
    await client.query(`CREATE TEMP TABLE trading_bots
      (id text PRIMARY KEY, wallet_address text NOT NULL, market text NOT NULL,
       is_active boolean NOT NULL, active_protocol text NOT NULL) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE bot_positions
      (trading_bot_id text NOT NULL, market text NOT NULL, base_size numeric(20,8) NOT NULL) ON COMMIT DROP`);
    connection.db = drizzle(client);
  }, 20000);
  beforeEach(async () => { await client.query('TRUNCATE pg_temp.bot_positions, pg_temp.trading_bots'); });
  afterAll(async () => {
    if (client) { await client.query('ROLLBACK'); client.release(); }
    if (pool) await pool.end();
  });
  async function seed(size: string | undefined, fields: { active?: boolean; protocol?: string; positionMarket?: string; id?: string } = {}) {
    const id = fields.id ?? 'EXAMPLE_BOT';
    await client.query('INSERT INTO trading_bots VALUES ($1,$2,$3,$4,$5)',
      [id, 'EXAMPLE_WALLET', 'BTC-PERP', fields.active ?? false, fields.protocol ?? 'pacifica']);
    if (size !== undefined) await client.query('INSERT INTO bot_positions VALUES ($1,$2,$3)',
      [id, fields.positionMarket ?? 'BTC-PERP', size]);
  }
  it.each([
    ['long', '1', true], ['short', '-1', true], ['flat', '0', false],
    ['positive boundary', '0.0001', false], ['negative boundary', '-0.0001', false],
    ['above positive boundary', '0.00010001', true], ['above negative boundary', '-0.00010001', true],
    ['NaN', 'NaN', false], ['missing position', undefined, false],
  ] as const)('selects %s with PostgreSQL numeric semantics', async (_name, size, included) => {
    await seed(size);
    expect(await select()).toEqual(included ? ['EXAMPLE_WALLET'] : []);
  });
  it('selects mixed wallets exactly once using one SELECT DISTINCT', async () => {
    await seed('1'); await seed('-1', { id: 'EXAMPLE_SECOND' });
    await seed('0', { active: true, id: 'EXAMPLE_ACTIVE' });
    const query = vi.spyOn(client, 'query');
    try {
      expect(await select()).toEqual(['EXAMPLE_WALLET']);
      expect(query).toHaveBeenCalledTimes(1);
      expect(String((query.mock.calls[0][0] as any).text)).toMatch(/^select distinct/i);
    } finally { query.mockRestore(); }
  });
  it('excludes paused Flash bots holding positions', async () => {
    await seed('1', { protocol: 'flash' }); expect(await select()).toEqual([]);
  });
  it.each(['ETH-PERP', 'btc-perp'])('requires exact bot market identity instead of %s', async positionMarket => {
    await seed('1', { positionMarket }); expect(await select()).toEqual([]);
  });
  it('cannot borrow a position from another bot', async () => {
    await seed(undefined); await client.query('INSERT INTO bot_positions VALUES ($1,$2,$3)', ['EXAMPLE_OTHER', 'BTC-PERP', '1']);
    expect(await select()).toEqual([]);
  });
  it('keeps active Flash and flat wallets and the legacy active-only selector unchanged', async () => {
    await seed('0', { active: true, protocol: 'flash' });
    expect(await select()).toEqual(['EXAMPLE_WALLET']);
    expect(await storage.getWalletsWithActiveBots()).toEqual(['EXAMPLE_WALLET']);
  });
});

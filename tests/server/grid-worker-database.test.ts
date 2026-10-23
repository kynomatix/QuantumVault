import { afterEach, describe, expect, it, vi } from 'vitest';
import { gridWorkerFixtureUrl } from '../helpers/grid-worker-fixture-url';
const state = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), close: vi.fn(), options: [] as Record<string, any>[],
}));
vi.mock('pg', () => ({ default: { Pool: class {
  constructor(options: Record<string, any>) { state.options.push(options); }
  on() {}
  async connect() { return { query: state.query, release: state.release }; }
  end = state.close;
} } }));
import { createGridWorkerDatabase } from '../../server/grid-worker/database';
afterEach(() => { vi.clearAllMocks(); state.options.length = 0; });
describe('U1 dedicated database bounds', () => {
  it('uses exactly one pool of four with verified TLS and session bounds', async () => {
    state.query.mockResolvedValue({ rows: [{ statement_timeout: '2s', idle_timeout: '12s', keepalive_idle: '5' }] });
    const db = createGridWorkerDatabase(gridWorkerFixtureUrl() + '?sslmode=require');
    expect(state.options).toHaveLength(1);
    expect(state.options[0]).toMatchObject({ max: 4, ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 2000, query_timeout: 2000, keepAliveInitialDelayMillis: 5000, options: '-c statement_timeout=2000 -c idle_in_transaction_session_timeout=12000 -c tcp_keepalives_idle=5' });
    expect(state.options[0].connectionString).not.toContain('sslmode');
    await db.connect(); await db.close();
    expect(state.query.mock.calls[0][0]).toContain("current_setting('statement_timeout')");
    expect(state.close).toHaveBeenCalledOnce();
  });
  it('destroys a client when readback fails instead of retaining an unsafe session', async () => {
    const db = createGridWorkerDatabase(gridWorkerFixtureUrl());
    for (const settings of [{}, { statement_timeout: '30s', idle_timeout: '12s', keepalive_idle: '5' }]) {
      state.query.mockResolvedValue({ rows: [settings] });
      await expect(db.connect()).rejects.toThrow('GRID_WORKER_DATABASE_BOUNDS_INVALID');
    }
    state.query.mockRejectedValue(new Error('EXAMPLE private database detail'));
    await expect(db.connect()).rejects.toThrow('GRID_WORKER_DATABASE_BOUNDS_INVALID');
    expect(state.release).toHaveBeenLastCalledWith(true);
  });
  it('refuses weak TLS overrides and missing URL credentials before allocating a pool', () => {
    for (const url of ['postgresql://localhost/EXAMPLE', gridWorkerFixtureUrl() + '?sslmode=disable', gridWorkerFixtureUrl() + '?sslcert=EXAMPLE', gridWorkerFixtureUrl().replace('postgresql:', 'http:')]) expect(() => createGridWorkerDatabase(url)).toThrow('GRID_WORKER_DATABASE_CONFIG_INVALID');
    expect(state.options).toHaveLength(0);
  });
});

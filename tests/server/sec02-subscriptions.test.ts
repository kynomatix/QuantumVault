import { describe, expect, it, vi } from 'vitest';
import { dispatch, execute, registration, section, source } from '../helpers/sec02-route-harness';

function harness() {
  const text = source('server/routes.ts'), store = source('server/storage.ts');
  const auth = section(text, '  const requireAuth =', '  const requireWallet =');
  const methods = section(store, '  async updateSubscriptionStatus(', '  async getPortfolio(');
  const row = { id: 'subscription', userId: 'user-owner', status: 'active' };
  const eq = (column: string, value: unknown) => ({ column, value });
  const and = (...conditions: any[]) => conditions;
  let updates: any, predicate: any;
  const apply = () => {
    const matches = (Array.isArray(predicate) ? predicate : [predicate]).every(({ column, value }) => row[column as keyof typeof row] === value);
    if (matches) { row.status = updates.status; return [{ id: row.id }]; }
    return [];
  };
  const query = {
    set: vi.fn((value: any) => { updates = value; return query; }),
    where: vi.fn((value: any) => { predicate = value; return query; }),
    returning: vi.fn(async () => apply()),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(apply()).then(resolve),
  };
  const db = { update: vi.fn(() => query), select: vi.fn(() => { throw new Error('Unexpected read-before-write'); }) };
  let handlers: any[] = [];
  const storage = execute(`class Store { ${methods} } return new Store();`, {
    db, eq, and, subscriptions: { id: 'id', userId: 'userId' },
  });
  execute(`${auth}\n${registration(text, 'patch', '/api/subscriptions/:id')}`, {
    app: { patch: (_path: string, ...registered: any[]) => { handlers = registered; } }, storage,
  });
  const request = (userId: string, id = row.id) => dispatch(handlers, { session: { userId }, params: { id }, body: { status: 'cancelled' } });
  return { request, row, query, db };
}
describe('SEC02-DISCRIMINATING-SERVER legacy subscriptions', () => {
  it('refuses a foreign session and an unknown id without modifying the legacy row', async () => {
    const h = harness();
    for (const [user, id] of [['user-other', 'subscription'], ['user-owner', 'missing']]) {
      const res = await h.request(user, id);
      expect(res.statusCode).toBe(404); expect(res.body).toEqual({ error: 'Subscription not found' });
      expect(h.row.status).toBe('active');
    }
    expect(h.db.select).not.toHaveBeenCalled();
    expect(h.query.where).toHaveBeenCalledWith([{ column: 'id', value: 'subscription' }, { column: 'userId', value: 'user-other' }]);
  });
});
describe('SEC02-PRESERVATION legacy subscriptions', () => {
  it('retains the rightful session owner success body and update', async () => {
    const h = harness(); const res = await h.request('user-owner');
    expect(res.statusCode).toBe(200); expect(res.body).toEqual({ success: true }); expect(h.row.status).toBe('cancelled');
  });
});

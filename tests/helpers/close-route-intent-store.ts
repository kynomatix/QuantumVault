import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';

// Route fixtures exercise the real admission service with an in-memory storage port.
// The actual storage/trigger/transaction contract is covered by the isolated PG suite.
export function makeCloseRouteStore(storage: any) {
  const rows = new Map<string, any>();
  const store: any = {
    reset: () => rows.clear(), ready: vi.fn(async () => {}),
    withScope: async (environment: string, account: string, market: string, work: any) => work({ environment, account, market, token: {} }),
    withOpenFence: async (_e: string, _a: string, _m: string, work: any) => work(),
    withLifecycle: async (_a: string, work: any) => work(),
    unresolved: async (s: any) => [...rows.values()].find(r => r.environment === s.environment && r.original_account === s.account && r.market === s.market && ['pending','needs_user'].includes(r.status)),
    hasLegacyPending: async () => false,
    create: async (s: any, input: any, trade: any) => {
      const prior = await store.unresolved(s); if (prior) return { intent: prior, created: false };
      const linked = await storage.createBotTrade({ ...trade, status: 'pending' });
      const row = { ...input, id: randomUUID(), original_trade_id: linked.id, status: 'pending', revision: 0,
        attempt_count: 0, attempt_log: [], dispatch_state: 'not_admitted', last_evidence: {}, created_at: new Date(), next_action_at: new Date() };
      rows.set(row.id, row); return { intent: row, created: true };
    },
    databaseTime: async () => Date.now(), assertSendAuthorized: vi.fn(async () => {}),
    mutate: async (_s: any, row: any, fields: any) => { const next = { ...row, ...fields, revision: row.revision + 1 }; rows.set(row.id, next); return next; },
    admit: async (s: any, row: any, attempt: any) => store.mutate(s, row, { attempt_log: [...row.attempt_log, attempt], attempt_count: row.attempt_count + 1, dispatch_state: 'admitted_unknown' }),
    outcome: async (s: any, row: any, id: string, outcome: any) => store.mutate(s, row, { attempt_log: row.attempt_log.map((a: any) => a.attemptId === id ? { ...a, outcome, receivedAt: Date.now() } : a), dispatch_state: outcome.kind === 'not_entered' ? 'proven_not_landed' : 'admitted_unknown' }),
    settle: async (s: any, row: any, fields: any) => store.mutate(s, row, fields),
    dueAccounting: async () => [],
    byId: async (_s: any, id: string) => rows.get(id), due: async () => [],
    statusForBot: async () => null, historyStatuses: async () => new Map(), legacyInventory: async () => [],
  };
  return store;
}

export function bridgePreparedClose(adapter: any) {
  const calls = new WeakMap<object, any>();
  adapter.getCloseEnvironment = () => 'EXAMPLE';
  adapter.prepareReduceOnlyMarketOrder = async (params: any) => {
    const prepared = { account: params.agentPublicKey, environment: 'EXAMPLE', market: params.internalSymbol,
      operationData: { symbol: params.internalSymbol.replace('-PERP',''), amount: params.sizeBaseExact ?? String(params.sizeBase),
        side: params.side === 'long' ? 'bid' : 'ask', reduce_only: true, client_order_id: params.clientOrderId } };
    calls.set(prepared, params); return prepared;
  };
  adapter.sendPreparedReduceOnlyMarketOrder = async (prepared: any) => {
    const result = await adapter.placeMarketOrder(calls.get(prepared));
    return result.success && result.orderId && result.landingDisposition !== 'unconfirmed' ? { kind: 'acknowledged', orderId: result.orderId }
      : { kind: 'ambiguous', cause: result.error ?? 'EXAMPLE_UNKNOWN' };
  };
}

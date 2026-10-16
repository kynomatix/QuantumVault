import { describe, expect, it, vi } from 'vitest';
import { registerPhoenixFundingRoutes } from '../../server/protocol/phoenix/funding-routes';
import { PhoenixOwnershipError } from '../../server/protocol/phoenix/operation-store';
const hooks = vi.hoisted(() => ({ runtime: null as any }));
vi.mock('../../server/protocol/phoenix/production', () => ({ getPhoenixProduction: () => hooks.runtime ? { funding: hooks.runtime } : null }));

describe('U04 funding history failures', () => {
  it.each([[new PhoenixOwnershipError('EXAMPLE-unowned'), 404], [new Error('EXAMPLE-database-outage'), 503]])('distinguishes ownership from infrastructure failure', async (error, status) => {
    const handlers = new Map<string, any>();
    const app = { get: (path: string, ...callbacks: any[]) => handlers.set(path, callbacks.at(-1)), post: vi.fn() };
    registerPhoenixFundingRoutes(app as any, vi.fn(), { history: vi.fn().mockRejectedValue(error) });
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handlers.get('/api/phoenix/bots/:botId/funding')({ params: { botId: 'EXAMPLE-bot' }, walletAddress: 'EXAMPLE-owner' }, res);
    expect(res.status).toHaveBeenCalledWith(status);
  });
  it('dispatches authenticated owner mutations and contains ownership errors', async () => {
    const handlers = new Map<string, any>(), auth = vi.fn();
    const app = { get: vi.fn(), post: (path: string, ...callbacks: any[]) => { expect(callbacks[0]).toBe(auth); handlers.set(path, callbacks.at(-1)); } };
    hooks.runtime = { preview: vi.fn().mockResolvedValue({ quoteId: 'EXAMPLE' }), execute: vi.fn().mockResolvedValue({ state: 'submission_pending' }), resume: vi.fn().mockResolvedValue({ funded: false }) };
    registerPhoenixFundingRoutes(app as any, auth, { history: vi.fn() });
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req = { params: { botId: 'EXAMPLE-bot' }, walletAddress: 'EXAMPLE-owner', body: { quoteId: 'EXAMPLE', consent: true } };
    for (const action of ['preview', 'deposit', 'withdraw', 'resume']) await handlers.get(`/api/phoenix/bots/:botId/funding/${action}`)(req, res);
    expect(hooks.runtime.preview).toHaveBeenCalledWith('EXAMPLE-bot', 'EXAMPLE-owner', req.body);
    expect(hooks.runtime.execute).toHaveBeenCalledWith('EXAMPLE-bot', 'EXAMPLE-owner', 'withdraw', req.body);
    expect(hooks.runtime.resume).toHaveBeenCalledWith('EXAMPLE-bot', 'EXAMPLE-owner', req.body);
    hooks.runtime.preview.mockRejectedValueOnce(new PhoenixOwnershipError('EXAMPLE-unowned'));
    await handlers.get('/api/phoenix/bots/:botId/funding/preview')(req, res);
    expect(res.status).toHaveBeenLastCalledWith(404);
    await handlers.get('/api/phoenix/bots/:botId/funding/preview')({ ...req, body: [] }, res);
    expect(res.status).toHaveBeenLastCalledWith(400);
    hooks.runtime = null;
  });
});

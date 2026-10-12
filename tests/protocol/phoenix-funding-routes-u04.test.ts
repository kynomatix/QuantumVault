import { describe, expect, it, vi } from 'vitest';
import { registerPhoenixFundingRoutes } from '../../server/protocol/phoenix/funding-routes';
import { PhoenixOwnershipError } from '../../server/protocol/phoenix/operation-store';

describe('U04 funding history failures', () => {
  it.each([[new PhoenixOwnershipError('EXAMPLE-unowned'), 404], [new Error('EXAMPLE-database-outage'), 503]])('distinguishes ownership from infrastructure failure', async (error, status) => {
    const handlers = new Map<string, any>();
    const app = { get: (path: string, ...callbacks: any[]) => handlers.set(path, callbacks.at(-1)), post: vi.fn() };
    registerPhoenixFundingRoutes(app as any, vi.fn(), { history: vi.fn().mockRejectedValue(error) });
    const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handlers.get('/api/phoenix/bots/:botId/funding')({ params: { botId: 'EXAMPLE-bot' }, walletAddress: 'EXAMPLE-owner' }, res);
    expect(res.status).toHaveBeenCalledWith(status);
  });
});

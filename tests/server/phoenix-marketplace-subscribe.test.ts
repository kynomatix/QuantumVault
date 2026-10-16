import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Reuse the registered-route storage/session stubs used by the server route tests.
vi.mock('../../server/storage', () => {
  const target: Record<string, ReturnType<typeof vi.fn>> = {};
  const storage = new Proxy(target, {
    get: (target, property: string | symbol) => {
      if (typeof property !== 'string' || property === 'then') return undefined;
      return (target[property] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {}
  return { storage, DatabaseStorage };
});
vi.mock('../../server/session', () => ({
  sessionMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.session = { walletAddress: 'EXAMPLE-subscriber' };
    next();
  },
}));
// This refusal must not need a database or a protocol adapter.
vi.mock('../../server/db', () => ({ db: {}, pool: {}, isConnectionClassError: vi.fn(() => false) }));
vi.mock('../../server/analytics-indexer', () => ({
  startAnalyticsIndexer: vi.fn(), getMetrics: vi.fn(), calculateAndStoreMetrics: vi.fn(),
}));

import { storage } from '../../server/storage';
import { registerRoutes } from '../../server/routes';
import { phoenixConsumerDisabled } from '../../server/protocol/phoenix/consumer-service';

let server: Server | undefined;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  server = await registerRoutes(createServer(app), app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No ephemeral test port');
  baseUrl = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>(resolve => server!.close(() => resolve()));
});

describe('POST /api/marketplace/:id/subscribe', () => {
  it('returns the Phoenix consumer disabled body with 503 for a Phoenix creator', async () => {
    vi.mocked(storage.getPublishedBotById).mockResolvedValue({
      id: 'EXAMPLE-listing', tradingBotId: 'EXAMPLE-creator', isActive: true,
    } as any);
    vi.mocked(storage.getBotSubscription).mockResolvedValue(undefined);
    vi.mocked(storage.getTradingBotById).mockResolvedValue({
      id: 'EXAMPLE-creator', activeProtocol: 'phoenix',
    } as any);
    const createBot = vi.mocked(storage.createTradingBot);
    createBot.mockClear();
    const requestId = 'EXAMPLE-request';
    const response = await fetch(`${baseUrl}/api/marketplace/EXAMPLE-listing/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capitalInvested: 100, leverage: 2, requestId }),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(phoenixConsumerDisabled(requestId));
    expect(storage.getTradingBotById).toHaveBeenCalledWith('EXAMPLE-creator');
    expect(createBot).not.toHaveBeenCalled();
  });
});

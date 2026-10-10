import { afterEach, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import { registerPhoenixReadRoutes } from '../../server/protocol/phoenix/routes';
import { getPhoenixReader } from '../../server/protocol/phoenix/runtime';

vi.mock('../../server/protocol/phoenix/runtime', () => ({ getPhoenixReader: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
function route() {
  const app = { get: vi.fn() }; registerPhoenixReadRoutes(app as unknown as Express);
  expect(app.get.mock.calls[0][0]).toBe('/api/phoenix/readiness');
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  return { handler: app.get.mock.calls[0][1], res };
}
it('returns 404 without accessing the reader while disabled', async () => {
  vi.stubEnv('PHOENIX_READS_ENABLED', 'false'); const { handler, res } = route(); await handler({}, res);
  expect(res.status).toHaveBeenCalledWith(404); expect(getPhoenixReader).not.toHaveBeenCalled();
});
it('returns 503 when Phoenix startup failed', async () => {
  vi.stubEnv('PHOENIX_READS_ENABLED', 'true'); vi.mocked(getPhoenixReader).mockReturnValue(null);
  const { handler, res } = route(); await handler({}, res); expect(res.status).toHaveBeenCalledWith(503);
});
it('returns cached capabilities and markets without upstream refresh', async () => {
  vi.stubEnv('PHOENIX_READS_ENABLED', 'true');
  const reader = { getCapabilities: vi.fn(() => ({ venue: 'phoenix', mode: 'read-only' })),
    getMarkets: vi.fn(() => ({ state: 'unknown', value: null })), getPrices: vi.fn(() => ({ state: 'unknown', value: null })), refresh: vi.fn() };
  vi.mocked(getPhoenixReader).mockReturnValue(reader as any);
  const { handler, res } = route(); await handler({}, res);
  expect(res.json).toHaveBeenCalledWith({ capabilities: { venue: 'phoenix', mode: 'read-only' },
    markets: { state: 'unknown', value: null }, prices: { state: 'unknown', value: null } });
  expect(reader.refresh).not.toHaveBeenCalled(); expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
});

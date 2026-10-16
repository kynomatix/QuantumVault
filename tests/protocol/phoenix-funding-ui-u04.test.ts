import { it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { Express } from 'express';
import { registerPhoenixFundingRoutes, PHOENIX_FUNDING_DISABLED } from '../../server/protocol/phoenix/funding-routes';
import { phoenixFundingDetail } from '../../server/protocol/phoenix/funding-detail';
import { phoenixMeasuredDelayText } from '../../shared/phoenix-funding-contract';
import { PhoenixWithdrawalDetail } from '../../client/src/components/PhoenixWithdrawalDetail';
import { PhoenixOwnershipError } from '../../server/protocol/phoenix/operation-store';

it.each(['pacifica', 'drift', 'flash', undefined])('keeps U04 withdrawal detail hidden for %s', activeProtocol => {
  expect(renderToStaticMarkup(createElement(PhoenixWithdrawalDetail, { visible: true, activeProtocol }))).toBe('');
});
it('shows unmeasured delay and distinguishes release from wallet cash while Phoenix remains disabled', () => {
  const html = renderToStaticMarkup(createElement(PhoenixWithdrawalDetail, { visible: true, activeProtocol: 'phoenix' }));
  expect(html).toContain('Withdrawal delay not yet measured'); expect(html).toContain('unwrapped to USDC');
  expect(html).toContain('Recovery money actions are unavailable until the server enables them');
  expect(renderToStaticMarkup(createElement(PhoenixWithdrawalDetail, { visible: false, activeProtocol: 'phoenix' }))).toBe('');
});
it('displays historical request-to-observed-release mean and range without including dropped requests', () => {
  const row = (id: string, state: string, completedAt?: number) => ({ id, state, created_at: new Date(1000),
    intent: { funding: { leg: 'withdraw' } }, observation: { funding: { requestedAt: 1000, queuedAt: 2000, completedAt, ...(state === 'dropped' ? { droppedAt: 100000 } : {}) } } });
  const detail = phoenixFundingDetail([row('EXAMPLE-1', 'completed', 11000), row('EXAMPLE-2', 'completed', 31000), row('EXAMPLE-3', 'dropped')] as any);
  expect(detail.measured).toEqual({ samples: 2, meanSeconds: 20, minSeconds: 10, maxSeconds: 30, lastCompletedAt: 31000 });
  expect(detail.droppedSamples).toBe(1); expect(detail.autoReturn || detail.parking || detail.debt || detail.enabled).toBe(false);
  expect(phoenixMeasuredDelayText(detail.measured)).toContain('20.0 seconds average (2 completed requests; 10.0–30.0 seconds)');
});
it('requires wallet authentication for history and disabled action routes, and scopes history to the authenticated owner', async () => {
  const app = { get: vi.fn(), post: vi.fn() }; const auth = vi.fn(); const history = vi.fn().mockResolvedValue([]);
  registerPhoenixFundingRoutes(app as unknown as Express, auth, { history });
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() }; res.status.mockReturnValue(res);
  const fundingGet = app.get.mock.calls.find(call => call[0] === '/api/phoenix/bots/:botId/funding')!;
  expect(fundingGet).toBeDefined(); expect(fundingGet[1]).toBe(auth);
  const req = { params: { botId: 'EXAMPLE-bot' }, walletAddress: 'EXAMPLE-owner', body: { ownerWallet: 'EXAMPLE-attacker' } };
  await fundingGet[2](req, res); expect(history).toHaveBeenCalledWith('EXAMPLE-bot', 'EXAMPLE-owner');
  expect(res.json).toHaveBeenCalledWith(phoenixFundingDetail([]));
  history.mockRejectedValueOnce(new PhoenixOwnershipError('EXAMPLE-not-owned'));
  await fundingGet[2](req, res); expect(res.status).toHaveBeenCalledWith(404);
  history.mockRejectedValueOnce(new Error('EXAMPLE-unavailable'));
  await fundingGet[2](req, res); expect(res.status).toHaveBeenCalledWith(503);
  const fundingPosts = app.post.mock.calls.filter(call => call[0].startsWith('/api/phoenix/bots/:botId/funding/'));
  expect(fundingPosts.map(call => call[0].split('/').pop())).toEqual(['preview', 'deposit', 'withdraw', 'resume']);
  for (const call of fundingPosts) { expect(call[1]).toBe(auth); await call[2](req, res); expect(res.json).toHaveBeenLastCalledWith(PHOENIX_FUNDING_DISABLED); }
});
it('gates Phoenix before incumbent decryption, independent-trader shortcut and exchange adapter dispatch', () => {
  const routes = readFileSync('server/routes.ts', 'utf8');
  expect(routes.indexOf('registerPhoenixFundingRoutes(app, requireWallet')).toBeGreaterThan(routes.indexOf('const requireWallet ='));
  const deposit = routes.slice(routes.indexOf('app.post("/api/exchange/deposit"'), routes.indexOf('const withdrawFromExchange'));
  expect(deposit.indexOf('PHOENIX_FUNDING_DISABLED')).toBeLessThan(deposit.indexOf('getUmkForWebhook'));
  expect(deposit.indexOf('PHOENIX_FUNDING_DISABLED')).toBeLessThan(deposit.indexOf("'independent_trader'"));
  const withdrawal = routes.slice(routes.indexOf('const withdrawFromExchange'), routes.indexOf('const withdrawFromExchange') + 13000);
  expect(withdrawal.indexOf('PHOENIX_FUNDING_DISABLED')).toBeLessThan(withdrawal.indexOf('getUmkForWebhook'));
  expect(withdrawal.indexOf('PHOENIX_FUNDING_DISABLED')).toBeLessThan(withdrawal.indexOf('getAdapterForBot'));
  const drawer = readFileSync('client/src/components/BotManagementDrawer.tsx', 'utf8');
  expect(drawer).toContain('<PhoenixEquityDetail');
  expect(drawer).toContain("visible={isOpen && activeTab === 'equity'}");
  const equity = readFileSync('client/src/components/PhoenixEquityDetail.tsx', 'utf8');
  expect(equity).toContain('<PhoenixWithdrawalDetail');
  expect(equity).toContain('botId={botId} walletAddress={walletAddress} activeProtocol="phoenix" visible={visible}');
});

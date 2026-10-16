import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handlePhoenixRegistrationCreate, registerPhoenixOnboardingRoutes } from '../../server/protocol/phoenix/onboarding-routes';
import { PhoenixOnboardingError } from '../../server/protocol/phoenix/production';

function fixture(holder: any = null) {
  const routes = new Map<string, any[]>();
  const app = { get: (path: string, ...handlers: any[]) => routes.set(`GET ${path}`, handlers),
    post: (path: string, ...handlers: any[]) => routes.set(`POST ${path}`, handlers) };
  const auth = vi.fn();
  const getHolder = vi.fn(() => holder);
  registerPhoenixOnboardingRoutes(app as any, auth, getHolder);
  const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const req = { walletAddress: 'EXAMPLE-owner', params: { botId: 'EXAMPLE-bot' }, body: {} };
  return { routes, auth, res, req, getHolder };
}
describe('Unit 2A authenticated routes', () => {
  it('uses incumbent wallet authentication before both owned handlers', () => {
    const { routes, auth } = fixture();
    expect(routes.size).toBe(2);
    for (const handlers of routes.values()) expect(handlers[0]).toBe(auth);
  });
  it('contains an absent holder and marks responses no-store', async () => {
    const { routes, res, req } = fixture();
    await routes.get('GET /api/phoenix/canary/preflight')!.at(-1)(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    await routes.get('POST /api/phoenix/bots/:botId/onboarding/resume')!.at(-1)(req, res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
  it('preflight delegates only the authenticated owner', async () => {
    const holder = { preflight: vi.fn().mockResolvedValue({ authorized: true }) };
    const { routes, req, res } = fixture(holder);
    await routes.get('GET /api/phoenix/canary/preflight')!.at(-1)({ ...req, query: { owner: 'EXAMPLE-other', signer: 'EXAMPLE' } }, res);
    expect(holder.preflight).toHaveBeenCalledWith('EXAMPLE-owner');
    expect(res.json).toHaveBeenCalledWith({ authorized: true });
  });
  it('resumes the owned bot without new-risk gates or client intents', async () => {
    const holder = { resume: vi.fn().mockResolvedValue({ code: 'submission_unknown' }) };
    const { routes, req, res } = fixture(holder);
    const handler = routes.get('POST /api/phoenix/bots/:botId/onboarding/resume')!.at(-1);
    await handler(req, res);
    expect(holder.resume).toHaveBeenCalledWith('EXAMPLE-owner', 'EXAMPLE-bot');
    holder.resume.mockClear();
    await handler({ ...req, body: { signer: 'EXAMPLE' } }, res);
    expect(res.status).toHaveBeenCalledWith(400); expect(holder.resume).not.toHaveBeenCalled();
  });
  it.each([new PhoenixOnboardingError(404, 'PHOENIX_BOT_NOT_FOUND'), new Error('EXAMPLE-private-referral')])('does not expose private errors or another owner', async error => {
    const holder = { resume: vi.fn().mockRejectedValue(error) };
    const { routes, req, res } = fixture(holder);
    await routes.get('POST /api/phoenix/bots/:botId/onboarding/resume')!.at(-1)(req, res);
    expect(res.status).toHaveBeenCalledWith(error instanceof PhoenixOnboardingError ? 404 : 503);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('EXAMPLE-private-referral');
  });
  it.each(['completed', 'submission_unknown', 'insufficient_gas', 'disabled'])('terminates create for %s', async code => {
    const holder = { create: vi.fn().mockResolvedValue({ code }) };
    const { res, getHolder } = fixture(holder);
    const input = { activeProtocol: 'phoenix', requestId: 'EXAMPLE' };
    await handlePhoenixRegistrationCreate('EXAMPLE-owner', input, res as any, getHolder);
    expect(holder.create).toHaveBeenCalledWith('EXAMPLE-owner', input);
    expect(res.json).toHaveBeenCalledWith({ code });
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });
  it('contains create failures and absent capability without a legacy fallback', async () => {
    const { res } = fixture();
    await handlePhoenixRegistrationCreate('EXAMPLE-owner', {}, res as any, () => null);
    expect(res.status).toHaveBeenCalledWith(503);
    await handlePhoenixRegistrationCreate('EXAMPLE-owner', {}, res as any, () => ({ create: vi.fn().mockRejectedValue(new Error('EXAMPLE-private')) }) as any);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('EXAMPLE-private');
  });
  it('preserves Pacifica create and routes Phoenix signal and safety work to owned facades', () => {
    const source = readFileSync('server/routes.ts', 'utf8');
    const start = source.indexOf('app.post("/api/trading-bots", requireWallet');
    const create = source.slice(start, start + 1100);
    expect(create).toMatch(/if \(String\(req.body.activeProtocol\).toLowerCase\(\) === "phoenix"\) \{\s+return handlePhoenixRegistrationCreate/);
    expect(create).toContain('const { name, market, side, leverage, maxPositionSize, totalInvestment, signalConfig, riskConfig }');
    expect(source).toContain("return handlePhoenixSignalPatch(req.walletAddress!, bot.id, req.body, res)");
    expect(source).toContain('return handlePhoenixTradingView(bot, req.body, res)');
    expect(source).toContain("await phoenixSafetyDispatch(req.walletAddress!, bot.id, bot.market, 'close', req.body)");
    expect(source).toContain('return res.status(503).json(phoenixOrderDisabled())');
    const funding = readFileSync('server/protocol/phoenix/funding-routes.ts', 'utf8');
    expect(funding).toContain('503');
    const index = readFileSync('server/index.ts', 'utf8');
    expect(index.indexOf("import('./protocol/phoenix/production')")).toBeGreaterThan(index.indexOf('await logSecurityConfigSummary()'));
    expect(index.indexOf("import('./protocol/phoenix/production')")).toBeLessThan(index.indexOf('await registerRoutes(httpServer, app)'));
    expect(index).toContain('void import');
  });
});

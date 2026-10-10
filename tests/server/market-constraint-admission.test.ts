import { describe, expect, it, vi, afterEach, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, request, type Server } from 'node:http';
import { evaluateNotionalFloor } from '../../server/trade-sizing-math.js';
import { observePacificaConstraints, checkEntryConstraints, minimumOpeningPriceForSizing, marketConstraintView, unavailableMark }
  from '../../server/protocol/market-constraints.js';

describe('Signal entry market constraint admission', () => {
  it('rejects unavailable sizing inputs before a collateral bump can be computed', () => {
    expect(evaluateNotionalFloor(1, 100, Number.NaN, 0.01)).toMatchObject({ rejected: true });
    expect(evaluateNotionalFloor(1, 100, 10, 0)).toMatchObject({ rejected: true });
  });

  it('rejects missing lot authority before a Signal bump', async () => {
    await expectNoSizingEffects(sizingFixture({ tick_size: '0.1', lot_size: '0', min_order_size: '10' }), 'constraint_unavailable');
  });

  it('rejects non-positive price or minimum before a Signal bump', async () => {
    await expectNoSizingEffects(sizingFixture({ tick_size: '0.1', lot_size: '0.01', min_order_size: '0' }), 'constraint_unavailable');
    const input = sizingFixture();
    await expectNoSizingEffects({ ...input, markPrice: { ...input.markPrice, exact: '0' } }, 'mark_price_unavailable');
  });

  it('quantizes an already sufficient Signal proposal down before intent', () => {
    expect(evaluateNotionalFloor(0.345, 100, 10, 0.1)).toMatchObject({
      needsBump: false, quantizedContracts: 0.3,
    });
  });

  it('sizes a market proposal against its current mark', () => {
    const strictest = minimumOpeningPriceForSizing({ kind: 'market', mark: 100 });
    expect(strictest).toBe(100);
    if (strictest === null) throw new Error('market mark unavailable');
    const result = evaluateNotionalFloor(0.099, strictest, 10, 0.001);
    expect(result.rejected).toBeUndefined();
    if (result.rejected) throw new Error(result.reason);
    expect(result.needsBump).toBe(true);
    expect(result.bumpedContracts * strictest).toBeGreaterThanOrEqual(10);
  });

  it('sizes a limit or stop proposal against the mark and its own price', () => {
    for (const kind of ['limit', 'stop_market'] as const) for (const ownPrice of [90, 110]) {
      const strictest = minimumOpeningPriceForSizing({ kind, mark: 100,
        ...(kind === 'limit' ? { limit: ownPrice } : { trigger: ownPrice }) });
      expect(strictest).toBe(Math.min(100, ownPrice));
      if (strictest === null) throw new Error('opening price unavailable');
      const result = evaluateNotionalFloor(0.1, strictest, 10, 0.001);
      expect(result.rejected).toBeUndefined();
      if (result.rejected) throw new Error(result.reason);
      expect(result.bumpedContracts * 100).toBeGreaterThanOrEqual(10);
      expect(result.bumpedContracts * ownPrice).toBeGreaterThanOrEqual(10);
    }
  });

  it('cannot size an opening without the current mark', () => {
    expect(minimumOpeningPriceForSizing({ kind: 'market' })).toBeNull();
    expect(minimumOpeningPriceForSizing({ kind: 'limit', limit: 11 })).toBeNull();
  });

  it('does not renew original observation age when a registry copy is read', () => {
    const observation = observePacificaConstraints({ tick_size: '0.1', lot_size: '0.001', min_order_size: '10' },
      'SOL-PERP', 1_000);
    const registryCopy = { constraintObservation: observation };
    expect(checkEntryConstraints(registryCopy.constraintObservation, 'SOL-PERP', 301_001))
      .toMatchObject({ ok: false, code: 'constraint_expired' });
  });
});


// Install before module evaluation; restored spies return to a denying transport.
const deniedHttp = vi.hoisted(() => {
  const attempts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    attempts.push(String(input));
    throw new Error('Unmocked HTTP denied by test network boundary');
  }) as typeof fetch;
  return attempts;
});
afterEach(() => {
  const unexpected = deniedHttp.splice(0);
  expect(unexpected, 'Every HTTP read must be explicitly mocked').toEqual([]);
});

const routeMocks = vi.hoisted(() => {
  const defaultAdapter = {
    protocolName: 'pacifica',
    minTransferAmount: 1,
    getMarkets: vi.fn(),
    getAccountInfo: vi.fn(),
    transferBetweenSubaccounts: vi.fn(),
    getFeeRateQuote: vi.fn(),
    placeMarketOrder: vi.fn(),
    getMarkPrice: vi.fn(),
    getPrice: vi.fn(),
    getPositions: vi.fn(),
    getStrictPositionForMarket: vi.fn(),
    getCapabilities: vi.fn(() => ({})),
  };
  return {
    defaultAdapter,
    selectedAdapter: defaultAdapter as any,
    getUmkForWebhook: vi.fn(),
    decryptAgentKeyStrict: vi.fn(),
  };
});

const TEST_WALLET = 'wallet-leverage-source-test';

vi.mock('../../server/notification-service', () => ({
  sendTradeNotification: vi.fn(async () => undefined),
  sendAutoTopUpNotification: vi.fn(async () => undefined),
  sendLoopSafetyNotification: vi.fn(async () => undefined),
  getCloseReasonLabel: vi.fn(),
  schedulePartialCloseNotification: vi.fn(),
  buildDefaultInlineKeyboard: vi.fn(),
}));

vi.mock('../../server/storage', () => {
  const target: Record<string, any> = {};
  const storage = new Proxy(target, {
    get: (object, property: string | symbol) => {
      if (typeof property !== 'string' || property === 'then') return undefined;
      return (object[property] ??= vi.fn(async () => undefined));
    },
  });
  class DatabaseStorage {
    static canonicalCloseFillId() { return 'test-close-fill'; }
  }
  return { storage, DatabaseStorage };
});

vi.mock('../../server/session', () => ({
  sessionMiddleware: (req: any, _res: unknown, next: () => void) => {
    req.session = { walletAddress: TEST_WALLET };
    next();
  },
}));

vi.mock('../../server/db', () => ({
  db: {},
  isConnectionClassError: vi.fn(() => false),
}));

vi.mock('../../server/analytics-indexer', () => ({
  startAnalyticsIndexer: vi.fn(),
  getMetrics: vi.fn(),
  calculateAndStoreMetrics: vi.fn(),
}));

vi.mock('../../server/session-v3', () => ({
  createSigningNonce: vi.fn(),
  verifySignatureAndConsumeNonce: vi.fn(),
  initializeWalletSecurity: vi.fn(),
  getSession: vi.fn(),
  getSessionByWalletAddress: vi.fn(),
  invalidateSession: vi.fn(),
  cleanupExpiredNonces: vi.fn(),
  revealMnemonic: vi.fn(),
  enableExecution: vi.fn(),
  revokeExecution: vi.fn(),
  emergencyStopWallet: vi.fn(),
  getUmkForWebhook: routeMocks.getUmkForWebhook,
  healExecutionUmkFromStorage: vi.fn(),
  restoreWalletSecurityFromStorage: vi.fn(),
  computeBotPolicyHmac: vi.fn(),
  verifyBotPolicyHmac: vi.fn(),
  decryptAgentKeyStrict: routeMocks.decryptAgentKeyStrict,
  decryptBotSubaccountKey: vi.fn(),
  repairStaleV3AgentKeyFromLegacy: vi.fn(),
  generateAgentWalletWithMnemonic: vi.fn(),
  encryptAndStoreMnemonic: vi.fn(),
  encryptMnemonicForStorage: vi.fn(),
  encryptAgentKeyV3: vi.fn(),
  encryptBotSubaccountKeyV3: vi.fn(),
  encryptPooledSubaccountKeyV3: vi.fn(),
  rebindRetainedKeyToBotUuidV3: vi.fn(),
  rebindSubaccountKeyToPooledV3: vi.fn(),
  decryptMnemonic: vi.fn(),
  deriveBotKeypairFromAgentSeed: vi.fn(),
  BOT_DERIVATION_PATH_VERSION: 1,
}));

vi.mock('../../server/protocol/adapter-registry', () => ({
  getAdapter: vi.fn(() => routeMocks.selectedAdapter),
  getDefaultAdapter: vi.fn(() => routeMocks.defaultAdapter),
  getAdapterForBot: vi.fn(() => routeMocks.selectedAdapter),
}));


import { computeTradeSizingAndTopUp, registerRoutes, routeSignalToSubscribers } from '../../server/routes';
import { storage } from '../../server/storage';
import { updateMarketCache } from '../../server/market-registry';
import { Keypair } from '@solana/web3.js';
const sizingKey = Keypair.generate();
function sizingFixture(raw = { tick_size: '0.1', lot_size: '0.01', min_order_size: '10' }) {
  const observation = observePacificaConstraints(raw, 'SOL-PERP', Date.now());
  const market = { internalSymbol: 'SOL-PERP', protocolSymbol: 'SOL', maxLeverage: 5, maxLeverageSource: 'venue',
    isActive: true, category: [], fullName: 'Solana', maintenanceMarginWeight: 0.1,
    riskTier: 'recommended', estimatedSlippagePct: 0, constraintObservation: observation,
    ...marketConstraintView(observation, Date.now()) };
  updateMarketCache([market as any]);
  routeMocks.defaultAdapter.getMarkets.mockResolvedValue([market]);
  routeMocks.defaultAdapter.getAccountInfo.mockResolvedValue({ equity: 100, balance: 100, availableMargin: 100, maintenanceMargin: 0, unrealizedPnl: 0 });
  const now = Date.now();
  return { sizingProtocol: 'pacifica' as const, markPrice: { kind: 'available' as const, venue: 'pacifica' as const,
    source: '/info/prices' as const, field: 'mark' as const, internalSymbol: 'SOL-PERP', protocolSymbol: 'SOL',
    exact: '50', observedAt: now, receivedAt: now, expiresAt: now + 5000 },
    adapter: routeMocks.defaultAdapter as any, agentPublicKey: sizingKey.publicKey.toString(),
    agentPrivateKeyEncrypted: sizingKey.secretKey, subAccountId: 0, botId: 'test', walletAddress: 'wallet',
    market: 'SOL-PERP', baseCapital: 20, leverage: 5, autoTopUp: true,
    profitReinvestEnabled: false, signalPercent: 100, oraclePrice: 100, logPrefix: '[ConstraintTest]' };
}
beforeEach(() => { vi.clearAllMocks(); });
async function expectNoSizingEffects(input: any, code: string) {
  const result = await computeTradeSizingAndTopUp(input);
  expect(result).toMatchObject({ success: false, finalContractSize: 0, constraintRejection: { code }, completedEffects: [] });
  expect(routeMocks.defaultAdapter.getAccountInfo).not.toHaveBeenCalled();
  expect(routeMocks.defaultAdapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
  expect(routeMocks.defaultAdapter.placeMarketOrder).not.toHaveBeenCalled();
}
describe('Round 2 actual Signal sizing boundaries', () => {
  it('rejects typed missing mark before account reads or capital effects', async () => {
    const input = sizingFixture();
    await expectNoSizingEffects({ ...input, markPrice: unavailableMark('SOL-PERP', 'SOL', 'transport_failed') }, 'mark_price_unavailable');
  });
  it('uses mark for minimum bump and oracle for accounting', async () => {
    const input = sizingFixture();
    const result = await computeTradeSizingAndTopUp({ ...input, baseCapital: 10 });
    expect(result.success).toBe(true);
    expect(result.finalContractSize).toBe(0.21);
    expect(result.tradeAmountUsd).toBe(21);
  });
  it('rejects refreshed unavailable mark after a collateral await before returning intent', async () => {
    const input = sizingFixture(); const now = Date.now();
    routeMocks.defaultAdapter.getAccountInfo.mockImplementationOnce(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
      return { equity: 100, balance: 100, availableMargin: 100, maintenanceMargin: 0, unrealizedPnl: 0 };
    });
    input.adapter.getMarkPrice = vi.fn(async () => unavailableMark('SOL-PERP', 'SOL', 'transport_failed'));
    try {
      const result = await computeTradeSizingAndTopUp(input);
      expect(result).toMatchObject({ success: false, finalContractSize: 0, constraintRejection: { code: 'mark_price_unavailable' } });
      expect(input.adapter.getMarkPrice).toHaveBeenCalledWith('SOL-PERP');
      expect(input.adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
});

describe('Round 2 five route triggers use typed mark admission', () => {
  let server: Server;
  let port: number;
  const priorEnv = process.env.ADMIN_PASSWORD;
  const bot = {
    id: 'constraint-route-bot', walletAddress: TEST_WALLET, name: 'Constraint route bot',
    market: 'SOL-PERP', activeProtocol: 'pacifica', isActive: true,
    webhookSecret: 'TV_TEST', side: 'both', leverage: 5,
    maxPositionSize: '2', autoTopUp: true, profitReinvest: false,
    driftSubaccountId: 0, policyHmac: null, protocolSubaccountId: null,
  };
  beforeAll(async () => {
    process.env.ADMIN_PASSWORD = 'ADMIN_TEST';
    const app = express();
    app.use(express.json());
    server = await registerRoutes(createServer(app), app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    port = address.port;
  }, 60_000);
  afterAll(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (priorEnv === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = priorEnv;
  });

  // Only this loopback request bypasses the global denying fetch transport.
  function post(path: string, payload: object): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path, method: 'POST', headers: {
        'content-type': 'application/json', authorization: 'Bearer ADMIN_TEST',
      } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end(JSON.stringify(payload));
    });
  }

  for (const trigger of ['subscriber', 'manual', 'tradingview', 'user', 'debug'] as const) {
    it.each(['fresh', 'stale', 'failed'] as const)(`${trigger} carries typed mark through real sizing: %s`, async mode => {
      const fixture = sizingFixture();
      const adapter = routeMocks.defaultAdapter;
      const stub = (name: keyof typeof storage, value: unknown) => {
        vi.mocked(storage[name]).mockResolvedValue(value as never);
      };
      stub('getTradingBotById', bot);
      stub('getWallet', {
        walletAddress: TEST_WALLET, address: TEST_WALLET,
        agentPublicKey: sizingKey.publicKey.toBase58(), agentPrivateKeyEncryptedV3: 'test-envelope',
        executionEnabled: true, executionExpiresAt: null, emergencyStopTriggered: false,
        userWebhookSecret: 'USER_TEST', slippageBps: 50,
      });
      stub('getBotPosition', null);
      stub('createWebhookLog', { id: 'constraint-log' });
      stub('createBotTrade', { id: 'constraint-trade' });
      stub('getPublishedBotByTradingBotId', trigger === 'subscriber' || trigger === 'debug'
        ? { id: 'constraint-published', isActive: true } : null);
      stub('getSubscriberBotsBySourceId', [bot]);
      routeMocks.getUmkForWebhook.mockResolvedValue({ umk: Buffer.alloc(32, 7), cleanup: vi.fn() });
      routeMocks.decryptAgentKeyStrict.mockResolvedValue({ secretKey: sizingKey.secretKey.slice(), cleanup: vi.fn() });
      adapter.getPrice.mockResolvedValue(100);
      adapter.getPositions.mockResolvedValue([]);
      adapter.getStrictPositionForMarket.mockResolvedValue(null);
      adapter.getFeeRateQuote.mockImplementation(async identity => ({ ...identity,
        subaccountId: identity.subaccountId ?? null, protocol: 'pacifica', availability: 'available',
        baseRate: 0.001, effectiveRate: 0.001, provenance: 'test fee authority',
        observedAt: Date.now(), builder: { status: 'absent' },
      }));
      adapter.placeMarketOrder.mockResolvedValue({ success: false, error: 'Test stops at order boundary' });
      adapter.getMarkPrice.mockReset();
      if (mode === 'failed') adapter.getMarkPrice.mockRejectedValue(new Error('mark read failed'));
      else adapter.getMarkPrice.mockResolvedValue(mode === 'fresh' ? fixture.markPrice
        : { ...fixture.markPrice, observedAt: Date.now() - 6000, expiresAt: Date.now() - 1000 });

      let response = '';
      if (trigger === 'subscriber') {
        await routeSignalToSubscribers('constraint-source', { action: 'buy', contracts: '0.01',
          positionSize: '1', price: '100', isCloseSignal: false, strategyPositionSize: '0.01' });
        response = JSON.stringify(vi.mocked(storage.createBotTrade).mock.calls);
      } else if (trigger === 'manual') {
        response = await post(`/api/trading-bots/${bot.id}/manual-trade`, { side: 'long' });
      } else if (trigger === 'debug') {
        response = await post('/api/admin/debug-routing/constraint-source', {});
      } else {
        const path = trigger === 'tradingview'
          ? `/api/webhook/tradingview/${bot.id}?secret=TV_TEST`
          : `/api/webhook/user/${TEST_WALLET}?secret=USER_TEST`;
        response = await post(path, { botId: bot.id, action: 'buy', contracts: '0.01',
          position_size: '0.01', price: '100', symbol: 'SOLUSD', time: `${trigger}-${mode}` });
      }
      expect(adapter.getMarkPrice, response).toHaveBeenCalledWith('SOL-PERP');
      if (mode === 'fresh') {
        expect(adapter.getAccountInfo, response).toHaveBeenCalled();
        // At oracle=100 the floor is 0.11; mark=50 must produce 0.21.
        if (trigger === 'debug') {
          expect(JSON.parse(response).results[0]).toMatchObject({ sizingSuccess: true,
            finalContractSize: 0.21, tradeAmountUsd: 21, wouldExecuteTrade: true });
          expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
        } else {
          expect(adapter.placeMarketOrder, response).toHaveBeenCalledWith(expect.objectContaining({ sizeBase: 0.21 }));
        }
      } else {
        if (trigger === 'manual' || trigger === 'tradingview' || trigger === 'user') {
          expect(JSON.parse(response)).toMatchObject({ error: mode === 'stale' ? 'stale' : 'transport_failed' });
        } else {
          expect(response).toMatch(/mark/i);
        }
        expect(adapter.getAccountInfo).not.toHaveBeenCalled();
        expect(adapter.transferBetweenSubaccounts).not.toHaveBeenCalled();
        expect(adapter.placeMarketOrder).not.toHaveBeenCalled();
      }
    });
  }
});

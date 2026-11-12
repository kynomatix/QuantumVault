import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const mocks = vi.hoisted(() => ({
  storage: {
    getWallet: vi.fn(), getTradingBots: vi.fn(), sumOpenBorrowDebtUsdc: vi.fn(),
    getWalletCumulativeDepositsWithdrawals: vi.fn(), getWalletTradeStats: vi.fn(),
    getWalletCreatorEarnings: vi.fn(), getPortfolioDailySnapshots: vi.fn(),
  },
  adapter: { getAccountInfo: vi.fn() },
  connection: { getAccountInfo: vi.fn(), getTokenAccountBalance: vi.fn(), getBalance: vi.fn() },
  reconcile: vi.fn(),
}));
vi.mock('../../server/storage', () => ({ storage: mocks.storage }));
vi.mock('../../server/db', () => ({ db: {} }));
vi.mock('../../server/solana-balance-read', () => ({ getConnection: () => mocks.connection }));
vi.mock('../../server/rpc-config', () => ({ createSolanaRpcConnection: () => mocks.connection }));
vi.mock('../../server/swap/index.js', () => ({ getBestQuote: vi.fn(), getProviderByName: vi.fn() }));
vi.mock('../../server/deposit-reconciler', () => ({ reconcileWalletDeposits: mocks.reconcile }));
vi.mock('../../server/vault/vault-service', () => ({ sumVaultPositionValueUsdc: vi.fn() }));
vi.mock('../../server/protocol/flash/manual-withdrawal', () => ({ getManualFlashWithdrawalAdapter: vi.fn() }));
vi.mock('../../server/protocol/adapter-registry', () => ({
  getDefaultAdapter: () => mocks.adapter, getAdapterForBot: () => mocks.adapter,
  listAdapters: vi.fn(), getAdapter: vi.fn(), getAdapterHealth: vi.fn(),
}));
import { computeWalletTotalBalance } from '../../server/portfolio-snapshot-job';
import { __internals } from '../../server/public-portfolio';
import type { PortfolioProtocolBlock } from '../../sonarwatch-plugin/quantumvault/types';

// Execute the actual route callback without booting unrelated trading routes,
// authentication, or database services. Only its dynamic import is injected.
const source = readFileSync('server/routes.ts', 'utf8');
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
function createRouteHandler(routeSource: string) {
  const file = ts.createSourceFile('routes.ts', routeSource, ts.ScriptTarget.Latest, true);
  const callbacks: ts.ArrowFunction[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'app'
      && node.expression.name.text === 'get'
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
      && node.arguments[0].text === '/api/portfolio-performance') {
      const callback = node.arguments[node.arguments.length - 1];
      if (!ts.isArrowFunction(callback) || !ts.isBlock(callback.body)) {
        throw new Error('Portfolio route callback must be an arrow function with a block');
      }
      callbacks.push(callback);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (callbacks.length !== 1) throw new Error(`Expected one portfolio route, found ${callbacks.length}`);
  const callback = callbacks[0];
  const start = callback.getStart(file);
  let callbackText = callback.getText(file);
  const imports: ts.AwaitExpression[] = [];
  function findImport(node: ts.Node) {
    if (ts.isAwaitExpression(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.kind === ts.SyntaxKind.ImportKeyword
      && ts.isStringLiteral(node.expression.arguments[0])
      && node.expression.arguments[0].text === './portfolio-snapshot-job') imports.push(node);
    ts.forEachChild(node, findImport);
  }
  findImport(callback);
  if (imports.length !== 1) throw new Error('Expected one portfolio snapshot dependency import');
  const injectedImport = imports[0];
  callbackText = callbackText.slice(0, injectedImport.getStart(file) - start)
    + 'dependencies' + callbackText.slice(injectedImport.end - start);
  const compiled = ts.transpileModule(`export const handle = ${callbackText};`, { compilerOptions }).outputText;
  return new Function('exports', 'storage', 'reconcileWalletDeposits', 'dependencies',
    `${compiled}\nreturn exports.handle;`)(
    {}, mocks.storage, mocks.reconcile, { computeWalletTotalBalance },
  );
}
const handle = createRouteHandler(source);

// The plugin lives in the external SonarWatch monorepo. Execute its entire
// module here with only that SDK and its configuration supplied as fixtures.
const pluginSource = readFileSync('sonarwatch-plugin/quantumvault/positionsFetcher.ts', 'utf8');
const pluginCompiled = ts.transpileModule(pluginSource, { compilerOptions }).outputText;
const plugin = new Function('exports', 'require', `${pluginCompiled}\nreturn exports.positionsFetcher;`)({}, (id: string) => {
  if (id === '@sonarwatch/portfolio-core') return {
    NetworkId: { solana: 'solana' }, PortfolioElementType: { multiple: 'multiple', leverage: 'leverage' },
    PortfolioAssetType: { token: 'token' }, solanaNativeAddress: 'EXAMPLE_NATIVE_SOL',
  };
  if (id === './constants') return { platformId: 'quantumvault', PORTFOLIO_ENDPOINT: 'https://example.invalid/portfolio' };
  throw new Error(`Unexpected plugin runtime dependency: ${id}`);
});
async function pluginElements(protocols: PortfolioProtocolBlock[]) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ protocols }) }));
  return plugin.executor('EXAMPLE_OWNER', { getTokenPrice: vi.fn().mockResolvedValue({ price: 1 }) });
}

const snapshot = (date: string | Date) => ({
  snapshotDate: new Date(date instanceof Date ? date.getTime() : date), totalBalance: '110', cumulativeTradingPnl: '30', netPnl: '30', pnlPercent: '30',
});
function localDay(offset: number) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return date;
}
function historySnapshots(hasToday: boolean) {
  const snapshots = [snapshot(localDay(-1))];
  if (hasToday) snapshots.push(snapshot(localDay(0)));
  return snapshots;
}
async function liveResponse(routeHandler = handle) {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  await routeHandler({ walletAddress: 'EXAMPLE_OWNER', query: { range: 'all' } }, res);
  expect(res.status).not.toHaveBeenCalled();
  return res.json.mock.calls[0][0];
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.storage.getWallet.mockResolvedValue({});
  const bot = { id: 'EXAMPLE_BOT', isActive: true, activeProtocol: 'pacifica', subaccountAuthMode: 'external_key', subaccountStatus: 'active', protocolSubaccountId: 'EXAMPLE_ACCOUNT' };
  mocks.storage.getTradingBots.mockResolvedValue([bot, { ...bot, id: 'EXAMPLE_SECOND_BOT', protocolSubaccountId: 'EXAMPLE_SECOND_ACCOUNT' }]);
  mocks.adapter.getAccountInfo.mockResolvedValue({ balance: 60 });
  mocks.storage.sumOpenBorrowDebtUsdc.mockResolvedValue(0);
  mocks.storage.getWalletCumulativeDepositsWithdrawals.mockResolvedValue({ deposits: 100, withdrawals: 20 });
  mocks.storage.getWalletTradeStats.mockResolvedValue({ totalTrades: 7, totalVolume: 900 });
  mocks.storage.getWalletCreatorEarnings.mockResolvedValue(3);
  mocks.storage.getPortfolioDailySnapshots.mockResolvedValue(historySnapshots(false));
  mocks.connection.getAccountInfo.mockResolvedValue({ data: Buffer.alloc(165) });
  mocks.connection.getTokenAccountBalance.mockResolvedValue({ value: { uiAmount: 12 } });
  mocks.connection.getBalance.mockResolvedValue(1_000_000_000);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('portfolio route extraction', () => {
  it('executes a reformatted registration with single quotes, CRLF and nested callbacks', async () => {
    const reformatted = source.replace(
      /app\.get\("\/api\/portfolio-performance", requireWallet, async \(req, res\) => \{/,
      "app\n .get(\n '/api/portfolio-performance',\n requireWallet,\n async (req, res) => {\n  await Promise.resolve().then(() => {\n  });",
    ).replace(/await import\('\.\/portfolio-snapshot-job'\)/, 'await import( "./portfolio-snapshot-job" )')
      .replace(/\r?\n/g, '\r\n');
    expect(reformatted).not.toBe(source);
    expect(await liveResponse(createRouteHandler(reformatted))).toMatchObject({
      dataCompleteness: 'complete', currentBalance: 120, netPnl: 40,
    });
  });

  it('rejects absent or ambiguous registrations instead of running an unrelated callback', () => {
    expect(() => createRouteHandler('app.get("/unrelated", async () => {});')).toThrow('found 0');
    expect(() => createRouteHandler(`${source}\n${source}`)).toThrow('found 2');
  });
});

describe('live portfolio completeness', () => {
  it('keeps complete numbers and appends the live point', async () => {
    const data = await liveResponse();
    expect(data).toMatchObject({ dataCompleteness: 'complete', currentBalance: 120, netPnl: 40, pnlPercent: 40 });
    expect(data.chartData).toHaveLength(3);
    expect(data.chartData.at(-1)).toMatchObject({ balance: 120, netPnl: 40, pnlPercent: 40 });
  });

  it.each([false, true])('preserves stored history on a failed bot read (today snapshot: %s)', async hasToday => {
    const snapshots = historySnapshots(hasToday);
    mocks.storage.getPortfolioDailySnapshots.mockResolvedValue(snapshots);
    mocks.adapter.getAccountInfo.mockResolvedValueOnce({ balance: 60 }).mockRejectedValueOnce(new Error('EXAMPLE_BOT_RPC_FAILURE'));
    const data = await liveResponse();
    expect(data).toMatchObject({
      dataCompleteness: 'partial', currentBalance: null, netPnl: null, pnlPercent: null,
      totalDeposits: 100, totalWithdrawals: 20, totalTrades: 7, totalVolume: 900,
      creatorEarnings: 3, activeBotCount: 2, totalBots: 2,
    });
    expect(data.chartData).toHaveLength(snapshots.length + 1);
    expect(data.chartData.slice(1)).toEqual(snapshots.map(s => ({ date: s.snapshotDate, balance: 110, netPnl: 30, pnlPercent: 30 })));
    const recovered = await liveResponse();
    expect(recovered).toMatchObject({ dataCompleteness: 'complete', currentBalance: 120, netPnl: 40, pnlPercent: 40 });
    expect(recovered.chartData).toHaveLength(snapshots.length + (hasToday ? 1 : 2));
    expect(recovered.chartData.at(-1).date).toEqual(localDay(0));
    expect(recovered.chartData.at(-1)).toMatchObject({ balance: 120, netPnl: 40 });
  });

  it('replaces the existing local-today point without appending in UTC and both timezone extremes', async () => {
    const originalTimezone = process.env.TZ;
    try {
      for (const [timezone, offset] of [['UTC', 0], ['America/Los_Angeles', 480], ['Pacific/Kiritimati', -840]] as const) {
        process.env.TZ = timezone;
        // Both UTC boundaries also cover hosts whose current local date differs from UTC.
        for (const instant of ['2026-11-12T01:00:00Z', '2026-11-12T23:00:00Z']) {
          vi.setSystemTime(new Date(instant));
          expect(new Date().getTimezoneOffset()).toBe(offset);
          const today = localDay(0);
          mocks.storage.getPortfolioDailySnapshots.mockResolvedValue(historySnapshots(true));
          mocks.adapter.getAccountInfo.mockRejectedValueOnce(new Error('EXAMPLE_BOT_RPC_FAILURE'));
          const partial = await liveResponse();
          expect(partial.chartData).toHaveLength(3);
          expect(partial.chartData.at(-1)).toMatchObject({ date: today, balance: 110, netPnl: 30 });
          const recovered = await liveResponse();
          expect(recovered.chartData).toHaveLength(3);
          expect(recovered.chartData.at(-1)).toMatchObject({ date: today, balance: 120, netPnl: 40 });
        }
      }
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it('does not invent a point when a partial wallet has no stored history', async () => {
    mocks.storage.getPortfolioDailySnapshots.mockResolvedValue([]);
    mocks.adapter.getAccountInfo.mockRejectedValueOnce(new Error('EXAMPLE_BOT_RPC_FAILURE'));
    expect(await liveResponse()).toMatchObject({ dataCompleteness: 'partial', chartData: [] });
  });

  it('preserves a true zero as complete', async () => {
    mocks.adapter.getAccountInfo.mockResolvedValue({ balance: 0 });
    expect(await liveResponse()).toMatchObject({ dataCompleteness: 'complete', currentBalance: 0, netPnl: -80, pnlPercent: -80 });
  });
});

describe('public agent wallet block uses strict display readers', () => {
  const agent = '11111111111111111111111111111111';
  it.each(['getAccountInfo', 'getTokenAccountBalance', 'getBalance'] as const)('reports error on rejected %s', async method => {
    mocks.connection[method].mockRejectedValueOnce(new Error('EXAMPLE_RPC_FAILURE'));
    expect(await __internals.fetchAgentWalletBlock(agent)).toMatchObject({
      id: 'agent_wallet', status: 'error', error: 'Failed to read on-chain balances', positions: [],
    });
  });

  it('reports ok and real zeros for an uninitialised ATA and empty SOL account', async () => {
    mocks.connection.getAccountInfo.mockResolvedValue(null);
    mocks.connection.getBalance.mockResolvedValue(0);
    expect(await __internals.fetchAgentWalletBlock(agent)).toEqual({
      id: 'agent_wallet', status: 'ok', error: undefined, balance: { usdc: 0, sol: 0 }, positions: [],
    });
    expect(mocks.connection.getTokenAccountBalance).not.toHaveBeenCalled();
  });

  it('retains complete nonzero balances', async () => {
    expect(await __internals.fetchAgentWalletBlock(agent)).toMatchObject({ status: 'ok', balance: { usdc: 12, sol: 1 } });
  });

  it('keeps a wallet without an agent key ok and skips RPC', async () => {
    expect(await __internals.fetchAgentWalletBlock(null)).toEqual({ id: 'agent_wallet', status: 'ok', balance: { usdc: 0, sol: 0 }, positions: [] });
    expect(mocks.connection.getAccountInfo).not.toHaveBeenCalled();
    expect(mocks.connection.getBalance).not.toHaveBeenCalled();
  });
});

describe('SonarWatch agent-wallet disclosure', () => {
  it.each(['getTokenAccountBalance', 'getBalance'] as const)('omits a rejected %s block even when the other balance is nonzero', async method => {
    mocks.connection[method].mockRejectedValueOnce(new Error('EXAMPLE_RPC_FAILURE'));
    const block = await __internals.fetchAgentWalletBlock('11111111111111111111111111111111');
    expect(block).toMatchObject({ status: 'error', balance: method === 'getBalance' ? { usdc: 12, sol: 0 } : { usdc: 0, sol: 1 } });
    const healthyProtocol: PortfolioProtocolBlock = { id: 'pacifica', status: 'ok', balance: { equity: 50 }, positions: [] };
    const elements = await pluginElements([block, healthyProtocol]);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ name: 'pacifica perps', value: 50 });
  });

  it.each(['partial', 'circuit_open', 'unavailable'] as const)('omits %s agent-wallet numbers', async status => {
    expect(await pluginElements([{ id: 'agent_wallet', status, balance: { usdc: 12, sol: 1 }, positions: [] }])).toEqual([]);
  });

  it('preserves complete nonzero wallet assets and hides genuine empty wallets', async () => {
    const block = await __internals.fetchAgentWalletBlock('11111111111111111111111111111111');
    const elements = await pluginElements([block]);
    expect(elements).toHaveLength(1);
    expect(elements[0]).toMatchObject({ name: 'Agent Wallet (idle)', value: 13 });
    expect(elements[0].data.assets.map((asset: { data: { amount: number } }) => asset.data.amount)).toEqual([12, 1]);
    expect(await pluginElements([{ ...block, balance: { usdc: 0, sol: 0 } }])).toEqual([]);
  });
});

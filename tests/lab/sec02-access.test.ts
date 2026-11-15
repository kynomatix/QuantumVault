import { createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, execute, registration, response, section, source } from '../helpers/sec02-route-harness';

const text = source('server/lab/routes.ts');
const auth = section(text, '  const authenticateLab =', '  app.get("/api/lab/tickers"');
const jobOwner = text.includes('  async function ownsLabJob(')
  ? section(text, '  async function ownsLabJob(', '  app.get("/api/lab/job/:id/progress"') : '';
const cacheAdmin = text.includes('  const requireLabCacheAdmin =')
  ? section(text, '  const requireLabCacheAdmin =', '  app.delete("/api/lab/cache"') : '';
const paths = ['/api/lab/job/:id/progress', '/api/lab/job/:id/results', '/api/lab/export/csv/:id'];
const owners = ['recorded-wallet', 'run-owner', 'run-strategy', 'job-strategy'] as const;

function harness(method: string, path: string) {
  let handlers: any[] = [];
  const state = {
    job: { walletAddress: 'wallet-owner', runId: 7, config: { strategyId: 9 }, progress: { status: 'complete' }, listeners: new Set() } as any,
    run: { userId: 'wallet-owner', strategyId: 8 } as any,
    strategy: { id: 8, userId: 'wallet-owner', pineScript: 'EXAMPLE', name: 'Example' } as any,
  };
  const results = { configs: [{ ticker: 'BTC', timeframe: '1h', params: {}, totalTrades: 3 }] };
  const labStorage = {
    getJob: vi.fn((id: string) => id === 'missing' ? undefined : state.job),
    getRun: vi.fn(async () => state.run), getStrategy: vi.fn(async () => state.strategy),
    getJobResult: vi.fn((id: string) => id === 'missing' ? undefined : results),
  };
  const query = { from: () => query, where: vi.fn(async () => state.strategy ? [state.strategy] : []) };
  const compilePine = vi.fn(() => ({ ast: [] }));
  const parity = { match: true, compiledPath: 'EXAMPLE', speedup: 1, diffs: [] };
  const runPineParityTest = vi.fn(() => parity);
  const fetchOHLCV = vi.fn(async () => Array.from({ length: 50 }, () => ({ close: 100 })));
  const clearCandleCache = vi.fn(async () => 12);
  const getCacheStats = vi.fn(async () => ({ totalCandles: 12, symbols: 1, estimatedSizeMb: 0.01 }));
  execute(`${auth}\n${jobOwner}\n${cacheAdmin}\n${registration(text, method, path)}`, {
    app: { [method]: (_path: string, ...registered: any[]) => { handlers = registered; } },
    labStorage, db: { select: () => query }, eq: vi.fn(), createHash, timingSafeEqual,
    compilePine, runPineParityTest, fetchOHLCV, clearCandleCache, getCacheStats,
    LAB_ALL_KNOWN_CANDLE_POLICY: 'EXAMPLE',
    require: (id: string) => id === '@shared/schema' ? { labStrategies: { id: 'id' } } : { compilePine, runPineParityTest },
  });
  const request = async (wallet = 'wallet-owner', id = 'job', headers = {} as Record<string, string>, session = true) => {
    const req = Object.assign(new EventEmitter(), {
      params: { id }, body: { strategyId: 8 }, headers,
      session: session ? { walletAddress: wallet } : undefined,
    });
    try { return await dispatch(handlers, req); }
    finally { req.emit('close'); }
  };
  function ownerPath(kind: typeof owners[number]) {
    if (kind !== 'recorded-wallet') state.job.walletAddress = undefined;
    if (kind === 'run-strategy') state.run.userId = null;
    if (kind === 'job-strategy') state.job.runId = undefined;
  }
  return { state, results, parity, request, ownerPath, labStorage, compilePine, runPineParityTest, fetchOHLCV, clearCandleCache,
    handler: handlers[handlers.length - 1] };
}
beforeEach(() => { vi.stubEnv('LAB_AUTH_SECRET', ''); vi.stubEnv('ADMIN_PASSWORD', 'EXAMPLE'); vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('SEC02-ROUND2 async ownership', () => {
  it('contains rejected run and strategy lookups on all three routes before any output or process rejection', async () => {
    const processFailure = vi.fn();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.on('unhandledRejection', processFailure);
    try {
      for (const path of paths) for (const lookup of ['getRun', 'getStrategy'] as const) {
        const h = harness('get', path);
        h.ownerPath(lookup === 'getRun' ? 'run-owner' : 'run-strategy');
        const failure = new Error('EXAMPLE database unavailable');
        h.labStorage[lookup].mockRejectedValueOnce(failure);
        const req = Object.assign(new EventEmitter(), { params: { id: 'job' }, walletAddress: 'wallet-owner' });
        const res = response();
        // Express 4 does not consume rejected handler promises. Resolution proves
        // the route contained the failure instead of forwarding it to the process.
        await expect(h.handler(req, res)).resolves.toBe(res);
        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ error: path.endsWith('/progress') ? 'Job not found' : 'Results not found' });
        expect(logged).toHaveBeenLastCalledWith(expect.stringContaining('ownership lookup failed'), failure);
        expect(res.writeHead).not.toHaveBeenCalled(); expect(res.flushHeaders).not.toHaveBeenCalled();
        expect(res.setHeader).not.toHaveBeenCalled(); expect(res.write).not.toHaveBeenCalled();
        expect(h.labStorage.getJobResult).not.toHaveBeenCalled();
        expect(h.state.job.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
        req.emit('close');
      }
      expect(processFailure).not.toHaveBeenCalled();
    } finally { process.removeListener('unhandledRejection', processFailure); }
  });

  it('avoids listeners and intervals after a disconnect during ownership and cleans stopped heartbeats', async () => {
    for (const mode of ['close', 'request-destroyed', 'response-destroyed', 'response-ended']) {
      const h = harness('get', paths[0]); h.ownerPath('run-owner');
      let resolveRun!: (run: any) => void;
      h.labStorage.getRun.mockImplementationOnce(() => new Promise(resolve => { resolveRun = resolve; }));
      const req = Object.assign(new EventEmitter(), { params: { id: 'job' }, walletAddress: 'wallet-owner', destroyed: false });
      const res = Object.assign(response(), { destroyed: false, writableEnded: false });
      const pending = h.handler(req, res);
      expect(h.labStorage.getRun).toHaveBeenCalledWith(7);
      if (mode === 'close') req.emit('close');
      if (mode === 'request-destroyed') req.destroyed = true;
      if (mode === 'response-destroyed') res.destroyed = true;
      if (mode === 'response-ended') res.writableEnded = true;
      resolveRun(h.state.run);
      await pending;
      try {
        expect(res.writeHead).not.toHaveBeenCalled(); expect(res.write).not.toHaveBeenCalled();
        expect(res.body).toBeUndefined(); expect(h.state.job.listeners.size).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      } finally { req.emit('close'); }
    }
    for (const mode of ['close', 'destroyed', 'ended']) {
      const h = harness('get', paths[0]);
      const req = Object.assign(new EventEmitter(), { params: { id: 'job' }, walletAddress: 'wallet-owner' });
      const res = Object.assign(response(), { destroyed: false, writableEnded: false });
      await h.handler(req, res);
      expect(h.state.job.listeners.size).toBe(1); expect(vi.getTimerCount()).toBe(1);
      if (mode === 'close') req.emit('close');
      else {
        if (mode === 'destroyed') res.destroyed = true;
        else res.writableEnded = true;
        vi.advanceTimersByTime(25000);
      }
      expect(res.write).toHaveBeenCalledTimes(1);
      expect(h.state.job.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
      req.emit('close');
    }
  });
});

describe('SEC02-DISCRIMINATING-JOBS Lab jobs', () => {
  for (const path of paths) for (const kind of owners) it(`${path} refuses foreign ${kind} and unknown job without side effects`, async () => {
    const h = harness('get', path); h.ownerPath(kind);
    for (const id of ['job', 'missing']) {
      const res = await h.request('wallet-other', id);
      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: path.endsWith('/progress') ? 'Job not found' : 'Results not found' });
      expect(res.writeHead).not.toHaveBeenCalled(); expect(res.write).not.toHaveBeenCalled();
    }
    expect(h.state.job.listeners.size).toBe(0);
    expect(h.labStorage.getJobResult).not.toHaveBeenCalled();
  });
  for (const path of paths) it(`${path} denies unresolved strategy owners and missing strategies`, async () => {
    for (const kind of ['run-strategy', 'job-strategy'] as const) for (const missing of [false, true]) {
      const h = harness('get', path); h.ownerPath(kind);
      h.state.strategy = missing ? undefined : { ...h.state.strategy, userId: null };
      expect((await h.request()).statusCode).toBe(404);
      expect(h.labStorage.getJobResult).not.toHaveBeenCalled(); expect(h.state.job.listeners.size).toBe(0);
    }
  });
  for (const path of paths) it(`${path} honours recorded and run owners before strategy fallbacks`, async () => {
    const recorded = harness('get', path);
    recorded.state.job.walletAddress = 'wallet-other';
    expect((await recorded.request()).statusCode).toBe(404);
    expect(recorded.labStorage.getRun).not.toHaveBeenCalled();
    const run = harness('get', path); run.ownerPath('run-owner'); run.state.run.userId = 'wallet-other';
    expect((await run.request()).statusCode).toBe(404);
    expect(run.labStorage.getStrategy).not.toHaveBeenCalled();
    const fallback = harness('get', path); fallback.ownerPath('run-strategy');
    await fallback.request();
    expect(fallback.labStorage.getStrategy).toHaveBeenCalledWith(8);
    const noRun = harness('get', path); noRun.ownerPath('job-strategy');
    await noRun.request();
    expect(noRun.labStorage.getStrategy).toHaveBeenCalledWith(9);
  });
});
describe('SEC02-PRESERVATION Lab jobs', () => {
  for (const path of paths) for (const kind of owners) it(`${path} retains owner output via ${kind}`, async () => {
    const h = harness('get', path); h.ownerPath(kind);
    const res = await h.request(); expect(res.statusCode).toBe(200);
    if (path.endsWith('/progress')) {
      expect(res.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'Content-Type': 'text/event-stream' }));
      expect(res.write).toHaveBeenCalledExactlyOnceWith('data: {"status":"complete"}\n\n');
    } else if (path.endsWith('/results')) expect(res.body).toEqual(h.results);
    else expect(res.body).toBe('Rank,Ticker,Timeframe,Net Profit %,Win Rate %,Max Drawdown %,Profit Factor,Total Trades,Parameters\n1,BTC,1h,,,,,3,{}');
  });
});
describe('SEC02-DISCRIMINATING-TOOLS Lab cache', () => {
  for (const mode of ['disabled', 'bad-token', 'lab-user']) it(`refuses ${mode} without deleting`, async () => {
    // Model an authenticated Lab proxy request even when an admin Bearer is bad.
    vi.stubEnv('LAB_AUTH_SECRET', 'CHANGEME');
    const h = harness('delete', '/api/lab/cache');
    if (mode === 'disabled') vi.stubEnv('ADMIN_PASSWORD', '');
    const res = await h.request('wallet-other', 'job', { 'x-lab-auth': 'CHANGEME', 'x-lab-wallet': 'wallet-other',
      ...(mode === 'bad-token' ? { authorization: 'Bearer REDACTED' } : {}) });
    expect(res.statusCode).toBe(mode === 'disabled' ? 503 : 401);
    expect(res.body).toEqual({ error: mode === 'disabled' ? 'Admin endpoints disabled - ADMIN_PASSWORD not configured' : 'Unauthorized' });
    expect(h.clearCandleCache).not.toHaveBeenCalled();
  });
  // This is new authorized behavior: the base incorrectly requires Lab identity.
  it('accepts admin Bearer without a Lab session', async () => {
    vi.stubEnv('LAB_AUTH_SECRET', 'REDACTED');
    const h = harness('delete', '/api/lab/cache');
    const res = await h.request('', 'job', { authorization: 'Bearer   EXAMPLE  ' }, false);
    expect(res.statusCode).toBe(200); expect(res.body).toEqual({ success: true, deletedRows: 12 });
    expect(h.clearCandleCache).toHaveBeenCalledOnce();
  });
});
describe('SEC02-PRESERVATION shared candle statistics', () => {
  it('retains authenticated aggregate-only stats', async () => {
    const res = await harness('get', '/api/lab/cache/stats').request();
    expect(res.body).toEqual({ totalCandles: 12, symbols: 1, estimatedSizeMb: 0.01 });
  });
});
describe('SEC02-DISCRIMINATING-TOOLS compilers', () => {
  for (const [method, path] of [['get', '/api/lab/debug-compiler/:id'], ['post', '/api/lab/compiler/parity-test']]) {
    it(`${path} refuses foreign and unknown strategies before compile or candles`, async () => {
      for (const strategy of [{ userId: 'wallet-other', pineScript: 'EXAMPLE' }, undefined, { userId: null, pineScript: 'EXAMPLE' }]) {
        const h = harness(method, path); h.state.strategy = strategy;
        const res = await h.request(); expect(res.statusCode).toBe(404); expect(res.body).toEqual({ error: 'Strategy not found' });
        expect(h.compilePine).not.toHaveBeenCalled(); expect(h.fetchOHLCV).not.toHaveBeenCalled(); expect(h.runPineParityTest).not.toHaveBeenCalled();
      }
    });
  }
});
describe('SEC02-PRESERVATION compilers', () => {
  for (const [method, path] of [['get', '/api/lab/debug-compiler/:id'], ['post', '/api/lab/compiler/parity-test']]) {
    it(`${path} retains owner compilation`, async () => {
      const h = harness(method, path); const res = await h.request();
      expect(res.statusCode).toBe(200); expect(res.body).toMatchObject(h.parity); expect(h.compilePine).toHaveBeenCalledWith('EXAMPLE');
      expect(h.runPineParityTest).toHaveBeenCalledOnce();
    });
  }
});
describe('SEC02-PRESERVATION Lab identity regression', () => {
  it('replaces forged browser headers with the session wallet and server secret', async () => {
    const index = source('server/index.ts');
    const proxy = section(index, '    proxyReq: (proxyReq, _req) => {', '    error:');
    const forwarded = new Map([['x-lab-auth', 'CHANGEME'], ['x-lab-wallet', 'wallet-other']]);
    const proxyReq = { removeHeader: (name: string) => forwarded.delete(name), setHeader: (name: string, value: string) => forwarded.set(name, value) };
    execute(`const hooks = { ${proxy} }; hooks.proxyReq(proxyReq, req);`, {
      proxyReq, req: { session: { walletAddress: 'wallet-owner' } }, getLabAuthSecret: () => 'REDACTED',
    });
    expect(Object.fromEntries(forwarded)).toEqual({ 'x-lab-wallet': 'wallet-owner', 'x-lab-auth': 'REDACTED' });
    vi.stubEnv('LAB_AUTH_SECRET', 'REDACTED');
    expect((await harness('get', '/api/lab/job/:id/results').request('', 'job', Object.fromEntries(forwarded), false)).statusCode).toBe(200);
  });
  it('refuses header-only child requests without the server secret', async () => {
    vi.stubEnv('LAB_AUTH_SECRET', 'REDACTED');
    const h = harness('get', '/api/lab/job/:id/results');
    const res = await h.request('', 'job', { 'x-lab-wallet': 'wallet-owner' }, false);
    expect(res.statusCode).toBe(403); expect(res.body).toEqual({ error: 'Forbidden' }); expect(h.labStorage.getJob).not.toHaveBeenCalled();
  });
});

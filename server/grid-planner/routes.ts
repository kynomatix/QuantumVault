import type { Express, Request, Response, RequestHandler } from 'express';
import type { ProtocolMarket } from '../protocol/protocol-types';
import type { PlannerDeps, PlannerQuery } from './types';
import { PlannerCharts } from './chart';
import { PlannerDirection } from './direction';
import { PlannerWeeklyStructure } from './weekly-structure';
import { PlannerRangeFacts } from './range-facts';
import { marketSnapshot } from './market-snapshot';
import { previewGrid, validatePreviewQuery } from './preview';
import { gridHistoryRequest } from '../../shared/grid-lookback';
import { RangingMarketFinder } from './scanner';
import type { GridFinderTimeframe } from '../../shared/grid-finder';

export function registerGridPlannerRoutes(app: Express, requireWallet: RequestHandler,
  loadDeps: () => Promise<PlannerDeps> = async () => (await import('./default-deps')).defaultPlannerDeps,
  enabled = process.env.GRID_PLANNER_ENABLED === 'true') {
  if (!enabled) return;
  let depsPromise: Promise<PlannerDeps> | undefined, charts: PlannerCharts | undefined;
  let direction: PlannerDirection | undefined;
  let weekly: PlannerWeeklyStructure | undefined;
  let finder: RangingMarketFinder | undefined;
  const ranges = new PlannerRangeFacts();
  let metadata: { rows: ProtocolMarket[]; observedAt: number } | undefined;
  let metadataJob: Promise<ProtocolMarket[]> | undefined, lastFailure = -Infinity;
  let previewStarts: number[] = [];
  let activeRequests = 0;
  // Forget a failed load so a transient import error does not disable the Planner until restart.
  const dependencies = () => depsPromise ??= loadDeps().catch(error => { depsPromise = undefined; throw error; });
  const membership = (deps: PlannerDeps): Promise<ProtocolMarket[]> => {
    const now = deps.now();
    // The adapter may have observed these rows before the Planner first received them.
    if (metadata && now >= metadata.observedAt && now - metadata.observedAt < 300_000
      && metadata.rows.every(row => !row.constraintObservation || now < row.constraintObservation.expiresAt)) return Promise.resolve(metadata.rows);
    if (metadataJob) return metadataJob;
    if (now - lastFailure < 300_000) return Promise.reject(new Error('Market metadata unavailable; refresh later'));
    metadataJob = Promise.resolve().then(() => deps.getMarkets()).then(rows => {
      lastFailure = -Infinity;
      metadata = { rows, observedAt: deps.now() }; return metadata.rows;
    }).catch(() => { metadata = undefined; lastFailure = deps.now(); throw new Error('Pacifica market metadata unavailable'); })
      .finally(() => { metadataJob = undefined; });
    return metadataJob;
  };
  const boundedMetadata = async (deps: PlannerDeps) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([membership(deps), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Market metadata deadline exceeded')), 15_000);
    })]); } finally { clearTimeout(timer); }
  };
  const route = (keys: string[], handler: (req: Request, res: Response, deps: PlannerDeps) => Promise<void>) =>
    async (req: Request, res: Response) => {
      res.set('Cache-Control', 'no-store');
      if (Object.keys(req.query).some(k => !keys.includes(k)) || Object.values(req.query).some(v => typeof v !== 'string' || v.length > 80)) {
        res.status(400).json({ state: 'unavailable', reason: 'Invalid query fields' }); return;
      }
      // Bound callers before metadata work, including requests sharing one upstream job.
      if (activeRequests >= 10) { res.status(503).json({ state: 'unavailable', reason: 'Planner is busy; refresh later' }); return; }
      activeRequests++;
      try { await handler(req, res, await dependencies()); }
      catch (error) { if (!res.destroyed) res.status(503).json({ state: 'unavailable', reason: error instanceof Error ? error.message : 'Planner unavailable' }); }
      finally { activeRequests--; }
    };
  app.get('/api/grid-planner/status', requireWallet, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (Object.keys(req.query).length) return res.status(400).json({ state: 'unavailable', reason: 'Status accepts no query fields' });
    res.json({ enabled: true, name: 'Grid Planner', planningOnly: true });
  });
  app.get('/api/grid-planner/markets', requireWallet, route(['market'], async (req, res, deps) => {
    const rows = await boundedMetadata(deps);
    if (req.query.market !== undefined) {
      const row = rows.find(r => r.internalSymbol === req.query.market);
      if (!row) { res.status(404).json({ state: 'unavailable', reason: 'Unknown Pacifica market' }); return; }
      if (!deps.refreshReference) throw Error('Fresh price refresh unavailable');
      const controller = new AbortController(), onClose = () => controller.abort();
      res.on('close', onClose);
      try { await deps.refreshReference(row.internalSymbol, row.protocolSymbol, controller.signal); }
      finally { res.off('close', onClose); }
    }
    if (!res.destroyed) res.json({ state: 'available', markets: rows.map(row => marketSnapshot(row, deps)), retrievedAt: deps.now() });
  }));
  app.get('/api/grid-planner/direction', requireWallet, route([], async (_req, res, deps) => {
    direction ??= new PlannerDirection(deps);
    const result = await direction.read();
    if (!res.destroyed) res.json(result);
  }));
  app.get('/api/grid-planner/finder', requireWallet, route(['timeframe', 'cursor'], async (req, res, deps) => {
    const { timeframe, cursor = '0' } = req.query;
    if (!['15m', '1h', '4h'].includes(String(timeframe)) || typeof cursor !== 'string' || !/^(0|[1-9]\d{0,5})$/.test(cursor)) {
      res.status(400).json({ state: 'unavailable', reason: 'Choose 15m, 1h or 4h and a valid finder cursor' }); return;
    }
    const controller = new AbortController(), onClose = () => controller.abort();
    res.on('close', onClose);
    try {
      const rows = await boundedMetadata(deps);
      finder ??= new RangingMarketFinder(deps);
      const result = await finder.read(rows, timeframe as GridFinderTimeframe, Number(cursor), controller.signal);
      if (!res.destroyed) res.json(result);
    } finally { res.off('close', onClose); }
  }));
  app.get('/api/grid-planner/signals', requireWallet, route(['market'], async (req, res, deps) => {
    const market = req.query.market;
    if (typeof market !== 'string' || !(await boundedMetadata(deps)).some(r => r.internalSymbol === market)) {
      res.status(400).json({ state: 'unavailable', reason: 'Choose a known Pacifica market' }); return;
    }
    weekly ??= new PlannerWeeklyStructure(deps);
    const unknown = (reason: string) => ({ state: 'unavailable' as const, reason });
    const [structure, funding] = await Promise.all([
      weekly.read(market),
      deps.fundingSignal ? deps.fundingSignal(market).catch(() => unknown('Pacifica funding unavailable.'))
        : Promise.resolve(unknown('Pacifica funding reader unavailable.')),
    ]);
    if (!res.destroyed) res.json({ market, serverNow: deps.now(), weekly: structure, funding });
  }));
  app.get('/api/grid-planner/range', requireWallet, route(['market', 'timeframe', 'bars', 'period'], async (req, res, deps) => {
    const { market, timeframe, bars, period } = req.query, window = gridHistoryRequest(timeframe, period, bars);
    if (typeof market !== 'string' || !window) {
      res.status(400).json({ state: 'unavailable', reason: 'Choose market, 15m/1h/4h and last day/week/month' }); return;
    }
    const row = (await boundedMetadata(deps)).find(r => r.internalSymbol === market);
    if (!row) { res.status(404).json({ state: 'unavailable', reason: 'Unknown Pacifica market' }); return; }
    const controller = new AbortController(), onClose = () => controller.abort();
    const timer = setTimeout(onClose, window.chartBars > 200 ? 30_000 : 15_000); res.on('close', onClose);
    try {
      charts ??= new PlannerCharts(deps);
      const chart = await charts.read(market, String(timeframe), window.chartBars, controller.signal);
      const result = await ranges.read(row, String(timeframe) as '15m' | '1h' | '4h', window.rangeBars, deps, controller.signal, chart, window.period);
      if (!res.destroyed) res.json(result);
    } finally { clearTimeout(timer); res.off('close', onClose); }
  }));
  app.get('/api/grid-planner/chart', requireWallet, route(['market', 'timeframe', 'bars', 'period'], async (req, res, deps) => {
    const { market, timeframe, bars, period } = req.query, window = gridHistoryRequest(timeframe, period, bars);
    if (typeof market !== 'string' || !window) {
      res.status(400).json({ state: 'unavailable', reason: 'Choose market, 15m/1h/4h and last day/week/month' }); return;
    }
    const row = (await boundedMetadata(deps)).find(r => r.internalSymbol === market);
    if (!row) { res.status(404).json({ state: 'unavailable', reason: 'Unknown Pacifica market' }); return; }
    const controller = new AbortController(), onClose = () => controller.abort();
    res.on('close', onClose);
    try {
      charts ??= new PlannerCharts(deps);
      const result = await charts.read(market, String(timeframe), window.chartBars, controller.signal);
      if (!res.destroyed) res.status(result.state === 'available' ? 200 : 503).json(result);
    } finally { res.off('close', onClose); }
  }));
  app.get('/api/grid-planner/preview', requireWallet, route(['market', 'side', 'lower', 'upper', 'intervals', 'entryScale', 'profitScale', 'seed', 'leverage', 'investment', 'stop', 'fee'], async (req, res, deps) => {
    const raw = req.query;
    const geometryOnly = raw.investment === undefined || raw.investment === '';
    if (((!geometryOnly || raw.seed !== undefined) && !['true', 'false'].includes(String(raw.seed))) || !/^(?:[1-9]\d?|100)$/.test(String(raw.intervals)) || typeof raw.market !== 'string') {
      res.status(400).json({ state: 'unavailable', reason: 'Invalid market, seed or interval count' }); return;
    }
    const q = { ...raw, investment: raw.investment ?? '', intervals: Number(raw.intervals), seed: raw.seed === 'true', fee: raw.fee === undefined || raw.fee === '' ? null : raw.fee } as unknown as PlannerQuery;
    const invalid = validatePreviewQuery(q);
    if (invalid) { res.status(400).json({ state: 'unavailable', reason: invalid }); return; }
    const now = deps.now(); previewStarts = previewStarts.filter(time => now - time < 60_000);
    if (previewStarts.length >= 30) { res.status(503).json({ state: 'unavailable', reason: 'Preview is busy; refresh later' }); return; }
    previewStarts.push(now);
    const row = (await boundedMetadata(deps)).find(r => r.internalSymbol === q.market);
    if (!row) { res.status(404).json({ state: 'unavailable', reason: 'Unknown Pacifica market' }); return; }
    // Freshness is checked again after all asynchronous work, directly before serialization.
    res.json(previewGrid(q, marketSnapshot(row, deps), deps.now()));
  }));
}

import { createHash } from 'crypto';
import type { LabStrategy, LabOptimizationRun, LabOptResult } from '../../shared/schema';
import { labMarket, type LabDeploySnapshot } from '../../shared/lab-provenance';

export function canonicalLabJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLabJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${canonicalLabJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function snapshotDigest(snapshot: Omit<LabDeploySnapshot, 'snapshotSha256'>): string {
  return createHash('sha256').update(canonicalLabJson(snapshot)).digest('hex');
}

const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function captureLabSnapshot(bot: { id: string; walletAddress: string; market: string }, strategy: LabStrategy,
  run: LabOptimizationRun, result: LabOptResult): LabDeploySnapshot {
  if (run.strategyId !== strategy.id || result.runId !== run.id || strategy.userId !== bot.walletAddress
    || run.userId !== bot.walletAddress || run.status !== 'complete') throw new Error('LAB_SOURCE_NOT_OWNED_OR_COMPLETE');
  if (labMarket(result.ticker) !== labMarket(bot.market)) throw new Error('LAB_DEPLOYMENT_MISMATCH');
  const raw = object(run.configSnapshot) ? run.configSnapshot : {};
  const config = object(raw.config) ? raw.config : raw;
  const snapshot: Omit<LabDeploySnapshot, 'snapshotSha256'> = {
    version: 1, botId: bot.id, ownerWallet: bot.walletAddress,
    strategyId: strategy.id, runId: run.id, resultId: result.id, strategyName: strategy.name,
    capturedAt: new Date().toISOString(), market: labMarket(result.ticker), ticker: result.ticker,
    timeframe: result.timeframe, params: result.params as Record<string, unknown>,
    engine: config.pineScript ? 'pine' : typeof config.engineType === 'string' ? config.engineType : 'flux',
    engineVersion: 'historical version unknown', scriptVersion: 'historical version unknown',
    pineScript: typeof config.pineScript === 'string' ? config.pineScript : strategy.pineScript,
    config, metrics: { netProfitPercent: finite(result.netProfitPercent), winRatePercent: finite(result.winRatePercent),
      maxDrawdownPercent: finite(result.maxDrawdownPercent), profitFactor: finite(result.profitFactor),
      totalTrades: result.totalTrades, sharpeRatio: finite(result.sharpeRatio) },
    window: { start: run.startDate, end: run.endDate },
    tradesRecorded: Array.isArray(result.trades),
    trades: Array.isArray(result.trades) ? result.trades : [],
  };
  // JSONB and the digest must have identical representations (including non-finite metrics).
  const clean = JSON.parse(JSON.stringify(snapshot));
  const sealed = { ...clean, snapshotSha256: snapshotDigest(clean) };
  if (!validLabSnapshot(sealed)) throw new Error('LAB_SNAPSHOT_INVALID');
  return sealed;
}

export function validLabSnapshot(value: unknown): value is LabDeploySnapshot {
  if (!object(value)) return false;
  const s = value;
  if (s.version !== 1 || !['botId', 'ownerWallet', 'strategyName', 'ticker', 'market', 'timeframe', 'engine', 'engineVersion']
    .every(k => typeof s[k] === 'string' && (s[k] as string).length > 0)
    || !['strategyId', 'runId', 'resultId'].every(k => Number.isSafeInteger(s[k]) && Number(s[k]) > 0)
    || !object(s.params) || !object(s.config) || !object(s.metrics) || !object(s.window) || !Array.isArray(s.trades)
    || !Number.isFinite(Date.parse(String(s.capturedAt))) || !Number.isFinite(Date.parse(String(s.window.start)))
    || !Number.isFinite(Date.parse(String(s.window.end))) || Date.parse(String(s.window.start)) >= Date.parse(String(s.window.end))
    || typeof s.tradesRecorded !== 'boolean' || typeof s.pineScript !== 'string' || !/^[1-9]\d*[mhdw]$/.test(String(s.timeframe))
    || s.scriptVersion !== 'historical version unknown' || typeof s.snapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.snapshotSha256)) return false;
  const metrics = s.metrics as Record<string, unknown>;
  if (!['netProfitPercent', 'winRatePercent', 'maxDrawdownPercent', 'profitFactor', 'sharpeRatio']
    .every(k => metrics[k] === null || finite(metrics[k]) !== null)
    || !Number.isSafeInteger(metrics.totalTrades) || Number(metrics.totalTrades) < 0) return false;
  if (s.trades.length > 20_000 || !s.trades.every(t => object(t)
    && ['long', 'short'].includes(String(t.direction))
    && Number.isFinite(Date.parse(String(t.entryTime))) && Number.isFinite(Date.parse(String(t.exitTime)))
    && ['entryPrice', 'exitPrice', 'pnlDollar', 'pnlPercent', 'barsHeld'].every(k => finite(t[k]) !== null))) return false;
  if (labMarket(String(s.ticker)) !== s.market) return false;
  const { snapshotSha256, ...body } = s;
  try { return snapshotSha256 === snapshotDigest(body as unknown as Omit<LabDeploySnapshot, 'snapshotSha256'>); }
  catch { return false; }
}

import { randomUUID } from 'crypto';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import { tradingBots, labStrategies, labOptimizationRuns, labOptimizationResults, webhookLogs, botTrades,
  type InsertTradingBot, type TradingBot } from '../../shared/schema';
import { labMarket, type LabDeploySnapshot } from '../../shared/lab-provenance';
import { captureLabSnapshot, snapshotDigest, validLabSnapshot } from './provenance-snapshot';
import { compareLabSignals, liveTradeSummary, webhookSignals, type SignalComparison } from './provenance-analysis';
import { rerunLabWindow } from './provenance-rerun';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const LAB_MATCH_LIMITS = { candidates: 12, budgetMs: 12_000, cacheMs: 300_000, signals: 1000, days: 14 } as const;
const cache = new Map<string, { expires: number; market: string; matches: Match[]; note: string }>();
const pending = new Map<string, Promise<ReturnType<typeof publicMatches>>>();
let active = 0;
interface Match { snapshot: LabDeploySnapshot; comparison: ReturnType<typeof compareLabSignals>; basis: string }
function publicMatches(entry: { matches: Match[]; note: string }) {
  return { candidates: entry.matches.map(m => ({ resultId: m.snapshot.resultId, strategyName: m.snapshot.strategyName,
    timeframe: m.snapshot.timeframe, ...m.comparison, basis: m.basis })), note: entry.note, limits: LAB_MATCH_LIMITS };
}

export function labSelection(input: Record<string, unknown>): number | undefined {
  const forbidden = ['labStrategyId', 'labRunId', 'labDeploySnapshot', 'labLinkState', 'labLinkedAt',
    'lab_strategy_id', 'lab_run_id', 'lab_result_id', 'lab_deploy_snapshot', 'lab_link_state', 'lab_linked_at'];
  if (forbidden.some(k => Object.prototype.hasOwnProperty.call(input, k))) throw new Error('LAB_CLIENT_EVIDENCE_REJECTED');
  if (input.labResultId === undefined) return undefined;
  if (!Number.isSafeInteger(input.labResultId) || Number(input.labResultId) < 1) throw new Error('LAB_RESULT_REQUIRED');
  return Number(input.labResultId);
}

async function source(tx: Tx, resultId: number, bot: { id: string; walletAddress: string; market: string }) {
  // Lock each member: deletion, result replacement and owner changes cannot race capture.
  const [result] = await tx.select().from(labOptimizationResults).where(eq(labOptimizationResults.id, resultId)).for('share');
  if (!result) throw new Error('LAB_RESULT_NOT_FOUND');
  const [run] = await tx.select().from(labOptimizationRuns).where(eq(labOptimizationRuns.id, result.runId)).for('share');
  if (!run) throw new Error('LAB_SOURCE_NOT_FOUND');
  const [strategy] = await tx.select().from(labStrategies).where(eq(labStrategies.id, run.strategyId)).for('share');
  if (!strategy) throw new Error('LAB_SOURCE_NOT_FOUND');
  return captureLabSnapshot(bot, strategy, run, result);
}
async function bounded<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async tx => { await tx.execute(sql`SET LOCAL statement_timeout = '4000ms'`); return fn(tx); });
}
export async function validateLabSelection(owner: string, market: string, resultId: number) {
  await bounded(tx => source(tx, resultId, { id: 'selection', walletAddress: owner, market }));
}
export async function createLabLinkedBot(input: InsertTradingBot, resultId: number): Promise<TradingBot> {
  if ((input.botType ?? 'signal') !== 'signal') throw new Error('LAB_SIGNAL_BOT_REQUIRED');
  return bounded(async tx => {
    const bot = { ...input, id: randomUUID() };
    const snapshot = await source(tx, resultId, bot);
    const [created] = await tx.insert(tradingBots).values({ ...bot, labStrategyId: snapshot.strategyId,
      labRunId: snapshot.runId, labResultId: snapshot.resultId, labDeploySnapshot: snapshot,
      labLinkState: 'linked', labLinkedAt: new Date() } as any).returning();
    return created;
  });
}
async function owned(owner: string, id: string): Promise<TradingBot> {
  const [bot] = await db.select().from(tradingBots).where(and(eq(tradingBots.id, id), eq(tradingBots.walletAddress, owner))).limit(1);
  if (!bot || bot.botType !== 'signal') throw new Error('LAB_SIGNAL_BOT_NOT_FOUND');
  return bot;
}
export async function labSourceDetail(owner: string, id: string) {
  const bot = await owned(owner, id);
  const snapshot = bot.labDeploySnapshot;
  return { state: bot.labLinkState, linkedAt: bot.labLinkedAt, snapshot,
    valid: validLabSnapshot(snapshot), sourceDeleted: !!snapshot && (!bot.labStrategyId || !bot.labRunId || !bot.labResultId) };
}
async function signalsFor(id: string, start: number, end: number) {
  const rows = await bounded(tx => tx.select({ payload: webhookLogs.payload, receivedAt: webhookLogs.receivedAt })
    .from(webhookLogs).where(and(eq(webhookLogs.tradingBotId, id), gte(webhookLogs.receivedAt, new Date(start)),
      lte(webhookLogs.receivedAt, new Date(end)))).orderBy(desc(webhookLogs.receivedAt)).limit(LAB_MATCH_LIMITS.signals));
  return webhookSignals(rows).filter(s => s.time >= start && s.time <= end);
}
export async function findLabSources(owner: string, id: string) {
  const bot = await owned(owner, id), key = `${owner}:${id}`;
  if (bot.labLinkState !== 'unlinked' || bot.labDeploySnapshot) throw new Error('LAB_ALREADY_LINKED');
  const cached = cache.get(key);
  if (cached && cached.market === bot.market && cached.expires > Date.now()) return publicMatches(cached);
  const running = pending.get(key); if (running) return running;
  if (active >= 2) throw new Error('LAB_MATCH_BUSY');
  const job = (async () => {
    active++;
    try {
      const deadline = Date.now() + LAB_MATCH_LIMITS.budgetMs, end = Date.now();
      const start = Math.max(new Date(bot.createdAt).getTime(), end - LAB_MATCH_LIMITS.days * 86_400_000);
      const signals = await signalsFor(id, start, end);
      const matches: Match[] = [];
      let unavailable = 0;
      if (signals.length) {
        const inferred = /(?:^|[\s_(\-])(\d+[mhdw])(?:$|[\s_)\-])/i.exec(bot.name)?.[1].toLowerCase();
        const candidates = await bounded(tx => tx.select({ result: labOptimizationResults, run: labOptimizationRuns, strategy: labStrategies })
          .from(labOptimizationResults).innerJoin(labOptimizationRuns, eq(labOptimizationResults.runId, labOptimizationRuns.id))
          .innerJoin(labStrategies, eq(labOptimizationRuns.strategyId, labStrategies.id))
          .where(and(eq(labStrategies.userId, owner), eq(labOptimizationRuns.userId, owner), eq(labOptimizationRuns.status, 'complete'),
            sql`regexp_replace(upper(${labOptimizationResults.ticker}), '(/USDT|/USD|USDT|[-/]PERP|[-/]USD)$', '') = ${labMarket(bot.market)}`,
            inferred ? eq(labOptimizationResults.timeframe, inferred) : undefined))
          .orderBy(desc(labOptimizationResults.id)).limit(LAB_MATCH_LIMITS.candidates));
        for (const c of candidates) {
          if (Date.now() >= deadline) { unavailable++; break; }
          try {
            const snapshot = captureLabSnapshot(bot, c.strategy, c.run, c.result);
            const overlapStart = Math.max(start, Date.parse(snapshot.window.start)), overlapEnd = Math.min(end, Date.parse(snapshot.window.end));
            const overlap = overlapStart < overlapEnd && signals.some(s => s.time >= overlapStart && s.time <= overlapEnd);
            const from = overlap ? overlapStart : Math.max(start, signals[0].time), to = overlap ? overlapEnd : end;
            const stored = overlap && snapshot.tradesRecorded;
            const trades = stored ? snapshot.trades : await rerunLabWindow(snapshot, from, to, deadline);
            const comparison = compareLabSignals(signals, trades, snapshot.timeframe, from, to);
            if (comparison.matched > 0) matches.push({ snapshot, comparison, basis: stored ? 'Stored backtest trades' : 'Current-engine re-run over live window; historical script/version unknown' });
          } catch { unavailable++; }
        }
      }
      matches.sort((a, b) => (b.comparison.percent ?? 0) - (a.comparison.percent ?? 0) || b.comparison.signals - a.comparison.signals);
      const entry = { expires: Date.now() + LAB_MATCH_LIMITS.cacheMs, market: bot.market, matches: matches.slice(0, 5),
        note: !signals.length ? 'No usable webhook signals in the last 14 days.' : `Compared up to 1,000 recent signals. ${unavailable} candidates unavailable or outside the work budget. Timing similarity does not prove the TradingView settings; confirm only a source you recognize.` };
      if (cache.size >= 100) cache.delete(cache.keys().next().value!);
      cache.set(key, entry);
      return publicMatches(entry);
    } finally { active--; pending.delete(key); }
  })();
  pending.set(key, job);
  return job;
}
export async function confirmLabSource(owner: string, id: string, resultId: number) {
  const key = `${owner}:${id}`, entry = cache.get(key);
  const candidate = entry?.matches.find(m => m.snapshot.resultId === resultId);
  if (!candidate || !entry || entry.expires <= Date.now()) throw new Error('LAB_FIND_SOURCE_AGAIN');
  const linked = await bounded(async tx => {
    const [bot] = await tx.select().from(tradingBots).where(and(eq(tradingBots.id, id), eq(tradingBots.walletAddress, owner))).for('update');
    if (!bot || bot.botType !== 'signal') throw new Error('LAB_SIGNAL_BOT_NOT_FOUND');
    if (bot.labDeploySnapshot || bot.labLinkState !== 'unlinked') throw new Error('LAB_ALREADY_LINKED');
    const snapshot = await source(tx, resultId, bot);
    const { snapshotSha256: _digest, ...body } = snapshot;
    if (snapshotDigest({ ...body, capturedAt: candidate.snapshot.capturedAt }) !== candidate.snapshot.snapshotSha256) throw new Error('LAB_SOURCE_CHANGED_FIND_AGAIN');
    const [updated] = await tx.update(tradingBots).set({ labStrategyId: snapshot.strategyId, labRunId: snapshot.runId,
      labResultId: snapshot.resultId, labDeploySnapshot: snapshot, labLinkState: 'owner_confirmed', labLinkedAt: new Date() })
      .where(eq(tradingBots.id, id)).returning();
    return updated;
  });
  cache.delete(key);
  return { state: linked.labLinkState };
}
export async function triageLabBot(owner: string, id: string) {
  const bot = await owned(owner, id), snapshot = bot.labDeploySnapshot;
  if (!['linked', 'owner_confirmed'].includes(bot.labLinkState ?? '')) throw new Error('LAB_UNLINKED');
  if (!validLabSnapshot(snapshot)) throw new Error('LAB_SNAPSHOT_INVALID');
  if (snapshot.botId !== id || snapshot.ownerWallet !== owner || snapshot.market !== labMarket(bot.market)) throw new Error('LAB_DEPLOYMENT_MISMATCH');
  const end = Date.now(), start = Math.max(new Date(bot.createdAt).getTime(), end - LAB_MATCH_LIMITS.days * 86_400_000);
  const signals = await signalsFor(id, start, end);
  const rows = await bounded(tx => tx.select().from(botTrades).where(and(eq(botTrades.tradingBotId, id),
    gte(botTrades.executedAt, new Date(start)), lte(botTrades.executedAt, new Date(end))))
    .orderBy(desc(botTrades.executedAt)).limit(1000));
  const from = Math.max(start, Date.parse(snapshot.window.start)), to = Math.min(end, Date.parse(snapshot.window.end));
  const stored = snapshot.tradesRecorded && from < to && signals.some(s => s.time >= from && s.time <= to);
  let entries: SignalComparison | null = null;
  let comparisonTrades = snapshot.trades, basis = 'Stored backtest trades';
  try {
    if (!stored) { comparisonTrades = await rerunLabWindow(snapshot, start, end, Date.now() + LAB_MATCH_LIMITS.budgetMs); basis = 'Current-engine re-run over live window'; }
    entries = compareLabSignals(signals, comparisonTrades, snapshot.timeframe, stored ? from : start, stored ? to : end);
  } catch { basis = 'Entry comparison unavailable within the bounded re-run budget'; }
  const comparisonStart = stored ? from : start, comparisonEnd = stored ? to : end;
  const windowTrades = comparisonTrades.filter(t => Date.parse(t.exitTime) >= comparisonStart && Date.parse(t.exitTime) <= comparisonEnd);
  const comparableRows = rows.filter(t => new Date(t.executedAt).getTime() >= comparisonStart && new Date(t.executedAt).getTime() <= comparisonEnd);
  return { asOf: new Date(end).toISOString(), range: { start: new Date(comparisonStart).toISOString(), end: new Date(comparisonEnd).toISOString() },
    entries, basis, live: liveTradeSummary(comparableRows), backtest: { headline: snapshot.metrics, comparableTrades: entries ? windowTrades.length : null,
      winRatePercent: entries && windowTrades.length ? windowTrades.filter(t => t.pnlDollar > 0).length / windowTrades.length * 100 : null,
      pnlDollar: entries && windowTrades.length ? windowTrades.reduce((n, t) => n + t.pnlDollar, 0) : null,
      fees: typeof snapshot.config.commission === 'number' ? `${snapshot.config.commission} per-side fraction` : 'Not recorded; current Lab engine uses 0.0005 per side' },
    explanation: 'Read-only comparison of up to 1,000 recent webhook signals and trade records over 14 days. Entry matching includes buy/sell timing, with one expected order per signal. Positive slippage means a worse fill than the signal price. PnL and win rate use recorded close-PnL rows, which may include partial closes; backtest PnL uses its original capital, so dollar values are not size-normalized. Unknown fees and paper/unknown-protocol records are excluded. Funding is unknown. Historical engine/script versions were not recorded; a re-run is a counterfactual, not proof of the alert configuration.' };
}

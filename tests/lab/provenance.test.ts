import { describe, expect, it } from 'vitest';
import { captureLabSnapshot, snapshotDigest, validLabSnapshot } from '../../server/lab/provenance-snapshot';
import { compareLabSignals, liveTradeSummary, webhookSignals } from '../../server/lab/provenance-analysis';
import { phoenixLabProvenanceSatisfied } from '../../server/protocol/phoenix/lab-provenance';
import { labRows, labTrade } from '../helpers/lab-provenance';

function snapshot() { const r = labRows(); return captureLabSnapshot(r.bot, r.strategy, r.run, r.result); }
describe('server-captured Lab evidence and Phoenix provenance', () => {
  it('seals a detached snapshot, preserves unknown history, and verifies JSONB key order', () => {
    const r = labRows(), saved = captureLabSnapshot(r.bot, r.strategy, r.run, r.result);
    (r.result.params as Record<string, unknown>).length = 99; (r.result.trades as typeof labTrade[])[0].entryPrice = 99;
    expect(saved.params.length).toBe(14); expect(saved.trades[0].entryPrice).toBe(100);
    expect(saved.engineVersion).toBe('historical version unknown');
    const reordered = Object.fromEntries(Object.entries(saved).reverse());
    expect(validLabSnapshot(JSON.parse(JSON.stringify(reordered)))).toBe(true);
    expect(validLabSnapshot({ ...saved, params: { length: 15 } })).toBe(false);
    const { snapshotSha256, ...body } = saved;
    expect(snapshotDigest(body)).toBe(snapshotSha256);
  });
  it.each(['strategy-owner', 'run-owner', 'strategy-chain', 'run-chain', 'incomplete', 'market'])('rejects invalid %s before capture', fault => {
    const r = labRows();
    if (fault === 'strategy-owner') r.strategy.userId = 'REDACTED';
    if (fault === 'run-owner') r.run.userId = 'REDACTED';
    if (fault === 'strategy-chain') r.run.strategyId = 99;
    if (fault === 'run-chain') r.result.runId = 99;
    if (fault === 'incomplete') r.run.status = 'running';
    if (fault === 'market') r.result.ticker = 'BTCUSDT';
    expect(() => captureLabSnapshot(r.bot, r.strategy, r.run, r.result)).toThrow(/^LAB_/);
  });
  it('represents non-finite headline metrics as unknown and rejects malformed evidence even if re-digested', () => {
    const r = labRows(); r.result.profitFactor = Infinity;
    expect(captureLabSnapshot(r.bot, r.strategy, r.run, r.result).metrics.profitFactor).toBeNull();
    const s = snapshot(), { snapshotSha256: _sha256, ...body } = s;
    const invalid = { ...body, trades: [{ ...labTrade, pnlDollar: null }] };
    expect(validLabSnapshot({ ...invalid, snapshotSha256: snapshotDigest(invalid as any) })).toBe(false);
    expect(validLabSnapshot({ ...s, trades: null })).toBe(false);
  });
  it('distinguishes absent trade history from an empty backtest and rejects zero timeframes', () => {
    const r = labRows(); r.result.trades = null;
    expect(captureLabSnapshot(r.bot, r.strategy, r.run, r.result)).toMatchObject({ tradesRecorded: false, trades: [] });
    r.result.trades = [];
    expect(captureLabSnapshot(r.bot, r.strategy, r.run, r.result).tradesRecorded).toBe(true);
    r.result.timeframe = '0m';
    expect(() => captureLabSnapshot(r.bot, r.strategy, r.run, r.result)).toThrow('LAB_SNAPSHOT_INVALID');
  });
  it('allows only valid linked states and retains evidence after source deletion', () => {
    const s = snapshot(), bot = { ...labRows().bot, labDeploySnapshot: s, labLinkState: 'linked' as const };
    for (const labLinkState of ['linked', 'owner_confirmed'] as const) {
      expect(phoenixLabProvenanceSatisfied({ ...bot, labLinkState, labStrategyId: null, labRunId: null, labResultId: null }).satisfied).toBe(true);
    }
    expect(phoenixLabProvenanceSatisfied({ ...bot, labLinkState: 'unlinked' }).reason).toBe('LAB_UNLINKED');
    expect(phoenixLabProvenanceSatisfied({ ...bot, labDeploySnapshot: null }).reason).toBe('LAB_SNAPSHOT_INVALID');
    expect(phoenixLabProvenanceSatisfied({ ...bot, labDeploySnapshot: { ...s, timeframe: '5m' } }).reason).toBe('LAB_SNAPSHOT_INVALID');
    for (const patch of [{ market: 'BTC' }, { id: 'REDACTED' }, { walletAddress: 'REDACTED' }]) {
      expect(phoenixLabProvenanceSatisfied({ ...bot, ...patch }).reason).toBe('LAB_DEPLOYMENT_MISMATCH');
    }
  });
});

describe('bounded-window comparison and honest live accounting', () => {
  const start = Date.parse('2026-10-15T09:00:00Z'), end = Date.parse('2026-10-15T12:00:00Z');
  it('uses webhook action/time, deduplicates retries, and never reuses an expected order', () => {
    const rows = [
      { payload: { action: 'BUY', time: Date.parse(labTrade.entryTime) / 1000, price: '100' }, receivedAt: new Date() },
      { payload: { action: 'buy', time: labTrade.entryTime }, receivedAt: new Date() },
      { payload: { action: 'sell', time: labTrade.exitTime }, receivedAt: new Date() },
      { payload: { action: 'hold' }, receivedAt: new Date() },
    ];
    const signals = webhookSignals(rows);
    expect(signals).toHaveLength(2); expect(signals[0].price).toBe(100);
    expect(compareLabSignals(signals, [labTrade], '1h', start, end)).toMatchObject({ matched: 2, signals: 2, percent: 100, toleranceSeconds: 300 });
    const repeated = [...signals, { ...signals[0], time: signals[0].time + 1000 }];
    expect(compareLabSignals(repeated, [labTrade], '1h', start, end)).toMatchObject({ matched: 2, signals: 3 });
    expect(compareLabSignals(signals, [labTrade], '1h', end, end + 1000).percent).toBeNull();
    expect(compareLabSignals([{ ...signals[0], action: 'sell' }], [labTrade], '1h', start, end).matched).toBe(0);
  });
  it('handles short entry/exit actions and explicit timing tolerance', () => {
    const signals = [{ action: 'sell' as const, time: Date.parse(labTrade.entryTime) + 30_000, price: null }, { action: 'buy' as const, time: Date.parse(labTrade.exitTime) + 30_001, price: null }];
    expect(compareLabSignals(signals, [{ ...labTrade, direction: 'short' }], '1m', start, end)).toMatchObject({ matched: 1, signals: 2, toleranceSeconds: 30 });
  });
  it('excludes paper/unknown/unexecuted rows and keeps unverified fees/PnL/funding unknown', () => {
    const fill = { protocol: 'pacifica', status: 'executed', fee: '1', feeTruthStatus: 'current_pipeline', pnlConvention: 'net_of_close_fee', pnl: '5', price: '101', averageFillPrice: '102', webhookPayload: { action: 'buy', price: 100 } };
    const rows = [fill, { ...fill, protocol: 'paper', pnl: '999' }, { ...fill, protocol: null }, { ...fill, status: 'pending' }];
    expect(liveTradeSummary(rows as any)).toMatchObject({ liveFills: 1, omitted: 3, pnlUsdc: 5, winRatePercent: 100, feesUsdc: 1, slippageBps: 200, funding: 'unknown' });
    expect(liveTradeSummary([{ ...fill, pnlConvention: 'gross_before_close_fee', feeTruthStatus: 'legacy_unverified' }] as any)).toMatchObject({ feesUsdc: null, pnlUsdc: null, winRatePercent: null });
    expect(liveTradeSummary([{ ...fill, feeTruthStatus: null }] as any).feesUsdc).toBeNull();
    expect(liveTradeSummary([])).toMatchObject({ pnlUsdc: null, feesUsdc: null, slippageBps: null, funding: 'unknown' });
  });
});

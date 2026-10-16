import type { LabStrategy, LabOptimizationRun, LabOptResult, LabTradeRecord } from '../../shared/schema';
export const labTrade: LabTradeRecord = { entryTime: '2026-10-15T10:00:00.000Z', exitTime: '2026-10-15T11:00:00.000Z',
  direction: 'long', entryPrice: 100, exitPrice: 110, pnlPercent: 10, pnlDollar: 100, exitReason: 'signal', barsHeld: 1 };
export function labRows() {
  return {
    bot: { id: 'EXAMPLE', walletAddress: 'EXAMPLE', market: 'SOL-PERP', name: 'EXAMPLE 1h', botType: 'signal',
      createdAt: new Date('2026-10-15T00:00:00Z'), labLinkState: 'unlinked', labDeploySnapshot: null },
    strategy: { id: 1, userId: 'EXAMPLE', name: 'EXAMPLE', pineScript: '// EXAMPLE' } as LabStrategy,
    run: { id: 2, strategyId: 1, userId: 'EXAMPLE', status: 'complete', startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-16T00:00:00Z', configSnapshot: { engineType: 'flux' } } as LabOptimizationRun,
    result: { id: 3, runId: 2, ticker: 'SOLUSDT', timeframe: '1h', params: { length: 14 }, netProfitPercent: 10,
      winRatePercent: 50, maxDrawdownPercent: 2, profitFactor: 2, totalTrades: 1, sharpeRatio: 1, trades: [structuredClone(labTrade)] } as LabOptResult,
  };
}

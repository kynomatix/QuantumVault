import type { LabTradeRecord } from './schema';

export type LabLinkState = 'linked' | 'owner_confirmed' | 'unlinked';
export interface LabDeploySnapshot {
  version: 1;
  botId: string;
  ownerWallet: string;
  strategyId: number;
  runId: number;
  resultId: number;
  strategyName: string;
  capturedAt: string;
  market: string;
  ticker: string;
  timeframe: string;
  params: Record<string, unknown>;
  engine: string;
  engineVersion: string;
  // Historical Lab rows do not retain their script/engine revision.
  scriptVersion: 'historical version unknown';
  pineScript: string;
  config: Record<string, unknown>;
  metrics: {
    netProfitPercent: number | null; winRatePercent: number | null;
    maxDrawdownPercent: number | null; profitFactor: number | null;
    totalTrades: number; sharpeRatio: number | null;
  };
  window: { start: string; end: string };
  tradesRecorded: boolean;
  trades: LabTradeRecord[];
  snapshotSha256: string;
}

export function labMarket(value: string): string {
  return value.trim().toUpperCase().replace(/(?:\/USDT|\/USD|USDT|[-/]PERP|[-/]USD)$/, '');
}

export const LAB_PROVENANCE_MESSAGES = {
  LAB_UNLINKED: 'Find and confirm a Lab source in Settings before starting.',
  LAB_SNAPSHOT_INVALID: 'The saved Lab evidence is incomplete or invalid. A new Lab deployment is needed.',
  LAB_DEPLOYMENT_MISMATCH: 'The saved Lab source belongs to a different market or bot.',
} as const;

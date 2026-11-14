import { useCallback, useEffect, useRef, useState } from 'react';
import { safeResponseJson } from '../lib/safe-fetch';

type Timeframe = '7d' | '30d' | '90d' | 'all';
interface PerformanceData {
  series: { timestamp: string; pnl: number; cumulativePnl: number }[];
  totalPnl: number;
  tradeCount: number;
  accountingIncompleteCloseCount: number;
}
interface PerformanceSnapshot {
  key: string;
  status: 'loading' | 'ready' | 'error';
  dataKey?: string;
  data?: PerformanceData;
}

// Keep the response's identity with its values so a period change cannot relabel
// a previous response, including the render before the new effect starts.
export function useBotPerformance(isOpen: boolean, botId: string | undefined, timeframe: Timeframe, walletAddress: string) {
  const key = JSON.stringify([botId, timeframe, walletAddress]);
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    if (!isOpen || !botId) return;
    const requestGeneration = ++generation.current;
    setSnapshot(previous => ({ key, status: 'loading', dataKey: previous?.dataKey, data: previous?.data }));
    try {
      const res = await fetch(`/api/trading-bots/${botId}/performance?timeframe=${timeframe}&wallet=${walletAddress}`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Performance request failed (${res.status})`);
      const data = await safeResponseJson(res);
      if (requestGeneration !== generation.current) return;
      setSnapshot({ key, status: 'ready', dataKey: key, data: {
        series: data.series || [],
        totalPnl: data.totalPnl || 0,
        tradeCount: data.tradeCount || 0,
        accountingIncompleteCloseCount: data.accountingIncompleteCloseCount || 0,
      } });
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      console.error('Failed to fetch performance data:', error);
      setSnapshot(previous => ({ key, status: 'error', dataKey: previous?.dataKey, data: previous?.data }));
    }
  }, [isOpen, botId, timeframe, walletAddress, key]);

  useEffect(() => {
    void refresh();
    // Invalidates responses on period/bot/wallet changes, close, and unmount.
    return () => { generation.current += 1; };
  }, [refresh]);

  const current = isOpen && snapshot?.key === key ? snapshot : null;
  // Only reuse data with matching provenance; the request key alone also covers
  // pending/error snapshots carrying another period's last known restriction.
  const data = current?.dataKey === key ? current.data : undefined;
  return {
    series: data?.series ?? [],
    totalPnl: data?.totalPnl ?? null,
    tradeCount: data?.tradeCount ?? null,
    // Preserve the last known sharing restriction until a fresh response verifies it.
    accountingIncompleteCloseCount: snapshot?.data?.accountingIncompleteCloseCount ?? 0,
    loading: isOpen && !!botId && (!current || current.status === 'loading'),
    stale: !!data && current?.status !== 'ready',
    refresh,
  };
}

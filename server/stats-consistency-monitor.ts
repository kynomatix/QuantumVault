import { db } from "./db";
import { storage } from "./storage";
import { tradingBots } from "../shared/schema";

const CHECK_INTERVAL_MS = 15 * 60 * 1000;

let monitorInterval: NodeJS.Timeout | null = null;

export async function runStatsConsistencyCheck(): Promise<{
  checked: number;
  drifted: number;
  driftedBotIds: string[];
}> {
  const bots = await db.select({ id: tradingBots.id, stats: tradingBots.stats }).from(tradingBots);
  let drifted = 0;
  const driftedBotIds: string[] = [];
  for (const { id, stats } of bots) {
    try {
      const cached: any = stats ?? {};
      const cachedTotal = Number(cached.totalTrades ?? 0);
      const cachedWin = Number(cached.winningTrades ?? 0);
      const cachedLoss = Number(cached.losingTrades ?? 0);
      const live = await storage.getCanonicalBotTradeStats(id);
      if (
        live.totalTrades !== cachedTotal ||
        live.winningTrades !== cachedWin ||
        live.losingTrades !== cachedLoss
      ) {
        drifted++;
        driftedBotIds.push(id);
        console.warn(
          `[StatsMonitor] DRIFT bot=${id} ` +
          `cached(trades=${cachedTotal}, wins=${cachedWin}, losses=${cachedLoss}) ` +
          `live(trades=${live.totalTrades}, wins=${live.winningTrades}, losses=${live.losingTrades})`
        );
      }
    } catch (err) {
      console.error(`[StatsMonitor] Check failed for bot ${id}:`, err);
    }
  }
  console.log(`[StatsMonitor] Consistency check: ${bots.length} bot(s) checked, ${drifted} drifted`);
  return { checked: bots.length, drifted, driftedBotIds };
}

/**
 * Starts the periodic monitor and returns a promise for the INITIAL check so
 * the boot-work coordinator can serialize it against other startup jobs.
 * Interval reruns are deliberately not serialized (steady-state load is
 * light and spread out).
 */
export function startStatsConsistencyMonitor(): Promise<void> {
  if (monitorInterval) return Promise.resolve();
  console.log(`[StatsMonitor] Starting periodic stats consistency monitor (every ${CHECK_INTERVAL_MS / 60_000} minutes)`);
  const initial = runStatsConsistencyCheck()
    .then(() => undefined)
    .catch((err) => console.error('[StatsMonitor] Initial check failed:', err));
  monitorInterval = setInterval(() => {
    runStatsConsistencyCheck().catch((err) => console.error('[StatsMonitor] Periodic check failed:', err));
  }, CHECK_INTERVAL_MS);
  return initial.then(() => undefined);
}

export function stopStatsConsistencyMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}

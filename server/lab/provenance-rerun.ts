import { Worker } from 'worker_threads';
import { resolve, dirname } from 'path';
import type { LabDeploySnapshot } from '../../shared/lab-provenance';
import type { LabTradeRecord } from '../../shared/schema';
import { fetchOHLCV, LAB_ALL_KNOWN_CANDLE_POLICY } from './datafeed';
import { timeframeMs } from './provenance-analysis';
import { isLabProductionBundle } from './runtime-mode';

let activeReruns = 0;
export async function rerunLabWindow(snapshot: LabDeploySnapshot, start: number, end: number, deadline: number): Promise<LabTradeRecord[]> {
  const bar = timeframeMs(snapshot.timeframe);
  if (!bar || end <= start || (end - start) / bar > 3000 || Date.now() >= deadline) throw new Error('LAB_WINDOW_LIMIT');
  if (activeReruns >= 2) throw new Error('LAB_RERUN_BUSY');
  activeReruns++;
  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  try {
    const candles = await fetchOHLCV(snapshot.ticker, snapshot.timeframe, start - 300 * bar, end, undefined, {
      basisPolicy: LAB_ALL_KNOWN_CANDLE_POLICY, signal: controller.signal, deadlineMs: deadline,
      cacheWritePolicy: 'skip',
    });
    if (candles.length < 10 || candles.length > 3400 || Date.now() >= deadline) throw new Error('LAB_CANDLES_UNAVAILABLE');
    return await new Promise((resolveTrades, reject) => {
      const prod = isLabProductionBundle();
      const workerData = { candles, snapshot };
      const worker = prod
        ? new Worker(resolve(dirname(process.argv[1]), 'provenance-worker.cjs'), { workerData, resourceLimits: { maxOldGenerationSizeMb: 256 } })
        : new Worker(`require('tsx/cjs'); require(${JSON.stringify(resolve(process.cwd(), 'server/lab/provenance-worker.ts'))});`,
          { eval: true, workerData, resourceLimits: { maxOldGenerationSizeMb: 256 } });
      let settled = false;
      const finish = (err?: Error, trades?: LabTradeRecord[]) => {
        if (settled) return;
        settled = true; clearTimeout(timeout);
        void worker.terminate();
        if (err) reject(err); else resolveTrades(trades!);
      };
      const timeout = setTimeout(() => finish(new Error('LAB_RERUN_TIMEOUT')), Math.max(1, deadline - Date.now()));
      worker.once('error', () => finish(new Error('LAB_RERUN_UNAVAILABLE')));
      worker.once('exit', () => finish(new Error('LAB_RERUN_UNAVAILABLE')));
      worker.once('message', message => Array.isArray(message.trades)
        ? finish(undefined, message.trades) : finish(new Error('LAB_RERUN_UNAVAILABLE')));
    });
  } finally { clearTimeout(abort); activeReruns--; }
}

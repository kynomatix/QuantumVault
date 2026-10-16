import { parentPort, workerData } from 'worker_threads';
import { runBacktest, compilePine } from './engine';

// A separate worker makes the CPU deadline enforceable even for pathological Pine.
const { candles, snapshot } = workerData;
try {
  const c = snapshot.config;
  const pineScript = typeof c.pineScript === 'string' ? c.pineScript : snapshot.engine === 'pine' ? snapshot.pineScript : null;
  const result = runBacktest(candles, snapshot.params, snapshot.ticker, snapshot.timeframe, {
    initialCapital: 1000, commission: 0.0005, positionSize: 1000,
    processOrdersOnClose: c.processOrdersOnClose, slippage: c.slippage,
    engineType: snapshot.engine, strategyId: snapshot.strategyId,
    pinePlan: pineScript ? compilePine(pineScript) : undefined,
  });
  parentPort!.postMessage({ trades: result.trades });
} catch {
  parentPort!.postMessage({ error: 'Lab re-run unavailable' });
}

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { labRows } from '../helpers/lab-provenance';
import { captureLabSnapshot } from '../../server/lab/provenance-snapshot';
const state = vi.hoisted(() => ({ fetch: vi.fn(), workers: [] as any[], prod: true }));
vi.mock('../../server/lab/datafeed', () => ({ fetchOHLCV: (...a: any[]) => state.fetch(...a), LAB_ALL_KNOWN_CANDLE_POLICY: 'EXAMPLE' }));
vi.mock('../../server/lab/runtime-mode', () => ({ isLabProductionBundle: () => state.prod }));
vi.mock('worker_threads', () => ({ Worker: class {
  listeners = new Map<string, (...a: any[]) => void>(); terminate = vi.fn();
  constructor(public file: string, public options: any) { state.workers.push(this); }
  once(event: string, listener: (...a: any[]) => void) { this.listeners.set(event, listener); return this; }
  emit(event: string, message?: any) { this.listeners.get(event)?.(message); }
} }));
beforeEach(() => { vi.resetModules(); state.fetch.mockReset(); state.workers = []; state.prod = true; });
afterEach(() => { vi.useRealTimers(); });
function fixture() { const r = labRows(); return captureLabSnapshot(r.bot, r.strategy, r.run, r.result); }
const candles = Array.from({ length: 10 }, (_, i) => ({ time: i * 3600_000, open: 100, high: 101, low: 99, close: 100, volume: 1 }));
it('bounds candle fetch and selects the deployed worker with a memory limit', async () => {
  const { rerunLabWindow } = await import('../../server/lab/provenance-rerun'); state.fetch.mockResolvedValue(candles);
  const start = Date.now() - 3600_000, end = Date.now(), deadline = end + 1000;
  const result = rerunLabWindow(fixture(), start, end, deadline);
  await vi.waitFor(() => expect(state.workers).toHaveLength(1));
  expect(state.workers[0].file).toMatch(/provenance-worker\.cjs$/);
  expect(state.workers[0].options.resourceLimits.maxOldGenerationSizeMb).toBe(256);
  expect(state.fetch.mock.calls[0][5]).toMatchObject({ cacheWritePolicy: 'skip', deadlineMs: deadline, signal: expect.any(AbortSignal) });
  state.workers[0].emit('message', { trades: [] }); expect(await result).toEqual([]); expect(state.workers[0].terminate).toHaveBeenCalledOnce();
});
it('terminates a stalled worker at the deadline and rejects excessive windows', async () => {
  vi.useFakeTimers(); const { rerunLabWindow } = await import('../../server/lab/provenance-rerun'); state.fetch.mockResolvedValue(candles);
  const end = Date.now(), result = rerunLabWindow(fixture(), end - 3600_000, end, end + 100);
  const rejected = expect(result).rejects.toThrow('LAB_RERUN_TIMEOUT');
  await vi.advanceTimersByTimeAsync(100); await rejected;
  expect(state.workers[0].terminate).toHaveBeenCalledOnce();
  await expect(rerunLabWindow(fixture(), end - 3001 * 3600_000, end, end + 1000)).rejects.toThrow('LAB_WINDOW_LIMIT');
});
it('refuses a third concurrent rerun and releases capacity after failures', async () => {
  const { rerunLabWindow } = await import('../../server/lab/provenance-rerun');
  let release!: (value: any) => void; state.fetch.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const end = Date.now(), a = rerunLabWindow(fixture(), end - 3600_000, end, end + 1000);
  const releaseA = release, b = rerunLabWindow(fixture(), end - 3600_000, end, end + 1000), releaseB = release;
  await expect(rerunLabWindow(fixture(), end - 3600_000, end, end + 1000)).rejects.toThrow('LAB_RERUN_BUSY');
  const rejectsA = expect(a).rejects.toThrow('LAB_CANDLES_UNAVAILABLE'), rejectsB = expect(b).rejects.toThrow('LAB_CANDLES_UNAVAILABLE');
  releaseA([]); releaseB([]); await Promise.all([rejectsA, rejectsB]);
  state.fetch.mockResolvedValue([]);
  await expect(rerunLabWindow(fixture(), end - 3600_000, end, end + 1000)).rejects.toThrow('LAB_CANDLES_UNAVAILABLE');
});

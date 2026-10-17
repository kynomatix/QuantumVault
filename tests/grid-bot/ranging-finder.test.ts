import { afterEach, describe, expect, it, vi } from 'vitest';
const transports = vi.hoisted(() => ({ read: vi.fn(), pacifica: vi.fn() }));
vi.mock('../../server/lab/datafeed', () => ({ readPlannerPerpSource: transports.read, readChartPerpSource: vi.fn() }));
vi.mock('../../server/grid-planner/pacifica-candles', async original => ({
  ...await original<typeof import('../../server/grid-planner/pacifica-candles')>(), pacificaPlannerCandles: transports.pacifica,
}));
import { RangingMarketFinder, qualifyRangingMarket } from '../../server/grid-planner/scanner';
import { plannerPoolCandles } from '../../server/grid-planner/candle-pool';
import type { PlannerCandle, PlannerDeps } from '../../server/grid-planner/types';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
import * as regimeModule from '../../server/grid-planner/regime';
const now = 1_800_000_000_000, step = 3_600_000, cut = Math.floor(now / step) * step;
const signal = () => new AbortController().signal;
const candles = (end = cut, count = 100, duration = step): PlannerCandle[] => Array.from({ length: count }, (_, i) => ({
  time: end - (count - i) * duration, open: 100, high: 102, low: 98, close: 100, volume: 1,
  provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' },
}));
const row = (symbol: string, isActive = true) => ({ internalSymbol: `${symbol}-PERP`, protocolSymbol: symbol, isActive } as ProtocolMarket);
const rows = (count: number) => Array.from({ length: count }, (_, i) => row(`M${String(i).padStart(2, '0')}`)).reverse();
const deps = (read = vi.fn(async () => candles())): PlannerDeps => ({ now: () => now, candles: read, getMarkets: async () => [], cachedReference: () => null });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('on-demand ranging finder bounds', () => {
  it('checks deterministic pages of 20 with only two in flight, caches measurements and sorts by ADX then symbol', async () => {
    let active = 0, peak = 0;
    const read = vi.fn(async () => { peak = Math.max(peak, ++active); await new Promise<void>(done => setImmediate(done)); active--; return candles(); });
    const finder = new RangingMarketFinder(deps(read)), universe = [...rows(45), row('INACTIVE', false), row('M00')];
    const first = await finder.read(universe, '1h', 0, signal());
    expect(read).toHaveBeenCalledTimes(20); expect(peak).toBe(2);
    expect(first).toMatchObject({ checked: 20, total: 45, ineligible: 2, nextCursor: 20, unavailable: 0, truncated: true });
    expect(first.candidates.map(c => c.symbol)).toEqual(Array.from({ length: 20 }, (_, i) => `M${String(i).padStart(2, '0')}`));
    expect(read.mock.calls.every(args => args.length === 4 && args[2] === 100)).toBe(true);
    await finder.read(universe, '1h', 0, signal()); expect(read).toHaveBeenCalledTimes(20);
    const next = await finder.read(universe, '1h', 20, signal()); expect(next.nextCursor).toBe(40);
    const last = await finder.read(universe, '1h', 40, signal()); expect(last).toMatchObject({ checked: 5, nextCursor: null, truncated: false });
  });
  it('deduplicates simultaneous clicks and cancellation of one caller preserves the other', async () => {
    let release!: () => void;
    const hold = new Promise<void>(done => { release = done; });
    const read = vi.fn(async () => { await hold; return candles(); });
    const finder = new RangingMarketFinder(deps(read)), owner = new AbortController(), universe = rows(2);
    const cancelled = finder.read(universe, '1h', 0, owner.signal).catch(e => e.message);
    const joined = finder.read(universe, '1h', 0, signal());
    await expect(finder.read(universe, '15m', 0, signal())).rejects.toThrow('busy');
    owner.abort(); expect(await cancelled).toContain('cancelled');
    expect(read.mock.calls.every(call => !(call[3] as AbortSignal).aborted)).toBe(true);
    release(); expect((await joined).checked).toBe(2); expect(read).toHaveBeenCalledTimes(2);
  });
  it('stops starting markets at the 15-second deadline, cancels the two active reads and reports partial coverage', async () => {
    vi.useFakeTimers();
    const read = vi.fn((_market: string, _tf: string, _bars: number, abort: AbortSignal) => new Promise<PlannerCandle[]>((_done, reject) =>
      abort.addEventListener('abort', () => reject(Error('EXAMPLE aborted')), { once: true })));
    const pending = new RangingMarketFinder(deps(read)).read(rows(40), '1h', 0, signal());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await pending).toMatchObject({ checked: 2, unavailable: 2, nextCursor: 2, deadlineReached: true, truncated: true });
    expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls.every(call => call[3].aborted)).toBe(true);
  });
  it('cancels all active reads on disconnect, never queues extra work and rejects invalid cursors', async () => {
    const read = vi.fn((_m: string, _tf: string, _b: number, abort: AbortSignal) => new Promise<PlannerCandle[]>((_done, reject) =>
      abort.addEventListener('abort', () => reject(Error('EXAMPLE aborted')), { once: true })));
    const finder = new RangingMarketFinder(deps(read)), owner = new AbortController();
    const pending = finder.read(rows(30), '1h', 0, owner.signal).catch(e => e.message);
    owner.abort(); expect(await pending).toContain('cancelled');
    await new Promise<void>(done => setImmediate(done));
    expect(read).toHaveBeenCalledTimes(2); expect(read.mock.calls.every(call => call[3].aborted)).toBe(true);
    for (const cursor of [-1, 1.5, 31]) await expect(finder.read(rows(30), '1h', cursor, signal())).rejects.toThrow('cursor');
  });
  it('does not reuse results across an interval or finalized history cut', async () => {
    let clock = now;
    const read = vi.fn(async (_market: string, tf: string) => {
      const duration = tf === '15m' ? 900_000 : step;
      return candles(Math.floor(clock / duration) * duration, 100, duration);
    });
    const finder = new RangingMarketFinder({ ...deps(read), now: () => clock });
    await finder.read(rows(1), '1h', 0, signal());
    await finder.read(rows(1), '15m', 0, signal());
    clock += step; await finder.read(rows(1), '1h', 0, signal());
    expect(read).toHaveBeenCalledTimes(3);
  });
});

describe('ranging qualification uses both existing facts', () => {
  it('excludes ADX exactly 20 and sorts differing measured ADX before the symbol tie break', async () => {
    const actual = regimeModule.plannerRegime;
    vi.spyOn(regimeModule, 'plannerRegime').mockImplementation((market, ...args) => {
      const result = actual(market, ...args);
      return result.state === 'available' ? { ...result, adx: market === 'M00-PERP' ? 19.9 : market === 'M01-PERP' ? 20 : 5 } : result;
    });
    const page = await new RangingMarketFinder(deps()).read(rows(4), '1h', 0, signal());
    expect(page.notRanging).toBe(1);
    expect(page.candidates.map(c => c.symbol)).toEqual(['M02', 'M03', 'M00']);
  });
  it('accepts ADX below 20 plus an active range and preserves source and history time', () => {
    expect(qualifyRangingMarket('BTC-PERP', 'BTC', '1h', candles(), now, cut)).toMatchObject({ state: 'ranging', candidate: {
      market: 'BTC-PERP', symbol: 'BTC', adx: 0, lowerPrice: '98', upperPrice: '102', venue: 'okx', latestFinalizedTime: cut - step,
    } });
  });
  it.each(['partial', 'forming', 'gap', 'stale', 'mixed', 'pacifica', 'no-range', 'volume', 'spot', 'nan'])('never qualifies %s history', kind => {
    const bars = candles();
    if (kind === 'partial') bars.pop();
    if (kind === 'forming') bars[99].provenance.finality = 'forming';
    if (kind === 'gap') bars[30].time++;
    if (kind === 'stale') bars.forEach(c => { c.time -= step; });
    if (kind === 'mixed') bars[0].provenance.venue = 'gate';
    if (kind === 'pacifica') bars.forEach(c => { c.provenance.source = 'pacifica'; c.provenance.venue = 'pacifica'; });
    if (kind === 'no-range') bars.forEach(c => { c.high = c.low = c.close = c.open; });
    if (kind === 'volume') bars[2].volume = -1;
    if (kind === 'spot') bars[3].provenance.basis = 'spot';
    if (kind === 'nan') bars[4].high = NaN;
    expect(qualifyRangingMarket('BTC-PERP', 'BTC', '1h', bars, now, cut).state).toBe('unavailable');
  });
  it('does not qualify a measured trend and retries unavailable markets on a later click', async () => {
    const trending = candles().map((c, i) => ({ ...c, open: 100 + i, close: 100 + i, high: 102 + i, low: 98 + i }));
    expect(qualifyRangingMarket('BTC-PERP', 'BTC', '1h', trending, now, cut).state).toBe('not-ranging');
    const read = vi.fn().mockResolvedValueOnce([]).mockResolvedValue(candles());
    const finder = new RangingMarketFinder(deps(read));
    expect(await finder.read(rows(1), '1h', 0, signal())).toMatchObject({ unavailable: 1, candidates: [] });
    expect((await finder.read(rows(1), '1h', 0, signal())).candidates).toHaveLength(1);
  });
});

describe('shared finalized planner pool cache', () => {
  it('reuses planner history for finder-sized reads and rolls the cache at a new finalized cut', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    transports.read.mockImplementation(async (_source, _market, _tf, start, end) => candles(end, (end - start) / step));
    expect(await plannerPoolCandles('CACHE-PERP', '1h', 168, signal())).toHaveLength(168);
    expect(await plannerPoolCandles('CACHE-PERP', '1h', 100, signal())).toHaveLength(100);
    expect(transports.read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(now + step);
    await plannerPoolCandles('CACHE-PERP', '1h', 100, signal()); expect(transports.read).toHaveBeenCalledTimes(2);
  });
  it('deduplicates simultaneous pool reads and keeps a surviving caller alive', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    let release!: (value: PlannerCandle[]) => void;
    transports.read.mockReturnValue(new Promise<PlannerCandle[]>(done => { release = done; }));
    const owner = new AbortController();
    const first = plannerPoolCandles('JOIN-PERP', '1h', 100, owner.signal).catch(() => []);
    const second = plannerPoolCandles('JOIN-PERP', '1h', 100, signal()); owner.abort();
    expect(await first).toEqual([]); expect(transports.read).toHaveBeenCalledTimes(1);
    expect((transports.read.mock.calls[0][5] as AbortSignal).aborted).toBe(false);
    release(candles()); expect(await second).toHaveLength(100);
  });
});

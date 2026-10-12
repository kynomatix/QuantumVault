import { afterEach, describe, expect, it, vi } from 'vitest';
import { BTC_TREND_PUBLICATION_GRACE_MS as GRACE, BTC_TREND_NEGATIVE_CACHE_MS as RETRY,
  BTC_TREND_WEEK_MS as WEEK, BTC_WEEKLY_SOURCES, type BtcStoredWeek, type BtcWeeklySource } from '../../shared/grid-direction';
import { computeBtcDirection, PlannerDirection } from '../../server/grid-planner/direction';
import { aggregateBtcDailyWeeks, readBtcWeeklySource, plannerBtcWeeklyCandles, BTC_WEEKLY_SOURCE_ORDER } from '../../server/grid-planner/btc-candles';
import { PostgresBtcWeeklyStore, type WeeklyPool } from '../../server/grid-planner/weekly-store';
import { registerGridPlannerRoutes } from '../../server/grid-planner/routes';
import type { PlannerDeps } from '../../server/grid-planner/types';

const quota = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../server/protocol/pacifica/pacifica-quota', () => ({ pacificaQuota: { tryClaimImmediate: quota } }));
const DAY = WEEK / 7, now = Date.UTC(2026, 9, 13), end = now - DAY, start = end - 55 * WEEK;
function history(count = 55, lastClose = '200', source: BtcWeeklySource = 'okx-index', until = end): BtcStoredWeek[] {
  return Array.from({ length: count }, (_, i) => ({ market: 'BTC', weekStart: until - (count - i) * WEEK,
    close: i === count - 1 ? lastClose : '100', source, basis: BTC_WEEKLY_SOURCES[source].basis,
    aggregation: 'native', finalized: true, fetchedAt: until + DAY }));
}
const dbRow = (w: BtcStoredWeek) => ({ market: w.market, week_start: new Date(w.weekStart).toISOString(), close: w.close,
  source: w.source, basis: w.basis, aggregation: w.aggregation, finalized: w.finalized, fetched_at: new Date(w.fetchedAt).toISOString() });
// Shared database double: each store uses independent clients against the same durable rows and session lock.
class Database {
  weeks = new Map<number, ReturnType<typeof dbRow>>();
  attempt: number | null = null;
  lock: object | null = null;
  failInsert = false;
  releases: (Error | undefined)[] = [];
  statements: string[] = [];
  constructor(rows: BtcStoredWeek[] = []) { rows.forEach(w => this.weeks.set(w.weekStart, dbRow(w))); }
  private latest(cutoff: number) { return [...this.weeks.values()].filter(w => w.finalized && Date.parse(w.week_start) < cutoff)
    .sort((a, b) => Date.parse(b.week_start) - Date.parse(a.week_start)).slice(0, 50); }
  pool: WeeklyPool = {
    query: async (sql, args) => { this.statements.push(sql); return { rows: [{ weeks: this.latest(Number(args![0])).reverse(),
      last_attempt_at: this.attempt === null ? null : new Date(this.attempt).toISOString() }] }; },
    connect: async () => {
      const session = {};
      return { release: error => { this.releases.push(error); if (this.lock === session) this.lock = null; },
        query: async (sql, args) => {
          this.statements.push(sql);
          if (sql.includes('pg_try_advisory_lock')) {
            if (this.lock) return { rows: [{ locked: false }] };
            this.lock = session; return { rows: [{ locked: true }] };
          }
          if (sql.includes('pg_advisory_unlock')) { this.lock = null; return { rows: [] }; }
          if (sql.includes('SELECT week_start')) return { rows: this.latest(Number(args![0])) };
          if (sql.includes('INSERT INTO planner_btc_weekly_refresh')) {
            if (this.attempt !== null && this.attempt > Number(args![1])) return { rows: [] };
            this.attempt = Number(args![0]); return { rows: [{ market: 'BTC' }] };
          }
          if (sql.includes('INSERT INTO planner_btc_weekly_closes')) {
            if (this.failInsert) throw Error('EXAMPLE failed insert');
            expect(sql).toContain('ON CONFLICT (market, week_start) DO NOTHING');
            for (const w of JSON.parse(String(args![0]))) if (!this.weeks.has(Date.parse(w.week_start))) {
              this.weeks.set(Date.parse(w.week_start), { ...w, market: 'BTC', finalized: true });
            }
            return { rows: [] };
          }
          throw Error('EXAMPLE unexpected SQL');
        } };
    },
  };
}
function service(db: Database, clock: () => number = () => now, load = vi.fn(async () => history())) {
  return { load, direction: new PlannerDirection({ now: clock, btcWeeklyCandles: load, btcWeeklyStore: new PostgresBtcWeeklyStore(db.pool) }) };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); quota.mockReset().mockReturnValue(true); });

 describe('stored BTC 50-week regime', () => {
  it.each(Object.keys(BTC_WEEKLY_SOURCES) as BtcWeeklySource[])('uses only the last 50 finalized stored %s closes', source => {
    const rows = history(55, '200', source); rows[0].close = '1';
    expect(computeBtcDirection(rows, now)).toMatchObject({ regime: 'above', movingAverage: 102, lastClose: 200,
      source, sourceBasis: BTC_WEEKLY_SOURCES[source].basis, sourceAggregation: 'native', asOf: end, expiresAt: end + WEEK });
  });
  it('returns below and unavailable at exact equality, including decimal closes', () => {
    expect(computeBtcDirection(history(50, '50'), now).regime).toBe('below');
    expect(computeBtcDirection(history(50, '100'), now).regime).toBe('unavailable');
    const equal = history(50).map(w => ({ ...w, close: '0.123456789012345678' }));
    expect(computeBtcDirection(equal, now).regime).toBe('unavailable');
  });
  it.each(['short', 'gap', 'duplicate', 'utc', 'finality', 'basis', 'price', 'future fetch', 'stale'] as const)('rejects %s history', defect => {
    const rows = history(50);
    if (defect === 'short') rows.pop();
    if (defect === 'gap') rows[10].weekStart -= WEEK;
    if (defect === 'duplicate') rows[10] = { ...rows[9] };
    if (defect === 'utc') rows[10].weekStart -= 8 * 3600000;
    if (defect === 'finality') (rows[10] as any).finalized = false;
    if (defect === 'basis') rows[10].basis = 'perp';
    if (defect === 'price') rows[10].close = 'NaN';
    if (defect === 'future fetch') rows[10].fetchedAt = now + 1;
    if (defect === 'stale') rows.forEach(w => { w.weekStart -= WEEK; });
    expect(computeBtcDirection(rows, now).regime).toBe('unavailable');
  });
  it('honestly marks mixed sources and aggregation', () => {
    const rows = history(50); rows[0] = { ...rows[0], source: 'gate-spot', basis: 'spot', aggregation: 'daily' };
    expect(computeBtcDirection(rows, now)).toMatchObject({ regime: 'above', source: 'mixed', sourceVenue: 'mixed', sourceBasis: 'mixed', sourceAggregation: 'mixed' });
  });
  it('expires old data exactly on UTC Monday even during publication grace', () => {
    expect(computeBtcDirection(history(), end + WEEK - 1).regime).toBe('above');
    expect(computeBtcDirection(history(), end + WEEK).regime).toBe('unavailable');
  });
});

 describe('database reads, append and platform-wide coordination', () => {
  it('reads 50 completed stored weeks on every request, without an upstream or result cache', async () => {
    const db = new Database(history()), { direction, load } = service(db);
    expect((await direction.read()).lastClose).toBe(200);
    db.weeks.get(end - WEEK)!.close = '50';
    expect((await direction.read()).regime).toBe('below');
    expect(load).not.toHaveBeenCalled();
    expect(db.statements.filter(s => s.includes('jsonb_agg'))).toHaveLength(2);
  });
  it('backfills 55 weeks, then appends only missing weeks without replacing old provenance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const db = new Database(), first = service(db);
    expect((await first.direction.read()).regime).toBe('above');
    expect(db.weeks.size).toBe(55);
    expect(first.load).toHaveBeenCalledWith(expect.any(AbortSignal), start, end);
    vi.spyOn(Date, 'now').mockReturnValue(now + WEEK);
    const next = service(db, () => now + WEEK, vi.fn(async () => history(55, '200', 'gate-spot', end + WEEK)));
    const value = await next.direction.read();
    expect(db.weeks.size).toBe(56); expect(db.weeks.get(end - WEEK)!.source).toBe('okx-index');
    expect(value).toMatchObject({ source: 'mixed', regime: 'above' });
    await next.direction.read(); expect(db.weeks.size).toBe(56); expect(next.load).toHaveBeenCalledTimes(1);
  });
  it('does not fetch until Monday 00:15 UTC and never uses stale data through grace', async () => {
    const db = new Database(history(55, '200', 'okx-index', end - WEEK));
    const early = service(db, () => end + GRACE - 1);
    expect(await early.direction.read()).toMatchObject({ regime: 'unavailable', expiresAt: end + GRACE });
    expect(early.load).not.toHaveBeenCalled();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const ready = service(db, () => end + GRACE, vi.fn(async () => history().map(w => ({ ...w, fetchedAt: end + GRACE }))));
    expect((await ready.direction.read()).regime).toBe('above'); expect(ready.load).toHaveBeenCalledTimes(1);
  });
  it('single-flights across separate service instances and releases the session lock', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const db = new Database(); let finish!: (rows: BtcStoredWeek[]) => void, started!: () => void;
    const began = new Promise<void>(resolve => { started = resolve; });
    const load = vi.fn(() => { started(); return new Promise<BtcStoredWeek[]>(resolve => { finish = resolve; }); });
    const first = service(db, () => now, load), second = service(db, () => now, load);
    const pending = first.direction.read(); await began;
    expect((await second.direction.read()).regime).toBe('unavailable'); expect(load).toHaveBeenCalledTimes(1);
    finish(history()); expect((await pending).regime).toBe('above');
    expect((await second.direction.read()).regime).toBe('above'); expect(load).toHaveBeenCalledTimes(1); expect(db.lock).toBeNull();
  });
  it.each(['empty', 'throw', 'invalid', 'duplicate', 'insert failure'] as const)('persists the retry cadence across restart after %s results', async defect => {
    let clock = now; vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const db = new Database(); db.failInsert = defect === 'insert failure';
    const load = vi.fn(async () => {
      if (defect === 'throw') throw Error('EXAMPLE unavailable');
      if (defect === 'empty') return [];
      const rows = history().map(w => ({ ...w, fetchedAt: clock }));
      if (defect === 'invalid') rows[0].weekStart++;
      if (defect === 'duplicate') rows[1] = rows[0];
      return rows;
    });
    expect(await service(db, () => clock, load).direction.read()).toMatchObject({ regime: 'unavailable', expiresAt: now + RETRY });
    expect(db.attempt).toBe(now); expect(db.weeks.size).toBe(0); expect(db.lock).toBeNull();
    clock += RETRY - 1; await service(db, () => clock, load).direction.read(); expect(load).toHaveBeenCalledTimes(1);
    clock++; await service(db, () => clock, load).direction.read(); expect(load).toHaveBeenCalledTimes(2);
  });
  it('repairs a missing older week even when the newest week is already stored', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const db = new Database(history()); db.weeks.delete(end - 20 * WEEK);
    const { direction, load } = service(db);
    expect((await direction.read()).regime).toBe('above'); expect(load).toHaveBeenCalledTimes(1);
  });
  it('returns unavailable when storage is absent or failed, even if an upstream returns valid closes', async () => {
    const load = vi.fn(async () => history());
    expect((await new PlannerDirection({ now: () => now, btcWeeklyCandles: load }).read()).regime).toBe('unavailable');
    const db = new Database(); db.pool.query = async () => { throw Error('EXAMPLE DB unavailable'); };
    expect((await service(db, () => now, load).direction.read()).regime).toBe('unavailable'); expect(load).not.toHaveBeenCalled();
  });
});

function dailyBars() { return Array.from({ length: 385 }, (_, i) => ({ time: start + i * DAY,
  close: i === 384 ? '200' : '100', finalized: true })); }
function payload(source: BtcWeeklySource) {
  const weeks = history(), days = dailyBars();
  if (source.startsWith('okx')) return { code: '0', data: weeks.map(w => source === 'okx-index'
    ? [String(w.weekStart), '100', '200', '50', w.close, '1'] : [String(w.weekStart), '100', '200', '50', w.close, '10', '1', '1', '1']) };
  if (source === 'gate-spot') return weeks.map(w => [String(w.weekStart / 1000), '10', w.close, '200', '50', '100', '1', 'true']);
  if (source === 'kraken-spot') return { error: [], result: { XXBTZUSD: [...days, { time: end, close: '1', finalized: false }].map(w => [w.time / 1000, '100', '200', '50', w.close]), last: end / 1000 } };
  if (source === 'coinbase-spot') return days.map(w => [w.time / 1000, 50, 200, 100, Number(w.close), 10]);
  if (source === 'hyperliquid-perp') return days.map(w => ({ t: w.time, T: w.time + DAY - 1, s: 'BTC', i: '1d', c: w.close }));
  return { success: true, data: weeks.map(w => ({ t: w.weekStart, T: w.weekStart + WEEK, s: 'BTC', i: '1w', c: w.close })) };
}
const response = (data: unknown) => ({ ok: true, json: async () => data });
 describe('finalized UTC source adapters and source selection', () => {
  it.each(BTC_WEEKLY_SOURCE_ORDER)('parses a complete %s window and retains honest provenance', async source => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => {
      let data = payload(source);
      if (source === 'coinbase-spot') { const q = new URL(url).searchParams; const lo = Date.parse(q.get('start')!), hi = Date.parse(q.get('end')!);
        data = (data as number[][]).filter(r => r[0] * 1000 >= lo && r[0] * 1000 <= hi); }
      return response(data);
    }); vi.stubGlobal('fetch', fetcher);
    const rows = await readBtcWeeklySource(source, new AbortController().signal, start, end);
    expect(rows).toHaveLength(55); expect(rows.at(-1)).toMatchObject({ weekStart: end - WEEK, close: '200', source,
      basis: BTC_WEEKLY_SOURCES[source].basis, aggregation: ['kraken-spot','coinbase-spot','hyperliquid-perp'].includes(source) ? 'daily' : 'native' });
    if (source === 'hyperliquid-perp') expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toMatchObject({ req: { interval: '1d' } });
    if (source === 'coinbase-spot') expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('prefers a single OKX index window, then Gate spot on refusal, without consulting chart caches', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const fetcher = vi.fn(async (url: string) => url.includes('okx') ? { ok: false } : response(payload('gate-spot'))); vi.stubGlobal('fetch', fetcher);
    const rows = await plannerBtcWeeklyCandles(new AbortController().signal, start, end);
    expect(new Set(rows.map(w => w.source))).toEqual(new Set(['gate-spot'])); expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockImplementation(async () => response(payload('okx-index')));
    expect((await plannerBtcWeeklyCandles(new AbortController().signal, start, end))[0].source).toBe('okx-index');
  });
  it.each(['duplicate','offset','forming','missing','price'] as const)('rejects an unusable Gate weekly %s window', async defect => {
    vi.spyOn(Date, 'now').mockReturnValue(now); const rows = payload('gate-spot') as string[][];
    if (defect === 'duplicate') rows[1] = rows[0];
    if (defect === 'offset') rows.forEach(row => { row[0] = String(Number(row[0]) - 28800); });
    if (defect === 'forming') rows[54][7] = 'false';
    if (defect === 'missing') rows.splice(20, 1);
    if (defect === 'price') rows[0][2] = '0';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('gateio') ? response(rows) : { ok: false }));
    expect(await plannerBtcWeeklyCandles(new AbortController().signal, start, end)).toEqual([]);
  });
  it.each(['missing','duplicate','forming','offset'] as const)('never synthesizes a daily week with a %s day', defect => {
    const days = dailyBars();
    if (defect === 'missing') days.pop();
    if (defect === 'duplicate') days[384] = { ...days[383] };
    if (defect === 'forming') days[384].finalized = false;
    if (defect === 'offset') days[384].time++;
    const weeks = aggregateBtcDailyWeeks(days, 'hyperliquid-perp', start, end, now);
    expect(weeks.find(w => w.weekStart === end - WEEK)).toBeUndefined();
  });
  it('honours cancellation and Pacifica quota without using an invented oracle candle', async () => {
    const signal = AbortSignal.abort(); vi.stubGlobal('fetch', vi.fn());
    await expect(plannerBtcWeeklyCandles(signal, start, end)).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
    quota.mockReturnValue(false);
    expect(await readBtcWeeklySource('pacifica-mark', new AbortController().signal, start, end)).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
});

 describe('display-only endpoint', () => {
  it('requires wallet auth, rejects direction inputs and reads stored BTC data without market/reference queries', async () => {
    const registrations = new Map<string, any[]>(), auth = vi.fn();
    const app = { get: vi.fn((path, ...handlers) => registrations.set(path, handlers)) };
    const db = new Database(history());
    const deps: PlannerDeps = { now: () => now, getMarkets: vi.fn(async () => []), cachedReference: vi.fn(() => null),
      candles: vi.fn(async () => []), btcWeeklyCandles: vi.fn(async () => history()), btcWeeklyStore: new PostgresBtcWeeklyStore(db.pool) };
    const load = vi.fn(async () => deps);
    registerGridPlannerRoutes(app as any, auth, load, false); expect(app.get).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled();
    registerGridPlannerRoutes(app as any, auth, load, true);
    const handlers = registrations.get('/api/grid-planner/direction')!; expect(handlers[0]).toBe(auth);
    const res = { set: vi.fn(), json: vi.fn(), status: vi.fn(), destroyed: false }; res.status.mockReturnValue(res);
    await handlers[1]({ query: {} }, res); expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ regime: 'above', source: 'okx-index' }));
    await handlers[1]({ query: { side: 'short' } }, res); expect(res.status).toHaveBeenCalledWith(400);
    expect(deps.getMarkets).not.toHaveBeenCalled(); expect(deps.cachedReference).not.toHaveBeenCalled(); expect(deps.btcWeeklyCandles).not.toHaveBeenCalled();
  });
});

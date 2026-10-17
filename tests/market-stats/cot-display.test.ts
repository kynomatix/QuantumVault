import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW } from './fixtures';
vi.mock('../../server/db.js', () => ({ db: {} }));
vi.mock('../../shared/schema.js', () => ({ cotSnapshots: {} }));

describe('request-driven COT display adapter', () => {
  const fetchMock = vi.fn();
  const stored = (fetchedAt = NOW - 1_000) => ({ latest: { report_date: '2026-10-13', comm_index: '61.23', dumb_index: '38.77',
    weeks_in_window: 120, fetched_at: new Date(fetchedAt).toISOString() },
    flip: { report_date: '2026-09-29', state: 'bullish_flip' } });
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(NOW); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('coalesces display readers, retains an older stored flip and respects an existing 24h capture', async () => {
    const query = vi.fn(async () => ({ rows: [stored()] }));
    const database = { query, connect: vi.fn() };
    const { getCotDisplaySnapshot } = await import('../../server/ai-trader/cot-service');
    const [one, two] = await Promise.all([getCotDisplaySnapshot(database, NOW), getCotDisplaySnapshot(database, NOW)]);
    expect(one).toEqual(two); expect(one?.commIndex).toBe(61.23);
    expect(one?.latestFlip).toEqual({ reportDate: '2026-09-29', state: 'bullish_flip' });
    expect(one?.retryAt).toBe(NOW - 1_000 + 86_400_000);
    expect(query).toHaveBeenCalledTimes(2); expect(fetchMock).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain("WHERE state IN ('bullish_flip', 'bearish_flip')");
  });
  it('awaits one bounded bootstrap batch into the existing table, then suppresses another fetch for 24h', async () => {
    const raw = Array.from({ length: 135 }, (_, i) => ({ report_date_as_yyyy_mm_dd: new Date(Date.UTC(2024, 2, 19) + i * 604_800_000).toISOString(),
      comm_positions_long_all: String(1000 + i), comm_positions_short_all: '500',
      noncomm_positions_long_all: '800', noncomm_positions_short_all: String(400 + i),
      nonrept_positions_long_all: '100', nonrept_positions_short_all: '50' }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => raw });
    let written = false;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('INSERT')) { written = true; expect(sql).toContain('"reportDate" date');
        expect(JSON.parse((values as string[])[0])).toHaveLength(135); return { rows: [] }; }
      return { rows: written ? [stored(NOW)] : [{ latest: null, flip: null }] };
    });
    const database = { query, connect: vi.fn() };
    const { getCotDisplaySnapshot } = await import('../../server/ai-trader/cot-service');
    expect((await getCotDisplaySnapshot(database, NOW))?.fetchedAt).toBe(NOW);
    await getCotDisplaySnapshot(database, NOW + 86_399_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('INSERT'))).toHaveLength(1);
  });
  it('negative-caches failed refresh attempts for five minutes', async () => {
    fetchMock.mockRejectedValue(Error('EXAMPLE offline'));
    const query = vi.fn(async () => ({ rows: [stored(NOW - 2 * 86_400_000)] }));
    const database = { query, connect: vi.fn() };
    const { getCotDisplaySnapshot } = await import('../../server/ai-trader/cot-service');
    expect((await getCotDisplaySnapshot(database, NOW))?.retryAt).toBe(NOW + 300_000);
    await getCotDisplaySnapshot(database, NOW + 299_999); expect(fetchMock).toHaveBeenCalledOnce();
    await getCotDisplaySnapshot(database, NOW + 300_000); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

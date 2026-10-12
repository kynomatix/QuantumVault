import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { GridDirectionBadge, GridDirectionHint } from '../../client/src/components/grid-planner/GridDirectionBadge';
import { gridDirectionText, isGridDirectionSuggestion } from '../../client/src/lib/grid-direction-view';
import { BTC_TREND_CACHE_MS as DAY, BTC_TREND_WEEK_MS as WEEK, type GridDirectionSuggestion } from '../../shared/grid-direction';

const now = Date.UTC(2026, 9, 13);
const above: GridDirectionSuggestion = { regime: 'above', sourceVenue: 'okx', movingAverage: 100, lastClose: 102,
  asOf: now - DAY, retrievedAt: now, serverNow: now, expiresAt: now + DAY };
const below: GridDirectionSuggestion = { ...above, regime: 'below', lastClose: 98 };

// Exercise the real badge effect without adding a DOM runtime or renderer dependency.
const hooks = vi.hoisted(() => ({ value: null as unknown, writes: [] as unknown[], effect: undefined as (() => void | (() => void)) | undefined, dependencies: [] as unknown[] }));
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(),
  useState: () => [hooks.value, (value: unknown) => { hooks.value = value; hooks.writes.push(value); }],
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => { hooks.effect = effect; hooks.dependencies = dependencies; },
}));
vi.mock('../../client/src/lib/queryClient', () => ({ walletAuthHeaders: () => ({ 'x-wallet-address': 'EXAMPLE' }) }));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); hooks.value = null; hooks.writes = []; hooks.effect = undefined; });

describe('display-only direction badge', () => {
  it('states the suggestion and its BTC weekly, SMA, venue and UTC basis', () => {
    expect(gridDirectionText(above).label).toBe('Trend: BTC above its 50-week average — long grids favoured');
    expect(gridDirectionText(below).label).toContain('short grids favoured');
    const html = renderToStaticMarkup(createElement(GridDirectionHint, { suggestion: above }));
    for (const text of ['BTC weekly candles', '50-week simple moving average', 'OKX', 'As of', 'UTC', 'choose either direction']) expect(html).toContain(text);
    expect(html).toContain('<details'); expect(html).toContain('<summary');
  });
  it('shows unavailable for absent data and rejects malformed, expired and stale server values', () => {
    expect(gridDirectionText(null).label).toBe('Trend suggestion unavailable');
    expect(isGridDirectionSuggestion(above)).toBe(true);
    for (const value of [null, {}, { ...above, expiresAt: now }, { ...above, asOf: now - WEEK },
      { ...above, lastClose: 99 }, { ...above, sourceVenue: 'unknown' }, { ...above, movingAverage: '100' },
      { ...above, retrievedAt: now + 1 }, { ...above, expiresAt: now + 2 * DAY }]) expect(isGridDirectionSuggestion(value)).toBe(false);
  });
  it('labels native Pacifica weeks separately from weekly closes aggregated from daily', () => {
    const native: GridDirectionSuggestion = { ...above, sourceVenue: 'pacifica' };
    const daily: GridDirectionSuggestion = { ...native, sourceAggregation: 'weekly-from-daily' };
    expect(isGridDirectionSuggestion(native)).toBe(true); expect(isGridDirectionSuggestion(daily)).toBe(true);
    expect(gridDirectionText(native).basis).toContain('PACIFICA perpetual candles');
    expect(gridDirectionText(daily).basis).toContain('Pacifica perp, weekly from daily');
    expect(isGridDirectionSuggestion({ ...above, sourceAggregation: 'weekly-from-daily' })).toBe(false);
    expect(isGridDirectionSuggestion({ ...native, sourceAggregation: 'spot' })).toBe(false);
  });
  it.each(['long', 'short'] as const)('leaves the selected %s control unchanged across opposing and unavailable suggestions', direction => {
    for (const suggestion of [above, below, null]) {
      const intent = { direction };
      const html = renderToStaticMarkup(createElement('div', null,
        createElement('input', { name: 'direction', type: 'radio', value: 'long', checked: intent.direction === 'long', readOnly: true }),
        createElement('input', { name: 'direction', type: 'radio', value: 'short', checked: intent.direction === 'short', readOnly: true }),
        createElement(GridDirectionHint, { suggestion })));
      expect(intent.direction).toBe(direction);
      const control = html.match(/<input[^>]+>/g)?.find(input => input.includes(`value="${direction}"`));
      expect(control).toContain('checked=""');
      const hint = renderToStaticMarkup(createElement(GridDirectionHint, { suggestion }));
      expect(hint).not.toMatch(/<input|<select|<button|disabled|aria-pressed/);
    }
  });
  it('keeps both real integrations independent of all direction editing and admission', () => {
    const planner = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
    const create = readFileSync('client/src/components/grid-bot/GridCreateSheet.tsx', 'utf8');
    expect(planner).toContain('<GridDirectionBadge active={open} identity={identity}/>');
    expect(planner).toContain("onClick={() => edit('side', side)}");
    expect(create).toContain('<GridDirectionBadge active={open} identity={identity}/>');
    const parent = readFileSync('client/src/components/grid-bot/GridDraftCard.tsx', 'utf8');
    expect(parent).toContain('identity={identity??undefined}');
    expect(create).toContain("selected('direction','Direction',['long','short'])");
    for (const source of [planner, create]) {
      expect(source.match(/<GridDirectionBadge\b/g)).toHaveLength(1);
    }
  });
  it('binds the effect to wallet identity and aborts the old wallet read before refetching', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    GridDirectionBadge({ active: true, identity: 'EXAMPLE_A' });
    expect(hooks.dependencies).toEqual([true, 'EXAMPLE_A']);
    const firstCleanup = hooks.effect?.();
    const firstSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    if (typeof firstCleanup === 'function') firstCleanup();
    expect(firstSignal?.aborted).toBe(true);
    GridDirectionBadge({ active: true, identity: 'EXAMPLE_B' });
    expect(hooks.dependencies).toEqual([true, 'EXAMPLE_B']);
    const secondCleanup = hooks.effect?.();
    expect(fetch).toHaveBeenCalledTimes(2);
    if (typeof secondCleanup === 'function') secondCleanup();
  });
  it.each(['long', 'short'] as const)('fetches an opposing suggestion without any %s direction state write and expires the display', async direction => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const response = direction === 'long' ? below : above;
    const intent = Object.freeze({ direction });
    const fetcher = vi.fn(async () => ({ ok: true, json: async () => response }));
    vi.stubGlobal('fetch', fetcher);
    GridDirectionBadge({ active: true, identity: 'EXAMPLE' });
    const cleanup = hooks.effect?.();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledWith('/api/grid-planner/direction', expect.objectContaining({ method: 'GET', credentials: 'include', headers: { 'x-wallet-address': 'EXAMPLE' } }));
      expect(hooks.writes).toEqual([null, response]);
      expect(intent.direction).toBe(direction);
      await vi.advanceTimersByTimeAsync(DAY);
      expect(hooks.value).toBeNull(); expect(intent.direction).toBe(direction);
    } finally { if (typeof cleanup === 'function') cleanup(); }
  });
  it('ignores a late response after closing and shows unavailable for failed reads', async () => {
    let resolve!: (response: { ok: boolean; json: () => Promise<GridDirectionSuggestion> }) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done; })));
    GridDirectionBadge({ active: true });
    const cleanup = hooks.effect?.();
    if (typeof cleanup === 'function') cleanup();
    resolve({ ok: true, json: async () => above });
    await new Promise<void>(done => setImmediate(done));
    expect(hooks.writes).toEqual([null]);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('EXAMPLE failed read'); }));
    GridDirectionBadge({ active: true });
    const cleanupFailure = hooks.effect?.();
    try { await new Promise<void>(done => setImmediate(done)); expect(hooks.value).toBeNull(); }
    finally { if (typeof cleanupFailure === 'function') cleanupFailure(); }
  });
});

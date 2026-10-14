import { afterEach, describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { GridRegimeHint } from '../../client/src/components/grid-planner/GridRegimeHint';
import { gridSetupAccess, gridSetupForm, gridSetupIntent, isGridRegime, gridMarketChange } from '../../client/src/lib/grid-setup-view';
import { gridHistoryWindow, gridHistoryRequest } from '../../shared/grid-lookback';
import { GridDraftCard } from '../../client/src/components/grid-bot/GridDraftCard';
import { GridDraftActions } from '../../client/src/components/grid-bot/GridDraftActions';
import { GridPlannerChart } from '../../client/src/components/grid-planner/GridPlannerChart';
import { GridPlannerSizeSelect } from '../../client/src/components/grid-planner/GridPlannerSizeSelect';
import { GridPlanIssues } from '../../client/src/components/grid-planner/GridPlanIssues';
import { GridBotOverview, GridBotDetails } from '../../client/src/components/grid-bot/GridBotDrawer';
import { gridSurface } from '../../server/grid-bot/surface';
import { plannerPriceFormat, plannerIssue, plannerMinimumRows } from '../../client/src/lib/grid-planner-view';
import { feePercentToRate, PlannerRequestGeneration, plannerOverlays, plannerLevelMessage, isPlannerMarket, isPlannerChart, isPlannerPreview,
  PLANNING_BANNER, ASSUMPTION_LABEL, readableDecimal, clientObservationDeadline, plannerRangeAround,
  proposedPlannerStop, plannerChartRange, plannerSizeHint, plannerShortcutReason, ORDER_SIZES, RANGE_PRESETS, type PlannerChart } from '../../client/src/lib/grid-planner-view';
import { PlannerPriceRefresh, watchPlannerPrice, PRICE_BUSY_MESSAGE } from '../../client/src/lib/planner-price-refresh';
import { previewGrid } from '../../server/grid-planner/preview';
import { marketSnapshot } from '../../server/grid-planner/market-snapshot';
import { observePacificaConstraints } from '../../server/protocol/market-constraints';
import type { ProtocolMarket } from '../../server/protocol/protocol-types';
const now = 1_800_000_000_000;
const market = marketSnapshot({ internalSymbol: 'BTC-PERP', protocolSymbol: 'BTC', fullName: 'Bitcoin', maxLeverage: 50, maxLeverageSource: 'venue',
  constraintObservation: observePacificaConstraints({ tick_size: '0.1', lot_size: '0.01', min_order_size: '10' }, 'BTC-PERP', now) } as ProtocolMarket,
  { now: () => now, cachedReference: () => ({ price: 100, observedAt: now }), getMarkets: async () => [], candles: async () => [] });
const preview = previewGrid({ market: 'BTC-PERP', side: 'long', lower: '80', upper: '120', intervals: 4, entryScale: 'flat', profitScale: 'flat', seed: true,
  leverage: '1', investment: '1000', stop: '70', fee: '0' }, market, now);
afterEach(() => vi.useRealTimers());
describe('Grid screenshot panel polish', () => {
  it('uses the exchange price step instead of padded engine precision and retains tiny-price precision', () => {
    expect(plannerPriceFormat('0.10000000', ['100.000000000000000000', '110.000000000000000000'])).toEqual({ precision: 1, minMove: 0.1 });
    expect(plannerPriceFormat('0.25', ['100.000000000000000000'])).toEqual({ precision: 2, minMove: 0.25 });
    expect(plannerPriceFormat(null, ['100.000000000000000000', '101.250000000000000000'])).toEqual({ precision: 2, minMove: 0.01 });
    expect(plannerPriceFormat('0.00000001', ['0.00000123'])).toEqual({ precision: 8, minMove: 0.00000001 });
    expect(plannerPriceFormat(null, ['0.000000000000000001'])).toEqual({ precision: 18, minMove: 1e-18 });
    expect(plannerPriceFormat('EXAMPLE', ['EXAMPLE', 100])).toEqual({ precision: 0, minMove: 1 });
    expect(readableDecimal('100.000000000000000000')).toBe('100');
    expect(readableDecimal('0.000001230000')).toBe('0.00000123');
  });
  it('merges equal minimum investments but preserves different and unavailable fee checks', () => {
    const base = { ...preview, minimum: { state: 'available' as const, value: '10' }, assumedMinimum: { state: 'available' as const, value: '10.00' } };
    expect(plannerMinimumRows(base)).toEqual([{ label: 'Minimum investment · includes your fee assumption', value: '10 USDC' }]);
    expect(plannerMinimumRows({ ...base, assumedMinimum: { state: 'available', value: '11' } })).toHaveLength(2);
    expect(plannerMinimumRows({ ...base, assumedMinimum: { state: 'unavailable', reason: 'EXAMPLE missing fee data' } })[1].value).toContain('EXAMPLE missing fee data');
    expect(plannerMinimumRows({ ...base, fee: { state: 'unknown' } })).toEqual([{ label: 'Minimum investment', value: '10 USDC' }]);
    expect(plannerMinimumRows(null)).toEqual([{ label: 'Minimum investment', value: 'Awaiting preview' }]);
  });
  it('shows real rejection causes and settings links, keeping original details reachable', () => {
    const reasons = ['Stop must align to the venue tick', 'Investment is below the minimum capital', 'Fee assumption must be nonnegative plain decimal'];
    const html = renderToStaticMarkup(createElement(GridPlanIssues, { reasons, onReview: vi.fn() }));
    expect(html).toContain('This plan can&#x27;t run yet:');
    for (const reason of reasons) expect(html).toContain(reason);
    for (const setting of ['Stop loss', 'Investment', 'Fees &amp; data', 'Source details']) expect(html).toContain(setting);
    expect(plannerIssue(reasons[0])).toMatchObject({ field: 'grid-stop', panel: 'stop' });
    expect(plannerIssue(reasons[1])).toMatchObject({ field: 'grid-investment', panel: 'direction-size' });
    expect(plannerIssue(reasons[2]).message).toBe(reasons[2]);
    expect(plannerIssue('Leverage exceeds the observed Pacifica maximum')).toMatchObject({ field: 'grid-leverage' });
    expect(renderToStaticMarkup(createElement(GridPlanIssues, { reasons: [] }))).toBe('');
    const sheet = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
    const plan = sheet.slice(sheet.indexOf('<h3 id="grid-plan-heading"'));
    expect(plan.indexOf('<GridPlanIssues')).toBeLessThan(plan.indexOf('<dl'));
    expect(sheet).toContain('10 grids make 11 price lines.');
    expect(sheet).toContain('Choose a market to see its price');
    expect(sheet).toContain('{form.market || undefined}</SelectValue>');
  });
  it('shows a readable bot overview while retaining settlement, capacity and ledger details', () => {
    const surface = gridSurface({ bot: { id: 'EXAMPLE', name: 'Grid', market: 'BTC-PERP', direction: 'long', status: 'stopped', lowerPrice: '90', upperPrice: '110', gridCount: 10, updatedAt: new Date(now) }, levels: [], operations: [] }, null, null, { pending: 0, uncertain: 0 }, now);
    const overview = renderToStaticMarkup(createElement(GridBotOverview, { surface, now }));
    for (const text of ['Total P&amp;L', 'Price unavailable', '10 grids', 'Range', 'Stop', 'Position', 'Not loaded yet.']) expect(overview).toContain(text);
    expect(overview).not.toContain('UNKNOWN'); expect(overview).not.toContain('Capacity and launch authorities');
    surface.sweep = 'Confirmed terminal';
    const details = renderToStaticMarkup(createElement(GridBotDetails, { surface, now }));
    for (const text of ['<details', 'Settlement complete', 'Mark price', 'USDC left', 'Last updated', 'No pending action', 'Capacity and launch authorities', 'Resume LaunchFacts provider: unavailable', 'Grid levels']) expect(details).toContain(text);
    expect(details).not.toContain('No pending action ·');
    expect(surface.sweep).toBe('Confirmed terminal');
    surface.observedAt = new Date(now - 15_001).toISOString(); surface.pnl.total = '123';
    const stale = renderToStaticMarkup(createElement(GridBotOverview, { surface, now }));
    expect(stale).not.toContain('123'); expect(stale).toContain('out of date');
  });
});
describe('Market range ownership and time windows', () => {
  it.each([['manual', null, 'manual'], ['manual', 10, 'percent'], ['auto', null, 'auto']] as const)
    ('clears every old-market price before resolving a %s range', (source, percent, mode) => {
      const old = { ...gridSetupForm(), market: 'BTC-PERP', lower: '80', upper: '120', stop: '70' };
      const next = gridMarketChange(old, 'ETH-PERP', source, percent);
      expect(next.form).toMatchObject({ market: 'ETH-PERP', lower: '', upper: '', stop: '' });
      expect(next.mode).toBe(mode); expect(next.note).toBe('Enter a range for ETH-PERP');
      expect(plannerChartRange(next.form.lower, next.form.upper, next.form.stop)).toBeNull();
      expect(gridMarketChange(next.form, '', source, percent).note).toBe('');
    });
  it.each([
    ['15m', 'day', 96, 144], ['15m', 'week', 672, 1008], ['15m', 'month', 2880, 4320],
    ['1h', 'day', 24, 100], ['1h', 'week', 168, 252], ['1h', 'month', 720, 1080],
    ['4h', 'day', 6, 100], ['4h', 'week', 42, 100], ['4h', 'month', 180, 270],
  ])('maps %s last %s to a range and context without shrinking the period', (timeframe, period, rangeBars, chartBars) => {
    expect(gridHistoryWindow(String(timeframe), String(period))).toMatchObject({ rangeBars, chartBars });
  });
  it('defaults to last week and rejects unbounded or mixed requests while retaining legacy draft metadata', () => {
    expect(gridSetupForm().rangeWindow).toBe('week');
    expect(gridHistoryRequest('1h', undefined, '200')).toMatchObject({ rangeBars: 200, chartBars: 200 });
    for (const args of [['2h', 'week', undefined], ['1h', 'year', undefined], ['1h', 'week', '100'], ['1h', undefined, '4321']])
      expect(gridHistoryRequest(...args as [string, string | undefined, string | undefined])).toBeNull();
    const form = { ...gridSetupForm(), lower: '80', upper: '120' };
    expect(gridSetupIntent(form, '70', 'auto').rangeSource).toBe('auto');
    expect(gridSetupIntent(form, '70', 'auto', true)).toMatchObject({ rangeSource: 'manual', lowerPrice: '80', upperPrice: '120', lookback: 100 });
  });
  it('disposes an old-market pending shortcut before accepting a fresh new-market price', async () => {
    let resolveOld!: (v: unknown) => void;
    const changed = vi.fn(), observedOld = vi.fn();
    const old = new PlannerPriceRefresh('BTC-PERP', () => new Promise(r => { resolveOld = r; }), observedOld, vi.fn(), () => now);
    const pending = old.apply(10, changed); await Promise.resolve(); old.dispose();
    const freshMarket = { ...market, market: 'ETH-PERP', reference: { state: 'available' as const, value: { price: '200', observedAt: now, expiresAt: now + 60_000, label: 'Cached Pacifica book reference price' as const } } };
    const fresh = new PlannerPriceRefresh('ETH-PERP', async () => ({ state: 'available', retrievedAt: now, markets: [freshMarket] }), vi.fn(), vi.fn(), () => now);
    expect(await fresh.apply(10, changed)).toBe(true);
    resolveOld({ state: 'available', retrievedAt: now, markets: [market] });
    expect(await pending).toBe(false); expect(observedOld).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledWith({ lower: '180', upper: '220' }); fresh.dispose();
  });
});
const priceResponse = (price: string, observedAt = now, retrievedAt = observedAt) => ({ state: 'available', retrievedAt,
  markets: [{ ...market, reference: { state: 'available', value: { price, observedAt, expiresAt: observedAt + 60_000, label: 'Cached Pacifica book reference price' } } }] });
describe('Planner fresh-price shortcuts and visibility', () => {
  it('labels all preset distances and leaves expiry alone recoverable by clicking', () => {
    expect(RANGE_PRESETS.map(p => p.label)).toEqual(['Tight ±5%', 'Balanced ±10%', 'Wide ±20%']);
    expect(plannerShortcutReason('BTC-PERP', false, '', false)).toBe('');
    expect(plannerShortcutReason('BTC-PERP', false, 'EXAMPLE quota exhausted', false)).toContain('EXAMPLE quota exhausted');
    expect(plannerShortcutReason('BTC-PERP', false, 'EXAMPLE', true)).toBe('');
    expect(plannerShortcutReason('BTC-PERP', true, 'EXAMPLE', false)).toBe('');
    expect(plannerShortcutReason('', false, '', false)).toContain('Choose a market');
  });
  it('uses a fresh observation immediately and fetches before applying an expired preset', async () => {
    let time = now;
    const read = vi.fn(async () => priceResponse(time === now ? '100' : '200', time));
    const changed = vi.fn(), status = vi.fn();
    const controller = new PlannerPriceRefresh('BTC-PERP', read, vi.fn(), status, () => time);
    await controller.refresh();
    expect(await controller.apply(5, changed)).toBe(true); expect(changed).toHaveBeenLastCalledWith({ lower: '95', upper: '105' });
    expect(read).toHaveBeenCalledTimes(1);
    time += 60_001;
    expect(await controller.apply(20, changed)).toBe(true); expect(changed).toHaveBeenLastCalledWith({ lower: '160', upper: '240' });
    expect(read).toHaveBeenCalledTimes(2); expect(status).toHaveBeenLastCalledWith(false, '');
    controller.dispose();
  });
  it('coalesces an expired slider drag and applies only its latest requested width', async () => {
    let resolve!: (value: unknown) => void;
    const read = vi.fn(() => new Promise<unknown>(r => { resolve = r; })), changed = vi.fn();
    const controller = new PlannerPriceRefresh('BTC-PERP', read, vi.fn(), vi.fn(), () => now);
    const first = controller.apply(5, changed), last = controller.apply(20, changed);
    await Promise.resolve(); resolve(priceResponse('200'));
    expect(await first).toBe(false); expect(await last).toBe(true);
    expect(read).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledExactlyOnceWith({ lower: '160', upper: '240' });
    controller.dispose();
  });
  it.each(['cancelShortcut', 'pause', 'dispose'] as const)('a late price cannot apply a shortcut after %s', async action => {
    let resolve!: (value: unknown) => void;
    const changed = vi.fn(), observed = vi.fn();
    const controller = new PlannerPriceRefresh('BTC-PERP', () => new Promise<unknown>(r => { resolve = r; }), observed, vi.fn(), () => now);
    const pending = controller.apply(10, changed);
    await Promise.resolve(); controller[action](); resolve(priceResponse('200'));
    expect(await pending).toBe(false); expect(changed).not.toHaveBeenCalled();
    if (action !== 'cancelShortcut') expect(observed).not.toHaveBeenCalled();
    controller.dispose();
  });
  it('failed refresh keeps the original expiry and input range untouched, then recovers', async () => {
    let time = now;
    const read = vi.fn(async () => priceResponse('100', time)), observed = vi.fn(), status = vi.fn(), changed = vi.fn();
    const controller = new PlannerPriceRefresh('BTC-PERP', read, observed, status, () => time);
    await controller.refresh(); time += 60_001;
    read.mockRejectedValueOnce(Error('EXAMPLE venue unavailable'));
    expect(await controller.apply(10, changed)).toBe(false);
    expect(changed).not.toHaveBeenCalled(); expect(observed).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenLastCalledWith(false, 'EXAMPLE venue unavailable');
    expect(await controller.apply(10, changed)).toBe(true); controller.dispose();
  });
  it('backs off quota refusals without reusing an expired price, then automatically recovers', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const visibility = Object.assign(new EventTarget(), { hidden: false });
    const read = vi.fn(async () => priceResponse('100', Date.now())), observed = vi.fn(), status = vi.fn(), changed = vi.fn();
    const controller = new PlannerPriceRefresh('BTC-PERP', read, observed, status);
    const stop = watchPlannerPrice(controller, visibility);
    await vi.advanceTimersByTimeAsync(0);
    read.mockRejectedValue(Error(PRICE_BUSY_MESSAGE));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(status).toHaveBeenLastCalledWith(false, PRICE_BUSY_MESSAGE);
    expect(controller.retryDelay()).toBe(5_000);
    await controller.refresh(); expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000); expect(controller.retryDelay()).toBe(10_000);
    await vi.advanceTimersByTimeAsync(10_000); expect(controller.retryDelay()).toBe(20_000);
    await vi.advanceTimersByTimeAsync(20_000); expect(controller.retryDelay()).toBe(40_000);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await controller.apply(10, changed)).toBe(false); expect(changed).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledTimes(1);
    read.mockImplementation(async () => priceResponse('200', Date.now()));
    await vi.advanceTimersByTimeAsync(34_999);
    expect(observed).toHaveBeenCalledTimes(2); expect(status).toHaveBeenLastCalledWith(false, '');
    expect(await controller.apply(10, changed)).toBe(true); stop();
  });
  it.each([priceResponse('100', now - 60_000, now), priceResponse('100', now + 1, now),
    { state: 'available', retrievedAt: now, markets: [] },
    { state: 'available', retrievedAt: now, markets: [{ ...market, reference: { state: 'unavailable', reason: 'EXAMPLE no observation' } }] },
    { state: 'available', retrievedAt: now, markets: [{ ...market, reference: { state: 'available', value: { price: '100', observedAt: now, expiresAt: now + 120_000 } } }] },
  ])('never applies an unavailable, expired, future or fabricated price', async response => {
    const changed = vi.fn(), status = vi.fn();
    const controller = new PlannerPriceRefresh('BTC-PERP', async () => response, vi.fn(), status, () => now);
    expect(await controller.apply(10, changed)).toBe(false); expect(changed).not.toHaveBeenCalled();
    expect(status.mock.calls.at(-1)?.[1]).toBeTruthy(); controller.dispose();
  });
  it('subtracts transit time even with client/server clock skew', async () => {
    let time = now, resolve!: (value: unknown) => void;
    const changed = vi.fn();
    const controller = new PlannerPriceRefresh('BTC-PERP', () => new Promise<unknown>(r => { resolve = r; }), vi.fn(), vi.fn(), () => time);
    const pending = controller.apply(10, changed);
    await Promise.resolve(); time += 60_000; resolve(priceResponse('100', now + 100_000));
    expect(await pending).toBe(false); expect(changed).not.toHaveBeenCalled(); controller.dispose();
  });
  it('refreshes every 20 seconds while visible, pauses hidden reads, wakes immediately and stops on close', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const visibility = Object.assign(new EventTarget(), { hidden: false });
    const read = vi.fn(async () => priceResponse('100', Date.now()));
    const controller = new PlannerPriceRefresh('BTC-PERP', read, vi.fn(), vi.fn());
    const stop = watchPlannerPrice(controller, visibility);
    await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(40_000); expect(read).toHaveBeenCalledTimes(3);
    visibility.hidden = true; visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000); expect(read).toHaveBeenCalledTimes(3);
    visibility.hidden = false; visibility.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(4);
    stop(); await vi.advanceTimersByTimeAsync(60_000); expect(read).toHaveBeenCalledTimes(4);
    visibility.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); expect(read).toHaveBeenCalledTimes(4);
  });
});
describe('Planner client authority boundaries', () => {
  it('uses the owner-approved sizing hints verbatim for both directions', () => {
    expect(ORDER_SIZES).toEqual([
      { value: 'flat', label: 'Equal' }, { value: 'ascending', label: 'Larger further from entry price' }, { value: 'descending', label: 'Larger near entry price' },
    ]);
    for (const side of ['long', 'short']) {
      expect(plannerSizeHint(side, 'flat')).toBe('Every grid order is the same size.');
      expect(plannerSizeHint(side, 'ascending')).toBe('Orders get bigger the further price moves from the entry price.');
      expect(plannerSizeHint(side, 'descending')).toBe('Orders are biggest close to the entry price.');
      expect(plannerSizeHint(side, 'flat', true)).toBe('Your starting position is closed in equal pieces at each level.');
      expect(plannerSizeHint(side, 'ascending', true)).toBe('Bigger pieces are closed the further price moves in your favour.');
      expect(plannerSizeHint(side, 'descending', true)).toBe('Bigger pieces are closed at the levels nearest the entry price.');
    }
  });
  it('starting-position sizing is disabled with a reason until enabled, then explains the selected direction', () => {
    const props = { id: 'grid-profitScale', label: 'Take-profit sizes', value: 'ascending', side: 'short', startingPosition: true, onChange: () => {} };
    const disabled = renderToStaticMarkup(createElement(GridPlannerSizeSelect, { ...props, enabled: false }));
    expect(disabled).toContain('Take-profit sizes');
    expect(disabled).toContain('disabled=""'); expect(disabled).toContain('Only used when &quot;Start with a position&quot; is on.');
    expect(disabled).toContain('aria-describedby="grid-profitScale-hint"');
    expect(disabled).toContain('Entry price = the price when your bot starts');
    const enabled = renderToStaticMarkup(createElement(GridPlannerSizeSelect, { ...props, enabled: true }));
    expect(enabled).not.toContain('disabled=""'); expect(enabled).toContain('Bigger pieces are closed the further price moves in your favour.');
    expect(enabled).toContain('Entry price = the price when your bot starts');
  });
  it('blank, explicit zero and decimal percentages preserve meaning without floats', () => {
    expect(feePercentToRate('')).toBeNull(); expect(feePercentToRate('0')).toBe('0'); expect(feePercentToRate('0.05')).toBe('0.0005');
    expect(feePercentToRate('1.2345678901234567')).toBe('0.012345678901234567');
    for (const value of ['-1', '1e-3', ' 0', '0.00000000000000001', 'EXAMPLE']) expect(() => feePercentToRate(value)).toThrow();
    expect(PLANNING_BANNER).toBe('Planning only — no orders are placed'); expect(ASSUMPTION_LABEL).toBe('Your assumption — not a venue quote');
  });
  it('A-B-A and same-query refresh never accept a superseded response, even if abort is ignored', async () => {
    const generation = new PlannerRequestGeneration(), updates: string[] = [];
    const oldA = generation.start(), b = generation.start(), newA = generation.start();
    await Promise.resolve(); for (const [token, value] of [[oldA, 'old A'], [b, 'B'], [newA, 'new A']] as const) if (token.current()) updates.push(value);
    expect(updates).toEqual(['new A']); expect(oldA.signal.aborted).toBe(true); expect(b.signal.aborted).toBe(true);
    const refresh = generation.start(); expect(newA.current()).toBe(false); generation.invalidate(); expect(refresh.current()).toBe(false);
  });
  it('close/unmount/identity invalidation clears all resource ownership; unrelated resources are independent', () => {
    const resources = [new PlannerRequestGeneration(), new PlannerRequestGeneration(), new PlannerRequestGeneration()];
    const tokens = resources.map(r => r.start()); resources[2].invalidate(); expect(tokens[0].current()).toBe(true);
    resources.forEach(r => r.invalidate()); expect(tokens.every(t => !t.current() && t.signal.aborted)).toBe(true);
  });
  it('strict runtime guards accept real API objects and refuse mismatched provenance or malformed rows', () => {
    expect(isPlannerMarket(market)).toBe(true); expect(isPlannerPreview(preview)).toBe(true);
    expect(isPlannerPreview({ ...preview, requestedPlan: { ...preview.requestedPlan, lines: [{ price: 'EXAMPLE' }] } })).toBe(false);
    expect(isPlannerPreview({ ...preview, fee: { state: 'assumption', rate: '0', label: 'Venue fee' } })).toBe(false);
    expect(isPlannerMarket({ ...market, reference: { state: 'available', value: { price: '0', observedAt: now, expiresAt: now + 60000 } } })).toBe(false);
    expect(isPlannerChart({ state: 'available', candles: [] })).toBe(false);
  });
  it('draws current server-calculated geometry, including diagnostic plans, and clears expired or absent geometry', () => {
    expect(plannerOverlays(preview, now + 60000, now)).toHaveLength(5);
    expect(plannerOverlays(preview, now + 60000, now + 60000)).toEqual([]);
    expect(plannerOverlays({ ...preview, state: 'rejected' }, now + 60000, now)).toHaveLength(5);
    expect(plannerOverlays({ ...preview, requestedPlan: null, minimumPlan: preview.requestedPlan }, now + 60000, now)).toHaveLength(5);
    expect(plannerOverlays({ ...preview, state: 'rejected', requestedPlan: null, minimumPlan: null }, now + 60000, now)).toEqual([]);
    expect(plannerOverlays({ ...preview, state: 'unavailable' }, now + 60000, now)).toEqual([]);
    expect(plannerOverlays(null, now + 60000, now)).toEqual([]);
  });
  it('explains missing inputs, request errors, loading, expired observations and diagnostic level authority', () => {
    const inputs = { market: 'BTC-PERP', lower: '80', upper: '120', investment: '1000', stop: '70' };
    const message = (p: typeof preview | null, overrides = {}, loading = false, error = '') =>
      plannerLevelMessage(p, now + 60000, now, { ...inputs, ...overrides }, loading, error);
    expect(message(null, { market: '' })).toContain('Choose a market');
    expect(message(null, { lower: '', upper: '', investment: '', stop: '' })).toContain('a lower price, an upper price, an investment amount, a stop price');
    expect(message(null, {}, true)).toContain('Calculating grid levels');
    expect(message(null, {}, false, 'Enter a valid fee percentage')).toContain('Enter a valid fee percentage');
    expect(message(null)).toContain('Waiting for a grid preview');
    expect(message({ ...preview, state: 'unavailable', validForMs: 0, requestedPlan: null, reasons: ['A fresh price is unavailable'] })).toContain('A fresh price is unavailable');
    expect(plannerLevelMessage(preview, now, now, inputs, false, '')).toContain('Grid levels have expired');
    expect(message(preview)).toContain('at your investment');
    expect(message(preview)).toContain('Some checks are unavailable');
    expect(message({ ...preview, state: 'rejected', requestedPlan: null, minimumPlan: preview.requestedPlan, reasons: ['Investment is too low'] })).toContain('at the minimum investment, not your entered investment');
    expect(message({ ...preview, state: 'rejected', reasons: ['Assumed fee check failed'] })).toContain('Checks did not pass; see Your plan.');
  });
  it('observation deadlines subtract transit and do not depend on client/server wall-clock agreement', () => {
    expect(clientObservationDeadline(now + 60_000, now, 1000)).toBe(61_000);
    expect(clientObservationDeadline(now - 1, now, 1000)).toBe(1000);
  });
  it('range shortcuts use an observed price and recheck expiry at click time', () => {
    const deadline = now + 60_000;
    expect(plannerRangeAround(market, deadline, now, 5)).toEqual({ lower: '95', upper: '105' });
    expect(plannerRangeAround(market, deadline, now, 10)).toEqual({ lower: '90', upper: '110' });
    expect(plannerRangeAround(market, deadline, now, 20)).toEqual({ lower: '80', upper: '120' });
    expect(plannerRangeAround(market, deadline, deadline, 10)).toBeNull();
    expect(plannerRangeAround(undefined, deadline, now, 10)).toBeNull();
    expect(plannerRangeAround({ ...market, reference: { state: 'unavailable', reason: 'EXAMPLE' } }, deadline, now, 10)).toBeNull();
    for (const width of [0, 41, NaN, Infinity]) expect(plannerRangeAround(market, deadline, now, width)).toBeNull();
    const small = { ...market, reference: { ...market.reference, state: 'available' as const,
      value: { price: '0.00000123', observedAt: now, expiresAt: deadline, label: 'Cached Pacifica book reference price' as const } } };
    expect(plannerRangeAround(small, deadline, now, 5)).toEqual({ lower: '0.0000011685', upper: '0.0000012915' });
  });
  it('proposed stops round outwards to the tick; manual invalid inputs never become chart prices', () => {
    expect(proposedPlannerStop('95', '105', 'long', '0.1')).toBe('92.1');
    expect(proposedPlannerStop('95', '105', 'short', '0.1')).toBe('108.2');
    expect(proposedPlannerStop('0.000001', '0.000002', 'long', '0.00000001')).toBe('0.00000097');
    expect(proposedPlannerStop('0.01', '0.02', 'long', '1')).toBeNull();
    for (const lower of ['', '0', '-1', '1e-3', 'EXAMPLE', '105']) {
      expect(proposedPlannerStop(lower, '105', 'long', '0.1')).toBeNull();
      expect(plannerChartRange(lower, '105', '90')).toBeNull();
    }
    expect(plannerChartRange('95', '105', 'EXAMPLE')).toEqual({ lower: '95', upper: '105', stop: null });
    expect(plannerChartRange('95', '105', '92.1')).toEqual({ lower: '95', upper: '105', stop: '92.1' });
  });
  it('chart captions preserve provenance, partial coverage, expiry and unavailable explanations', () => {
    const chart: PlannerChart = { state: 'available', market: 'BTC-PERP', timeframe: '15m', requestedBars: 100, actualBars: 1,
      partial: true, retrievedAt: now, cacheInsertedAt: now, validForMs: 60_000,
      candles: [{ time: now - 900_000, open: 100, high: 101, low: 99, close: 100, volume: 1,
        provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', timeSemantic: 'open_time', finality: 'forming' } }] };
    expect(isPlannerChart(chart)).toBe(true);
    const pacifica = { ...chart, candles: chart.candles.map(c => ({ ...c, provenance: { ...c.provenance, source: 'pacifica', venue: 'pacifica' } })) };
    expect(isPlannerChart(pacifica)).toBe(true);
    for (const change of [{ venue: 'okx' }, { basis: 'spot' }, { proxy: 'proxy' }])
      expect(isPlannerChart({ ...pacifica, candles: pacifica.candles.map(c => ({ ...c, provenance: { ...c.provenance, ...change } })) })).toBe(false);
    expect(isPlannerChart({ ...chart, candles: [...chart.candles, { ...pacifica.candles[0], time: now }] })).toBe(false);
    const nativeHtml = renderToStaticMarkup(createElement(GridPlannerChart, { chart: pacifica as PlannerChart, lines: [], range: null, stale: false }));
    expect(nativeHtml).toContain('PACIFICA direct perpetual candles');
    expect(nativeHtml).toContain('PACIFICA trade candle prices');
    const html = renderToStaticMarkup(createElement(GridPlannerChart, { chart, lines: [], range: null, stale: false }));
    expect(html).toContain('How this preview works');
    expect(html.match(/No orders are placed/g)).toHaveLength(1);
    expect(html).toContain('Fees are estimates. We can&#x27;t confirm this stop avoids liquidation.');
    for (const text of ['OKX direct perpetual candles', '15m', '1/100 bars', 'partial coverage', 'opening times', 'forming candles', 'separate from the Pacifica', 'Expand Planner chart']) expect(html).toContain(text);
    const expired = renderToStaticMarkup(createElement(GridPlannerChart, { chart, lines: [], range: null, stale: true }));
    expect(expired).toContain('Chart cache expired');
    const unavailable = renderToStaticMarkup(createElement(GridPlannerChart, { chart: { state: 'unavailable', reason: 'EXAMPLE' }, hasMarket: true, onRetry: () => {}, lines: [], range: null, stale: false }));
    expect(unavailable).toContain('Candles are temporarily unavailable from the price source. Try again shortly.');
    expect(unavailable).toContain('role="alert"'); expect(unavailable).toContain('EXAMPLE'); expect(unavailable).toContain('Retry chart');
    expect(unavailable).not.toContain('Choose a market');
    const failure = renderToStaticMarkup(createElement(GridPlannerChart, { chart: null, hasMarket: true, error: 'EXAMPLE source failure', onRetry: () => {}, lines: [], range: null, stale: false }));
    expect(failure).toContain('EXAMPLE source failure'); expect(failure).toContain('Retry chart'); expect(failure).not.toContain('Choose a market');
    const unselected = renderToStaticMarkup(createElement(GridPlannerChart, { chart: null, hasMarket: false, lines: [], range: null, stale: false }));
    expect(unselected).toContain('Choose a market to load candles.'); expect(unselected).not.toContain('Retry chart');
  });
  it('uses one setup across independent planning, draft and live gates', () => {
    for (const planner of [false, true]) for (const drafts of [false, true]) for (const start of [false, true]) for (const worker of [false, true]) {
      expect(gridSetupAccess(planner, drafts, start, worker)).toEqual({ setup: planner || drafts, drafts, live: drafts && start && worker });
    }
    const app = readFileSync('client/src/pages/App.tsx', 'utf8');
    expect(app.match(/<GridDraftCard\b/g)).toHaveLength(1); expect(app).not.toContain('GridPlannerCard');
    const card = readFileSync('client/src/components/grid-bot/GridDraftCard.tsx', 'utf8');
    expect(card.match(/<GridPlannerSheet\b/g)).toHaveLength(1); expect(card).not.toContain('GridCreateSheet');
    expect(readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8')).toContain('rangeBusy={autoApplying}');
    expect(card).toContain('initialIntent={create.intent}'); expect(card).toContain('createEnabled={enabled}');
    for (const props of [{ authenticated: false, identity: null }, { authenticated: true, identity: 'EXAMPLE' }]) {
      const live = renderToStaticMarkup(createElement(GridDraftCard, props));
      expect(live).toContain('card-grid-bot-coming-soon'); expect(live).toContain('Coming soon'); expect(live).not.toContain('Start bot');
    }
    expect(readableDecimal('123456.000001')).toBe('123,456.000001');
  });
  it('retains every Adjust Range intent field through the unified form, including inactive profit sizing', () => {
    const form = { ...gridSetupForm(), market: 'ETH-PERP', side: 'short', lower: '90', upper: '110', stop: '115', intervals: '17',
      timeframe: '4h', bars: '200', investment: '234.56', leverage: '3', seed: false, entryScale: 'ascending', profitScale: 'descending' };
    const intent = gridSetupIntent(form, form.stop, 'auto');
    expect(gridSetupForm(intent)).toEqual(form); expect(intent.rangeSource).toBe('auto');
    expect(intent.seedAtCreation).toBe(false); expect(intent.profitScaleType).toBe('descending');
    expect(gridSetupIntent(form, '120', 'manual').stopPrice).toBe('120');
  });
  it('keeps an explicit timeframe ADX advisory and trending caution separate from direction inputs', () => {
    const regime = { state: 'available' as const, market: 'BTC-PERP', timeframe: '1h', adx: 30, label: 'trending' as const,
      venue: 'okx' as const, bars: 100, latestFinalizedTime: now };
    expect(isGridRegime(regime, 'BTC-PERP', '1h')).toBe(true);
    for (const bad of [{ ...regime, label: 'ranging' }, { ...regime, bars: 27 }, { ...regime, adx: NaN }, { ...regime, timeframe: '4h' }])
      expect(isGridRegime(bad, 'BTC-PERP', '1h')).toBe(false);
    const html = renderToStaticMarkup(createElement(GridRegimeHint, { timeframe: '1h', regime }));
    expect(html).toContain('ADX(14)'); expect(html).toContain('1h'); expect(html.toLowerCase()).toContain('trending');
    expect(html).toContain('Caution'); expect(html).not.toMatch(/<input|<select|disabled/);
    const unknown = renderToStaticMarkup(createElement(GridRegimeHint, { timeframe: '4h', regime: { state: 'unavailable', reason: 'EXAMPLE' } }));
    expect(unknown).toContain('—'); expect(unknown).toContain('Not loaded yet. EXAMPLE</p>'); expect(unknown).toContain('role="status"'); expect(unknown).toContain('4h');
  });
  it('shows the short-history ADX reason as visible text on touch screens', () => {
    const html = renderToStaticMarkup(createElement(GridRegimeHint, { timeframe: '1h', regime: { state: 'unavailable', reason: 'ADX needs 28 bars' } }));
    expect(html).toContain('—'); expect(html).toContain('Not loaded yet. ADX needs 28 bars</p>');
    expect(html).not.toMatch(/<input|<select|disabled/);
  });
  it('groups all normal and detailed settings without hiding the chart, plan or actions', () => {
    const sheet = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
    const body = sheet.slice(sheet.indexOf('  const renderSetup ='));
    expect(sheet).toContain("useState<string | null>('direction-size')");
    expect(sheet).toContain("setExpandedSettingsPanel('direction-size')");
    for (const title of ['Range', 'Order', 'Stop loss', 'Sizing', 'Fees & data'])
      expect(sheet).toContain(`title="${title}"`);
    expect(sheet.match(/<DrawerSettingsPanel\b/g)).toHaveLength(5);
    expect(sheet.match(/icon=\{\w+\} keepMounted/g)).toHaveLength(5);
    expect(sheet).not.toContain('<Collapsible'); expect(sheet).not.toContain('Advanced settings');
    expect(body.indexOf('<GridPlannerChart')).toBeLessThan(body.indexOf('<DrawerSettingsPanel'));
    expect(body).toContain('aria-labelledby="grid-plan-heading"');
    expect(body).toContain('<section aria-labelledby="grid-range-heading"');
    expect(body).toContain('<h3 id="grid-range-heading"');
    expect(body.slice(body.indexOf('        </fieldset>'))).toContain('{details ?? feesPanel()}');
    expect(body).toContain('createEnabled ? <GridDraftActions');
    expect(body).toContain(': renderSetup()');
    expect(sheet).toContain('const feesPanel = (draftDetails?: React.ReactNode) => <fieldset disabled={draftBusy}>');
  });
  it('puts grid count with direction, investment and leverage and keeps every editable field', () => {
    const sheet = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
    const panel = (id: string) => sheet.slice(sheet.indexOf(`<DrawerSettingsPanel id="${id}"`)).split('</DrawerSettingsPanel>')[0];
    const direction = panel('direction-size');
    for (const control of ['<GridDirectionSignals', "edit('side'", "numberField('investment'", 'id="grid-leverage"', "numberField('intervals', 'Number of grids (1–100)'"])
      expect(direction).toContain(control);
    for (const field of ['lower', 'upper', 'investment', 'intervals', 'stop', 'feePercent'])
      expect(sheet.match(new RegExp(`numberField\\('${field}'`, 'g'))).toHaveLength(1);
    expect(panel('range')).toContain('<GridRegimeHint'); expect(panel('range')).toContain('id="grid-width"');
    expect(panel('stop')).toContain("numberField('stop'"); expect(panel('stop')).toContain('Suggested stop:');
    const stopHint = 'A blank custom stop uses the suggested price.';
    expect(sheet.split(stopHint)).toHaveLength(2); expect(panel('stop')).toContain(stopHint);
    for (const control of ['id="grid-seed"', 'id="grid-entryScale"', 'id="grid-profitScale"', 'startingPosition enabled={form.seed}'])
      expect(panel('orders')).toContain(control);
    expect(panel('range')).toContain('id="grid-period-label"');
    expect(panel('range')).toContain('Suggest auto-range');
    expect(panel('range')).toContain("'Day' : period === 'week' ? 'Week' : 'Month'");
    expect(panel('range')).toContain('Highs and lows from this period set the range; the candle size sets the safety buffer.');
    expect(panel('fees')).not.toContain("choice('rangeWindow'"); expect(panel('fees')).toContain('Observation and sizing details');
    expect(panel('fees')).toContain('testId="grid-advanced-toggle"');
    expect(sheet).toContain('grid grid-cols-1 sm:grid-cols-2');
  });
  it('folds draft funding and capacity details without changing the action owner or save guards', () => {
    const sheet = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
    const actions = readFileSync('client/src/components/grid-bot/GridDraftActions.tsx', 'utf8');
    expect(sheet).toContain('rangeBusy={autoApplying} onIssue={showIssue} renderDetails={feesPanel}');
    const details = actions.slice(actions.indexOf('  const details = <>'), actions.indexOf('  const status ='));
    for (const text of ['Draft sizing, observed fees and funds', 'Capacity before trading', 'Unknown capacity does not prevent saving a draft.'])
      expect(details).toContain(text);
    expect(details).not.toContain('<Button'); expect(details).not.toContain('role="status"');
    const visible = actions.slice(actions.indexOf('  const status ='));
    expect(visible).toContain('details: renderDetails ? renderDetails(details) : details');
    expect(visible).toContain('role="status"'); expect(visible).toContain('<DepositDialog');
    expect(actions).toContain("cash.shortfall!=='0.00'");
    expect(actions).toContain('session.current.beginCreate');
  });
  it('uses the create Dialog layout with fixed header and footer around the scrolling setup', () => {
    const setup = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
    const layout = setup.slice(setup.indexOf('  const renderSetup ='), setup.indexOf('  return <Dialog'));
    expect(setup).toContain("from '@/components/ui/dialog'");
    expect(setup).not.toContain("from '@/components/ui/sheet'");
    expect(setup).toContain('<Dialog open={open} onOpenChange={handleOpenChange}>');
    expect(layout).toContain('max-w-lg sm:max-w-[760px] max-h-[90dvh] flex flex-col');
    expect(layout).toContain('data-testid="sheet-grid-planner"');
    expect(layout).toContain('<DialogHeader>');
    expect(layout).toContain('<DialogTitle className="flex items-center gap-2 text-xl">');
    expect(layout).toContain('flex-1 min-h-0 overflow-y-auto space-y-3 sm:space-y-5 py-2 pr-1');
    expect(layout).toContain('pb-[max(2rem,env(safe-area-inset-bottom))]');
    const footer = layout.slice(layout.indexOf('<DialogFooter'), layout.indexOf('</DialogFooter>'));
    expect(footer).toContain('pt-2 border-t border-border/40');
    expect(footer).toContain('variant="outline" disabled={draftBusy} onClick={() => handleOpenChange(false)}>Cancel');
    expect(footer).toContain('{actions}');
    expect(footer).not.toContain('overflow-y-auto');
    expect(layout.indexOf('</DialogHeader>')).toBeLessThan(layout.indexOf('overflow-y-auto'));
    expect(layout.indexOf('{status}')).toBeLessThan(layout.indexOf('<DialogFooter'));
    expect(layout).toContain('{depositDialog}');
    expect(setup).toContain('renderDetails={feesPanel} renderLayout={renderSetup}');
    const close = setup.slice(setup.indexOf('  const handleOpenChange'), setup.indexOf('  const renderSetup'));
    expect(close).toContain('if (draftBusy) return;');
    expect(close).toContain('priceRefresh.current?.dispose()');
    expect(close).toContain('Object.values(generation.current).forEach(g => g.invalidate())');
    expect(close).toContain("setExpandedSettingsPanel('direction-size')");
    expect(close).toContain('onOpenChange(value)');
  });
  it('places the existing draft controls in a supplied footer while retaining details and status', () => {
    const props = { open: false, intent: gridSetupIntent(gridSetupForm(), '', 'manual'), onSaved: vi.fn(),
      onBusyChange: vi.fn(), liveEnabled: false, rangeBusy: false, onPreview: vi.fn() };
    const html = renderToStaticMarkup(createElement(GridDraftActions, { ...props,
      renderDetails: details => createElement('article', { 'data-testid': 'draft-details' }, details),
      renderLayout: ({ details, status, actions, depositDialog }) => createElement('main', null,
        details, status, createElement('footer', null, actions), depositDialog),
    }));
    expect(html).toContain('data-testid="draft-details"');
    expect(html).toContain('Draft sizing, observed fees and funds');
    expect(html).toContain('Capacity before trading');
    expect(html).toContain('role="status" aria-live="polite"');
    const footer = html.slice(html.indexOf('<footer>'), html.indexOf('</footer>'));
    expect(footer).toContain('Refresh preview and funds'); expect(footer).toContain('Save draft');
    expect(footer).toContain('bg-gradient-to-r from-primary to-accent');
    expect(footer.match(/disabled=""/g)).toHaveLength(1);
    expect(html.slice(0, html.indexOf('<footer>'))).not.toContain('<button');
    const live = renderToStaticMarkup(createElement(GridDraftActions, { ...props, liveEnabled: true }));
    expect(live).toContain('aria-label="Save Grid draft"'); expect(live).toContain('Create bot');
    expect(live).toContain('Refresh preview and funds');
  });
  it('keeps active management in its sheet and routes Adjust Range intent to the setup Dialog', () => {
    const drawer = readFileSync('client/src/components/grid-bot/GridBotDrawer.tsx', 'utf8');
    const card = readFileSync('client/src/components/grid-bot/GridDraftCard.tsx', 'utf8');
    expect(drawer).toContain('<Sheet open onOpenChange=');
    expect(drawer).toContain('Adjust Range');
    expect(drawer).toContain("onAdjust({...surface.bot.createIntent,rangeSource:'manual'})");
    expect(card).toContain('initialIntent={create.intent}');
    expect(card).toContain('onAdjust={intent=>{setSelected(null);setCreate({key:Date.now(),intent});}}');
  });
});

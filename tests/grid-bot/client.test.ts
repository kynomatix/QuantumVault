import { afterEach, describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GridPlannerCard } from '../../client/src/components/grid-planner/GridPlannerCard';
import { GridDraftCard } from '../../client/src/components/grid-bot/GridDraftCard';
import { GridPlannerChart } from '../../client/src/components/grid-planner/GridPlannerChart';
import { GridPlannerSizeSelect } from '../../client/src/components/grid-planner/GridPlannerSizeSelect';
import { feePercentToRate, PlannerRequestGeneration, plannerOverlays, isPlannerMarket, isPlannerChart, isPlannerPreview,
  PLANNING_BANNER, ASSUMPTION_LABEL, readableDecimal, clientObservationDeadline, plannerRangeAround,
  proposedPlannerStop, plannerChartRange, plannerSizeHint, plannerShortcutReason, ORDER_SIZES, RANGE_PRESETS, type PlannerChart } from '../../client/src/lib/grid-planner-view';
import { PlannerPriceRefresh, watchPlannerPrice } from '../../client/src/lib/planner-price-refresh';
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
  it('size labels describe distance and quote allocation for both sides and both order roles', () => {
    expect(ORDER_SIZES).toEqual([
      { value: 'flat', label: 'Equal' }, { value: 'ascending', label: 'Larger further from entry price' }, { value: 'descending', label: 'Larger near entry price' },
    ]);
    for (const side of ['long', 'short']) for (const seed of [false, true]) {
      const move = side === 'long' ? (seed ? 'rises' : 'falls') : (seed ? 'falls' : 'rises');
      const near = side === 'long' ? (seed ? 'above' : 'below') : (seed ? 'below' : 'above');
      expect(plannerSizeHint(side, 'ascending', seed)).toContain(`price ${move} further`);
      expect(plannerSizeHint(side, 'descending', seed)).toContain(`just ${near} the entry price`);
      expect(plannerSizeHint(side, 'flat', seed)).toContain('Equal quote value');
      expect(plannerSizeHint(side, 'flat', seed)).toContain('base quantities vary');
    }
    expect(plannerSizeHint('long', 'ascending')).toContain('bought');
    expect(plannerSizeHint('short', 'ascending')).toContain('sold short');
    expect(plannerSizeHint('long', 'ascending', true)).toContain('sold to close the starting long');
    expect(plannerSizeHint('short', 'ascending', true)).toContain('bought back to close the starting short');
  });
  it('starting-position sizing is disabled with a reason until enabled, then explains the selected direction', () => {
    const props = { id: 'grid-profitScale', label: 'How the starting position is taken profit on', value: 'ascending', side: 'short', startingPosition: true, onChange: () => {} };
    const disabled = renderToStaticMarkup(createElement(GridPlannerSizeSelect, { ...props, enabled: false }));
    expect(disabled).toContain('How the starting position is taken profit on');
    expect(disabled).toContain('disabled=""'); expect(disabled).toContain('to choose how that position is closed in pieces.');
    expect(disabled).toContain('aria-describedby="grid-profitScale-hint"');
    expect(disabled).toContain('Entry price = the price when your bot starts');
    const enabled = renderToStaticMarkup(createElement(GridPlannerSizeSelect, { ...props, enabled: true }));
    expect(enabled).not.toContain('disabled=""'); expect(enabled).toContain('bought back to close the starting short'); expect(enabled).toContain('price falls further');
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
  it('only current, accepted requested geometry draws overlays; rejected and expired geometry clears', () => {
    expect(plannerOverlays(preview, now + 60000, now)).toHaveLength(5);
    expect(plannerOverlays(preview, now + 60000, now + 60000)).toEqual([]);
    expect(plannerOverlays({ ...preview, state: 'rejected' }, now + 60000, now)).toEqual([]);
    expect(plannerOverlays({ ...preview, requestedPlan: null, minimumPlan: preview.requestedPlan }, now + 60000, now)).toEqual([]);
    expect(plannerOverlays(null, now + 60000, now)).toEqual([]);
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
  it('planner flags coexist with a truthful Grid surface and never offer a live start', () => {
    for (const props of [{ authenticated: false, identity: null }, { authenticated: true, identity: 'EXAMPLE' }]) {
      const html = renderToStaticMarkup(createElement(GridPlannerCard, props));
      expect(html).toBe('');
      // Before Grid is enabled (and with no Grid bots) the original coming-soon card stays.
      const live=renderToStaticMarkup(createElement(GridDraftCard,props));expect(live).toContain('card-grid-bot-coming-soon');expect(live).toContain('Coming soon');expect(live).not.toContain('Start bot');
    }
    expect(readableDecimal('123456.000001')).toBe('123,456.000001');
  });
});

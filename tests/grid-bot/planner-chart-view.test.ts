import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridPlannerPriceCanvas } from '../../client/src/components/grid-planner/GridPlannerChart';
import type { PlannerChart } from '../../client/src/lib/grid-planner-view';
import type { GridLine } from '../../server/grid-bot/engine-types';

type PointEvent = { point?: { x: number; y: number } };
const fixture = vi.hoisted(() => {
  const series = { setData: vi.fn(), applyOptions: vi.fn((_options: unknown) => {}), createPriceLine: vi.fn((_options: unknown) => {}), attachPrimitive: vi.fn(), priceToCoordinate: vi.fn((price: number) => price) };
  const timeScale = { fitContent: vi.fn(), logicalToCoordinate: vi.fn() };
  const canvas = { addCandlestickSeries: vi.fn(() => series), applyOptions: vi.fn((_options: unknown) => {}), timeScale: () => timeScale,
    subscribeCrosshairMove: vi.fn((_callback: (event: PointEvent) => void) => {}), subscribeClick: vi.fn((_callback: (event: PointEvent) => void) => {}),
    unsubscribeCrosshairMove: vi.fn(), unsubscribeClick: vi.fn(), remove: vi.fn() };
  return { series, canvas, effect: undefined as (() => void | (() => void)) | undefined,
    cleanup: undefined as (() => void) | undefined, setHovered: vi.fn(),
    container: { clientWidth: 640, clientHeight: 300, appendChild: vi.fn() } };
});
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  useRef: () => ({ current: fixture.container }), useState: () => [null, fixture.setHovered],
  useEffect: (effect: () => void | (() => void)) => { fixture.effect = effect; },
}));
vi.mock('../../client/src/components/SharedTradePriceChart', () => ({ createSharedTradePriceChart: () => fixture.canvas }));
vi.mock('lightweight-charts', () => ({ LineStyle: { Dashed: 2, Solid: 0 } }));
afterEach(() => { fixture.cleanup?.(); fixture.cleanup = undefined; vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('planner chart prices and interactive grid lines', () => {
  it.each([640, 390])('shows strong grid lines, labels only boundaries and stop, and exposes prices on a %ipx canvas', width => {
    fixture.container.clientWidth = width;
    vi.stubGlobal('getComputedStyle', (element: { style?: { color?: string } }) => ({ getPropertyValue: () => '0 0% 50%', color: element.style?.color ?? 'rgb(128, 128, 128)' }));
    vi.stubGlobal('document', { createElement: () => ({ style: {}, remove: vi.fn() }) });
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const chart: Extract<PlannerChart, { state: 'available' }> = { state: 'available', market: 'BTC-PERP', timeframe: '1h', requestedBars: 1, actualBars: 1,
      partial: false, retrievedAt: 1_800_000_000_000, cacheInsertedAt: 1_800_000_000_000, validForMs: 60_000,
      candles: [{ time: 1_799_996_400_000, open: 100, high: 110, low: 90, close: 100, volume: 1,
        provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } }] };
    const lines: GridLine[] = [90, 100, 110].map((price, ordinal) => ({ ordinal, price: `${price}.000000000000000000`, quantity: '1', notional: String(price), role: 'entry', pairedExitOrdinal: null }));
    GridPlannerPriceCanvas({ chart, lines, range: { lower: '90', upper: '110', stop: '80' }, tick: '0.1' });
    const cleanup = fixture.effect?.(); if (typeof cleanup === 'function') fixture.cleanup = cleanup;
    expect(fixture.series.applyOptions).toHaveBeenCalledWith({ title: 'Current price', priceFormat: { type: 'price', precision: 1, minMove: 0.1 } });
    const options = fixture.canvas.applyOptions.mock.calls.map(call => call[0]) as { localization?: { priceFormatter: (price: number) => string } }[];
    expect(options.find(option => option.localization)?.localization?.priceFormatter(100)).toBe('100.0');
    const priceLines = fixture.series.createPriceLine.mock.calls.map(call => call[0]) as { title: string; axisLabelVisible: boolean; color: string; lineWidth: number; lineStyle: number }[];
    expect(priceLines.filter(line => line.axisLabelVisible).map(line => line.title)).toEqual(['Lower', 'Upper', 'Stop']);
    expect(priceLines.slice(0, lines.length).every(line => line.axisLabelVisible === false && line.title === '')).toBe(true);
    expect(priceLines.slice(0, lines.length).every(line => line.lineWidth === 2 && line.lineStyle === 2 && line.color === 'hsl(0 0% 50% / 0.85)')).toBe(true);
    expect(priceLines.slice(lines.length).every(line => line.lineWidth === 3 && line.lineStyle === 0)).toBe(true);
    const hover = fixture.canvas.subscribeCrosshairMove.mock.calls[0][0], tap = fixture.canvas.subscribeClick.mock.calls[0][0];
    hover({ point: { x: width - 1, y: 101 } }); expect(fixture.setHovered).toHaveBeenLastCalledWith({ price: '100.0', left: width === 640 ? 500 : 250, top: 71 });
    tap({ point: { x: 1, y: 90 } }); expect(fixture.setHovered).toHaveBeenLastCalledWith({ price: '90.0', left: 9, top: 60 });
    hover({ point: { x: 20, y: 50 } }); expect(fixture.setHovered).toHaveBeenLastCalledWith(null);
    hover({}); expect(fixture.setHovered).toHaveBeenLastCalledWith(null);
    fixture.cleanup?.(); fixture.cleanup = undefined;
    expect(fixture.canvas.unsubscribeCrosshairMove).toHaveBeenCalledWith(hover); expect(fixture.canvas.unsubscribeClick).toHaveBeenCalledWith(tap);
    expect(fixture.canvas.remove).toHaveBeenCalledOnce();
  });
});

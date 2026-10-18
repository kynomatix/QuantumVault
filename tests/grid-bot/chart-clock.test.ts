import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import type { GridBotSurface } from '../../shared/grid-surface';
import type { PlannerChart } from '../../client/src/lib/grid-planner-view';

const hooks = vi.hoisted(() => ({ useRef: vi.fn(), useEffect: vi.fn(), useState: vi.fn() }));
const chartFactory = vi.hoisted(() => vi.fn());
vi.mock('react', async original => {
  const react = await original<typeof import('react')>();
  return { ...react, ...hooks, default: { ...react, ...hooks } };
});
vi.mock('../../client/src/components/SharedTradePriceChart', () => ({ createSharedTradePriceChart: chartFactory }));
vi.mock('../../client/src/components/grid-bot/GridDraftCard', () => ({ gridJson: vi.fn() }));
vi.mock('../../client/src/components/ui/dialog', () => ({ Dialog: 'div', DialogContent: 'div', DialogHeader: 'div', DialogTitle: 'div', DialogDescription: 'div' }));
vi.mock('../../client/src/components/ui/button', () => ({ Button: 'button' }));
import { GridBotChart } from '../../client/src/components/grid-bot/GridBotChart';
import { gridJson } from '../../client/src/components/grid-bot/GridDraftCard';

type Props = { chart: Extract<PlannerChart, { state: 'available' }>; surface: GridBotSurface; fresh: boolean; now: number };
type Effect = { deps: unknown[]; cleanup?: () => void };
function findCanvas(node: unknown): ReactElement<Props> | null {
  if (Array.isArray(node)) return node.map(findCanvas).find(Boolean) ?? null;
  if (!isValidElement<{ children?: unknown }>(node)) return null;
  if (typeof node.type === 'function' && node.type.name === 'Canvas') return node as ReactElement<Props>;
  return findCanvas(node.props.children);
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Grid chart clock and viewport', () => {
  it('updates polled data and live lines without rebuilding or resetting the viewport', () => {
    const now = 1_800_000_000_000;
    const surface: GridBotSurface = {
      bot: { id: 'EXAMPLE', name: 'Grid', market: 'BTC-PERP', direction: 'long', status: 'active', lowerPrice: '90', upperPrice: '110',
        totalInvestment: '1000', stopLossPrice: '80', gridCount: 4, chartTimeframe: '1h', updatedAt: new Date(now).toISOString() },
      levels: [{ id: 'EXAMPLE', ordinal: 1, price: '95', size: '1', side: 'buy', reduceOnly: false, status: 'open', cumulativeFilledSize: '0' }],
      operations: [], lifecycle: { action: null, state: null, blocker: null },
      pnl: { realised: null, unrealised: null, total: null, fees: null, averageEntry: '100', breakeven: '100' },
      fills: [], cycles: null, position: { size: '1', direction: 'long' }, mark: '105', observedAt: new Date(now).toISOString(),
      residual: null, sweep: 'EXAMPLE', capacity: { ordinaryWindow: 0, reservedSlots: 0, liveOrders: null, venueMaximum: null },
      qualification: {firstConfirmedAt:null,cleanSince:null,cleanTicks:null,promotedAt:null},
      authorities: { safeWindow: false, safeWindowState:'unavailable', resume: false, lostSweepLookup: false, breaker: 'retained_terminal_failures' },
      returnedFunds:{amount:null,confirmedAt:null},entriesBlockedReasons:[],startDraft:null,notifications: { pending: 0, uncertain: 0 }, draftEnabled:false,startConfigured:false,workerEnabled: false, workerRunning:false, startEnabled: false,
    };
    const chart: Props['chart'] = { state: 'available', market: 'BTC-PERP', timeframe: '1h', requestedBars: 100, actualBars: 1,
      partial: true, retrievedAt: now, cacheInsertedAt: now, validForMs: 60_000, candles: [{ time: now - 3_600_000, open: 100, high: 110, low: 90, close: 105, volume: 1,
        provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } }] };
    hooks.useState.mockImplementation(initial => [initial, vi.fn()]).mockReturnValueOnce([chart, vi.fn()]);
    hooks.useEffect.mockImplementation(() => {});
    const element = findCanvas(GridBotChart({ surface, onClose: vi.fn() }))!;
    expect(element).not.toBeNull();
    const Canvas = element.type as (props: Props) => unknown;

    const priceLines: { price: number; title: string; axisLabelVisible: boolean; lineWidth: number; lineStyle: number; applyOptions: ReturnType<typeof vi.fn> }[] = [];
    const series = { setData: vi.fn(), setMarkers: vi.fn(), applyOptions: vi.fn(), removePriceLine: vi.fn(),
      attachPrimitive: vi.fn((_primitive: { autoscaleInfo: () => unknown }) => {}), priceToCoordinate: vi.fn((price: number) => price),
      createPriceLine: vi.fn((options: { price: number; title: string; axisLabelVisible: boolean; lineWidth: number; lineStyle: number }) => { const line = { ...options, applyOptions: vi.fn() }; priceLines.push(line); return line; }) };
    const fitContent = vi.fn(), remove = vi.fn(), viewport = { from: -2.5, to: 0.5 };
    const getVisibleLogicalRange = vi.fn(() => viewport), setVisibleLogicalRange = vi.fn();
    type PointEvent = { point?: { x: number; y: number } };
    const subscribeCrosshairMove = vi.fn((_callback: (event: PointEvent) => void) => {}), subscribeClick = vi.fn((_callback: (event: PointEvent) => void) => {});
    const unsubscribeCrosshairMove = vi.fn(), unsubscribeClick = vi.fn(), setHovered = vi.fn();
    hooks.useState.mockImplementation(initial => [initial, setHovered]);
    chartFactory.mockReturnValue({ addCandlestickSeries: () => series, timeScale: () => ({ fitContent, getVisibleLogicalRange, setVisibleLogicalRange }), applyOptions: vi.fn(), remove,
      subscribeCrosshairMove, subscribeClick, unsubscribeCrosshairMove, unsubscribeClick });
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const refs: { current: unknown }[] = [{ current: { clientWidth: 800, clientHeight: 400 } }, { current: null }];
    const effects: Effect[] = [];
    let refIndex = 0, effectIndex = 0, pending: (() => void)[] = [];
    hooks.useRef.mockImplementation(() => refs[refIndex++]);
    hooks.useEffect.mockImplementation((setup: () => (() => void) | undefined, deps: unknown[]) => {
      const index = effectIndex++, previous = effects[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) pending.push(() => {
        previous?.cleanup?.(); effects[index] = { deps, cleanup: setup() };
      });
    });
    const render = (props: Props) => { refIndex = 0; effectIndex = 0; pending = []; Canvas(props); pending.forEach(run => run()); };
    render({ chart, surface, fresh: true, now });
    const level = priceLines.find(line => line.price === 95 && !line.axisLabelVisible)!;
    const lower = priceLines.find(line => line.title === 'Lower range')!;
    const breakeven = priceLines.find(line => line.title.startsWith('Breakeven'))!;
    const mark = priceLines.find(line => line.title === 'Pacifica mark')!;
    expect(level).toMatchObject({ title: '', lineWidth: 2, lineStyle: 2, axisLabelVisible: false });
    for (const title of ['Lower range', 'Upper range', 'Stop']) expect(priceLines.find(line => line.title === title)).toMatchObject({ lineWidth: 3, lineStyle: 0, axisLabelVisible: true });
    expect(series.attachPrimitive.mock.calls[0][0].autoscaleInfo()).toEqual({ priceRange: { minValue: 80, maxValue: 110 } });
    const hover = subscribeCrosshairMove.mock.calls[0][0], tap = subscribeClick.mock.calls[0][0];
    hover({ point: { x: 799, y: 96 } }); expect(setHovered).toHaveBeenLastCalledWith({ price: '95.00', detail: '1 buy 1 · open', left: 580, top: 44 });
    (refs[0].current as { clientWidth: number }).clientWidth = 390;
    tap({ point: { x: 389, y: 95 } }); expect(setHovered).toHaveBeenLastCalledWith({ price: '95.00', detail: '1 buy 1 · open', left: 170, top: 43 });
    hover({ point: { x: 20, y: 50 } }); expect(setHovered).toHaveBeenLastCalledWith(null);
    hover({}); expect(setHovered).toHaveBeenLastCalledWith(null);
    expect(breakeven.title).toContain('5.00%');
    render({ chart, surface, fresh: true, now: now + 1000 });
    expect(breakeven.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ price: 100, title: 'Breakeven · 5.00%', color: '#10b981' }));
    render({ chart, surface, fresh: false, now: now + 15_001 });
    expect(series.removePriceLine).toHaveBeenCalledWith(breakeven); expect(series.removePriceLine).toHaveBeenCalledWith(mark);
    expect(chartFactory).toHaveBeenCalledTimes(1); expect(fitContent).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
    expect(series.setData).toHaveBeenCalledTimes(1);
    const moving={...surface,pnl:{...surface.pnl,botBreakeven:'60'}};
    render({chart,surface:moving,fresh:true,now:now+1000});
    expect(priceLines.find(line=>line.price===60&&line.title.startsWith('Breakeven'))).toBeDefined();
    expect(series.attachPrimitive.mock.calls[0][0].autoscaleInfo()).toEqual({priceRange:{minValue:60,maxValue:110}});
    const movingLine=priceLines.find(line=>line.price===60&&line.title.startsWith('Breakeven'))!;
    render({chart,surface:{...moving,pnl:{...moving.pnl,botBreakeven:'-10',profitCoversPosition:true}},fresh:true,now:now+1000});
    expect(series.removePriceLine).toHaveBeenCalledWith(movingLine);
    const polled: GridBotSurface = { ...surface, bot: { ...surface.bot, lowerPrice: '91' }, mark: '106',
      levels: [{ ...surface.levels[0], price: '96', status: 'filled' }],
      fills: [{ tradeId: 'EXAMPLE', time: chart.candles[0].time, leg: 'entry', size: '1', price: '96' }] };
    render({ chart, surface: polled, fresh: true, now: now + 2000 });
    expect(chartFactory).toHaveBeenCalledTimes(1); expect(fitContent).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
    expect(level.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ price: 96, title: '', axisLabelVisible: false, lineWidth: 2 }));
    tap({ point: { x: 20, y: 96 } }); expect(setHovered).toHaveBeenLastCalledWith(expect.objectContaining({ price: '96.00', detail: '1 buy 1 · filled' }));
    expect(lower.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ price: 91 }));
    expect(series.setMarkers).toHaveBeenLastCalledWith([expect.objectContaining({ text: 'entry 1 @ 96', shape: 'arrowUp' })]);
    expect(setVisibleLogicalRange).toHaveBeenLastCalledWith(viewport);
    expect(series.setData).toHaveBeenCalledTimes(4);
    render({ chart: { ...chart, candles: [{ ...chart.candles[0], close: 106 }] }, surface: { ...polled, levels: [], fills: [] }, fresh: true, now: now + 3000 });
    expect(chartFactory).toHaveBeenCalledTimes(1); expect(fitContent).toHaveBeenCalledTimes(1);
    expect(series.removePriceLine).toHaveBeenCalledWith(level); expect(series.setMarkers).toHaveBeenLastCalledWith([]);
    tap({ point: { x: 20, y: 96 } }); expect(setHovered).toHaveBeenLastCalledWith(null);
    expect(series.setData).toHaveBeenLastCalledWith([expect.objectContaining({ close: 106 })]);
    expect(setVisibleLogicalRange).toHaveBeenLastCalledWith(viewport);
    const expanded = { ...chart, candles: [{ ...chart.candles[0], time: chart.candles[0].time - 7_200_000 }, ...chart.candles] };
    render({ chart: expanded, surface: polled, fresh: true, now: now + 3500 });
    expect(chartFactory).toHaveBeenCalledTimes(1); expect(fitContent).toHaveBeenCalledTimes(1);
    expect(setVisibleLogicalRange).toHaveBeenLastCalledWith({ from: viewport.from + 1, to: viewport.to + 1 });
    render({ chart: { ...chart, timeframe: '4h' }, surface: polled, fresh: true, now: now + 4000 });
    expect(chartFactory).toHaveBeenCalledTimes(2); expect(fitContent).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(1);
    render({ chart: { ...chart, timeframe: '4h' }, surface: { ...polled, bot: { ...polled.bot, id: 'EXAMPLE-OTHER' } }, fresh: true, now: now + 5000 });
    expect(chartFactory).toHaveBeenCalledTimes(3); expect(fitContent).toHaveBeenCalledTimes(3); expect(remove).toHaveBeenCalledTimes(2);
    effects.forEach(effect => effect.cleanup?.()); expect(remove).toHaveBeenCalledTimes(3); expect(disconnect).toHaveBeenCalledTimes(3);
    expect(unsubscribeCrosshairMove).toHaveBeenCalledWith(hover); expect(unsubscribeClick).toHaveBeenCalledWith(tap);
  });
  it('retains displayed chart data and its expiry while a refresh request is pending', () => {
    vi.useFakeTimers();
    const now = Date.now(), setChart = vi.fn(), setExpired = vi.fn();
    const chart: Props['chart'] = { state: 'available', market: 'BTC-PERP', timeframe: '1h', requestedBars: 100,
      actualBars: 0, partial: true, retrievedAt: now, cacheInsertedAt: now, validForMs: 3000, candles: [] };
    const surface = { bot: { id: 'EXAMPLE', market: 'BTC-PERP' }, observedAt: null } as GridBotSurface;
    const effects: { setup: () => (() => void) | undefined; deps: unknown[] }[] = [];
    hooks.useState.mockImplementation(initial => [initial, vi.fn()])
      .mockReturnValueOnce([chart, setChart]).mockReturnValueOnce(['1h', vi.fn()])
      .mockReturnValueOnce([1, vi.fn()]).mockReturnValueOnce([false, setExpired]);
    hooks.useEffect.mockImplementation((setup, deps) => effects.push({ setup, deps }));
    vi.mocked(gridJson).mockReturnValue(new Promise(() => {}));
    expect(findCanvas(GridBotChart({ surface, onClose: vi.fn() }))).not.toBeNull();
    const expiryCleanup = effects.find(effect => effect.deps.length === 1 && effect.deps[0] === chart)!.setup();
    const requestCleanup = effects.find(effect => effect.deps.length === 3 && effect.deps[2] === 1)!.setup();
    expect(setChart).not.toHaveBeenCalled();
    requestCleanup?.();
    vi.advanceTimersByTime(3000);
    expect(setExpired).toHaveBeenCalledWith(true);
    expiryCleanup?.();
  });
});

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

type Props = { chart: Extract<PlannerChart, { state: 'available' }>; surface: GridBotSurface; fresh: boolean; now: number };
type Effect = { deps: unknown[]; cleanup?: () => void };
function findCanvas(node: unknown): ReactElement<Props> | null {
  if (Array.isArray(node)) return node.map(findCanvas).find(Boolean) ?? null;
  if (!isValidElement<{ children?: unknown }>(node)) return null;
  if (typeof node.type === 'function' && node.type.name === 'Canvas') return node as ReactElement<Props>;
  return findCanvas(node.props.children);
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Grid chart clock and viewport', () => {
  it('updates live lines on ticks and expiry without rebuilding or fitting the viewport', () => {
    const now = 1_800_000_000_000;
    const surface: GridBotSurface = {
      bot: { id: 'EXAMPLE', name: 'Grid', market: 'BTC-PERP', direction: 'long', status: 'active', lowerPrice: '90', upperPrice: '110',
        totalInvestment: '1000', stopLossPrice: '80', gridCount: 4, chartTimeframe: '1h', updatedAt: new Date(now).toISOString() },
      levels: [], operations: [], lifecycle: { action: null, state: null, blocker: null },
      pnl: { realised: null, unrealised: null, total: null, fees: null, averageEntry: '100', breakeven: '100' },
      fills: [], cycles: null, position: { size: '1', direction: 'long' }, mark: '105', observedAt: new Date(now).toISOString(),
      residual: null, sweep: 'EXAMPLE', capacity: { ordinaryWindow: 0, reservedSlots: 0, liveOrders: null, venueMaximum: null },
      authorities: { safeWindow: false, resume: false, lostSweepLookup: false, breaker: 'not_monitored_by_venue_error_class' },
      notifications: { pending: 0, uncertain: 0 }, workerEnabled: false, startEnabled: false,
    };
    const chart: Props['chart'] = { state: 'available', market: 'BTC-PERP', timeframe: '1h', requestedBars: 100, actualBars: 1,
      partial: true, retrievedAt: now, cacheInsertedAt: now, validForMs: 60_000, candles: [{ time: now - 3_600_000, open: 100, high: 110, low: 90, close: 105, volume: 1,
        provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } }] };
    hooks.useState.mockImplementation(initial => [initial, vi.fn()]).mockReturnValueOnce([chart, vi.fn()]);
    hooks.useEffect.mockImplementation(() => {});
    const element = findCanvas(GridBotChart({ surface, onClose: vi.fn() }))!;
    expect(element).not.toBeNull();
    const Canvas = element.type as (props: Props) => unknown;

    const priceLines: { title: string; applyOptions: ReturnType<typeof vi.fn> }[] = [];
    const series = { setData: vi.fn(), setMarkers: vi.fn(), applyOptions: vi.fn(), removePriceLine: vi.fn(),
      createPriceLine: vi.fn((options: { title: string }) => { const line = { title: options.title, applyOptions: vi.fn() }; priceLines.push(line); return line; }) };
    const fitContent = vi.fn(), remove = vi.fn();
    chartFactory.mockReturnValue({ addCandlestickSeries: () => series, timeScale: () => ({ fitContent }), applyOptions: vi.fn(), remove });
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
    const breakeven = priceLines.find(line => line.title.startsWith('Breakeven'))!;
    const mark = priceLines.find(line => line.title === 'Pacifica mark')!;
    expect(breakeven.title).toContain('5.00%');
    render({ chart, surface, fresh: true, now: now + 1000 });
    expect(breakeven.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ price: 100, title: 'Breakeven · 5.00%', color: '#10b981' }));
    render({ chart, surface, fresh: false, now: now + 15_001 });
    expect(series.removePriceLine).toHaveBeenCalledWith(breakeven); expect(series.removePriceLine).toHaveBeenCalledWith(mark);
    expect(chartFactory).toHaveBeenCalledTimes(1); expect(fitContent).toHaveBeenCalledTimes(1); expect(remove).not.toHaveBeenCalled();
    expect(series.setData).toHaveBeenCalledTimes(1);
    render({ chart: { ...chart, candles: [...chart.candles] }, surface, fresh: true, now: now + 2000 });
    expect(chartFactory).toHaveBeenCalledTimes(2); expect(fitContent).toHaveBeenCalledTimes(2); expect(remove).toHaveBeenCalledTimes(1);
    effects.forEach(effect => effect.cleanup?.()); expect(remove).toHaveBeenCalledTimes(2); expect(disconnect).toHaveBeenCalledTimes(2);
  });
});

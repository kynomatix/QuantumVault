import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { GridPlannerSheet } from '../../client/src/components/grid-planner/GridPlannerSheet';
import { GridPlannerChart } from '../../client/src/components/grid-planner/GridPlannerChart';
import { gridSetupForm, gridSetupIntent } from '../../client/src/lib/grid-setup-view';
import { gridHistoryWindow } from '../../shared/grid-lookback';
import { RANGE_PRESETS } from '../../client/src/lib/grid-planner-view';

// Exercise the real sheet, request generations and price controller without a DOM dependency.
// Only rendering hooks and the periodic price scheduler are replaced.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dirty: false,
  stateIndex: 0, refIndex: 0, effectIndex: 0,
  effects: [] as { dependencies?: readonly unknown[]; cleanup?: () => void }[],
  pending: [] as { index: number; run: () => void | (() => void); dependencies?: readonly unknown[] }[],
  controllers: [] as import('../../client/src/lib/planner-price-refresh').PlannerPriceRefresh[],
}));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[index], (next: unknown) => {
      const value = typeof next === 'function' ? next(hooks.states[index]) : next;
      if (!Object.is(value, hooks.states[index])) { hooks.states[index] = value; hooks.dirty = true; }
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++;
    return hooks.refs[index] ?? (hooks.refs[index] = { current: initial });
  },
  useMemo: (compute: () => unknown) => compute(),
  useCallback: (callback: unknown) => callback,
  useEffect: (run: () => void | (() => void), dependencies?: readonly unknown[]) => {
    const index = hooks.effectIndex++, previous = hooks.effects[index];
    if (!previous || !dependencies || !previous.dependencies || dependencies.length !== previous.dependencies.length
      || dependencies.some((value, i) => !Object.is(value, previous.dependencies![i]))) {
      hooks.pending.push({ index, run, dependencies });
    }
  },
}));
vi.mock('../../client/src/lib/queryClient', () => ({ walletAuthHeaders: () => ({}) }));
vi.mock('../../client/src/lib/planner-price-refresh', async importOriginal => ({
  ...await importOriginal<typeof import('../../client/src/lib/planner-price-refresh')>(),
  watchPlannerPrice: (controller: import('../../client/src/lib/planner-price-refresh').PlannerPriceRefresh) => {
    hooks.controllers.push(controller);
    void controller.refresh();
    return () => controller.dispose();
  },
}));

type Props = Parameters<typeof GridPlannerSheet>[0];
type Element = ReactElement<Record<string, any>>;
type RangeRequest = { market: string; timeframe: string; period: string; signal: AbortSignal;
  resolve: (value: unknown) => void; reject: (error: Error) => void };
let props: Props, tree: ReactNode, requests: RangeRequest[], listed: string[];

function render(next: Partial<Props> = {}) {
  props = { ...props, ...next };
  hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effectIndex = 0; hooks.pending = []; hooks.dirty = false;
  tree = GridPlannerSheet(props);
  // React cleans up old effects before setting up the next commit's effects.
  for (const effect of hooks.pending) hooks.effects[effect.index]?.cleanup?.();
  for (const effect of hooks.pending) {
    const cleanup = effect.run();
    hooks.effects[effect.index] = { dependencies: effect.dependencies, cleanup: cleanup || undefined };
  }
}
async function settle() {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!hooks.dirty) return;
    render();
  }
  throw Error('Sheet did not settle within 20 renders');
}
function elements(node: ReactNode = tree): Element[] {
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...Children.toArray(node.props.children).flatMap(child => elements(child))];
}
function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return isValidElement<{ children?: ReactNode }>(node) ? Children.toArray(node.props.children).map(text).join('') : '';
}
function find(predicate: (element: Element) => boolean) {
  const found = elements().find(predicate);
  expect(found).toBeDefined();
  return found!;
}
function button(label: string) { return find(node => typeof node.props.onClick === 'function' && text(node) === label); }
function field(name: string) { return find(node => node.props.id === `grid-${name}` && 'value' in node.props); }
function edit(name: string, value: string) { field(name).props.onChange({ target: { value } }); render(); }
function market(value: string) {
  find(node => typeof node.props.onValueChange === 'function'
    && elements(node).some(child => child.props.id === 'grid-market')).props.onValueChange(value);
  render();
}
function prices() { return { lower: field('lower').props.value, upper: field('upper').props.value, stop: field('stop').props.value }; }
function source() { return find(node => node.type === 'span' && ['Auto', 'Manual'].includes(text(node))).props.children; }
function facts(request: RangeRequest, overrides: Record<string, unknown> = {}) {
  return { state: 'available', market: request.market, timeframe: request.timeframe,
    requestedBars: gridHistoryWindow(request.timeframe, request.period)!.rangeBars, validForMs: 60_000,
    regime: { state: 'unavailable', reason: 'EXAMPLE independent ADX unavailable' },
    range: { state: 'available', lowerPrice: '90', upperPrice: '110', longStop: '85', shortStop: '115', includedBars: 168 },
    ...overrides };
}
async function open(next: Partial<Props> = {}) { render(next); await settle(); }
async function resolve(request: RangeRequest, value = facts(request)) { request.resolve(value); await settle(); }

beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = []; hooks.controllers = []; hooks.dirty = false;
  props = { open: true, onOpenChange: vi.fn(), identity: 'EXAMPLE_WALLET' };
  requests = []; listed = ['BTC-PERP', 'ETH-PERP'];
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    const path = new URL(url, 'https://example.test');
    if (path.pathname.endsWith('/range')) return new Promise((complete, reject) => {
      requests.push({ market: path.searchParams.get('market')!, timeframe: path.searchParams.get('timeframe')!,
        period: path.searchParams.get('period')!, signal: init.signal as AbortSignal,
        resolve: value => complete({ ok: true, json: async () => value }), reject });
    });
    const observedAt = Date.now();
    const value = path.pathname.endsWith('/markets') || path.pathname.endsWith('/setup-markets')
      ? { state: 'available', retrievedAt: observedAt, markets: listed.map(market => ({ market, name: market, protocolSymbol: market,
        constraints: { state: 'unavailable', reason: 'EXAMPLE sizing unavailable' },
        reference: { state: 'available', value: { price: '100', observedAt, expiresAt: observedAt + 60_000,
          label: 'Cached Pacifica book reference price' } } })) }
      : { state: 'unavailable', reason: 'EXAMPLE chart unavailable' };
    return Promise.resolve({ ok: true, json: async () => value });
  }));
});
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('Grid setup automatic opening range', () => {
  it.each([true, false])('fills Week bounds and structural stop once with plannerEnabled=%s', async plannerEnabled => {
    await open({ plannerEnabled });
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ market: 'BTC-PERP', timeframe: '1h', period: 'week' });
    expect(button('Week').props['aria-pressed']).toBe(true);
    expect(prices()).toEqual({ lower: '', upper: '', stop: '' });
    await resolve(requests[0]);
    expect(prices()).toEqual({ lower: '90', upper: '110', stop: '85' }); expect(source()).toBe('Auto');
    expect(find(node => node.type === GridPlannerChart).props.range).toMatchObject({ lower: '90', upper: '110', stop: '85' });
    await hooks.controllers.at(-1)!.refresh(); await settle();
    expect(requests).toHaveLength(1); expect(prices().lower).toBe('90');
    button('Refresh price').props.onClick(); render(); await settle();
    expect(requests).toHaveLength(2);
    await resolve(requests[1], facts(requests[1], { range: { state: 'available', lowerPrice: '70', upperPrice: '130', longStop: '65', shortStop: '135' } }));
    expect(prices()).toEqual({ lower: '90', upper: '110', stop: '85' });
  });
  it('validates the remembered default before auto-filling its live fallback', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'OLD-PERP', setItem: vi.fn() });
    await open();
    expect(requests).toHaveLength(1); expect(requests[0].market).toBe('BTC-PERP');
    await resolve(requests[0]); expect(prices().lower).toBe('90'); expect(source()).toBe('Auto');
  });
  it.each(['manual', 'auto'] as const)('preserves an initialIntent with source %s through initial reads and price refreshes', async rangeSource => {
    const form = { ...gridSetupForm(undefined, 'OLD-PERP'), side: 'short', lower: '80', upper: '120', stop: '125' };
    await open({ initialIntent: gridSetupIntent(form, form.stop, rangeSource) });
    expect(requests).toHaveLength(1); expect(requests[0].market).toBe('OLD-PERP');
    await resolve(requests[0]);
    await hooks.controllers.at(-1)!.refresh(); await settle();
    expect(prices()).toEqual({ lower: '80', upper: '120', stop: '125' }); expect(source()).toBe(rangeSource === 'auto' ? 'Auto' : 'Manual');
    expect(requests).toHaveLength(1);
    render({ open: false }); await settle(); render({ open: true }); await settle();
    await resolve(requests[1]); expect(prices()).toEqual({ lower: '80', upper: '120', stop: '125' });
  });
  it.each(['lower', 'upper', 'stop'])('gives an early %s edit ownership over the pending suggestion', async name => {
    await open(); edit(name, '95');
    await resolve(requests[0]);
    expect(field(name).props.value).toBe('95'); expect(source()).toBe('Manual');
    expect(prices()).toEqual({ lower: '', upper: '', stop: '', [name]: '95' });
  });
  it('keeps auto pending through an unrelated edit and uses the latest direction for the stop', async () => {
    await open(); edit('investment', '100');
    find(node => typeof node.props.onClick === 'function' && text(node) === 'Short').props.onClick(); render();
    await resolve(requests[0]);
    expect(prices()).toEqual({ lower: '90', upper: '110', stop: '115' }); expect(source()).toBe('Auto');
  });
  it('gives a price preset ownership even when the initial suggestion arrives later', async () => {
    await open(); button(RANGE_PRESETS[1].label).props.onClick(); render(); await settle();
    const entered = prices(); expect(entered.lower).not.toBe(''); expect(source()).toBe('Manual');
    await resolve(requests[0]); expect(prices()).toEqual(entered); expect(source()).toBe('Manual');
  });
  it('keeps a slider change after later range observations', async () => {
    await open(); await resolve(requests[0]);
    find(node => typeof node.props.onValueChange === 'function' && Array.isArray(node.props.value)).props.onValueChange([20]); render();
    const entered = prices(); expect(source()).toBe('Manual'); expect(entered.lower).not.toBe('90');
    button('Refresh price').props.onClick(); render(); await settle(); await resolve(requests[1]);
    expect(prices()).toEqual(entered);
  });
  it('ignores an old market response and re-runs auto once for each selected market', async () => {
    await open(); const old = requests[0]; market('ETH-PERP'); await settle();
    expect(old.signal.aborted).toBe(true); expect(prices()).toEqual({ lower: '', upper: '', stop: '' });
    await resolve(old); expect(prices().lower).toBe('');
    await resolve(requests[1]); expect(prices().lower).toBe('90');
    await hooks.controllers.at(-1)!.refresh(); await settle(); expect(requests).toHaveLength(2);
    market('BTC-PERP'); await settle(); expect(requests).toHaveLength(3);
    await resolve(requests[2]); expect(source()).toBe('Auto');
    edit('lower', '88'); market('ETH-PERP'); await settle(); await resolve(requests[3]);
    expect(prices()).toEqual({ lower: '', upper: '', stop: '' }); expect(source()).toBe('Manual');
  });
  it.each(['unavailable', 'failure', 'invalid', 'expired'])('leaves an empty range and a plain reason on %s', async kind => {
    await open(); const request = requests[0];
    if (kind === 'failure') request.reject(Error('EXAMPLE source down'));
    else if (kind === 'unavailable') request.resolve(facts(request, { range: { state: 'unavailable', reason: 'EXAMPLE not enough finalized candles' } }));
    else if (kind === 'invalid') request.resolve(facts(request, { market: 'EXAMPLE_WRONG_MARKET' }));
    else {
      // Expire the observation in transit without using timers or fabricating prices.
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
      request.resolve(facts(request)); await settle(); clock.mockRestore();
    }
    await settle();
    expect(prices()).toEqual({ lower: '', upper: '', stop: '' });
    expect(elements().some(node => node.props.role === 'status' && /source down|not enough finalized|Invalid range|expired/.test(text(node)))).toBe(true);
    await hooks.controllers.at(-1)!.refresh(); await settle(); expect(requests).toHaveLength(1);
    button('Refresh price').props.onClick(); render(); await settle(); await resolve(requests[1]);
    expect(prices()).toEqual({ lower: '', upper: '', stop: '' });
    button('Suggest auto-range').props.onClick(); render(); await settle();
    expect(prices().lower).toBe('90'); expect(source()).toBe('Auto');
  });
  it('waits for the new period and rejects the superseded Week response', async () => {
    await open(); const week = requests[0]; button('Day').props.onClick(); render(); await settle();
    expect(week.signal.aborted).toBe(true); expect(requests[1].period).toBe('day');
    await resolve(week); expect(prices().lower).toBe('');
    await resolve(requests[1]); expect(source()).toBe('Auto'); expect(prices().lower).toBe('90');
  });
  it('re-arms a retained sheet on reopen and ignores the closed opening response', async () => {
    await open(); const old = requests[0];
    render({ open: false }); await settle(); expect(old.signal.aborted).toBe(true);
    render({ open: true }); await settle(); expect(requests).toHaveLength(2);
    await resolve(old); expect(prices().lower).toBe('');
    await resolve(requests[1]); expect(prices().lower).toBe('90');
    edit('lower', '88'); button('Month').props.onClick(); render(); await settle();
    render({ open: false }); await settle(); render({ open: true }); await settle();
    const reopened = requests.at(-1)!; expect(reopened.period).toBe('week'); expect(prices().lower).toBe('');
    await resolve(reopened); expect(source()).toBe('Auto'); expect(prices().lower).toBe('90');
  });
});

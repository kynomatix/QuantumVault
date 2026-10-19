import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { Button } from '../../client/src/components/ui/button';
import { DialogFooter } from '../../client/src/components/ui/dialog';
import { GridPlanIssues } from '../../client/src/components/grid-planner/GridPlanIssues';
import { GridBehaviourSelect } from '../../client/src/components/grid-planner/GridBehaviourSelect';
import { GridPlannerSheet } from '../../client/src/components/grid-planner/GridPlannerSheet';
import { GridRangingFinder } from '../../client/src/components/grid-planner/GridRangingFinder';
import { GridPlannerChart } from '../../client/src/components/grid-planner/GridPlannerChart';
import { GridRegimeHint } from '../../client/src/components/grid-planner/GridRegimeHint';
import { GridDraftActions } from '../../client/src/components/grid-bot/GridDraftActions';
import { previewGrid } from '../../server/grid-planner/preview';
import type { PlannerMarket, PlannerQuery } from '../../server/grid-planner/types';
import { gridSetupForm, gridSetupIntent } from '../../client/src/lib/grid-setup-view';
import { gridHistoryWindow } from '../../shared/grid-lookback';
import { isPlannerPreview, RANGE_PRESETS } from '../../client/src/lib/grid-planner-view';

// Exercise the real sheet, request generations and price controller without a DOM dependency.
// Only rendering hooks and the periodic price scheduler are replaced.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dirty: false,
  stateIndex: 0, refIndex: 0, effectIndex: 0, modesCreation: true,
  effects: [] as { dependencies?: readonly unknown[]; cleanup?: () => void }[],
  pending: [] as { index: number; run: () => void | (() => void); dependencies?: readonly unknown[] }[],
  controllers: [] as import('../../client/src/lib/planner-price-refresh').PlannerPriceRefresh[],
}));
vi.mock('../../shared/grid-behaviour', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/grid-behaviour')>(),
  get GRID_MODES_CREATION() { return hooks.modesCreation; },
}));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useId: () => 'EXAMPLE-behaviour',
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
let props: Props, tree: ReactNode, requests: RangeRequest[], listed: string[], constraintsAvailable: boolean;
let holdCharts: boolean, chartRequests: RangeRequest[];
let cycleV2Creation: boolean | undefined;

function fixtureMarket(market: string, observedAt = Date.now()): PlannerMarket {
  // Venue constraints last five minutes; reference prices and geometry previews last one.
  return { market, name: market, protocolSymbol: market,
    constraints: constraintsAvailable
      ? { state: 'available', value: { tick: '0.1', lot: '0.01', minimumQuote: '10', observedAt, expiresAt: observedAt + 300_000,
        maxLeverage: { state: 'available', value: '50' }, maximumQuote: { state: 'unavailable', reason: 'EXAMPLE' },
        priceBounds: { state: 'unavailable', reason: 'EXAMPLE' }, restrictions: { state: 'unavailable', reason: 'EXAMPLE' }, source: '/info', venue: 'pacifica' } }
      : { state: 'unavailable', reason: 'EXAMPLE sizing unavailable' },
    reference: { state: 'available', value: { price: '100', observedAt, expiresAt: observedAt + 60_000,
      label: 'Cached Pacifica book reference price' } } };
}

function render(next: Partial<Props> = {}, commit = true) {
  props = { ...props, ...next };
  hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effectIndex = 0; hooks.pending = []; hooks.dirty = false;
  tree = GridPlannerSheet(props);
  if (!commit) return;
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
  const layout = node.type === GridDraftActions
    ? node.props.renderLayout({ details: null, status: null, actions: null, depositDialog: null }) : null;
  return [node, ...Children.toArray(node.props.children).flatMap(child => elements(child)), ...elements(layout)];
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
function chartFacts(request: RangeRequest) {
  const retrievedAt = Date.now(), requestedBars = gridHistoryWindow(request.timeframe, request.period)!.chartBars;
  return { state: 'available', market: request.market, timeframe: request.timeframe, requestedBars,
    actualBars: 1, partial: requestedBars > 1, retrievedAt, cacheInsertedAt: retrievedAt, validForMs: 60_000,
    candles: [{ time: retrievedAt - 3_600_000, open: 100, high: 110, low: 90, close: 100, volume: 1,
      provenance: { source: 'pacifica', venue: 'pacifica', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' } }] };
}
function chart() { return find(node => node.type === GridPlannerChart).props.chart; }
function regime() { return find(node => node.type === GridRegimeHint).props.regime; }
async function open(next: Partial<Props> = {}) { render(next); await settle(); }
async function resolve(request: RangeRequest, value = facts(request)) { request.resolve(value); await settle(); }

beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = []; hooks.controllers = []; hooks.dirty = false;
  props = { open: true, onOpenChange: vi.fn(), identity: 'EXAMPLE_WALLET' };
  requests = []; listed = ['BTC-PERP', 'ETH-PERP']; constraintsAvailable = true;
  holdCharts = false; chartRequests = [];
  cycleV2Creation = undefined;
  hooks.modesCreation = true;
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    const path = new URL(url, 'https://example.test');
    if (path.pathname.endsWith('/preview')) {
      const observedAt = Date.now(), market = path.searchParams.get('market')!;
      const fixture = fixtureMarket(market, observedAt);
      const query = { ...Object.fromEntries(path.searchParams), intervals: Number(path.searchParams.get('intervals')),
        seed: path.searchParams.get('seed') === 'true', fee: path.searchParams.get('fee') } as unknown as PlannerQuery;
      return Promise.resolve({ ok: true, json: async () => previewGrid(query, fixture, observedAt, {cycleV2Creation,modesCreation:hooks.modesCreation}) });
    }
    if (path.pathname.endsWith('/range') || holdCharts && path.pathname.endsWith('/chart')) return new Promise((complete, reject) => {
      (path.pathname.endsWith('/range') ? requests : chartRequests).push({ market: path.searchParams.get('market')!, timeframe: path.searchParams.get('timeframe')!,
        period: path.searchParams.get('period')!, signal: init.signal as AbortSignal,
        resolve: value => complete({ ok: true, json: async () => value }), reject });
    });
    const observedAt = Date.now();
    const value = path.pathname.endsWith('/markets') || path.pathname.endsWith('/setup-markets')
      ? { state: 'available', retrievedAt: observedAt, markets: listed.map(market => fixtureMarket(market, observedAt)) }
      : { state: 'unavailable', reason: 'EXAMPLE chart unavailable' };
    return Promise.resolve({ ok: true, json: async () => value });
  }));
});
afterEach(() => {
  for (const effect of hooks.effects) effect.cleanup?.();
  vi.useRealTimers();
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe('Grid behaviour reveal interaction', () => {
  it.each(['long', 'short'])('toggles inline, selects each %s card, and restores row focus', side => {
    let value: Parameters<typeof GridBehaviourSelect>[0]['value'] = 'repeat_all';
    const onChange = vi.fn((mode: typeof value) => { value = mode; });
    const focus = vi.fn();
    const renderPicker = () => {
      hooks.stateIndex = 0; hooks.refIndex = 0;
      tree = GridBehaviourSelect({ value, side, seed: true, onChange });
      hooks.refs[0].current = { focus };
    };
    const row = () => find(node => node.type === Button);
    const panel = () => find(node => node.props.id === row().props['aria-controls']);
    renderPicker();
    expect(row().props['aria-expanded']).toBe(false);
    expect(panel().props.hidden).toBe(true);
    row().props.onClick(); renderPicker();
    expect(row().props['aria-expanded']).toBe(true);
    expect(panel().props.hidden).toBe(false);
    row().props.onClick(); renderPicker();
    expect(panel().props.hidden).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    for (const mode of ['step_back', 'step_back_edge', 'repeat_all']) {
      row().props.onClick(); renderPicker();
      const radio = find(node => node.type === 'input' && node.props.value === mode);
      // A pointer activation clicks the input and changes its checked value.
      expect(radio.props.type).toBe('radio');
      expect(radio.props.name).toBe('EXAMPLE-behaviour-behaviour');
      radio.props.onClick(); radio.props.onChange(); renderPicker();
      expect(onChange).toHaveBeenLastCalledWith(mode);
      expect(panel().props.hidden).toBe(true);
      expect(row().props['aria-expanded']).toBe(false);
      expect(find(node => node.type === 'input' && node.props.value === mode).props.checked).toBe(true);
      const title = find(node => node.props.id === radio.props['aria-labelledby']);
      expect(row().props['aria-label']).toContain(text(title));
    }
    expect(focus).toHaveBeenCalledTimes(3);
    row().props.onClick(); renderPicker();
    find(node => node.type === 'input' && node.props.checked).props.onClick(); renderPicker();
    expect(panel().props.hidden).toBe(true);
    expect(focus).toHaveBeenCalledTimes(4);
  });

  function keyboardPicker() {
    let value: Parameters<typeof GridBehaviourSelect>[0]['value'] = 'repeat_all';
    const onChange = vi.fn((mode: typeof value) => { value = mode; });
    const focus = vi.fn();
    const renderPicker = () => {
      hooks.stateIndex = 0; hooks.refIndex = 0;
      tree = GridBehaviourSelect({ value, side: 'long', seed: true, onChange });
      hooks.refs[0].current = { focus };
    };
    const row = () => find(node => node.type === Button);
    const panel = () => find(node => node.props.id === row().props['aria-controls']);
    const radio = (mode = value) => find(node => node.type === 'input' && node.props.value === mode);
    renderPicker();
    row().props.onClick(); renderPicker();
    return { renderPicker, row, panel, radio, onChange, focus };
  }

  it('Escape from inside the panel closes only the panel and restores row focus', () => {
    const picker = keyboardPicker();
    const event = { key: 'Escape', target: picker.radio(), preventDefault: vi.fn(), stopPropagation: vi.fn() };
    picker.panel().props.onKeyDown(event); picker.renderPicker();
    expect(picker.panel().props.hidden).toBe(true);
    expect(picker.row().props['aria-expanded']).toBe(false);
    expect(picker.focus).toHaveBeenCalledOnce();
    expect(picker.onChange).not.toHaveBeenCalled();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
  });

  it.each(['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'])('%s browses and wraps cards without collapsing', key => {
    const picker = keyboardPicker();
    const order = key === 'ArrowRight' || key === 'ArrowDown'
      ? ['step_back', 'step_back_edge', 'repeat_all'] as const
      : ['step_back_edge', 'step_back', 'repeat_all'] as const;
    for (const mode of order) {
      const cardFocus = vi.fn();
      const querySelector = vi.fn(() => ({ focus: cardFocus }));
      const closest = vi.fn(() => ({ querySelector }));
      const event = { key, preventDefault: vi.fn(), currentTarget: { closest } };
      picker.radio().props.onKeyDown(event); picker.renderPicker();
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(closest).toHaveBeenCalledWith('[role="radiogroup"]');
      expect(querySelector).toHaveBeenCalledWith(`input[value="${mode}"]`);
      expect(cardFocus).toHaveBeenCalledOnce();
      expect(picker.onChange).toHaveBeenLastCalledWith(mode);
      expect(picker.radio(mode).props.checked).toBe(true);
      expect(picker.panel().props.hidden).toBe(false);
      expect(picker.row().props['aria-expanded']).toBe(true);
      expect(picker.focus).not.toHaveBeenCalled();
    }
    expect(picker.onChange).toHaveBeenCalledTimes(3);
  });

  it.each(['Enter', ' '])('%s selects the focused card and collapses with row focus', key => {
    const picker = keyboardPicker();
    // Exercise both a different card and activation of the already-selected card.
    for (let attempt = 0; attempt < 2; attempt++) {
      const event = { key, preventDefault: vi.fn() };
      picker.radio('step_back').props.onKeyDown(event); picker.renderPicker();
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(picker.onChange).toHaveBeenLastCalledWith('step_back');
      expect(picker.radio('step_back').props.checked).toBe(true);
      expect(picker.panel().props.hidden).toBe(true);
      expect(picker.row().props['aria-expanded']).toBe(false);
      expect(picker.focus).toHaveBeenCalledTimes(attempt + 1);
      if (attempt === 0) { picker.row().props.onClick(); picker.renderPicker(); }
    }
    expect(picker.onChange).toHaveBeenCalledTimes(2);
  });
});

describe('Grid setup automatic opening range', () => {
  it('finder selection uses the ordinary market change and never applies a candidate band', async () => {
    holdCharts = true; await open(); await resolve(requests[0]);
    chartRequests[0].resolve(chartFacts(chartRequests[0])); await settle();
    edit('investment', '300');
    const finder = () => find(node => node.type === GridRangingFinder);
    const heldChart = chart();
    finder().props.onSelect('BTC-PERP'); render(); await settle();
    expect(chart()).toBe(heldChart);
    finder().props.onSelect('ETH-PERP'); render(); await settle();
    expect(prices()).toEqual({ lower: '', upper: '', stop: '' }); expect(chart()).toBeNull();
    expect(field('investment').props.value).toBe('300');
    expect(requests.at(-1)!.market).toBe('ETH-PERP'); expect(chartRequests.at(-1)!.market).toBe('ETH-PERP');
  });
  it('retains the chart and range advisory while the same market refreshes, including a failed refresh', async () => {
    holdCharts = true; await open(); await resolve(requests[0]);
    chartRequests[0].resolve(chartFacts(chartRequests[0])); await settle();
    const heldChart = chart(), heldRegime = regime();
    expect(heldChart?.state).toBe('available');
    button('Refresh chart').props.onClick(); render(); await settle();
    expect(chart()).toBe(heldChart); expect(regime()).toBe(heldRegime);
    requests.at(-1)!.reject(Error('EXAMPLE range refresh failed'));
    chartRequests.at(-1)!.reject(Error('EXAMPLE chart refresh failed')); await settle();
    expect(chart()).toBe(heldChart); expect(regime()).toBe(heldRegime);
    edit('lower', '88'); button('Suggest auto-range').props.onClick(); render(); await settle();
    expect(prices().lower).toBe('90');
  });
  it.each(['market', 'timeframe', 'period', 'identity'] as const)('clears held chart and range facts on a %s change, even if the replacement fails', async changed => {
    holdCharts = true; await open(); await resolve(requests[0]);
    chartRequests[0].resolve(chartFacts(chartRequests[0])); await settle();
    const oldRegime = regime(); expect(chart()?.state).toBe('available');
    if (changed === 'market') market('ETH-PERP');
    else if (changed === 'timeframe') { button('4h').props.onClick(); render(); }
    else if (changed === 'period') { button('Day').props.onClick(); render(); }
    else render({ identity: 'EXAMPLE_OTHER_WALLET' }, false);
    // The identity assertion precedes effect cleanup: a stored observation must be keyed at render time.
    expect(chart()).toBeNull(); expect(regime()).not.toBe(oldRegime);
    render(); await settle();
    requests.at(-1)!.reject(Error('EXAMPLE replacement range failed'));
    chartRequests.at(-1)!.reject(Error('EXAMPLE replacement chart failed')); await settle();
    expect(chart()).toBeNull(); expect(regime()).not.toBe(oldRegime);
    edit('lower', '88'); button('Suggest auto-range').props.onClick(); render(); await settle();
    expect(prices().lower).toBe('88');
    expect(requests.at(-1)!.market).toBe(changed === 'market' ? 'ETH-PERP' : 'BTC-PERP');
  });
  it('rejects late old-identity observations before the new effects have committed', async () => {
    holdCharts = true; await open(); const oldRange = requests[0], oldChart = chartRequests[0];
    render({ identity: 'EXAMPLE_OTHER_WALLET' }, false);
    oldRange.resolve(facts(oldRange)); oldChart.resolve(chartFacts(oldChart)); await settle();
    expect(chart()).toBeNull(); expect(prices().lower).toBe('');
    render(); await settle();
    expect(chart()).toBeNull(); expect(prices().lower).toBe('');
  });
  it('keeps Equal defaults and shows the opening-order minimum lift for behaviour modes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await open(); await resolve(requests[0]);
    expect(field('entryScale').props.value).toBe('flat'); expect(field('profitScale').props.value).toBe('flat');
    edit('investment', '300'); edit('leverage', '10'); edit('intervals', '50');
    field('entryScale').props.onChange('ascending'); render();
    field('profitScale').props.onChange('ascending'); render();
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(elements().some(node => node.props.role === 'status' && text(node) === '4 grid orders raised to the $10 minimum')).toBe(true);
  });
  it('hides mode choice and sends mode-free preview and draft requests while modes creation is disabled', async () => {
    hooks.modesCreation = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await open({createEnabled:true}); await resolve(requests[0]); edit('investment','1000');
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(elements().some(node => node.type === GridBehaviourSelect)).toBe(false);
    expect(find(node => node.type === GridDraftActions).props.intent).not.toHaveProperty('behaviourMode');
    const previewCalls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/preview?'));
    expect(previewCalls.length).toBeGreaterThan(0);
    for (const [url] of previewCalls) expect(new URL(String(url),'https://example.test').searchParams.has('behaviourMode')).toBe(false);
    expect(elements().filter(node=>node.type===GridPlanIssues).flatMap(node=>node.props.reasons)).not.toContain('Behaviour modes are unavailable');
  });
  it('rejects a behaviour-mode preview while cycle creation is disabled', async () => {
    cycleV2Creation=false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await open(); await resolve(requests[0]); edit('investment','1000');
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(find(node=>node.type===GridPlanIssues).props.reasons).toContain('Behaviour modes are unavailable');
  });
  it.each(['Long','Short'])('shows the default %s behaviour selector and fixed-quantity copy', async side => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await open(); await resolve(requests[0]);
    if(side==='Short'){button('Short').props.onClick();render();}
    edit('investment','1000');edit('intervals','4');
    await vi.advanceTimersByTimeAsync(250);await settle();
    const selector=find(node=>node.type===GridBehaviourSelect);
    expect(selector.props.value).toBe('repeat_all');
    expect(selector.props.side).toBe(side.toLowerCase());
    const copy=elements().map(node=>text(node)).join('\n');
    expect(copy).toContain(side==='Long'
      ?'Sell as price rises, buy back as it falls, and keep going.'
      :'Close as price falls, reopen as it rises, and keep going.');
    expect(copy).toContain('Quantities stay fixed; profits stay in the bot.');
    expect(copy).toContain(side==='Long'
      ?'Place backed sells above price immediately. Without it, those levels wait for a buy first.'
      :'Place backed buys below price immediately. Without it, those levels wait for a sell first.');
    selector.props.onChange('step_back'); render();
    expect(find(node=>node.type===GridBehaviourSelect).props.value).toBe('step_back');
  });
  it('shows a disabled Create bot with a visible accessible launch reason and working Cancel in planning mode', async () => {
    await open();
    const footer = find(node => node.type === DialogFooter);
    const buttons = elements(footer).filter(node => node.type === Button);
    expect(buttons.map(text)).toEqual(['Cancel', 'Create bot']);
    const create = buttons[1];
    expect(create.props.disabled).toBe(true);
    expect(create.props.type).toBe('button');
    expect(create.props.className).toBe('bg-gradient-to-r from-primary to-accent');
    expect(create.props.onClick).toBeUndefined();
    const reason = elements(footer).find(node => node.props.id === create.props['aria-describedby']);
    expect(reason).toBeDefined();
    expect(reason!.type).toBe('p');
    expect(text(reason)).toBe('Opens when Grid trading launches');
    expect(reason!.props.hidden).toBeUndefined();
    expect(reason!.props.className).not.toMatch(/sr-only|hidden/);
    expect(buttons[0].props.disabled).toBe(false);
    buttons[0].props.onClick();
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
  it.each([false, true])('retains supplied draft actions without the launch placeholder with liveEnabled=%s', async liveEnabled => {
    await open({ createEnabled: true, liveEnabled });
    const draft = find(node => node.type === GridDraftActions);
    const onClick = vi.fn(), label = liveEnabled ? 'Create bot' : 'Save draft';
    const actions = createElement(Button, { onClick }, label);
    const layout = draft.props.renderLayout({ actions });
    const footer = elements(layout).find(node => node.type === DialogFooter)!;
    const buttons = elements(footer).filter(node => node.type === Button);
    expect(buttons.map(text)).toEqual(['Cancel', label]);
    expect(buttons[1].props).toEqual(actions.props);
    expect(text(footer)).not.toContain('Opens when Grid trading launches');
    buttons[1].props.onClick();
    expect(onClick).toHaveBeenCalledOnce();
  });
  it.each([false, true])('draws quantized levels before investment with createEnabled=%s and replaces them on sizing', async createEnabled => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await open({ createEnabled }); await resolve(requests[0]);
    expect(field('investment').props.value).toBe('');
    expect(elements().some(node => text(node) === 'Restore entered range')).toBe(false);
    await vi.advanceTimersByTimeAsync(250); await settle();
    let chart = find(node => node.type === GridPlannerChart);
    expect(chart.props.lines).toHaveLength(11);
    expect(chart.props.lines[0]).toEqual({ ordinal: 0, price: '90' });
    expect(chart.props.lines.at(-1)).toEqual({ ordinal: 10, price: '110' });
    expect(chart.props.lines.every((line: Record<string, unknown>) => Object.keys(line).sort().join(',') === 'ordinal,price')).toBe(true);
    expect(chart.props.levelMessage).toBe('Enter an investment to see order sizes');
    edit('intervals', '4'); expect(find(node => node.type === GridPlannerChart).props.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(find(node => node.type === GridPlannerChart).props.lines).toHaveLength(5);
    edit('investment', '1000'); expect(find(node => node.type === GridPlannerChart).props.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(250); await settle();
    chart = find(node => node.type === GridPlannerChart);
    // Draft-enabled setups still require the separate authoritative draft preview after investment.
    if (createEnabled) expect(chart.props.lines).toEqual([]);
    else expect(chart.props.lines[0]).toHaveProperty('quantity');
    edit('investment', ''); await vi.advanceTimersByTimeAsync(250); await settle();
    expect(find(node => node.type === GridPlannerChart).props.lines).toHaveLength(5);
    const previewRequests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/preview?'));
    const beforeExpiry = previewRequests().length;
    // The scheduler is mocked: no fresh preview can renew these lines. Defer rendering across
    // both the earlier market/range deadline and the later geometry deadline.
    await vi.advanceTimersByTimeAsync(60_001); await settle();
    expect(previewRequests()).toHaveLength(beforeExpiry);
    expect(find(node => node.type === GridPlannerChart).props.lines).toHaveLength(5);
    expect(find(node => node.type === GridPlannerChart).props.levelMessage).toContain('expired');
  });
  it.each([false, true])('holds price-only levels during refresh and labels expiry with createEnabled=%s', async createEnabled => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    await open({ createEnabled }); await resolve(requests[0]);
    edit('intervals', '4'); await vi.advanceTimersByTimeAsync(250); await settle();
    const initialLines = find(node => node.type === GridPlannerChart).props.lines;
    expect(initialLines).toHaveLength(5);
    const initialDeadline = Date.now() + 60_000;
    await vi.advanceTimersByTimeAsync(20_000); await settle();

    const original = vi.mocked(fetch).getMockImplementation()!;
    let finish!: () => void, renewedPreview!: ReturnType<typeof previewGrid>;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!String(url).includes('/preview?')) return response;
      renewedPreview = await response.json();
      return new Promise<Response>(resolve => { finish = () => resolve({ ...response, json: async () => renewedPreview } as Response); });
    });
    await hooks.controllers.at(-1)!.refresh(); await settle();
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(isPlannerPreview(renewedPreview)).toBe(true);
    expect(renewedPreview.retrievedAt).toBeGreaterThan(initialDeadline - 60_000);
    expect(find(node => node.type === GridPlannerChart).props.lines).toEqual(initialLines);
    finish(); await settle();
    expect(find(node => node.type === GridPlannerChart).props.lines).toEqual(initialLines);

    await vi.advanceTimersByTimeAsync(initialDeadline - Date.now() + 1); await settle();
    expect(find(node => node.type === GridPlannerChart).props.lines).toEqual(initialLines);
    await vi.advanceTimersByTimeAsync(renewedPreview.retrievedAt + renewedPreview.validForMs - Date.now() + 1); await settle();
    expect(find(node => node.type === GridPlannerChart).props.lines).toEqual(initialLines);
    expect(find(node => node.type === GridPlannerChart).props.levelMessage).toContain('expired');
  });
  it('ignores a superseded geometry response after editing the range', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const original = vi.mocked(fetch).getMockImplementation()!;
    let finish!: () => void, oldSignal: AbortSignal | undefined;
    let stalePreview!: ReturnType<typeof previewGrid>;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url).includes('/preview?') && !oldSignal) {
        oldSignal = init?.signal as AbortSignal;
        const response = await original(url, init);
        stalePreview = await response.json();
        return new Promise<Response>(resolve => { finish = () => resolve({ ...response, json: async () => stalePreview } as Response); });
      }
      return original(url, init);
    });
    await open(); await resolve(requests[0]); await vi.advanceTimersByTimeAsync(250); await settle();
    expect(isPlannerPreview(stalePreview)).toBe(true);
    expect(stalePreview.geometry).toMatchObject({ state: 'available', value: expect.arrayContaining([{ ordinal: 0, price: '90' }]) });
    edit('lower', '95'); expect(oldSignal?.aborted).toBe(true);
    finish(); await settle();
    expect(find(node => node.type === GridPlannerChart).props.lines).toEqual([]);
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(find(node => node.type === GridPlannerChart).props.lines[0].price).toBe('95');
  });
  it.each([false, true])('keeps levels unavailable without market constraints with createEnabled=%s', async createEnabled => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    constraintsAvailable = false;
    await open({ createEnabled }); await resolve(requests[0]);
    expect(prices()).toEqual({ lower: '90', upper: '110', stop: '85' });
    await vi.advanceTimersByTimeAsync(250); await settle();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/preview?'))).toBe(true);
    const chart = find(node => node.type === GridPlannerChart);
    expect(chart.props.lines).toEqual([]);
    expect(chart.props.levelMessage).toBe('Grid levels are unavailable: EXAMPLE sizing unavailable');
  });
  it.each([true, false])('clears automatic application after a markets read failure with plannerEnabled=%s', async plannerEnabled => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation((url, init) => /\/(?:setup-)?markets(?:\?|$)/.test(String(url))
      ? Promise.reject(Error('EXAMPLE markets read failed')) : original(url, init));
    await open({ plannerEnabled, createEnabled: true });
    expect(find(node => node.type === GridDraftActions).props.rangeBusy).toBe(false);
    expect(requests).toHaveLength(0);
    vi.mocked(fetch).mockImplementation(original);
    await hooks.controllers.at(-1)!.refresh(); await settle(); await resolve(requests[0]);
    expect(prices()).toEqual({ lower: '', upper: '', stop: '' });
    button('Suggest auto-range').props.onClick(); render(); await settle(); expect(prices().lower).toBe('90');
  });
  it('keeps candle-based auto range armed after a successful markets read without a reference price', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!/\/markets(?:\?|$)/.test(String(url))) return response;
      const value = await response.json();
      return { ...response, json: async () => ({ ...value, markets: value.markets.map((m: PlannerMarket) => ({
        ...m, reference: { state: 'unavailable', reason: 'EXAMPLE no cached reference' },
      })) }) } as Response;
    });
    await open(); await resolve(requests[0]);
    expect(prices()).toEqual({ lower: '90', upper: '110', stop: '85' });
    expect(source()).toBe('Auto');
  });
  it('only offers restoration after a real manual range and forgets it when changing markets', async () => {
    await open(); await resolve(requests[0]);
    expect(elements().some(node => text(node) === 'Restore entered range')).toBe(false);
    edit('lower', '88'); edit('upper', '112'); edit('stop', '82'); const entered = prices();
    button('Suggest auto-range').props.onClick(); render(); await settle(); expect(source()).toBe('Auto');
    button('Restore entered range').props.onClick(); render(); expect(prices()).toEqual(entered); expect(source()).toBe('Manual');
    button('Suggest auto-range').props.onClick(); render(); market('ETH-PERP'); await settle(); await resolve(requests.at(-1)!);
    expect(elements().some(node => text(node) === 'Restore entered range')).toBe(false);
  });
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

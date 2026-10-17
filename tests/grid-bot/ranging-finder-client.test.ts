import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { GridRangingFinder } from '../../client/src/components/grid-planner/GridRangingFinder';
import type { GridFinderPage } from '../../shared/grid-finder';
const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: any }[], stateIndex: 0, refIndex: 0,
  effectIndex: 0, effects: [] as { deps: readonly unknown[]; cleanup?: () => void }[], pending: [] as (() => void)[] }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = typeof value === 'function' ? value(hooks.states[index]) : value; }];
  },
  useRef: (value: unknown) => { const index = hooks.refIndex++; return hooks.refs[index] ??= { current: value }; },
  useEffect: (run: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.effectIndex++, previous = hooks.effects[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) hooks.pending.push(() => {
      previous?.cleanup?.(); hooks.effects[index] = { deps, cleanup: run() || undefined };
    });
  },
}));
vi.mock('../../client/src/lib/queryClient', () => ({ walletAuthHeaders: () => ({}) }));
type Props = Parameters<typeof GridRangingFinder>[0];
type Element = ReactElement<Record<string, any>>;
let props: Props, tree: ReactNode;
let requests: { url: URL; signal: AbortSignal; resolve: (page: unknown) => void }[];
function render(next: Partial<Props> = {}, commit = true) {
  props = { ...props, ...next }; hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effectIndex = 0; hooks.pending = [];
  tree = GridRangingFinder(props); if (commit) hooks.pending.forEach(effect => effect());
}
function elements(node = tree): Element[] {
  return isValidElement<Record<string, any>>(node) ? [node, ...Children.toArray(node.props.children).flatMap(child => elements(child))] : [];
}
function text(node: ReactNode = tree): string {
  return typeof node === 'string' || typeof node === 'number' ? String(node)
    : isValidElement<{ children?: ReactNode }>(node) ? Children.toArray(node.props.children).map(text).join('') : '';
}
function button(label: string) {
  const found = elements().find(node => typeof node.props.onClick === 'function' && text(node) === label);
  expect(found).toBeDefined(); return found!;
}
function click(label: string) { button(label).props.onClick(); render(); }
async function resolve(page: unknown, index = requests.length - 1) { requests[index].resolve(page); await new Promise<void>(done => setImmediate(done)); render(); }
function page(count = 8, cursor = 0, overrides: Partial<GridFinderPage> = {}): GridFinderPage {
  const historyCut = Math.floor(1_800_000_000_000 / 3_600_000) * 3_600_000;
  return { state: 'available', timeframe: '1h', historyCut, universe: 'EXAMPLE', cursor, nextCursor: cursor + 20,
    total: 45, ineligible: 1, checked: 20, unavailable: 1, notRanging: 19 - count, deadlineReached: false, truncated: true,
    candidates: Array.from({ length: count }, (_, i) => ({ market: `M${cursor + i}-PERP`, symbol: `M${cursor + i}`, adx: 10 + i / 10,
      lowerPrice: '98', upperPrice: '102', venue: 'okx', latestFinalizedTime: historyCut - 3_600_000, updatedAt: 1_800_000_000_000 })), ...overrides };
}
beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = []; hooks.pending = []; requests = [];
  props = { enabled: true, identity: 'EXAMPLE', timeframe: '1h', disabled: false, onSelect: vi.fn() };
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => new Promise((done, reject) => {
    requests.push({ url: new URL(url, 'https://example.test'), signal: init.signal as AbortSignal,
      resolve: value => done({ ok: true, json: async () => value }) });
    init.signal?.addEventListener('abort', () => reject(Error('EXAMPLE cancelled')), { once: true });
  })));
});
afterEach(() => { hooks.effects.forEach(effect => effect.cleanup?.()); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ranging finder interaction', () => {
  it('shows only the trigger until clicked, never scans on mount and can collapse without another request', async () => {
    render(); render(); expect(text()).toBe('Find ranging markets'); expect(fetch).not.toHaveBeenCalled();
    expect(elements().some(node => node.props.id === 'grid-ranging-markets')).toBe(false);
    click('Find ranging markets'); expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests[0].url.searchParams.get('timeframe')).toBe('1h');
    button('Find ranging markets').props.onClick(); render();
    expect(elements().some(node => node.props.id === 'grid-ranging-markets')).toBe(false);
    await resolve(page()); expect(elements().some(node => node.props.id === 'grid-ranging-markets')).toBe(false);
    click('Find ranging markets'); expect(elements().some(node => node.props.id === 'grid-ranging-markets')).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('shows five rows initially, expands locally, and selects only the market', async () => {
    render(); click('Find ranging markets'); await resolve(page());
    const candidates = () => elements().filter(node => node.props['aria-label']?.startsWith('Select M'));
    expect(candidates()).toHaveLength(5); expect(text()).toContain('Ranging'); expect(text()).toContain('ADX 10.0');
    expect(text()).toContain('Detected band:'); expect(text()).toContain('Updated'); expect(text()).toContain('weakest measured trend');
    expect(text()).not.toContain('best markets');
    candidates()[0].props.onClick(); expect(props.onSelect).toHaveBeenCalledExactlyOnceWith('M0-PERP');
    click('Show more candidates'); expect(candidates()).toHaveLength(8); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports coverage, partial and unavailable states, and pages only after another explicit click', async () => {
    render(); click('Find ranging markets'); await resolve(page(0));
    expect(text()).toContain('Checked 20 of 45 markets. 1 unavailable; 25 not yet checked. 1 ineligible.');
    expect(text()).toContain('No qualifying markets in this scan.'); expect(text()).toContain('Scan truncated');
    click('Check next 20 markets'); button('Check next 20 markets').props.onClick();
    expect(fetch).toHaveBeenCalledTimes(2); expect(requests[1].url.searchParams.get('cursor')).toBe('20');
    await resolve(page(0, 20, { deadlineReached: true }));
    expect(text()).toContain('Checked 40 of 45 markets. 2 unavailable; 5 not yet checked.');
    expect(text()).toContain('Deadline reached; this batch is partial.');
  });
  it('cancels on interval, identity and close changes and hides old facts before effect cleanup', async () => {
    render(); click('Find ranging markets'); const old = requests[0];
    render({ timeframe: '4h' }, false); expect(text()).toBe('Find ranging markets');
    render({ timeframe: '4h' }); expect(old.signal.aborted).toBe(true);
    await new Promise<void>(done => setImmediate(done)); render(); expect(text()).toBe('Find ranging markets');
    click('Find ranging markets'); render({ identity: 'REDACTED' }); expect(requests[1].signal.aborted).toBe(true);
    click('Find ranging markets'); render({ enabled: false }); expect(requests[2].signal.aborted).toBe(true); expect(tree).toBeNull();
    await new Promise<void>(done => setImmediate(done));
  });
  it('keeps previous coverage when a page crosses the history cut and offers an explicit restart', async () => {
    render(); click('Find ranging markets'); await resolve(page(1)); click('Check next 20 markets');
    await resolve(page(1, 20, { historyCut: page().historyCut + 3_600_000 }));
    expect(text()).toContain('history or market list changed'); expect(text()).toContain('Checked 20 of 45 markets.');
    expect(button('Check first 20 again').props.disabled).toBe(false);
  });
  it('cancels on request and never scans when disabled', async () => {
    render({ disabled: true }); expect(button('Find ranging markets').props.disabled).toBe(true);
    button('Find ranging markets').props.onClick(); expect(fetch).not.toHaveBeenCalled();
    render({ disabled: false }); click('Find ranging markets'); click('Cancel scan');
    await new Promise<void>(done => setImmediate(done)); render();
    expect(requests[0].signal.aborted).toBe(true); expect(text()).toContain('cancelled or timed out');
  });
});

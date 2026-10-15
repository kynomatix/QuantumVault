import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import type { GridBotSummary } from '../../shared/grid-surface';
import type { GridIntent } from '../../shared/grid-draft';
import { GridDraftCard } from '../../client/src/components/grid-bot/GridDraftCard';

// Run the real collection effects and callbacks without a DOM renderer dependency.
const hooks = vi.hoisted(() => ({
  states: [] as unknown[], stateIndex: 0, refs: [] as { current: unknown }[], refIndex: 0,
  effects: [] as { run: () => void | (() => void); dependencies: unknown[] }[],
  drawer: null as null | Parameters<typeof import('../../client/src/components/grid-bot/GridBotDrawer').GridBotDrawer>[0],
  sheet: null as null | Parameters<typeof import('../../client/src/components/grid-planner/GridPlannerSheet').GridPlannerSheet>[0],
}));
vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === 'function' ? next(hooks.states[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++;
    return hooks.refs[index] ?? (hooks.refs[index] = { current: initial });
  },
  useEffect: (run: () => void | (() => void), dependencies: unknown[]) => {
    hooks.effects.push({ run, dependencies });
  },
}));
vi.mock('../../client/src/lib/queryClient', () => ({ walletAuthHeaders: () => ({}) }));
vi.mock('../../client/src/components/grid-bot/GridBotDrawer', () => ({
  GridBotDrawer: (props: NonNullable<typeof hooks.drawer>) => { hooks.drawer = props; return null; },
}));
vi.mock('../../client/src/components/grid-planner/GridPlannerSheet', () => ({
  GridPlannerSheet: (props: NonNullable<typeof hooks.sheet>) => { hooks.sheet = props; return null; },
}));

const bot: GridBotSummary = {
  id: 'EXAMPLE_GRID', name: 'EXAMPLE range', market: 'BTC-PERP', direction: 'long', status: 'draft',
  lowerPrice: '90', upperPrice: '110', totalInvestment: '100', stopLossPrice: '85',
  gridCount: 10, chartTimeframe: '1h', updatedAt: '2026-10-15T00:00:00Z',
};
let layout: { card: ReactNode; bots: ReactNode };
function render(authenticated = true, identity: string | null = 'EXAMPLE_WALLET') {
  hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effects = []; hooks.drawer = null; hooks.sheet = null;
  return renderToStaticMarkup(createElement(GridDraftCard, {
    authenticated, identity,
    renderLayout: (card, bots) => {
      layout = { card, bots };
      return createElement('main', {},
        createElement('div', { 'data-testid': 'type-cards', className: 'grid md:grid-cols-3 gap-5' }, card),
        createElement('div', { 'data-testid': 'existing-bots' }, bots));
    },
  }));
}
type ActionElement = ReactElement<{ children?: ReactNode; 'data-testid'?: string; onClick?: () => void }>;
function find(node: ReactNode, testId: string): ActionElement | undefined {
  if (!isValidElement<ActionElement['props']>(node)) return undefined;
  if (node.props['data-testid'] === testId) return node;
  for (const child of Children.toArray(node.props.children)) {
    const match = find(child, testId);
    if (match) return match;
  }
  return undefined;
}
function seed({ drafts = false, planning = false, start = false, worker = false, bots = [] as GridBotSummary[] } = {}) {
  hooks.states = [drafts, bots, null, '', planning, start, worker, null, 0];
}
function responses(bots: GridBotSummary[] = [], enabled = true) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => ({
    ok: true,
    json: async () => String(url).includes('includeStopped') ? { bots }
      : String(url).includes('grid-planner') ? { enabled, planningOnly: true, name: 'Grid Planner' }
      : { enabled, startEnabled: false, workerEnabled: false },
  })));
}
// A task boundary lets all three fetch/json chains and their allSettled handler finish.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  hooks.states = []; hooks.refs = []; hooks.effects = [];
  vi.stubGlobal('window', new EventTarget());
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Grid bot setup card and separate bot section', () => {
  it('uses the sibling card, tile, text, badge and bottom button styles without listing bots in the setup card', () => {
    seed({ planning: true, bots: [bot] });
    const html = render();
    const top = html.slice(0, html.indexOf('data-testid="existing-bots"'));
    const app = readFileSync('client/src/pages/App.tsx', 'utf8');
    const cardClass = app.match(/className="([^"]+)" data-testid="card-ai-trader"/)?.[1];
    expect(cardClass).toBeTruthy();
    expect(top).toContain(`class="${cardClass}" data-testid="card-grid-bot"`);
    expect(top).toContain('w-10 h-10 rounded-xl bg-gradient-to-br from-primary/30 to-accent/30 flex items-center justify-center flex-shrink-0');
    expect(top).toContain('<h3 class="font-semibold">Grid Bot</h3>');
    expect(top).toContain('<p class="text-xs text-muted-foreground">Range trading on Pacifica</p>');
    expect(top).toContain('text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground border border-border/60 shrink-0');
    expect(top).toContain('>Planning</span>');
    expect(top).toContain('<p class="text-sm text-muted-foreground">Pick a range');
    expect(top).toContain('<p class="text-xs text-muted-foreground/70">Planning only for now: no orders are placed.</p>');
    expect(top).toContain('flex items-center gap-2 mt-auto pt-1');
    expect(top).toContain('flex-1 bg-gradient-to-r from-primary to-accent hover:opacity-90');
    expect(top).toContain('Plan a grid →');
    for (const removed of ['Refresh bots', 'No Grid bots loaded.', 'funding', 'View bot', bot.name]) expect(top).not.toContain(removed);
    expect(html).toContain('data-testid="section-grid-bots"');
    expect(html).toContain('grid md:grid-cols-2 xl:grid-cols-3 gap-5');
    expect(app.indexOf('{gridBots}')).toBeGreaterThan(app.indexOf('data-testid="section-signal-bots"'));
  });

  it('shows no empty bot section and retains a non-interactive coming-soon card when every gate is off', () => {
    seed();
    const html = render();
    expect(html).toContain('data-testid="card-grid-bot-coming-soon"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-testid="section-grid-bots"');
    expect(html).not.toContain('No Grid bots loaded.');
  });

  it.each([
    { planning: true }, { drafts: true }, { drafts: true, start: true }, { drafts: true, worker: true },
  ])('permits planning through an existing setup gate without implying live execution: %j', (gates) => {
    seed(gates);
    expect(render()).toContain('Planning only for now: no orders are placed.');
    expect(find(layout.card, 'button-plan-grid')).toBeDefined();
    expect(render()).not.toContain('data-testid="section-grid-bots"');
  });

  it('keeps the existing live gate conjunction without displaying a planning-only promise when live is enabled', () => {
    seed({ drafts: true, start: true, worker: true });
    const html = render();
    expect(html).toContain('Plan a grid →');
    expect(html).not.toContain('Planning only for now');
    expect(html).not.toContain('>Planning</span>');
  });

  it('keeps existing and stopped bots accessible with Grid off and routes View bot and Adjust Range through the same owner', () => {
    seed({ bots: [bot, { ...bot, id: 'EXAMPLE_STOPPED', status: 'stopped' }] });
    const html = render();
    expect(html).not.toContain('card-grid-bot-coming-soon');
    expect(find(layout.card, 'button-plan-grid')).toBeUndefined();
    expect(html).toContain('data-testid="grid-bot-card-EXAMPLE_STOPPED"');
    expect(html).toContain('BTC-PERP · long');
    expect(html).toContain('90 – 110');
    expect(html).toContain('View bot');
    find(layout.bots, 'grid-bot-card-EXAMPLE_GRID')!.props.onClick!();
    render();
    expect(hooks.drawer?.id).toBe(bot.id);
    expect(hooks.drawer?.createEnabled).toBe(false);
    const intent: GridIntent = {
      schemaVersion: 1, protocol: 'pacifica', timeframe: '1h', lookback: 100,
      market: 'BTC-PERP', direction: 'long', lowerPrice: '90', upperPrice: '110', gridCount: 10,
      totalInvestment: '100', leverage: '1', stopPrice: '85', seedAtCreation: false,
      entryScaleType: 'flat', profitScaleType: 'flat', rangeSource: 'manual',
    };
    hooks.drawer!.onAdjust(intent);
    render();
    expect(hooks.drawer).toBeNull();
    expect(hooks.sheet?.initialIntent).toBe(intent);
    expect(hooks.sheet?.createEnabled).toBe(false);
    expect(hooks.sheet?.liveEnabled).toBe(false);
  });

  it('refreshes on mount, window focus and draft save while retaining the visible list during reads', async () => {
    responses([bot]);
    render();
    const cleanupRead = hooks.effects[0].run();
    const cleanupFocus = hooks.effects[1].run();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(render()).toContain('grid-bot-card-EXAMPLE_GRID');
    window.dispatchEvent(new Event('focus'));
    render();
    expect(hooks.effects[0].dependencies).toEqual([true, 'EXAMPLE_WALLET', 1]);
    if (typeof cleanupRead === 'function') cleanupRead();
    const cleanupRefresh = hooks.effects[0].run();
    expect(render()).toContain('grid-bot-card-EXAMPLE_GRID');
    await settle();
    expect(fetch).toHaveBeenCalledTimes(6);
    find(layout.card, 'button-plan-grid')!.props.onClick!();
    render();
    expect(hooks.sheet?.identity).toBe('EXAMPLE_WALLET');
    hooks.sheet!.onSaved!({ id: 'EXAMPLE_GRID' });
    render();
    expect(hooks.sheet).toBeNull();
    expect(hooks.effects[0].dependencies).toEqual([true, 'EXAMPLE_WALLET', 2]);
    if (typeof cleanupRefresh === 'function') cleanupRefresh();
    const cleanupSaved = hooks.effects[0].run();
    await settle();
    expect(fetch).toHaveBeenCalledTimes(9);
    if (typeof cleanupSaved === 'function') cleanupSaved();
    if (typeof cleanupFocus === 'function') cleanupFocus();
    window.dispatchEvent(new Event('focus'));
    expect(hooks.states[8]).toBe(2);
  });

  it('aborts obsolete wallet reads and refuses their late list and flag results', async () => {
    const pending: ((value: unknown) => void)[] = [];
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { pending.push(resolve); })));
    render();
    const cleanup = hooks.effects[0].run();
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    if (typeof cleanup === 'function') cleanup();
    expect(signal?.aborted).toBe(true);
    pending.forEach((resolve, index) => resolve({ ok: true, json: async () => index === 1 ? { bots: [bot] } : { enabled: true } }));
    await settle();
    expect(render()).toContain('card-grid-bot-coming-soon');
    expect(hooks.states[1]).toEqual([]);
    expect(hooks.states[0]).toBe(false);
  });

  it('does not read or register focus refresh without an authenticated wallet', () => {
    responses();
    render(false, null);
    expect(hooks.effects[0].run()).toBeUndefined();
    expect(hooks.effects[1].run()).toBeUndefined();
    window.dispatchEvent(new Event('focus'));
    expect(fetch).not.toHaveBeenCalled();
    expect(hooks.states[8]).toBe(0);
  });

  it('retains existing bots on a failed refresh and exposes the failure below the setup card', async () => {
    seed({ drafts: true, bots: [bot] });
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('EXAMPLE unavailable'); }));
    render();
    const cleanup = hooks.effects[0].run();
    await settle();
    const html = render();
    expect(html).toContain('role="status"');
    expect(html).toContain('Grid bots unavailable. Return to this window to retry.');
    expect(html).toContain('grid-bot-card-EXAMPLE_GRID');
    expect(find(layout.card, 'button-plan-grid')).toBeUndefined();
    if (typeof cleanup === 'function') cleanup();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBotPerformance } from '../../client/src/hooks/useBotPerformance';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { transpileModule, JsxEmit, ScriptTarget } from 'typescript';

// Execute the actual drawer chart/footer JSX, with inert chart/button elements.
// This tests its conditions and visible text without mounting unrelated money controls.
const drawerSource = readFileSync(resolve(process.cwd(), 'client/src/components/BotManagementDrawer.tsx'), 'utf8');
const panelStart = drawerSource.indexOf('<div className="p-4 rounded-xl border bg-muted/20" data-testid="performance-chart-container">');
const panelEnd = drawerSource.indexOf('<div className="mt-3 pt-3 border-t border-border/50">', panelStart);
if (panelStart < 0 || panelEnd <= panelStart) throw new Error('Performance panel extraction failed');
const panelJs = transpileModule(`function renderPanel({
  series: performanceData, loading: performanceLoading, stale: performanceStale,
  totalPnl: performanceTotalPnl, tradeCount: performanceTradeCount,
  accountingIncompleteCloseCount: performanceAccountingIncompleteCount,
}) {
  const performanceTimeframe = '7d', netDeposited = 100, showPerformancePercent = false;
  const setPerformanceTimeframe = () => {}, setPerformanceView = () => {};
  const getPerformanceChartCaption = () => 'Chart: last 7 days';
  const Button = 'Button', Loader2 = 'Loader2', BarChart3 = 'BarChart3';
  const ResponsiveContainer = 'ResponsiveContainer', LineChart = 'LineChart';
  const XAxis = 'XAxis', YAxis = 'YAxis', RechartsTooltip = 'RechartsTooltip', Line = 'Line';
  return (${drawerSource.slice(panelStart, panelEnd)}</div>);
}`, { compilerOptions: { jsx: JsxEmit.React, target: ScriptTarget.ES2020 }, fileName: 'performance-panel.tsx' }).outputText;
const renderPanel = new Function('React', `${panelJs}; return renderPanel;`)({
  createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
});
function panel(view: ReturnType<typeof useBotPerformance>) {
  const text: string[] = [], testIds: string[] = [];
  function visit(node: any) {
    if (typeof node === 'string' || typeof node === 'number') text.push(String(node));
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node) {
      if (node.props?.['data-testid']) testIds.push(node.props['data-testid']);
      node.children.forEach(visit);
    }
  }
  visit(renderPanel(view));
  return { text: text.join(''), testIds };
}

// A deterministic React hook lifecycle: render and passive effects are separate
// so the first render after selecting a period is tested before its fetch starts.
const hooks = vi.hoisted(() => ({
  slots: [] as any[], cursor: 0, effects: [] as Array<() => void>,
}));
vi.mock('react', () => ({
  useState(initial: unknown) {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (next: any) => {
      hooks.slots[index] = typeof next === 'function' ? next(hooks.slots[index]) : next;
    }];
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++;
    return hooks.slots[index] ??= { current: initial };
  },
  useCallback(callback: unknown, deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks.slots[index] = { deps, callback };
    }
    return hooks.slots[index].callback;
  },
  useEffect(effect: () => (() => void), deps: unknown[]) {
    const index = hooks.cursor++;
    const previous = hooks.slots[index];
    if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
      hooks.effects.push(() => {
        previous?.cleanup();
        hooks.slots[index] = { deps, cleanup: effect() };
      });
    }
  },
}));

type Args = Parameters<typeof useBotPerformance>;
function render(timeframe: Args[2], botId = 'EXAMPLE', wallet = 'EXAMPLE', open = true) {
  hooks.cursor = 0;
  return useBotPerformance(open, botId, timeframe, wallet);
}
function commitEffects() {
  hooks.effects.splice(0).forEach(effect => effect());
}
const requests: Array<{ url: string; resolve: (value: Response) => void; reject: (reason: Error) => void }> = [];
function select(timeframe: Args[2], botId = 'EXAMPLE', wallet = 'EXAMPLE', open = true) {
  const view = render(timeframe, botId, wallet, open);
  commitEffects();
  return view;
}
async function finish(index: number, count: number, incomplete = 0) {
  requests[index].resolve({ ok: true, text: async () => JSON.stringify({
    series: [{ timestamp: `period-${count}`, pnl: count, cumulativePnl: count }],
    totalPnl: count, tradeCount: count, accountingIncompleteCloseCount: incomplete,
  }) } as Response);
  // Drain the actual fetch + response-body promises, without polling state.
  await new Promise<void>(resolve => setImmediate(resolve));
}
function expectUnavailable(view: ReturnType<typeof useBotPerformance>, loading = true) {
  expect(view.series).toEqual([]);
  expect(view.tradeCount).toBeNull();
  expect(view.totalPnl).toBeNull();
  expect(view.loading).toBe(loading);
}

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.effects = []; requests.length = 0;
  vi.stubGlobal('fetch', vi.fn((url: string) => new Promise<Response>((resolve, reject) => {
    requests.push({ url, resolve, reject });
  })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  hooks.slots.forEach(slot => slot?.cleanup?.());
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('bot performance response identity', () => {
  it('retains matching last good data marked stale after network and HTTP refresh failures', async () => {
    select('7d'); await finish(0, 7, 2);
    const good = render('7d');
    expect(good.stale).toBe(false);
    let refresh = good.refresh();
    expect(render('7d')).toMatchObject({ series: good.series, tradeCount: 7, totalPnl: 7, loading: true, stale: true });
    expect(panel(render('7d')).testIds).toContain('performance-chart');
    expect(panel(render('7d')).text).toContain('Refreshing performance');
    requests[1].reject(new Error('EXAMPLE'));
    await refresh;
    let view = render('7d');
    expect(view).toMatchObject({ series: good.series, tradeCount: 7, totalPnl: 7, loading: false, stale: true, accountingIncompleteCloseCount: 2 });
    expect(panel(view).text).toContain('Refresh failed. Showing last successful chart and trades (stale).');
    expect(panel(view).testIds).toContain('performance-chart');
    refresh = view.refresh();
    requests[2].resolve({ ok: false, status: 500 } as Response);
    await refresh;
    expect(render('7d')).toMatchObject({ series: good.series, tradeCount: 7, totalPnl: 7, loading: false, stale: true });
    refresh = render('7d').refresh();
    await finish(3, 9); await refresh;
    view = render('7d');
    expect(view).toMatchObject({ tradeCount: 9, totalPnl: 9, stale: false });
    expect(panel(view).testIds).not.toContain('performance-stale');
    // Carrying a restriction through a new identity must not relabel its data.
    select('30d');
    requests[4].resolve({ ok: false, status: 500 } as Response);
    await new Promise<void>(resolve => setImmediate(resolve));
    expectUnavailable(render('30d'), false);
    expect(render('30d').stale).toBe(false);
  });

  it('renders loading labels during initial load and period switches, reserving unavailable for failure', async () => {
    function expectLoading(view: ReturnType<typeof useBotPerformance>) {
      const rendered = panel(view);
      expect(view.loading).toBe(true);
      expect(rendered.text).toContain('Loading performance');
      expect(rendered.text).toContain('Loading trades');
      expect(rendered.text).toContain('Loading PnL');
      expect(rendered.text).not.toMatch(/Performance unavailable|Trades unavailable|PnL unavailable|No executed trades yet/);
    }
    expectLoading(select('7d'));
    await finish(0, 7);
    expectLoading(select('30d')); // Before the passive effect's state update.
    expectLoading(render('30d')); // Fetch in flight.
    requests[1].reject(new Error('EXAMPLE'));
    await new Promise<void>(resolve => setImmediate(resolve));
    const failure = panel(render('30d')).text;
    expect(failure).toContain('Performance unavailable');
    expect(failure).toContain('Trades unavailable');
    expect(failure).not.toContain('Loading');
    select('90d');
    requests[2].resolve({ ok: true, text: async () => JSON.stringify({ series: [], totalPnl: 0, tradeCount: 0 }) } as Response);
    await new Promise<void>(resolve => setImmediate(resolve));
    const zero = panel(render('90d')).text;
    expect(zero).toContain('No executed trades yet');
    expect(zero).toContain('0 trades');
    expect(zero).not.toMatch(/Loading|unavailable/);
    expect(drawerSource).toContain('performanceLoading={performanceLoading}');
  });

  it('keeps the accounting notice visible through pending and failed requests until the restriction clears', async () => {
    select('7d'); await finish(0, 7, 2);
    function expectRestriction(view: ReturnType<typeof useBotPerformance>) {
      expect(view.accountingIncompleteCloseCount).toBe(2);
      expect(panel(view).testIds).toContain('performance-accounting-incomplete');
      expect(panel(view).text).toContain('2 confirmed closes excluded because venue PnL is unavailable. The displayed total is partial.');
    }
    expectRestriction(render('7d'));
    expectRestriction(select('30d'));
    expectRestriction(render('30d'));
    requests[1].reject(new Error('EXAMPLE'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expectRestriction(render('30d'));
    const refresh = render('30d').refresh();
    await finish(2, 30, 0); await refresh;
    expect(render('30d').accountingIncompleteCloseCount).toBe(0);
    expect(panel(render('30d')).testIds).not.toContain('performance-accounting-incomplete');
  });

  it('keeps the 90d response when 30d resolves last and hides the old count immediately while pending', async () => {
    select('7d');
    await finish(0, 7);
    expect(render('7d').tradeCount).toBe(7);
    // This is the render before the 30d effect; no stale seven-day values may escape.
    expectUnavailable(select('30d'));
    expectUnavailable(select('90d'));
    expect(requests.map(request => request.url)).toEqual([
      '/api/trading-bots/EXAMPLE/performance?timeframe=7d&wallet=EXAMPLE',
      '/api/trading-bots/EXAMPLE/performance?timeframe=30d&wallet=EXAMPLE',
      '/api/trading-bots/EXAMPLE/performance?timeframe=90d&wallet=EXAMPLE',
    ]);
    await finish(2, 90);
    expect(render('90d')).toMatchObject({ tradeCount: 90, totalPnl: 90, loading: false });
    await finish(1, 30, 3);
    expect(render('90d')).toMatchObject({
      tradeCount: 90, totalPnl: 90, loading: false, accountingIncompleteCloseCount: 0,
      series: [{ timestamp: 'period-90', pnl: 90, cumulativePnl: 90 }],
    });
  });

  it('does not stop the current loading state when an obsolete request finishes first', async () => {
    select('30d'); select('90d');
    await finish(0, 30);
    expectUnavailable(render('90d'));
    await finish(1, 0);
    expect(render('90d')).toMatchObject({ tradeCount: 0, totalPnl: 0, loading: false });
  });

  it('keeps values unavailable after failure instead of relabelling the previous count or inventing zero', async () => {
    select('7d'); await finish(0, 7, 2);
    select('90d');
    requests[1].reject(new Error('EXAMPLE'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expectUnavailable(render('90d'), false);
    // Pending/error must not clear a known accounting-incomplete sharing restriction.
    expect(render('90d').accountingIncompleteCloseCount).toBe(2);
  });

  it('ignores obsolete request failures after the selected response arrives', async () => {
    select('30d'); select('90d'); await finish(1, 90);
    requests[0].reject(new Error('EXAMPLE'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(render('90d')).toMatchObject({ tradeCount: 90, totalPnl: 90, loading: false });
    expect(console.error).not.toHaveBeenCalled();
  });

  it('binds responses to bot and wallet as well as timeframe', async () => {
    select('7d'); await finish(0, 7);
    expectUnavailable(select('7d', 'REDACTED'));
    expectUnavailable(select('7d', 'REDACTED', 'REDACTED'));
    await finish(2, 90);
    await finish(1, 30);
    expect(render('7d', 'REDACTED', 'REDACTED').tradeCount).toBe(90);
  });

  it('ignores an older refresh of the same period', async () => {
    select('7d');
    const refresh = render('7d').refresh();
    await finish(1, 9); await refresh;
    await finish(0, 7);
    expect(render('7d').tradeCount).toBe(9);
  });

  it('invalidates a response on close and starts fresh when reopened', async () => {
    select('7d'); select('7d', 'EXAMPLE', 'EXAMPLE', false);
    await finish(0, 7);
    expectUnavailable(select('7d'));
    await finish(1, 9);
    expect(render('7d').tradeCount).toBe(9);
  });
});

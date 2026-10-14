import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GridDirectionSignals, GridSignalButton } from '../../client/src/components/grid-planner/GridDirectionSignals';
import { computeWeeklyStructure } from '../../server/grid-planner/weekly-structure';
import { btcUtcWeekStart, BTC_TREND_WEEK_MS as WEEK } from '../../shared/grid-direction';
import type { GridSignals } from '../../shared/grid-signals';
import type { PlannerCandle } from '../../server/grid-planner/types';
const hooks = vi.hoisted(() => ({ value: null as unknown, writes: [] as unknown[],
  effect: undefined as (() => void | (() => void)) | undefined, dependencies: [] as unknown[] }));
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  useState: () => [hooks.value, (update: unknown) => {
    hooks.value = typeof update === 'function' ? update(hooks.value) : update; hooks.writes.push(hooks.value);
  }],
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => { hooks.effect = effect; hooks.dependencies = dependencies; },
}));
vi.mock('../../client/src/lib/queryClient', () => ({ walletAuthHeaders: () => ({ 'x-wallet-address': 'EXAMPLE' }) }));
vi.mock('../../client/src/components/grid-planner/GridDirectionBadge', () => ({ useGridDirectionSuggestion: () => null }));
const now = Date.UTC(2026, 9, 14), end = btcUtcWeekStart(now);
const candles: PlannerCandle[] = [70, 72, 90, 74, 76, 78, 80, 100, 82, 84, 83, 82].map((high, i) => ({
  time: end - (12 - i) * WEEK, open: 50, close: 50, high, low: [40, 39, 38, 37, 30, 37, 38, 39, 40, 35, 40, 41][i], volume: 1,
  provenance: { source: 'okx', venue: 'okx', basis: 'perp', proxy: 'direct', finality: 'finalized', timeSemantic: 'open_time' },
}));
const response = (): GridSignals => ({ market: 'BTC-PERP', serverNow: now, weekly: computeWeeklyStructure('BTC-PERP', candles, now),
  funding: { state: 'available', market: 'BTC-PERP', hourlyRate: 0.0001, basis: 'next-hour estimate', observedAt: now, expiresAt: now + 300_000 } });
const props = { active: true, identity: 'EXAMPLE', market: 'BTC-PERP', timeframe: '1h', regime: { state: 'unavailable' as const, reason: 'EXAMPLE' }, refresh: 0 };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); hooks.value = null; hooks.writes = []; hooks.effect = undefined; });

describe('signal row never edits direction', () => {
  it.each(['long', 'short'] as const)('fetches opposing and unavailable observations without changing chosen %s or fetching on expiry', async direction => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const intent = Object.freeze({ direction }), fetcher = vi.fn(async () => ({ ok: true, json: async () => response() }));
    vi.stubGlobal('fetch', fetcher);
    GridDirectionSignals(props); const cleanup = hooks.effect?.();
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(hooks.value).toEqual(response()); expect(intent.direction).toBe(direction);
      expect(fetcher).toHaveBeenCalledWith('/api/grid-planner/signals?market=BTC-PERP', expect.objectContaining({ method: 'GET', headers: { 'x-wallet-address': 'EXAMPLE' } }));
      await vi.advanceTimersByTimeAsync(300_000);
      expect(hooks.value).toMatchObject({ funding: { state: 'unavailable' }, weekly: { state: 'available' } });
      await vi.advanceTimersByTimeAsync(end + WEEK - now - 300_000);
      expect(hooks.value).toMatchObject({ funding: { state: 'unavailable' }, weekly: { state: 'unavailable' } });
      expect(intent.direction).toBe(direction); expect(fetcher).toHaveBeenCalledTimes(1);
      const source = readFileSync('client/src/components/grid-planner/GridDirectionSignals.tsx', 'utf8');
      expect(source).not.toMatch(/edit\(|setForm|setDirection|aria-pressed|disabled=/);
      const sheet = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
      const integration = sheet.match(/<GridDirectionSignals[^>]+\/>/)?.[0];
      expect(integration).not.toMatch(/on\w+=|side=|direction=/);
    } finally { if (typeof cleanup === 'function') cleanup(); }
  });
  it('clears and aborts the old wallet/market request, guarding its late response', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    let resolve: (value: unknown) => void = () => {};
    const fetcher = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise(r => { resolve = r; })); vi.stubGlobal('fetch', fetcher);
    GridDirectionSignals(props); expect(hooks.dependencies).toEqual([true, 'EXAMPLE', 'BTC-PERP', 0]);
    const cleanup = hooks.effect?.(); const signal = fetcher.mock.calls[0]?.[1]?.signal;
    if (typeof cleanup === 'function') cleanup(); expect(signal?.aborted).toBe(true);
    resolve({ ok: true, json: async () => response() }); await vi.advanceTimersByTimeAsync(0);
    expect(hooks.value).toBeNull();
    GridDirectionSignals({ ...props, identity: 'EXAMPLE_B', market: 'ETH-PERP', refresh: 1 });
    expect(hooks.dependencies).toEqual([true, 'EXAMPLE_B', 'ETH-PERP', 1]);
  });
  it.each(['http', 'invalid', 'network'])('shows explicit unavailable after %s failure and never synthesizes a zero funding rate', async failure => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network') throw Error('EXAMPLE');
      return { ok: failure !== 'http', json: async () => ({ ...response(), market: 'ETH-PERP' }) };
    }));
    GridDirectionSignals(props); const cleanup = hooks.effect?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(hooks.value).toMatchObject({ weekly: { state: 'unavailable', reason: expect.any(String) }, funding: { state: 'unavailable', reason: expect.any(String) } });
    if (typeof cleanup === 'function') cleanup();
  });
  it('renders four independent buttons and preserves a working weekly signal when funding is unavailable', () => {
    hooks.value = { ...response(), funding: { state: 'unavailable', reason: 'EXAMPLE quota' } };
    const element = GridDirectionSignals(props);
    const children = element.props.children;
    expect(children).toHaveLength(4);
    expect(children.map((c: { props: { signal: { name: string } } }) => c.props.signal.name)).toEqual(['Macro', 'Weekly structure', 'Trend', 'Funding']);
    expect(children[1].props.signal.direction).toBe('long');
    expect(children[3].props.signal).toMatchObject({ unavailable: true, direction: 'neutral', detail: 'EXAMPLE quota' });
  });
});

describe('accessible hover, keyboard and touch popovers', () => {
  it('uses a labelled native button; mouse hover opens, touch does not depend on hover, and Radix toggling stays open until dismissed', async () => {
    vi.useFakeTimers(); hooks.value = false;
    const tree = GridSignalButton({ signal: { name: 'Funding', direction: 'neutral', unavailable: true, summary: 'Unavailable', detail: 'EXAMPLE quota', basis: 'Pacifica /info; as-of unavailable.' } });
    const trigger = tree.props.children[0].props.children;
    expect(trigger.type).toBe('button'); expect(trigger.props.type).toBe('button');
    expect(trigger.props['aria-label']).toContain('Funding: Unavailable'); expect(trigger.props.disabled).toBeUndefined();
    trigger.props.onPointerEnter({ pointerType: 'mouse' }); expect(hooks.value).toBe(true);
    trigger.props.onPointerLeave(); await vi.advanceTimersByTimeAsync(150); expect(hooks.value).toBe(false);
    trigger.props.onPointerEnter({ pointerType: 'touch' }); expect(hooks.value).toBe(false);
    tree.props.onOpenChange(true); trigger.props.onPointerLeave(); await vi.advanceTimersByTimeAsync(150); expect(hooks.value).toBe(true);
    tree.props.onOpenChange(false); expect(hooks.value).toBe(false);
    const content = tree.props.children[1]; expect(content.props['aria-label']).toContain('Funding signal details');
    expect(content.props.children.at(-1).props.children).toContain('Choose either direction');
  });
});

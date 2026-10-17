import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { GridPlannerSheet } from '../../client/src/components/grid-planner/GridPlannerSheet';

const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], stateIndex: 0, refIndex: 0,
  effects: [] as (() => void | (() => void))[] }));
// Execute the sheet's hooks without mounting the chart or starting market requests.
vi.mock('react', async () => ({ ...await vi.importActual<typeof import('react')>('react'),
  useState: (initial: unknown) => {
    const i = hooks.stateIndex++;
    if (!(i in hooks.states)) hooks.states[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks.states[i], (value: unknown) => { hooks.states[i] = typeof value === 'function' ? value(hooks.states[i]) : value; }];
  },
  useRef: (initial: unknown) => { const i = hooks.refIndex++; return hooks.refs[i] ??= { current: initial }; },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useMemo: (calculate: () => unknown) => calculate(), useCallback: (callback: unknown) => callback,
}));
vi.mock('../../client/src/components/grid-planner/GridPlannerChart', () => ({ GridPlannerChart: () => null }));

function render(identity = 'EXAMPLE') {
  hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effects = [];
  return GridPlannerSheet({ open: true, identity, onOpenChange: vi.fn() });
}
function feeInput(node: unknown): ReactElement<{ id: string; value: string; onChange: (event: { target: { value: string } }) => void }> | null {
  if (Array.isArray(node)) { for (const child of node) { const found = feeInput(child); if (found) return found; } return null; }
  if (!node || typeof node !== 'object' || !('props' in node)) return null;
  const element = node as ReactElement<{ id?: string; children?: unknown }>;
  if (element.props.id === 'grid-feePercent') return element as ReturnType<typeof feeInput>;
  return feeInput(element.props.children);
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
beforeEach(() => { hooks.states = []; hooks.refs = []; });
afterEach(() => vi.unstubAllGlobals());

describe('planner fee input lifecycle', () => {
  it.each([
    [{ fee: { rate: '0.00012', tier: '2', source: 'account' } }, '0.012'],
    [{ fee: { rate: '0.00015', tier: '1', source: 'published' } }, '0.015'],
    [{ fee: null }, ''],
  ])('prefills the editable field from %j', async (body, expected) => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => body })); vi.stubGlobal('fetch', fetch);
    render(); hooks.effects[0](); await flush();
    expect(fetch).toHaveBeenCalledWith('/api/exchange/planner-fee', expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }));
    expect(feeInput(render())?.props.value).toBe(expected);
    feeInput(render())!.props.onChange({ target: { value: '0.02' } });
    expect(feeInput(render())?.props.value).toBe('0.02');
  });
  it('keeps a user edit made while the account read is pending', async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done; })));
    render(); hooks.effects[0]();
    feeInput(render())!.props.onChange({ target: { value: '' } });
    resolve({ ok: true, json: async () => ({ fee: { rate: '0.00012', tier: '2', source: 'account' } }) });
    await flush(); expect(feeInput(render())?.props.value).toBe('');
  });
  it('discards a previous owner’s response after cleanup and clears the old fee', async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done; })));
    render(); const cleanup = hooks.effects[0]();
    feeInput(render())!.props.onChange({ target: { value: '0.02' } });
    if (typeof cleanup === 'function') cleanup();
    resolve({ ok: true, json: async () => ({ fee: { rate: '0', tier: 'VIP 1', source: 'account' } }) });
    await flush(); expect(feeInput(render('EXAMPLE second owner'))?.props.value).toBe('0.02');
    // New owner's effect clears the retained form before accepting its own result.
    hooks.effects[0](); expect(feeInput(render('EXAMPLE second owner'))?.props.value).toBe('');
  });
  it('uses the published fallback on a failed account request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('EXAMPLE'); }));
    render(); hooks.effects[0](); await flush(); expect(feeInput(render())?.props.value).toBe('0.015');
  });
});

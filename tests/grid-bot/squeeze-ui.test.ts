import { it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { GridSqueezeNotice } from '../../client/src/components/grid-planner/GridSimpleSqueeze';
import type { GridSqueeze } from '../../shared/grid-squeeze';

const value: GridSqueeze = { state: 'available', market: 'BTC-PERP', squeezed: true, bandwidth: 0.04, percentile: 0.1,
  historyDays: 365, latestFinalizedTime: Date.UTC(2026, 9, 21), retrievedAt: Date.UTC(2026, 9, 22), validForMs: 300000 };
it('shows only the plain advisory for a squeezed current market', () => {
  const render = (v: GridSqueeze | null, market = 'BTC-PERP') => renderToStaticMarkup(createElement(GridSqueezeNotice, { value: v, market }));
  expect(render(value)).toContain('This market is unusually quiet right now. Grids often get stopped out when it breaks, so waiting may be better.');
  expect(render(value)).not.toMatch(/Bollinger|bandwidth|percentile|0\.04|0\.1|365/);
  expect(render({ ...value, squeezed: false })).toBe('');
  expect(render({ state: 'unavailable', reason: 'EXAMPLE' })).toBe('');
  expect(render(null)).toBe(''); expect(render(value, 'ETH-PERP')).toBe('');
});
it('mounts only above Simple Review and never changes launch admission', () => {
  const source = readFileSync('client/src/components/grid-planner/GridPlannerSheet.tsx', 'utf8');
  const simple = source.slice(source.indexOf('const renderSimple ='), source.indexOf('const renderSetup ='));
  expect(simple).toContain('<GridSimpleSqueeze market={form.market} identity={identity} open={open}');
  expect(simple.indexOf('<GridSimpleSqueeze')).toBeLessThan(simple.indexOf('Review bot'));
  expect(source.match(/<GridSimpleSqueeze /g)).toHaveLength(1);
  expect(readFileSync('client/src/components/grid-bot/GridDraftActions.tsx', 'utf8')).not.toMatch(/squeeze/i);
});

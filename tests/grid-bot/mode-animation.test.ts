import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GRID_BEHAVIOUR_MODES, gridBehaviourCopy, gridCyclePair, gridOneShotOwners } from '../../shared/grid-behaviour';
import { GRID_SETUP_INITIAL } from '../../client/src/lib/grid-setup-view';
import { GRID_ANIMATION_DURATION, GRID_ANIMATION_TIMING, gridAnimationFrame, gridAnimationModel } from '../../client/src/lib/grid-mode-animation';
import { GridModeAnimationScene } from '../../client/src/components/grid-planner/GridModeAnimation';

describe('Rule-driven grid animation', () => {
  it.each(GRID_BEHAVIOUR_MODES)('%s darkens only product one-shot owners, with custom geometry too', mode => {
    for (const side of ['long', 'short'] as const) for (const lines of [undefined, [60, 65, 80, 91, 100, 109, 120, 135, 140]]) {
      const model = gridAnimationModel({ mode, side, lines });
      const profits = model.owners.filter(owner => !owner.opening).map(owner => owner.ownerOrdinal);
      const expected = gridOneShotOwners(mode, profits, model.prices.length - 1, side === 'long');
      const end = gridAnimationFrame(model, GRID_ANIMATION_DURATION);
      expect(end.states.flatMap((state, i) => state === 'dark' ? [i] : [])).toEqual(expected);
      expect([...model.once]).toEqual(expected);
    }
  });
  it.each(GRID_BEHAVIOUR_MODES)('%s mirrors prices, pairs, states and fill sides for shorts', mode => {
    const long = gridAnimationModel({ mode, side: 'long' }), short = gridAnimationModel({ mode, side: 'short' });
    for (const t of [0, .25, .5, .75, 1]) {
      const elapsed = GRID_ANIMATION_TIMING.intro + t * GRID_ANIMATION_TIMING.run;
      expect(short.price(t)).toBeCloseTo(2 * long.reference - long.price(t));
      expect(gridAnimationFrame(short, elapsed).states).toEqual(gridAnimationFrame(long, elapsed).states.reverse());
    }
    expect(short.fills.map(fill => fill.label)).toEqual(long.fills.map(fill => fill.label === 'SELL' ? 'BUY' : 'SELL'));
    for (const model of [long, short]) for (const owner of model.owners) {
      expect(owner.closingOrdinal - owner.openingOrdinal).toBe(model.side === 'long' ? 1 : -1);
    }
  });
  it.each(GRID_BEHAVIOUR_MODES)('%s seed-off never closes invented inventory and leaves once-only owners unused', mode => {
    for (const side of ['long', 'short'] as const) {
      const model = gridAnimationModel({ mode, side, seed: false });
      expect(model.fills.every(fill => fill.leg === 'opening' && fill.at > model.peak)).toBe(true);
      for (const elapsed of [0, GRID_ANIMATION_TIMING.intro + 2000, GRID_ANIMATION_DURATION]) {
        const frame = gridAnimationFrame(model, elapsed);
        expect(frame.states.flatMap((state, i) => state === 'unused' ? [i] : [])).toEqual([...model.once]);
        if (elapsed === 0) expect(frame.pending.every(order => order.leg === 'opening')).toBe(true);
      }
    }
  });
  it('uses shipped defaults and shares the unchanged planner pairing arithmetic', () => {
    const model = gridAnimationModel();
    expect(model.mode).toBe(GRID_SETUP_INITIAL.behaviourMode);
    expect(model.prices).toHaveLength(Number(GRID_SETUP_INITIAL.intervals) + 1);
    expect(gridCyclePair(3, true, true)).toEqual({ openingOrdinal: 3, closingOrdinal: 4 });
    expect(gridCyclePair(4, false, true)).toEqual({ openingOrdinal: 3, closingOrdinal: 4 });
    expect(gridCyclePair(4, true, false)).toEqual({ openingOrdinal: 4, closingOrdinal: 3 });
    expect(gridCyclePair(3, false, false)).toEqual({ openingOrdinal: 4, closingOrdinal: 3 });
  });
  it('starts tags at their exact fill crossing, fading in, and shows hollow waiting rings', () => {
    const model = gridAnimationModel({ mode: 'repeat_all' });
    for (const fill of model.fills) {
      const when = GRID_ANIMATION_TIMING.intro + fill.at * GRID_ANIMATION_TIMING.run;
      const matches = (tag: typeof fill) => tag.ownerOrdinal === fill.ownerOrdinal && tag.leg === fill.leg;
      expect(model.price(fill.at)).toBeCloseTo(model.prices[fill.ordinal]);
      expect(gridAnimationFrame(model, when - 1).tags.some(matches)).toBe(false);
      const exact = gridAnimationFrame(model, when + .001).tags.find(matches)!;
      expect(exact.opacity).toBeGreaterThan(0); expect(exact.opacity).toBeLessThan(.1);
      expect(gridAnimationFrame(model, when + 180).tags.find(matches)!.opacity).toBeGreaterThan(exact.opacity);
    }
    const html = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed: 0 }));
    expect(html).toContain('data-waiting-order='); expect(html).toContain('fill="none"');
    expect(html).toContain(gridBehaviourCopy(model.mode, model.side, model.seed).hint);
    expect(html).not.toContain('Recommended'); expect(html).not.toContain('<title'); expect(html).not.toMatch(/<text[^>]*>\d/);
  });
  it('contains no retired media URLs or assets in the client', () => {
    const retiredUrl = ['', 'grid-modes', ''].join('/');
    const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(join(path, entry.name)) : /\.(?:tsx?|css|html)$/.test(entry.name) ? [join(path, entry.name)] : []);
    for (const path of walk('client/src')) expect(readFileSync(path, 'utf8'), path).not.toContain(retiredUrl);
    const assets = join('client', 'public', 'grid-modes'); expect(existsSync(assets) ? readdirSync(assets) : []).toEqual([]);
  });
});

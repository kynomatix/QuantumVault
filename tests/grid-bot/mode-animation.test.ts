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
  it.each(GRID_BEHAVIOUR_MODES)('%s morphs colours, brightness and glow on the shared fill clock', mode => {
    for (const side of ['long', 'short'] as const) {
      const model = gridAnimationModel({ mode, side });
      for (const fill of model.fills.filter(fill => !model.owners.find(owner => owner.ownerOrdinal === fill.ownerOrdinal)!.opening)) {
        const owner = model.owners.find(owner => owner.ownerOrdinal === fill.ownerOrdinal)!;
        const look = (age: number) => gridAnimationFrame(model, fill.timeMs + age).looks[fill.ownerOrdinal];
        const closing = fill.leg === 'closing';
        expect(look(0).active).toBe(closing ? 1 : 0);
        expect(look(70).active).toBeCloseTo(closing ? .84375 : .15625);
        expect(look(140).active).toBeCloseTo(.5);
        expect(look(280).active).toBe(closing ? 0 : 1);
        const mutedGlow = owner.recycles ? .15 : 0;
        expect(look(140).glow).toBeCloseTo((1 + mutedGlow) / 2);
        expect(look(280).glow).toBe(closing ? mutedGlow : 1);
        expect(look(140).opacity).toBeCloseTo(owner.recycles ? .7 : .75);
        const html = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed: fill.timeMs + 140 }));
        expect(html).toContain(`color-mix(in srgb, rgb(var(--grid-animation-active)) 50%, rgb(var(--grid-animation-${owner.recycles ? 'waiting' : 'out'})))`);
      }
    }
  });
  it('leaves seed-off one-shot lines unlit and eases cycling lines back from waiting', () => {
    const model = gridAnimationModel({ seed: false, mode: 'top_once' });
    for (const elapsed of [0, 3000, GRID_ANIMATION_DURATION]) {
      const frame = gridAnimationFrame(model, elapsed);
      for (const ordinal of model.once) expect(frame.looks[ordinal]).toMatchObject({ muted: 'unused', active: 0, glow: 0 });
    }
    const fill = model.fills.find(fill => !model.owners.find(owner => owner.ownerOrdinal === fill.ownerOrdinal)!.opening)!;
    const look = gridAnimationFrame(model, fill.timeMs + 140).looks[fill.ownerOrdinal];
    expect(look.active).toBe(.5); expect(look.glow).toBeCloseTo(.575);
  });
  it('keeps overlapping fades continuous for custom grids', () => {
    const model = gridAnimationModel({ lines: [90, 100, 101, 109, 110], mode: 'repeat_all' });
    for (const owner of model.owners.filter(owner => Number.isFinite(owner.openTimeMs))) {
      const before = gridAnimationFrame(model, owner.openTimeMs - .000001).looks[owner.ownerOrdinal];
      const exact = gridAnimationFrame(model, owner.openTimeMs).looks[owner.ownerOrdinal];
      expect(before.active).toBeCloseTo(exact.active, 6);
    }
  });
  it('uses one bounded glow group with crisp text and path, including static end states', () => {
    for (const mode of GRID_BEHAVIOUR_MODES) {
      const model = gridAnimationModel({ mode });
      const html = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed: GRID_ANIMATION_DURATION }));
      expect(html.match(/filter="url/g)).toHaveLength(1);
      expect(html.match(/<feGaussianBlur/g)).toHaveLength(1);
      expect(html).toContain('filterUnits="userSpaceOnUse"');
      expect(html).toContain('shape-rendering="geometricPrecision"');
      expect(html).toContain('stroke-linejoin="round"');
      expect(html).toContain('<linearGradient'); expect(html.match(/<radialGradient/g)).toHaveLength(2);
      const glow = html.split('data-glow="true"')[1].split('</g>')[0];
      expect(glow).not.toContain('<text'); expect(glow).toContain('opacity=".6"');
      expect(gridAnimationFrame(model, GRID_ANIMATION_DURATION).sceneOpacity).toBe(1);
    }
  });
  it('shows a signed one-decimal percentage relative to Start, without negative zero', () => {
    for (const start of [100, 200]) for (const side of ['long', 'short'] as const) {
      const model = gridAnimationModel({ start, lines: [start - 10, start - 5, start, start + 5, start + 10], side });
      const frame = gridAnimationFrame(model, GRID_ANIMATION_TIMING.intro + 2000);
      const expected = `${side === 'long' ? '+' : '\u2212'}${Math.abs((frame.price - start) / start * 100).toFixed(1)}%`;
      expect(frame.readout).toBe(expected);
      const html = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed: GRID_ANIMATION_TIMING.intro + 2000 }));
      expect(html).toContain(`>${expected}</text>`); expect(html).not.toContain('>Price<');
      expect(gridAnimationFrame(model, 0).readout).toBe('+0.0%');
    }
  });
  it('eases the playing scene in over 900 ms and holds the complete end for 1600 ms', () => {
    const model = gridAnimationModel();
    expect(gridAnimationFrame(model, 0).sceneOpacity).toBe(0);
    expect(gridAnimationFrame(model, 225).sceneOpacity).toBeCloseTo(.15625);
    expect(gridAnimationFrame(model, 450).sceneOpacity).toBe(.5);
    expect(gridAnimationFrame(model, 900).sceneOpacity).toBe(1);
    const hold = gridAnimationFrame(model, GRID_ANIMATION_DURATION - 1600), end = gridAnimationFrame(model, GRID_ANIMATION_DURATION);
    expect(hold.progress).toBe(1); expect(hold.price).toBe(end.price);
    // The last 168 ms tag / 280 ms state morph may finish during the hold.
    expect(hold.sceneOpacity).toBe(1); expect(end.sceneOpacity).toBe(1);
    const idle = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed: 0 }));
    const playing = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed: 0, reveal: true }));
    expect(idle).toContain('data-scene="true" opacity="1"');
    expect(playing).toContain('data-scene="true" opacity="0"');
  });
  it('spreads portrait grid geometry vertically with larger undistorted text and rings', () => {
    for (const side of ['long', 'short'] as const) {
      const model = gridAnimationModel({ side, mode: 'repeat_all' });
      const elapsed = model.fills[2].timeMs + 30;
      const wide = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed }));
      const tall = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed, portraitHeight: 1200, fit: true }));
      expect(wide).toContain('viewBox="0 0 640 360"');
      expect(tall).toContain('viewBox="0 0 640 1200"');
      expect(tall).toContain('preserveAspectRatio="xMidYMid meet"');
      expect(tall).toContain('M100,1148H552');
      expect(tall).toContain('M100,60H552');
      expect(tall).toContain('font-size="28">Start');
      expect(tall).toContain(`font-size="28">${gridAnimationFrame(model, elapsed).readout}`);
      expect(tall).toContain('font-size="28" font-weight="600"');
      expect(tall).toContain('r="6" fill="none"');
      expect(tall.match(/data-state="[^"]+"/g)).toEqual(wide.match(/data-state="[^"]+"/g));
      expect(tall.match(/data-fill="[^"]+"/g)).toEqual(wide.match(/data-fill="[^"]+"/g));
      expect(tall.match(/data-waiting-order="[^"]+"/g)).toEqual(wide.match(/data-waiting-order="[^"]+"/g));
    }
  });
  it('labels the model start line and mirrors its height for shorts, including custom starts', () => {
    for (const start of [100, 96]) {
      const labels = (['long', 'short'] as const).map(side => {
        const model = gridAnimationModel({ side, start: side === 'long' ? start : 200 - start });
        const expectedY = 282 - 224 * (model.reference - model.prices[0]) / (model.prices.at(-1)! - model.prices[0]);
        for (const elapsed of [0, GRID_ANIMATION_TIMING.intro + 2000, GRID_ANIMATION_DURATION]) {
          const html = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed }));
          expect(html.match(/>Start<\/text>/g)).toHaveLength(1);
          expect(html).toContain(`<text x="60" y="${expectedY}" text-anchor="end" dominant-baseline="middle" fill="hsl(var(--muted-foreground))" font-size="14">Start</text>`);
          expect(html).toContain(`M72,${expectedY}H552`);
        }
        return expectedY;
      });
      expect(labels[0] + labels[1]).toBeCloseTo(340);
    }
  });
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
  it('matches v5 full-opacity arrival, hold, fade and 3%-of-run lifetime', () => {
    const model = gridAnimationModel({ mode: 'repeat_all' });
    // modes_anim.py:83,150,233: 0.03 * 5600 ms, with the first 35% at opacity 1.
    expect(GRID_ANIMATION_TIMING.tagLife).toBe(168);
    for (const fill of model.fills) {
      const when = fill.timeMs;
      const matches = (tag: typeof fill) => tag.ownerOrdinal === fill.ownerOrdinal && tag.leg === fill.leg;
      expect(model.price(fill.at)).toBeCloseTo(model.prices[fill.ordinal]);
      expect(gridAnimationFrame(model, when - 1).tags.some(matches)).toBe(false);
      expect(gridAnimationFrame(model, when).tags.find(matches)!.opacity).toBe(1);
      expect(gridAnimationFrame(model, when + 50).tags.find(matches)!.opacity).toBe(1);
      expect(gridAnimationFrame(model, when + 58.8).tags.find(matches)!.opacity).toBeCloseTo(1);
      expect(gridAnimationFrame(model, when + 113.4).tags.find(matches)!.opacity).toBeCloseTo(.5);
      expect(gridAnimationFrame(model, when + 167).tags.find(matches)!.opacity).toBeLessThan(.01);
      expect(gridAnimationFrame(model, when + 168).tags.some(matches)).toBe(false);
      expect(gridAnimationFrame(model, when + 200).tags.some(matches)).toBe(false);
    }
  });
  it.each(GRID_BEHAVIOUR_MODES)('%s flips tags and owner states on the same exact event time', mode => {
    for (const side of ['long', 'short'] as const) for (const seed of [true, false]) {
      const model = gridAnimationModel({ mode, side, seed });
      for (const fill of model.fills) {
        const owner = model.owners.find(row => row.ownerOrdinal === fill.ownerOrdinal)!;
        expect(fill.timeMs).toBe(fill.leg === 'closing' ? owner.closeTimeMs : owner.openTimeMs);
        const before = gridAnimationFrame(model, fill.timeMs - .000001);
        const exact = gridAnimationFrame(model, fill.timeMs);
        const matches = (tag: typeof fill) => tag.ownerOrdinal === fill.ownerOrdinal && tag.leg === fill.leg;
        expect(before.tags.some(matches)).toBe(false);
        expect(exact.tags.find(matches)!.opacity).toBe(1);
        // Profit-side owners change state at both fills; opening owners stay active.
        if (!owner.opening) {
          expect(before.states[owner.ownerOrdinal]).toBe(fill.leg === 'closing' ? 'active' : 'waiting');
          expect(exact.states[owner.ownerOrdinal]).toBe(fill.leg === 'closing' ? (owner.recycles ? 'waiting' : 'dark') : 'active');
        }
      }
    }
  });
  it('keeps tags at the v5 fill point while fading, and removes them before +200 ms', () => {
    for (const side of ['long', 'short'] as const) {
      const model = gridAnimationModel({ mode: 'repeat_all', side });
      for (const fill of model.fills) {
        const later = gridAnimationFrame(model, fill.timeMs + 100);
        const tag = later.tags.find(row => row.ownerOrdinal === fill.ownerOrdinal && row.leg === fill.leg)!;
        expect(tag.at).toBe(fill.at); expect(tag.ordinal).toBe(fill.ordinal);
        expect(later.progress).toBeGreaterThan(tag.at); expect(tag.opacity).toBeLessThan(1);
        const html = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed: fill.timeMs + 100 }));
        const fillY = 282 - 224 * (model.prices[fill.ordinal] - model.prices[0]) / (model.prices.at(-1)! - model.prices[0]);
        expect(html).toContain(`<rect x="${72 + 480 * fill.at - 62}" y="${fillY - 11}"`);
        expect(gridAnimationFrame(model, fill.timeMs + 200).tags.some(row => row.timeMs === fill.timeMs)).toBe(false);
      }
    }
  });
  it('paints all hollow rings above fill brackets and labels throughout the tag lifetime', () => {
    for (const side of ['long', 'short'] as const) {
      const model = gridAnimationModel({ mode: 'repeat_all', side });
      for (const fill of model.fills) for (const age of [0, 50, 100, 167]) {
        const html = renderToStaticMarkup(createElement(GridModeAnimationScene, { model, elapsed: fill.timeMs + age }));
        expect(html).toContain('data-fill=');
        expect(html.indexOf('data-waiting-order=')).toBeGreaterThan(html.lastIndexOf('data-fill='));
        const rings = html.slice(html.indexOf('data-waiting-order='));
        expect(rings).not.toContain('<path'); expect(rings).not.toContain('<rect');
        expect(rings).toContain('r="4" fill="none"');
      }
    }
  });
  it('shows hollow waiting rings and accessible copy', () => {
    const model = gridAnimationModel({ mode: 'repeat_all' });
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

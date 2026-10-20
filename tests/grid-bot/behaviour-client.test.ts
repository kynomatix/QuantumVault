import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GridBehaviourSelect } from '../../client/src/components/grid-planner/GridBehaviourSelect';
import { GridModeAnimation, GridModeAnimationScene } from '../../client/src/components/grid-planner/GridModeAnimation';
import { GRID_ANIMATION_DURATION, gridAnimationFrame } from '../../client/src/lib/grid-mode-animation';
import { Dialog, DialogContent } from '../../client/src/components/ui/dialog';

// Real callbacks, controlled hooks/frame lifecycle: the product suite runs on Node.
type Effect = { deps?: unknown[]; run: () => void | (() => void); cleanup?: void | (() => void); pending: boolean };
type HookStore = { states: unknown[]; refs: { current: unknown }[]; effects: Effect[]; memos: { deps: unknown[]; value: unknown }[] };
const hooks = vi.hoisted(() => ({ store: null as HookStore | null, stateIndex: 0, refIndex: 0, effectIndex: 0, memoIndex: 0 }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useId: () => 'EXAMPLE-behaviour',
  useState: (initial: unknown) => {
    const store = hooks.store!, index = hooks.stateIndex++;
    if (!(index in store.states)) store.states[index] = typeof initial === 'function' ? initial() : initial;
    return [store.states[index], (next: unknown) => {
      store.states[index] = typeof next === 'function' ? next(store.states[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const store = hooks.store!, index = hooks.refIndex++;
    return store.refs[index] ?? (store.refs[index] = { current: initial });
  },
  useMemo: (calculate: () => unknown, deps: unknown[]) => {
    const store = hooks.store!, index = hooks.memoIndex++, old = store.memos[index];
    if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) store.memos[index] = { deps, value: calculate() };
    return store.memos[index].value;
  },
  useEffect: (run: Effect['run'], deps?: unknown[]) => {
    const store = hooks.store!, index = hooks.effectIndex++, old = store.effects[index];
    if (!old || !deps || deps.some((dep, i) => !Object.is(dep, old.deps?.[i]))) {
      if (old?.cleanup) old.cleanup();
      store.effects[index] = { run, deps, pending: true };
    }
  },
}));
type Element = ReactElement<Record<string, any>>;
const store = (): HookStore => ({ states: [], refs: [], effects: [], memos: [] });
function render<T>(hookStore: HookStore, component: () => T): T {
  hooks.store = hookStore; hooks.stateIndex = 0; hooks.refIndex = 0; hooks.effectIndex = 0; hooks.memoIndex = 0;
  const result = component();
  for (const effect of hookStore.effects) if (effect.pending) { effect.cleanup = effect.run(); effect.pending = false; }
  return result;
}
function pathTo(node: ReactNode, matches: (element: Element) => boolean): Element[] | undefined {
  if (!isValidElement<Element['props']>(node)) return;
  if (matches(node)) return [node];
  for (const child of Children.toArray(node.props.children)) { const path = pathTo(child, matches); if (path) return [node, ...path]; }
}
function find(node: ReactNode, matches: (element: Element) => boolean): Element {
  const path = pathTo(node, matches);
  if (!path) throw Error('Expected element missing');
  return path[path.length - 1];
}
function bubble(path: Element[], handler: string, extra = {}) {
  let stopped = false;
  const event = { ...extra, preventDefault: vi.fn(), stopPropagation: vi.fn(() => { stopped = true; }) };
  for (const element of [...path].reverse()) { element.props[handler]?.(event); if (stopped) break; }
  return event;
}

describe('Grid behaviour animation interactions', () => {
  let picker: HookStore, player: HookStore;
  let side: 'long' | 'short', seed: boolean, nextFrame: number;
  const onChange = vi.fn(), focus = vi.fn(), cancelFrame = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();
  const requestFrame = vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  const renderPicker = () => render(picker, () => GridBehaviourSelect({ value: 'repeat_all', side, seed, onChange }));
  const trigger = (tree: Element) => find(tree, element => 'aria-expanded' in element.props);
  const renderPlayer = (tree: Element) => {
    const animation = find(tree, element => element.type === GridModeAnimation && element.props.mode === 'repeat_all');
    return render(player, () => GridModeAnimation(animation.props));
  };
  const open = () => { trigger(renderPicker()).props.onClick(); return renderPicker(); };
  const scene = (tree: Element) => find(tree, element => element.type === GridModeAnimationScene);
  const button = (tree: Element) => find(tree, element => element.type === 'button');
  beforeEach(() => {
    vi.clearAllMocks(); frames.clear(); nextFrame = 0; side = 'long'; seed = true;
    picker = store(); player = store(); picker.refs.push({ current: { focus } });
    vi.stubGlobal('requestAnimationFrame', requestFrame); vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: false })) });
  });
  afterEach(() => {
    for (const effect of player.effects) if (effect.cleanup) effect.cleanup();
    vi.unstubAllGlobals();
  });
  const dialog = (tree: Element) => find(tree, element => element.type === Dialog);
  const content = (tree: Element) => find(tree, element => element.type === DialogContent);
  const enlarge = (tree: Element) => find(tree, element => element.props['aria-label']?.startsWith('Enlarge example'));
  it.each([false, true].flatMap(enlarged => [16, 33, 100, 250, 'jitter'].map(interval => ({ enlarged, interval }))))(
    'renders each fill through the real playback callback, resume and replay: $enlarged / $interval', ({ enlarged, interval }) => {
      let visibility: () => void;
      const page = { hidden: false, addEventListener: vi.fn((_name, callback) => { visibility = callback; }), removeEventListener: vi.fn() };
      vi.stubGlobal('document', page);
      vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
      const tree = open(), initial = renderPlayer(tree);
      initial.props.ref.current = {};
      if (enlarged) {
        dialog(initial).props.onOpenChange(true);
        const opened = renderPlayer(tree);
        find(content(opened), element => element.type === 'div' && typeof element.props.ref === 'function').props.ref({});
      } else button(initial).props.onClick();
      const current = () => {
        const rendered = renderPlayer(tree);
        return scene(enlarged ? content(rendered) : rendered).props;
      };
      const model = current().model;
      let wallTime = 0, random = 47;
      for (let playback = 0; playback < 2; playback++) {
        const arrivals: number[] = [];
        let paused = false, previous = 0, steps = 0;
        frames.get(nextFrame)!(wallTime);
        while (current().elapsed < GRID_ANIMATION_DURATION && steps++ < 2000) {
          random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
          wallTime += interval === 'jitter' ? 1 + random % 250 : Number(interval);
          frames.get(nextFrame)!(wallTime);
          const { elapsed } = current();
          const crossed = model.fills.filter((fill: { timeMs: number }) => fill.timeMs > previous && fill.timeMs <= elapsed);
          expect(crossed.length).toBeLessThanOrEqual(1);
          if (crossed.length) {
            expect(elapsed).toBe(crossed[0].timeMs);
            expect(gridAnimationFrame(model, elapsed).price).toBe(model.prices[crossed[0].ordinal]);
            arrivals.push(elapsed);
          }
          previous = elapsed;
          if (!paused && arrivals.length === 2) {
            page.hidden = true; visibility!();
            page.hidden = false; visibility!();
            wallTime += 10000;
            frames.get(nextFrame)!(wallTime);
            expect(current().elapsed).toBe(elapsed);
            paused = true;
          }
        }
        expect(current().elapsed).toBe(GRID_ANIMATION_DURATION);
        expect(arrivals).toEqual(model.fills.map((fill: { timeMs: number }) => fill.timeMs));
        expect(paused).toBe(true);
        if (playback === 0) {
          const rendered = renderPlayer(tree);
          button(enlarged ? content(rendered) : rendered).props.onClick();
          expect(current().elapsed).toBe(0);
        }
      }
    });
  it.each([16, 20, 21])('selects the soft glow only after 30 measured intervals averaging over 20 ms: %s', interval => {
    const tree = open(); button(renderPlayer(tree)).props.onClick();
    for (let i = 0; i < 30; i++) frames.get(i + 1)!(i * interval);
    expect(scene(renderPlayer(tree)).props.softGlow).toBe(false);
    frames.get(31)!(30 * interval);
    expect(scene(renderPlayer(tree)).props.softGlow).toBe(interval > 20);
  });
  it('uses filter-free soft glow for reduced motion, including the static end', () => {
    vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: true })) });
    const tree = open(), animation = renderPlayer(tree);
    expect(scene(animation).props.softGlow).toBe(true);
    expect(scene(animation).props.elapsed).toBe(GRID_ANIMATION_DURATION);
    expect(requestFrame).not.toHaveBeenCalled();
  });
  it('suspends off-screen and hidden playback without advancing the clock, and disconnects on unmount', () => {
    let intersection: (entries: { isIntersecting: boolean }[]) => void;
    let visibility: () => void;
    const disconnect = vi.fn(), observe = vi.fn(), removeEventListener = vi.fn();
    const page = { hidden: false, addEventListener: vi.fn((_name, callback) => { visibility = callback; }), removeEventListener };
    vi.stubGlobal('document', page);
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof intersection) { intersection = callback; }
      observe = observe; disconnect = disconnect;
    });
    const tree = open(), animation = renderPlayer(tree);
    animation.props.ref.current = {};
    button(animation).props.onClick(); renderPlayer(tree);
    frames.get(1)!(0); frames.get(2)!(100);
    intersection!([{ isIntersecting: false }]);
    expect(cancelFrame).toHaveBeenLastCalledWith(3);
    expect(scene(renderPlayer(tree)).props.elapsed).toBe(100);
    intersection!([{ isIntersecting: true }]);
    frames.get(4)!(5000); frames.get(5)!(5100);
    expect(scene(renderPlayer(tree)).props.elapsed).toBe(200);
    page.hidden = true; visibility!(); expect(cancelFrame).toHaveBeenLastCalledWith(6);
    page.hidden = false; visibility!(); frames.get(7)!(9000);
    expect(scene(renderPlayer(tree)).props.elapsed).toBe(200);
    for (const effect of player.effects) if (effect.cleanup) effect.cleanup();
    expect(disconnect).toHaveBeenCalled(); expect(removeEventListener).toHaveBeenCalledWith('visibilitychange', visibility!);
    expect(cancelFrame).toHaveBeenLastCalledWith(8);
  });
  it.each([[390, 844, true], [844, 390, false], [1280, 900, false], [768, 1024, true]])(
    'selects portrait geometry only in portrait viewports: %s x %s', (width, height, portrait) => {
      vi.stubGlobal('window', { matchMedia: vi.fn(query => ({ matches: query === '(orientation: portrait)' && height >= width })) });
      const tree = open(); dialog(renderPlayer(tree)).props.onOpenChange(true);
      const opened = renderPlayer(tree), large = scene(content(opened));
      expect(large.props.portraitHeight).toBe(portrait ? 960 : undefined);
      expect(scene(opened).props.portraitHeight).toBeUndefined();
      expect(content(opened).props.style.height).toBe(portrait
        ? 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 1rem)' : undefined);
      expect(button(content(opened)).props.className).not.toContain('absolute');
    });
  it('responds to rotation and measured drawing space, and cleans up both subscriptions', () => {
    const listeners: (() => void)[] = [];
    const media = { matches: false, addEventListener: vi.fn((_name, update) => listeners.push(update)), removeEventListener: vi.fn() };
    vi.stubGlobal('window', { matchMedia: vi.fn(query => query === '(orientation: portrait)' ? media : { matches: false }) });
    const observe = vi.fn(), disconnect = vi.fn();
    let resize: (entries: { contentRect: { width: number; height: number } }[]) => void;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: typeof resize) { resize = callback; }
      observe = observe;
      disconnect = disconnect;
    });
    const tree = open(); dialog(renderPlayer(tree)).props.onOpenChange(true);
    const opened = renderPlayer(tree);
    const drawing = find(content(opened), element => element.type === 'div' && !!element.props.ref);
    const node = { nodeName: 'DIV' };
    drawing.props.ref(node);
    media.matches = true; listeners[0](); renderPlayer(tree);
    expect(observe).toHaveBeenCalledWith(node);
    resize!([{ contentRect: { width: 348, height: 640 } }]);
    expect(scene(content(renderPlayer(tree))).props.portraitHeight).toBeCloseTo(640 * 640 / 348);
    media.matches = false; listeners[0]();
    expect(scene(content(renderPlayer(tree))).props.portraitHeight).toBeUndefined();
    expect(disconnect).toHaveBeenCalledOnce();
    for (const effect of player.effects) if (effect.cleanup) effect.cleanup();
    expect(media.removeEventListener).toHaveBeenCalledWith('change', listeners[0]);
  });
  it('offers labelled 44px Enlarge controls and opens without selecting or collapsing', () => {
    const tree = open(), animation = renderPlayer(tree);
    expect(enlarge(animation).props['aria-label']).toBe('Enlarge example animation: Keep trading the whole range');
    expect(enlarge(animation).props.className.split(' ')).toEqual(expect.arrayContaining(['h-11', 'w-11', 'right-1']));
    const cardPath = pathTo(tree, element => element.type === GridModeAnimation)!;
    const event = bubble([...cardPath.slice(0, -1), ...pathTo(animation, element => element.props['aria-label']?.startsWith('Enlarge example'))!], 'onClick');
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    dialog(animation).props.onOpenChange(true);
    const opened = renderPlayer(tree);
    expect(dialog(opened).props.open).toBe(true);
    expect(requestFrame).toHaveBeenCalledOnce();
    content(opened).props.onClick(event);
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger(renderPicker()).props['aria-expanded']).toBe(true);
  });
  it.each(['escape', 'close-or-overlay'])('%s closes only the dialog, cancels playback and restores Enlarge focus', method => {
    const tree = open();
    dialog(renderPlayer(tree)).props.onOpenChange(true);
    const opened = renderPlayer(tree), restore = vi.fn();
    enlarge(opened).props.ref.current = { focus: restore };
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    if (method === 'escape') {
      content(opened).props.onEscapeKeyDown(event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    } else dialog(opened).props.onOpenChange(false);
    content(opened).props.onCloseAutoFocus(event);
    expect(restore).toHaveBeenCalledOnce();
    expect(dialog(renderPlayer(tree)).props.open).toBe(false);
    expect(cancelFrame).toHaveBeenLastCalledWith(1);
    expect(trigger(renderPicker()).props['aria-expanded']).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    const bubbled = bubble([tree, content(opened)], 'onKeyDown', { key: 'Escape' });
    expect(bubbled.stopPropagation).toHaveBeenCalledOnce();
    expect(trigger(renderPicker()).props['aria-expanded']).toBe(true);
  });
  it('freezes the small scene while the enlarged scene plays, and never resumes on close', () => {
    const tree = open(); button(renderPlayer(tree)).props.onClick();
    frames.get(1)!(100); frames.get(2)!(1100);
    dialog(renderPlayer(tree)).props.onOpenChange(true);
    expect(cancelFrame).toHaveBeenLastCalledWith(3);
    frames.get(4)!(2000); frames.get(5)!(4000);
    const opened = renderPlayer(tree);
    expect(scene(opened).props.elapsed).toBe(1000);
    expect(scene(content(opened)).props.elapsed).toBe(scene(content(opened)).props.model.fills[0].timeMs);
    dialog(opened).props.onOpenChange(false);
    expect(cancelFrame).toHaveBeenLastCalledWith(6);
    expect(scene(renderPlayer(tree)).props.elapsed).toBe(1000);
    expect(requestFrame).toHaveBeenCalledTimes(6);
  });
  it('opens reduced-motion at the end state and plays only on explicit tap', () => {
    vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: true })) });
    const tree = open(); dialog(renderPlayer(tree)).props.onOpenChange(true);
    const opened = renderPlayer(tree);
    expect(scene(content(opened)).props.elapsed).toBe(GRID_ANIMATION_DURATION);
    expect(requestFrame).not.toHaveBeenCalled();
    button(content(opened)).props.onClick();
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(scene(content(renderPlayer(tree))).props.elapsed).toBe(0);
  });
  it('pauses other cards before starting playback', () => {
    const tree = open(); button(renderPlayer(tree)).props.onClick();
    const other = store();
    const otherTree = render(other, () => GridModeAnimation({ mode: 'step_back', side, seed }));
    button(otherTree).props.onClick();
    expect(cancelFrame).toHaveBeenLastCalledWith(1);
    for (const effect of other.effects) if (effect.cleanup) effect.cleanup();
    expect(cancelFrame).toHaveBeenLastCalledWith(2);
  });
  it.each([['long', true], ['short', true], ['long', false], ['short', false]] as const)(
    'mounts all animations only while expanded: %s, seed=%s', (direction, seeded) => {
      side = direction; seed = seeded;
      expect(pathTo(renderPicker(), element => element.type === GridModeAnimation)).toBeUndefined();
      const tree = open(), group = find(tree, element => element.props.role === 'radiogroup');
      expect(Children.toArray(group.props.children)).toHaveLength(3);
      for (const card of Children.toArray(group.props.children)) {
        const path = pathTo(card, element => element.type === GridModeAnimation)!;
        expect(path.at(-1)!.props).toMatchObject({ side, seed });
        expect(path.some(element => element.type === 'label')).toBe(false);
        expect(find(card, element => element.type === 'input').props['aria-describedby']).toMatch(/-hint$/);
      }
      const markup = renderToStaticMarkup(scene(renderPlayer(tree)));
      expect(markup).toContain('aspect-video w-full max-w-full'); expect(markup).toContain('Example animation:');
      expect(group.props.className).toContain('auto-rows-fr');
      trigger(tree).props.onClick();
      expect(pathTo(renderPicker(), element => element.type === GridModeAnimation)).toBeUndefined();
    });
  it.each([false, true])('never autoplays; tap/replay does not select or close, reduced motion=%s', reduced => {
    vi.stubGlobal('window', { matchMedia: vi.fn(() => ({ matches: reduced })) });
    const tree = open(), animation = renderPlayer(tree);
    expect(scene(animation).props.elapsed).toBe(reduced ? GRID_ANIMATION_DURATION : 0);
    expect(requestFrame).not.toHaveBeenCalled();
    expect(button(animation).props.className.split(' ')).toEqual(expect.arrayContaining(['h-11', 'w-11']));
    const cardPath = pathTo(tree, element => element.type === GridModeAnimation && element.props.mode === 'repeat_all')!;
    const event = bubble([...cardPath.slice(0, -1), ...pathTo(animation, element => element.type === 'button')!], 'onClick');
    expect(event.stopPropagation).toHaveBeenCalledOnce(); expect(requestFrame).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled(); expect(trigger(renderPicker()).props['aria-expanded']).toBe(true);
    expect(scene(renderPlayer(tree)).props.elapsed).toBe(0);
    frames.get(1)!(100);
    const fills = scene(renderPlayer(tree)).props.model.fills;
    for (let i = 0; i <= fills.length; i++) frames.get(i + 2)!(100 + (i + 1) * GRID_ANIMATION_DURATION);
    expect(scene(renderPlayer(tree)).props.elapsed).toBe(GRID_ANIMATION_DURATION);
    expect(requestFrame).toHaveBeenCalledTimes(fills.length + 2);
    const end = renderPlayer(tree); expect(button(end).props['aria-label']).toMatch(/^Replay/);
    button(end).props.onClick(); expect(scene(renderPlayer(tree)).props.elapsed).toBe(0);
  });
  it('cancels the current frame on unmount and after a prop change', () => {
    const tree = open(); button(renderPlayer(tree)).props.onClick(); frames.get(1)!(10);
    for (const effect of player.effects) if (effect.cleanup) effect.cleanup();
    expect(cancelFrame).toHaveBeenLastCalledWith(2);
    player = store(); button(renderPlayer(tree)).props.onClick();
    side = 'short'; renderPlayer(renderPicker()); expect(cancelFrame).toHaveBeenLastCalledWith(3);
    expect(scene(renderPlayer(renderPicker())).props.elapsed).toBe(0);
  });
  it('Escape closes the panel and restores focus; closed panels leave Escape to the dialog', () => {
    const tree = open();
    const event = bubble(pathTo(tree, element => 'aria-expanded' in element.props)!, 'onKeyDown', { key: 'Escape' });
    expect(trigger(renderPicker()).props['aria-expanded']).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce();
    const closed = bubble(pathTo(renderPicker(), element => 'aria-expanded' in element.props)!, 'onKeyDown', { key: 'Escape' });
    expect(closed.stopPropagation).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
  });
  it('still selects and closes from the radio, while arrow navigation stays open', () => {
    const radio = find(open(), element => element.type === 'input' && element.props.value === 'step_back');
    radio.props.onChange(); radio.props.onClick();
    expect(onChange).toHaveBeenLastCalledWith('step_back'); expect(trigger(renderPicker()).props['aria-expanded']).toBe(false);
    const next = find(open(), element => element.type === 'input' && element.props.value === 'repeat_all');
    next.props.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn(), currentTarget: { closest: () => null } });
    expect(onChange).toHaveBeenLastCalledWith('step_back'); expect(trigger(renderPicker()).props['aria-expanded']).toBe(true);
  });
});

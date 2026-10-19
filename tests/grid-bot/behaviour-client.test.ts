import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GridBehaviourSelect } from '../../client/src/components/grid-planner/GridBehaviourSelect';

// Exercise the real callbacks, with the same hook harness used by card-client.
// Native media methods are stubbed because these tests run on the Node runner.
type HookStore = { states: unknown[]; refs: { current: unknown }[]; effects: (() => void | (() => void))[] };
const hooks = vi.hoisted(() => ({ store: null as HookStore | null, stateIndex: 0, refIndex: 0 }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useId: () => 'EXAMPLE-behaviour',
  useState: (initial: unknown) => {
    const store = hooks.store!;
    const index = hooks.stateIndex++;
    if (!(index in store.states)) store.states[index] = initial;
    return [store.states[index], (next: unknown) => {
      store.states[index] = typeof next === 'function' ? next(store.states[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const store = hooks.store!;
    const index = hooks.refIndex++;
    return store.refs[index] ?? (store.refs[index] = { current: initial });
  },
  useEffect: (run: () => void | (() => void)) => { hooks.store!.effects.push(run); },
}));

type Element = ReactElement<Record<string, any>>;
const store = (): HookStore => ({ states: [], refs: [], effects: [] });
function render<T>(hookStore: HookStore, component: () => T): T {
  hooks.store = hookStore; hooks.stateIndex = 0; hooks.refIndex = 0; hookStore.effects = [];
  return component();
}
function pathTo(node: ReactNode, matches: (element: Element) => boolean): Element[] | undefined {
  if (!isValidElement<Element['props']>(node)) return;
  if (matches(node)) return [node];
  for (const child of Children.toArray(node.props.children)) {
    const path = pathTo(child, matches);
    if (path) return [node, ...path];
  }
}
function find(node: ReactNode, matches: (element: Element) => boolean): Element {
  const path = pathTo(node, matches);
  if (!path) throw Error('Expected element missing');
  return path[path.length - 1];
}
function bubble(path: Element[], handler: string, extra = {}) {
  let stopped = false;
  const event = { ...extra, preventDefault: vi.fn(), stopPropagation: vi.fn(() => { stopped = true; }) };
  for (const element of [...path].reverse()) {
    element.props[handler]?.(event);
    if (stopped) break;
  }
  return event;
}

describe('Grid behaviour clip interactions', () => {
  let picker: HookStore, player: HookStore;
  const onChange = vi.fn();
  const focus = vi.fn();
  const media = { play: vi.fn(() => Promise.resolve()), pause: vi.fn(), load: vi.fn() };
  const renderPicker = () => render(picker, () => GridBehaviourSelect({ value: 'repeat_all', side: 'long', seed: true, onChange }));
  const trigger = (tree: Element) => find(tree, element => 'aria-expanded' in element.props);
  const renderPlayer = (tree: Element) => {
    const clip = find(tree, element => element.props.mode === 'repeat_all');
    return render(player, () => (clip.type as (props: any) => Element)(clip.props));
  };
  const open = () => {
    trigger(renderPicker()).props.onClick();
    return renderPicker();
  };
  beforeEach(() => {
    vi.clearAllMocks();
    picker = store(); player = store();
    picker.refs.push({ current: { focus } }); player.refs.push({ current: media });
    media.play.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('mounts videos and posters only while expanded, and removes them on close', () => {
    const panelMarkup = (tree: Element) => render(player, () => renderToStaticMarkup(
      find(tree, element => element.props.role === 'radiogroup'),
    ));
    const collapsed = panelMarkup(renderPicker());
    expect(collapsed).not.toContain('<video');
    expect(collapsed).not.toContain('poster=');
    expect(collapsed).not.toContain('/grid-modes/');
    const tree = open();
    const expanded = panelMarkup(tree);
    expect(expanded.match(/<video\b/g)).toHaveLength(3);
    for (const name of ['repeat-all', 'step-back', 'step-back-edge']) {
      expect(expanded).toContain(`src="/grid-modes/${name}.mp4"`);
      expect(expanded).toContain(`poster="/grid-modes/${name}.png"`);
    }
    for (const video of expanded.match(/<video\b[^>]*>/g) ?? []) {
      expect(video).toContain('preload="none"');
      expect(video).toContain('muted=""');
      expect(video).toMatch(/playsinline=""/i);
      expect(video).not.toMatch(/\s(?:autoplay|loop|controls)=/i);
    }
    expect(expanded).toContain('aspect-video w-full max-w-full');
    expect(expanded).toContain('auto-rows-fr');
    for (const label of expanded.match(/<label\b[^]*?<\/label>/g) ?? []) expect(label).not.toContain('<video');
    trigger(tree).props.onClick();
    const closed = panelMarkup(renderPicker());
    expect(closed).not.toContain('<video');
    expect(closed).not.toContain('poster=');
    expect(closed).not.toContain('/grid-modes/');
  });

  it('Escape from the still-focused row trigger closes the panel and restores focus', () => {
    const tree = open();
    expect(trigger(tree).props['aria-expanded']).toBe(true);
    const event = bubble(pathTo(tree, element => 'aria-expanded' in element.props)!, 'onKeyDown', { key: 'Escape' });
    expect(trigger(renderPicker()).props['aria-expanded']).toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('leaves Escape available to the enclosing dialog when the panel is closed', () => {
    const event = bubble(pathTo(renderPicker(), element => 'aria-expanded' in element.props)!, 'onKeyDown', { key: 'Escape' });
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
  });

  it.each([false, true])('plays only on tap, without choosing or closing, reduced motion=%s', reduced => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduced })));
    const tree = open();
    const clipPath = pathTo(tree, element => element.props.mode === 'repeat_all')!;
    expect(clipPath.some(element => element.type === 'label')).toBe(false);
    const clip = renderPlayer(tree);
    const video = find(clip, element => element.type === 'video');
    expect(video.props).toMatchObject({ muted: true, playsInline: true, preload: 'none', controls: false,
      poster: '/grid-modes/repeat-all.png', src: '/grid-modes/repeat-all.mp4' });
    expect(video.props.autoPlay).toBeUndefined(); expect(video.props.loop).toBeUndefined();
    expect(find(clip, element => element.type === 'button').props.className.split(' ')).toEqual(expect.arrayContaining(['h-11', 'w-11']));
    expect(media.play).not.toHaveBeenCalled();
    const event = bubble([...clipPath.slice(0, -1), ...pathTo(clip, element => element.type === 'button')!], 'onClick');
    expect(media.play).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger(renderPicker()).props['aria-expanded']).toBe(true);
    const playing = renderPlayer(renderPicker());
    expect(find(playing, element => element.type === 'video').props.controls).toBe(true);
    // Native pause/seek/replay taps are also isolated from card selection.
    const nativeTap = bubble([...clipPath.slice(0, -1), ...pathTo(playing, element => element.type === 'video')!], 'onClick');
    expect(nativeTap.stopPropagation).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('restores the play button if media playback is rejected', async () => {
    media.play.mockRejectedValueOnce(Error('EXAMPLE playback unavailable'));
    const tree = open();
    find(renderPlayer(tree), element => element.type === 'button').props.onClick();
    await Promise.resolve();
    expect(find(renderPlayer(tree), element => element.type === 'video').props.controls).toBe(false);
    expect(find(renderPlayer(tree), element => element.type === 'button')).toBeTruthy();
  });

  it('pauses on close via unmount and restores the poster on a fresh mount', () => {
    const tree = open();
    find(renderPlayer(tree), element => element.type === 'button').props.onClick();
    const cleanup = player.effects[0]();
    trigger(tree).props.onClick();
    expect(pathTo(renderPicker(), element => element.props.mode === 'repeat_all')).toBeUndefined();
    if (cleanup) cleanup();
    expect(media.pause).toHaveBeenCalledOnce();
    player = store(); player.refs.push({ current: media });
    const reopened = renderPlayer(open());
    expect(find(reopened, element => element.type === 'video').props.controls).toBe(false);
    expect(find(reopened, element => element.type === 'button')).toBeTruthy();
  });

  it('still selects and closes from the radio, while arrow navigation stays open', () => {
    const tree = open();
    const radio = find(tree, element => element.type === 'input' && element.props.value === 'step_back');
    radio.props.onChange(); radio.props.onClick();
    expect(onChange).toHaveBeenLastCalledWith('step_back');
    expect(trigger(renderPicker()).props['aria-expanded']).toBe(false);
    const nextTree = open();
    const next = find(nextTree, element => element.type === 'input' && element.props.value === 'repeat_all');
    next.props.onKeyDown({ key: 'ArrowRight', preventDefault: vi.fn(), currentTarget: { closest: () => null } });
    expect(onChange).toHaveBeenLastCalledWith('step_back');
    expect(trigger(renderPicker()).props['aria-expanded']).toBe(true);
  });
});

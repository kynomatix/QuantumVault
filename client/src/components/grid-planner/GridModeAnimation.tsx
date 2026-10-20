import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Maximize2, Play, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { gridBehaviourCopy } from '../../../../shared/grid-behaviour';
import { GRID_ANIMATION_DURATION, gridAnimationFrame, gridAnimationModel, type GridModeAnimationOptions,
  type GridAnimationModel, type AnimationLineState } from '@/lib/grid-mode-animation';

const colours: Record<AnimationLineState, string> = {
  active: 'rgb(var(--grid-animation-active))', waiting: 'rgb(var(--grid-animation-waiting))',
  dark: 'rgb(var(--grid-animation-out))', unused: 'rgb(var(--grid-animation-out))',
};
const openingColour = 'rgb(var(--grid-animation-buy))';
const closingColour = 'rgb(var(--grid-animation-path))';
const players = new Set<() => void>();

/** Pure SVG scene, also used for end-state previews. No timers or playback on its own. */
export function GridModeAnimationScene({ model, elapsed, portraitHeight, fit = false, reveal = false }: {
  model: GridAnimationModel; elapsed: number; portraitHeight?: number; fit?: boolean; reveal?: boolean;
}) {
  const id = useId();
  const portrait = portraitHeight !== undefined;
  const height = portraitHeight ?? 360;
  const left = portrait ? 100 : 72;
  const x = (t: number) => left + (552 - left) * t;
  const fontSize = portrait ? 28 : 14;
  const radius = portrait ? 6 : 4;
  const frame = gridAnimationFrame(model, elapsed);
  const lineColours = frame.looks.map(look => look.active === 1 ? colours.active : look.active === 0 ? colours[look.muted]
    : `color-mix(in srgb, ${colours.active} ${look.active * 100}%, ${colours[look.muted]})`);
  const low = model.prices[0], span = model.prices[model.prices.length - 1] - low;
  const bottom = portrait ? height - 52 : 282;
  const top = portrait ? 60 : 58;
  const y = (price: number) => bottom - (bottom - top) * (price - low) / span;
  const dotX = x(frame.progress), dotY = y(frame.price);
  const path = Array.from({ length: 121 }, (_, i) => {
    const t = frame.progress * i / 120;
    return `${i ? 'L' : 'M'}${x(t)},${y(model.price(t))}`;
  }).join(' ');
  const copy = gridBehaviourCopy(model.mode, model.side, model.seed);
  return <svg viewBox={`0 0 640 ${height}`} role="img" aria-label={`Example animation: ${copy.label}`}
    data-layout={portrait ? 'portrait' : 'wide'} preserveAspectRatio="xMidYMid meet" shapeRendering="geometricPrecision"
    fontFamily="var(--font-sans)" fontWeight="600"
    style={fit ? { width: '100%', height: '100%' } : undefined}
    aria-describedby={`${id}-description`} className="block aspect-video w-full max-w-full rounded-md bg-background">
    <desc id={`${id}-description`}>{copy.hint}</desc>
    <defs>
      <filter id={`${id}-glow`} filterUnits="userSpaceOnUse" x="0" y="0" width="640" height={height} colorInterpolationFilters="sRGB">
        <feGaussianBlur stdDeviation="4.67" />
      </filter>
      <linearGradient id={`${id}-background`} x2="0" y2="1">
        <stop stopColor="rgb(var(--grid-animation-top))" /><stop offset="1" stopColor="rgb(var(--grid-animation-bottom))" />
      </linearGradient>
      <radialGradient id={`${id}-wash`} cx="50%" cy="55%" r="55%">
        <stop stopColor="rgb(var(--grid-animation-wash))" /><stop offset="1" stopColor="rgb(var(--grid-animation-wash))" stopOpacity="0" />
      </radialGradient>
      <radialGradient id={`${id}-vignette`} r="70%">
        <stop offset=".45" stopColor="rgb(var(--grid-animation-top))" stopOpacity="0" />
        <stop offset="1" stopColor="rgb(var(--grid-animation-top))" stopOpacity=".7" />
      </radialGradient>
    </defs>
    <rect width="640" height={height} fill={`url(#${id}-background)`} />
    <rect width="640" height={height} fill={`url(#${id}-wash)`} style={{ mixBlendMode: 'screen' }} />
    <rect width="640" height={height} fill={`url(#${id}-vignette)`} />
    <g data-scene="true" opacity={reveal ? frame.sceneOpacity : 1}>
    {/* One bounded blur surface, under all crisp geometry and text. */}
    <g data-glow="true" filter={`url(#${id}-glow)`} fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ mixBlendMode: 'screen' }}>
      {model.prices.map((price, ordinal) => <path key={ordinal} d={`M${left},${y(price)}H552`}
        stroke={lineColours[ordinal]} strokeWidth="12" opacity={frame.looks[ordinal].glow} />)}
      <path d={path} stroke={closingColour} strokeWidth="10" opacity=".6" />
      <circle cx={dotX} cy={dotY} r={radius * 3} fill={closingColour} opacity=".6" />
    </g>
    {model.prices.map((price, ordinal) => <g key={ordinal} data-grid-line={ordinal} data-state={frame.states[ordinal]}>
      <path d={`M${left},${y(price)}H552`} stroke={lineColours[ordinal]} strokeWidth={frame.looks[ordinal].width} opacity={frame.looks[ordinal].opacity} />
    </g>)}
    <text x={left - 12} y={y(model.reference)} textAnchor="end" dominantBaseline="middle"
      fill="hsl(var(--muted-foreground))" fontSize={fontSize}>Start</text>
    <path d={path} fill="none" stroke={closingColour} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={dotX} cy={dotY} r={radius} fill="rgb(var(--grid-animation-text))" />
    {frame.progress < 1 && <text data-price-readout="true" x={dotX + 12} y={dotY + (frame.progress < model.peak ? fontSize + 4 : -12)}
      textAnchor={portrait && dotX > 500 ? 'end' : 'start'} fill={closingColour} fontSize={portrait ? 28 : 15}>{frame.readout}</text>}
    {frame.tags.map(tag => {
      // v5 modes_anim.py:165,239-243: stay beside the original fill point.
      // The model's short fade removes the tag before it reads as a trailing order.
      const fillX = x(tag.at), fillY = y(model.prices[tag.ordinal]);
      const colour = tag.label === 'BUY' ? openingColour : colours.waiting;
      const owner = model.owners.find(row => row.ownerOrdinal === tag.ownerOrdinal)!;
      return <g key={`${tag.ownerOrdinal}-${tag.leg}`} opacity={tag.opacity} data-fill={tag.label}>
        {tag.leg === 'opening' && <path d={`M${fillX},${fillY}V${y(model.prices[owner.closingOrdinal])}`} stroke={colour} strokeWidth="1.5" />}
        <rect x={fillX - (portrait ? 106 : 62)} y={fillY - (portrait ? 20 : 11)} width={portrait ? 96 : 52} height={portrait ? 40 : 22} rx="5" fill={colour} fillOpacity=".33" stroke={colour} strokeWidth={portrait ? 3 : 2} />
        <text x={fillX - (portrait ? 58 : 36)} y={fillY + (portrait ? 9 : 5)} textAnchor="middle" fill="rgb(var(--grid-animation-text))" fontSize={fontSize} fontWeight="600">{tag.label}</text>
      </g>;
    })}
    {/* Paint resting rings last so no fill bracket or label can cover their stroke. */}
    {frame.pending.map(order => <circle key={order.ownerOrdinal} data-waiting-order={order.leg}
      cx={dotX} cy={y(model.prices[order.ordinal])} r={radius} fill="none" stroke={order.leg === 'opening' ? openingColour : closingColour} strokeWidth="1.8" />)}
    </g>
  </svg>;
}

export function GridModeAnimation(props: GridModeAnimationOptions) {
  const model = useMemo(() => gridAnimationModel(props), [props.lines, props.start, props.side, props.seed, props.mode]);
  const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [elapsed, setElapsed] = useState(() => reduced() ? GRID_ANIMATION_DURATION : 0);
  const [playing, setPlaying] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [portrait, setPortrait] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(orientation: portrait)').matches);
  const [portraitHeight, setPortraitHeight] = useState(960);
  const [drawing, setDrawing] = useState<HTMLDivElement | null>(null);
  const smallElapsed = useRef(elapsed);
  const enlargeButton = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const began = useRef<number | null>(null);
  const playbackElapsed = useRef(0);
  const resume = useRef<(() => void) | null>(null);
  useEffect(() => {
    const media = window.matchMedia?.('(orientation: portrait)');
    if (!media) return;
    const update = () => setPortrait(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  useEffect(() => {
    if (!drawing || !portrait) return;
    // Recompute geometry, rather than stretching the SVG. Uniform SVG scaling
    // keeps circles round and text legible as the header or safe areas change.
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setPortraitHeight(640 * entry.contentRect.height / entry.contentRect.width);
    });
    observer.observe(drawing);
    return () => observer.disconnect();
  }, [drawing, portrait]);
  const cancel = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    began.current = null;
    resume.current = null;
  };
  useEffect(() => {
    cancel();
    setPlaying(false);
    setElapsed(reduced() ? GRID_ANIMATION_DURATION : 0);
    const pause = () => { cancel(); setPlaying(false); };
    players.add(pause);
    return () => { cancel(); players.delete(pause); };
  }, [model]);
  useEffect(() => {
    const target = enlarged ? drawing : container.current;
    if (!playing || !target || typeof IntersectionObserver === 'undefined') return;
    let visible = true;
    const update = () => {
      if (visible && !document.hidden) resume.current?.();
      else {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        began.current = null;
      }
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; update(); });
    observer.observe(target);
    document.addEventListener('visibilitychange', update);
    update();
    return () => { observer.disconnect(); document.removeEventListener('visibilitychange', update); };
  }, [playing, enlarged, drawing]);
  const play = () => {
    players.forEach(pause => pause());
    cancel();
    setElapsed(0);
    playbackElapsed.current = 0;
    setPlaying(true);
    const tick = (time: number) => {
      began.current ??= time;
      const next = Math.min(playbackElapsed.current + time - began.current, GRID_ANIMATION_DURATION);
      began.current = time;
      playbackElapsed.current = next;
      setElapsed(next);
      if (next < GRID_ANIMATION_DURATION) frame.current = requestAnimationFrame(tick);
      else { frame.current = null; resume.current = null; setPlaying(false); }
    };
    resume.current = () => { if (frame.current === null) frame.current = requestAnimationFrame(tick); };
    frame.current = requestAnimationFrame(tick);
  };
  const changeOpen = (open: boolean) => {
    cancel();
    setPlaying(false);
    setEnlarged(open);
    if (open) {
      smallElapsed.current = elapsed;
      players.forEach(pause => pause());
      if (reduced()) setElapsed(GRID_ANIMATION_DURATION);
      else play();
    } else setElapsed(smallElapsed.current);
  };
  const replay = playing || elapsed > 0;
  const copy = gridBehaviourCopy(model.mode, model.side, model.seed);
  const playButton = <button type="button" aria-label={`${replay ? 'Replay' : 'Play'} example animation: ${copy.label}`}
      className={`${enlarged ? 'shrink-0 self-start' : 'absolute bottom-1 left-1'} flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background/90 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
      onClick={play}>
      {replay ? <RotateCcw aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4" />}
    </button>;
  return <div ref={container} className="relative mt-auto min-w-0 max-w-full overflow-hidden pb-12" onClick={event => event.stopPropagation()}>
    <GridModeAnimationScene model={model} elapsed={enlarged ? smallElapsed.current : elapsed} reveal={playing && !enlarged} />
    {!enlarged && playButton}
    <Dialog open={enlarged} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <button ref={enlargeButton} type="button" aria-label={`Enlarge example animation: ${copy.label}`} title="Enlarge"
          className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background/90 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <Maximize2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="flex w-[calc(100vw-1rem)] max-w-[1100px] flex-col max-h-[calc(100dvh-1rem)] rounded-lg p-3 sm:p-6"
        style={{
          height: portrait ? 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 1rem)' : undefined,
          maxHeight: 'calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 1rem)',
          width: 'calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right) - 1rem)',
          top: 'calc((100dvh + env(safe-area-inset-top) - env(safe-area-inset-bottom)) / 2)',
          left: 'calc((100vw + env(safe-area-inset-left) - env(safe-area-inset-right)) / 2)',
        }}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        onEscapeKeyDown={event => {
          // Radix handles Escape at document capture, before the panel's React handler.
          event.preventDefault();
          event.stopPropagation();
          changeOpen(false);
        }}
        onCloseAutoFocus={event => { event.preventDefault(); enlargeButton.current?.focus(); }}>
        <DialogHeader className="shrink-0 pr-8 text-left">
          <DialogTitle>{copy.label}</DialogTitle>
          <DialogDescription>{copy.hint}</DialogDescription>
        </DialogHeader>
        {enlarged && <>
          <div ref={setDrawing} className="min-h-0 min-w-0" style={{ flex: portrait ? '1 1 0%' : '0 1 auto', aspectRatio: portrait ? undefined : '16 / 9' }}>
            <GridModeAnimationScene model={model} elapsed={elapsed} portraitHeight={portrait ? portraitHeight : undefined} reveal={playing} fit />
          </div>
          {playButton}
        </>}
      </DialogContent>
    </Dialog>
  </div>;
}

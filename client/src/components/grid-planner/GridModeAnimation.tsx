import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Maximize2, Play, RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { gridBehaviourCopy } from '../../../../shared/grid-behaviour';
import { GRID_ANIMATION_DURATION, gridAnimationFrame, gridAnimationModel, type GridModeAnimationOptions,
  type GridAnimationModel, type AnimationLineState } from '@/lib/grid-mode-animation';

const colours: Record<AnimationLineState, string> = {
  active: 'hsl(var(--chart-3))', waiting: 'hsl(var(--chart-5))', dark: 'hsl(var(--border))', unused: 'hsl(var(--border))',
};
const openingColour = 'hsl(var(--chart-4))';
const closingColour = 'hsl(var(--foreground))';
const x = (t: number) => 72 + 480 * t;
const players = new Set<() => void>();

/** Pure SVG scene, also used for end-state previews. No timers or playback on its own. */
export function GridModeAnimationScene({ model, elapsed }: { model: GridAnimationModel; elapsed: number }) {
  const id = useId();
  const frame = gridAnimationFrame(model, elapsed);
  const low = model.prices[0], span = model.prices[model.prices.length - 1] - low;
  const y = (price: number) => 282 - 224 * (price - low) / span;
  const dotX = x(frame.progress), dotY = y(frame.price);
  const path = Array.from({ length: 121 }, (_, i) => {
    const t = frame.progress * i / 120;
    return `${i ? 'L' : 'M'}${x(t)},${y(model.price(t))}`;
  }).join(' ');
  const copy = gridBehaviourCopy(model.mode, model.side, model.seed);
  return <svg viewBox="0 0 640 360" role="img" aria-label={`Example animation: ${copy.label}`}
    aria-describedby={`${id}-description`} className="block aspect-video w-full max-w-full rounded-md bg-background">
    <desc id={`${id}-description`}>{copy.hint}</desc>
    <defs>
      <filter id={`${id}-glow`} x="-20%" y="-100%" width="140%" height="300%"><feGaussianBlur stdDeviation="3" /></filter>
      <radialGradient id={`${id}-wash`}><stop stopColor="hsl(var(--primary))" stopOpacity=".14" /><stop offset="1" stopColor="hsl(var(--background))" stopOpacity="0" /></radialGradient>
    </defs>
    <rect width="640" height="360" fill={`url(#${id}-wash)`} />
    {model.prices.map((price, ordinal) => <g key={ordinal} data-grid-line={ordinal} data-state={frame.states[ordinal]}>
      {frame.states[ordinal] === 'active' && <path d={`M72,${y(price)}H552`} stroke={colours.active} strokeWidth="7" opacity=".3" filter={`url(#${id}-glow)`} />}
      <path d={`M72,${y(price)}H552`} stroke={colours[frame.states[ordinal]]} strokeWidth={frame.states[ordinal] === 'active' ? 2 : 1.5} />
    </g>)}
    <text x="60" y={y(model.reference)} textAnchor="end" dominantBaseline="middle"
      fill="hsl(var(--muted-foreground))" fontSize="14">Start</text>
    <path d={path} fill="none" stroke={closingColour} strokeWidth="2" strokeLinecap="round" />
    <circle cx={dotX} cy={dotY} r="4" fill={closingColour} />
    {/* A word readout replaces the reference's numeric price, on the opposite side to the tags. */}
    {frame.progress < 1 && <text x={dotX + 12} y={dotY + (frame.progress < model.peak ? 18 : -12)}
      fill={closingColour} fontSize="14">Price</text>}
    {frame.tags.map(tag => {
      // v5 modes_anim.py:165,239-243: stay beside the original fill point.
      // The model's short fade removes the tag before it reads as a trailing order.
      const fillX = x(tag.at), fillY = y(model.prices[tag.ordinal]);
      const colour = tag.leg === 'opening' ? openingColour : 'hsl(var(--chart-5))';
      const owner = model.owners.find(row => row.ownerOrdinal === tag.ownerOrdinal)!;
      return <g key={`${tag.ownerOrdinal}-${tag.leg}`} opacity={tag.opacity} data-fill={tag.label}>
        {tag.leg === 'opening' && <path d={`M${fillX},${fillY}V${y(model.prices[owner.closingOrdinal])}`} stroke={colour} strokeWidth="1.5" />}
        <rect x={fillX - 62} y={fillY - 11} width="52" height="22" rx="5" fill="hsl(var(--background))" stroke={colour} />
        <text x={fillX - 36} y={fillY + 5} textAnchor="middle" fill={colour} fontSize="14" fontWeight="600">{tag.label}</text>
      </g>;
    })}
    {/* Paint resting rings last so no fill bracket or label can cover their stroke. */}
    {frame.pending.map(order => <circle key={order.ownerOrdinal} data-waiting-order={order.leg}
      cx={dotX} cy={y(model.prices[order.ordinal])} r="4" fill="none" stroke={order.leg === 'opening' ? openingColour : closingColour} strokeWidth="1.8" />)}
  </svg>;
}

export function GridModeAnimation(props: GridModeAnimationOptions) {
  const model = useMemo(() => gridAnimationModel(props), [props.lines, props.start, props.side, props.seed, props.mode]);
  const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [elapsed, setElapsed] = useState(() => reduced() ? GRID_ANIMATION_DURATION : 0);
  const [playing, setPlaying] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const smallElapsed = useRef(elapsed);
  const enlargeButton = useRef<HTMLButtonElement>(null);
  const frame = useRef<number | null>(null);
  const began = useRef<number | null>(null);
  const cancel = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    began.current = null;
  };
  useEffect(() => {
    cancel();
    setPlaying(false);
    setElapsed(reduced() ? GRID_ANIMATION_DURATION : 0);
    const pause = () => { cancel(); setPlaying(false); };
    players.add(pause);
    return () => { cancel(); players.delete(pause); };
  }, [model]);
  const play = () => {
    players.forEach(pause => pause());
    cancel();
    setElapsed(0);
    setPlaying(true);
    const tick = (time: number) => {
      began.current ??= time;
      const next = Math.min(time - began.current, GRID_ANIMATION_DURATION);
      setElapsed(next);
      if (next < GRID_ANIMATION_DURATION) frame.current = requestAnimationFrame(tick);
      else { frame.current = null; setPlaying(false); }
    };
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
      className="absolute bottom-1 left-1 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background/90 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      onClick={play}>
      {replay ? <RotateCcw aria-hidden="true" className="h-4 w-4" /> : <Play aria-hidden="true" className="h-4 w-4" />}
    </button>;
  return <div className="relative mt-auto min-w-0 max-w-full overflow-hidden" onClick={event => event.stopPropagation()}>
    <GridModeAnimationScene model={model} elapsed={enlarged ? smallElapsed.current : elapsed} />
    {!enlarged && playButton}
    <Dialog open={enlarged} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <button ref={enlargeButton} type="button" aria-label={`Enlarge example animation: ${copy.label}`} title="Enlarge"
          className="absolute bottom-1 right-1 flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background/90 text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <Maximize2 aria-hidden="true" className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-[1100px] max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-lg p-3 sm:p-6"
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        onEscapeKeyDown={event => {
          // Radix handles Escape at document capture, before the panel's React handler.
          event.preventDefault();
          event.stopPropagation();
          changeOpen(false);
        }}
        onCloseAutoFocus={event => { event.preventDefault(); enlargeButton.current?.focus(); }}>
        <DialogHeader className="pr-8 text-left">
          <DialogTitle>{copy.label}</DialogTitle>
          <DialogDescription>{copy.hint}</DialogDescription>
        </DialogHeader>
        {enlarged && <div className="relative min-w-0">
          <GridModeAnimationScene model={model} elapsed={elapsed} />
          {playButton}
        </div>}
      </DialogContent>
    </Dialog>
  </div>;
}

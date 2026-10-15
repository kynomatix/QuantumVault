import React, { useEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export function GridChartSourceInfo({ venue, timeframe, children }: { venue: string; timeframe: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), hovering = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const leave = () => { timer.current = setTimeout(() => { if (hovering.current) setOpen(false); }, 150); };
  return <Popover open={open} onOpenChange={value => { hovering.current = false; clearTimeout(timer.current); setOpen(value); }}>
    <PopoverTrigger asChild><button ref={trigger} type="button" aria-label={`Chart: ${venue} · ${timeframe}. Show source and candle details.`}
      onPointerEnter={event => { if (event.pointerType === 'mouse') { clearTimeout(timer.current); hovering.current = true; setOpen(true); } }} onPointerLeave={leave}
      className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      Chart: {venue} · {timeframe}<Info className="h-3.5 w-3.5" aria-hidden="true" />
    </button></PopoverTrigger>
    <PopoverContent side="top" align="start" collisionBoundary={trigger.current?.closest('[role="dialog"]') ?? undefined} collisionPadding={12}
      className="w-80 max-w-[min(calc(100vw-2rem),var(--radix-popover-content-available-width))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto space-y-2 text-xs leading-relaxed" aria-label="Chart source and candle details"
      onOpenAutoFocus={event => event.preventDefault()} onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}>
      {children}
    </PopoverContent>
  </Popover>;
}

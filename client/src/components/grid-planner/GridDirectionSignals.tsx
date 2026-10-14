import React, { useEffect, useRef, useState } from 'react';
import { Activity, ArrowDown, ArrowRight, ArrowUp, ChartNoAxesCombined, Globe2, Percent } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { walletAuthHeaders } from '@/lib/queryClient';
import { gridSignalViews, isGridSignals, type GridSignalView } from '@/lib/grid-signals-view';
import { useGridDirectionSuggestion } from './GridDirectionBadge';
import type { GridSignals } from '../../../../shared/grid-signals';
import type { GridRegime } from '../../../../shared/grid-regime';

export function GridSignalButton({ signal }: { signal: GridSignalView }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), hovering = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);
  const enter = () => { clearTimeout(timer.current); hovering.current = true; setOpen(true); };
  const leave = () => { timer.current = setTimeout(() => { if (hovering.current) setOpen(false); }, 150); };
  const Icon = { Macro: Globe2, 'Weekly structure': ChartNoAxesCombined, Trend: Activity, Funding: Percent }[signal.name];
  const Arrow = signal.direction === 'long' ? ArrowUp : signal.direction === 'short' ? ArrowDown : ArrowRight;
  return <Popover open={open} onOpenChange={value => { hovering.current = false; clearTimeout(timer.current); setOpen(value); }}>
    <PopoverTrigger asChild><button type="button" aria-label={`${signal.name}: ${signal.summary}. Show details and basis.`}
      onPointerEnter={event => { if (event.pointerType === 'mouse') enter(); }} onPointerLeave={leave}
      className="inline-flex h-8 w-9 items-center justify-center gap-0.5 rounded-md border border-border/60 bg-card/40 text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <Icon className="h-3.5 w-3.5" aria-hidden="true"/><Arrow aria-hidden="true" className={`h-3 w-3 ${signal.unavailable || signal.direction === 'neutral' ? 'text-muted-foreground' : signal.direction === 'long' ? 'text-teal-500' : 'text-red-500'}`}/>
    </button></PopoverTrigger>
    <PopoverContent side="top" align="start" className="w-80 max-w-[calc(100vw-2rem)] space-y-2 text-xs" aria-label={`${signal.name} signal details`}
      onOpenAutoFocus={event => event.preventDefault()} onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}>
      <p className="font-medium text-sm">{signal.name} · {signal.summary}</p>
      <p className="leading-relaxed">{signal.detail}</p><p className="text-muted-foreground leading-relaxed">{signal.basis}</p>
      <p className="text-muted-foreground">Advisory only. Choose either direction.</p>
    </PopoverContent>
  </Popover>;
}

// Display inputs only: this component cannot select, change or block order direction.
export function GridDirectionSignals({ active, identity, market, timeframe, regime, refresh }: {
  active: boolean; identity?: string; market: string; timeframe: string; regime: GridRegime; refresh: number;
}) {
  const macro = useGridDirectionSuggestion({ active, identity, refresh });
  const [signals, setSignals] = useState<GridSignals | null>(null);
  useEffect(() => {
    setSignals(null);
    if (!active || !market) return;
    const controller = new AbortController(), startedAt = Date.now();
    const timers: ReturnType<typeof setTimeout>[] = [];
    const missing = { state: 'unavailable' as const, reason: 'Signal request failed or returned invalid data.' };
    void fetch(`/api/grid-planner/signals?${new URLSearchParams({ market })}`, {
      method: 'GET', credentials: 'include', headers: walletAuthHeaders(),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]),
    }).then(async response => { if (!response.ok) throw new Error('Signals unavailable'); return response.json(); })
      .then(value => {
        if (controller.signal.aborted) return;
        if (!isGridSignals(value, market)) throw new Error('Invalid signals');
        const result: GridSignals = { ...value };
        for (const key of ['weekly', 'funding'] as const) {
          const signal = value[key]; if (signal.state !== 'available') continue;
          const remaining = signal.expiresAt - value.serverNow - (Date.now() - startedAt);
          if (remaining <= 0) result[key] = { state: 'unavailable', reason: 'Observation expired; refresh for fresh data.' };
          else timers.push(setTimeout(() => setSignals(current => current ? {
            ...current, [key]: { state: 'unavailable', reason: 'Observation expired; refresh for fresh data.' },
          } : null), remaining));
        }
        setSignals(result);
      }).catch(() => { if (!controller.signal.aborted) setSignals({ market, serverNow: Date.now(), weekly: missing, funding: missing }); });
    return () => { controller.abort(); timers.forEach(clearTimeout); };
  }, [active, identity, market, refresh]);
  return <div role="group" aria-label="Independent direction signals" className="flex items-center gap-1">
    {gridSignalViews(macro, signals, market, timeframe, regime).map(signal =>
      <GridSignalButton key={`${market}:${timeframe}:${signal.name}`} signal={signal}/>)}
  </div>;
}

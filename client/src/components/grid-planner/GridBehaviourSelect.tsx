import { useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GRID_BEHAVIOUR_MODES, gridBehaviourCopy, type GridBehaviourMode } from '../../../../shared/grid-behaviour';

import { GridModeAnimation } from './GridModeAnimation';
import { GRID_SETUP_INITIAL } from '@/lib/grid-setup-view';

export function GridBehaviourSelect({ value, side, seed, onChange }: { value: GridBehaviourMode; side: string; seed: boolean; onChange: (mode: GridBehaviourMode) => void }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const when = side === 'long' ? 'When price rises' : 'When price falls';
  const close = () => {
    setExpanded(false);
    trigger.current?.focus();
  };
  const select = (mode: GridBehaviourMode) => {
    onChange(mode);
    close();
  };

  return <div className="@container min-w-0" onKeyDown={event => {
    if (expanded && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <Button ref={trigger} type="button" variant="outline"
      className="h-auto min-h-11 w-full justify-between whitespace-normal text-left py-3"
      aria-label={`${when}: ${gridBehaviourCopy(value, side, seed).label}`}
      aria-expanded={expanded} aria-controls={`${id}-panel`} onClick={() => setExpanded(!expanded)}>
      <span>{when}: <strong>{gridBehaviourCopy(value, side, seed).label}</strong></span>
      <ChevronDown aria-hidden="true" className={`ml-2 h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} />
    </Button>
    <div id={`${id}-panel`} hidden={!expanded}>
      <div role="radiogroup" aria-label={`${when}: Grid behaviour`}
        className="mt-3 grid auto-rows-fr grid-cols-1 items-stretch gap-3 @min-[560px]:grid-cols-3">
        {GRID_BEHAVIOUR_MODES.map(mode => {
          const copy = gridBehaviourCopy(mode, side, seed);
          const selected = value === mode;
          return <div key={mode} className={`relative flex h-full min-w-0 flex-col gap-2 rounded-lg border p-3 text-left break-words focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${selected ? 'border-primary bg-primary/10' : 'border-border bg-card'}`}>
            <label className="flex min-w-0 flex-1 cursor-pointer flex-col gap-2">
            <input type="radio" name={`${id}-behaviour`} value={mode} checked={selected}
              aria-labelledby={`${id}-${mode}-title`} aria-describedby={`${id}-${mode}-hint`}
              className="sr-only" onChange={() => onChange(mode)} onClick={close}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  select(mode);
                } else if (['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'].includes(event.key)) {
                  // Prevent native arrow activation from generating a click that closes the panel.
                  event.preventDefault();
                  const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
                  const next = GRID_BEHAVIOUR_MODES[(GRID_BEHAVIOUR_MODES.indexOf(mode) + direction + GRID_BEHAVIOUR_MODES.length) % GRID_BEHAVIOUR_MODES.length];
                  onChange(next);
                  event.currentTarget.closest('[role="radiogroup"]')?.querySelector<HTMLInputElement>(`input[value="${next}"]`)?.focus();
                }
              }} />
            <span className="flex items-start justify-between gap-2">
              <span id={`${id}-${mode}-title`} className="font-medium">{copy.label}</span>
              {selected && <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-primary" />}
            </span>
            {mode === GRID_SETUP_INITIAL.behaviourMode && <Badge variant="secondary" className="w-fit">Recommended</Badge>}
            <span id={`${id}-${mode}-hint`} className="text-sm text-muted-foreground">{copy.hint}</span>
            </label>
            {expanded && <GridModeAnimation mode={mode} side={side === 'long' ? 'long' : 'short'} seed={seed} />}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

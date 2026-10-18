import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger, DialogClose } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { GRID_BEHAVIOUR_MODES, gridBehaviourCopy, type GridBehaviourMode } from '../../../../shared/grid-behaviour';

export function GridBehaviourSelect({ value, side, seed, onChange }: { value: GridBehaviourMode; side: string; seed: boolean; onChange: (mode: GridBehaviourMode) => void }) {
  const when = side === 'long' ? 'When price rises' : 'When price falls';
  return <Dialog><DialogTrigger asChild><Button type="button" variant="outline" className="h-auto min-h-11 w-full justify-between whitespace-normal text-left py-3" aria-label={`${when}: ${gridBehaviourCopy(value, side, seed).label}`}>
    <span>{when}: <strong>{gridBehaviourCopy(value, side, seed).label}</strong></span><span aria-hidden="true" className="ml-2">›</span>
  </Button></DialogTrigger><DialogContent className="max-w-md max-h-[85dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>{when}</DialogTitle><DialogDescription>Choose what happens after each profit-taking order.</DialogDescription></DialogHeader>
    <fieldset className="space-y-4"><legend className="sr-only">Grid behaviour</legend>{GRID_BEHAVIOUR_MODES.map(mode => {
      const copy = gridBehaviourCopy(mode, side, seed);
      return <div key={mode} className="space-y-2"><label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3">
        <input type="radio" name="grid-behaviour" value={mode} checked={value === mode} onChange={() => onChange(mode)} className="mt-1 accent-primary" />
        <span><span className="block font-medium">{copy.label}{mode === 'repeat_all' && <span className="block text-xs text-muted-foreground">Recommended</span>}</span><span className="block text-sm text-muted-foreground mt-1">{copy.hint}</span></span>
      </label><details className="ml-3 text-sm"><summary className="cursor-pointer text-primary">See example</summary><p className="mt-1 text-muted-foreground">{copy.example}</p></details></div>;
    })}</fieldset><DialogClose asChild><Button type="button">Done</Button></DialogClose>
  </DialogContent></Dialog>;
}

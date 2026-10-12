import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ORDER_SIZES, plannerSizeHint } from '@/lib/grid-planner-view';

export function GridPlannerSizeSelect({ id, label, value, side, startingPosition = false, enabled = true, onChange }: {
  id: string; label: string; value: string; side: string; startingPosition?: boolean; enabled?: boolean; onChange: (value: string) => void;
}) {
  const hint = enabled ? plannerSizeHint(side, value, startingPosition)
    : 'Enable “Start with a position at the current price” to choose how that position is closed in pieces.';
  return <div className="space-y-1.5">
    <Label htmlFor={id}>{label}</Label>
    <Select value={value} onValueChange={onChange} disabled={!enabled}>
      <SelectTrigger id={id} aria-describedby={`${id}-hint`}><SelectValue /></SelectTrigger>
      <SelectContent>{ORDER_SIZES.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
    </Select>
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
  </div>;
}

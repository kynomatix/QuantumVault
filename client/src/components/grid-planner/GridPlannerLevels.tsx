import type { GridPlan } from '../../../../server/grid-bot/engine-types';
import { readableDecimal } from '@/lib/grid-planner-view';
import { Badge } from '@/components/ui/badge';

/** Display the engine's rounded notionals, including any opening minimum lifts. */
export function GridPlannerLevels({ plan, baseSymbol }: { plan: GridPlan; baseSymbol: string }) {
  return <div className="overflow-x-auto max-h-72 mt-2"><table className="w-full text-xs text-left">
    <caption className="text-left py-2">Planned levels ({plan.lines.length} price lines)</caption>
    <thead><tr><th className="p-2">Level</th><th className="p-2">Price</th><th className="p-2">Quantity · USD value</th><th className="p-2">Role</th></tr></thead>
    <tbody>{plan.lines.map(line => <tr key={line.ordinal} className="border-t border-border/60">
      <td className="p-2">{line.ordinal + 1}</td><td className="p-2 tabular-nums">{readableDecimal(line.price)}</td>
      <td className="p-2 tabular-nums">{line.role === 'virtual' ? '—' : <>
        {readableDecimal(line.quantity)} {baseSymbol} · ${readableDecimal(line.notional)}
        {line.role === 'entry' && plan.openingOrderLift?.ordinals?.includes(line.ordinal)
          && <Badge variant="secondary" className="ml-2 text-[10px]">raised to min</Badge>}
      </>}</td>
      <td className="p-2">{line.role === 'entry' ? 'Entry' : line.role === 'seed_exit' ? 'Take-profit (starting position)' : 'Virtual line'}</td>
    </tr>)}</tbody>
    <tfoot><tr className="border-t border-border/60"><td colSpan={4} className="p-2 font-medium tabular-nums">
      Total in orders: ${readableDecimal(plan.allocatedNotional)}
    </td></tr></tfoot>
  </table></div>;
}

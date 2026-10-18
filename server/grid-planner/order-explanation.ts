import Decimal from 'decimal.js';
import { calculateGridPrices } from '../grid-bot/engine';
import type { GridInput, GridIssue } from '../grid-bot/engine-types';

const D = Decimal.clone({ precision: 120, rounding: Decimal.ROUND_DOWN });
export const dollars = (value: string) => new D(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/** Display-only reconstruction of the rejected line. Never used to size or admit an order. */
export function explainPlannerIssue(issue: GridIssue, input: GridInput): string {
  if (issue.code !== 'underfunded') return issue.reason;
  if (input.policyVersion === '2.0.0')
    return 'The investment cannot cover all cycling orders across the range. Raise the investment, use fewer grids, or use more leverage.';
  if (issue.reason === 'Starting-position order is below the opening minimum')
    return `The starting-position order is below Pacifica's $${new D(input.minimumQuote).toFixed()} minimum order. Raise the investment, use fewer grids, or use more leverage.`;
  if (issue.ordinal === undefined) return issue.reason;
  const geometry = calculateGridPrices(input);
  if (!geometry.ok) return issue.reason;
  const start = new D(input.start).div(input.tick).floor().mul(input.tick);
  const entry = (price: string) => input.side === 'long' ? new D(price).lt(start) : new D(price).gt(start);
  const entries = geometry.lines.filter(l => entry(l.price));
  const profits = geometry.lines.filter(l => !entry(l.price) && !new D(l.price).eq(start));
  entries.sort((a, b) => input.side === 'long' ? a.ordinal - b.ordinal : b.ordinal - a.ordinal);
  profits.sort((a, b) => input.side === 'long' ? b.ordinal - a.ordinal : a.ordinal - b.ordinal);
  const line = geometry.lines[issue.ordinal], isEntry = entry(line.price), set = isEntry ? entries : profits;
  const scale = isEntry ? input.entryScale : input.profitScale;
  const weights = set.map((_, i) => scale === 'flat' ? 1 : scale === 'ascending' ? set.length - i : i + 1);
  const total = new D(input.investment).mul(input.leverage);
  const seed = input.seed ? total.mul(profits.length).div(entries.length + profits.length) : new D(0);
  const allocation = isEntry ? total.minus(seed) : seed;
  const quantity = allocation.mul(weights[set.indexOf(line)]).div(weights.reduce((a, b) => a + b, 0))
    .div(line.price).div(input.lot).floor().mul(input.lot);
  const price = line.price;
  const order = !isEntry ? `The take-profit order at $${new D(price).toFixed()}` : 'Each grid order';
  if (quantity.lt(input.lot)) return `${order} rounds below Pacifica's smallest quantity step (${input.lot} base units). Raise the investment, use fewer grids, or use more leverage.`;
  if (!isEntry) return issue.reason;
  return `${order} would be about $${dollars(quantity.mul(price).toFixed())}, below Pacifica's $${new D(input.minimumQuote).toFixed()} minimum order. Raise the investment, use fewer grids, or use more leverage.`;
}

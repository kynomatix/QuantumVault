import Decimal from 'decimal.js';
import type { GridPriceInput, GridPriceResult, GridResult } from './engine-types';

const D = Decimal.clone({ precision: 120, rounding: Decimal.ROUND_DOWN, toExpNeg: -120, toExpPos: 120 });
const MAX = new D('1000000000000000000');
const MIN = new D('0.000000000000000001');
export function validGridDecimal(value: unknown, allowZero = false): value is string {
  if (typeof value !== 'string' || value.length > 37 || !/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/.test(value)) return false;
  const n = new D(value);
  return n.lt(MAX) && (allowZero && n.isZero() || n.gte(MIN));
}
const text = (n: Decimal) => n.toFixed();
const floor = (n: Decimal, step: Decimal) => n.div(step).floor().times(step);
const failure = (code: Extract<GridResult, { ok: false }>['issues'][number]['code'], reason: string, ordinal?: number): Extract<GridResult, { ok: false }> =>
  ({ ok: false, issues: [{ code, reason, ...(ordinal === undefined ? {} : { ordinal }) }] });

/** Price geometry only; never supplies quantities, capital requirements or execution authority. */
export function calculateGridPrices(input: GridPriceInput): GridPriceResult {
  for (const key of ['lower', 'upper', 'tick'] as const)
    if (!validGridDecimal(input[key])) return failure('invalid_decimal', `${key}: use a positive plain decimal with at most 18 decimal places`);
  if (!Number.isInteger(input.intervals) || input.intervals < 1 || input.intervals > 100 || !new D(input.lower).lt(input.upper))
    return failure('invalid_geometry', 'Choose an increasing range and 1–100 intervals');
  const lower = new D(input.lower), tick = new D(input.tick), spacing = new D(input.upper).minus(lower).div(input.intervals);
  const prices = Array.from({ length: input.intervals + 1 }, (_, i) => floor(lower.plus(spacing.times(i)), tick));
  if (prices.some((p, i) => p.lte(0) || i > 0 && p.lte(prices[i - 1])))
    return failure('duplicate_prices', 'Tick rounding collapses grid lines; widen the range or reduce intervals');
  return { ok: true, lines: prices.map((p, ordinal) => ({ ordinal, price: text(p) })) };
}


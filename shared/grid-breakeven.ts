import Decimal from 'decimal.js';

const D = Decimal.clone({ precision: 220 });
/** Strict comparison only: callers must include estimated closing costs in newStop. */
export function stopLocksProfit(side: string, newStop: string | null, botBreakeven: string | null): boolean {
  const valid = (value: unknown): value is string => typeof value === 'string' && value.length <= 100
    && value.trim() === value && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value);
  if (!valid(newStop) || !valid(botBreakeven) || !new D(newStop).gt(0)) return false;
  return side === 'long' ? new D(newStop).gt(botBreakeven)
    : side === 'short' ? new D(newStop).lt(botBreakeven) : false;
}

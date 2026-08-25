export interface AiTraderChartPriceFormat {
  type: 'price';
  precision: number;
  minMove: number;
}

const MAX_TICK_PRECISION = 12;

function precisionForTick(tickSize: number): number {
  for (let precision = 0; precision <= MAX_TICK_PRECISION; precision += 1) {
    const scaled = tickSize * 10 ** precision;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9) return precision;
  }
  return MAX_TICK_PRECISION;
}

function precisionForMagnitude(price: number): number {
  if (price < 0.01) return 6;
  if (price < 1) return 4;
  if (price < 10) return 3;
  return 2;
}

export function deriveAiTraderChartPriceFormat(
  tickSize: number | null | undefined,
  renderedPrices: readonly number[],
): AiTraderChartPriceFormat {
  if (typeof tickSize === 'number' && Number.isFinite(tickSize) && tickSize > 0) {
    return { type: 'price', precision: precisionForTick(tickSize), minMove: tickSize };
  }

  const positivePrices = renderedPrices
    .filter((price) => Number.isFinite(price) && price !== 0)
    .map((price) => Math.abs(price));
  const referencePrice = positivePrices.length > 0 ? Math.min(...positivePrices) : 10;
  const precision = precisionForMagnitude(referencePrice);
  return { type: 'price', precision, minMove: Number(`1e-${precision}`) };
}

export function readDecisionTimeLeverage(clampedDecision: unknown): number | null {
  if (!clampedDecision || typeof clampedDecision !== 'object' || Array.isArray(clampedDecision)) {
    return null;
  }
  const leverage = (clampedDecision as Record<string, unknown>).leverage;
  return typeof leverage === 'number' && Number.isFinite(leverage) && leverage > 0
    ? leverage
    : null;
}

export function formatDecisionTimeLeverage(leverage: number | null): string {
  if (leverage === null || !Number.isFinite(leverage) || leverage <= 0) return '\u2014';
  return `${leverage.toFixed(2).replace(/\.?0+$/, "")}\u00d7`;
}

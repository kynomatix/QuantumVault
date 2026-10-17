import { HOUR, LIQUIDATION_DAY, type ModelHour, type LiquidationInputs } from '../../server/market-stats/liquidations-model';
export const END = Date.UTC(2026, 9, 17);
export function hour(i: number, oiBtc: number, price = 100): ModelHour {
  return { time: END + i * HOUR, open: price, high: price, low: price, close: price, oiBtc };
}
export function fullInputs(end = END): LiquidationInputs {
  const candles = Array.from({ length: 38 * 24 }, (_, i) => ({ time: end - 38 * LIQUIDATION_DAY + i * HOUR, open: 100, high: 100, low: 100, close: 100 }));
  return { candles, oi: candles.map((c, i) => ({ time: c.time, btc: 1000 + i })), fetchedAt: end + HOUR };
}

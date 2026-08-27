import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deriveAiTraderChartPriceFormat,
  formatDecisionTimeLeverage,
  readDecisionTimeLeverage,
} from '../../client/src/lib/ai-trader-position-display';

const chartSource = readFileSync(
  resolve(process.cwd(), 'client/src/components/AiTraderDecisionChart.tsx'),
  'utf8',
);
const drawerSource = readFileSync(
  resolve(process.cwd(), 'client/src/components/AiTraderDrawer.tsx'),
  'utf8',
);

describe('AI Trader position display truth', () => {
  it('derives precision and minimum movement from a valid venue tick', () => {
    expect(deriveAiTraderChartPriceFormat(0.0005, [123])).toEqual({
      type: 'price',
      precision: 4,
      minMove: 0.0005,
    });
    expect(deriveAiTraderChartPriceFormat(0.25, [123])).toEqual({
      type: 'price',
      precision: 2,
      minMove: 0.25,
    });
  });

  it('uses the most precise existing magnitude band across rendered prices', () => {
    expect(deriveAiTraderChartPriceFormat(undefined, [20])).toMatchObject({ precision: 2, minMove: 0.01 });
    expect(deriveAiTraderChartPriceFormat(undefined, [9.5, 20])).toMatchObject({ precision: 3, minMove: 0.001 });
    expect(deriveAiTraderChartPriceFormat(undefined, [0.98, 20])).toMatchObject({ precision: 4, minMove: 0.0001 });
    expect(deriveAiTraderChartPriceFormat(undefined, [0.0098, 20])).toMatchObject({ precision: 6, minMove: 0.000001 });
    expect(deriveAiTraderChartPriceFormat(undefined, [])).toMatchObject({ precision: 2, minMove: 0.01 });
  });

  it('keeps the observed JUP levels distinguishable', () => {
    const format = deriveAiTraderChartPriceFormat(undefined, [0.215, 0.2105, 0.1984, 0.195]);
    expect(format.precision).toBe(4);
    expect((0.1984).toFixed(format.precision)).not.toBe((0.195).toFixed(format.precision));
  });

  it('reads only a valid decision-time clamped leverage and formats it compactly', () => {
    expect(readDecisionTimeLeverage({ leverage: 3.25 })).toBe(3.25);
    expect(readDecisionTimeLeverage({ leverage: 0 })).toBeNull();
    expect(readDecisionTimeLeverage({ leverage: Number.NaN })).toBeNull();
    expect(readDecisionTimeLeverage(null)).toBeNull();
    expect(formatDecisionTimeLeverage(3)).toBe('3\u00d7');
    expect(formatDecisionTimeLeverage(3.25)).toBe('3.25\u00d7');
    expect(formatDecisionTimeLeverage(null)).toBe('\u2014');
  });

  it('applies one shared format to every price-bearing chart series', () => {
    expect(chartSource.match(/priceFormat: chartPriceFormat/g)).toHaveLength(5);
    expect(chartSource).toContain('deriveAiTraderChartPriceFormat(undefined, [');
    expect(chartSource).toContain('...candles.flatMap((c) => [c.open, c.high, c.low, c.close])');
  });

  it('labels the card fact as decision leverage without cap or reconstructed applied leverage', () => {
    const card = drawerSource.slice(
      drawerSource.indexOf('{openDecision && ('),
      drawerSource.indexOf("{bot.status === 'open' && !openDecision && ("),
    );
    expect(card).toContain('Decision leverage {formatDecisionTimeLeverage(decisionTimeLeverage)}');
    expect(card).toContain('data-testid="text-open-position-decision-leverage"');
    expect(card).not.toContain('bot.maxLeverage');
    expect(card).not.toContain('marginUsdc /');
    expect(card).not.toContain('sizeBase *');
    expect(card).not.toContain('notional');
  });
});

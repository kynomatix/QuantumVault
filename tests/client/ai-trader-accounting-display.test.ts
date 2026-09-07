import { describe, expect, it } from 'vitest';
import { accountingNumber, performanceCompleteness } from '../../client/src/lib/ai-trader-accounting-display';

describe('AI Trader accounting display truth', () => {
  it.each([null, undefined, '', '  ', NaN, Infinity, -Infinity, 'bad', 'Infinity', false, [], {}])('does not invent zero for %j', value => {
    expect(accountingNumber(value)).toBeNull();
  });
  it.each([[0, 0], ['0.00', 0], ['-104.90', -104.9], [43.96, 43.96]])('preserves finite accounting %j', (value, expected) => {
    expect(accountingNumber(value)).toBe(expected);
  });
  it('labels a known subtotal incomplete when a confirmed close is unpriced', () => {
    expect(performanceCompleteness({tradeCount: 7, omittedInvalidPnlTrades: 1, omittedUnattributedTrades: 0}))
      .toEqual({incomplete: true, hasPricedSubtotal: true, missingPnl: 1, unattributed: 0});
  });
  it('does not display zero as the result of an entirely unpriced population', () => {
    expect(performanceCompleteness({tradeCount: 0, omittedInvalidPnlTrades: 1, omittedUnattributedTrades: 0}).hasPricedSubtotal).toBe(false);
  });
  it('preserves genuine empty and zero-net priced populations', () => {
    for (const tradeCount of [0, 2]) expect(performanceCompleteness({tradeCount, omittedInvalidPnlTrades: 0, omittedUnattributedTrades: 0}))
      .toEqual({incomplete: false, hasPricedSubtotal: true, missingPnl: 0, unattributed: 0});
  });
  it('discloses unknown terminal mode without assigning it to paper or live', () => {
    expect(performanceCompleteness({tradeCount: 0, omittedInvalidPnlTrades: 0, omittedUnattributedTrades: 2}))
      .toEqual({incomplete: true, hasPricedSubtotal: false, missingPnl: 0, unattributed: 2});
  });
  it.each([undefined, -1, 0.5, NaN, '0'])('does not treat malformed omission counts as complete: %j', count => {
    expect(performanceCompleteness({tradeCount: 7, omittedInvalidPnlTrades: count, omittedUnattributedTrades: 0}).hasPricedSubtotal).toBe(false);
  });
});

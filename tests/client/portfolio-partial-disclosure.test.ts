import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { PortfolioLiveValue, PortfolioPartialNotice, portfolioValueClass } from '../../client/src/components/PortfolioLiveValue';

describe('portfolio partial disclosure', () => {
  it.each(['dollar', 'percent'] as const)('renders a neutral dash for unavailable %s values', format => {
    expect(renderToStaticMarkup(createElement(PortfolioLiveValue, { value: null, format, signed: true }))).toBe('—');
    expect(portfolioValueClass(null)).toBe('text-muted-foreground');
  });

  it('shows the plain notice only while partial', () => {
    const notice = renderToStaticMarkup(createElement(PortfolioPartialNotice, { partial: true }));
    expect(notice).toContain('Some balances could not be read just now. Totals will return shortly.');
    expect(notice).toContain('role="status"');
    expect(notice).not.toMatch(/text-(red|emerald)/);
    expect(renderToStaticMarkup(createElement(PortfolioPartialNotice, { partial: false }))).toBe('');
  });

  it.each([
    [0, 'dollar', '+$0.00'], [25, 'percent', '+25.00%'], [-5, 'dollar', '$-5.00'],
  ] as const)('keeps the complete display for %s %s', (value, format, expected) => {
    expect(renderToStaticMarkup(createElement(PortfolioLiveValue, { value, format, signed: true }))).toBe(expected);
    expect(portfolioValueClass(value)).toBe(value >= 0 ? 'text-emerald-400' : 'text-red-400');
  });

  it('wires all headline values and chart colour through nullable guards', () => {
    const source = readFileSync('client/src/pages/App.tsx', 'utf8');
    for (const field of ['currentBalance', 'netPnl', 'pnlPercent']) {
      expect(source).toContain(`portfolioPartial ? null : portfolioPerformanceData?.${field} ?? null`);
      expect(source).not.toMatch(new RegExp(`portfolioPerformanceData\\.${field}\\s*(?:>=|\\.toFixed)`));
    }
    expect(source).toContain('<PortfolioPartialNotice partial={portfolioPartial} />');
    expect(source).toContain("portfolioPnl === null ? '#6b7280'");
    expect(source).toContain('value={portfolioBalance}');
    expect(source).toContain('value={portfolioDisplayedPnl}');
    expect(source).toContain('value={portfolioReturn}');
  });
});

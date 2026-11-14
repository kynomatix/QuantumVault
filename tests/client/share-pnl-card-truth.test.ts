import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SharePnLCard, getPerformanceChartCaption, getSharePnLCardText } from '../../client/src/components/SharePnLCard';

vi.mock('react', async (importOriginal) => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => [initial, vi.fn()],
  useEffect: vi.fn(),
}));
vi.mock('../../client/src/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

// Execute the actual preview/export canvas path without a browser or rasterizer.
function renderCard(timeframe: '7d' | '30d' | '90d' | 'all', pnl = 125.5, pnlPercent: number | null = 12.55, tradeCount: number | null = 3, performanceLoading = false, performanceStale = false, chart: { chartData?: { timestamp: string; cumulativePnl: number }[] } = { chartData: [{ timestamp: '2026-11-01', cumulativePnl: 0 }, { timestamp: '2026-11-02', cumulativePnl: pnl }] }) {
  const drawnText: Array<{ value: string; x: number; y: number; font: string; width: number }> = [];
  const ctx = {
    font: '',
    scale: vi.fn(), beginPath: vi.fn(), roundRect: vi.fn(), fill: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fillRect: vi.fn(), arc: vi.fn(),
    createLinearGradient: () => ({ addColorStop: vi.fn() }),
    measureText(value: string) {
      return { width: value.length * Number.parseFloat(this.font.match(/([\d.]+)px/)?.[1] ?? '0') * 0.6 };
    },
    fillText(value: string, x: number, y: number) {
      drawnText.push({ value, x, y, font: this.font, width: this.measureText(value).width });
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,EXAMPLE' };
  vi.stubGlobal('document', { createElement: () => canvas });
  try {
    SharePnLCard({
      isOpen: true, onClose: vi.fn(), botName: 'My bot', market: 'BTC', pnl, pnlPercent,
      timeframe, tradeCount, performanceLoading, performanceStale, winRate: 50,
      ...chart,
    });
  } finally {
    vi.unstubAllGlobals();
  }
  return { drawnText, canvas };
}

const cardSource = readFileSync(resolve(process.cwd(), 'client/src/components/SharePnLCard.tsx'), 'utf8');
const drawerSource = readFileSync(resolve(process.cwd(), 'client/src/components/BotManagementDrawer.tsx'), 'utf8');
const periods = [
  ['7d', 'last 7 days'],
  ['30d', 'last 30 days'],
  ['90d', 'last 90 days'],
  ['all', 'all time'],
] as const;

describe('share PnL card timeframe truth', () => {
  for (const [timeframe, periodLabel] of periods) {
    it(`${timeframe}: draws the selected chart caption in the exported canvas beside the lifetime headline`, () => {
      const { drawnText } = renderCard(timeframe);
      expect(drawnText).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: 'All Time', x: 36, y: 146 }),
        expect.objectContaining({ value: `Chart: ${periodLabel}`, x: 36, y: 236 }),
      ]));
    });
  }

  it('omits the chart caption for empty or omitted data while retaining lifetime and trade labels', () => {
    for (const [timeframe, periodLabel] of periods) {
      for (const chart of [{ chartData: [] }, {}]) {
        for (const loading of [true, false]) {
          const { drawnText } = renderCard(timeframe, 125.5, 12.55, null, loading, false, chart);
          expect(drawnText.some(text => text.value.startsWith('Chart:'))).toBe(false);
          expect(drawnText).toEqual(expect.arrayContaining([
            expect.objectContaining({ value: 'All Time' }),
            expect.objectContaining({ value: '+12.55%' }),
            expect.objectContaining({ value: loading ? 'Loading trades…' : 'Trades unavailable' }),
          ]));
        }
      }
      const { drawnText } = renderCard(timeframe, 125.5, 12.55, 1, false, false, {
        chartData: [{ timestamp: '2026-11-01', cumulativePnl: 125.5 }],
      });
      expect(drawnText).toEqual(expect.arrayContaining([
        expect.objectContaining({ value: `Chart: ${periodLabel}`, x: 36, y: 236 }),
      ]));
    }
  });

  it('draws loading trades while pending and unavailable after failure without inventing a selected-period zero', () => {
    const { drawnText } = renderCard('90d', 125.5, 12.55, null, true);
    expect(drawnText).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'Loading trades…' }),
      expect.objectContaining({ value: 'Chart: last 90 days' }),
    ]));
    expect(drawnText.some(text => text.value === 'Trades unavailable')).toBe(false);
    expect(renderCard('90d', 125.5, 12.55, null).drawnText).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'Trades unavailable' }),
    ]));
    expect(drawnText.some(text => /\d+ trades? \(last 90 days\)/.test(text.value))).toBe(false);
    expect(renderCard('90d', 125.5, 12.55, 0).drawnText).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '0 trades (last 90 days)' }),
    ]));
    expect(renderCard('90d', 125.5, 12.55, 3, false, true).drawnText).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'Chart/trades: last successful data (stale)' }),
    ]));
    expect(drawerSource).toContain('performanceStale={performanceStale}');
  });

  it('fits long dollar gains and losses within the canvas while preserving short headline size', () => {
    for (const pnl of [12345678901234.56, -12345678901234.56]) {
      const { drawnText, canvas } = renderCard('7d', pnl, null);
      const headline = drawnText.find(text => text.value === `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
      expect(headline).toBeDefined();
      expect(headline!.width).toBeLessThanOrEqual(canvas.width / 2 - 72);
      expect(headline!.x + headline!.width).toBeLessThanOrEqual(canvas.width / 2 - 36);
      expect(headline!.font).not.toBe('bold 72px Inter, system-ui, sans-serif');
    }
    expect(renderCard('7d').drawnText.find(text => text.value === '+12.55%')?.font).toBe('bold 72px Inter, system-ui, sans-serif');
  });

  it('keeps trade count on the selected response and win rate on bot-wide lifetime counters', () => {
    expect(drawerSource).toContain('useBotPerformance(isOpen, bot?.id, performanceTimeframe, walletAddress)');
    const winRate = drawerSource.slice(drawerSource.indexOf('const getWinRate ='), drawerSource.indexOf('const formatWinRate ='));
    expect(winRate).toContain('const stats = localBot?.stats || bot?.stats;');
    expect(winRate).toContain('const wins = stats.winningTrades || 0;');
    expect(winRate).toContain('const losses = stats.losingTrades || 0;');
    expect(winRate).toContain('const rate = (wins / realizedTrades) * 100;');
    expect(winRate).not.toContain('performanceTimeframe');
    expect(drawerSource).toContain('tradeCount={performanceTradeCount}');
    expect(drawerSource).toContain('winRate={getWinRate()}');

    const routes = readFileSync(resolve(process.cwd(), 'server/routes.ts'), 'utf8');
    const endpointStart = routes.indexOf('app.get("/api/trading-bots/:id/performance"');
    expect(endpointStart).toBeGreaterThanOrEqual(0);
    const endpoint = routes.slice(endpointStart, routes.indexOf('Get bot performance error:', endpointStart));
    expect(endpoint).toContain('storage.getBotPerformanceSeries(req.params.id, since)');
    expect(endpoint).toContain('tradeCount: tradeSeries.length');
    const storage = readFileSync(resolve(process.cwd(), 'server/storage.ts'), 'utf8');
    const seriesStart = storage.indexOf('async getBotPerformanceSeries(');
    expect(storage.slice(seriesStart, storage.indexOf('const trades = await db', seriesStart))).toContain('conditions.push(gte(botTrades.executedAt, since))');
    const statsStart = storage.indexOf('async getCanonicalBotTradeStats(');
    const statsEnd = storage.indexOf('async ', statsStart + 6);
    expect(statsStart).toBeGreaterThanOrEqual(0);
    expect(statsEnd).toBeGreaterThan(statsStart);
    expect(storage.slice(statsStart, statsEnd)).not.toMatch(/\bsince\b|gte\(botTrades.executedAt/);
  });
  for (const [timeframe, periodLabel] of periods) {
    for (const isPublishedBot of [true, false]) {
      const input = {
        market: 'BTC', pnl: 125.5, pnlPercent: 12.55, timeframe,
        tradeCount: 3, winRate: 50, isPublishedBot, shareUrl: 'https://example.invalid/bot',
      };
      const linkText = isPublishedBot ? 'Copy my trades' : 'Join here';

      it(`${timeframe}, published=${isPublishedBot}: separates lifetime headline/post from chart and trade periods`, () => {
        const text = getSharePnLCardText(input);
        expect(text.headlineLabel).toBe('All Time');
        expect(text.headlineValue).toBe('+12.55%');
        expect(text.postText).toBe(`My BTC trading bot gained +12.55% all time!\n\n${linkText}: https://example.invalid/bot\n\nPowered by @QuantumVaultLab`);
        expect(getPerformanceChartCaption(timeframe)).toBe(`Chart: ${periodLabel}`);
        expect(text.tradesText).toBe(`3 trades (${periodLabel})`);
        expect(text.winText).toBe('50.0% win (all time)');
      });

      it(`${timeframe}, published=${isPublishedBot}: unknown return uses dollars without a fabricated percentage`, () => {
        const text = getSharePnLCardText({ ...input, pnlPercent: null });
        expect(text.headlineLabel).toBe('All Time');
        expect(text.headlineValue).toBe('+$125.50');
        expect(text.headlineValue).not.toContain('%');
        expect(text.postText).toBe(`My BTC trading bot gained +$125.50 all time!\n\n${linkText}: https://example.invalid/bot\n\nPowered by @QuantumVaultLab`);
        expect(text.postText).not.toContain('%');
        expect(text.postText).not.toContain('0.00%');
      });

      it(`${timeframe}, published=${isPublishedBot}: losses retain a single negative sign and say lost`, () => {
        const loss = { ...input, pnl: -125.5, pnlPercent: -12.55 };
        expect(getSharePnLCardText(loss).headlineValue).toBe('-12.55%');
        expect(getSharePnLCardText(loss).postText).toBe(`My BTC trading bot lost -12.55% all time!\n\n${linkText}: https://example.invalid/bot\n\nPowered by @QuantumVaultLab`);
        const dollarLoss = getSharePnLCardText({ ...loss, pnlPercent: null });
        expect(dollarLoss.headlineValue).toBe('-$125.50');
        expect(dollarLoss.postText).toBe(`My BTC trading bot lost -$125.50 all time!\n\n${linkText}: https://example.invalid/bot\n\nPowered by @QuantumVaultLab`);
      });
    }
  }

  it('distinguishes a known zero return from an unknown return and preserves the no-link post variant', () => {
    const input = { market: 'BTC', pnl: 0, pnlPercent: 0, timeframe: 'all' as const, tradeCount: 1 };
    expect(getSharePnLCardText(input).headlineValue).toBe('+0.00%');
    const unknown = getSharePnLCardText({ ...input, pnlPercent: null });
    expect(unknown.headlineValue).toBe('+$0.00');
    expect(unknown.postText).toBe('My BTC trading bot gained +$0.00 all time!\n\nPowered by @QuantumVaultLab');
    expect(unknown.tradesText).toBe('1 trade (all time)');
    expect(unknown.winText).toBeUndefined();
    expect(getSharePnLCardText({ ...input, winRate: NaN }).winText).toBeUndefined();
  });

  it('wires the tested text into the image and post, and preserves null from the drawer', () => {
    expect(cardSource).toContain('pnlPercent: number | null;');
    expect(drawerSource).toContain('pnlPercent={overviewReturnPct}');
    expect(drawerSource).not.toContain('pnlPercent={overviewReturnPct ?? 0}');
    expect(cardSource).toContain('ctx.fillText(text.headlineLabel, padding, padding + 110)');
    expect(cardSource).toContain('ctx.fillText(text.headlineValue, padding, padding + 175)');
    expect(cardSource).toContain('const tradesText = text.tradesText;');
    expect(cardSource).toContain('ctx.fillText(text.winText, statsX, padding + 220)');
    expect(cardSource).toContain('const tweetText = text.postText;');
    expect(cardSource).toContain('encodeURIComponent(tweetText)');
    expect(cardSource).toContain('Chart / trades period:');
    expect(drawerSource).toContain('{getPerformanceChartCaption(performanceTimeframe)}');
  });

  it('labels both the drawer percent chart and period total as a share of current net deposits', () => {
    const chartStart = drawerSource.indexOf('data-testid="performance-chart-container"');
    const chartEnd = drawerSource.indexOf('data-testid="performance-accounting-incomplete"', chartStart);
    expect(chartStart).toBeGreaterThanOrEqual(0);
    expect(chartEnd).toBeGreaterThan(chartStart);
    const chart = drawerSource.slice(chartStart, chartEnd);
    expect(chart.length).toBeGreaterThan(0);
    expect(chart).toContain('<p className="text-xs text-muted-foreground">% of current net deposits</p>');
    expect(chart).toContain("showPerformancePercent ? 'PnL (% of current net deposits)' : 'PnL'");
    expect(chart).toContain('${((performanceTotalPnl / netDeposited) * 100).toFixed(2)}% of current net deposits');
    expect(chart).toContain('(d.cumulativePnl / netDeposited) * 100');
  });

  it('disables percent mode without positive deposits and consistently falls back to dollar rendering', () => {
    expect(drawerSource).toContain("const showPerformancePercent = performanceView === 'percent' && netDeposited > 0;");
    const percentButton = drawerSource.slice(drawerSource.indexOf("onClick={() => setPerformanceView('percent')}"), drawerSource.indexOf("onClick={() => setPerformanceView('percent')}") + 180);
    expect(percentButton).toContain('disabled={netDeposited <= 0}');
    expect(drawerSource).toContain('data={showPerformancePercent');
    expect(drawerSource).toContain('tickFormatter={(value) => showPerformancePercent');
    expect(drawerSource).toContain("dataKey={showPerformancePercent ? 'cumulativePnlPercent' : 'cumulativePnl'}");
  });
});

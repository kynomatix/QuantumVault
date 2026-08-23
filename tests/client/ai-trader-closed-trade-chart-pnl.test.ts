import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { reconcileChartTarget } from '../../client/src/lib/ai-trader-chart-target';

const openTarget = { decisionId: 'decision-1', closedAt: null };

describe('AI Trader closed-trade chart lifecycle', () => {
  it('keeps a target while the same decision remains open', () => {
    expect(reconcileChartTarget(openTarget, 'decision-1', [])).toEqual({ kind: 'keep' });
  });

  it('replaces a pre-close target with its durable terminal row', () => {
    const row = { id: 'decision-1', closedAt: '2026-08-24T00:00:00Z', realizedPnl: null };
    expect(reconcileChartTarget(openTarget, null, [row])).toEqual({ kind: 'replace', row });
  });

  it('clears a no-longer-open target when terminal truth is unavailable', () => {
    expect(reconcileChartTarget(openTarget, null, [])).toEqual({ kind: 'clear' });
  });

  it('leaves an already-terminal target stable', () => {
    const terminalTarget = { decisionId: 'decision-1', closedAt: 1 };
    expect(reconcileChartTarget(terminalTarget, null, [])).toEqual({ kind: 'keep' });
  });

  it('uses closedAt for every chart and drawer terminality seam', () => {
    const chart = readFileSync('client/src/components/AiTraderDecisionChart.tsx', 'utf8');
    const drawer = readFileSync('client/src/components/AiTraderDrawer.tsx', 'utf8');

    expect(chart).not.toMatch(/realizedPnl\s*(?:===|!==)\s*null/);
    expect(chart.match(/closedAt\s*===\s*null/g)).toHaveLength(2);
    expect(chart).toContain('closedAt !== null');
    expect(drawer).toContain('chartTarget.closedAt === null');
  });

  it('shares durable-row mapping between history clicks and poll reconciliation', () => {
    const drawer = readFileSync('client/src/components/AiTraderDrawer.tsx', 'utf8');
    expect(drawer).toContain('function decisionRowToChartTarget');
    expect(drawer).toContain('setChartTarget(decisionRowToChartTarget(d))');
    expect(drawer).toContain('return decisionRowToChartTarget(result.row);');
    expect(drawer).toContain('setChartTarget(null);');
  });
});

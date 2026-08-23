export interface ChartTargetLifecycleRef {
  decisionId: string;
  closedAt: string | number | null;
}

export interface DecisionLifecycleRef {
  id: string;
  closedAt: string | number | null;
}

export type ChartTargetReconciliation<TRow extends DecisionLifecycleRef> =
  | { kind: 'keep' }
  | { kind: 'replace'; row: TRow }
  | { kind: 'clear' };

/**
 * Reconciles a click-time chart target against the latest durable decision
 * state. `closedAt` is the sole terminal authority; nullable PnL is not.
 */
export function reconcileChartTarget<TRow extends DecisionLifecycleRef>(
  target: ChartTargetLifecycleRef | null,
  openDecisionId: string | null,
  refreshedRows: readonly TRow[],
): ChartTargetReconciliation<TRow> {
  if (target === null || target.closedAt !== null) return { kind: 'keep' };
  if (openDecisionId === target.decisionId) return { kind: 'keep' };

  const terminalRow = refreshedRows.find(
    row => row.id === target.decisionId && row.closedAt !== null,
  );
  return terminalRow
    ? { kind: 'replace', row: terminalRow }
    : { kind: 'clear' };
}

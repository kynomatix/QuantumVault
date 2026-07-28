import type { BorrowOperation, BorrowPosition } from "@shared/schema";

/**
 * Terminal allowlists shared by the ordinary reset preflight and the
 * transaction-bound reset finalizer. Unknown/future/null statuses block by
 * construction; never replace these with a list of statuses believed active.
 */
export const TERMINAL_POSITION_STATUSES: ReadonlySet<string> = new Set(["closed", "failed"]);

export const TERMINAL_OPERATION_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "completed",
  "failed",
]);

export type ResetBlockerAssessment =
  | { blocked: false }
  | { blocked: true; reason: "active_vault_state" | "vault_state_unreadable" };

/** Pure row assessment so transaction-bound reads cannot drift from checkpoint 1. */
export function assessResetBlockerRows(
  classicPositions: BorrowPosition[],
  loopPositions: BorrowPosition[],
  operations: BorrowOperation[],
): ResetBlockerAssessment {
  const hasActivePosition = [...classicPositions, ...loopPositions].some(
    (p) => !TERMINAL_POSITION_STATUSES.has(String((p as { status?: unknown }).status ?? "")),
  );
  const hasActiveOperation = operations.some(
    (o) => !TERMINAL_OPERATION_STATUSES.has(String((o as { status?: unknown }).status ?? "")),
  );

  return hasActivePosition || hasActiveOperation
    ? { blocked: true, reason: "active_vault_state" }
    : { blocked: false };
}

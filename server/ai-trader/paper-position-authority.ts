import type { AiTraderDecision } from "@shared/schema";
import { parseBreakevenProtect, type BreakevenProtectState } from "./breakeven";
import type { PaperSide } from "./paper-math";

export interface OpenDecisionView {
  decision: AiTraderDecision;
  side: PaperSide;
  sizeBase: number;
  marginUsdc: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  /** Recorded entry fill (may be null pre-reconciliation for crashed live entries). */
  entryPrice: number | null;
  decidedAtMs: number;
  /** Breakeven-protect ratchet state — presence means it already fired. */
  breakevenProtect: BreakevenProtectState | null;
}

export type PaperPositionState = "open" | "flat" | "unknown";
export type PaperPositionAuthority = "paper_ledger" | "unknown";
export type PaperPositionInconsistencyReason =
  | "multiple_open_rows"
  | "malformed_open_row"
  | "status_requires_open_row"
  | "status_row_mismatch"
  | "unrecognised_status";

export interface PaperPositionResolution {
  positionState: PaperPositionState;
  positionAuthority: PaperPositionAuthority;
  view: OpenDecisionView | null;
  reason: PaperPositionInconsistencyReason | null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * Parse one currently-open decision row into validated paper-position values.
 * Invalid or absent rows return null; callers decide whether that means flat or
 * inconsistent from the independently durable bot status.
 */
export function parseOpenDecision(decisions: AiTraderDecision[]): OpenDecisionView | null {
  const row = decisions.find((decision) => decision.outcome === "executed" && !decision.closedAt);
  if (!row) return null;
  const clamped = (row.clampedDecision ?? {}) as Record<string, unknown>;
  const action = clamped.action;
  if (action !== "long" && action !== "short") return null;
  const sizeBase = num(clamped.sizeBase);
  const marginUsdc = num(clamped.marginUsdc);
  const stopLossPrice = num(clamped.stopLossPrice);
  const takeProfitPrice = num(clamped.takeProfitPrice);
  if (!sizeBase || sizeBase <= 0 || !stopLossPrice || stopLossPrice <= 0 || !takeProfitPrice || takeProfitPrice <= 0) {
    return null;
  }
  const decidedAtMs = row.decidedAt ? new Date(row.decidedAt).getTime() : Date.now();
  return {
    decision: row,
    side: action,
    sizeBase,
    marginUsdc: marginUsdc ?? 0,
    stopLossPrice,
    takeProfitPrice,
    entryPrice: num(row.entryPrice),
    decidedAtMs,
    breakevenProtect: parseBreakevenProtect(clamped.breakevenProtect, stopLossPrice, decidedAtMs),
  };
}

/** Display-grade mark-to-market for an open paper or live position. */
export function computeUnrealizedPnl(view: OpenDecisionView, markPrice: number): number | null {
  if (
    view.entryPrice === null ||
    !Number.isFinite(view.entryPrice) ||
    view.entryPrice <= 0 ||
    !Number.isFinite(markPrice) ||
    markPrice <= 0 ||
    !Number.isFinite(view.sizeBase) ||
    view.sizeBase <= 0
  ) {
    return null;
  }
  const direction = view.side === "long" ? 1 : -1;
  return (markPrice - view.entryPrice) * view.sizeBase * direction;
}

const FLAT_WITHOUT_ROW = new Set(["idle", "paused", "stopped"]);
const TRANSIENT_REQUIRING_ROW = new Set(["analyzing", "proposed", "executing", "open"]);
const OPEN_WITH_VALID_ROW = new Set(["open", "paused"]);

export function resolvePaperPositionState(
  botStatus: string,
  openRows: AiTraderDecision[],
): PaperPositionResolution {
  if (openRows.length > 1) {
    return { positionState: "unknown", positionAuthority: "unknown", view: null, reason: "multiple_open_rows" };
  }

  if (openRows.length === 1) {
    const view = parseOpenDecision(openRows);
    if (!view) {
      return { positionState: "unknown", positionAuthority: "unknown", view: null, reason: "malformed_open_row" };
    }
    if (OPEN_WITH_VALID_ROW.has(botStatus)) {
      return { positionState: "open", positionAuthority: "paper_ledger", view, reason: null };
    }
    if (
      botStatus === "idle" ||
      botStatus === "stopped" ||
      botStatus === "analyzing" ||
      botStatus === "proposed" ||
      botStatus === "executing"
    ) {
      return { positionState: "unknown", positionAuthority: "unknown", view: null, reason: "status_row_mismatch" };
    }
    return { positionState: "unknown", positionAuthority: "unknown", view: null, reason: "unrecognised_status" };
  }

  if (FLAT_WITHOUT_ROW.has(botStatus)) {
    return { positionState: "flat", positionAuthority: "paper_ledger", view: null, reason: null };
  }
  if (TRANSIENT_REQUIRING_ROW.has(botStatus)) {
    return { positionState: "unknown", positionAuthority: "unknown", view: null, reason: "status_requires_open_row" };
  }
  return { positionState: "unknown", positionAuthority: "unknown", view: null, reason: "unrecognised_status" };
}

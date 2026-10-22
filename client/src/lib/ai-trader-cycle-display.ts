import type { CycleReason, LatestCycle } from "@shared/ai-trader-cycle";
import { sanitizeGatewayFailure } from "@shared/ai-gateway-failure";
import { FLAT_REASON_LABELS } from "@shared/ai-trader-flat-reasons";

const REASON_LABELS: Record<CycleReason, string> = {
  paused: "Skipped: bot paused", position_open: "Skipped: position already open",
  auto_next_off: "Skipped: automatic checks off", mode_suggest: "Skipped: suggestion mode",
  venue_retired: "Skipped: venue retired", venue_unavailable: "Skipped: venue unavailable",
  schema_not_ready: "Skipped: required data unavailable", cooldown: "Skipped: cooldown",
  daily_cap: "Skipped: daily trade cap", model_key_missing: "Skipped: model key missing",
  reauth_required: "Skipped: reconnect wallet", model_unsupported: "Skipped: model unavailable",
  state_unresolved: "Skipped: bot state unresolved", claim_lost: "Skipped: another check owns this cycle",
  scanner_disabled: "Skipped: scanner disabled", shortlist_empty: "Skipped: no eligible scanner candidate",
  shortlist_stale: "Skipped: scanner shortlist unavailable or stale", feed_basis_unavailable: "Skipped: candle basis unavailable",
  feed_stale: "Skipped: stale candle data", feed_cache_degraded: "Skipped: candle cache unavailable",
  gateway_timeout: "Failed: model request timed out", gateway_error: "Failed: model gateway error",
  model_malformed: "Failed: model reply malformed", audit_write_failed: "Cycle history unavailable",
  model_flat: "Model chose flat", model_entry: "Model proposed an entry", model_close: "Model chose to close",
  guardrail_rejected: "Entry rejected by guardrails", close_without_position: "Model chose close with no open position",
  proposal_created: "Suggestion created", entry_executed: "Entry executed", execution_rejected: "Entry execution rejected",
  position_management: "Position managed", scanner_boundary_lane_timeout: "Deferred: scanner boundary still busy",
  scanner_boundary_lane_wait_failed: "Deferred: scanner boundary unavailable", cycle_interrupted: "Check interrupted",
  internal_error: "Failed: internal cycle error", wallet_agent_missing: "Skipped: wallet agent missing",
  malfunction_ceiling: "Paused: daily safety ceiling",
};

export function currentScheduleLabel(bot: { status: string; mode: string; autoNext: boolean }): string {
  if (bot.status === "paused") return "Currently paused";
  if (bot.mode === "suggest") return "Currently in suggestion mode";
  if (!bot.autoNext) return "Automatic checks are currently off";
  if (bot.status === "open") return "Currently managing an open position";
  return "Automatic checks enabled";
}

export function cycleDisplay(latest?: LatestCycle) {
  const cycle = latest?.cycle;
  const base = { time: cycle?.startedAt ?? null, flatLabels: [] as string[], rationale: null as string | null, schedule: null as string | null, gatewayDetail: null as string | null };
  if (!latest || latest.status === "unavailable") return { ...base, outcome: "Cycle history unavailable" };
  if (!cycle) return { ...base, outcome: "No automatic cycle recorded yet" };
  if (cycle.outcome === "running") return { ...base, outcome: cycle.completionUnknown ? "Incomplete check: completion unknown" : "Check running" };
  const failure = cycle.reasonCode === "gateway_error" || cycle.reasonCode === "gateway_timeout"
    ? sanitizeGatewayFailure(cycle.gatewayFailure) : null;
  return { ...base, outcome: cycle.reasonCode === "cooldown" && cycle.detailCodes.includes("market_entry_pending")
    ? "Skipped: entry pending on this market — waiting for reconciliation"
    : cycle.reasonCode === "cooldown" && cycle.detailCodes.includes("market_cooldown")
      ? `Skipped: market cooldown${cycle.availableAt ? ` — eligible after ${new Date(cycle.availableAt).toLocaleString()}` : ""}`
      : cycle.reasonCode ? REASON_LABELS[cycle.reasonCode] : "Check completed",
    gatewayDetail: failure ? [failure.failureClass, failure.httpStatus ? `HTTP ${failure.httpStatus}` : null,
      failure.providerCode, failure.providerType, `${failure.elapsedMs} ms`, `${failure.attemptCount} attempt(s)`].filter(Boolean).join(" · ") : null,
    flatLabels: cycle.reasonCode === "model_flat" ? cycle.flatReasons?.map(reason => `Model reason: ${FLAT_REASON_LABELS[reason]}`) ?? ["Model reason not recorded"] : [], rationale: cycle.rationale,
    schedule: cycle.rearmed && cycle.nextPlannedBoundary
      ? `Next check was scheduled for ${new Date(cycle.nextPlannedBoundary).toLocaleString()}`
      : "No next check was scheduled by this cycle.",
  };
}

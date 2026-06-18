import {
  Wand2,
  FlaskConical,
  ShieldCheck,
  Microscope,
  Check,
  Loader2,
  Clock,
  Minus,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Shared "quant agent" checklist: the animated task list the Lab Assistant shows while
 * an Auto run drives a strategy end-to-end (draft, backtest, robustness, refine). The
 * SAME stage rows render in two places so they look identical:
 *   - the LIVE dock (LabAssistantDock), driven by the real planner via the polled DTO, and
 *   - the canned landing demo (LabAssistantDemo), driven by its animation clock.
 *
 * The derivation here is the single honest mapping from the real planner's persisted
 * phase + counters onto the four stages. It is pure and unit-tested.
 */

// The auto-progress slice the server attaches to the polled task DTO (server side:
// toAutoChecklistDto in server/ai-assistant/routes.ts). Mirrored here for the client.
export interface AutoChecklistDto {
  phase: "create" | "backtest" | "evaluate" | "insights" | "improve" | "done";
  improveCount: number;
  graduated: boolean;
  // True when the auto run is parked on a locked session (30-min UMK timeout) and is
  // waiting on a wallet re-sign to resume. The dock shows Continue / Start-new chips.
  pausedForReauth?: boolean;
  pendingConfirm: { tool: "createStrategyFromText" | "improve"; estCostUsd: number } | null;
  activeRun: {
    status: string;
    stage: string | null;
    progressPct: number | null;
    jobsAhead: number | null;
  } | null;
  // The best result the agent has for its current strategy, so the dock can render a
  // real result card + Deploy button (which only OPENS the deploy modal; money path).
  // Headline numbers only; the dock fetches the full result row on demand for the
  // post-leverage math. Mirror of AutoDeployableResultView in
  // server/ai-assistant/deployable-result.ts. Present only on auto tasks.
  deployableResult?: {
    status: "ready" | "pending" | "unavailable";
    strategyId: number;
    bestResultId: number | null;
    runId: number | null;
    ticker: string | null;
    timeframe: string | null;
    netProfitPercent: number | null;
    maxDrawdownPercent: number | null;
    winRatePercent: number | null;
    oosSharpe: number | null;
  } | null;
}

export type StageState = "pending" | "running" | "waiting" | "done" | "skipped" | "failed";

export interface QuantStep {
  state: StageState;
  /** Short live sub-line shown instead of the static stage blurb when present. */
  detail?: string;
}

export interface QuantStage {
  id: string;
  label: string;
  sub: string;
  Icon: typeof Wand2;
}

// The four stages, in the order the user reads them. This is the honest pipeline order:
// the agent drafts, backtests, checks it on data it never saw, and only THEN rewrites if
// it didn't hold up (the improve loop). Used by BOTH the live dock and the demo.
export const QUANT_AGENT_STAGES: QuantStage[] = [
  { id: "draft", label: "Draft strategy", sub: "Writes a strategy from your words", Icon: Wand2 },
  { id: "backtest", label: "Backtest", sub: "Sweeps thousands of parameter combinations", Icon: FlaskConical },
  { id: "robustness", label: "Check robustness", sub: "Scores it on data it never saw", Icon: ShieldCheck },
  { id: "improve", label: "Improve if needed", sub: "Rewrites and retries until it holds up", Icon: Microscope },
];

const MAX_IMPROVE_ROUNDS = 3; // mirrors auto-planner.ts maxImproveLoops

function money(usd: number): string {
  return `$${(usd ?? 0).toFixed(2)}`;
}

// Turn the live run's status into a short, honest sub-line for the Backtest row.
function runDetail(run: NonNullable<AutoChecklistDto["activeRun"]>): string {
  if (run.status === "queued") {
    return run.jobsAhead && run.jobsAhead > 0 ? `Queued · ${run.jobsAhead} ahead` : "Queued";
  }
  if (run.progressPct != null) return `Running · ${Math.round(run.progressPct)}%`;
  return "Running";
}

/**
 * The single source of truth that maps the real planner state onto the four stage rows.
 * Pure: same input always yields the same output. Honest about the planner's quirks:
 *  - a queued/running backtest keeps the Backtest row "running" even though the planner
 *    has already advanced its phase to "evaluate" (it advances when it QUEUES the run);
 *  - graduation (proving on SOL, then widening to ETH/ARB) reads as a second robustness
 *    pass, not a new stage;
 *  - the improve loop reports its round, and "no improve needed" reads as skipped.
 */
export function deriveQuantAgentSteps(auto: AutoChecklistDto | null | undefined): QuantStep[] {
  if (!auto) return QUANT_AGENT_STAGES.map(() => ({ state: "pending" as StageState }));

  const { phase, improveCount, graduated, pendingConfirm, activeRun } = auto;
  const runActive = !!activeRun && (activeRun.status === "queued" || activeRun.status === "running");
  const runFailed = !!activeRun && activeRun.status === "failed";

  // 1) Draft strategy
  let draft: QuantStep;
  if (pendingConfirm?.tool === "createStrategyFromText") {
    draft = { state: "waiting", detail: `Waiting for your OK (~${money(pendingConfirm.estCostUsd)})` };
  } else if (phase === "create") {
    draft = { state: "running", detail: "Writing the strategy" };
  } else {
    draft = { state: "done" };
  }

  // 2) Backtest
  let backtest: QuantStep;
  if (runFailed) {
    backtest = { state: "failed", detail: "Backtest failed" };
  } else if (runActive) {
    backtest = { state: "running", detail: runDetail(activeRun!) };
  } else if (phase === "create") {
    backtest = { state: "pending" };
  } else if (phase === "backtest") {
    backtest = { state: "running", detail: "Queuing the backtest" };
  } else {
    backtest = { state: "done" };
  }

  // 3) Check robustness (out-of-sample)
  let robustness: QuantStep;
  if (phase === "create" || phase === "backtest") {
    robustness = { state: "pending" };
  } else if (runActive) {
    robustness = graduated
      ? { state: "running", detail: "Checking it generalizes to ETH and ARB" }
      : { state: "pending", detail: "Waiting for backtest results" };
  } else if (phase === "evaluate") {
    robustness = {
      state: "running",
      detail: graduated ? "Confirming it generalizes" : "Scoring it on data it never saw",
    };
  } else {
    robustness = { state: "done" };
  }

  // 4) Improve if needed
  let improve: QuantStep;
  if (pendingConfirm?.tool === "improve") {
    improve = {
      state: "waiting",
      detail: `Waiting for your OK (~${money(pendingConfirm.estCostUsd)}) · round ${improveCount + 1}/${MAX_IMPROVE_ROUNDS}`,
    };
  } else if (phase === "insights" || phase === "improve") {
    improve = { state: "running", detail: `Refining the strategy · round ${improveCount + 1}/${MAX_IMPROVE_ROUNDS}` };
  } else if (phase === "done") {
    improve =
      improveCount > 0
        ? { state: "done", detail: `Refined ${improveCount} round${improveCount > 1 ? "s" : ""}` }
        : { state: "skipped", detail: "Held up first try, no fixes needed" };
  } else {
    improve = { state: "pending" };
  }

  return [draft, backtest, robustness, improve];
}

// Header status line for the live checklist card.
export function deriveChecklistStatus(auto: AutoChecklistDto | null | undefined): string {
  const steps = deriveQuantAgentSteps(auto);
  if (steps.some((s) => s.state === "failed")) return "Stopped";
  if (steps.some((s) => s.state === "waiting")) return "Waiting for your OK";
  if (steps.every((s) => s.state === "done" || s.state === "skipped")) return "Done";
  return "Working through it";
}

const STATE_BOX: Record<StageState, string> = {
  done: "border-emerald-400/40 bg-emerald-400/15 text-emerald-300",
  running: "border-primary/40 bg-primary/15 text-primary",
  waiting: "border-amber-400/40 bg-amber-400/15 text-amber-300",
  failed: "border-rose-400/40 bg-rose-500/15 text-rose-300",
  skipped: "border-white/15 bg-white/5 text-white/40",
  pending: "border-white/10 bg-white/[0.04] text-white/40",
};

/** One stage row. Shared so the live dock and the canned demo render identically. */
export function QuantAgentStepRow({
  stage,
  step,
  testId,
}: {
  stage: QuantStage;
  step: QuantStep;
  testId?: string;
}) {
  const { state } = step;
  const dim = state === "pending" || state === "skipped";
  return (
    <div className="flex items-start gap-2.5" data-testid={testId ?? `quant-step-${stage.id}`}>
      <div
        className={cn(
          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border",
          STATE_BOX[state],
        )}
      >
        {state === "done" ? (
          <Check className="h-3 w-3" />
        ) : state === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : state === "waiting" ? (
          <Clock className="h-3 w-3" />
        ) : state === "failed" ? (
          <AlertTriangle className="h-3 w-3" />
        ) : state === "skipped" ? (
          <Minus className="h-3 w-3" />
        ) : (
          <stage.Icon className="h-3 w-3" />
        )}
      </div>
      <div className="min-w-0 leading-tight">
        <span className={cn("text-[13px] font-semibold", dim ? "text-white/55" : "text-white")}>
          {stage.label}
        </span>
        <span className="text-[12.5px] text-white/45">
          {"  "}
          {step.detail ?? stage.sub}
        </span>
      </div>
    </div>
  );
}

/** The live checklist card rendered in the dock from the polled DTO. */
export default function QuantAgentChecklist({
  auto,
  className,
  collapsed = false,
  onToggleCollapsed,
}: {
  auto: AutoChecklistDto | null | undefined;
  className?: string;
  collapsed?: boolean;
  /** When provided, a chevron lets the user fold the step rows down to this header. */
  onToggleCollapsed?: () => void;
}) {
  const steps = deriveQuantAgentSteps(auto);
  const status = deriveChecklistStatus(auto);
  const done = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  return (
    <div
      data-testid="quant-agent-checklist"
      className={cn(
        "rounded-xl border border-indigo-400/20 bg-indigo-500/[0.06] px-3 py-2.5",
        className,
      )}
    >
      <div className={cn("flex items-center gap-2", collapsed ? "" : "mb-2")}>
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-500 text-white">
          <Wand2 className="h-3 w-3" />
        </span>
        <span className="text-[12.5px] font-semibold text-white">Quant agent</span>
        <span className="text-[11px] text-white/45" data-testid="text-quant-agent-status">
          {status}
        </span>
        <span className="ml-auto text-[11px] tabular-nums text-white/40">
          {done}/{steps.length}
        </span>
        {onToggleCollapsed && (
          <button
            type="button"
            onClick={onToggleCollapsed}
            data-testid="button-quant-agent-collapse"
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Show the steps" : "Hide the steps"}
            className="-mr-1 rounded p-0.5 text-white/40 transition-colors hover:bg-white/10 hover:text-white"
          >
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", collapsed && "-rotate-90")}
            />
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="space-y-2">
          {QUANT_AGENT_STAGES.map((stage, i) => (
            <QuantAgentStepRow key={stage.id} stage={stage} step={steps[i]} />
          ))}
        </div>
      )}
    </div>
  );
}

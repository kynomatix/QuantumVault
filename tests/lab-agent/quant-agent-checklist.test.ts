import { describe, it, expect } from "vitest";
import {
  deriveQuantAgentSteps,
  deriveChecklistStatus,
  type AutoChecklistDto,
} from "@/components/QuantAgentChecklist";

// Build an AutoChecklistDto with sane defaults; override per case.
function auto(partial: Partial<AutoChecklistDto>): AutoChecklistDto {
  return {
    phase: "create",
    improveCount: 0,
    graduated: false,
    pendingConfirm: null,
    activeRun: null,
    ...partial,
  };
}

const [DRAFT, BACKTEST, ROBUST, IMPROVE] = [0, 1, 2, 3];

describe("deriveQuantAgentSteps", () => {
  it("returns four pending steps when there is no auto state", () => {
    const steps = deriveQuantAgentSteps(null);
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.state === "pending")).toBe(true);
  });

  it("drafting: draft running, everything after it pending", () => {
    const steps = deriveQuantAgentSteps(auto({ phase: "create" }));
    expect(steps[DRAFT].state).toBe("running");
    expect(steps[BACKTEST].state).toBe("pending");
    expect(steps[ROBUST].state).toBe("pending");
    expect(steps[IMPROVE].state).toBe("pending");
  });

  it("waits on the paid draft confirm", () => {
    const steps = deriveQuantAgentSteps(
      auto({ phase: "create", pendingConfirm: { tool: "createStrategyFromText", estCostUsd: 0.16 } }),
    );
    expect(steps[DRAFT].state).toBe("waiting");
    expect(steps[DRAFT].detail).toContain("$0.16");
    expect(deriveChecklistStatus(auto({ phase: "create", pendingConfirm: { tool: "createStrategyFromText", estCostUsd: 0.16 } }))).toBe(
      "Waiting for your OK",
    );
  });

  it("keeps Backtest running while a run is queued, even though phase already advanced to evaluate", () => {
    const steps = deriveQuantAgentSteps(
      auto({
        phase: "evaluate",
        activeRun: { status: "queued", stage: null, progressPct: null, jobsAhead: 2 },
      }),
    );
    expect(steps[DRAFT].state).toBe("done");
    expect(steps[BACKTEST].state).toBe("running");
    expect(steps[BACKTEST].detail).toBe("Queued · 2 ahead");
    expect(steps[ROBUST].state).toBe("pending");
  });

  it("shows backtest progress percent while running", () => {
    const steps = deriveQuantAgentSteps(
      auto({
        phase: "evaluate",
        activeRun: { status: "running", stage: "random", progressPct: 42.6, jobsAhead: null },
      }),
    );
    expect(steps[BACKTEST].state).toBe("running");
    expect(steps[BACKTEST].detail).toBe("Running · 43%");
  });

  it("evaluate with no active run means robustness is being scored", () => {
    const steps = deriveQuantAgentSteps(auto({ phase: "evaluate" }));
    expect(steps[BACKTEST].state).toBe("done");
    expect(steps[ROBUST].state).toBe("running");
    expect(steps[ROBUST].detail).toBe("Scoring it on data it never saw");
  });

  it("graduation reads as a second robustness pass on ETH/ARB", () => {
    const steps = deriveQuantAgentSteps(
      auto({
        phase: "evaluate",
        graduated: true,
        activeRun: { status: "running", stage: null, progressPct: null, jobsAhead: null },
      }),
    );
    expect(steps[ROBUST].state).toBe("running");
    expect(steps[ROBUST].detail).toContain("ETH and ARB");
  });

  it("improve loop reports its round", () => {
    const steps = deriveQuantAgentSteps(auto({ phase: "improve", improveCount: 0 }));
    expect(steps[IMPROVE].state).toBe("running");
    expect(steps[IMPROVE].detail).toContain("round 1/3");
  });

  it("waits on the paid improve confirm with the next round number", () => {
    const steps = deriveQuantAgentSteps(
      auto({ phase: "improve", improveCount: 1, pendingConfirm: { tool: "improve", estCostUsd: 0.22 } }),
    );
    expect(steps[IMPROVE].state).toBe("waiting");
    expect(steps[IMPROVE].detail).toContain("round 2/3");
    expect(steps[IMPROVE].detail).toContain("$0.22");
  });

  it("done with no improvement reads as skipped", () => {
    const steps = deriveQuantAgentSteps(auto({ phase: "done", improveCount: 0 }));
    expect(steps[DRAFT].state).toBe("done");
    expect(steps[BACKTEST].state).toBe("done");
    expect(steps[ROBUST].state).toBe("done");
    expect(steps[IMPROVE].state).toBe("skipped");
    expect(deriveChecklistStatus(auto({ phase: "done", improveCount: 0 }))).toBe("Done");
  });

  it("done after refining shows the round count", () => {
    const steps = deriveQuantAgentSteps(auto({ phase: "done", improveCount: 2 }));
    expect(steps[IMPROVE].state).toBe("done");
    expect(steps[IMPROVE].detail).toBe("Refined 2 rounds");
  });

  it("a failed run fails the Backtest row and stops the checklist", () => {
    const failing = auto({
      phase: "evaluate",
      activeRun: { status: "failed", stage: null, progressPct: null, jobsAhead: null },
    });
    const steps = deriveQuantAgentSteps(failing);
    expect(steps[BACKTEST].state).toBe("failed");
    expect(deriveChecklistStatus(failing)).toBe("Stopped");
  });
});

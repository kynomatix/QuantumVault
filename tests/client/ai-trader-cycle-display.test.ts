import { describe, expect, it } from "vitest";
import { cycleDisplay, currentScheduleLabel } from "../../client/src/lib/ai-trader-cycle-display";
import { readFlatReasons } from "@shared/ai-trader-flat-reasons";
import type { LatestCycle } from "@shared/ai-trader-cycle";

describe("latest automatic check display", () => {
  const base: NonNullable<LatestCycle["cycle"]> = { id: "EXAMPLE", startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(),
    outcome: "model_decided", reasonCode: "model_flat", rearmed: false, nextPlannedBoundary: null, completionUnknown: false, flatReasons: null, rationale: "Retained rationale", detailCodes: [] };
  it("distinguishes unavailable, never recorded, active and completion unknown", () => {
    expect(cycleDisplay().outcome).toContain("unavailable");
    expect(cycleDisplay({ status: "available", cycle: null }).outcome).toContain("No automatic cycle");
    expect(cycleDisplay({ status: "available", cycle: { ...base, outcome: "running" } }).outcome).toBe("Check running");
    expect(cycleDisplay({ status: "available", cycle: { ...base, outcome: "running", completionUnknown: true } }).outcome).toContain("completion unknown");
  });
  it("attributes structured reasons to the model and never invents legacy reasons", () => {
    const legacy = cycleDisplay({ status: "available", cycle: base });
    expect(legacy.flatLabels).toEqual(["Model reason not recorded"]); expect(legacy.rationale).toBe("Retained rationale");
    expect(cycleDisplay({ status: "available", cycle: { ...base, flatReasons: ["no_setup", "session_risk"] } }).flatLabels).toEqual(["Model reason: no setup", "Model reason: session risk"]);
    expect(cycleDisplay({ status: "available", cycle: { ...base, reasonCode: "guardrail_rejected", flatReasons: ["no_setup"] } }).flatLabels).toEqual([]);
    expect(readFlatReasons({ action: "long", flatReasonsVersion: 1, flatReasons: ["no_setup"] })).toBeNull();
    expect(readFlatReasons({ action: "flat", flatReasonsVersion: 2, flatReasons: ["no_setup"] })).toBeNull();
  });
  it("separates current scheduling state from a past cycle's scheduling receipt", () => {
    expect(currentScheduleLabel({ status: "paused", mode: "auto", autoNext: true })).toContain("paused");
    expect(currentScheduleLabel({ status: "idle", mode: "suggest", autoNext: true })).toContain("suggestion");
    expect(currentScheduleLabel({ status: "idle", mode: "auto", autoNext: false })).toContain("off");
    expect(cycleDisplay({ status: "available", cycle: base }).schedule).toContain("No next check");
    expect(cycleDisplay({ status: "available", cycle: { ...base, rearmed: true, nextPlannedBoundary: new Date(2).toISOString() } }).schedule).toContain("was scheduled");
  });
});

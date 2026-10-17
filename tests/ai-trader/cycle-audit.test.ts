import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AiTraderBot } from "@shared/schema";
import { assertCycleFinish, outcomeForCycleReason } from "@shared/ai-trader-cycle";

const mocks = vi.hoisted(() => ({ start: vi.fn(), finish: vi.fn(), latest: vi.fn(), decision: vi.fn(), telemetry: vi.fn() }));
vi.mock("../../server/storage", () => ({ storage: {
  startAiTraderCycle: mocks.start, finishAiTraderCycle: mocks.finish,
  getLatestAiTraderCycle: mocks.latest, getAiTraderDecision: mocks.decision,
} }));
vi.mock("../../server/telemetry", () => ({ appendTelemetry: mocks.telemetry }));
const bot = () => ({ id: randomUUID(), mode: "auto", status: "idle", autoNext: true,
  protocol: "pacifica", market: "SOL-PERP", timeframe: "4h", marketSource: "fixed", paperMode: true, model: "EXAMPLE" } as AiTraderBot);
beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.start.mockResolvedValue(undefined); mocks.finish.mockResolvedValue(undefined);
});

describe("closure-owned cycle receipts", () => {
  it("isolates overlapping cycles and counts every provider request and ordered decision", async () => {
    const { CycleAudit, cycleIsActive } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot(); const a = new CycleAudit(sameBot, new Date()); const b = new CycleAudit(sameBot, new Date());
    await a.begin(); await b.begin();
    expect(a.id).not.toBe(b.id); expect(cycleIsActive(a.id)).toBe(true);
    const ids = [randomUUID(), randomUUID()];
    a.candidate(); a.gatewayCall(); a.gatewayCall();
    a.decision({ ok: false, reason: "malformed", decisionId: ids[0] } as any);
    a.candidate(); a.gatewayCall();
    a.decision({ ok: true, decision: { action: "flat" }, decisionId: ids[1] } as any);
    b.set("claim_lost", "boundary_lane"); await b.finish(null); await a.finish(new Date()); await a.finish(null);
    expect(mocks.finish).toHaveBeenCalledTimes(2);
    expect(mocks.finish.mock.calls[1][3]).toMatchObject({ decisionIds: ids, candidateCount: 2, modelCallCount: 3, reasonCode: "model_flat", rearmed: true });
    expect(mocks.finish.mock.calls[0][3]).toMatchObject({ decisionIds: [], candidateCount: 0, modelCallCount: 0, reasonCode: "claim_lost", rearmed: false });
    expect(cycleIsActive(a.id)).toBe(false);
    assertCycleFinish(mocks.finish.mock.calls[1][3]);
  });
  it("retries failed starts and terminal writes, then drains the pending receipt without replaying work", async () => {
    const { CycleAudit, cycleAuditUnavailable } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot(); mocks.start.mockRejectedValue(new Error("EXAMPLE private upstream detail"));
    mocks.telemetry.mockImplementation(() => { throw new Error("telemetry unavailable"); });
    const a = new CycleAudit(sameBot, new Date()); await a.begin(); a.set("paused"); await a.finish(null);
    expect(cycleAuditUnavailable(sameBot.id)).toBe(true); expect(mocks.start).toHaveBeenCalledTimes(4);
    mocks.start.mockResolvedValue(undefined); mocks.telemetry.mockReset();
    const b = new CycleAudit(sameBot, new Date()); await b.begin(); b.set("auto_next_off"); await b.finish(null);
    expect(cycleAuditUnavailable(sameBot.id)).toBe(false);
    expect(mocks.finish.mock.calls.map(call => call[0])).toEqual([a.id, b.id]);
  });
  it("rejects invalid outcome pairs, duplicate links and unbounded details", () => {
    const value = { phase: "model", reasonCode: "model_flat", outcome: outcomeForCycleReason("model_flat"), finishedAt: new Date(),
      rearmed: false, nextPlannedBoundary: null, candidateCount: 1, modelCallCount: 1, decisionIds: [randomUUID()],
      promptVersionHash: null, contextVersionHash: null, details: {} } as const;
    expect(() => assertCycleFinish({ ...value, decisionIds: [...value.decisionIds], outcome: "executed" })).toThrow();
    expect(() => assertCycleFinish({ ...value, decisionIds: [value.decisionIds[0], value.decisionIds[0]] })).toThrow();
    expect(() => assertCycleFinish({ ...value, decisionIds: [], details: { text: "x".repeat(8193) } })).toThrow();
  });
});

describe("authorized latest-cycle projection", () => {
  it("does not infer interruption from age or link unrelated/clamped flat reasons", async () => {
    const { readLatestCycle } = await import("../../server/ai-trader/cycle-display");
    const row = { id: randomUUID(), startedAt: new Date(0), finishedAt: null, outcome: "running", ownerBootId: "EXAMPLE",
      reasonCode: null, rearmed: null, nextPlannedBoundary: null, decisionIds: [], details: {} };
    mocks.latest.mockResolvedValue(row);
    expect((await readLatestCycle("EXAMPLE")).cycle?.completionUnknown).toBe(true);
    mocks.latest.mockResolvedValue({ ...row, outcome: "model_decided", reasonCode: "guardrail_rejected", decisionIds: [randomUUID()] });
    expect((await readLatestCycle("EXAMPLE")).cycle?.flatReasons).toBeNull(); expect(mocks.decision).not.toHaveBeenCalled();
    mocks.latest.mockResolvedValue({ ...row, outcome: "model_decided", reasonCode: "model_flat", decisionIds: [randomUUID()] });
    mocks.decision.mockResolvedValue({ botId: "OTHER", rawDecision: { action: "flat", flatReasonsVersion: 1, flatReasons: ["no_setup"] } });
    expect((await readLatestCycle("EXAMPLE")).cycle?.flatReasons).toBeNull();
  });
  it("reads linked raw flat metadata and compressed rationale only; database errors stay unavailable", async () => {
    const { readLatestCycle } = await import("../../server/ai-trader/cycle-display");
    mocks.latest.mockResolvedValue({ id: randomUUID(), startedAt: new Date(), outcome: "model_decided", reasonCode: "model_flat", decisionIds: [randomUUID()], details: {} });
    mocks.decision.mockResolvedValue({ botId: "EXAMPLE", rawDecision: { action: "flat", flatReasonsVersion: 1, flatReasons: ["structure_conflict", "context_insufficient"], rationaleExcerpt: "EXAMPLE retained rationale" } });
    expect((await readLatestCycle("EXAMPLE")).cycle).toMatchObject({ flatReasons: ["structure_conflict", "context_insufficient"], rationale: "EXAMPLE retained rationale" });
    mocks.latest.mockRejectedValue(new Error("EXAMPLE")); expect(await readLatestCycle("EXAMPLE")).toEqual({ status: "unavailable", cycle: null });
  });
});

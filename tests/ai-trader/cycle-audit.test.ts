import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  it("persists bounded gateway diagnostics without raw detail and projects them for the drawer", async () => {
    const { CycleAudit } = await import("../../server/ai-trader/cycle-audit");
    const { readLatestCycle } = await import("../../server/ai-trader/cycle-display");
    const sameBot = bot(); const audit = new CycleAudit(sameBot, new Date());
    await audit.begin(); audit.gatewayCall(); audit.gatewayCall();
    audit.decision({ ok: false, reason: "gateway", detail: "EXAMPLE private prompt and headers",
      gatewayFailure: { failureClass: "http", httpStatus: 400, providerCode: "invalid_json_schema",
        providerType: "invalid_request_error", elapsedMs: 900, attemptCount: 2, raw: "EXAMPLE private" } });
    await audit.finish(null);
    const receipt = mocks.finish.mock.calls[0][3];
    expect(receipt).toMatchObject({ reasonCode: "gateway_error", modelCallCount: 2,
      details: { gatewayFailure: { failureClass: "http", httpStatus: 400, providerCode: "invalid_json_schema", providerType: "invalid_request_error", elapsedMs: 900, attemptCount: 2 } } });
    expect(JSON.stringify(receipt)).not.toContain("private");
    mocks.latest.mockResolvedValue({ ...receipt, id: audit.id, startedAt: new Date(), decisionIds: [] });
    expect((await readLatestCycle(sameBot.id)).cycle?.gatewayFailure).toEqual(receipt.details.gatewayFailure);
    expect(mocks.decision).not.toHaveBeenCalled();
  });
  it("contains hostile failure metadata without throwing or altering the gateway reason", async () => {
    const { CycleAudit } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot(); const audit = new CycleAudit(sameBot, new Date());
    await audit.begin();
    expect(() => audit.decision({ ok: false, reason: "timeout", gatewayFailure: {
      get failureClass() { throw new Error("EXAMPLE"); },
    } })).not.toThrow();
    await audit.finish(null);
    expect(mocks.finish.mock.calls[0][3]).toMatchObject({ reasonCode: "gateway_timeout" });
  });
  it.each([undefined, null, {}, { ok: true }, { ok: true, decision: { action: "EXAMPLE" } },
    { ok: true, decision: { action: "flat" }, violations: {} },
    { ok: true, get decision() { throw new Error("EXAMPLE"); } },
  ])("records an unexpected decision shape as an audit coverage gap (%#)", async result => {
    const { CycleAudit, cycleAuditUnavailable } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot(); const audit = new CycleAudit(sameBot, new Date());
    await audit.begin();
    expect(() => audit.decision(result)).not.toThrow();
    audit.set("proposal_created");
    await audit.finish(null);
    expect(mocks.finish.mock.calls[0][3]).toMatchObject({ reasonCode: "internal_error", outcome: "failed",
      details: { auditStatus: "unavailable" } });
    expect(cycleAuditUnavailable(sameBot.id)).toBe(true);
  });
  it("contains malformed and unserializable context, execution and reason metadata", async () => {
    const { CycleAudit, cycleAuditUnavailable } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot(); const audit = new CycleAudit(sameBot, new Date());
    const circular: Record<string, unknown> = {}; circular.self = circular;
    await audit.begin();
    expect(() => { audit.context(undefined); audit.context({ system: "EXAMPLE", contextDigest: circular });
      audit.execution({} as any, true); audit.set("EXAMPLE" as any); }).not.toThrow();
    await audit.finish(null);
    expect(cycleAuditUnavailable(sameBot.id)).toBe(true);
    expect(mocks.finish.mock.calls[0][3].reasonCode).toBe("internal_error");
  });
  it("contains a recorder that throws from construction, methods, properties and asynchronous writes", async () => {
    const { CycleAudit, safeCycleAudit, cycleAuditUnavailable } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot();
    const broken = new Proxy({} as any, {
      get: (_target, key) => key === "begin" || key === "finish"
        ? () => Promise.reject(new Error("EXAMPLE")) : () => { throw new Error("EXAMPLE"); },
      set: () => { throw new Error("EXAMPLE"); },
    });
    const audit = safeCycleAudit(sameBot.id, () => broken);
    expect(() => { audit.phase = "model"; audit.set("model_flat"); audit.candidate(); audit.gatewayCall();
      audit.context(null); audit.decision(null); audit.execution(null, true); }).not.toThrow();
    await expect(audit.begin()).resolves.toBeUndefined();
    await expect(audit.finish(null)).resolves.toBeUndefined();
    const missing = safeCycleAudit(sameBot.id, () => { throw new Error("EXAMPLE"); });
    expect(() => { missing.begin(); missing.set("paused"); missing.finish(null); }).not.toThrow();
    const frozen = safeCycleAudit(sameBot.id, () => Object.freeze(new CycleAudit(sameBot, new Date())));
    expect(() => { frozen.phase = "model"; frozen.candidate(); }).not.toThrow();
    expect(cycleAuditUnavailable(sameBot.id)).toBe(true);
  });
  it("orders background start and finish writes without holding the caller on a slow start", async () => {
    const { CycleAudit, safeCycleAudit, cycleIsActive } = await import("../../server/ai-trader/cycle-audit");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    mocks.start.mockReturnValue(gate);
    const sameBot = bot(); const audit = safeCycleAudit(sameBot.id, () => new CycleAudit(sameBot, new Date()));
    const begin = audit.begin(); audit.set("model_flat"); const finish = audit.finish(null);
    expect(cycleIsActive(audit.id)).toBe(false);
    expect(mocks.finish).not.toHaveBeenCalled();
    release(); await begin; await finish;
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.finish).toHaveBeenCalledTimes(1);
  });
  it("buffers a whole cycle while the passive snapshot is unresolved and preserves its receipt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    try {
    const { CycleAudit, deferredCycleAudit } = await import("../../server/ai-trader/cycle-audit");
    let release!: (value: AiTraderBot) => void;
    const snapshot = new Promise<AiTraderBot>(resolve => { release = resolve; });
    let saved!: () => void;
    const savedReceipt = new Promise<void>(resolve => { saved = resolve; });
    mocks.finish.mockImplementation(async () => { saved(); });
    const sameBot = bot(); const audit = deferredCycleAudit(sameBot.id, () => snapshot, new Date());
    audit.set("feed_cache_degraded", "context");
    expect(audit.reason).toBe("feed_cache_degraded"); expect(audit.phase).toBe("context");
    audit.begin(); audit.phase = "model"; audit.candidate(); audit.gatewayCall();
    audit.decision({ ok: true, decision: { action: "flat" } }); audit.finish(null);
    expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-10-17T00:10:00Z"));
    release(sameBot); await savedReceipt;
    expect(mocks.finish.mock.calls[0][3]).toMatchObject({ reasonCode: "model_flat", candidateCount: 1, modelCallCount: 1,
      finishedAt: new Date("2026-10-17T00:00:00Z") });
    } finally { vi.useRealTimers(); }
  });
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

describe("deferred snapshot recovery and safe diagnostics", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-18T00:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("retries only the snapshot once and writes queued observations with original timestamps", async () => {
    const { deferredCycleAudit, cycleAuditUnavailable } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot(); const startedAt = new Date(); const boundary = new Date(startedAt.getTime() - 10_000);
    const read = vi.fn().mockRejectedValueOnce({ code: "ECONNRESET", message: "EXAMPLE private SQL" }).mockResolvedValue(sameBot);
    const audit = deferredCycleAudit(sameBot.id, read, boundary, startedAt);
    audit.begin(); audit.candidate(); audit.gatewayCall(); audit.set("model_flat", "model");
    vi.setSystemTime(new Date(startedAt.getTime() + 100)); audit.finish(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1); expect(mocks.start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1499);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledTimes(1); expect(mocks.finish).toHaveBeenCalledTimes(1);
    expect(mocks.start.mock.calls[0][0]).toMatchObject({ startedAt, plannedBoundary: boundary });
    expect(mocks.finish.mock.calls[0][3]).toMatchObject({ finishedAt: new Date(startedAt.getTime() + 100),
      candidateCount: 1, modelCallCount: 1, reasonCode: "model_flat" });
    expect(cycleAuditUnavailable(sameBot.id)).toBe(false); expect(mocks.telemetry).not.toHaveBeenCalled();
  });

  it("discards only after two read rejections with bounded telemetry and no raw error data", async () => {
    const { deferredCycleAudit, cycleAuditUnavailable } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot();
    const read = vi.fn().mockRejectedValue({ message: "EXAMPLE SQL params URL credentials", stack: "EXAMPLE stack",
      details: { private: "EXAMPLE" }, cause: { code: "55P03", message: "EXAMPLE inner" } });
    const audit = deferredCycleAudit(sameBot.id, read, new Date()); audit.begin(); audit.set("paused"); audit.finish(null);
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(2); expect(mocks.start).not.toHaveBeenCalled(); expect(mocks.finish).not.toHaveBeenCalled();
    expect(cycleAuditUnavailable(sameBot.id)).toBe(true);
    expect(mocks.telemetry.mock.calls).toEqual([[`[AIT-CYCLE] audit_internal_error bot=${sameBot.id.slice(0, 8)} stage=snapshot_read error_class=unknown error_code=55P03 elapsed_ms=1500 attempts=2 coverage=unavailable`]]);
    read.mockResolvedValue(sameBot); audit.candidate(); audit.begin(); audit.finish(null);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read).toHaveBeenCalledTimes(2); expect(mocks.start).not.toHaveBeenCalled();
  });

  it.each([
    ["connection code", { cause: { code: "ECONNRESET" } }, "connection", "connection"],
    ["connection SQLSTATE", { cause: { code: "08006" } }, "connection", "connection"],
    ["connection class", { name: "ConnectionError" }, "connection", "connection"],
    ...["57014", "55P03", "40001", "23514"].map(code => [code, { code: "EXAMPLE", cause: { code } }, "unknown", code]),
    ["unknown", { code: "EXAMPLE", name: "EXAMPLE", message: "EXAMPLE private" }, "unknown", "unknown"],
    ["primitive", "EXAMPLE private", "unknown", "unknown"],
    ["throwing code and name", { get code() { throw new Error("EXAMPLE"); }, get name() { throw new Error("EXAMPLE"); }, cause: { code: "23514" } }, "unknown", "23514"],
    ["throwing cause", { get cause() { throw new Error("EXAMPLE"); } }, "unknown", "unknown"],
    ["unread message", { code: "57014", get message() { throw new Error("EXAMPLE"); }, get stack() { throw new Error("EXAMPLE"); } }, "unknown", "57014"],
  ])("classifies %s through the guarded cause chain", async (_label, error, errorClass, errorCode) => {
    const { deferredCycleAudit } = await import("../../server/ai-trader/cycle-audit");
    deferredCycleAudit(bot().id, vi.fn().mockRejectedValue(error), new Date()).begin();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.telemetry).toHaveBeenCalledTimes(1);
    expect(mocks.telemetry.mock.calls[0][0]).toContain(`error_class=${errorClass} error_code=${errorCode}`);
    expect(mocks.telemetry.mock.calls[0][0]).not.toContain("EXAMPLE");
  });

  it("bounds cyclic, deep and revoked-proxy causes without throwing", async () => {
    const { deferredCycleAudit } = await import("../../server/ai-trader/cycle-audit");
    const cyclic: Record<string, unknown> = {}; cyclic.cause = cyclic;
    let deep: unknown = { code: "23514" };
    for (let depth = 0; depth < 8; depth++) deep = { cause: deep };
    const hostile = Proxy.revocable({}, {}); hostile.revoke();
    for (const error of [cyclic, deep, hostile.proxy]) deferredCycleAudit(bot().id, vi.fn().mockRejectedValue(error), new Date()).begin();
    await vi.advanceTimersByTimeAsync(1500);
    expect(mocks.telemetry).toHaveBeenCalledTimes(3);
    for (const [line] of mocks.telemetry.mock.calls) expect(line).toContain("error_class=unknown error_code=unknown");
  });

  it("does not retry a missing snapshot or construction failure", async () => {
    const { deferredCycleAudit } = await import("../../server/ai-trader/cycle-audit");
    const missing = vi.fn().mockResolvedValue(undefined);
    const broken = vi.fn().mockResolvedValue({ get mode() { throw { cause: { code: "40001" } }; } });
    deferredCycleAudit(bot().id, missing, new Date()).begin();
    deferredCycleAudit(bot().id, broken, new Date()).begin();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(missing).toHaveBeenCalledTimes(1); expect(broken).toHaveBeenCalledTimes(1);
    expect(mocks.telemetry.mock.calls[0][0]).toContain("stage=snapshot_missing error_class=unknown error_code=unknown");
    expect(mocks.telemetry.mock.calls[1][0]).toContain("stage=construct error_class=unknown error_code=40001");
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("keeps the 256-observation bound during backoff and skips recovery after overflow", async () => {
    const { deferredCycleAudit } = await import("../../server/ai-trader/cycle-audit");
    const read = vi.fn().mockRejectedValueOnce({ code: "ECONNRESET" }).mockResolvedValue(bot());
    const audit = deferredCycleAudit(bot().id, read, new Date());
    await vi.advanceTimersByTimeAsync(0);
    for (let count = 0; count < 257; count++) audit.candidate();
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(1); expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.telemetry.mock.calls[0][0]).toContain("audit_receipt_lost");
  });

  it("contains throwing telemetry after retry failure and tags persistence and replay errors", async () => {
    const { CycleAudit, deferredCycleAudit, safeCycleAudit, cycleAuditUnavailable } = await import("../../server/ai-trader/cycle-audit");
    const sameBot = bot(); mocks.telemetry.mockImplementation(() => { throw new Error("EXAMPLE"); });
    const deferred = deferredCycleAudit(sameBot.id, vi.fn().mockRejectedValue({ code: "57014" }), new Date());
    expect(() => { deferred.begin(); deferred.finish(null); }).not.toThrow();
    await vi.advanceTimersByTimeAsync(1500); expect(cycleAuditUnavailable(sameBot.id)).toBe(true);
    mocks.telemetry.mockReset();
    mocks.start.mockRejectedValue({ cause: { code: "23514" } });
    const audit = new CycleAudit(bot(), new Date()); await expect(audit.begin()).resolves.toBeUndefined();
    expect(mocks.telemetry.mock.lastCall?.[0]).toContain("stage=begin_insert error_class=unknown error_code=23514");
    mocks.start.mockResolvedValue(undefined); mocks.finish.mockRejectedValue({ code: "55P03" });
    await expect(audit.finish(null)).resolves.toBeUndefined();
    expect(mocks.telemetry.mock.lastCall?.[0]).toContain("stage=finalize error_class=unknown error_code=55P03");
    expect(mocks.telemetry.mock.lastCall?.[0]).toContain("attempts=2");
    const guarded = safeCycleAudit(bot().id, () => new CycleAudit(bot(), new Date()));
    expect(() => guarded.context({ system: "EXAMPLE", get contextDigest() { throw { code: "40001" }; } })).not.toThrow();
    expect(mocks.telemetry.mock.lastCall?.[0]).toContain("stage=replay error_class=unknown error_code=40001");
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

it.each(['market_cooldown','market_entry_pending'])('persists %s as skipped and projects its detail', async (code) => {
  const {CycleAudit}=await import('../../server/ai-trader/cycle-audit');
  const {readLatestCycle}=await import('../../server/ai-trader/cycle-display');
  const audit=new CycleAudit(bot(),new Date());await audit.begin();
  audit.execution(code,false,'2026-10-23T04:00:00.000Z');await audit.finish(null);
  const receipt=mocks.finish.mock.calls[0][3];
  expect(receipt).toMatchObject({outcome:'skipped',reasonCode:'cooldown',details:{detailCodes:[code]}});
  mocks.latest.mockResolvedValue({...receipt,id:audit.id,startedAt:new Date(),decisionIds:[]});
  expect((await readLatestCycle('EXAMPLE')).cycle?.detailCodes).toEqual([code]);
});

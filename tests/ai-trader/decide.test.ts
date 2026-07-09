// WO-4 acceptance: unit tests for server/ai-trader/decide.ts — the decision cycle.
// The WO-1 gateway is partially mocked (real LlmGatewayError class kept so
// `instanceof` in decide.ts matches), storage and models-catalog pricing are
// mocked, guardrails run for real (they're pure). Covers: happy path, the
// zod↔JSON-schema single-source parity, malformed→corrective-retry→success,
// malformed×2 abort, prose-instead-of-tool-call, timeout/gateway aborts (no row),
// the temperature-400 retry, flat decisions, and guardrail rejection rows.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AiTraderBot } from "@shared/schema";
import type { ProtocolAdapter } from "../../server/protocol/adapter";
import { LlmGatewayError, type LlmMessage } from "../../server/ai-assistant/router";

const callMock = vi.fn();
// Snapshot messages at call time — decide.ts mutates the same array between
// attempts, so asserting on mock.calls[n] directly would see the final state.
const capturedCalls: { messages: LlmMessage[]; opts: Record<string, unknown> }[] = [];

vi.mock("../../server/ai-assistant/router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/ai-assistant/router")>();
  return {
    ...actual,
    callOpenRouterWithUsage: (opts: any) => {
      capturedCalls.push({
        messages: JSON.parse(JSON.stringify(opts.messages)),
        opts: { ...opts, messages: undefined },
      });
      return callMock(opts);
    },
  };
});

const insertMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    insertAiTraderDecision: (...args: unknown[]) => insertMock(...args),
  },
}));

const costMock = vi.fn();
vi.mock("../../server/ai-assistant/models-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../server/ai-assistant/models-catalog")>();
  return {
    ...actual,
    estimateCallCostUsd: (...args: unknown[]) => costMock(...args),
  };
});

// --- Fixtures -----------------------------------------------------------------

const DIGEST = {
  market: "SOL-PERP",
  timeframe: "15m",
  price: 100,
  indicators: { atr14: { value: 0.1, prev: 0.11 } },
  account: { allocatedUsdc: 1000, hasPosition: false, unrealizedPnl: 0 },
  guardrailEcho: { maxLeverage: 5, smartLeverageCap: 5 },
};

function makeBot(overrides: Partial<AiTraderBot> = {}): AiTraderBot {
  return {
    id: "bot-1",
    walletAddress: "WALLET_X",
    protocol: "pacifica",
    market: "SOL-PERP",
    timeframe: "15m",
    mode: "auto",
    model: "moonshotai/kimi-k2.6",
    allocatedUsdc: "1000",
    maxLeverage: 5,
    status: "analyzing",
    ...overrides,
  } as unknown as AiTraderBot;
}

function makeAdapter(): ProtocolAdapter {
  return {
    getMaintenanceMarginWeight: vi.fn().mockReturnValue(0.02),
    quantizeOrderSize: vi.fn((_m: string, s: number) => Math.floor(s * 100) / 100),
  } as unknown as ProtocolAdapter;
}

function makeContext() {
  return { system: "SYSTEM PROMPT", user: "USER PROMPT", contextDigest: { ...DIGEST } };
}

const VALID_LONG_ARGS = {
  action: "long",
  entryType: "market",
  leverage: 2,
  sizePct: 50,
  stopLossPrice: 98,
  takeProfitPrice: 106,
  confidence: 7,
  invalidation: "loses 98 support",
  rationale: "uptrend continuation",
};

function toolResponse(args: unknown, usage = { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 }) {
  return {
    content: "",
    toolCalls: [{ name: "decide", arguments: JSON.stringify(args) }],
    usage,
  };
}

async function importDecide() {
  return await import("../../server/ai-trader/decide");
}

beforeEach(() => {
  callMock.mockReset();
  insertMock.mockReset();
  costMock.mockReset();
  capturedCalls.length = 0;
  insertMock.mockResolvedValue({ id: "dec-1" });
  costMock.mockResolvedValue(0.012345);
});

// --- Schema single-source parity -------------------------------------------------

describe("tradeDecisionSchema ↔ DECISION_JSON_SCHEMA (single source)", () => {
  it("generated JSON schema mirrors the zod shape: object, same properties, correct required set, no $schema marker", async () => {
    const { DECISION_JSON_SCHEMA } = await importDecide();
    expect(DECISION_JSON_SCHEMA.type).toBe("object");
    expect(DECISION_JSON_SCHEMA.$schema).toBeUndefined();
    const props = DECISION_JSON_SCHEMA.properties as Record<string, any>;
    expect(Object.keys(props).sort()).toEqual(
      [
        "action",
        "entryType",
        "leverage",
        "sizePct",
        "stopLossPrice",
        "takeProfitPrice",
        "confidence",
        "invalidation",
        "rationale",
      ].sort()
    );
    // Only the always-required fields are in `required` (trade fields are enforced
    // conditionally by superRefine + guardrails' defensive re-check).
    expect(((DECISION_JSON_SCHEMA.required as string[]) ?? []).sort()).toEqual(
      ["action", "confidence", "invalidation", "rationale"].sort()
    );
    expect(props.action.enum).toEqual(["long", "short", "flat", "close"]);
    expect(props.leverage.minimum).toBe(1);
    expect(props.leverage.maximum).toBe(5);
    expect(props.sizePct.minimum).toBe(10);
    expect(props.sizePct.maximum).toBe(90);
    expect(props.confidence.minimum).toBe(1);
    expect(props.confidence.maximum).toBe(10);
    expect(props.invalidation.maxLength).toBe(200);
    expect(props.rationale.maxLength).toBe(600);
  });

  it("zod fixtures: accepts valid long + minimal flat; rejects missing SL, out-of-range size, bad action", async () => {
    const { tradeDecisionSchema } = await importDecide();
    expect(tradeDecisionSchema.safeParse(VALID_LONG_ARGS).success).toBe(true);
    expect(
      tradeDecisionSchema.safeParse({
        action: "flat",
        confidence: 5,
        invalidation: "n/a",
        rationale: "no edge",
      }).success
    ).toBe(true);

    const { stopLossPrice: _sl, ...missingSl } = VALID_LONG_ARGS;
    const noSl = tradeDecisionSchema.safeParse(missingSl);
    expect(noSl.success).toBe(false);
    if (!noSl.success) {
      expect(JSON.stringify(noSl.error.issues)).toContain("stopLossPrice");
    }

    expect(tradeDecisionSchema.safeParse({ ...VALID_LONG_ARGS, sizePct: 95 }).success).toBe(false);
    expect(tradeDecisionSchema.safeParse({ ...VALID_LONG_ARGS, leverage: 6 }).success).toBe(false);
    expect(tradeDecisionSchema.safeParse({ ...VALID_LONG_ARGS, action: "buy" }).success).toBe(false);
    expect(tradeDecisionSchema.safeParse({ ...VALID_LONG_ARGS, confidence: 0 }).success).toBe(false);
  });
});

// --- runDecision -----------------------------------------------------------------

describe("runDecision — happy path", () => {
  it("forces the decide tool per WO-4 step 1 and records a fully-populated decision row", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "sk-or-test",
      context: makeContext(),
      adapter: makeAdapter(),
    });

    // Gateway call contract (checklist item 1).
    expect(callMock).toHaveBeenCalledTimes(1);
    const opts = capturedCalls[0].opts as any;
    expect(opts.model).toBe("moonshotai/kimi-k2.6");
    expect(opts.temperature).toBe(0.2);
    expect(opts.timeoutMs).toBe(60_000);
    expect(opts.toolChoice).toBe("required");
    expect(opts.requireParameters).toBe(true);
    expect(opts.omitTemperature).toBeUndefined();
    expect(opts.tools).toHaveLength(1);
    expect(opts.tools[0].function.name).toBe("decide");
    expect(opts.tools[0].function.parameters.type).toBe("object");
    expect(capturedCalls[0].messages).toEqual([
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "USER PROMPT" },
    ]);

    // Result shape.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decisionId).toBe("dec-1");
    expect(result.rejected).toBe(false);
    expect(result.violations).toEqual([]);
    expect(result.decision).toEqual(VALID_LONG_ARGS);
    expect(result.clamped).toMatchObject({
      action: "long",
      leverage: 2,
      sizePct: 50,
      marginUsdc: 500,
      notionalUsdc: 1000,
      sizeBase: 10,
      stopLossPrice: 98,
      takeProfitPrice: 106,
    });
    expect(result.usage).toEqual({ promptTokens: 1000, completionTokens: 200, totalTokens: 1200 });
    expect(typeof result.latencyMs).toBe("number");

    // Audit row (WO-4 step 5).
    expect(costMock).toHaveBeenCalledWith("moonshotai/kimi-k2.6", 1000, 200);
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0][0];
    expect(row.botId).toBe("bot-1");
    expect(row.contextDigest).toEqual(DIGEST);
    expect(row.rawDecision).toEqual(VALID_LONG_ARGS);
    expect(row.clampedDecision).toMatchObject({ leverage: 2, sizeBase: 10 });
    expect(row.guardrailViolations).toBeNull();
    expect(row.outcome).toBeNull();
    expect(row.llmCostUsd).toBe("0.012345");
    expect(typeof row.llmLatencyMs).toBe("number");
  });

  it("records unknown spend (null cost) when pricing is unavailable", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));
    costMock.mockResolvedValueOnce(null);

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });
    expect(result.ok).toBe(true);
    expect(insertMock.mock.calls[0][0].llmCostUsd).toBeNull();
  });
});

describe("runDecision — malformed output and the single corrective retry", () => {
  it("feeds the zod error back as a user turn and succeeds on the corrected retry", async () => {
    const { runDecision } = await importDecide();
    const { stopLossPrice: _sl, ...badArgs } = VALID_LONG_ARGS;
    callMock
      .mockResolvedValueOnce(toolResponse(badArgs))
      .mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });

    expect(result.ok).toBe(true);
    expect(callMock).toHaveBeenCalledTimes(2);
    // Second call carries: original 2 turns + assistant(raw output) + corrective user turn.
    const second = capturedCalls[1].messages;
    expect(second).toHaveLength(4);
    expect(second[2].role).toBe("assistant");
    expect(second[2].content).toContain('"action":"long"');
    expect(second[3].role).toBe("user");
    expect(second[3].content).toContain("Your decision failed validation:");
    expect(second[3].content).toContain("stopLossPrice");
    expect(second[3].content).toContain("Call decide again with corrected arguments.");
    // Success row, not an abort row.
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0].outcome).toBeNull();
  });

  it("aborts after the second malformed output with an aborted_malformed audit row and summed usage", async () => {
    const { runDecision } = await importDecide();
    const { stopLossPrice: _sl, ...badArgs } = VALID_LONG_ARGS;
    callMock
      .mockResolvedValueOnce(toolResponse(badArgs))
      .mockResolvedValueOnce(toolResponse({ ...badArgs, leverage: 99 }));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });

    expect(result).toMatchObject({ ok: false, reason: "malformed" });
    expect(callMock).toHaveBeenCalledTimes(2); // exactly ONE corrective retry
    expect(insertMock).toHaveBeenCalledTimes(1);
    const row = insertMock.mock.calls[0][0];
    expect(row.outcome).toBe("aborted_malformed");
    expect(row.clampedDecision).toBeNull();
    expect(row.rawDecision.malformed).toBe(true);
    expect(typeof row.rawDecision.raw).toBe("string");
    expect(row.rawDecision.validationError.length).toBeGreaterThan(0);
    // Spend summed across BOTH calls: 2×1000 prompt, 2×200 completion.
    expect(costMock).toHaveBeenCalledWith("moonshotai/kimi-k2.6", 2000, 400);
  });

  it("treats a prose answer with no tool call as malformed", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValue({ content: "I think we should go long here.", usage: undefined });

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });

    expect(result).toMatchObject({ ok: false, reason: "malformed" });
    expect((result as any).detail).toContain("no `decide` tool call");
    // No usage was ever reported → unknown spend, cost stays null without a pricing call.
    expect(costMock).not.toHaveBeenCalled();
    expect(insertMock.mock.calls[0][0].llmCostUsd).toBeNull();
  });

  it("treats unparseable tool arguments as malformed", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValue({
      content: "",
      toolCalls: [{ name: "decide", arguments: "{not json" }],
      usage: undefined,
    });

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });
    expect(result).toMatchObject({ ok: false, reason: "malformed" });
    expect((result as any).detail).toContain("not valid JSON");
  });
});

describe("runDecision — gateway failures (no decision row)", () => {
  it("maps a 408 to reason 'timeout' and writes NO row", async () => {
    const { runDecision } = await importDecide();
    callMock.mockRejectedValueOnce(new LlmGatewayError("The model took too long to respond. Try again.", 408));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });
    expect(result).toMatchObject({ ok: false, reason: "timeout" });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("maps other gateway errors to reason 'gateway' and writes NO row", async () => {
    const { runDecision } = await importDecide();
    callMock.mockRejectedValueOnce(new LlmGatewayError("Provider error.", 502));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });
    expect(result).toMatchObject({ ok: false, reason: "gateway" });
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("a plain 400 WITHOUT the temperature flag does not retry", async () => {
    const { runDecision } = await importDecide();
    callMock.mockRejectedValueOnce(new LlmGatewayError("Bad request.", 400));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });
    expect(result).toMatchObject({ ok: false, reason: "gateway" });
    expect(callMock).toHaveBeenCalledTimes(1);
  });
});

describe("runDecision — temperature-quirk retry", () => {
  it("retries exactly once without the temperature field when a 400 is flagged temperatureUnsupported", async () => {
    const { runDecision } = await importDecide();
    callMock
      .mockRejectedValueOnce(new LlmGatewayError("Bad request.", 400, { temperatureUnsupported: true }))
      .mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });

    expect(result.ok).toBe(true);
    expect(callMock).toHaveBeenCalledTimes(2);
    expect((capturedCalls[0].opts as any).omitTemperature).toBeUndefined();
    expect((capturedCalls[1].opts as any).omitTemperature).toBe(true);
  });

  it("does not loop: a second temperature-flagged 400 after omission aborts as gateway", async () => {
    const { runDecision } = await importDecide();
    callMock.mockRejectedValue(new LlmGatewayError("Bad request.", 400, { temperatureUnsupported: true }));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });
    expect(result).toMatchObject({ ok: false, reason: "gateway" });
    expect(callMock).toHaveBeenCalledTimes(2); // initial + the single omit retry
  });
});

describe("runDecision — flat and guardrail rejection", () => {
  it("a flat decision records outcome 'flat' with a pass-through clamp", async () => {
    const { runDecision } = await importDecide();
    const flatArgs = { action: "flat", confidence: 4, invalidation: "n/a", rationale: "chop" };
    callMock.mockResolvedValueOnce(toolResponse(flatArgs));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect(result.clamped).toEqual({
      action: "flat",
      confidence: 4,
      invalidation: "n/a",
      rationale: "chop",
    });
    expect(insertMock.mock.calls[0][0].outcome).toBe("flat");
  });

  it("a guardrail violation records outcome 'rejected_guardrails' with the violation list and null clamp", async () => {
    const { runDecision } = await importDecide();
    // SL on the wrong side of a long — fatal price-level violation, never clamped.
    callMock.mockResolvedValueOnce(toolResponse({ ...VALID_LONG_ARGS, stopLossPrice: 102 }));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(true);
    expect(result.clamped).toBeNull();
    expect(result.violations.map((v) => v.code)).toContain("sl_wrong_side");

    const row = insertMock.mock.calls[0][0];
    expect(row.outcome).toBe("rejected_guardrails");
    expect(row.clampedDecision).toBeNull();
    expect(Array.isArray(row.guardrailViolations)).toBe(true);
    expect(row.guardrailViolations.map((v: any) => v.code)).toContain("sl_wrong_side");
    expect(row.rawDecision).toMatchObject({ stopLossPrice: 102 });
  });

  it("WO-9: every guardrail rejection is logged with the RAW decision (observability)", async () => {
    const { runDecision } = await importDecide();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    callMock.mockResolvedValueOnce(toolResponse({ ...VALID_LONG_ARGS, stopLossPrice: 102 }));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(true);

    const line = warnSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes("guardrails REJECTED"));
    expect(line).toBeDefined();
    expect(line).toContain("sl_wrong_side"); // violation codes present
    expect(line).toContain('"stopLossPrice":102'); // full raw decision serialized into the line
    warnSpy.mockRestore();
  });

  it("close without an open position rejects via guardrails (contract violation)", async () => {
    const { runDecision } = await importDecide();
    const closeArgs = { action: "close", confidence: 6, invalidation: "n/a", rationale: "exit" };
    callMock.mockResolvedValueOnce(toolResponse(closeArgs));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(), // digest has hasPosition:false
      adapter: makeAdapter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(true);
    expect(result.violations.map((v) => v.code)).toContain("close_without_position");
    expect(insertMock.mock.calls[0][0].outcome).toBe("rejected_guardrails");
  });
});

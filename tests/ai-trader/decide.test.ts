import { observePacificaConstraints } from "../../server/protocol/market-constraints";
// WO-4 acceptance: unit tests for server/ai-trader/decide.ts — the decision cycle.
// The WO-1 gateway is partially mocked (real LlmGatewayError class kept so
// `instanceof` in decide.ts matches), storage and models-catalog pricing are
// mocked, guardrails run for real (they're pure). Covers: happy path, the
// zod↔JSON-schema single-source parity, malformed→corrective-retry→success,
// malformed×2 abort, prose-instead-of-tool-call, timeout/gateway aborts (no row),
// the temperature-400 retry, flat decisions, and guardrail rejection rows.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AiTraderBot } from "@shared/schema";
import type { ProtocolAdapter } from "../../server/protocol/adapter";
import { LlmGatewayError, type LlmMessage } from "../../server/ai-assistant/router";
import { computeQualificationEraDigest } from "../../server/ai-trader/graduation";

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
const pnlMapMock = vi.fn();
const updateBotMock = vi.fn();
vi.mock("../../server/storage", () => ({
  storage: {
    insertAiTraderDecision: (...args: unknown[]) => insertMock(...args),
    getAiTraderTotalRealizedPnlMap: (...args: unknown[]) => pnlMapMock(...args),
    updateAiTraderBot: (...args: unknown[]) => updateBotMock(...args),
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
  feeRateIdentity: {
    protocol: "pacifica",
    account: "AGENT_ACCOUNT",
    subaccountId: null,
    liquidityRole: "taker",
  },
  feeRateQuote: {
    availability: "available",
    protocol: "pacifica",
    account: "AGENT_ACCOUNT",
    subaccountId: null,
    liquidityRole: "taker",
    baseRate: 0.0012,
    effectiveRate: 0.0014,
    provenance: "pacifica:/account:taker_fee",
    observedAt: Date.now(),
    builder: { status: "included", code: "QuantumVault", rate: 0.0002, provenance: "pacifica:builder_actual" },
  },
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
    marketSource: "fixed",
    mode: "auto",
    riskProfile: "guarded",
    model: "moonshotai/kimi-k2.6",
    sizingMode: "discretionary",
    riskMinPct: "0.50",
    riskMaxPct: "1.50",
    allocatedUsdc: "1000",
    maxLeverage: 5,
    stopPolicy: "static",
    status: "analyzing",
    ...overrides,
  } as unknown as AiTraderBot;
}

function entryMarkets() {
  return [{ internalSymbol: "SOL-PERP", constraintObservation: observePacificaConstraints({
    tick_size: "0.01", lot_size: "0.01", min_order_size: "10",
  }, "SOL-PERP", Date.now()) }];
}

function makeAdapter(overrides: Record<string, unknown> = {}): ProtocolAdapter {
  return {
    getMarkets: vi.fn(async () => entryMarkets()),
    getMaintenanceMarginWeight: vi.fn().mockReturnValue(0.02),
    quantizeOrderSize: vi.fn((_m: string, s: number) => Math.floor(s * 100) / 100),
    getBalances: vi.fn().mockResolvedValue({ freeCollateral: 1000 }),
    ...overrides,
  } as unknown as ProtocolAdapter;
}

function makeContext() {
  return { system: "SYSTEM PROMPT", user: "USER PROMPT", contextDigest: { ...DIGEST } };
}

function makeContextForSubaccount(subaccountId: string | null) {
  const context = makeContext() as any;
  context.contextDigest = structuredClone(context.contextDigest);
  context.contextDigest.feeRateIdentity.subaccountId = subaccountId;
  context.contextDigest.feeRateQuote.subaccountId = subaccountId;
  return context;
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
  pnlMapMock.mockReset();
  updateBotMock.mockReset();
  capturedCalls.length = 0;
  insertMock.mockResolvedValue({ id: "dec-1" });
  updateBotMock.mockImplementation(async (_id: string, updates: Record<string, unknown>) => ({
    ...makeBot(),
    ...updates,
  }));
  costMock.mockResolvedValue(0.012345);
  pnlMapMock.mockResolvedValue(new Map());
});
afterEach(() => vi.unstubAllGlobals());

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
      apiKey: "EXAMPLE",
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
    expect(row.qualificationEraDigest).toMatch(/^[0-9A-F]{64}$/);
    expect(row.llmCostUsd).toBe("0.012345");
    expect(typeof row.llmLatencyMs).toBe("number");
    expect(updateBotMock).toHaveBeenCalledWith("bot-1", expect.objectContaining({
      currentQualificationEraDigest: row.qualificationEraDigest,
      graduationState: "in_trial",
    }));
  });

  it("retains a scanner bot's qualification era when deciding on a different selected market", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));
    const context = makeContext();
    const previousMarketBot = makeBot({
      marketSource: "scanner",
      market: "BTC-PERP",
    });
    const retainedDigest = computeQualificationEraDigest({
      bot: previousMarketBot,
      contextDigest: context.contextDigest,
    });
    const selectedMarketBot = makeBot({
      marketSource: "scanner",
      market: "SOL-PERP",
      currentQualificationEraDigest: retainedDigest,
      trialStartedAt: new Date("2026-08-01T00:00:00.000Z"),
      graduationState: "in_trial",
    } as Partial<AiTraderBot>);

    const result = await runDecision({
      bot: selectedMarketBot,
      apiKey: ["sk", "or", "test"].join("-"),
      context,
      adapter: makeAdapter(),
    });

    expect(result.ok).toBe(true);
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0].qualificationEraDigest).toBe(retainedDigest);
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

  it("admits an entry end-to-end when paper-ledger position truth is explicitly flat", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));
    const context = makeContext() as any;
    context.contextDigest = structuredClone(context.contextDigest);
    context.contextDigest.account = {
      ...context.contextDigest.account,
      positionAuthority: "paper_ledger",
      positionState: "flat",
      positionReason: null,
      hasPosition: false,
    };

    const result = await runDecision({
      bot: makeBot({ paperMode: true } as Partial<AiTraderBot>),
      apiKey: "k",
      context,
      adapter: makeAdapter(),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect(result.clamped).toMatchObject({ action: "long" });
    expect(result.violations).not.toContainEqual(expect.objectContaining({ code: "position_truth_unknown" }));
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
  it.each([400, 404])("retries exactly once without the temperature field when a %s is flagged temperatureUnsupported", async (status) => {
    const { runDecision } = await importDecide();
    callMock
      .mockRejectedValueOnce(new LlmGatewayError("Bad request.", status, { temperatureUnsupported: true }))
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

  it.each([400, 404])("does not loop: a second temperature-flagged %s after omission aborts as gateway", async (status) => {
    const { runDecision } = await importDecide();
    callMock.mockRejectedValue(new LlmGatewayError("Bad request.", status, { temperatureUnsupported: true }));

    const result = await runDecision({
      bot: makeBot(),
      apiKey: "k",
      context: makeContext(),
      adapter: makeAdapter(),
    });
    expect(result).toMatchObject({ ok: false, reason: "gateway", gatewayFailure: { httpStatus: status, attemptCount: 2 } });
    expect(callMock).toHaveBeenCalledTimes(2); // initial + the single omit retry
  });

  it.each([400, 404])("retries an actual HTTP %s once with only temperature removed", async (status) => {
    const actual = await vi.importActual<typeof import("../../server/ai-assistant/router")>("../../server/ai-assistant/router");
    callMock.mockImplementation(actual.callOpenRouterWithUsage);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status, text: async () => JSON.stringify({ error: {
        code: status, message: status === 400 ? "Unsupported temperature" : "No endpoints found that can handle the requested parameters",
      } }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: {
        tool_calls: [{ function: { name: "decide", arguments: JSON.stringify(VALID_LONG_ARGS) } }],
      } }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const { runDecision } = await importDecide();
    const onGatewayCall = vi.fn();
    const result = await runDecision({ bot: makeBot({ model: "anthropic/claude-opus-4.8", paperMode: true }),
      apiKey: "EXAMPLE", context: makeContext(), adapter: makeAdapter(), onGatewayCall });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onGatewayCall).toHaveBeenCalledTimes(2);
    const { temperature, ...withoutTemperature } = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(temperature).toBe(0.2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(withoutTemperature);
    expect(withoutTemperature.provider).toEqual({ require_parameters: true });
  });

  it("reports two attempts after a second actual HTTP 404 without retaining the body", async () => {
    const actual = await vi.importActual<typeof import("../../server/ai-assistant/router")>("../../server/ai-assistant/router");
    callMock.mockImplementation(actual.callOpenRouterWithUsage);
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => JSON.stringify({ error: {
      code: 404, message: "No endpoints found that can handle the requested parameters; EXAMPLE private prompt",
    } }) });
    vi.stubGlobal("fetch", fetchMock);
    const { runDecision } = await importDecide();
    const onGatewayCall = vi.fn();
    const result = await runDecision({ bot: makeBot({ paperMode: true }), apiKey: "EXAMPLE",
      context: makeContext(), adapter: makeAdapter(), onGatewayCall });
    expect(result).toMatchObject({ ok: false, reason: "gateway", gatewayFailure: {
      failureClass: "http", httpStatus: 404, providerCode: "404", attemptCount: 2,
    } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onGatewayCall).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("temperature");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("does not retry an unflagged 404", async () => {
    const { runDecision } = await importDecide();
    callMock.mockRejectedValueOnce(new LlmGatewayError("EXAMPLE", 404));
    expect(await runDecision({ bot: makeBot(), apiKey: "EXAMPLE", context: makeContext(), adapter: makeAdapter() }))
      .toMatchObject({ ok: false, reason: "gateway", gatewayFailure: { httpStatus: 404, attemptCount: 1 } });
    expect(callMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the scanner Qwen HTTP request unchanged and makes only one call on success", async () => {
    const actual = await vi.importActual<typeof import("../../server/ai-assistant/router")>("../../server/ai-assistant/router");
    callMock.mockImplementation(actual.callOpenRouterWithUsage);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ choices: [{ message: {
      tool_calls: [{ function: { name: "decide", arguments: JSON.stringify(VALID_LONG_ARGS) } }],
    } }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const { runDecision, DECISION_JSON_SCHEMA } = await importDecide();
    const context = makeContext();
    expect((await runDecision({ bot: makeBot({ model: "qwen/qwen3.7-max", marketSource: "scanner", paperMode: true }),
      apiKey: "EXAMPLE", context, adapter: makeAdapter() })).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: "qwen/qwen3.7-max",
      messages: [{ role: "system", content: context.system }, { role: "user", content: context.user }],
      max_tokens: 8192, temperature: 0.2, reasoning: { enabled: false }, tools: [{ type: "function", function: {
        name: "decide", description: "Submit your trading decision for this cycle. You MUST call this tool exactly once with your decision.",
        parameters: DECISION_JSON_SCHEMA,
      } }],
      tool_choice: "required", provider: { require_parameters: true } });
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

describe("fee context is non-admission", () => {
  it.each([
    ["missing", (c: any) => { delete c.contextDigest.feeRateQuote; }],
    ["unavailable", (c: any) => { c.contextDigest.feeRateQuote = { availability: "unavailable", reason: "capability_unavailable" }; }],
    ["stale", (c: any) => { c.contextDigest.feeRateQuote.observedAt = Date.now() - 10 * 60_000 - 1; }],
    ["future", (c: any) => { c.contextDigest.feeRateQuote.observedAt = Date.now() + 60_000; }],
    ["malformed", (c: any) => { c.contextDigest.feeRateQuote.effectiveRate = Number.NaN; }],
    ["identity mismatch", (c: any) => { c.contextDigest.feeRateIdentity.subaccountId = "other"; }],
  ])("admits an otherwise-valid long with %s retained fee context", async (_label, mutate) => {
    const { runDecision } = await importDecide();
    const context = makeContext() as any;
    context.contextDigest = structuredClone(context.contextDigest);
    mutate(context);
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));

    const result = await runDecision({ bot: makeBot(), apiKey: "k", context, adapter: makeAdapter() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect(result.clamped?.action).toBe("long");
    expect(result.violations.map((v) => v.code)).not.toContain("fee_rate_unavailable");
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      outcome: null,
      clampedDecision: expect.objectContaining({ action: "long" }),
      qualificationEraDigest: expect.stringMatching(/^[0-9A-F]{64}$/),
    });
  });

  it("keeps flat available when the retained quote is explicitly unavailable", async () => {
    const { runDecision } = await importDecide();
    const context = makeContext() as any;
    context.contextDigest = structuredClone(context.contextDigest);
    context.contextDigest.feeRateQuote = { availability: "unavailable", reason: "builder_rate_unknown" };
    callMock.mockResolvedValueOnce(toolResponse({
      action: "flat",
      confidence: 4,
      invalidation: "n/a",
      rationale: "no edge",
    }));

    const result = await runDecision({ bot: makeBot(), apiKey: "k", context, adapter: makeAdapter() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect(result.clamped?.action).toBe("flat");
    expect(insertMock.mock.calls[0][0].outcome).toBe("flat");
  });

  it("does not let an available fee create a G4 or after-fee G3 admission veto", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse({
      ...VALID_LONG_ARGS,
      stopLossPrice: 99.5,
      takeProfitPrice: 101,
    }));

    const result = await runDecision({ bot: makeBot(), apiKey: "k", context: makeContext(), adapter: makeAdapter() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect(result.violations.map((v) => v.code)).not.toContain("tp_below_fee_floor");
    expect(result.violations.map((v) => v.code)).not.toContain("rr_below_floor");
  });
});

// --- risk-based-sizing-spec Phase A: equity-read wiring ------------------------------

describe("risk_based sizing — decide.ts equity wiring", () => {
  const RISK_BOT = {
    sizingMode: "risk_based",
    riskMinPct: "0.50",
    riskMaxPct: "1.50",
  } as const;

  it("paper bot: equity = allocation + lifetime realized PnL; drawdown shrinks the base", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));
    pnlMapMock.mockResolvedValue(new Map([["bot-1", -300]])); // equity 700

    const adapter = makeAdapter();
    const result = await runDecision({
      bot: makeBot({ ...RISK_BOT, paperMode: true } as any),
      apiKey: "k",
      context: makeContext(),
      adapter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect(pnlMapMock).toHaveBeenCalledWith(["bot-1"]);
    expect((adapter.getBalances as any)).not.toHaveBeenCalled(); // paper never touches the venue
    expect(result.clamped).toMatchObject({ sizingMode: "risk_based", leverage: 1 });
    // base = min(1000, 700) × 0.95 = 665
    expect(result.clamped!.base).toBeCloseTo(665, 8);
    expect(result.clamped!.sizePct).toBeUndefined();
    // Audit row carries the stamps too.
    expect(insertMock.mock.calls[0][0].clampedDecision).toMatchObject({ sizingMode: "risk_based" });
  });

  it("live bot: equity = adapter free collateral for the bot's OWN subaccount", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));

    const adapter = makeAdapter({ getBalances: vi.fn().mockResolvedValue({ freeCollateral: 800 }) });
    const result = await runDecision({
      bot: makeBot({ ...RISK_BOT, paperMode: false, protocolSubaccountId: "sub-9" } as any),
      apiKey: "k",
      context: makeContextForSubaccount("sub-9"),
      adapter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect((adapter.getBalances as any)).toHaveBeenCalledWith("sub-9", undefined);
    expect(pnlMapMock).not.toHaveBeenCalled();
    expect(result.clamped!.base).toBeCloseTo(800 * 0.95, 8); // min(1000, 800) × 0.95
  });

  it("live bot: a THROWING equity read fails closed to rejected_guardrails (risk_equity_unavailable)", async () => {
    const { runDecision } = await importDecide();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));

    const adapter = makeAdapter({ getBalances: vi.fn().mockRejectedValue(new Error("venue down")) });
    const result = await runDecision({
      bot: makeBot({ ...RISK_BOT, paperMode: false, protocolSubaccountId: "sub-9" } as any),
      apiKey: "k",
      context: makeContextForSubaccount("sub-9"),
      adapter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(true);
    expect(result.clamped).toBeNull();
    expect(result.violations.map((v) => v.code)).toContain("risk_equity_unavailable");
    expect(insertMock.mock.calls[0][0].outcome).toBe("rejected_guardrails");
    warnSpy.mockRestore();
  });

  it("live bot without a provisioned subaccount fails closed the same way", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));

    const adapter = makeAdapter();
    const result = await runDecision({
      bot: makeBot({ ...RISK_BOT, paperMode: false, protocolSubaccountId: null } as any),
      apiKey: "k",
      context: makeContext(),
      adapter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(true);
    expect(result.violations.map((v) => v.code)).toContain("risk_equity_unavailable");
    expect((adapter.getBalances as any)).not.toHaveBeenCalled();
  });

  it("discretionary bot: never reads equity and stamps no risk fields (regression)", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));

    const adapter = makeAdapter();
    const result = await runDecision({
      bot: makeBot({ paperMode: true } as any), // sizingMode absent → discretionary
      apiKey: "k",
      context: makeContext(),
      adapter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect(pnlMapMock).not.toHaveBeenCalled();
    expect((adapter.getBalances as any)).not.toHaveBeenCalled();
    expect(result.clamped).toMatchObject({ sizePct: 50, marginUsdc: 500 });
    expect(result.clamped!.sizingMode).toBeUndefined();
    expect(result.clamped!.riskPct).toBeUndefined();
  });

  it("risk_based bot deciding FLAT never reads equity (no wasted venue call)", async () => {
    const { runDecision } = await importDecide();
    const flatArgs = { action: "flat", confidence: 4, invalidation: "n/a", rationale: "chop" };
    callMock.mockResolvedValueOnce(toolResponse(flatArgs));

    const adapter = makeAdapter();
    const result = await runDecision({
      bot: makeBot({ ...RISK_BOT, paperMode: false, protocolSubaccountId: "sub-9" } as any),
      apiKey: "k",
      context: makeContext(),
      adapter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rejected).toBe(false);
    expect((adapter.getBalances as any)).not.toHaveBeenCalled();
    expect(pnlMapMock).not.toHaveBeenCalled();
  });
});


describe("H.53 constraint admission audit", () => {
  it.each([false, true])("records stale constraints without losing cost or throwing (paper=%s)", async (paperMode) => {
    const { ConstraintAdmissionError } = await import("../../server/protocol/market-constraints");
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));
    const adapter = makeAdapter({ quantizeOrderSize: vi.fn(() => {
      throw new ConstraintAdmissionError({ ok: false, code: "constraint_expired", reason: "stale observation; no replacement" });
    }) });
    const result = await runDecision({ bot: makeBot({ protocol: "pacifica", paperMode }),
      apiKey: "EXAMPLE", context: makeContext(), adapter });
    expect(result).toMatchObject({ ok: true, rejected: true,
      violations: [expect.objectContaining({ code: "constraint_unavailable", fatal: true })] });
    expect(adapter.getMarkets).toHaveBeenCalledOnce();
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "rejected_guardrails",
      llmCostUsd: expect.stringMatching(/0\.012345/), clampedDecision: null,
      guardrailViolations: [expect.objectContaining({ code: "constraint_unavailable" })] }));
  });
  it("audits a failed market refresh before any sizing callback", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));
    const adapter = makeAdapter({ getMarkets: vi.fn().mockRejectedValue(new Error("offline")) });
    await expect(runDecision({ bot: makeBot({ protocol: "pacifica" }), apiKey: "EXAMPLE",
      context: makeContext(), adapter })).resolves.toMatchObject({ ok: true, rejected: true });
    expect(adapter.quantizeOrderSize).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "rejected_guardrails" }));
  });
  it("awaits refreshed constraints before invoking guardrail sizing", async () => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));
    let refreshed = false;
    const adapter = makeAdapter({ getMarkets: vi.fn(async () => { await Promise.resolve(); refreshed = true; return entryMarkets(); }),
      quantizeOrderSize: vi.fn((_market: string, size: number) => { expect(refreshed).toBe(true); return size; }) });
    await expect(runDecision({ bot: makeBot({ protocol: "pacifica" }), apiKey: "EXAMPLE",
      context: makeContext(), adapter })).resolves.toMatchObject({ ok: true, rejected: false });
    expect(adapter.quantizeOrderSize).toHaveBeenCalled();
  });
});


// Successful refreshes may remove a previously initialized market.
describe("r2j absent market audit", () => {
  it.each([false, true])("audits a successful refresh without the target market (paper=%s)", async (paperMode) => {
    const { runDecision } = await importDecide();
    callMock.mockResolvedValueOnce(toolResponse(VALID_LONG_ARGS));
    const adapter = makeAdapter({
      getMarkets: vi.fn().mockResolvedValue([{ internalSymbol: "BTC-PERP" }]),
      getMaintenanceMarginWeight: vi.fn(() => { throw new Error("Market SOL-PERP not found"); }),
      quantizeOrderSize: vi.fn(() => { throw new Error("Market SOL-PERP not found"); }),
    });
    await expect(runDecision({ bot: makeBot({ protocol: "pacifica", paperMode }), apiKey: "EXAMPLE",
      context: makeContext(), adapter })).resolves.toMatchObject({ ok: true, rejected: true,
      violations: [expect.objectContaining({ code: "constraint_unavailable", fatal: true })] });
    expect(adapter.getMarkets).toHaveBeenCalledOnce();
    expect(adapter.getMaintenanceMarginWeight).not.toHaveBeenCalled();
    expect(adapter.quantizeOrderSize).not.toHaveBeenCalled();
    expect(insertMock).toHaveBeenCalledOnce();
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "rejected_guardrails",
      llmCostUsd: expect.stringMatching(/0\.012345/), clampedDecision: null,
      rawDecision: expect.objectContaining({ action: "long" }),
      guardrailViolations: [expect.objectContaining({ code: "constraint_unavailable" })] }));
  });
});

describe("fixed-paper decision-v2 flat explanations", () => {
  const flat = { action: "flat", confidence: 5, invalidation: "n/a", rationale: "No confirmed setup", flatReasonsVersion: 1, flatReasons: ["structure_conflict", "context_insufficient"] };
  it("enforces version, unique bounds and conditional requirements in Zod", async () => {
    const { paperTradeDecisionSchema, PAPER_DECISION_JSON_SCHEMA } = await importDecide();
    expect(paperTradeDecisionSchema.parse(flat).flatReasons).toEqual(flat.flatReasons);
    for (const reasons of [[], ["UNKNOWN"], ["no_setup", "no_setup"], ["no_setup", "thin_liquidity", "other", "session_risk"]])
      expect(paperTradeDecisionSchema.safeParse({ ...flat, flatReasons: reasons }).success).toBe(false);
    expect(paperTradeDecisionSchema.safeParse({ ...flat, flatReasonsVersion: 2 }).success).toBe(false);
    expect(paperTradeDecisionSchema.safeParse({ ...flat, flatReasons: undefined }).success).toBe(false);
    expect(paperTradeDecisionSchema.safeParse({ ...flat, flatReasons: ["other"], rationale: " " }).success).toBe(false);
    expect(paperTradeDecisionSchema.safeParse({ ...VALID_LONG_ARGS, flatReasons: ["no_setup"] }).success).toBe(false);
    expect(PAPER_DECISION_JSON_SCHEMA).toMatchObject({ type: "object", additionalProperties: false });
  });
  it.each([400, 404])("counts a %s temperature retry plus one correction and retains raw reasons", async (status) => {
    const { runDecision } = await importDecide(); const onGatewayCall = vi.fn();
    callMock.mockRejectedValueOnce(new LlmGatewayError("EXAMPLE", status, { temperatureUnsupported: true }))
      .mockResolvedValueOnce(toolResponse({ ...flat, flatReasons: undefined })).mockResolvedValueOnce(toolResponse(flat));
    const result = await runDecision({ bot: makeBot({ paperMode: true, marketSource: "fixed" }), apiKey: "EXAMPLE", context: makeContext(), adapter: makeAdapter(), onGatewayCall });
    expect(result.ok).toBe(true); expect(onGatewayCall).toHaveBeenCalledTimes(3);
    expect(capturedCalls.slice(1).every((call) => call.opts.omitTemperature === true)).toBe(true);
    expect(insertMock.mock.calls[0][0].rawDecision.flatReasons).toEqual(flat.flatReasons);
  });
  it("caps correction at two attempts and returns the malformed decision identity", async () => {
    const { runDecision } = await importDecide(); const onGatewayCall = vi.fn();
    callMock.mockResolvedValue(toolResponse({ ...flat, flatReasons: undefined }));
    const result = await runDecision({ bot: makeBot({ paperMode: true, marketSource: "fixed" }), apiKey: "EXAMPLE", context: makeContext(), adapter: makeAdapter(), onGatewayCall });
    expect(result).toMatchObject({ ok: false, reason: "malformed", decisionId: "dec-1" });
    expect(onGatewayCall).toHaveBeenCalledTimes(2); expect(insertMock).toHaveBeenCalledTimes(1);
  });
  it.each([{ paperMode: false, marketSource: "fixed" }, { paperMode: true, marketSource: "scanner" }])("keeps legacy tool calls for %j", async (scope) => {
    const { runDecision, DECISION_JSON_SCHEMA } = await importDecide();
    const { flatReasons, flatReasonsVersion, ...legacy } = flat; callMock.mockResolvedValueOnce(toolResponse(legacy));
    expect((await runDecision({ bot: makeBot(scope as any), apiKey: "EXAMPLE", context: makeContext(), adapter: makeAdapter() })).ok).toBe(true);
    expect((capturedCalls[0].opts.tools as any[])[0].function.parameters).toEqual(DECISION_JSON_SCHEMA);
    expect(callMock).toHaveBeenCalledTimes(1);
  });
  it.each(["qwen/qwen3.7-max", "anthropic/claude-opus-4.8"])("sends a compatible exact HTTP request for fixed PAPER with %s", async model => {
    const actual = await vi.importActual<typeof import("../../server/ai-assistant/router")>("../../server/ai-assistant/router");
    callMock.mockImplementation(actual.callOpenRouterWithUsage);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      choices: [{ message: { tool_calls: [{ function: { name: "decide", arguments: JSON.stringify(flat) } }] } }],
    }) });
    vi.stubGlobal("fetch", fetchMock);
    const { runDecision, DECISION_JSON_SCHEMA } = await importDecide();
    const context = makeContext();
    const result = await runDecision({ bot: makeBot({ model, paperMode: true }), apiKey: "EXAMPLE", context, adapter: makeAdapter() });
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const schema = body.tools[0].function.parameters;
    expect(body).toEqual({ model, messages: [{ role: "system", content: context.system }, { role: "user", content: context.user }],
      max_tokens: 8192, temperature: 0.2, reasoning: { enabled: false }, tools: body.tools,
      tool_choice: "required", provider: { require_parameters: true } });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].function).not.toHaveProperty("strict");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(DECISION_JSON_SCHEMA.required);
    const { flatReasons, flatReasonsVersion, ...legacyProperties } = schema.properties;
    expect(legacyProperties).toEqual(DECISION_JSON_SCHEMA.properties);
    expect(flatReasonsVersion).toEqual({ type: "integer", enum: [1] });
    expect(flatReasons).toMatchObject({ type: "array", items: { type: "string" } });
    // Optional fields use the working legacy non-strict dialect. No unions,
    // array cardinality/uniqueness keywords, constants or extra object levels.
    const visit = (node: any, depth = 0) => {
      expect(depth).toBeLessThanOrEqual(4);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        expect(["oneOf", "anyOf", "allOf", "minItems", "maxItems", "uniqueItems", "pattern", "$ref", "const", "strict"]).not.toContain(key);
        if (value && typeof value === "object" && !Array.isArray(value)) visit(value, depth + 1);
      }
    };
    visit(schema);
    expect(JSON.stringify(schema).length).toBeLessThan(4000);
    expect(insertMock.mock.calls[0][0].rawDecision.flatReasons).toEqual(flat.flatReasons);
  });
  it("retains safe metadata and counts every temperature/correction attempt on failure", async () => {
    const { runDecision } = await importDecide();
    callMock.mockRejectedValueOnce(new LlmGatewayError("EXAMPLE", 400, { temperatureUnsupported: true }))
      .mockResolvedValueOnce(toolResponse({ ...flat, flatReasons: undefined }))
      .mockRejectedValueOnce(new LlmGatewayError("EXAMPLE", 503));
    const onGatewayCall = vi.fn(() => { throw new Error("EXAMPLE audit failure"); });
    const result = await runDecision({ bot: makeBot({ paperMode: true }), apiKey: "EXAMPLE", context: makeContext(), adapter: makeAdapter(), onGatewayCall });
    expect(result).toMatchObject({ ok: false, reason: "gateway", gatewayFailure: {
      failureClass: "http", httpStatus: 503, attemptCount: 3, elapsedMs: expect.any(Number),
    } });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

// Regression: consecutive observations are not material strategy changes.
describe("qualification era observation stability", () => {
  it.each(["scanner", "fixed"])("%s: retains the trial and per-decision provenance across feed A/B/A and missing parent", async (marketSource) => {
    const { runDecision } = await importDecide();
    const trialStartedAt = new Date("2026-10-01T00:00:00Z");
    const bot = makeBot({ marketSource, paperMode: true, trialStartedAt, graduationState: "in_trial" });
    const candle = (source: string) => ({ source, venue: source, basis: "perp", proxy: "direct", finality: "finalized", timeSemantic: "open_time" });
    const contexts = [
      { selected: candle("gate"), parent: null },
      { selected: candle("gate"), parent: candle("okx") },
      { selected: candle("gate"), parent: null },
      { selected: candle("okx"), parent: candle("okx") },
      { selected: candle("gate"), parent: candle("okx") },
      { selected: candle("okx"), parent: candle("gate") },
      { selected: candle("okx"), parent: null },
      { selected: candle("okx"), parent: candle("okx") },
    ];
    bot.currentQualificationEraDigest = computeQualificationEraDigest({ bot, contextDigest: { candleProvenance: contexts[0] } });
    callMock.mockResolvedValue(toolResponse({ action: "flat", confidence: 5, rationale: "No setup", invalidation: "None", flatReasonsVersion: 1, flatReasons: ["no_setup"] }));
    for (const [index, candleProvenance] of contexts.entries()) {
      const context = { ...makeContext(), contextDigest: { ...DIGEST, price: 100 + index, candleProvenance } };
      const result = await runDecision({ bot, apiKey: "EXAMPLE", context, adapter: makeAdapter() });
      expect(result.ok).toBe(true);
      expect(insertMock.mock.calls[index][0]).toMatchObject({
        qualificationEraDigest: bot.currentQualificationEraDigest,
        contextDigest: { candleProvenance },
      });
    }
    expect(updateBotMock).not.toHaveBeenCalled();
    expect(bot.trialStartedAt).toBe(trialStartedAt);
  });
});


it("runtime model overrides preserve the saved-model era and retain actual model/cost attribution", async () => {
  const { runDecision } = await importDecide();
  const trialStartedAt = new Date("2026-10-01T00:00:00Z");
  const bot = makeBot({ paperMode: true, marketSource: "fixed", trialStartedAt, graduationState: "in_trial" });
  bot.currentQualificationEraDigest = computeQualificationEraDigest({ bot });
  callMock.mockResolvedValue(toolResponse({ action: "flat", confidence: 5, rationale: "No setup", invalidation: "None", flatReasonsVersion: 1, flatReasons: ["no_setup"] }));
  for (const [index, modelOverride] of [undefined, "deepseek/deepseek-v4-flash", undefined].entries()) {
    const modelUsed = modelOverride ?? bot.model;
    const result = await runDecision({ bot, modelOverride, apiKey: "EXAMPLE", context: makeContext(), adapter: makeAdapter() });
    expect(result.ok).toBe(true);
    expect(capturedCalls[index].opts.model).toBe(modelUsed);
    expect(costMock.mock.calls[index][0]).toBe(modelUsed);
    expect(insertMock.mock.calls[index][0]).toMatchObject({ modelUsed, qualificationEraDigest: bot.currentQualificationEraDigest });
  }
  expect(updateBotMock).not.toHaveBeenCalled();
  expect(bot.trialStartedAt).toBe(trialStartedAt);
});

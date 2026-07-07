// WO-3: decideTurnAction — 3-path structured-decision routing.
// Tests the Path A (tools), Path B (json_schema), Path C (prose) branching and
// the 404-to-C fallback. Router and models-catalog are mocked so no network calls occur.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Module mocks must be declared before dynamic imports that use them.
vi.mock("../../server/ai-assistant/models-catalog", () => ({
  getModelCapabilities: vi.fn(),
}));
vi.mock("../../server/ai-assistant/router", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    callOpenRouterWithUsage: vi.fn(),
  };
});

import { decideTurnAction, MalformedDecisionError } from "../../server/lab-agent/chat-brain";
import { getModelCapabilities } from "../../server/ai-assistant/models-catalog";
import { callOpenRouterWithUsage, LlmGatewayError } from "../../server/ai-assistant/router";

const mockCaps = vi.mocked(getModelCapabilities);
const mockRouter = vi.mocked(callOpenRouterWithUsage);

// Reset call counts and queued return values between tests.
beforeEach(() => vi.clearAllMocks());

const BASE_INPUT = {
  goal: null,
  recentMessages: [{ role: "user" as const, content: "backtest my SOL strategy" }],
  memoryDigest: undefined,
  apiKey: "sk-or-test",
  model: "deepseek/deepseek-v4-pro",
};

const FINAL_DECISION_JSON = '{"action":"final","message":"Here is your result."}';
const FINAL_TOOL_CALL = {
  name: "decide",
  arguments: FINAL_DECISION_JSON,
};

function okUsage() {
  return { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
}

describe("decideTurnAction — Path A (native tool calling)", () => {
  it("uses tools + toolChoice when caps.tools is true, parses tool_calls[0].arguments", async () => {
    mockCaps.mockResolvedValue({ tools: true, responseFormat: true, structuredOutputs: true, live: true });
    mockRouter.mockResolvedValue({ content: "", toolCalls: [FINAL_TOOL_CALL], usage: okUsage() });

    const result = await decideTurnAction(BASE_INPUT);

    expect(result.decision.action).toBe("final");
    expect(result.decisionPath).toBe("tools");

    const call = mockRouter.mock.calls[0][0];
    expect(call.tools).toBeDefined();
    expect(call.toolChoice).toBeDefined();
    expect(call.requireParameters).toBe(true);
  });

  it("falls back to content parsing when tool_calls is absent (provider answered in content)", async () => {
    mockCaps.mockResolvedValue({ tools: true, responseFormat: false, structuredOutputs: false, live: true });
    mockRouter.mockResolvedValue({ content: FINAL_DECISION_JSON, toolCalls: undefined, usage: okUsage() });

    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decision.action).toBe("final");
    expect(result.decisionPath).toBe("prose");
  });

  it("falls through to Path C when Path A returns 404", async () => {
    mockCaps.mockResolvedValue({ tools: true, responseFormat: false, structuredOutputs: false, live: true });
    // First call (Path A): 404
    // Second call (Path C): success
    mockRouter
      .mockRejectedValueOnce(new LlmGatewayError("no provider", 404))
      .mockResolvedValueOnce({ content: FINAL_DECISION_JSON, usage: okUsage() });

    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decision.action).toBe("final");
    expect(result.decisionPath).toBe("prose");
    expect(mockRouter).toHaveBeenCalledTimes(2);
  });

  it("propagates non-404 gateway errors from Path A without retrying", async () => {
    mockCaps.mockResolvedValue({ tools: true, responseFormat: false, structuredOutputs: false, live: true });
    mockRouter.mockRejectedValue(new LlmGatewayError("rate limit", 429));

    await expect(decideTurnAction(BASE_INPUT)).rejects.toBeInstanceOf(LlmGatewayError);
    expect(mockRouter).toHaveBeenCalledTimes(1);
  });
});

describe("decideTurnAction — Path B (response_format json_schema)", () => {
  it("uses responseFormat when caps.structuredOutputs is true and caps.tools is false", async () => {
    mockCaps.mockResolvedValue({ tools: false, responseFormat: true, structuredOutputs: true, live: true });
    mockRouter.mockResolvedValue({ content: FINAL_DECISION_JSON, usage: okUsage() });

    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decision.action).toBe("final");
    expect(result.decisionPath).toBe("json_schema");

    const call = mockRouter.mock.calls[0][0];
    expect(call.responseFormat).toBeDefined();
    expect(call.requireParameters).toBe(true);
    expect(call.tools).toBeUndefined();
  });

  it("falls through to Path C when Path B returns 404", async () => {
    mockCaps.mockResolvedValue({ tools: false, responseFormat: true, structuredOutputs: true, live: true });
    mockRouter
      .mockRejectedValueOnce(new LlmGatewayError("no provider", 404))
      .mockResolvedValueOnce({ content: FINAL_DECISION_JSON, usage: okUsage() });

    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decision.action).toBe("final");
    expect(result.decisionPath).toBe("prose");
    expect(mockRouter).toHaveBeenCalledTimes(2);
  });
});

describe("decideTurnAction — Path C (prose fallback)", () => {
  it("uses prose path when caps.tools and caps.structuredOutputs are both false", async () => {
    mockCaps.mockResolvedValue({ tools: false, responseFormat: false, structuredOutputs: false, live: true });
    mockRouter.mockResolvedValue({ content: FINAL_DECISION_JSON, usage: okUsage() });

    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decision.action).toBe("final");
    expect(result.decisionPath).toBe("prose");

    const call = mockRouter.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    expect(call.responseFormat).toBeUndefined();
    expect(call.requireParameters).toBeUndefined();
  });

  it("uses prose path when caps.live is false (fetch failed, all-false capabilities)", async () => {
    mockCaps.mockResolvedValue({ tools: false, responseFormat: false, structuredOutputs: false, live: false });
    mockRouter.mockResolvedValue({ content: FINAL_DECISION_JSON, usage: okUsage() });

    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decisionPath).toBe("prose");
    expect(mockRouter).toHaveBeenCalledTimes(1);
  });
});

describe("decideTurnAction — MalformedDecisionError salvage across paths", () => {
  it("salvages clean prose from Path A toolCalls when parseBrainDecision fails", async () => {
    mockCaps.mockResolvedValue({ tools: true, responseFormat: false, structuredOutputs: false, live: true });
    // tool_calls carries valid prose, not JSON — parseBrainDecision will throw MalformedDecisionError
    const cleanProse =
      "Your SOL strategy is up 312.4% net with a 0.81 Sharpe. It has a strong out-of-sample result.";
    const badArgs = cleanProse; // not valid JSON, but coerceProseToFinal should salvage it
    // Provide recentMessages with a tool result this turn so coerceProseToFinal's gate passes
    const inputWithTool = {
      ...BASE_INPUT,
      recentMessages: [
        { role: "user" as const, content: "show me my best result" },
        { role: "tool" as const, content: "getTopResults result: {}" },
      ],
    };
    mockRouter.mockResolvedValue({
      content: "",
      toolCalls: [{ name: "decide", arguments: badArgs }],
      usage: okUsage(),
    });

    const result = await decideTurnAction(inputWithTool);
    expect(result.decision.action).toBe("final");
    expect((result.decision as any).message).toBe(cleanProse);
    expect(result.decisionPath).toBe("prose");
  });

  it("re-throws MalformedDecisionError from Path C when salvage fails", async () => {
    mockCaps.mockResolvedValue({ tools: false, responseFormat: false, structuredOutputs: false, live: false });
    mockRouter.mockResolvedValue({ content: "broken json {", usage: okUsage() });

    await expect(decideTurnAction(BASE_INPUT)).rejects.toBeInstanceOf(MalformedDecisionError);
  });
});

describe("decideTurnAction — decisionPath surfaced in result", () => {
  it("sets decisionPath:'tools' when Path A tool_calls was used", async () => {
    mockCaps.mockResolvedValue({ tools: true, responseFormat: false, structuredOutputs: false, live: true });
    mockRouter.mockResolvedValue({ content: "", toolCalls: [FINAL_TOOL_CALL], usage: okUsage() });
    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decisionPath).toBe("tools");
  });

  it("sets decisionPath:'json_schema' when Path B was used", async () => {
    mockCaps.mockResolvedValue({ tools: false, responseFormat: false, structuredOutputs: true, live: true });
    mockRouter.mockResolvedValue({ content: FINAL_DECISION_JSON, usage: okUsage() });
    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decisionPath).toBe("json_schema");
  });

  it("sets decisionPath:'prose' when Path C was used", async () => {
    mockCaps.mockResolvedValue({ tools: false, responseFormat: false, structuredOutputs: false, live: false });
    mockRouter.mockResolvedValue({ content: FINAL_DECISION_JSON, usage: okUsage() });
    const result = await decideTurnAction(BASE_INPUT);
    expect(result.decisionPath).toBe("prose");
  });
});

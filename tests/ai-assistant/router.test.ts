// WO-2: callOpenRouterWithUsage — structured-output request extensions and
// tool_calls response parsing. Tests verify:
//   - new fields (tools, tool_choice, response_format, provider) appear in the
//     request body only when the caller sets them
//   - a tool_calls response is extracted into result.toolCalls
//   - empty content + tool_calls does NOT throw (WO-2's key invariant)
//   - existing callers (no new opts) produce byte-identical request bodies

import { describe, it, expect, beforeEach, vi } from "vitest";
import { callOpenRouterWithUsage, LlmGatewayError } from "../../server/ai-assistant/router";

const TEST_KEY = "sk-or-test-key";
const TEST_MODEL = "deepseek/deepseek-v4-pro";
const MESSAGES = [{ role: "user" as const, content: "hi" }];

function baseCall(overrides: Record<string, unknown> = {}) {
  return callOpenRouterWithUsage({
    apiKey: TEST_KEY,
    model: TEST_MODEL,
    messages: MESSAGES,
    maxTokens: 100,
    temperature: 0,
    timeoutMs: 5000,
    ...overrides,
  });
}

function okFetch(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response);
}

function makeChoice(content: string | null, toolCalls?: unknown[]) {
  const message: Record<string, unknown> = {};
  if (content !== null) message.content = content;
  if (toolCalls) message.tool_calls = toolCalls;
  return {
    choices: [{ message, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

describe("callOpenRouterWithUsage — request body structure", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("includes 'tools' and 'tool_choice' in body when opts.tools is set", async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return { ok: true, status: 200, json: async () => makeChoice("answer") } as Response;
      }),
    );
    const tools = [{ type: "function", function: { name: "decide" } }];
    const toolChoice = { type: "function", function: { name: "decide" } };
    await baseCall({ tools, toolChoice });
    expect(capturedBody.tools).toEqual(tools);
    expect(capturedBody.tool_choice).toEqual(toolChoice);
  });

  it("adds provider.require_parameters:true when requireParameters is set", async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return { ok: true, status: 200, json: async () => makeChoice("answer") } as Response;
      }),
    );
    await baseCall({
      tools: [{ type: "function", function: { name: "decide" } }],
      toolChoice: { type: "function", function: { name: "decide" } },
      requireParameters: true,
    });
    expect((capturedBody.provider as any)?.require_parameters).toBe(true);
  });

  it("includes response_format when responseFormat is set", async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return { ok: true, status: 200, json: async () => makeChoice("{}") } as Response;
      }),
    );
    const rf = { type: "json_schema", json_schema: { name: "decide", strict: true, schema: {} } };
    await baseCall({ responseFormat: rf });
    expect(capturedBody.response_format).toEqual(rf);
  });

  it("does NOT include tools / tool_choice / provider in body when opts omit them (back-compat)", async () => {
    let capturedBody: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return { ok: true, status: 200, json: async () => makeChoice("answer") } as Response;
      }),
    );
    await baseCall(); // no tools / toolChoice / responseFormat / requireParameters
    expect(capturedBody).not.toHaveProperty("tools");
    expect(capturedBody).not.toHaveProperty("tool_choice");
    expect(capturedBody).not.toHaveProperty("response_format");
    expect(capturedBody).not.toHaveProperty("provider");
  });
});

describe("callOpenRouterWithUsage — tool_calls response parsing", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("returns toolCalls when the response carries tool_calls", async () => {
    const tc = [{ function: { name: "decide", arguments: '{"action":"final","message":"hi"}' } }];
    vi.stubGlobal("fetch", okFetch(makeChoice(null, tc)));
    const result = await baseCall({ tools: [{ type: "function", function: { name: "decide" } }] });
    expect(result.toolCalls).toBeDefined();
    expect(result.toolCalls![0].name).toBe("decide");
    expect(result.toolCalls![0].arguments).toBe('{"action":"final","message":"hi"}');
  });

  it("does NOT throw when content is empty and tool_calls is present (key WO-2 invariant)", async () => {
    const tc = [{ function: { name: "decide", arguments: '{"action":"final","message":"ok"}' } }];
    vi.stubGlobal("fetch", okFetch(makeChoice(null, tc)));
    await expect(
      baseCall({ tools: [{ type: "function", function: { name: "decide" } }] }),
    ).resolves.toMatchObject({ toolCalls: [{ name: "decide" }] });
  });

  it("JSON-encodes tool_calls.arguments when arguments is an object (not a string)", async () => {
    const tc = [{ function: { name: "decide", arguments: { action: "final", message: "hi" } } }];
    vi.stubGlobal("fetch", okFetch(makeChoice(null, tc)));
    const result = await baseCall({ tools: [{ type: "function", function: { name: "decide" } }] });
    const parsed = JSON.parse(result.toolCalls![0].arguments);
    expect(parsed.action).toBe("final");
  });

  it("falls through to content when tools was sent but tool_calls is absent from response", async () => {
    vi.stubGlobal("fetch", okFetch(makeChoice("fallback content")));
    const result = await baseCall({ tools: [{ type: "function", function: { name: "decide" } }] });
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe("fallback content");
  });

  it("throws LlmGatewayError when tools NOT set and content is empty", async () => {
    vi.stubGlobal("fetch", okFetch(makeChoice("")));
    await expect(baseCall()).rejects.toBeInstanceOf(LlmGatewayError);
  });
});

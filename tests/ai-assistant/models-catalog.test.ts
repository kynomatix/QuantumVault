// WO-1: getModelCapabilities — capability flags derived from OpenRouter's
// supported_parameters list. Tests use module resets + fetch stubs to avoid
// network calls and to clear the module-level priceCache between cases.

import { describe, it, expect, beforeEach, vi } from "vitest";

const TOOL_MODEL_ID = "deepseek/deepseek-v4-pro"; // in SELECTABLE_IDS
const UNKNOWN_MODEL_ID = "fictional/does-not-exist-v99"; // NOT in SELECTABLE_IDS

function makeOkFetch(models: unknown[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: models }),
  } as unknown as Response);
}

function makeFailFetch() {
  return vi.fn().mockRejectedValue(new Error("network error"));
}

function modelEntry(id: string, params: string[]) {
  return {
    id,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    supported_parameters: params,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("getModelCapabilities — tools flag", () => {
  it("returns tools:true when supported_parameters includes both 'tools' and 'tool_choice'", async () => {
    vi.stubGlobal(
      "fetch",
      makeOkFetch([modelEntry(TOOL_MODEL_ID, ["tools", "tool_choice", "response_format"])]),
    );
    const { getModelCapabilities } = await import(
      "../../server/ai-assistant/models-catalog"
    );
    const caps = await getModelCapabilities(TOOL_MODEL_ID);
    expect(caps.tools).toBe(true);
    expect(caps.live).toBe(true);
  });

  it("returns tools:false when 'tool_choice' is absent (tools alone is insufficient)", async () => {
    vi.stubGlobal(
      "fetch",
      makeOkFetch([modelEntry(TOOL_MODEL_ID, ["tools", "response_format"])]),
    );
    const { getModelCapabilities } = await import(
      "../../server/ai-assistant/models-catalog"
    );
    const caps = await getModelCapabilities(TOOL_MODEL_ID);
    expect(caps.tools).toBe(false);
  });

  it("returns tools:false when 'tools' is absent even if 'tool_choice' is present", async () => {
    vi.stubGlobal("fetch", makeOkFetch([modelEntry(TOOL_MODEL_ID, ["tool_choice"])]));
    const { getModelCapabilities } = await import(
      "../../server/ai-assistant/models-catalog"
    );
    const caps = await getModelCapabilities(TOOL_MODEL_ID);
    expect(caps.tools).toBe(false);
  });
});

describe("getModelCapabilities — responseFormat + structuredOutputs flags", () => {
  it("parses responseFormat from 'response_format' in supported_parameters", async () => {
    vi.stubGlobal(
      "fetch",
      makeOkFetch([modelEntry(TOOL_MODEL_ID, ["tools", "tool_choice", "response_format"])]),
    );
    const { getModelCapabilities } = await import(
      "../../server/ai-assistant/models-catalog"
    );
    const caps = await getModelCapabilities(TOOL_MODEL_ID);
    expect(caps.responseFormat).toBe(true);
    expect(caps.structuredOutputs).toBe(false);
  });

  it("parses structuredOutputs from 'structured_outputs' in supported_parameters", async () => {
    vi.stubGlobal(
      "fetch",
      makeOkFetch([
        modelEntry(TOOL_MODEL_ID, [
          "tools",
          "tool_choice",
          "response_format",
          "structured_outputs",
        ]),
      ]),
    );
    const { getModelCapabilities } = await import(
      "../../server/ai-assistant/models-catalog"
    );
    const caps = await getModelCapabilities(TOOL_MODEL_ID);
    expect(caps.structuredOutputs).toBe(true);
    expect(caps.responseFormat).toBe(true);
  });
});

describe("getModelCapabilities — fail-soft behaviour", () => {
  it("returns all-false + live:false when the fetch throws (network failure)", async () => {
    vi.stubGlobal("fetch", makeFailFetch());
    const { getModelCapabilities } = await import(
      "../../server/ai-assistant/models-catalog"
    );
    const caps = await getModelCapabilities(TOOL_MODEL_ID);
    expect(caps.tools).toBe(false);
    expect(caps.responseFormat).toBe(false);
    expect(caps.structuredOutputs).toBe(false);
    expect(caps.live).toBe(false);
  });

  it("returns all-false + live:true when the model is not in the selectable list", async () => {
    vi.stubGlobal(
      "fetch",
      makeOkFetch([modelEntry(TOOL_MODEL_ID, ["tools", "tool_choice"])]),
    );
    const { getModelCapabilities } = await import(
      "../../server/ai-assistant/models-catalog"
    );
    const caps = await getModelCapabilities(UNKNOWN_MODEL_ID);
    expect(caps.tools).toBe(false);
    expect(caps.responseFormat).toBe(false);
    expect(caps.structuredOutputs).toBe(false);
    expect(caps.live).toBe(true); // fetch succeeded but model unknown
  });

  it("does not throw — never rejects the caller", async () => {
    vi.stubGlobal("fetch", makeFailFetch());
    const { getModelCapabilities } = await import(
      "../../server/ai-assistant/models-catalog"
    );
    await expect(getModelCapabilities(TOOL_MODEL_ID)).resolves.toBeDefined();
  });
});

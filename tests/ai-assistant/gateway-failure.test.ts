import { afterEach, describe, expect, it, vi } from "vitest";
import { callOpenRouterWithUsage, LlmGatewayError } from "../../server/ai-assistant/router";
import { sanitizeGatewayFailure } from "@shared/ai-gateway-failure";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const call = () => callOpenRouterWithUsage({ apiKey: "EXAMPLE", model: "EXAMPLE", messages: [], timeoutMs: 60_000 });
async function failedCall() {
  try { await call(); } catch (err) { expect(err).toBeInstanceOf(LlmGatewayError); return err as LlmGatewayError; }
  throw new Error("Expected gateway failure");
}
describe("safe gateway diagnostics", () => {
  it.each([400, 401, 402, 403, 404, 408, 429, 500, 502, 503])("projects HTTP %s without retaining body/message/metadata", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, text: async () => JSON.stringify({ error: {
      code: "invalid_json_schema", type: "invalid_request_error", message: "EXAMPLE private prompt", metadata: { raw: "EXAMPLE private headers" },
    } }) }));
    const err = await failedCall();
    expect(err.failure).toEqual({ failureClass: "http", httpStatus: status, providerCode: "invalid_json_schema",
      providerType: "invalid_request_error", elapsedMs: expect.any(Number), attemptCount: 1 });
    expect(JSON.stringify(err)).not.toContain("private");
  });
  it.each(["network", "abort"])("classifies %s without retaining exceptions", async failureClass => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("EXAMPLE private credential"), { name: failureClass === "abort" ? "AbortError" : "TypeError" })));
    const err = await failedCall();
    expect(err.failure).toMatchObject({ failureClass, httpStatus: null });
    expect(err.message).not.toContain("private");
  });
  it.each(["headers", "body", "error_body"])("keeps the 60s deadline through %s", async phase => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, init) => {
      const stalled = () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("EXAMPLE"), { name: "AbortError" }))));
      return phase === "headers" ? stalled() : { ok: phase !== "error_body", status: phase === "error_body" ? 503 : 200, json: stalled, text: stalled };
    }));
    const pending = failedCall();
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await pending).failure).toMatchObject({ failureClass: "timeout", elapsedMs: 60_000, attemptCount: 1,
      httpStatus: phase === "headers" ? null : phase === "error_body" ? 503 : 200 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([null, {}, { choices: [] }, { choices: [{ finish_reason: "length", message: { content: "" } }] }])("classifies empty/missing envelopes (%#)", async data => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => data }));
    expect((await failedCall()).failure).toMatchObject({ failureClass: "envelope_parse", httpStatus: 200 });
  });
  it("classifies invalid JSON and 200 error envelopes", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError("EXAMPLE"); } })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: { code: 503, type: "overloaded_error", message: "EXAMPLE private" } }) });
    vi.stubGlobal("fetch", fetchMock);
    expect((await failedCall()).failure.failureClass).toBe("envelope_parse");
    expect((await failedCall()).failure).toMatchObject({ failureClass: "http", httpStatus: 200, providerCode: "503", providerType: "overloaded_error" });
  });
  it("redacts unknown identifiers, bounds fields and contains throwing getters", () => {
    expect(sanitizeGatewayFailure({ failureClass: "EXAMPLE", httpStatus: 999, providerCode: "EXAMPLE".repeat(500),
      providerType: "EXAMPLE_PRIVATE", elapsedMs: Infinity, attemptCount: 10000, body: "EXAMPLE" }))
      .toEqual({ failureClass: "other", httpStatus: null, providerCode: "other", providerType: "other", elapsedMs: 0, attemptCount: 1000 });
    expect(sanitizeGatewayFailure({ get failureClass() { throw new Error("EXAMPLE"); } })).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { callOpenRouterWithUsage, LlmGatewayError } from "../../server/ai-assistant/router";
import { sanitizeGatewayFailure } from "@shared/ai-gateway-failure";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const call = (opts: Partial<Parameters<typeof callOpenRouterWithUsage>[0]> = {}) =>
  callOpenRouterWithUsage({ apiKey: "EXAMPLE", model: "EXAMPLE", messages: [], timeoutMs: 60_000, ...opts });
async function failedCall(opts: Partial<Parameters<typeof callOpenRouterWithUsage>[0]> = {}) {
  try { await call(opts); } catch (err) { expect(err).toBeInstanceOf(LlmGatewayError); return err as LlmGatewayError; }
  throw new Error("Expected gateway failure");
}
describe("safe gateway diagnostics", () => {
  it.each([
    { omitTemperature: false, requireParameters: true, flagged: true },
    { omitTemperature: true, requireParameters: true, flagged: false },
    { omitTemperature: false, requireParameters: false, flagged: false },
    { omitTemperature: false, requireParameters: undefined, flagged: false },
  ])("flags a 404 only with temperature and strict routing: %j", async ({ flagged, ...opts }) => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404,
      text: async () => JSON.stringify({ error: { code: 404, message: "EXAMPLE private prompt" } }) });
    vi.stubGlobal("fetch", fetchMock);
    const err = await failedCall(opts);
    expect(Boolean(err.temperatureUnsupported)).toBe(flagged);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.prototype.hasOwnProperty.call(body, "temperature")).toBe(!opts.omitTemperature);
    expect(body.provider?.require_parameters === true).toBe(opts.requireParameters === true);
    expect(JSON.stringify(err)).not.toContain("private");
  });

  it("flags a strict-routing 404 even when its body is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404,
      text: async () => { throw new Error("EXAMPLE private"); } }));
    await expect(callOpenRouterWithUsage({ apiKey: "EXAMPLE", model: "EXAMPLE", messages: [], requireParameters: true }))
      .rejects.toMatchObject({ status: 404, temperatureUnsupported: true, failure: { attemptCount: 1 } });
  });

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

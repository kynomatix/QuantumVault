import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJupiterRuntime, resolveJupiterRuntimeConfig } from "../../server/swap/jupiter-runtime";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("Jupiter runtime availability", () => {
  beforeEach(() => vi.restoreAllMocks());

  it.each(["NO_ROUTES_FOUND", "COULD_NOT_FIND_ANY_ROUTE", "TOKEN_NOT_TRADABLE"])(
    "accepts exact structured no-route code %s",
    async (errorCode) => {
      const runtime = createJupiterRuntime({
        fetchImpl: vi.fn(async () => jsonResponse(400, { error: "opaque", errorCode })),
        sleep: async () => undefined,
      });
      await expect(runtime.requestJson({ operation: "quote" })).resolves.toEqual({ kind: "no_route", status: 400, code: errorCode });
    },
  );

  it.each([
    [500, { error: "no route in message" }, "upstream_server"],
    [401, { errorCode: "NO_ROUTES_FOUND" }, "authentication"],
    [403, { errorCode: "NO_ROUTES_FOUND" }, "authentication"],
    [400, { errorCode: "CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD" }, "invalid_request"],
  ])("does not misclassify HTTP %s as no-route", async (status, body, failureClass) => {
    let clock = 0;
    const runtime = createJupiterRuntime({
      fetchImpl: vi.fn(async () => jsonResponse(status as number, body)),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      telemetry: vi.fn(),
    });
    const result = await runtime.requestJson({ operation: "quote" });
    expect(result).toMatchObject({ kind: "unavailable", failure: { failureClass, status } });
  });

  it("treats x-ratelimit-reset as primary and caps it at the five-second provider window", async () => {
    let clock = 1_000_000;
    const starts: number[] = [];
    const telemetry = vi.fn();
    const fetchImpl = vi.fn(async () => {
      starts.push(clock);
      return starts.length === 1
        ? new Response("secret raw response", { status: 429, headers: { "x-ratelimit-reset": "1010", "retry-after": "1" } })
        : jsonResponse(200, { inAmount: "1", outAmount: "2" });
    });
    const runtime = createJupiterRuntime({ now: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl, telemetry });
    await expect(runtime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "success" });
    expect(starts).toEqual([1_000_000, 1_005_000]);
    expect(JSON.stringify(telemetry.mock.calls)).not.toContain("secret raw response");
  });

  it("uses the documented one-second fallback when no usable reset header is present", async () => {
    let clock = 0;
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      starts.push(clock);
      return starts.length === 1
        ? jsonResponse(429, { error: "limited" }, { "x-ratelimit-reset": "invalid" })
        : jsonResponse(200, { inAmount: "1", outAmount: "2" });
    });
    const runtime = createJupiterRuntime({
      env: { JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "10" },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetchImpl,
      telemetry: vi.fn(),
    });
    await expect(runtime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "success" });
    expect(starts).toEqual([0, 1000]);
  });

  it("treats x-ratelimit-reset as absolute epoch seconds and falls back when it is not in the future", async () => {
    let clock = 2_000_000;
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      starts.push(clock);
      return starts.length === 1
        ? jsonResponse(429, { error: "limited" }, { "x-ratelimit-reset": "1999" })
        : jsonResponse(200, { inAmount: "1", outAmount: "2" });
    });
    const runtime = createJupiterRuntime({
      env: { JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "10" },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetchImpl,
      telemetry: vi.fn(),
    });
    await expect(runtime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "success" });
    expect(starts).toEqual([2_000_000, 2_001_000]);
  });

  it("uses Retry-After only as a compatible fallback when reset is absent", async () => {
    let clock = 0;
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      starts.push(clock);
      return starts.length === 1
        ? jsonResponse(429, { error: "limited" }, { "retry-after": "3" })
        : jsonResponse(200, { inAmount: "1", outAmount: "2" });
    });
    const runtime = createJupiterRuntime({
      env: { JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "10" },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetchImpl,
      telemetry: vi.fn(),
    });
    await expect(runtime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "success" });
    expect(starts).toEqual([0, 3000]);
  });

  it("sanity-bounds a distant reset to the five-second provider window", async () => {
    let clock = 0;
    const starts: number[] = [];
    const fetchImpl = vi.fn(async () => {
      starts.push(clock);
      return starts.length === 1
        ? jsonResponse(429, { error: "limited" }, { "x-ratelimit-reset": "999" })
        : jsonResponse(200, { inAmount: "1", outAmount: "2" });
    });
    const runtime = createJupiterRuntime({ now: () => clock, sleep: async (ms) => { clock += ms; }, fetchImpl, telemetry: vi.fn() });
    await expect(runtime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "success" });
    expect(starts).toEqual([0, 5_000]);
  });

  it.each([401, 403])("classifies non-JSON HTTP %s as authentication failure", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("opaque gateway body", { status }));
    const runtime = createJupiterRuntime({ fetchImpl, sleep: async () => undefined, telemetry: vi.fn() });
    await expect(runtime.requestJson({ operation: "quote" })).resolves.toMatchObject({
      kind: "unavailable",
      failure: { failureClass: "authentication", status },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("makes an already queued caller recheck a newly received provider cooldown", async () => {
    let clock = 0;
    const starts: Array<{ at: number; amount: string | null }> = [];
    const sleepers: Array<{ ms: number; release: () => void }> = [];
    const sleep = vi.fn((ms: number) => new Promise<void>((resolve) => {
      sleepers.push({ ms, release: () => { clock += ms; resolve(); } });
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      starts.push({ at: clock, amount: url.searchParams.get("amount") });
      return starts.length === 1
        ? jsonResponse(429, { error: "limited" }, { "x-ratelimit-reset": "5", "retry-after": "1" })
        : jsonResponse(200, { inAmount: "1", outAmount: "2" });
    });
    const runtime = createJupiterRuntime({ now: () => clock, sleep, fetchImpl, telemetry: vi.fn() });
    const first = runtime.requestJson({ operation: "quote", query: { amount: "1" } });
    const queued = runtime.requestJson({ operation: "quote", query: { amount: "2" } });
    let settled = false;
    const combined = Promise.all([first, queued]).finally(() => { settled = true; });
    let released = 0;
    for (let round = 0; round < 10 && !settled; round += 1) {
      for (let spin = 0; spin < 100 && sleepers.length <= released && !settled; spin += 1) await Promise.resolve();
      if (sleepers.length > released) sleepers[released++].release();
    }
    await expect(combined).resolves.toHaveLength(2);
    expect(starts).toHaveLength(3);
    expect(starts[0]).toEqual({ at: 0, amount: "1" });
    expect(sleepers.reduce((total, entry) => total + entry.ms, 0)).toBeGreaterThanOrEqual(5000);
    const retriedFirst = starts.filter((entry) => entry.amount === "1");
    expect(retriedFirst).toHaveLength(2);
    expect(retriedFirst[1].at - retriedFirst[0].at).toBeGreaterThanOrEqual(5000);
    for (let index = 1; index < starts.length; index += 1) expect(starts[index].at - starts[index - 1].at).toBeGreaterThanOrEqual(2000);
  });

  it("starts queued risk reduction before execution and read work", async () => {
    let clock = 0;
    const starts: string[] = [];
    const sleepers: Array<() => void> = [];
    const sleep = vi.fn((ms: number) => new Promise<void>((resolve) => {
      sleepers.push(() => { clock += ms; resolve(); });
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      starts.push(new URL(String(input)).searchParams.get("amount") ?? "missing");
      return jsonResponse(200, { inAmount: "1", outAmount: "2" });
    });
    const runtime = createJupiterRuntime({
      now: () => clock,
      sleep,
      fetchImpl,
      readQueueWaitMs: 60_000,
      telemetry: vi.fn(),
    });
    const first = runtime.requestJson({ operation: "quote", purpose: "read", query: { amount: "first" } });
    const read = runtime.requestJson({ operation: "quote", purpose: "read", query: { amount: "read" } });
    const execution = runtime.requestJson({ operation: "quote", purpose: "execution", query: { amount: "execution" } });
    const risk = runtime.requestJson({ operation: "quote", purpose: "risk_reducing", query: { amount: "risk" } });
    for (let index = 0; index < 3; index += 1) {
      for (let spin = 0; spin < 100 && sleepers.length <= index; spin += 1) await Promise.resolve();
      expect(sleepers.length).toBeGreaterThan(index);
      sleepers[index]();
    }
    await expect(Promise.all([first, read, execution, risk])).resolves.toHaveLength(4);
    expect(starts).toEqual(["first", "risk", "execution", "read"]);
  });

  it("sheds a read that cannot start inside the five-second queue budget", async () => {
    let clock = 0;
    const starts: string[] = [];
    const sleepers: Array<() => void> = [];
    const readExpiryCallbacks: Array<() => void> = [];
    const telemetry = vi.fn();
    const runtime = createJupiterRuntime({
      now: () => clock,
      sleep: (ms) => new Promise<void>((resolve) => {
        sleepers.push(() => { clock += ms; resolve(); });
      }),
      setTimer: ((callback: () => void, ms: number) => {
        if (ms === 5_000) readExpiryCallbacks.push(callback);
        return { ms } as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: vi.fn(),
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        starts.push(new URL(String(input)).searchParams.get("amount") ?? "missing");
        return jsonResponse(200, { inAmount: "1", outAmount: "2" });
      }),
      telemetry,
    });
    const active = runtime.requestJson({ operation: "quote", purpose: "execution", query: { amount: "active" } });
    const queuedExecution = runtime.requestJson({ operation: "quote", purpose: "execution", query: { amount: "queued-execution" } });
    const read = runtime.requestJson({ operation: "quote", purpose: "read", query: { amount: "shed-read" } });
    for (let spin = 0; spin < 100 && readExpiryCallbacks.length === 0; spin += 1) await Promise.resolve();
    expect(readExpiryCallbacks).toHaveLength(1);
    readExpiryCallbacks[0]();
    await expect(read).resolves.toMatchObject({
      kind: "unavailable",
      failure: { failureClass: "rate_limited", status: null },
    });
    expect(starts).not.toContain("shed-read");
    expect(telemetry).toHaveBeenCalledWith(expect.objectContaining({
      operation: "quote",
      failureClass: "rate_limited",
      terminal: true,
    }));
    for (let spin = 0; spin < 100 && sleepers.length === 0; spin += 1) await Promise.resolve();
    expect(sleepers).toHaveLength(1);
    sleepers[0]();
    await expect(Promise.all([active, queuedExecution])).resolves.toHaveLength(2);
    expect(starts).toEqual(["active", "queued-execution"]);
  });

  it("uses the contract's 12000 ms timeout for the complete HTTP operation", async () => {
    const timerDurations: number[] = [];
    const runtime = createJupiterRuntime({
      setTimer: ((callback: () => void, ms: number) => {
        timerDurations.push(ms);
        return { callback, ms } as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimer: vi.fn(),
      fetchImpl: vi.fn(async () => jsonResponse(200, { inAmount: "1", outAmount: "2" })),
    });
    await expect(runtime.requestJson({ operation: "quote", purpose: "execution" })).resolves.toMatchObject({ kind: "success" });
    expect(timerDurations).toContain(12_000);
  });

  it("classifies timeout and network failure without leaking thrown text", async () => {
    let clock = 0;
    const runtime = createJupiterRuntime({
      fetchImpl: vi.fn(async () => { throw new Error("credential-looking transport text"); }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      telemetry: vi.fn(),
    });
    const result = await runtime.requestJson({ operation: "quote" });
    expect(result).toMatchObject({ kind: "unavailable", failure: { failureClass: "network", status: null } });
    expect(JSON.stringify(result)).not.toContain("credential-looking");
    const aborted = new Error("opaque timeout text");
    aborted.name = "AbortError";
    const timeoutRuntime = createJupiterRuntime({
      fetchImpl: vi.fn(async () => { throw aborted; }),
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      telemetry: vi.fn(),
    });
    await expect(timeoutRuntime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "unavailable", failure: { failureClass: "timeout", status: null } });
    const stalledBodyFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const bodyAbort = new Error("opaque stalled body");
          bodyAbort.name = "AbortError";
          reject(bodyAbort);
        }, { once: true });
      }),
    } as unknown as Response));
    const bodyTimeoutRuntime = createJupiterRuntime({
      fetchImpl: stalledBodyFetch,
      sleep: async () => undefined,
      timeoutMs: 5,
      telemetry: vi.fn(),
    });
    await expect(bodyTimeoutRuntime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "unavailable", failure: { failureClass: "timeout", status: 200 } });
    expect(stalledBodyFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, { errorCode: "NO_ROUTES_FOUND" }, "no_route"],
    [401, { error: "unauthorized" }, "unavailable"],
    [400, { errorCode: "CANNOT_COMPUTE_OTHER_AMOUNT_THRESHOLD" }, "unavailable"],
  ])("does not retry terminal HTTP %s outcomes", async (status, body, kind) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status as number, body));
    const runtime = createJupiterRuntime({ fetchImpl, sleep: async () => undefined, telemetry: vi.fn() });
    await expect(runtime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry malformed JSON and stops retryable failures after attempt two", async () => {
    const malformed = vi.fn(async () => new Response("not-json", { status: 200 }));
    const malformedRuntime = createJupiterRuntime({ fetchImpl: malformed, sleep: async () => undefined, telemetry: vi.fn() });
    await expect(malformedRuntime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "unavailable", failure: { failureClass: "malformed_response" } });
    expect(malformed).toHaveBeenCalledTimes(1);

    let clock = 0;
    const upstream = vi.fn(async () => jsonResponse(503, { error: "down" }));
    const retryRuntime = createJupiterRuntime({
      fetchImpl: upstream,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      telemetry: vi.fn(),
    });
    await expect(retryRuntime.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "unavailable", failure: { failureClass: "upstream_server" } });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("uses the official gateway for keyless and keyed traffic and sends a key only when configured", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    let clock = 0;
    const keyless = createJupiterRuntime({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetchImpl: vi.fn(async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return jsonResponse(200, { inAmount: "1", outAmount: "2" });
      }),
    });
    await keyless.requestJson({ operation: "quote" });
    expect(new URL(requests[0].url).hostname).toBe("api.jup.ag");
    expect(requests[0].headers.has("x-api-key")).toBe(false);
    requests.length = 0;
    const runtime = createJupiterRuntime({
      env: { JUPITER_API_KEY: "top-secret" },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      fetchImpl: vi.fn(async (input, init) => {
        requests.push({ url: String(input), headers: new Headers(init?.headers) });
        return jsonResponse(200, { inAmount: "1", outAmount: "2" });
      }),
    });
    await runtime.requestJson({ operation: "quote" });
    await runtime.requestJson({ operation: "swap", body: {} });
    await runtime.requestJson({ operation: "swap-instructions", body: {} });
    expect(requests.map((entry) => new URL(entry.url).pathname)).toEqual(["/swap/v1/quote", "/swap/v1/swap", "/swap/v1/swap-instructions"]);
    expect(requests.every((entry) => new URL(entry.url).hostname === "api.jup.ag" && entry.headers.get("x-api-key") === "top-secret")).toBe(true);
    const customRequests: Array<{ url: string; headers: Headers }> = [];
    const custom = createJupiterRuntime({
      env: { JUPITER_API_BASE: "https://swap-proxy.example/v1" },
      fetchImpl: vi.fn(async (input, init) => {
        customRequests.push({ url: String(input), headers: new Headers(init?.headers) });
        return jsonResponse(200, { inAmount: "1", outAmount: "2" });
      }),
    });
    await custom.requestJson({ operation: "quote" });
    expect(new URL(customRequests[0].url).hostname).toBe("swap-proxy.example");
    expect(customRequests[0].headers.has("x-api-key")).toBe(false);
    const invalidTelemetry = vi.fn();
    const invalidFetch = vi.fn();
    const invalid = createJupiterRuntime({
      env: { JUPITER_API_KEY: "top-secret", JUPITER_API_BASE: "https://example.com/swap/v1" },
      fetchImpl: invalidFetch,
      telemetry: invalidTelemetry,
    });
    await expect(invalid.requestJson({ operation: "quote" })).resolves.toMatchObject({ kind: "unavailable", failure: { failureClass: "configuration" } });
    expect(invalidFetch).not.toHaveBeenCalled();
    expect(invalidTelemetry).toHaveBeenCalledWith(expect.objectContaining({ endpointHost: "api.jup.ag", failureClass: "configuration", terminal: true }));
    expect(JSON.stringify(invalidTelemetry.mock.calls)).not.toContain("top-secret");
  });

  it("uses safe tier defaults and reports rejected rate settings without increasing request rate", () => {
    expect(resolveJupiterRuntimeConfig({}).intervalMs).toBe(2000);
    expect(resolveJupiterRuntimeConfig({ JUPITER_API_KEY: "x" }).intervalMs).toBe(1000);
    expect(resolveJupiterRuntimeConfig({ JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "1" }).intervalMs).toBe(1000);
    expect(resolveJupiterRuntimeConfig({ JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "10" }).intervalMs).toBe(100);
    expect(resolveJupiterRuntimeConfig({ JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "50" }).intervalMs).toBe(20);
    expect(resolveJupiterRuntimeConfig({ JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "150" }).intervalMs).toBe(7);
    expect(resolveJupiterRuntimeConfig({ JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "2" }).intervalMs).toBe(1000);
    const invalidRateTelemetry = vi.fn();
    createJupiterRuntime({ env: { JUPITER_API_KEY: "x", JUPITER_REQUESTS_PER_SECOND: "2" }, telemetry: invalidRateTelemetry });
    expect(invalidRateTelemetry).toHaveBeenCalledWith(expect.objectContaining({ operation: "configuration", failureClass: "configuration", terminal: false, retryDelayMs: 1000 }));
    expect(resolveJupiterRuntimeConfig({ JUPITER_REQUESTS_PER_SECOND: "10" })).toMatchObject({ intervalMs: 2000, rateConfigurationInvalid: true });
  });

  async function expectMalformedQuote(body: { inAmount?: unknown; outAmount?: unknown }) {
    vi.resetModules();
    vi.doMock("../../server/swap/jupiter-runtime.js", () => ({
      jupiterRuntimeIdentity: () => "api.jup.ag:keyless",
      jupiterRequestJson: vi.fn(async () => ({ kind: "success", body })),
    }));
    try {
      const { JupiterProvider } = await import("../../server/swap/jupiter");
      await expect(new JupiterProvider().getQuote({ inputMint: "in", outputMint: "out", amountRaw: "1", slippageBps: 100 })).resolves.toMatchObject({
        kind: "unavailable",
        failure: { provider: "jupiter", failureClass: "malformed_response", status: 200 },
      });
    } finally {
      vi.doUnmock("../../server/swap/jupiter-runtime.js");
    }
  }

  it("maps a quote with missing output to provider unavailability", async () => {
    await expectMalformedQuote({ inAmount: "1" });
  });

  it("maps a quote with mismatched input amount to provider unavailability", async () => {
    await expectMalformedQuote({ inAmount: "2", outAmount: "10" });
  });

  it("maps a quote with zero output to provider unavailability", async () => {
    await expectMalformedQuote({ inAmount: "1", outAmount: "0" });
  });

  it("preserves risk-reducing purpose from quote through transaction construction", async () => {
    vi.resetModules();
    const jupiterRequestJson = vi.fn(async (request: { operation: string }) => request.operation === "quote"
      ? { kind: "success" as const, body: { inAmount: "1", outAmount: "2", priceImpactPct: "0" } }
      : { kind: "success" as const, body: { swapTransaction: "transaction" } });
    vi.doMock("../../server/swap/jupiter-runtime.js", () => ({
      jupiterRuntimeIdentity: () => "api.jup.ag:keyless",
      jupiterRequestJson,
    }));
    try {
      const { JupiterProvider } = await import("../../server/swap/jupiter");
      const provider = new JupiterProvider();
      const result = await provider.getQuote({
        inputMint: "in",
        outputMint: "out",
        amountRaw: "1",
        slippageBps: 100,
        purpose: "risk_reducing",
      });
      expect(result.kind).toBe("quote");
      if (result.kind !== "quote") throw new Error("expected quote");
      await expect(provider.buildSwapTransaction(result.quote, "wallet")).resolves.toBe("transaction");
      expect(jupiterRequestJson).toHaveBeenNthCalledWith(1, expect.objectContaining({ operation: "quote", purpose: "risk_reducing" }));
      expect(jupiterRequestJson).toHaveBeenNthCalledWith(2, expect.objectContaining({ operation: "swap", purpose: "risk_reducing" }));
    } finally {
      vi.doUnmock("../../server/swap/jupiter-runtime.js");
    }
  });

  it("rejects an empty successful swap-build payload before signing", async () => {
    vi.resetModules();
    vi.doMock("../../server/swap/jupiter-runtime.js", () => ({
      jupiterRuntimeIdentity: () => "api.jup.ag:keyless",
      jupiterRequestJson: vi.fn(async () => ({ kind: "success", body: { swapTransaction: "" } })),
    }));
    try {
      const { JupiterProvider } = await import("../../server/swap/jupiter");
      await expect(new JupiterProvider().buildSwapTransaction({
        provider: "jupiter",
        inputMint: "in",
        outputMint: "out",
        inAmountRaw: "1",
        outAmountRaw: "2",
        priceImpactPct: 0,
        slippageBps: 100,
        raw: {},
      }, "wallet")).rejects.toThrow("malformed response");
    } finally {
      vi.doUnmock("../../server/swap/jupiter-runtime.js");
    }
  });
});

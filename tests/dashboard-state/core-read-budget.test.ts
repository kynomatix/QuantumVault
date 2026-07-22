/**
 * WO-20 / WO-20.1 — core-read budget tests.
 *
 * Every scenario is deterministic: fake timers control the 15-second deadline
 * and the 503 Retry-After delay; fetch is stubbed to either never-settle,
 * immediately resolve, or resolve in response-sequence order.
 *
 * Invariants under test:
 *  1. Never-settling fetch times out at exactly CORE_READ_BUDGET_MS.
 *  2. Caller cancellation is NOT classified as degradation or session expiry.
 *  3. State is clean after success / HTTP error / timeout / cancellation.
 *  4. 503 + Retry-After retry succeeds within the budget.
 *  5. 503 + long Retry-After times out within the SAME budget.
 *  6. A single timeout immediately marks the server degraded (reportCoreReadTimeoutNow);
 *     session expiry is never raised for timeouts.
 *  7. CoreReadTimeoutError is transient (stale data preserved by React Query).
 *  8. A timeout throws — never returns null — so no-cache queries enter the
 *     error state instead of the empty-account state.
 *  9. A changed X-Boot-Id fires emitRecovery().
 * 10. A matched X-Boot-Id does NOT fire recovery (idempotent).
 * 11. Successful response clears degradation and fires recovery listeners.
 * 12. Mutations (apiRequest) are unaffected by coreReadJson.
 * 13. (WO-20.1) A body that never settles is caught by the combined signal
 *     inside safeResponseJson — it cannot escape the 15-second budget.
 *
 * IMPORTANT: every test that advances fake timers past the deadline MUST
 * attach a rejection handler BEFORE calling vi.advanceTimersByTimeAsync(),
 * using Promise.all([expect(p).rejects..., vi.advanceTimersByTimeAsync(...)]).
 * Attaching a handler after the timer fires causes a PromiseRejectionHandled
 * warning which vitest promotes to a test failure.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  coreReadJson,
  CoreReadTimeoutError,
  CoreReadError,
  CORE_READ_BUDGET_MS,
  isServerDegraded,
  isSessionExpired,
  reportCoreReadFailure,
  registerRecoveryListener,
  __resetServerHealthForTests,
} from "@/lib/server-health";
import { isTransientReadError } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

/**
 * A fetch mock that properly honours the AbortSignal: it rejects immediately
 * if the signal is already aborted, or listens and rejects when it fires.
 * Used for the "never-settling" and "wallet-switch cancellation" tests so the
 * deadline AbortController can actually cancel the pending promise.
 */
function abortAwareFetch(_input: unknown, init?: { signal?: AbortSignal }) {
  const signal = init?.signal;
  return new Promise<Response>((_, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("AbortError", "AbortError"));
      return;
    }
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("AbortError", "AbortError")),
      { once: true },
    );
  });
}

/**
 * Returns a Response immediately but whose body never resolves.
 * Tests the WO-20.1 fix: the body read must race the combined signal inside
 * safeResponseJson so a hung body stream cannot escape the 15-second budget.
 */
function bodyHangsFetch(_input: unknown, _init?: { signal?: AbortSignal }) {
  const mockResponse = {
    status: 200,
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    // text() returns a promise that never resolves (simulates a hung TCP stream
    // where headers arrived but the body bytes never come).
    text: () => new Promise<string>(() => {}),
    body: null,
  };
  return Promise.resolve(mockResponse as unknown as Response);
}

function makeResponse(
  status: number,
  body = "{}",
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = new Headers({
    "content-type": "application/json",
    ...extraHeaders,
  });
  return new Response(body, { status, headers });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  __resetServerHealthForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllTimers();
});

// ---------------------------------------------------------------------------
// 1. Never-settling fetch times out at CORE_READ_BUDGET_MS
// ---------------------------------------------------------------------------

describe("deadline — never-settling fetch", () => {
  it("throws CoreReadTimeoutError at exactly the budget limit", async () => {
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    const promise = coreReadJson("positions", "/api/positions", undefined);
    // Attach handler BEFORE advancing time to avoid PromiseRejectionHandledWarning.
    await Promise.all([
      expect(promise).rejects.toBeInstanceOf(CoreReadTimeoutError),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);
  });

  it("does NOT throw before the deadline", async () => {
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    const promise = coreReadJson("positions", "/api/positions", undefined);

    // Attach a silent catch immediately so the cleanup never leaves an unhandled rejection.
    const caught = promise.catch((e) => e);

    // Advance to just before the deadline — promise must still be pending.
    await vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS - 1);

    let settled = false;
    caught.then(() => {
      settled = true;
    });
    await Promise.resolve(); // drain microtasks
    expect(settled).toBe(false);

    // Advance past the deadline to clean up (caught already has the handler).
    await vi.advanceTimersByTimeAsync(2);
    const err = await caught;
    expect(err).toBeInstanceOf(CoreReadTimeoutError);
  });

  it("timeout error has kind='timeout' and correct resource name", async () => {
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    const promise = coreReadJson("trading-bots", "/api/trading-bots", undefined);
    const [err] = await Promise.all([
      promise.catch((e) => e),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);

    expect(err).toBeInstanceOf(CoreReadTimeoutError);
    expect((err as CoreReadTimeoutError).kind).toBe("timeout");
    expect((err as CoreReadTimeoutError).resource).toBe("trading-bots");
  });
});

// ---------------------------------------------------------------------------
// 2. Caller cancellation — no health penalty
// ---------------------------------------------------------------------------

describe("caller cancellation", () => {
  it("pre-aborted signal rejects immediately without degradation", async () => {
    const ctrl = new AbortController();
    ctrl.abort();

    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    await expect(
      coreReadJson("positions", "/api/positions", undefined, { signal: ctrl.signal }),
    ).rejects.toThrow(DOMException);

    // No degradation: caller cancelled, not a server failure.
    expect(isServerDegraded()).toBe(false);
    expect(isSessionExpired()).toBe(false);
  });

  it("mid-flight cancellation does not degrade the server", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    const promise = coreReadJson("positions", "/api/positions", undefined, {
      signal: ctrl.signal,
    });

    // Cancel after fetch is in-flight.
    ctrl.abort();

    await expect(promise).rejects.toThrow();
    expect(isServerDegraded()).toBe(false);
    expect(isSessionExpired()).toBe(false);
  });

  it("cancellation is NOT a CoreReadTimeoutError", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    const promise = coreReadJson("positions", "/api/positions", undefined, {
      signal: ctrl.signal,
    });
    ctrl.abort();

    const err = await promise.catch((e) => e);
    expect(err).not.toBeInstanceOf(CoreReadTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// 3. Clean state after each outcome
// ---------------------------------------------------------------------------

describe("state cleanup", () => {
  it("success: no degradation, no session expiry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse(200)));

    await coreReadJson("positions", "/api/positions", undefined);

    expect(isServerDegraded()).toBe(false);
    expect(isSessionExpired()).toBe(false);
  });

  it("4xx does NOT degrade (server answered authoritatively)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse(404)));

    // 404 is returned without throwing by coreReadJson (callers check ok themselves)
    const result = await coreReadJson("positions", "/api/positions", undefined, {
      authed: false,
    });
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
    expect(isServerDegraded()).toBe(false);
  });

  it("5xx increments failure counter (degraded after 2)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse(500)));

    await coreReadJson("positions", "/api/positions", undefined);
    expect(isServerDegraded()).toBe(false); // 1 failure — below threshold

    await coreReadJson("positions", "/api/positions", undefined);
    expect(isServerDegraded()).toBe(true); // 2nd failure → degraded
  });

  it("recovery clears degradation after 5xx → 200 sequence", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(200));

    vi.stubGlobal("fetch", fetchMock);

    await coreReadJson("positions", "/api/positions", undefined);
    await coreReadJson("positions", "/api/positions", undefined);
    expect(isServerDegraded()).toBe(true);

    await coreReadJson("positions", "/api/positions", undefined);
    expect(isServerDegraded()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. 503 retry within the budget
// ---------------------------------------------------------------------------

describe("503 retry within budget", () => {
  it("retries once after 503 + Retry-After and returns the second response", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(makeResponse(503, "{}", { "Retry-After": "3" }));
        }
        return Promise.resolve(makeResponse(200));
      }),
    );

    const promise = coreReadJson("positions", "/api/positions", undefined);
    // Advance past the 3-second Retry-After delay.
    await vi.advanceTimersByTimeAsync(3000);

    const result = await promise;
    expect(result.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it("does not count 503→200 as a failure (degradation counter stays zero)", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        return Promise.resolve(
          callCount === 1
            ? makeResponse(503, "{}", { "Retry-After": "1" })
            : makeResponse(200),
        );
      }),
    );

    const promise = coreReadJson("positions", "/api/positions", undefined);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(isServerDegraded()).toBe(false);
  });

  it("clamps Retry-After above MAX to 5 seconds", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve(
            makeResponse(503, "{}", { "Retry-After": "60" }), // server says 60s
          );
        }
        return Promise.resolve(makeResponse(200));
      }),
    );

    const promise = coreReadJson("positions", "/api/positions", undefined);

    // Advance only 5s — if the clamp works, the retry should fire by now.
    await vi.advanceTimersByTimeAsync(5200);
    const result = await promise;

    expect(result.status).toBe(200);
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. 503 with long Retry-After exhausts the budget → CoreReadTimeoutError
// ---------------------------------------------------------------------------

describe("503 retry exceeds budget", () => {
  it("times out within the budget even when the retry fires", async () => {
    // Timeline: budget=15s, Retry-After=5 (clamped). At t=5s the retry fires
    // (callCount=2). At t=15s the deadline aborts the retry → CoreReadTimeoutError.
    // The key invariant: the promise ALWAYS rejects with CoreReadTimeoutError
    // before the 15s budget expires, regardless of whether the retry fired.
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => {
        callCount++;
        if (callCount === 1) {
          // First response is 503 with 5-second Retry-After.
          return Promise.resolve(makeResponse(503, "{}", { "Retry-After": "5" }));
        }
        // Retry request: abort-aware so the deadline signal can cancel it.
        return abortAwareFetch(_input, init) as Promise<Response>;
      }),
    );

    const promise = coreReadJson("positions", "/api/positions", undefined);
    // Advance past the full budget — deadline fires and aborts the retry request.
    await Promise.all([
      expect(promise).rejects.toBeInstanceOf(CoreReadTimeoutError),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);
    // The retry DID fire (at 5s) but was aborted at 15s: callCount === 2.
    expect(callCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Timeout → degraded immediately; never session expiry
// ---------------------------------------------------------------------------

describe("timeout classification", () => {
  it("first timeout immediately marks degraded via reportCoreReadTimeoutNow", async () => {
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    // Single timeout: immediate latch (no two-failure threshold for timeouts).
    const p1 = coreReadJson("positions", "/api/positions", undefined);
    await Promise.all([
      expect(p1).rejects.toBeInstanceOf(CoreReadTimeoutError),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);
    expect(isServerDegraded()).toBe(true); // immediate — no second timeout required
    expect(isSessionExpired()).toBe(false); // NEVER session expiry for timeouts
  });

  it("timeout with authed:true does not produce session expiry", async () => {
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    const promise = coreReadJson(
      "health-metrics",
      "/api/health-metrics",
      undefined,
      { authed: true },
    );
    await Promise.all([
      expect(promise).rejects.toBeInstanceOf(CoreReadTimeoutError),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);

    expect(isSessionExpired()).toBe(false);
  });

  it("subsequent success after timeout fires recovery (degraded → healthy)", async () => {
    let recovered = false;
    registerRecoveryListener(() => {
      recovered = true;
    });

    // First: timeout → degraded immediately.
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));
    const p1 = coreReadJson("positions", "/api/positions", undefined);
    await Promise.all([
      p1.catch(() => {}),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);
    expect(isServerDegraded()).toBe(true);
    expect(recovered).toBe(false);

    // Then: success → clears degradation, fires recovery.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse(200)));
    await coreReadJson("positions", "/api/positions", undefined);
    expect(isServerDegraded()).toBe(false);
    expect(recovered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. isTransientReadError: CoreReadTimeoutError is transient
// ---------------------------------------------------------------------------

describe("isTransientReadError — stale-data preservation", () => {
  it("CoreReadTimeoutError is transient (React Query retries, stale data stays)", () => {
    const err = new CoreReadTimeoutError("positions");
    expect(isTransientReadError(err)).toBe(true);
  });

  it("CoreReadError(server) is also transient", () => {
    const err = new CoreReadError("positions", 503);
    expect(isTransientReadError(err)).toBe(true);
  });

  it("CoreReadError(auth) is NOT transient — auth failures do not retry", () => {
    const err = new CoreReadError("positions", 401);
    expect(isTransientReadError(err)).toBe(false);
  });

  it("CoreReadError(http/404) is NOT transient", () => {
    const err = new CoreReadError("positions", 404);
    expect(isTransientReadError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Timeout throws — never returns null — so no-cache reads enter error state
// ---------------------------------------------------------------------------

describe("no-cache read: timeout throws, never returns null", () => {
  it("rejects with CoreReadTimeoutError (callers see an error, not empty data)", async () => {
    vi.stubGlobal("fetch", vi.fn(abortAwareFetch));

    const promise = coreReadJson("trading-bots", "/api/trading-bots", undefined);
    await Promise.all([
      expect(promise).rejects.toBeInstanceOf(CoreReadTimeoutError),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);
  });

  it("successful response resolves with a CoreReadResult (status, ok, data)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeResponse(200, '{"ok":true}')),
    );

    const result = await coreReadJson("trading-bots", "/api/trading-bots", undefined);
    expect(result.status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// 9. Changed X-Boot-Id fires emitRecovery()
// ---------------------------------------------------------------------------

describe("boot-id tracking", () => {
  it("first boot id seen: no recovery fired (no prior to compare against)", async () => {
    let recoveryCount = 0;
    registerRecoveryListener(() => {
      recoveryCount++;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(makeResponse(200, "{}", { "X-Boot-Id": "boot-1" })),
    );

    await coreReadJson("positions", "/api/positions", undefined);
    expect(recoveryCount).toBe(0);
  });

  it("changed boot id fires recovery exactly once", async () => {
    let recoveryCount = 0;
    registerRecoveryListener(() => {
      recoveryCount++;
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(200, "{}", { "X-Boot-Id": "boot-1" }))
      .mockResolvedValueOnce(makeResponse(200, "{}", { "X-Boot-Id": "boot-2" }));

    vi.stubGlobal("fetch", fetchMock);

    await coreReadJson("positions", "/api/positions", undefined); // sets boot-1
    expect(recoveryCount).toBe(0); // no prior → no recovery

    await coreReadJson("positions", "/api/positions", undefined); // sees boot-2
    expect(recoveryCount).toBe(1); // boot changed → recovery
  });

  it("same boot id repeated does NOT fire recovery", async () => {
    let recoveryCount = 0;
    registerRecoveryListener(() => {
      recoveryCount++;
    });

    // Use mockImplementation (not mockResolvedValue) so each call gets a FRESH
    // Response instance. coreReadJson consumes the body internally; reusing the
    // same Response object across calls would exhaust its body stream on call 2+.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(makeResponse(200, "{}", { "X-Boot-Id": "boot-stable" })),
      ),
    );

    await coreReadJson("positions", "/api/positions", undefined);
    await coreReadJson("positions", "/api/positions", undefined);
    await coreReadJson("positions", "/api/positions", undefined);

    expect(recoveryCount).toBe(0); // same id every time — never fires
  });

  it("boot id missing from response leaves prior id unchanged", async () => {
    let recoveryCount = 0;
    registerRecoveryListener(() => {
      recoveryCount++;
    });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(200, "{}", { "X-Boot-Id": "boot-1" }))
      .mockResolvedValueOnce(makeResponse(200, "{}")); // no X-Boot-Id

    vi.stubGlobal("fetch", fetchMock);

    await coreReadJson("positions", "/api/positions", undefined);
    await coreReadJson("positions", "/api/positions", undefined); // no header — no change

    expect(recoveryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Idempotent: matched boot id does NOT double-fire recovery
// ---------------------------------------------------------------------------

describe("recovery listener idempotency", () => {
  it("degraded→healthy fires recovery once; subsequent successes do not re-fire", async () => {
    let recoveryCount = 0;
    registerRecoveryListener(() => {
      recoveryCount++;
    });

    // Use mockImplementation for the 200 tail so each call gets a FRESH
    // Response instance — coreReadJson consumes the body internally and
    // mockResolvedValue reuses the same object, exhausting the stream on call 2.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(makeResponse(500))
      .mockResolvedValueOnce(makeResponse(500))
      .mockImplementation(() => Promise.resolve(makeResponse(200)));

    vi.stubGlobal("fetch", fetchMock);

    await coreReadJson("positions", "/api/positions", undefined);
    await coreReadJson("positions", "/api/positions", undefined); // → degraded

    // Two more successes — recovery should fire exactly once (on first success)
    await coreReadJson("positions", "/api/positions", undefined);
    await coreReadJson("positions", "/api/positions", undefined);

    expect(recoveryCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Successful response clears degradation and fires recovery
// ---------------------------------------------------------------------------

describe("degraded → healthy transition", () => {
  it("fires recovery listener when degradation clears", async () => {
    let recovered = false;
    registerRecoveryListener(() => {
      recovered = true;
    });

    // Pre-degrade via reportCoreReadFailure (simulates prior failures).
    reportCoreReadFailure();
    reportCoreReadFailure();
    expect(isServerDegraded()).toBe(true);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeResponse(200)));

    await coreReadJson("positions", "/api/positions", undefined);

    expect(isServerDegraded()).toBe(false);
    expect(recovered).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12. Mutations are unaffected — apiRequest does NOT go through coreReadJson
// ---------------------------------------------------------------------------

describe("mutation path is unchanged", () => {
  it("apiRequest uses plain fetch, not the budget wrapper", async () => {
    const { apiRequest } = await import("@/lib/queryClient");
    expect(typeof apiRequest).toBe("function");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
    );

    // Should resolve without fake timer advancement (no 15s budget applied).
    const res = await apiRequest("GET", "/api/test");
    expect(res.status).toBe(200);

    // No degradation side-effect from a plain GET via apiRequest.
    expect(isServerDegraded()).toBe(false);
  });

  it("POST mutations resolve without timeout regardless of slow response", async () => {
    const { apiRequest } = await import("@/lib/queryClient");

    // Simulate a slow server response that resolves after 20s.
    let resolveResponse!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      ),
    );

    const mutationPromise = apiRequest("POST", "/api/trade/open", {
      market: "SOL-PERP",
      size: 1,
    });

    // Advance well past the 15s budget without resolving.
    await vi.advanceTimersByTimeAsync(20_000);

    // Mutation is still pending (no budget applied).
    let settled = false;
    mutationPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    // Now resolve it — should complete without error.
    resolveResponse(new Response("{}", { status: 200 }));
    const res = await mutationPromise;
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 13. (WO-20.1) Body-never-settles is caught by the combined signal
// ---------------------------------------------------------------------------

describe("body never settles — deadline still fires (WO-20.1 fix)", () => {
  it("a body that hangs forever is aborted by the combined signal inside safeResponseJson", async () => {
    // fetch returns headers immediately but the body never resolves.
    // Under the old coreReadFetch the timer was cleared BEFORE safeResponseJson,
    // so this body would hang indefinitely. Under coreReadJson the combined
    // signal is threaded into safeResponseJson and races the body read.
    vi.stubGlobal("fetch", vi.fn(bodyHangsFetch));

    const promise = coreReadJson("positions", "/api/positions", undefined);
    await Promise.all([
      expect(promise).rejects.toBeInstanceOf(CoreReadTimeoutError),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);
  });

  it("body-hang timeout marks the server degraded immediately", async () => {
    vi.stubGlobal("fetch", vi.fn(bodyHangsFetch));

    const promise = coreReadJson("positions", "/api/positions", undefined);
    await Promise.all([
      promise.catch(() => {}),
      vi.advanceTimersByTimeAsync(CORE_READ_BUDGET_MS),
    ]);

    expect(isServerDegraded()).toBe(true);
    expect(isSessionExpired()).toBe(false);
  });

  it("caller cancellation during body hang does NOT degrade", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", vi.fn(bodyHangsFetch));

    const promise = coreReadJson("positions", "/api/positions", undefined, {
      signal: ctrl.signal,
    });
    ctrl.abort();

    await expect(promise).rejects.toThrow();
    expect(isServerDegraded()).toBe(false);
  });
});

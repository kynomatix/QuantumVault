// 2026-07-20 incident — client-state telemetry unit tests.
//
// The telemetry module ships incident evidence (wallet flaps, probe verdicts,
// sessionConnected flips) to POST /api/client-telemetry. Because it runs on
// every production browser, its own discipline is what's pinned here:
//
//   1. Deduped: identical type+detail within the window records ONCE, but a
//      CHANGED detail (a real transition, e.g. wallet present→absent) always
//      records — flapping must flap through.
//   2. Bounded: ring cap and a per-minute event cap; drops are COUNTED into a
//      'tel-dropped' event on the next window, never silent.
//   3. Delivery-or-requeue: a failed flush (possibly the incident itself)
//      puts events back, capped, so the incident-onset timeline arrives on
//      the first successful POST after recovery.
//   4. Node-safe: importing + recording without init touches no DOM and
//      never auto-schedules network work.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  recordClientEvent,
  __resetClientTelemetryForTests,
  __getClientTelemetryStateForTests,
  __flushClientTelemetryForTests,
} from "../../client/src/lib/client-telemetry";
import { setActiveWalletAddress } from "../../client/src/lib/queryClient";
import { __resetSessionProbeForTests } from "../../client/src/lib/session-probe";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetClientTelemetryForTests();
  __resetSessionProbeForTests();
  setActiveWalletAddress(null);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  __resetClientTelemetryForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function ringTypes(): string[] {
  return __getClientTelemetryStateForTests().ring.map((e) => e.type);
}

describe("event recording — dedupe and transitions", () => {
  it("identical type+detail within the dedupe window records once", () => {
    recordClientEvent("wallet", "present");
    recordClientEvent("wallet", "present");
    recordClientEvent("wallet", "present");
    expect(ringTypes().filter((t) => t === "wallet")).toHaveLength(1);
  });

  it("a CHANGED detail always records — flapping flaps through", () => {
    recordClientEvent("wallet", "present");
    recordClientEvent("wallet", "absent");
    recordClientEvent("wallet", "present");
    recordClientEvent("wallet", "absent");
    const walletEvents = __getClientTelemetryStateForTests().ring.filter(
      (e) => e.type === "wallet",
    );
    expect(walletEvents.map((e) => e.d)).toEqual(["present", "absent", "present", "absent"]);
  });

  it("the same value records again once the dedupe window passes", () => {
    vi.useFakeTimers();
    recordClientEvent("session-connected", "true");
    vi.setSystemTime(Date.now() + 6_000);
    recordClientEvent("session-connected", "true");
    expect(ringTypes().filter((t) => t === "session-connected")).toHaveLength(2);
  });
});

describe("bounds — ring cap and per-minute cap", () => {
  it("per-minute cap drops excess events and reports the drop count next window", () => {
    vi.useFakeTimers();
    // 40 unique events (unique detail dodges dedupe) against a 30/min cap.
    for (let i = 0; i < 40; i++) recordClientEvent("burst", `e${i}`);
    expect(ringTypes().filter((t) => t === "burst")).toHaveLength(30);

    // Next minute: the drop is surfaced as a counted event, never silent.
    vi.setSystemTime(Date.now() + 61_000);
    recordClientEvent("after", "window");
    const dropped = __getClientTelemetryStateForTests().ring.find(
      (e) => e.type === "tel-dropped",
    );
    expect(dropped?.d).toBe("10");
  });

  it("ring never exceeds its cap", () => {
    vi.useFakeTimers();
    for (let minute = 0; minute < 3; minute++) {
      for (let i = 0; i < 30; i++) recordClientEvent(`m${minute}`, `e${i}`);
      vi.setSystemTime(Date.now() + 61_000);
    }
    expect(__getClientTelemetryStateForTests().ring.length).toBeLessThanOrEqual(50);
  });
});

describe("flush — delivery or requeue", () => {
  it("successful flush posts the events and empties the ring", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    recordClientEvent("verdict", "valid");
    recordClientEvent("wallet", "present");

    await __flushClientTelemetryForTests("hb");

    expect(__getClientTelemetryStateForTests().ring).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("/api/client-telemetry");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.kind).toBe("hb");
    expect(body.ev.map((e: { type: string }) => e.type)).toEqual(["verdict", "wallet"]);
    expect(body.hb).toMatchObject({ verdict: "none" });
  });

  it("failed flush re-queues the events (incident timeline survives the outage)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    recordClientEvent("verdict", "server-unavailable:http-503");
    recordClientEvent("wallet", "absent");

    await __flushClientTelemetryForTests();

    expect(ringTypes()).toEqual(["verdict", "wallet"]);

    // Server comes back: the SAME events are delivered on the next flush.
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await __flushClientTelemetryForTests();
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.ev.map((e: { type: string }) => e.type)).toEqual(["verdict", "wallet"]);
    expect(__getClientTelemetryStateForTests().ring).toHaveLength(0);
  });

  it("non-2xx flush also re-queues", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    recordClientEvent("verdict", "valid");
    await __flushClientTelemetryForTests();
    expect(ringTypes()).toEqual(["verdict"]);
  });

  it("wallet identity in the flush body is shortened, never the full address", async () => {
    setActiveWalletAddress("WaLLetActive1111111111111111111111111111111");
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    recordClientEvent("wallet", "present");
    await __flushClientTelemetryForTests();
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.w).toBe("WaLL..1111");
    expect(JSON.stringify(body)).not.toContain("WaLLetActive1111111111111111111111111111111");
  });
});

describe("node-safety — no init, no network", () => {
  it("recording without initClientTelemetry never schedules a network call", async () => {
    recordClientEvent("wallet", "present");
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(__getClientTelemetryStateForTests().initialized).toBe(false);
  });
});

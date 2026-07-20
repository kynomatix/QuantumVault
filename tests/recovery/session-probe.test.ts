// 2026-07-20 incident regression tests: the auth/session recovery state
// machine (client/src/lib/session-probe.ts + the coreFetch arbiter hook in
// server-health.ts).
//
// Invariants pinned here:
//   1. A probe timeout / network error / 5xx is "server-unavailable" — it
//      NEVER latches the session-expired banner and NEVER produces a
//      signature-required verdict (during the incident, transient 401s and
//      timeouts against a wedged pool rendered "sign in again" while the
//      user's 7-day cookie was perfectly valid).
//   2. Only an AUTHORITATIVE probe answer latches: 401 → cookie-invalid,
//      403 → wallet-mismatch, 200+hasSession:false → umk-missing.
//   3. An authoritative valid probe clears the latch and fires the recovery
//      listeners (queryClient refetches errored queries on that edge).
//   4. A stray core-read 401 is EVIDENCE handed to the arbiter — recorded,
//      wallet-match checked, then settled by ONE probe. It does not latch
//      by itself, and a rejection stamped with a stale wallet is discarded.
//   5. Single-flight: concurrent probes share one request.
//   6. A wallet switch mid-probe discards the verdict (no cross-wallet latch).
//   7. After "server-unavailable", a health-recovery edge re-probes
//      automatically — no user action, no permanent one-attempt deadlock.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  probeSession,
  onSessionVerdict,
  getAuthRejectionEvidence,
  getLastSessionVerdict,
  getLastKnownBootId,
  __resetSessionProbeForTests,
} from "../../client/src/lib/session-probe";
import {
  coreFetch,
  isSessionExpired,
  reportCoreAuthFailure,
  reportCoreReadFailure,
  reportCoreReadSuccess,
  registerRecoveryListener,
  __resetServerHealthForTests,
} from "../../client/src/lib/server-health";
import { setActiveWalletAddress } from "../../client/src/lib/queryClient";

const WALLET = "WaLLetActive1111111111111111111111111111111";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetSessionProbeForTests();
  __resetServerHealthForTests();
  setActiveWalletAddress(WALLET);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // Clear any pending backoff timer BEFORE the fetch stub disappears.
  __resetSessionProbeForTests();
  vi.unstubAllGlobals();
});

describe("probeSession — inconclusive results never demand a signature", () => {
  it("network error → server-unavailable, session-expired NOT latched", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const v = await probeSession();
    expect(v.kind).toBe("server-unavailable");
    if (v.kind === "server-unavailable") expect(v.detail).toBe("network");
    expect(isSessionExpired()).toBe(false);
  });

  it("probe timeout → server-unavailable('timeout'), NOT treated as missing UMK", async () => {
    const err = new Error("The operation timed out");
    err.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(err);
    const v = await probeSession();
    expect(v.kind).toBe("server-unavailable");
    if (v.kind === "server-unavailable") expect(v.detail).toBe("timeout");
    expect(isSessionExpired()).toBe(false);
  });

  it("5xx → server-unavailable, session-expired NOT latched", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "pool wedged" }));
    const v = await probeSession();
    expect(v.kind).toBe("server-unavailable");
    if (v.kind === "server-unavailable") expect(v.detail).toBe("http-503");
    expect(isSessionExpired()).toBe(false);
  });

  it("no active wallet → no-wallet verdict, zero network calls", async () => {
    setActiveWalletAddress(null);
    const v = await probeSession();
    expect(v.kind).toBe("no-wallet");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("probeSession — authoritative answers", () => {
  it("401 → signature-required(cookie-invalid) and latches", async () => {
    fetchMock.mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    const v = await probeSession();
    expect(v).toMatchObject({ kind: "signature-required", reason: "cookie-invalid" });
    expect(isSessionExpired()).toBe(true);
  });

  it("403 → signature-required(wallet-mismatch) and latches", async () => {
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    const v = await probeSession();
    expect(v).toMatchObject({ kind: "signature-required", reason: "wallet-mismatch" });
    expect(isSessionExpired()).toBe(true);
  });

  it("200 + hasSession:false → signature-required(umk-missing) and latches", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { hasSession: false, bootId: "boot-7" }));
    const v = await probeSession();
    expect(v).toMatchObject({ kind: "signature-required", reason: "umk-missing" });
    expect(isSessionExpired()).toBe(true);
    expect(getLastKnownBootId()).toBe("boot-7");
  });

  it("200 + hasSession:true → valid, clears the latch, fires recovery listeners", async () => {
    reportCoreAuthFailure();
    expect(isSessionExpired()).toBe(true);
    const recovered = vi.fn();
    registerRecoveryListener(recovered);

    fetchMock.mockResolvedValueOnce(
      jsonRes(200, { hasSession: true, restored: true, bootId: "boot-9" }),
    );
    const v = await probeSession();
    expect(v).toMatchObject({ kind: "valid", restored: true, bootId: "boot-9" });
    expect(isSessionExpired()).toBe(false);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(getLastKnownBootId()).toBe("boot-9");
  });
});

describe("probeSession — flight discipline", () => {
  it("single-flight: two concurrent probes share ONE request", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    const p1 = probeSession();
    const p2 = probeSession();
    release(jsonRes(200, { hasSession: true }));
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(v1.kind).toBe("valid");
    expect(v2.kind).toBe("valid");
  });

  it("wallet switch mid-flight discards the verdict (no cross-wallet latch)", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (release = r)));
    const p = probeSession();
    setActiveWalletAddress("WaLLetOther2222222222222222222222222222222");
    // Would have latched umk-missing had it not been discarded.
    release(jsonRes(200, { hasSession: false }));
    const v = await p;
    expect(v.kind).toBe("no-wallet");
    expect(isSessionExpired()).toBe(false);
  });
});

describe("coreFetch arbiter — evidence, not verdict", () => {
  it("a stray core 401 records evidence, does NOT latch, and one probe settles it as valid", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes("/api/auth/session")) {
        return jsonRes(200, { hasSession: true, bootId: "boot-1" });
      }
      return new Response("unauthorized", { status: 401 });
    });

    const res = await coreFetch("/api/trading-bots", {
      headers: { "x-wallet-address": WALLET },
    });
    expect(res.status).toBe(401);
    // Evidence recorded, banner NOT latched by the stray 401 itself.
    expect(isSessionExpired()).toBe(false);
    const ev = getAuthRejectionEvidence();
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      endpoint: "/api/trading-bots",
      status: 401,
      requestWallet: WALLET,
      walletMatch: true,
    });

    // The arbiter fired ONE authoritative probe; valid → still no latch.
    await vi.waitFor(() => {
      expect(getLastSessionVerdict()?.kind).toBe("valid");
    });
    expect(isSessionExpired()).toBe(false);
    const probeCalls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/auth/session"),
    );
    expect(probeCalls).toHaveLength(1);
  });

  it("a genuinely dead session still latches: 401 evidence → probe 401 → signature-required", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await coreFetch("/api/trading-bots", { headers: { "x-wallet-address": WALLET } });
    await vi.waitFor(() => {
      expect(isSessionExpired()).toBe(true);
    });
    expect(getLastSessionVerdict()).toMatchObject({
      kind: "signature-required",
      reason: "cookie-invalid",
    });
  });

  it("a 401 stamped with a STALE wallet is discarded — no probe, no latch", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await coreFetch("/api/trading-bots", {
      headers: { "x-wallet-address": "WaLLetStale3333333333333333333333333333333" },
    });
    await new Promise((r) => setTimeout(r, 25));
    // Only the core read itself hit the network — no /api/auth/session probe.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isSessionExpired()).toBe(false);
    const ev = getAuthRejectionEvidence();
    expect(ev).toHaveLength(1);
    expect(ev[0].walletMatch).toBe(false);
  });

  it("evidence buffer is capped", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    for (let i = 0; i < 25; i++) {
      await coreFetch(`/api/read-${i}`, {
        headers: { "x-wallet-address": "WaLLetStale3333333333333333333333333333333" },
      });
    }
    expect(getAuthRejectionEvidence().length).toBeLessThanOrEqual(20);
  });
});

describe("auto-recovery — no permanent one-attempt deadlock", () => {
  it("after server-unavailable, a health recovery edge re-probes to valid without user action", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "mid-deploy" }));
    const verdicts: string[] = [];
    onSessionVerdict((v) => verdicts.push(v.kind));

    const v1 = await probeSession();
    expect(v1.kind).toBe("server-unavailable");

    // Server comes back; some OTHER core read recovers the health store.
    fetchMock.mockResolvedValue(jsonRes(200, { hasSession: true }));
    reportCoreReadFailure();
    reportCoreReadFailure(); // degraded latched
    reportCoreReadSuccess(); // degraded→healthy edge fires recovery listeners

    await vi.waitFor(() => {
      expect(getLastSessionVerdict()?.kind).toBe("valid");
    });
    expect(verdicts).toEqual(["server-unavailable", "valid"]);
    expect(isSessionExpired()).toBe(false);
  });

  it("an authoritative verdict is settled — recovery edges do NOT re-probe it", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { hasSession: true }));
    await probeSession();
    fetchMock.mockClear();

    reportCoreReadFailure();
    reportCoreReadFailure();
    reportCoreReadSuccess();
    await new Promise((r) => setTimeout(r, 25));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

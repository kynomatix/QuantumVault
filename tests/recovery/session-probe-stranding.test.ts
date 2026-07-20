// 2026-07-20 recurrence — stranding-hole regression tests.
//
// The stuck-dashboard incident kept recurring because two paths could
// permanently disarm the session-probe's auto-recovery while the server was
// mid-deploy AND the mobile wallet adapter transiently dropped the public key
// (which it does on every app switch / page restore):
//
//   1. A 'no-wallet' emission OVERWROTE a settled 'server-unavailable'
//      verdict. Every auto-reprobe hook (backoff, online, focus, recovery
//      edge) is gated on lastVerdict === 'server-unavailable', so the open
//      question "is the server back?" was silently forgotten — recovery
//      never ran again until a manual reload.
//   2. A backoff timer that fired DURING the wallet drop consumed itself
//      without rescheduling (maybeReprobe returned early on null wallet),
//      ending the retry chain permanently.
//
// These tests pin the fixes: the server-unavailable verdict survives a
// transient wallet drop, and the backoff chain keeps rescheduling through it.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  probeSession,
  onSessionVerdict,
  getLastSessionVerdict,
  __resetSessionProbeForTests,
} from "../../client/src/lib/session-probe";
import { __resetServerHealthForTests } from "../../client/src/lib/server-health";
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
  __resetSessionProbeForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("no-wallet must not overwrite server-unavailable", () => {
  it("a transient wallet drop keeps the server-unavailable verdict (reprobe hooks stay armed)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "mid-deploy" }));
    const v1 = await probeSession();
    expect(v1.kind).toBe("server-unavailable");

    // Mobile MWA drops the key; a probe during the drop answers no-wallet.
    setActiveWalletAddress(null);
    const v2 = await probeSession();
    expect(v2.kind).toBe("no-wallet"); // callers still see the truthful answer

    // ...but the SETTLED verdict — the reprobe-hook gate — is not forgotten.
    expect(getLastSessionVerdict()?.kind).toBe("server-unavailable");
  });

  it("no-wallet still overwrites authoritative verdicts (only server-unavailable is protected)", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { hasSession: true }));
    await probeSession();
    expect(getLastSessionVerdict()?.kind).toBe("valid");

    setActiveWalletAddress(null);
    await probeSession();
    // A settled 'valid' has no pending question to protect; no-wallet lands.
    expect(getLastSessionVerdict()?.kind).toBe("no-wallet");
  });

  it("listeners still receive the no-wallet emission even when the verdict is preserved", async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "mid-deploy" }));
    await probeSession();

    const seen: string[] = [];
    onSessionVerdict((v) => seen.push(v.kind));
    setActiveWalletAddress(null);
    await probeSession();
    expect(seen).toEqual(["no-wallet"]);
    expect(getLastSessionVerdict()?.kind).toBe("server-unavailable");
  });
});

describe("backoff retry chain survives a wallet drop", () => {
  it("a backoff tick during the drop reschedules; the next tick after reconnect probes to valid", async () => {
    vi.useFakeTimers();

    // 1. Server mid-deploy: probe settles server-unavailable, arms backoff (5s).
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "mid-deploy" }));
    const v1 = await probeSession();
    expect(v1.kind).toBe("server-unavailable");
    const probeCallsAfterFirst = fetchMock.mock.calls.length;

    // 2. Wallet drops (MWA app switch). The 5s backoff timer fires during the
    //    drop — before the fix, this consumed the chain permanently.
    setActiveWalletAddress(null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock.mock.calls.length).toBe(probeCallsAfterFirst); // no probe without a wallet

    // 3. Wallet reconnects; server is back. The RESCHEDULED tick (next backoff
    //    step is 10s) must fire and settle the session — no user action.
    setActiveWalletAddress(WALLET);
    fetchMock.mockResolvedValue(jsonRes(200, { hasSession: true }));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(probeCallsAfterFirst);
    expect(getLastSessionVerdict()?.kind).toBe("valid");
  });

  it("the chain keeps rescheduling across MULTIPLE ticks while the wallet stays absent", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonRes(503, { error: "mid-deploy" }));
    await probeSession();
    setActiveWalletAddress(null);

    // Ride out several backoff steps (5s → 10s → 20s → 40s) with no wallet.
    await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000);

    // Reconnect: the chain must STILL be alive (capped at 60s steps).
    setActiveWalletAddress(WALLET);
    fetchMock.mockResolvedValue(jsonRes(200, { hasSession: true }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getLastSessionVerdict()?.kind).toBe("valid");
  });
});

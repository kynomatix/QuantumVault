// Direct tests for the Flash landing-confirmation poll (flash-confirm.ts) —
// the corrective for the 7d116026 HOLD: the original loop had no per-RPC
// timeout and no absolute deadline, so a never-settling getSignatureStatuses
// call (observed in prod — AbortSignal.timeout did not fire) could hold a
// webhook/close request far past the ~60s proxy reap. These tests pin:
//   1. verdict correctness (confirmed / finalized / reverted / unconfirmed)
//   2. the HARD wall-clock deadline, including under a hung RPC
//   3. transient RPC errors keep polling, never become a verdict
//   4. retry-classification hard exclusion of the unconfirmed verdict —
//      including the base58-signature-contains-"429" collision that would
//      otherwise classify it rate-limit-retryable and double-open.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  confirmTxLanded,
  CONFIRM_WINDOW_MS,
  CONFIRM_RPC_TIMEOUT_MS,
  type SignatureStatusReader,
} from "../../server/protocol/flash/flash-confirm";
import {
  UNCONFIRMED_LANDING_VERDICT_TOKEN,
  isUnconfirmedLandingVerdict,
} from "../../server/protocol/tx-verdicts";
import {
  isRateLimitError,
  isTransientError,
  isTimeoutError,
} from "../../server/trade-retry-service";

const SIG = "5KtP9vXm2QwRz7Yb3cD8eF4gH6jL1nA5sT9uV3wX7yZ2bC4dE6fG8hJ";

function statusValue(v: unknown) {
  return { context: { slot: 1 }, value: [v] } as never;
}

function reader(impl: (...args: unknown[]) => Promise<unknown>): SignatureStatusReader {
  return { getSignatureStatuses: vi.fn(impl) } as unknown as SignatureStatusReader;
}

beforeEach(() => {
  vi.useFakeTimers(); // fakes Date.now too — deadline math runs on the fake clock
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("confirmTxLanded — verdicts", () => {
  it("confirmed on first poll → ok", async () => {
    const conn = reader(async () => statusValue({ confirmationStatus: "confirmed", err: null }));
    const r = await confirmTxLanded(conn, SIG, "open");
    expect(r).toEqual({ ok: true });
    expect(conn.getSignatureStatuses).toHaveBeenCalledWith([SIG], { searchTransactionHistory: true });
  });

  it("finalized → ok", async () => {
    const conn = reader(async () => statusValue({ confirmationStatus: "finalized", err: null }));
    const r = await confirmTxLanded(conn, SIG, "open");
    expect(r).toEqual({ ok: true });
  });

  it("on-chain err → DEFINITIVE revert (unconfirmed:false, no verdict token)", async () => {
    const conn = reader(async () =>
      statusValue({ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }),
    );
    const r = await confirmTxLanded(conn, SIG, "open");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.unconfirmed).toBe(false);
      expect(r.error).toContain("reverted on-chain");
      expect(isUnconfirmedLandingVerdict(r.error)).toBe(false);
    }
  });

  it("persistent null status → UNCONFIRMED verdict at the window, token attached", async () => {
    const conn = reader(async () => statusValue(null));
    const p = confirmTxLanded(conn, SIG, "open");
    await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS + 100);
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.unconfirmed).toBe(true);
      expect(r.error).toContain("did not confirm on-chain within the verification window");
      expect(r.error).toContain(UNCONFIRMED_LANDING_VERDICT_TOKEN);
      expect(isUnconfirmedLandingVerdict(r.error)).toBe(true);
    }
  });

  it("transient RPC errors then confirmed → ok (errors are never a verdict)", async () => {
    let calls = 0;
    const conn = reader(async () => {
      calls += 1;
      if (calls <= 2) throw new Error("fetch failed: ECONNRESET");
      return statusValue({ confirmationStatus: "confirmed", err: null });
    });
    const p = confirmTxLanded(conn, SIG, "open");
    await vi.advanceTimersByTimeAsync(10_000);
    const r = await p;
    expect(r).toEqual({ ok: true });
    expect(calls).toBe(3);
  });
});

describe("confirmTxLanded — hard wall-clock deadline", () => {
  it("NEVER-SETTLING RPC: per-call hard timeout keeps polling; total bounded by the window", async () => {
    // The exact prod failure mode: the RPC promise neither resolves nor rejects.
    const conn = reader(() => new Promise(() => {}) as Promise<unknown>);
    const started = Date.now();
    let settled = false;
    const p = confirmTxLanded(conn, SIG, "open").then((r) => {
      settled = true;
      return r;
    });

    // Not settled before the window…
    await vi.advanceTimersByTimeAsync(CONFIRM_WINDOW_MS - 1_000);
    expect(settled).toBe(false);

    // …but settles once the window elapses, with the unconfirmed verdict.
    await vi.advanceTimersByTimeAsync(2_000);
    const r = await p;
    expect(settled).toBe(true);
    expect(Date.now() - started).toBeLessThanOrEqual(CONFIRM_WINDOW_MS + 2_000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unconfirmed).toBe(true);
    // Multiple polls happened (hung calls were individually timed out, not waited on forever).
    expect((conn.getSignatureStatuses as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it("hung RPC per-call cap is clamped to the remaining budget near the deadline", async () => {
    // windowMs smaller than the per-call cap: the single call must be cut at the
    // window, not at CONFIRM_RPC_TIMEOUT_MS.
    const conn = reader(() => new Promise(() => {}) as Promise<unknown>);
    const windowMs = Math.floor(CONFIRM_RPC_TIMEOUT_MS / 2);
    let settled = false;
    const p = confirmTxLanded(conn, SIG, "open", { windowMs }).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(windowMs + 100);
    const r = await p;
    expect(settled).toBe(true);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.unconfirmed).toBe(true);
  });

  it("late rejection from an abandoned (timed-out) RPC call does not unhandled-reject", async () => {
    let rejectLate: ((e: Error) => void) | undefined;
    let calls = 0;
    const conn = reader(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise((_res, rej) => { rejectLate = rej; }) as Promise<unknown>;
      }
      return Promise.resolve(statusValue({ confirmationStatus: "confirmed", err: null }));
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const p = confirmTxLanded(conn, SIG, "open");
      // Let the first call hard-timeout, then the second call confirms.
      await vi.advanceTimersByTimeAsync(CONFIRM_RPC_TIMEOUT_MS + 2_000);
      const r = await p;
      expect(r).toEqual({ ok: true });
      // Now the abandoned first call rejects late — must be swallowed.
      rejectLate?.(new Error("late socket error"));
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("unconfirmed verdict — retry classification hard exclusion", () => {
  function unconfirmedMessage(sig: string): string {
    return (
      `open transaction did not confirm on-chain within the verification window (sig ${sig}). ` +
      `Not booked as filled — verify on the exchange before retrying (a late landing is reconciled automatically). ` +
      UNCONFIRMED_LANDING_VERDICT_TOKEN
    );
  }

  it("is NEVER transient / rate-limited / timeout-retryable", () => {
    const msg = unconfirmedMessage(SIG);
    expect(isTransientError(msg)).toBe(false);
    expect(isRateLimitError(msg)).toBe(false);
    expect(isTimeoutError(msg)).toBe(false);
  });

  it("survives the base58 '429'-in-signature collision (would otherwise classify rate-limit)", () => {
    // A base58 signature can legitimately contain "429". Without the hard
    // exclusion, isRateLimitError('...429...') → true → auto-retry of a tx
    // that may still land → double-open.
    const collisionSig = "3xY429AbCdEfGhJkLmNpQrStUvWxYz1234567890BcDeFgHiJkLmNoP";
    const msg = unconfirmedMessage(collisionSig);
    expect(msg).toContain("429");
    expect(isRateLimitError(msg)).toBe(false);
    expect(isTransientError(msg)).toBe(false);
  });

  it("Error instances are matched, not just strings", () => {
    expect(isTransientError(new Error(unconfirmedMessage(SIG)))).toBe(false);
    expect(isUnconfirmedLandingVerdict(new Error(unconfirmedMessage(SIG)))).toBe(true);
  });

  it("ordinary retryable errors still classify (guard is narrow)", () => {
    expect(isRateLimitError("429 too many requests")).toBe(true);
    expect(isTransientError("oracle not found")).toBe(true);
    expect(isTimeoutError("request timed out")).toBe(true);
  });
});

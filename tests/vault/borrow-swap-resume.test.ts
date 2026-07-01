import { describe, it, expect } from "vitest";
import { decideSwapResume } from "../../server/vault/borrow-engine-core";

// ---------------------------------------------------------------------------
// Crash/resume reconciliation for the (non-amount-exact) SWAP leg of the per-bot
// collateral top-up. The cardinal rule: NEVER re-broadcast a swap that may have
// landed (double-swap spends the source twice). The only safe re-swap is a sig
// PROVEN dead (reverted/expired) or no sig at all.
// ---------------------------------------------------------------------------
describe("decideSwapResume", () => {
  it("swaps when no signature was ever recorded (nothing broadcast)", () => {
    expect(decideSwapResume({ recordedSig: null }).action).toBe("execute_swap");
    expect(decideSwapResume({ recordedSig: undefined }).action).toBe("execute_swap");
    expect(decideSwapResume({ recordedSig: "" }).action).toBe("execute_swap");
  });

  it("STOPS (in-flight) when a recorded swap is still settling — never re-swap", () => {
    expect(decideSwapResume({ recordedSig: "sig1", status: "in_flight" }).action).toBe("stop_in_flight");
  });

  it("STOPS (in-flight) when a recorded swap has no resolvable status — never assume dropped", () => {
    expect(decideSwapResume({ recordedSig: "sig1", status: null }).action).toBe("stop_in_flight");
    expect(decideSwapResume({ recordedSig: "sig1" }).action).toBe("stop_in_flight");
  });

  it("re-swaps only when the recorded swap is PROVEN dead (reverted/expired)", () => {
    expect(decideSwapResume({ recordedSig: "sig1", status: "reverted" }).action).toBe("retry_swap");
    expect(decideSwapResume({ recordedSig: "sig1", status: "expired" }).action).toBe("retry_swap");
  });

  it("credits the realized delta when a landed swap is provable", () => {
    const d = decideSwapResume({
      recordedSig: "sig1",
      status: "landed",
      swapOutBeforeRaw: "1000",
      currentOutBalanceRaw: 1_500n,
    });
    expect(d.action).toBe("use_realized");
    expect(d.action === "use_realized" && d.realizedRaw).toBe(500n);
  });

  it("accepts a bigint baseline", () => {
    const d = decideSwapResume({
      recordedSig: "sig1",
      status: "landed",
      swapOutBeforeRaw: 200n,
      currentOutBalanceRaw: 950n,
    });
    expect(d.action === "use_realized" && d.realizedRaw).toBe(750n);
  });

  it("STOPS (needs attention) when a landed swap's output is unreadable — never re-swap", () => {
    expect(
      decideSwapResume({ recordedSig: "sig1", status: "landed", swapOutBeforeRaw: "1000", currentOutBalanceRaw: null }).action,
    ).toBe("stop_needs_attention");
    expect(
      decideSwapResume({ recordedSig: "sig1", status: "landed", swapOutBeforeRaw: null, currentOutBalanceRaw: 1_500n }).action,
    ).toBe("stop_needs_attention");
  });

  it("STOPS (needs attention) when a landed swap shows no positive output delta", () => {
    expect(
      decideSwapResume({ recordedSig: "sig1", status: "landed", swapOutBeforeRaw: "1500", currentOutBalanceRaw: 1_500n }).action,
    ).toBe("stop_needs_attention");
    expect(
      decideSwapResume({ recordedSig: "sig1", status: "landed", swapOutBeforeRaw: "2000", currentOutBalanceRaw: 1_500n }).action,
    ).toBe("stop_needs_attention");
  });

  it("STOPS (needs attention) on an unparseable baseline rather than guessing", () => {
    expect(
      decideSwapResume({ recordedSig: "sig1", status: "landed", swapOutBeforeRaw: "not-a-number", currentOutBalanceRaw: 1_500n }).action,
    ).toBe("stop_needs_attention");
  });
});

import { describe, it, expect } from "vitest";
import {
  classifyMarketDiscriminator,
  buildBuyPtArgs,
  decideUnwindResume,
  MARKET_TWO_DISCRIMINATOR,
  MARKET_THREE_DISCRIMINATOR,
} from "../../server/vault/fixed-yield/fixed-yield-core";

// ---------------------------------------------------------------------------
// The production bug: the deposit/exit paths hardcoded MarketThree.load, but the
// pinned ONyc market is a MarketTwo account → "Invalid account discriminator" on
// the buy leg AFTER the USDC→ONyc swap → the op looped forever with funds stuck
// as ONyc. The fix dispatches on the on-chain 8-byte account discriminator.
// ---------------------------------------------------------------------------
describe("classifyMarketDiscriminator", () => {
  it("identifies a MarketTwo account (the pinned ONyc market's class)", () => {
    const data = new Uint8Array([...MARKET_TWO_DISCRIMINATOR, 9, 9, 9]);
    expect(classifyMarketDiscriminator(data)).toBe("two");
  });

  it("identifies a MarketThree account", () => {
    const data = new Uint8Array([...MARKET_THREE_DISCRIMINATOR, 1, 2, 3, 4]);
    expect(classifyMarketDiscriminator(data)).toBe("three");
  });

  it("classifies the EXACT 8-byte discriminator with no trailing data", () => {
    expect(classifyMarketDiscriminator(MARKET_TWO_DISCRIMINATOR)).toBe("two");
    expect(classifyMarketDiscriminator(MARKET_THREE_DISCRIMINATOR)).toBe("three");
  });

  it("accepts a Buffer (getAccountInfo returns Buffer data)", () => {
    const buf = Buffer.from([...MARKET_TWO_DISCRIMINATOR, 0, 0]);
    expect(classifyMarketDiscriminator(buf)).toBe("two");
  });

  it("returns 'unsupported' for a found account of an unknown type (permanent)", () => {
    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(classifyMarketDiscriminator(data)).toBe("unsupported");
  });

  it("returns 'unsupported' for missing / too-short data (never mis-classifies)", () => {
    expect(classifyMarketDiscriminator(null)).toBe("unsupported");
    expect(classifyMarketDiscriminator(undefined)).toBe("unsupported");
    expect(classifyMarketDiscriminator(new Uint8Array([212, 4, 132]))).toBe("unsupported");
  });

  it("does NOT match when only the first bytes overlap but the tail differs", () => {
    const almostTwo = new Uint8Array([212, 4, 132, 126, 169, 121, 121, 99]); // last byte off
    expect(classifyMarketDiscriminator(almostTwo)).toBe("unsupported");
  });
});

describe("buildBuyPtArgs", () => {
  it("MarketThree → exact INPUT: spend baseIn, floor the fill with minPtOut", () => {
    const args = buildBuyPtArgs({ kind: "three", targetPtRaw: 950n, baseInRaw: 1000n });
    expect(args).toEqual({ baseIn: 1000n, minPtOut: 950n });
  });

  it("MarketTwo → exact OUTPUT: ask for ptOut, cap spend with maxBaseIn", () => {
    const args = buildBuyPtArgs({ kind: "two", targetPtRaw: 950n, baseInRaw: 1000n });
    expect(args).toEqual({ ptOut: 950n, maxBaseIn: 1000n });
  });

  it("never lets the buy spend more underlying than we hold (maxBaseIn == baseIn)", () => {
    const args = buildBuyPtArgs({ kind: "two", targetPtRaw: 1n, baseInRaw: 42n }) as { maxBaseIn: bigint };
    expect(args.maxBaseIn).toBe(42n);
  });
});

// ---------------------------------------------------------------------------
// Unwind (stranded-deposit escape hatch): ONyc → USDC. Same cardinal rule as the
// forward swap — NEVER re-broadcast a swap that may have landed (an in-flight
// ONyc balance reads unchanged, so a balance-only check would double-swap into
// the shared Earn park position).
// ---------------------------------------------------------------------------
describe("decideUnwindResume", () => {
  it("swaps when no signature was ever recorded (first attempt)", () => {
    expect(decideUnwindResume({ recordedSig: null }).action).toBe("swap");
    expect(decideUnwindResume({ recordedSig: undefined }).action).toBe("swap");
    expect(decideUnwindResume({ recordedSig: "" }).action).toBe("swap");
  });

  it("finalizes (funds already back) when the unwind swap landed", () => {
    expect(decideUnwindResume({ recordedSig: "sig1", status: "landed" }).action).toBe("finalize_failed");
  });

  it("re-swaps only when the recorded swap is a CONFIRMED revert", () => {
    expect(decideUnwindResume({ recordedSig: "sig1", status: "reverted" }).action).toBe("retry_swap");
  });

  it("STOPS in-flight when the outcome is unknown and the blockhash window is still open", () => {
    expect(
      decideUnwindResume({ recordedSig: "sig1", status: "in_flight", lastValidBlockHeight: 1000, currentBlockHeight: 1005 }).action,
    ).toBe("stop_in_flight");
    // not-found (null) is also "unknown" — never assume dropped
    expect(
      decideUnwindResume({ recordedSig: "sig1", status: null, lastValidBlockHeight: 1000, currentBlockHeight: 1000 }).action,
    ).toBe("stop_in_flight");
  });

  it("STOPS in-flight when the current height can't be read (never guess expiry)", () => {
    expect(
      decideUnwindResume({ recordedSig: "sig1", status: "in_flight", lastValidBlockHeight: 1000, currentBlockHeight: null }).action,
    ).toBe("stop_in_flight");
  });

  it("re-swaps once the blockhash window is demonstrably over (proven dead)", () => {
    expect(
      decideUnwindResume({ recordedSig: "sig1", status: "in_flight", lastValidBlockHeight: 1000, currentBlockHeight: 1031 }).action,
    ).toBe("retry_swap");
  });

  it("requires a real lastValidBlockHeight before declaring expiry", () => {
    // Without a recorded lvbh we can't prove the tx is dead → wait, don't re-swap.
    expect(
      decideUnwindResume({ recordedSig: "sig1", status: "in_flight", lastValidBlockHeight: 0, currentBlockHeight: 9_999_999 }).action,
    ).toBe("stop_in_flight");
  });
});

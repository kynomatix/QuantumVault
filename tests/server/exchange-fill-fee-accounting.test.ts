import { describe, expect, it } from "vitest";
import {
  classifyCloseFeeEvidence,
  closeFeeAmount,
  closeFeePersistence,
} from "../../server/trading/signal-bot-close-integrity";

const quote = {
  availability: "available" as const,
  protocol: "pacifica",
  account: "account-1",
  subaccountId: null,
  liquidityRole: "taker" as const,
  baseRate: 0.0004,
  effectiveRate: 0.0004,
  provenance: "pacifica:/account:taker_fee",
  observedAt: 1_700_000_000_000,
  builder: { status: "absent" as const },
};

describe("close fee evidence", () => {
  it("preserves a Pacifica exact zero instead of falling through to an estimate", () => {
    const evidence = classifyCloseFeeEvidence({
      protocol: "pacifica",
      venueFee: 0,
      notional: 1_000,
      rateQuote: quote,
    });

    expect(evidence).toEqual({ kind: "venue_exact", amount: 0, protocol: "pacifica" });
    expect(closeFeeAmount(evidence)).toBe(0);
    expect(closeFeePersistence(evidence, 12)).toMatchObject({
      fee: "0",
      pnl: "12",
      feeDelta: 0,
      pnlDelta: 12,
    });
  });

  it("labels a validated quote fallback and retains its provenance", () => {
    expect(classifyCloseFeeEvidence({
      protocol: "pacifica",
      venueFee: undefined,
      notional: 2_000,
      rateQuote: quote,
    })).toEqual({
      kind: "rate_estimate",
      amount: 0.8,
      notional: 2_000,
      rate: 0.0004,
      protocol: "pacifica",
      provenance: "pacifica:/account:taker_fee",
      observedAt: 1_700_000_000_000,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    "never calls an invalid venue fee exact (%s)",
    venueFee => {
      const evidence = classifyCloseFeeEvidence({
        protocol: "pacifica",
        venueFee,
        notional: 100,
        rateQuote: { availability: "unavailable", reason: "read_failed" },
      });
      expect(evidence).toEqual({ kind: "unavailable", reason: "invalid_venue_fee" });
      expect(closeFeeAmount(evidence)).toBeNull();
    },
  );

  it("does not call another adapter's numeric result exact", () => {
    expect(classifyCloseFeeEvidence({
      protocol: "drift",
      venueFee: 0.45,
      notional: 1_000,
    })).toEqual({
      kind: "unavailable",
      reason: "unproven_exact_fee_semantics:drift",
    });
  });

  it("persists unavailable fee and PnL as explicit null while using zero only for aggregate deltas", () => {
    const evidence = { kind: "unavailable", reason: "fee_rate_builder_rate_unknown" } as const;
    const fields = closeFeePersistence(evidence, null);
    expect(fields).toEqual({
      fee: null,
      pnl: null,
      feeDelta: 0,
      pnlDelta: 0,
      feeEvidence: evidence,
    });

    // Simulate the JSON/DB boundary: both keys remain explicitly present and
    // null; they can never trigger bot_trades' DEFAULT 0 via omission.
    const reread = JSON.parse(JSON.stringify(fields));
    expect(Object.hasOwn(reread, "fee")).toBe(true);
    expect(Object.hasOwn(reread, "pnl")).toBe(true);
    expect(reread.fee).toBeNull();
    expect(reread.pnl).toBeNull();
  });
});

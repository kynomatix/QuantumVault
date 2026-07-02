import { describe, it, expect } from "vitest";
import {
  planBorrowOpen,
  planBorrowClose,
  verifyOpenOutcome,
  verifyCloseOutcome,
  withinToleranceBps,
  absDiff,
  hasSufficientRepayBalance,
  capPositiveCollateralDeposit,
  resolveRepaidHistoryRaw,
  DEFAULT_DEBT_DUST_RAW,
  positionScaleDecimals,
  positionRawToNativeRaw,
  EXCHANGE_PRICE_PRECISION,
  isSaneVaultExchangePrice,
  scaleByExchangePrice,
  parseExchangePricesReturn,
} from "../../server/vault/borrow-engine-core";

describe("borrow-engine-core: plan builders", () => {
  it("planBorrowOpen mints a fresh position and deposits+borrows exactly", () => {
    const plan = planBorrowOpen({ collateralRaw: 1_000_000_000n, debtRaw: 50_000_000n });
    expect(plan.positionId).toBe(0); // 0 => SDK mints the position NFT
    expect(plan.colAmount).toEqual({ kind: "exact", raw: 1_000_000_000n });
    expect(plan.debtAmount).toEqual({ kind: "exact", raw: 50_000_000n });
  });

  it("planBorrowOpen refuses non-positive amounts", () => {
    expect(() => planBorrowOpen({ collateralRaw: 0n, debtRaw: 1n })).toThrow();
    expect(() => planBorrowOpen({ collateralRaw: 1n, debtRaw: 0n })).toThrow();
    expect(() => planBorrowOpen({ collateralRaw: -1n, debtRaw: 1n })).toThrow();
  });

  it("planBorrowClose repays ALL and withdraws ALL for a real position", () => {
    const plan = planBorrowClose(42);
    expect(plan.positionId).toBe(42);
    expect(plan.colAmount).toEqual({ kind: "max" });
    expect(plan.debtAmount).toEqual({ kind: "max" });
  });

  it("planBorrowClose refuses a missing/placeholder positionId", () => {
    expect(() => planBorrowClose(0)).toThrow();
    expect(() => planBorrowClose(-1)).toThrow();
    expect(() => planBorrowClose(1.5)).toThrow();
  });
});

describe("borrow-engine-core: tolerance math", () => {
  it("absDiff is order-independent", () => {
    expect(absDiff(5n, 8n)).toBe(3n);
    expect(absDiff(8n, 5n)).toBe(3n);
    expect(absDiff(7n, 7n)).toBe(0n);
  });

  it("withinToleranceBps honors the band and handles zero expected", () => {
    // 0.5% of 1_000_000 = 5_000
    expect(withinToleranceBps(1_004_000n, 1_000_000n, 50)).toBe(true);
    expect(withinToleranceBps(1_006_000n, 1_000_000n, 50)).toBe(false);
    expect(withinToleranceBps(0n, 0n, 50)).toBe(true);
    expect(withinToleranceBps(1n, 0n, 50)).toBe(false);
    expect(withinToleranceBps(5n, 5n, -1)).toBe(false); // invalid tolerance => false
  });
});

describe("borrow-engine-core: verifyOpenOutcome", () => {
  const base = {
    requestedCollateralRaw: 1_000_000_000n,
    requestedDebtRaw: 50_000_000n,
    usdcDeltaRaw: 50_000_000n,
    observedColRaw: 1_000_000_000n,
    observedDebtRaw: 50_000_000n,
  };

  it("passes when reality matches the request", () => {
    expect(verifyOpenOutcome(base)).toEqual({ ok: true });
  });

  it("fails closed when no USDC was received (no money landed)", () => {
    expect(verifyOpenOutcome({ ...base, usdcDeltaRaw: 0n }).ok).toBe(false);
  });

  it("fails when debt materially exceeds the request", () => {
    const r = verifyOpenOutcome({ ...base, observedDebtRaw: 60_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("debt_exceeds_requested");
  });

  it("tolerates tiny tick-rounding / interest within the band", () => {
    expect(verifyOpenOutcome({ ...base, observedDebtRaw: 50_010_000n }).ok).toBe(true); // +0.02%
  });

  it("flags a collateral mismatch", () => {
    expect(verifyOpenOutcome({ ...base, observedColRaw: 900_000_000n }).reason).toBe("collateral_mismatch");
  });

  it("flags a received-usdc mismatch", () => {
    expect(verifyOpenOutcome({ ...base, usdcDeltaRaw: 40_000_000n }).reason).toBe("received_usdc_mismatch");
  });
});

describe("borrow-engine-core: verifyCloseOutcome", () => {
  it("passes when debt is cleared and collateral returned", () => {
    expect(verifyCloseOutcome({ observedDebtRaw: 0n, collateralDeltaRaw: 1_000_000_000n })).toEqual({ ok: true });
  });

  it("tolerates sub-dust residual debt", () => {
    expect(verifyCloseOutcome({ observedDebtRaw: DEFAULT_DEBT_DUST_RAW, collateralDeltaRaw: 1n }).ok).toBe(true);
  });

  it("fails when debt is not cleared", () => {
    const r = verifyCloseOutcome({ observedDebtRaw: 1_000_000n, collateralDeltaRaw: 1_000_000_000n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("debt_not_cleared");
  });

  it("fails closed when no collateral came back", () => {
    const r = verifyCloseOutcome({ observedDebtRaw: 0n, collateralDeltaRaw: 0n });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_collateral_returned");
  });
});

describe("borrow-engine-core: hasSufficientRepayBalance", () => {
  it("requires balance >= debt + buffer", () => {
    expect(hasSufficientRepayBalance(50_000_000n, 50_000_000n)).toBe(true);
    expect(hasSufficientRepayBalance(49_999_999n, 50_000_000n)).toBe(false);
    expect(hasSufficientRepayBalance(50_500_000n, 50_000_000n, 1_000_000n)).toBe(false);
    expect(hasSufficientRepayBalance(51_000_000n, 50_000_000n, 1_000_000n)).toBe(true);
  });
});

describe("borrow-engine-core: capPositiveCollateralDeposit", () => {
  it("caps an exact-balance deposit one raw unit below the held balance (the Fluid round-up bug)", () => {
    // The live-reproduced boundary: 0.1 INF held = 100000000 raw -> deposit 99999999.
    expect(capPositiveCollateralDeposit(100_000_000n, 100_000_000n)).toBe(99_999_999n);
  });

  it("never deposits more than requested when the wallet holds extra", () => {
    // Requested < held-1 -> pass the request through untouched (no hidden buffer pull).
    expect(capPositiveCollateralDeposit(100_000_000n, 200_000_000n)).toBe(100_000_000n);
    expect(capPositiveCollateralDeposit(1n, 100_000_000n)).toBe(1n);
  });

  it("caps at held-1 only when the request meets or exceeds the held balance", () => {
    expect(capPositiveCollateralDeposit(200_000_000n, 100_000_000n)).toBe(99_999_999n);
    expect(capPositiveCollateralDeposit(99_999_999n, 100_000_000n)).toBe(99_999_999n);
  });

  it("returns 0n (caller must reject) when nothing can safely be deposited", () => {
    expect(capPositiveCollateralDeposit(0n, 100_000_000n)).toBe(0n);
    expect(capPositiveCollateralDeposit(-5n, 100_000_000n)).toBe(0n);
    expect(capPositiveCollateralDeposit(100_000_000n, 1n)).toBe(0n);
    expect(capPositiveCollateralDeposit(100_000_000n, 0n)).toBe(0n);
  });
});

describe("borrow-engine-core: resolveRepaidHistoryRaw (repay history amount)", () => {
  // The caller has already PROVEN the repay confirmed on-chain; this only picks the
  // amount to record. It must ALWAYS yield a positive figure for a real repay so a
  // confirmed repay never gets skipped from the history/tax feed (the owner's bug).

  it("uses the EXACT observed reduction on a clean verified repay", () => {
    const r = resolveRepaidHistoryRaw({
      preDebtRaw: 4_068_061n,
      observedDebtRaw: 0n,
      repayRaw: 4_068_061n,
      cleanVerified: true,
    });
    expect(r).toEqual({ realizedRepaidRaw: 4_068_061n, exact: true });
  });

  it("REGRESSION: a lagging re-read (delta 0) still emits the row, falling back to the sent amount", () => {
    // The bug: post-repay re-read returned the still-old debt -> observedDelta 0 ->
    // realized used to be 0 -> the equity-event row was SKIPPED. Now it records the
    // proven sent amount, marked inexact ("pending re-read").
    const r = resolveRepaidHistoryRaw({
      preDebtRaw: 4_068_061n,
      observedDebtRaw: 4_068_061n, // stale read shows no reduction
      repayRaw: 4_068_061n, // max repay => sent == live preDebt
      cleanVerified: false,
    });
    expect(r.realizedRepaidRaw).toBe(4_068_061n);
    expect(r.exact).toBe(false);
  });

  it("treats an unreadable re-read (caller passes preDebt) like the lagging case", () => {
    const r = resolveRepaidHistoryRaw({
      preDebtRaw: 10_000_000n,
      observedDebtRaw: 10_000_000n,
      repayRaw: 10_000_000n,
      cleanVerified: false,
    });
    expect(r).toEqual({ realizedRepaidRaw: 10_000_000n, exact: false });
  });

  it("records a real positive partial reduction, marked inexact when verify missed", () => {
    const r = resolveRepaidHistoryRaw({
      preDebtRaw: 10_000_000n,
      observedDebtRaw: 6_000_000n, // 4 USDC came off
      repayRaw: 4_000_000n,
      cleanVerified: false,
    });
    expect(r.realizedRepaidRaw).toBe(4_000_000n);
    expect(r.exact).toBe(false);
  });

  it("CAPS at the sent amount so a noisy read can never over-report principal", () => {
    // A pathological read showing MORE reduction than we sent must not over-report.
    const r = resolveRepaidHistoryRaw({
      preDebtRaw: 10_000_000n,
      observedDebtRaw: 1_000_000n, // claims 9 USDC off
      repayRaw: 4_000_000n, // but we only sent 4
      cleanVerified: false,
    });
    expect(r.realizedRepaidRaw).toBe(4_000_000n);
  });

  it("never returns a negative figure when the read shows MORE debt than before", () => {
    const r = resolveRepaidHistoryRaw({
      preDebtRaw: 4_000_000n,
      observedDebtRaw: 5_000_000n, // debt read grew (stale/interest) -> delta negative
      repayRaw: 4_000_000n,
      cleanVerified: false,
    });
    expect(r.realizedRepaidRaw).toBe(4_000_000n);
    expect(r.exact).toBe(false);
  });
});

describe("borrow-engine-core: SDK position-raw -> native scaling", () => {
  it("positionScaleDecimals is max(decimals, 9)", () => {
    expect(positionScaleDecimals(6)).toBe(9); // USDC -> upscaled to 9 dp
    expect(positionScaleDecimals(9)).toBe(9); // INF -> unchanged
    expect(positionScaleDecimals(0)).toBe(9);
    expect(positionScaleDecimals(18)).toBe(18); // >= 9 dp left native
  });

  it("converts the real bug case: USDC debt 9dp -> native 6dp (the 1000x overstatement)", () => {
    // The live row that read as ~$1933: 1_933_233_786 at 9 dp is $1.933233786.
    // CEIL for a liability (never under-report what is owed).
    expect(positionRawToNativeRaw(1_933_233_786n, 6, "ceil")).toBe(1_933_234n); // $1.933234
    // FLOOR is the repay cap (never overshoot true debt -> VaultUserDebtTooLow).
    expect(positionRawToNativeRaw(1_933_233_786n, 6, "floor")).toBe(1_933_233n);
  });

  it("ceil vs floor differ by at most one native unit", () => {
    const positionRaw = 2_000_000_001n; // $2.000000001 at 9 dp
    expect(positionRawToNativeRaw(positionRaw, 6, "ceil")).toBe(2_000_001n);
    expect(positionRawToNativeRaw(positionRaw, 6, "floor")).toBe(2_000_000n);
  });

  it("exact multiples ceil == floor (no spurious +1)", () => {
    expect(positionRawToNativeRaw(2_000_000_000n, 6, "ceil")).toBe(2_000_000n);
    expect(positionRawToNativeRaw(2_000_000_000n, 6, "floor")).toBe(2_000_000n);
  });

  it("collateral at >= 9 dp passes through unscaled (divisor 1)", () => {
    // INF (9 dp): 100_000_000 = 0.1 INF, no scaling either direction.
    expect(positionRawToNativeRaw(100_000_000n, 9, "floor")).toBe(100_000_000n);
    expect(positionRawToNativeRaw(100_000_000n, 9, "ceil")).toBe(100_000_000n);
  });

  it("zero stays zero in both directions", () => {
    expect(positionRawToNativeRaw(0n, 6, "ceil")).toBe(0n);
    expect(positionRawToNativeRaw(0n, 6, "floor")).toBe(0n);
  });

  it("fails closed on invalid decimals or a negative (unreadable) input", () => {
    expect(() => positionRawToNativeRaw(1n, -1, "floor")).toThrow();
    expect(() => positionRawToNativeRaw(1n, 19, "floor")).toThrow();
    expect(() => positionRawToNativeRaw(1n, 6.5, "floor")).toThrow();
    expect(() => positionRawToNativeRaw(-1n, 6, "floor")).toThrow();
  });
});

describe("borrow-engine-core: vault exchange-price scaling (raw ledger -> true owed)", () => {
  const E1 = EXCHANGE_PRICE_PRECISION; // exactly 1.0
  // Vault 43's live borrow exchange price at diagnosis time: 1.036035169894
  const E_VAULT43 = 1_036_035_169_894n;

  it("sanity bounds: [1.0, 10.0) accepted, outside rejected", () => {
    expect(isSaneVaultExchangePrice(E1)).toBe(true);
    expect(isSaneVaultExchangePrice(E_VAULT43)).toBe(true);
    expect(isSaneVaultExchangePrice(E1 * 10n - 1n)).toBe(true);
    expect(isSaneVaultExchangePrice(E1 - 1n)).toBe(false); // < 1.0: accrual never shrinks
    expect(isSaneVaultExchangePrice(E1 * 10n)).toBe(false); // >= 10x: parse/venue is broken
    expect(isSaneVaultExchangePrice(0n)).toBe(false);
    expect(isSaneVaultExchangePrice(-E1)).toBe(false);
  });

  it("reproduces the real bug: vault 43 ledger debt x 1.036 = true owed (~3.6% more)", () => {
    // The test position: ledger read 1_933_233_786 (9dp) was treated as owed.
    const ledger = 1_933_233_786n;
    const trueOwed = scaleByExchangePrice(ledger, E_VAULT43, "ceil");
    // 1_933_233_786 * 1.036035169894 = 2_002_898_193.4... -> ceil
    expect(trueOwed).toBe(2_002_898_194n);
    // The understatement was the accrued interest: ~3.6% of the debt.
    expect(Number(trueOwed - ledger) / Number(ledger)).toBeCloseTo(0.036035, 4);
  });

  it("exchange price exactly 1.0 is the identity (fresh vault, no accrual)", () => {
    expect(scaleByExchangePrice(123_456_789n, E1, "floor")).toBe(123_456_789n);
    expect(scaleByExchangePrice(123_456_789n, E1, "ceil")).toBe(123_456_789n);
  });

  it("ceil never under-reports, floor never over-reports; differ by at most 1", () => {
    for (const raw of [1n, 999n, 1_000_000n, 1_933_233_786n, 10n ** 15n]) {
      const fl = scaleByExchangePrice(raw, E_VAULT43, "floor");
      const ce = scaleByExchangePrice(raw, E_VAULT43, "ceil");
      expect(ce - fl === 0n || ce - fl === 1n).toBe(true);
      // Both are >= the raw ledger amount (E >= 1.0 always).
      expect(fl >= raw).toBe(true);
    }
  });

  it("zero stays zero (no phantom debt)", () => {
    expect(scaleByExchangePrice(0n, E_VAULT43, "floor")).toBe(0n);
    expect(scaleByExchangePrice(0n, E_VAULT43, "ceil")).toBe(0n);
  });

  it("fails closed on a negative raw or an insane exchange price", () => {
    expect(() => scaleByExchangePrice(-1n, E_VAULT43, "floor")).toThrow();
    expect(() => scaleByExchangePrice(1n, 0n, "floor")).toThrow();
    expect(() => scaleByExchangePrice(1n, E1 - 1n, "floor")).toThrow();
    expect(() => scaleByExchangePrice(1n, E1 * 10n, "ceil")).toThrow();
  });

  it("repay-cap safety property: floor((ledger-1) x E_read) repay never burns more ledger units than exist", () => {
    // Repaying amount X burns ceil-ish ~X/E_exec + 1 ledger units. E is monotone
    // non-decreasing, so E_exec >= E_read (the cache only lowers E_read).
    // Property: burnUnits = floor(X / E_exec) + 1 <= ledger for X = maxRepay.
    const ledgers = [2n, 100n, 1_933_233_786n, 10n ** 12n];
    const eReads = [E1, E_VAULT43, 9_999_999_999_999n];
    for (const ledger of ledgers) {
      for (const eRead of eReads) {
        const maxRepay = scaleByExchangePrice(ledger - 1n, eRead, "floor");
        for (const eExec of [eRead, eRead + 1n, eRead + 10n ** 9n]) {
          if (!isSaneVaultExchangePrice(eExec)) continue;
          const burned = (maxRepay * EXCHANGE_PRICE_PRECISION) / eExec + 1n;
          expect(burned <= ledger).toBe(true);
        }
      }
    }
  });
});

describe("borrow-engine-core: parseExchangePricesReturn (simulate return data)", () => {
  function encodeU128LE(v: bigint): Uint8Array {
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      out[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    return out;
  }
  function encodeReturn(prices: [bigint, bigint, bigint, bigint]): Uint8Array {
    const out = new Uint8Array(64);
    prices.forEach((p, i) => out.set(encodeU128LE(p), i * 16));
    return out;
  }

  it("parses the real vault 43 fixture (4 LE u128s at 1e12 precision)", () => {
    // Observed via on-chain simulate on 2026-07-02: liquidity supply/borrow,
    // vault supply, vault borrow.
    const data = encodeReturn([
      1_000_000_000_000n,
      1_054_321_000_000n,
      1_000_000_000_000n,
      1_036_035_169_894n,
    ]);
    const parsed = parseExchangePricesReturn(data);
    expect(parsed).not.toBeNull();
    expect(parsed!.liquiditySupplyExchangePrice).toBe(1_000_000_000_000n);
    expect(parsed!.liquidityBorrowExchangePrice).toBe(1_054_321_000_000n);
    expect(parsed!.vaultSupplyExchangePrice).toBe(1_000_000_000_000n);
    expect(parsed!.vaultBorrowExchangePrice).toBe(1_036_035_169_894n);
  });

  it("round-trips large u128 values without precision loss", () => {
    const big = (1n << 100n) + 12345n;
    const data = encodeReturn([big, big + 1n, 2_000_000_000_000n, 3_000_000_000_000n]);
    const parsed = parseExchangePricesReturn(data);
    expect(parsed).not.toBeNull();
    expect(parsed!.liquiditySupplyExchangePrice).toBe(big);
    expect(parsed!.liquidityBorrowExchangePrice).toBe(big + 1n);
  });

  it("fails closed on wrong length", () => {
    expect(parseExchangePricesReturn(new Uint8Array(0))).toBeNull();
    expect(parseExchangePricesReturn(new Uint8Array(63))).toBeNull();
    expect(parseExchangePricesReturn(new Uint8Array(65))).toBeNull();
  });

  it("fails closed when the VAULT prices are out of sane bounds", () => {
    // vault supply below 1.0 -> reject (a garbage price must never scale money)
    const low = encodeReturn([10n ** 12n, 10n ** 12n, 999_999_999_999n, 10n ** 12n]);
    expect(parseExchangePricesReturn(low)).toBeNull();
    // vault borrow at 10x -> reject
    const high = encodeReturn([10n ** 12n, 10n ** 12n, 10n ** 12n, 10n ** 13n]);
    expect(parseExchangePricesReturn(high)).toBeNull();
    // all-zero buffer (defaulted/failed simulate) -> reject
    expect(parseExchangePricesReturn(new Uint8Array(64))).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import {
  evaluateNotionalFloor,
  floorToLot,
  ceilToLot,
  countDecimals,
} from "../../server/trade-sizing-math";

// MUST mirror PacificaAdapter.quantizeOrderSize (float-safe floor). Kept as an independent
// copy — NOT importing floorToLot — so this test fails loudly if the adapter's quantization
// formula and the helper's prediction ever drift apart. A bumped order size must survive this
// without dropping below the min. NOTE: uses the module's countDecimals (handles scientific
// notation); the adapter's local countDecimals does not — they agree for all real decimal lots
// (>= 1e-6), so this mirror is exact in practice. Sub-1e-6 lots are a known follow-up.
function adapterFloor(contracts: number, lotStep: number): number {
  if (!(lotStep > 0)) return contracts;
  const decimals = countDecimals(lotStep);
  return parseFloat((Math.floor(contracts / lotStep + 1e-9) * lotStep).toFixed(decimals));
}

const MIN = 10; // Pacifica's $10 minimum order notional

describe("evaluateNotionalFloor", () => {
  it("reproduces & fixes the production ZEC 422 (0.2455 ZEC floors to 0.2 -> $8.14)", () => {
    const price = 40.726;
    const contracts = MIN / price; // ~0.2455 — the exact-min bump that caused the bug
    const lot = 0.2; // ZEC lot step (== minOrderSizeBase)
    const r = evaluateNotionalFloor(contracts, price, MIN, lot);

    // Without the fix the adapter would floor 0.2455 -> 0.2 -> $8.145 < $10
    expect(r.quantizedContracts).toBeCloseTo(0.2, 9);
    expect(r.quantizedNotional).toBeLessThan(MIN);
    expect(r.needsBump).toBe(true);

    // Bumped size is a whole-lot multiple that still clears the min AFTER the adapter floors it
    expect(r.bumpedContracts).toBeCloseTo(0.4, 9);
    expect(adapterFloor(r.bumpedContracts, lot) * price).toBeGreaterThanOrEqual(MIN);
  });

  it("catches the sibling case: raw notional >= $10 but post-floor notional < $10", () => {
    const price = 40.726;
    const lot = 0.2;
    const contracts = 0.28; // raw ~$11.40, but floors to 0.2 -> $8.145
    const r = evaluateNotionalFloor(contracts, price, MIN, lot);

    expect(r.quantizedNotional).toBeLessThan(MIN);
    expect(r.needsBump).toBe(true);
    expect(adapterFloor(r.bumpedContracts, lot) * price).toBeGreaterThanOrEqual(MIN);
  });

  it("does NOT bump an order that already clears the floor after quantization", () => {
    const price = 40.726;
    const lot = 0.1;
    const contracts = 0.5; // floors to 0.5 -> $20.36 >= $10
    const r = evaluateNotionalFloor(contracts, price, MIN, lot);

    expect(r.needsBump).toBe(false);
    expect(r.bumpedContracts).toBe(r.quantizedContracts);
  });

  it("bumps to the smallest sufficient lot multiple across many price/lot combos (property test)", () => {
    const lots = [0.001, 0.01, 0.1, 0.2, 1];
    const prices = [0.42, 3.1415, 25.25, 40.726, 101, 1234.5];
    for (const lot of lots) {
      for (const price of prices) {
        const contracts = (MIN * 0.3) / price; // start well below the min so a bump is needed
        const r = evaluateNotionalFloor(contracts, price, MIN, lot);
        if (!r.needsBump) continue;

        // sufficiency: survives the adapter's later floor and clears the min
        const refloored = adapterFloor(r.bumpedContracts, lot);
        expect(refloored * price).toBeGreaterThanOrEqual(MIN);

        // minimality: one lot smaller would NOT clear the buffered min (no spurious extra lot)
        const oneLotLess = parseFloat((r.bumpedContracts - lot).toFixed(countDecimals(lot)));
        if (oneLotLess > 0) {
          expect(oneLotLess * price).toBeLessThan(MIN * 1.01);
        }
      }
    }
  });

  it("guards float artifacts (0.4 / 0.1 === 4.000000000000001) — no spurious extra lot", () => {
    const price = 25.25; // MIN * 1.01 / price = 10.1 / 25.25 = 0.4, lands exactly on a lot boundary
    const lot = 0.1;
    const r = evaluateNotionalFloor(0.1, price, MIN, lot); // 0.1 forces a bump

    expect(r.needsBump).toBe(true);
    expect(r.bumpedContracts).toBeCloseTo(0.4, 9); // 0.4, NOT 0.5
    expect(adapterFloor(r.bumpedContracts, lot) * price).toBeGreaterThanOrEqual(MIN);
  });

  it("with no lot step (lotStep = 0) bumps to the raw buffered min", () => {
    const price = 50;
    const r = evaluateNotionalFloor(0.05, price, MIN, 0); // $2.50
    expect(r.needsBump).toBe(true);
    expect(r.bumpedNotional).toBeGreaterThanOrEqual(MIN);
  });

  it("treats non-positive price/min as no-bump (defensive)", () => {
    expect(evaluateNotionalFloor(1, 0, MIN, 0.1).needsBump).toBe(false);
    expect(evaluateNotionalFloor(1, 40, 0, 0.1).needsBump).toBe(false);
  });
});

describe("floor/ceil lot helpers", () => {
  it("floorToLot mirrors the adapter exactly", () => {
    expect(floorToLot(0.2455, 0.2)).toBeCloseTo(0.2, 9);
    expect(floorToLot(0.99, 0.1)).toBeCloseTo(0.9, 9);
    expect(floorToLot(5, 1)).toBe(5);
  });

  it("floorToLot is float-safe: clean lot multiples are NOT dropped a whole lot", () => {
    // 0.3 / 0.1 === 2.9999999999999996 and 0.6 / 0.2 === 2.9999999999999996 — a naive
    // Math.floor(x / lot) * lot returns 0.2 / 0.4 here (the root of the production 422).
    expect(floorToLot(0.3, 0.1)).toBeCloseTo(0.3, 9);
    expect(floorToLot(0.6, 0.2)).toBeCloseTo(0.6, 9);
    expect(floorToLot(0.9, 0.1)).toBeCloseTo(0.9, 9);
    // genuine sub-lot remainders still floor down correctly
    expect(floorToLot(0.34, 0.1)).toBeCloseTo(0.3, 9);
  });

  it("ceilToLot rounds up without float overshoot", () => {
    expect(ceilToLot(0.4, 0.1)).toBeCloseTo(0.4, 9); // artifact: not 0.5
    expect(ceilToLot(0.41, 0.1)).toBeCloseTo(0.5, 9);
    expect(ceilToLot(0.2455, 0.2)).toBeCloseTo(0.4, 9);
  });

  it("countDecimals handles plain and scientific notation", () => {
    expect(countDecimals(0.2)).toBe(1);
    expect(countDecimals(0.001)).toBe(3);
    expect(countDecimals(1)).toBe(0);
    expect(countDecimals(1e-7)).toBe(7);
  });
});

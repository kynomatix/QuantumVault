import { describe, it, expect } from "vitest";
import {
  decideAutoTopUp,
  decideAutoRepay,
  selectResumableTopUpOp,
  buildAutoTopUpClientRequestId,
  AUTO_TOPUP_CLIENT_REQUEST_PREFIX,
  AUTO_TOPUP_MIN_USD,
  AUTO_TOPUP_COOLDOWN_MS,
  AUTO_REPAY_MIN_USD,
  AUTO_REPAY_UNPARK_BUFFER_MULT,
  AUTO_REPAY_UNPARK_BUFFER_FLAT,
} from "../../server/vault/auto-topup";
import type {
  TopUpOpRow,
} from "../../server/vault/auto-topup";
import type {
  PerBotPositionHealth,
  TopUpSuggestion,
} from "../../server/vault/borrow-health";

// ---------------------------------------------------------------------------
// PURE decision tests for the autonomous "defend the loan" auto top-up.
//
// Fixtures: collateral priced at $1 with 6 decimals. A suggestion of 10_000_000
// raw = 10 tokens = $10. The decision layer is DIRECT-collateral-only (v1):
//   - fires ONLY on an available, not-yet-liquidatable, urgent-or-worse loan
//     that has a positive suggested top-up;
//   - CAPS the add at the account wallet's held balance (no swaps);
//   - refuses a dust add below the economic floor (alert instead);
//   - fails closed (skip) on unreadable health / suggestion / price / decimals.
// ---------------------------------------------------------------------------
function health(overrides: Partial<PerBotPositionHealth> = {}): PerBotPositionHealth {
  return {
    borrowPositionId: "p1",
    venuePositionId: 1,
    collateralAssetKey: "INF",
    collateralMint: "InfMint",
    status: "available",
    collateralValueUsd: 100,
    debtUsd: 80,
    ltv: 0.8,
    healthFactor: 1.1,
    liquidatable: false,
    band: "urgent",
    ...overrides,
  };
}

function suggestion(raw: bigint): TopUpSuggestion {
  return {
    suggestedCollateralRaw: raw,
    suggestedCollateralTokens: Number(raw) / 1e6,
    suggestedCollateralUsd: (Number(raw) / 1e6) * 1,
    targetLtv: 0.5,
  };
}

const base = {
  collateralPriceUsd: 1,
  collateralDecimals: 6,
};

describe("decideAutoTopUp — skip (not actionable / fail closed)", () => {
  it("skips when health is unavailable (fail closed, monitor covers)", () => {
    const d = decideAutoTopUp({
      health: health({ status: "unavailable", band: "unavailable" }),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 10_000_000n,
      ...base,
    });
    expect(d.action).toBe("skip");
  });

  it("skips when already liquidatable (do not throw more collateral at it)", () => {
    const d = decideAutoTopUp({
      health: health({ liquidatable: true, band: "liquidation", healthFactor: 0.95 }),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 10_000_000n,
      ...base,
    });
    expect(d.action).toBe("skip");
  });

  it("skips when the band is below urgent (nudge)", () => {
    const d = decideAutoTopUp({
      health: health({ band: "nudge", healthFactor: 1.6 }),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 10_000_000n,
      ...base,
    });
    expect(d.action).toBe("skip");
  });

  it("skips when the band is healthy", () => {
    const d = decideAutoTopUp({
      health: health({ band: "healthy", healthFactor: 3 }),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 10_000_000n,
      ...base,
    });
    expect(d.action).toBe("skip");
  });

  it("skips when the suggestion is null (unreadable facts)", () => {
    const d = decideAutoTopUp({
      health: health(),
      suggestion: null,
      heldCollateralRaw: 10_000_000n,
      ...base,
    });
    expect(d.action).toBe("skip");
  });

  it("skips when the suggested top-up is zero (already at/above target)", () => {
    const d = decideAutoTopUp({
      health: health(),
      suggestion: suggestion(0n),
      heldCollateralRaw: 10_000_000n,
      ...base,
    });
    expect(d.action).toBe("skip");
  });

  it("skips on an invalid collateral price", () => {
    const d = decideAutoTopUp({
      health: health(),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 10_000_000n,
      collateralPriceUsd: 0,
      collateralDecimals: 6,
    });
    expect(d.action).toBe("skip");
  });

  it("skips on invalid collateral decimals", () => {
    const d = decideAutoTopUp({
      health: health(),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 10_000_000n,
      collateralPriceUsd: 1,
      collateralDecimals: -1,
    });
    expect(d.action).toBe("skip");
  });
});

describe("decideAutoTopUp — alert (urgent but not auto-defendable)", () => {
  it("alerts when the account wallet holds no collateral", () => {
    const d = decideAutoTopUp({
      health: health(),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 0n,
      ...base,
    });
    expect(d.action).toBe("alert");
  });

  it("alerts when the affordable add is below the economic floor (dust)", () => {
    // Holds only $3 of collateral, floor is $5 → not worth the gas.
    const d = decideAutoTopUp({
      health: health(),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 3_000_000n,
      ...base,
    });
    expect(d.action).toBe("alert");
  });
});

describe("decideAutoTopUp — topup (spend held collateral, no swap)", () => {
  it("tops up the full suggested amount when the wallet holds enough", () => {
    const d = decideAutoTopUp({
      health: health(),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 25_000_000n,
      ...base,
    });
    expect(d.action).toBe("topup");
    if (d.action === "topup") {
      expect(d.sourceAmountRaw).toBe(10_000_000n);
      expect(d.addUsd).toBeCloseTo(10, 6);
    }
  });

  it("caps the add at the held balance when the wallet holds less than suggested", () => {
    const d = decideAutoTopUp({
      health: health(),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 7_000_000n, // $7 held, still >= $5 floor
      ...base,
    });
    expect(d.action).toBe("topup");
    if (d.action === "topup") {
      expect(d.sourceAmountRaw).toBe(7_000_000n);
      expect(d.addUsd).toBeCloseTo(7, 6);
    }
  });

  it("fires on the liquidation band too (before the venue marks it liquidatable)", () => {
    const d = decideAutoTopUp({
      health: health({ band: "liquidation", healthFactor: 0.98, liquidatable: false }),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 10_000_000n,
      ...base,
    });
    expect(d.action).toBe("topup");
  });

  it("honors a custom minUsd floor", () => {
    // $7 held would pass the default $5 floor, but a $10 floor forces an alert.
    const d = decideAutoTopUp({
      health: health(),
      suggestion: suggestion(10_000_000n),
      heldCollateralRaw: 7_000_000n,
      minUsd: 10,
      ...base,
    });
    expect(d.action).toBe("alert");
  });
});

describe("auto-topup constants", () => {
  it("exposes a sane cooldown and floor", () => {
    expect(AUTO_TOPUP_COOLDOWN_MS).toBe(10 * 60 * 1000);
    expect(AUTO_TOPUP_MIN_USD).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// RESUME selection — money-safety. A partial top-up (collateral moved to the bot,
// supply not yet done) parks a non-terminal `perbot_collateral_topup` op. The
// scanner MUST finish it under its ORIGINAL clientRequestId before ever minting a
// new id — otherwise a later tick starts a SECOND spend and strands the first
// tranche in the bot wallet. selectResumableTopUpOp encodes that decision.
// ---------------------------------------------------------------------------
const COLLATERAL_MINT = "InfMint";

// Default fixture = an AUTO-ORIGIN, DIRECT-collateral op (autoTopup flag + source
// mint == collateral mint). Only such an op is safe for the scanner to resume.
function op(overrides: Partial<TopUpOpRow> = {}): TopUpOpRow {
  return {
    id: "op1",
    operationType: "perbot_collateral_topup",
    status: "needs_attention",
    clientRequestId: "auto-topup:p1:2026-01-01T00:00:00.000Z",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    metadata: { sourceMint: "InfMint", sourceAmountRaw: "7000000", autoTopup: true },
    ...overrides,
  };
}

describe("selectResumableTopUpOp — resume before a fresh spend", () => {
  it("returns 'none' when there are no ops at all", () => {
    expect(selectResumableTopUpOp([], COLLATERAL_MINT)).toEqual({ kind: "none" });
  });

  it("returns 'none' when the only top-up op already succeeded", () => {
    const sel = selectResumableTopUpOp([op({ status: "succeeded" })], COLLATERAL_MINT);
    expect(sel.kind).toBe("none");
  });

  it("ignores ops of other types (e.g. a repay op is not a top-up)", () => {
    const sel = selectResumableTopUpOp(
      [op({ operationType: "perbot_repay", status: "needs_attention" })],
      COLLATERAL_MINT,
    );
    expect(sel.kind).toBe("none");
  });

  it("RESUMES a needs_attention partial under its ORIGINAL id + stored amount (crash after transfer)", () => {
    const sel = selectResumableTopUpOp([op({ status: "needs_attention" })], COLLATERAL_MINT);
    expect(sel).toEqual({
      kind: "resume",
      opId: "op1",
      clientRequestId: "auto-topup:p1:2026-01-01T00:00:00.000Z",
      sourceMint: "InfMint",
      sourceAmountRaw: 7_000_000n,
    });
  });

  it("RESUMES a still-pending/failed op (any non-succeeded status is re-enterable)", () => {
    for (const status of ["pending", "in_progress", "failed", "needs_attention"]) {
      const sel = selectResumableTopUpOp([op({ status })], COLLATERAL_MINT);
      expect(sel.kind).toBe("resume");
    }
  });

  it("picks the NEWEST unfinished op when several exist (never an older tranche)", () => {
    const older = op({
      id: "old",
      clientRequestId: "auto-topup:p1:old",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      metadata: { sourceMint: "InfMint", sourceAmountRaw: "1000000", autoTopup: true },
    });
    const newer = op({
      id: "new",
      clientRequestId: "auto-topup:p1:new",
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      metadata: { sourceMint: "InfMint", sourceAmountRaw: "9000000", autoTopup: true },
    });
    const sel = selectResumableTopUpOp([older, newer], COLLATERAL_MINT);
    expect(sel.kind).toBe("resume");
    if (sel.kind === "resume") {
      expect(sel.opId).toBe("new");
      expect(sel.sourceAmountRaw).toBe(9_000_000n);
    }
  });

  it("resumes on the metadata autoTopup flag ALONE even without the id prefix", () => {
    const sel = selectResumableTopUpOp(
      [op({ clientRequestId: "internal-id-no-prefix" })],
      COLLATERAL_MINT,
    );
    expect(sel.kind).toBe("resume");
  });

  it("does NOT resume on the id prefix alone — a missing autoTopup flag means manual (unresumable)", () => {
    // The default fixture id carries the "auto-topup:" prefix, but the metadata
    // drops the server-set flag. The prefix is client-spoofable, so origin is
    // proven ONLY by the flag: this is treated as a manual op and left alone.
    const sel = selectResumableTopUpOp(
      [op({ metadata: { sourceMint: "InfMint", sourceAmountRaw: "7000000" } })],
      COLLATERAL_MINT,
    );
    expect(sel).toEqual({ kind: "unresumable", opId: "op1" });
  });

  it("marks 'unresumable' (NOT a fresh spend) when the op has no clientRequestId", () => {
    const sel = selectResumableTopUpOp([op({ clientRequestId: null })], COLLATERAL_MINT);
    expect(sel).toEqual({ kind: "unresumable", opId: "op1" });
  });

  it("marks 'unresumable' when the recorded amount is missing or zero", () => {
    expect(selectResumableTopUpOp([op({ metadata: null })], COLLATERAL_MINT).kind).toBe("unresumable");
    expect(
      selectResumableTopUpOp([op({ metadata: { sourceMint: "InfMint", sourceAmountRaw: "0", autoTopup: true } })], COLLATERAL_MINT).kind,
    ).toBe("unresumable");
    expect(
      selectResumableTopUpOp([op({ metadata: { sourceMint: "InfMint", sourceAmountRaw: "not-a-number", autoTopup: true } })], COLLATERAL_MINT).kind,
    ).toBe("unresumable");
  });

  it("marks 'unresumable' when the op recorded NO source mint (can't prove it's direct)", () => {
    const sel = selectResumableTopUpOp(
      [op({ metadata: { sourceAmountRaw: "5000000", autoTopup: true } })],
      COLLATERAL_MINT,
    );
    expect(sel).toEqual({ kind: "unresumable", opId: "op1" });
  });
});

// ---------------------------------------------------------------------------
// MONEY-SAFETY BOUNDARY — the auto path must NEVER autonomously swap, and must
// NEVER finish a user's manual Add Collateral op. Both callers create the SAME
// `perbot_collateral_topup` op type via the SAME executor (which swaps whenever
// source mint != collateral mint), so the selector alone enforces the boundary.
// ---------------------------------------------------------------------------
describe("selectResumableTopUpOp — auto path must not swap or finish manual ops", () => {
  it("BLOCKS a manual swap-backed op (different source mint, no auto flag/prefix) — never resumes a swap", () => {
    const manualSwap = op({
      id: "manual-swap",
      clientRequestId: "client-uuid-1234", // client-generated, not the auto prefix
      metadata: { sourceMint: "UsdcMint", sourceAmountRaw: "10000000" }, // USDC->INF swap
    });
    const sel = selectResumableTopUpOp([manualSwap], COLLATERAL_MINT);
    expect(sel).toEqual({ kind: "unresumable", opId: "manual-swap" });
  });

  it("BLOCKS a manual DIRECT op (same mint) that is NOT auto-origin — leave it for the user", () => {
    const manualDirect = op({
      id: "manual-direct",
      clientRequestId: "client-uuid-5678", // no auto prefix
      metadata: { sourceMint: "InfMint", sourceAmountRaw: "7000000" }, // no autoTopup flag
    });
    const sel = selectResumableTopUpOp([manualDirect], COLLATERAL_MINT);
    expect(sel).toEqual({ kind: "unresumable", opId: "manual-direct" });
  });

  it("BLOCKS even an AUTO-ORIGIN op if it is swap-backed (defense-in-depth: never autonomously swap)", () => {
    const autoSwap = op({
      id: "auto-swap",
      clientRequestId: "auto-topup:p1:x",
      metadata: { sourceMint: "UsdcMint", sourceAmountRaw: "10000000", autoTopup: true },
    });
    const sel = selectResumableTopUpOp([autoSwap], COLLATERAL_MINT);
    expect(sel).toEqual({ kind: "unresumable", opId: "auto-swap" });
  });

  it("does not let a spoofed auto-prefix on a SWAP op cause a resume (both gates hold)", () => {
    const spoofed = op({
      id: "spoofed",
      clientRequestId: "auto-topup:evil", // client spoofed the prefix...
      metadata: { sourceMint: "UsdcMint", sourceAmountRaw: "10000000" }, // ...but it's a swap
    });
    const sel = selectResumableTopUpOp([spoofed], COLLATERAL_MINT);
    expect(sel).toEqual({ kind: "unresumable", opId: "spoofed" });
  });

  it("BLOCKS a manual DIRECT op that spoofed the auto-topup: id prefix (flag is the only authority)", () => {
    // The most subtle attack: a manual op that is DIRECT (would pass the swap gate)
    // AND carries the auto id prefix, but has NO server-set flag. Must be left alone.
    const spoofedDirect = op({
      id: "spoofed-direct",
      clientRequestId: "auto-topup:evil-but-manual",
      metadata: { sourceMint: "InfMint", sourceAmountRaw: "7000000" }, // direct, but no flag
    });
    const sel = selectResumableTopUpOp([spoofedDirect], COLLATERAL_MINT);
    expect(sel).toEqual({ kind: "unresumable", opId: "spoofed-direct" });
  });
});

// ---------------------------------------------------------------------------
// PURE decision tests for the AUTO REPAY fallback (bot idle USDC → pay debt
// down to the target LTV). Fixtures: collateral $1 / 6 decimals, debt = USDC /
// 6 decimals. Base loan: $100 collateral, $80 debt (LTV 0.8, urgent). Target
// LTV 0.5 → target debt $50 → need $30 of repay.
// ---------------------------------------------------------------------------
const repayBase = {
  debtRaw: 80_000_000n,
  collateralRaw: 100_000_000n,
  collateralPriceUsd: 1,
  collateralDecimals: 6,
  debtDecimals: 6,
};

describe("decideAutoRepay — skip (not actionable / fail closed)", () => {
  it("skips when health is unavailable (fail closed, monitor covers)", () => {
    const d = decideAutoRepay({
      health: health({ status: "unavailable", band: "unavailable" }),
      ...repayBase,
      botIdleUsdcRaw: 50_000_000n,
    });
    expect(d.action).toBe("skip");
  });

  it("skips when already liquidatable (never race the venue's liquidation)", () => {
    const d = decideAutoRepay({
      health: health({ liquidatable: true, band: "liquidation", healthFactor: 0.95 }),
      ...repayBase,
      botIdleUsdcRaw: 50_000_000n,
    });
    expect(d.action).toBe("skip");
  });

  it("skips when the band is below urgent (nudge / healthy)", () => {
    for (const band of ["nudge", "healthy"] as const) {
      const d = decideAutoRepay({
        health: health({ band, healthFactor: 2 }),
        ...repayBase,
        botIdleUsdcRaw: 50_000_000n,
      });
      expect(d.action).toBe("skip");
    }
  });

  it("skips on an invalid collateral price", () => {
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      collateralPriceUsd: 0,
      botIdleUsdcRaw: 50_000_000n,
    });
    expect(d.action).toBe("skip");
  });

  it("skips on invalid decimals", () => {
    expect(
      decideAutoRepay({ health: health(), ...repayBase, collateralDecimals: -1, botIdleUsdcRaw: 50_000_000n }).action,
    ).toBe("skip");
    expect(
      decideAutoRepay({ health: health(), ...repayBase, debtDecimals: 1.5, botIdleUsdcRaw: 50_000_000n }).action,
    ).toBe("skip");
  });

  it("skips on an out-of-range target LTV", () => {
    for (const targetLtv of [0, 1, -0.5, 1.5]) {
      const d = decideAutoRepay({
        health: health(),
        ...repayBase,
        botIdleUsdcRaw: 50_000_000n,
        targetLtv,
      });
      expect(d.action).toBe("skip");
    }
  });

  it("skips when there is no debt", () => {
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      debtRaw: 0n,
      botIdleUsdcRaw: 50_000_000n,
    });
    expect(d.action).toBe("skip");
  });

  it("skips when the loan already sits at/below the target LTV (nothing to defend)", () => {
    // $100 collateral, $40 debt → LTV 0.4, below the 0.5 target.
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      debtRaw: 40_000_000n,
      botIdleUsdcRaw: 50_000_000n,
    });
    expect(d.action).toBe("skip");
  });
});

describe("decideAutoRepay — alert (urgent but the bot wallet can't cover it)", () => {
  it("alerts when the bot wallet holds no idle USDC", () => {
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 0n,
    });
    expect(d.action).toBe("alert");
  });

  it("alerts when the affordable paydown is below the economic floor (dust)", () => {
    // Holds only $3 of idle USDC, floor is $5 → not worth the gas.
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 3_000_000n,
    });
    expect(d.action).toBe("alert");
  });
});

describe("decideAutoRepay — repay (pay bot idle USDC toward the target LTV)", () => {
  it("repays exactly the shortfall to the target when the bot holds enough", () => {
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 50_000_000n, // more than the $30 needed
    });
    expect(d.action).toBe("repay");
    if (d.action === "repay") {
      expect(d.repayRaw).toBe(30_000_000n); // $80 debt → $50 target
      expect(d.repayUsd).toBeCloseTo(30, 6);
      expect(d.targetFinalDebtRaw).toBe(50_000_000n);
      expect(d.unparkUsd).toBe(0); // idle alone covers — no unpark leg
    }
  });

  it("caps the paydown at the bot's idle USDC (a partial defense still helps)", () => {
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 10_000_000n, // only $10 of the $30 needed
    });
    expect(d.action).toBe("repay");
    if (d.action === "repay") {
      expect(d.repayRaw).toBe(10_000_000n);
      expect(d.repayUsd).toBeCloseTo(10, 6);
      // The target floor is unchanged — the executor stops AT the target even
      // if a stale-sized duplicate lands.
      expect(d.targetFinalDebtRaw).toBe(50_000_000n);
      expect(d.unparkUsd).toBe(0); // no parked savings passed — idle-only
    }
  });

  it("fires on the liquidation band too (before the venue marks it liquidatable)", () => {
    const d = decideAutoRepay({
      health: health({ band: "liquidation", healthFactor: 0.98, liquidatable: false }),
      ...repayBase,
      botIdleUsdcRaw: 50_000_000n,
    });
    expect(d.action).toBe("repay");
  });

  it("honors a custom target LTV", () => {
    // Target 0.6 → target debt $60 → need $20.
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 50_000_000n,
      targetLtv: 0.6,
    });
    expect(d.action).toBe("repay");
    if (d.action === "repay") {
      expect(d.repayRaw).toBe(20_000_000n);
      expect(d.targetFinalDebtRaw).toBe(60_000_000n);
    }
  });

  it("honors a custom minUsd floor", () => {
    // $7 idle would pass the default $5 floor, but a $10 floor forces an alert.
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 7_000_000n,
      minUsd: 10,
    });
    expect(d.action).toBe("alert");
  });

  it("exposes a sane economic floor", () => {
    expect(AUTO_REPAY_MIN_USD).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// THIRD DEFENSE — parked vault savings counted alongside idle USDC. The
// decision sizes an unpark leg (buffered like the manual Repay waterfall)
// whenever the planned repay exceeds what idle USDC alone can cover.
// ---------------------------------------------------------------------------
describe("decideAutoRepay — parked savings (third defense)", () => {
  it("covers the full shortfall when idle USDC + parked savings suffice", () => {
    // Need $30; idle $10 + parked $25 → full $30 repay, unpark the $20 gap (buffered).
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 10_000_000n,
      parkedUsdcValueRaw: 25_000_000n,
    });
    expect(d.action).toBe("repay");
    if (d.action === "repay") {
      expect(d.repayRaw).toBe(30_000_000n);
      expect(d.targetFinalDebtRaw).toBe(50_000_000n);
      expect(d.unparkUsd).toBeCloseTo(20 * AUTO_REPAY_UNPARK_BUFFER_MULT + AUTO_REPAY_UNPARK_BUFFER_FLAT, 6);
    }
  });

  it("turns an idle-only alert into a repay when parked savings cover the floor", () => {
    // Idle $0 (alert on its own) + parked $12 → $12 partial repay, all unparked.
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 0n,
      parkedUsdcValueRaw: 12_000_000n,
    });
    expect(d.action).toBe("repay");
    if (d.action === "repay") {
      expect(d.repayRaw).toBe(12_000_000n);
      expect(d.unparkUsd).toBeCloseTo(12 * AUTO_REPAY_UNPARK_BUFFER_MULT + AUTO_REPAY_UNPARK_BUFFER_FLAT, 6);
    }
  });

  it("still alerts when idle + parked together stay under the economic floor", () => {
    // $2 idle + $2 parked = $4 < $5 floor → not worth the gas, tell the owner.
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 2_000_000n,
      parkedUsdcValueRaw: 2_000_000n,
    });
    expect(d.action).toBe("alert");
  });

  it("ignores parked savings when idle USDC already covers the full shortfall", () => {
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 50_000_000n,
      parkedUsdcValueRaw: 100_000_000n,
    });
    expect(d.action).toBe("repay");
    if (d.action === "repay") {
      expect(d.repayRaw).toBe(30_000_000n);
      expect(d.unparkUsd).toBe(0); // never unpark what the repay doesn't need
    }
  });

  it("never repays past the target even with deep parked savings", () => {
    const d = decideAutoRepay({
      health: health(),
      ...repayBase,
      botIdleUsdcRaw: 0n,
      parkedUsdcValueRaw: 500_000_000n, // $500 parked, only $30 needed
    });
    expect(d.action).toBe("repay");
    if (d.action === "repay") {
      expect(d.repayRaw).toBe(30_000_000n);
      expect(d.targetFinalDebtRaw).toBe(50_000_000n);
    }
  });
});

describe("buildAutoTopUpClientRequestId", () => {
  it("mints an id under the shared auto prefix", () => {
    const id = buildAutoTopUpClientRequestId("p1", "2026-01-01T00:00:00.000Z");
    expect(id.startsWith(AUTO_TOPUP_CLIENT_REQUEST_PREFIX)).toBe(true);
  });

  it("an auto op (server-set flag) resumes — the id format is not what authorizes it", () => {
    const sel = selectResumableTopUpOp(
      [
        op({
          clientRequestId: buildAutoTopUpClientRequestId("p1", "s"),
          metadata: { sourceMint: "InfMint", sourceAmountRaw: "7000000", autoTopup: true },
        }),
      ],
      COLLATERAL_MINT,
    );
    expect(sel.kind).toBe("resume");
  });
});

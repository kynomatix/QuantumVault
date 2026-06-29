import { describe, it, expect } from "vitest";
import { decodeVaultConfig, type BorrowVaultConfig } from "../../server/vault/jupiter-lend-borrow-route";
import {
  evaluateCollateralWithdraw,
  evaluateMaxCarveForTargetLtv,
  PERBOT_CARVE_DEFAULT_TARGET_LTV,
  PERBOT_CARVE_HARD_CEILING_LTV,
  type BorrowOracleContext,
} from "../../server/vault/borrow-risk-policy";
import { selectBlockingBotPositions } from "../../server/vault/jupiter-lend-perbot-carve";

/**
 * Per-bot CARVE sizing tests (owner pivot 2026-06-29). PURE — no network.
 * The carve withdraws collateral OUT of the ACCOUNT position down to a target
 * LTV; `evaluateMaxCarveForTargetLtv` sizes it, delegating every fail-closed gate
 * to `evaluateCollateralWithdraw` (the one money gate). Uses the live INF→USDC
 * vault snapshot (id 43): price ≈ $98.87/INF, maxLtv 0.75, liqThreshold 0.80.
 */
const RAW_INF = {
  id: 43,
  address: "VaultAddrPlaceholder1111111111111111111111",
  oracle: "OracleAddrPlaceholder111111111111111111111",
  supplyToken: { address: "INFmintPlaceholder11111111111111111111111", symbol: "INF", decimals: 9, price: "99.249552485649" },
  borrowToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, price: "1" },
  collateralFactor: "750",
  liquidationThreshold: "800",
  liquidationPenalty: "500",
  borrowRate: "466",
  supplyRate: "0",
  borrowFee: "0",
  borrowLimitUtilization: "405783379446790",
  minimumBorrowing: "1034775",
  borrowable: "5838249171951",
  withdrawable: "11610714005191",
  oraclePriceLiquidate: "98865597964440443",
  oraclePriceOperate: "98865597964440443",
};

const vault = (): BorrowVaultConfig => {
  const c = decodeVaultConfig(RAW_INF);
  if (!c) throw new Error("INF config failed to decode");
  return c;
};

const PRICE = vault().oraclePriceLiquidateUsd; // ≈ 98.8656
const ONE_INF = 1_000_000_000n; // 1 INF @ 9 dp
const oracleOk: BorrowOracleContext = { publishAgeSec: 30, priceMove1hAbs: 0.02 };
const codesOf = (reasons: { code: string }[]) => reasons.map((r) => r.code);

describe("per-bot carve constants", () => {
  it("encodes the owner's 50% default and a hard ceiling below the protocol max", () => {
    expect(PERBOT_CARVE_DEFAULT_TARGET_LTV).toBe(0.5);
    expect(PERBOT_CARVE_HARD_CEILING_LTV).toBe(0.6);
    // The hard ceiling MUST stay strictly below the INF protocol collateral factor.
    expect(PERBOT_CARVE_HARD_CEILING_LTV).toBeLessThan(vault().maxLtv);
  });
});

describe("evaluateMaxCarveForTargetLtv — default 50% target", () => {
  it("sizes a carve that lands the account at <= the target", () => {
    // 1 INF (~$98.87) collateral, 20 USDC debt → current LTV ≈ 0.202.
    const d = evaluateMaxCarveForTargetLtv({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      oracle: oracleOk,
    });
    expect(d.allowed).toBe(true);
    expect(d.targetLtv).toBe(0.5);
    expect(d.maxCarveRaw).not.toBeNull();
    const carve = BigInt(d.maxCarveRaw as string);
    expect(carve).toBeGreaterThan(0n);
    expect(carve).toBeLessThan(ONE_INF); // can't carve the whole thing while debt remains
    // Conservative rounding leaves the account at or just under the target.
    expect(d.postLtvAtMax).not.toBeNull();
    expect(d.postLtvAtMax as number).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(d.postLtvAtMax as number).toBeCloseTo(0.5, 2);
  });

  it("allows withdrawing ALL collateral when there is no debt", () => {
    const d = evaluateMaxCarveForTargetLtv({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 0n,
      oracle: oracleOk,
    });
    expect(d.allowed).toBe(true);
    expect(d.targetLtv).toBe(0.5);
    expect(d.maxCarveRaw).toBe(ONE_INF.toString());
    expect(d.postLtvAtMax).toBe(0);
  });

  it("DENIES (null carve) when the account is already at/above the target", () => {
    // 60 USDC debt vs ~$98.87 collateral → current LTV ≈ 0.607 > 0.5.
    const d = evaluateMaxCarveForTargetLtv({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 60_000_000n,
      oracle: oracleOk,
    });
    expect(d.allowed).toBe(false);
    expect(d.maxCarveRaw).toBeNull();
    expect(codesOf(d.reasons)).toContain("exceeds_max_ltv");
  });
});

describe("evaluateMaxCarveForTargetLtv — fail closed", () => {
  it("DENIES (null carve) when the oracle is unreadable and debt remains", () => {
    const d = evaluateMaxCarveForTargetLtv({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      oracle: { publishAgeSec: null, priceMove1hAbs: 0.02 },
    });
    expect(d.allowed).toBe(false);
    expect(d.maxCarveRaw).toBeNull();
    expect(codesOf(d.reasons)).toContain("oracle_unreadable");
  });

  it("DENIES (null carve, null target) when the target LTV is invalid or > 100%", () => {
    // 0/neg/NaN/Infinity are non-finite-or-non-positive; 1.5 & 2 are > 100% LTV
    // (nonsensical) and must be REJECTED, not silently clamped to the ceiling.
    for (const bad of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 2]) {
      const d = evaluateMaxCarveForTargetLtv({
        vault: vault(),
        liveCollateralRaw: ONE_INF,
        liveDebtRaw: 20_000_000n,
        oracle: oracleOk,
        requestedTargetLtv: bad,
      });
      expect(d.allowed).toBe(false);
      expect(d.targetLtv).toBeNull();
      expect(d.maxCarveRaw).toBeNull();
      expect(codesOf(d.reasons)).toContain("invalid_carve_target_ltv");
    }
  });

  it("DENIES (null carve) when the publish age is negative or NaN (unreadable, not 'fresh')", () => {
    for (const badAge of [-5, Number.NaN]) {
      const d = evaluateMaxCarveForTargetLtv({
        vault: vault(),
        liveCollateralRaw: ONE_INF,
        liveDebtRaw: 20_000_000n,
        oracle: { publishAgeSec: badAge, priceMove1hAbs: 0.02 },
      });
      expect(d.allowed).toBe(false);
      expect(d.maxCarveRaw).toBeNull();
      expect(codesOf(d.reasons)).toContain("oracle_unreadable");
    }
  });

  it("DENIES (null carve) when the price move is NaN, Infinity, or negative (unreadable, not 'calm')", () => {
    for (const badMove of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const d = evaluateMaxCarveForTargetLtv({
        vault: vault(),
        liveCollateralRaw: ONE_INF,
        liveDebtRaw: 20_000_000n,
        oracle: { publishAgeSec: 30, priceMove1hAbs: badMove },
      });
      expect(d.allowed).toBe(false);
      expect(d.maxCarveRaw).toBeNull();
      expect(codesOf(d.reasons)).toContain("price_move_unreadable");
    }
  });
});

describe("evaluateCollateralWithdraw — oracle fail-closed (non-finite / negative)", () => {
  const base = {
    vault: vault(),
    liveCollateralRaw: ONE_INF,
    liveDebtRaw: 20_000_000n,
    requestedWithdrawRaw: "max" as const,
  };

  it("treats an Infinity price move as UNREADABLE, never a passable value", () => {
    const d = evaluateCollateralWithdraw({
      ...base,
      oracle: { publishAgeSec: 30, priceMove1hAbs: Number.POSITIVE_INFINITY },
    });
    expect(d.allowed).toBe(false);
    expect(codesOf(d.reasons)).toContain("price_move_unreadable");
  });

  it("treats a negative publish age as UNREADABLE (impossible age = unreadable)", () => {
    const d = evaluateCollateralWithdraw({
      ...base,
      oracle: { publishAgeSec: -10, priceMove1hAbs: 0.02 },
    });
    expect(d.allowed).toBe(false);
    expect(codesOf(d.reasons)).toContain("oracle_unreadable");
  });
});

describe("evaluateMaxCarveForTargetLtv — target resolution", () => {
  it("clamps a too-high requested target down to the hard ceiling", () => {
    const d = evaluateMaxCarveForTargetLtv({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      oracle: oracleOk,
      requestedTargetLtv: 0.9, // above the 0.6 hard ceiling
    });
    expect(d.allowed).toBe(true);
    expect(d.targetLtv).toBe(0.6);
    expect(d.postLtvAtMax as number).toBeCloseTo(0.6, 2);
    // 0.6 is above the 0.5 recommended-safe level → warned, but still allowed.
    expect(codesOf(d.reasons)).toContain("above_recommended_ltv");
  });

  it("falls back to the global setting when no per-call target is given", () => {
    const d = evaluateMaxCarveForTargetLtv({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      oracle: oracleOk,
      globalTargetLtv: 0.4,
    });
    expect(d.allowed).toBe(true);
    expect(d.targetLtv).toBe(0.4);
    expect(d.postLtvAtMax as number).toBeCloseTo(0.4, 2);
  });

  it("a LOWER target yields a SMALLER carve", () => {
    const base = {
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      oracle: oracleOk,
    };
    const low = evaluateMaxCarveForTargetLtv({ ...base, requestedTargetLtv: 0.3 });
    const high = evaluateMaxCarveForTargetLtv({ ...base, requestedTargetLtv: 0.5 });
    expect(low.allowed).toBe(true);
    expect(high.allowed).toBe(true);
    expect(BigInt(low.maxCarveRaw as string)).toBeLessThan(BigInt(high.maxCarveRaw as string));
    expect(low.postLtvAtMax as number).toBeCloseTo(0.3, 2);
  });
});

describe("evaluateCollateralWithdraw — targetMaxLtv parameter", () => {
  it("tightens the cap: an exact withdraw allowed at the protocol ceiling is DENIED at the target", () => {
    const exactWithdraw = 600_000_000n; // 0.6 INF → leaves 0.4 INF (~$39.55) vs 20 USDC → LTV ≈ 0.506
    const tight = evaluateCollateralWithdraw({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      requestedWithdrawRaw: exactWithdraw,
      oracle: oracleOk,
      targetMaxLtv: 0.5,
    });
    expect(tight.allowed).toBe(false);
    expect(codesOf(tight.reasons)).toContain("exceeds_max_ltv");

    // The SAME withdraw with no target only checks the looser protocol ceiling (0.75) → allowed.
    const loose = evaluateCollateralWithdraw({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      requestedWithdrawRaw: exactWithdraw,
      oracle: oracleOk,
    });
    expect(loose.allowed).toBe(true);
  });

  it("fails closed on an out-of-range targetMaxLtv", () => {
    const d = evaluateCollateralWithdraw({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      requestedWithdrawRaw: "max",
      oracle: oracleOk,
      targetMaxLtv: 1.5,
    });
    expect(d.allowed).toBe(false);
    expect(d.maxWithdrawableRaw).toBeNull();
    expect(codesOf(d.reasons)).toContain("invalid_target_ltv");
  });

  it("is unchanged (caps at the protocol ceiling) when targetMaxLtv is omitted", () => {
    const d = evaluateCollateralWithdraw({
      vault: vault(),
      liveCollateralRaw: ONE_INF,
      liveDebtRaw: 20_000_000n,
      requestedWithdrawRaw: "max",
      oracle: oracleOk,
    });
    expect(d.allowed).toBe(true);
    expect(d.effectiveMaxLtv).toBe(0.75);
    expect(d.postLtv as number).toBeCloseTo(0.75, 2);
    // Sanity: PRICE decoded as expected from the snapshot.
    expect(PRICE).toBeCloseTo(98.8656, 2);
  });
});

/**
 * Resume-aware clean-bot guard (PURE rule behind the per-bot proof ROUTE).
 *
 * The architect found a route-level resume DEAD-END: both clean-bot guards (the
 * pre-lock "3b" and the in-lock "7b") 409'd on ANY non-terminal bot position, so
 * after a successful open a re-POST of the SAME proofRunId could never reach the
 * orchestrators — contradicting the route's own "re-POST the same proofRunId to
 * finish/reconcile" contract. These pin the fix: a FRESH run still refuses any
 * non-terminal row; a RESUME with a KNOWN own position id tolerates ONLY that
 * exact row and still blocks foreign ones; and a RESUME with a NULL own id blocks
 * EVERY non-terminal row (fail-safe). The executor write-aheads the bot position
 * id onto the carve op BEFORE the open broadcast, so "a row of ours exists ⇒
 * ownedBotPositionId is set" — therefore a null owner on a resume can only mean a
 * FOREIGN row (or the no-money-moved pre-broadcast crash sliver), never an
 * adoptable own position.
 */
describe("selectBlockingBotPositions — resume-aware clean-bot guard", () => {
  const open = (id: string, status = "open") => ({ id, status });

  it("FRESH run: blocks ANY non-terminal position (assumes a clean bot)", () => {
    const blocking = selectBlockingBotPositions({
      rows: [open("bot-pos-1"), open("bot-pos-2", "pending")],
      isResume: false,
      ownedBotPositionId: null,
    });
    expect(blocking.map((p) => p.id)).toEqual(["bot-pos-1", "bot-pos-2"]);
  });

  it("FRESH run: a clean bot (no non-terminal rows) passes", () => {
    const blocking = selectBlockingBotPositions({
      rows: [open("bot-pos-old", "closed"), open("bot-pos-fail", "failed")],
      isResume: false,
      ownedBotPositionId: null,
    });
    expect(blocking).toHaveLength(0);
  });

  it("RESUME: this run's OWN open position is tolerated (does NOT block)", () => {
    const blocking = selectBlockingBotPositions({
      rows: [open("bot-pos-1")],
      isResume: true,
      ownedBotPositionId: "bot-pos-1",
    });
    expect(blocking).toHaveLength(0);
  });

  it("RESUME: a FOREIGN non-terminal position still BLOCKS", () => {
    const blocking = selectBlockingBotPositions({
      rows: [open("bot-pos-1"), open("bot-pos-foreign", "pending")],
      isResume: true,
      ownedBotPositionId: "bot-pos-1",
    });
    expect(blocking.map((p) => p.id)).toEqual(["bot-pos-foreign"]);
  });

  it("RESUME with a NULL own id BLOCKS every non-terminal row (fail-safe)", () => {
    // The executor write-aheads the bot position id onto the carve op BEFORE the
    // open broadcast, so "a row of ours exists ⇒ ownedBotPositionId is set". A
    // null owner on a resume therefore means we own NO position yet, so any live
    // row is FOREIGN (or the no-money-moved pre-broadcast crash sliver) and must
    // block — never silently adopted.
    const blocking = selectBlockingBotPositions({
      rows: [open("bot-pos-1", "pending"), open("bot-pos-2")],
      isResume: true,
      ownedBotPositionId: null,
    });
    expect(blocking.map((p) => p.id)).toEqual(["bot-pos-1", "bot-pos-2"]);
  });

  it("terminal rows (closed/failed) NEVER block, even on a fresh run", () => {
    const blocking = selectBlockingBotPositions({
      rows: [open("a", "closed"), open("b", "failed")],
      isResume: false,
      ownedBotPositionId: null,
    });
    expect(blocking).toHaveLength(0);
  });
});

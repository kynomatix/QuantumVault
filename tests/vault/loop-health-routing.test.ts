import { describe, it, expect } from "vitest";
import {
  decodeVaultConfig,
  decodeLoopVaultConfig,
  WSOL_MINT,
  type BorrowVaultConfig,
  type LivePositionHealth,
} from "../../server/vault/jupiter-lend-borrow-route";
import {
  computeRowHealth,
  computePerBotPositionHealth,
  type RowHealthDeps,
} from "../../server/vault/borrow-health";

// ---------------------------------------------------------------------------
// T005 — SOL Loop Vault health routing.
//
// Two money-safety properties under test:
//   1. decodeLoopVaultConfig accepts ONLY WSOL-debt vaults (pinned by MINT),
//      and the USDC decoder still rejects them — the two families can never
//      cross-decode.
//   2. computeRowHealth routes kind='loop' rows through the VAULT-ID-keyed
//      deps and NEVER the mint-keyed ones. A mint-keyed read would pair the
//      loop row with a sibling vault's config (JupSOL also has USDC vault 13,
//      mSOL has 49) and could read a DIFFERENT USER's position with the same
//      numeric position id — which the monitor would then "self-heal" the
//      stored amounts from.
// ---------------------------------------------------------------------------

/**
 * Raw REST shape of the mSOL→SOL loop vault (id 47). Risk numbers mirror the
 * live vault (liquidationThreshold 900 ⇒ 0.90; oraclePriceLiquidate 1e15-scaled
 * ≈ 1.391 = mSOL/SOL rate, verified live 2026-07-03 — DEBT-TOKEN denominated,
 * not $). Addresses other than the WSOL mint are placeholders; decoding never
 * validates pubkeys and these tests are pure (no network).
 */
const RAW_MSOL_LOOP = {
  id: 47,
  address: "LoopVaultAddrPlaceholder1111111111111111111",
  oracle: "LoopOracleAddrPlaceholder111111111111111111",
  supplyToken: { address: "mSoLmintPlaceholder1111111111111111111111", symbol: "MSOL", decimals: 9, price: "245.1" },
  borrowToken: { address: WSOL_MINT, symbol: "SOL", decimals: 9, price: "176.2" },
  collateralFactor: "870",
  liquidationThreshold: "900",
  liquidationPenalty: "200",
  borrowRate: "310",
  supplyRate: "0",
  borrowFee: "0",
  borrowLimitUtilization: "405783379446790",
  minimumBorrowing: "1000000",
  borrowable: "5838249171951",
  withdrawable: "11610714005191",
  oraclePriceLiquidate: "1391000000000000",
  oraclePriceOperate: "1391000000000000",
};

describe("decodeLoopVaultConfig (WSOL debt pinned by MINT)", () => {
  it("decodes a WSOL-debt loop vault; ...Usd fields carry SOL-denominated values", () => {
    const c = decodeLoopVaultConfig(RAW_MSOL_LOOP);
    expect(c).not.toBeNull();
    const cfg = c as BorrowVaultConfig;
    expect(cfg.vaultId).toBe(47);
    expect(cfg.debtMint).toBe(WSOL_MINT);
    expect(cfg.debtDecimals).toBe(9);
    expect(cfg.collateralDecimals).toBe(9);
    expect(cfg.liquidationThreshold).toBeCloseTo(0.9, 6);
    // 1e15-scaled oracle decodes to the mSOL/SOL rate (SOL per mSOL), NOT $.
    expect(cfg.oraclePriceLiquidateUsd).toBeCloseTo(1.391, 6);
  });

  it("rejects a USDC-debt vault (fail closed)", () => {
    const usdcDebt = {
      ...RAW_MSOL_LOOP,
      borrowToken: { address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6, price: "1" },
    };
    expect(decodeLoopVaultConfig(usdcDebt)).toBeNull();
  });

  it("rejects a vault whose debt SYMBOL says SOL but the mint is wrong (mint pin, not symbol)", () => {
    const fakeSol = {
      ...RAW_MSOL_LOOP,
      borrowToken: { ...RAW_MSOL_LOOP.borrowToken, address: "FakeSoLMint111111111111111111111111111111" },
    };
    expect(decodeLoopVaultConfig(fakeSol)).toBeNull();
  });

  it("rejects malformed input (fail closed)", () => {
    expect(decodeLoopVaultConfig(null)).toBeNull();
    expect(decodeLoopVaultConfig({})).toBeNull();
  });

  it("the USDC decoder still REJECTS the loop vault — families can never cross-decode", () => {
    expect(decodeVaultConfig(RAW_MSOL_LOOP)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeRowHealth kind routing
// ---------------------------------------------------------------------------

const LOOP_CFG = decodeLoopVaultConfig(RAW_MSOL_LOOP) as BorrowVaultConfig;

/** Live loop position: 10 mSOL collateral, 6.955 SOL debt (both 9dp, SOL units). */
const LOOP_LIVE: LivePositionHealth = {
  vaultId: 47,
  positionId: 3,
  collateralRaw: (10n * 10n ** 9n).toString(),
  debtRaw: "6955000000",
  maxRepayNativeRaw: "6955000000",
  liquidatable: false,
  tick: 0,
  oraclePriceUsd: 1.391,
};

/** Deps whose MINT-KEYED members throw — any call is a money-safety violation. */
function loopOnlyDeps(overrides: Partial<RowHealthDeps> = {}): RowHealthDeps {
  return {
    getVaultConfig: async () => {
      throw new Error("MINT-KEYED getVaultConfig called for a loop row");
    },
    readLivePositionHealth: async () => {
      throw new Error("MINT-KEYED readLivePositionHealth called for a loop row");
    },
    getLoopVaultConfig: async (vaultId) => (vaultId === 47 ? LOOP_CFG : null),
    readLoopLivePositionHealth: async (vaultId, positionId) =>
      vaultId === 47 && positionId === 3 ? LOOP_LIVE : null,
    ...overrides,
  };
}

const LOOP_ROW = {
  id: "row-loop-1",
  venuePositionId: 3,
  collateralMint: "mSoLmintPlaceholder1111111111111111111111",
  collateralAssetKey: "msol",
  kind: "loop",
  venueVaultId: "47",
};

describe("computeRowHealth loop routing (money-safety)", () => {
  it("routes a loop row via vaultId-keyed deps and NEVER calls the mint-keyed ones", async () => {
    // The mint-keyed deps throw; catching-them-internally would surface as
    // band 'unavailable', so a correct 'healthy' result proves they were
    // never invoked.
    const h = await computeRowHealth(LOOP_ROW, loopOnlyDeps());
    expect(h.band).toBe("healthy");
    // Unit consistency (SOL-denominated both sides): collateral 10 mSOL ×
    // 1.391 = 13.91 SOL; debt 6.955 SOL → LTV 0.5, HF = 13.91×0.90/6.955 = 1.8.
    expect(h.collateralValueUsd).toBeCloseTo(13.91, 6);
    expect(h.debtUsd).toBeCloseTo(6.955, 6);
    expect(h.ltv).toBeCloseTo(0.5, 6);
    expect(h.healthFactor).toBeCloseTo(1.8, 6);
  });

  it("a loop row WITHOUT a venueVaultId fails closed to unavailable (never a mint fallback)", async () => {
    const h = await computeRowHealth({ ...LOOP_ROW, venueVaultId: null }, loopOnlyDeps());
    expect(h.band).toBe("unavailable");
  });

  it("a loop row with a non-numeric venueVaultId fails closed to unavailable", async () => {
    const h = await computeRowHealth({ ...LOOP_ROW, venueVaultId: "abc" }, loopOnlyDeps());
    expect(h.band).toBe("unavailable");
  });

  it("an unreadable loop vault config fails closed to unavailable", async () => {
    const h = await computeRowHealth(
      LOOP_ROW,
      loopOnlyDeps({ getLoopVaultConfig: async () => null }),
    );
    expect(h.band).toBe("unavailable");
  });

  it("caches the loop config under 'loop:<vaultId>' — no collision with mint keys", async () => {
    const cache = new Map<string, BorrowVaultConfig | null>();
    // Pre-poison the MINT key with null: a mint-keyed cache lookup would
    // return null config → unavailable. The loop row must ignore it.
    cache.set(LOOP_ROW.collateralMint, null);
    const h = await computeRowHealth(LOOP_ROW, loopOnlyDeps(), cache);
    expect(h.band).toBe("healthy");
    expect(cache.get("loop:47")).toBe(LOOP_CFG);
    expect(cache.get(LOOP_ROW.collateralMint)).toBeNull(); // untouched
  });

  it("a kind-less row still routes through the mint-keyed (borrow) path", async () => {
    let mintCalls = 0;
    const deps: RowHealthDeps = {
      getVaultConfig: async () => {
        mintCalls++;
        return null;
      },
      readLivePositionHealth: async () => null,
      getLoopVaultConfig: async () => {
        throw new Error("loop dep called for a borrow row");
      },
      readLoopLivePositionHealth: async () => {
        throw new Error("loop dep called for a borrow row");
      },
    };
    const h = await computeRowHealth(
      { id: "row-b", venuePositionId: 1, collateralMint: "InfMint", collateralAssetKey: "inf" },
      deps,
    );
    expect(mintCalls).toBe(1);
    expect(h.band).toBe("unavailable"); // null config fails closed as before
  });
});

// ---------------------------------------------------------------------------
// Vault-47 unit-consistency (pure ratio math on the SOL-denominated oracle)
// ---------------------------------------------------------------------------

describe("computePerBotPositionHealth on a SOL-denominated loop vault", () => {
  it("LTV / HF are correct because config and position share the SAME denomination", () => {
    const h = computePerBotPositionHealth({
      borrowPositionId: "p-loop",
      venuePositionId: 3,
      collateralAssetKey: "msol",
      collateralMint: LOOP_ROW.collateralMint,
      live: LOOP_LIVE,
      vault: LOOP_CFG,
    });
    expect(h.status).toBe("available");
    expect(h.healthFactor).toBeCloseTo(1.8, 6);
    expect(h.ltv).toBeCloseTo(0.5, 6);
    expect(h.band).toBe("healthy");
  });

  it("liquidation band when debt approaches the 0.90 threshold (SOL units)", () => {
    const nearLiq: LivePositionHealth = {
      ...LOOP_LIVE,
      // debt 12.6 SOL vs 13.91 SOL collateral value → HF = 12.519/12.6 ≈ 0.9936
      debtRaw: "12600000000",
      maxRepayNativeRaw: "12600000000",
    };
    const h = computePerBotPositionHealth({
      borrowPositionId: "p-loop",
      venuePositionId: 3,
      collateralAssetKey: "msol",
      collateralMint: LOOP_ROW.collateralMint,
      live: nearLiq,
      vault: LOOP_CFG,
    });
    expect(h.healthFactor).toBeLessThan(1);
    expect(h.band).toBe("liquidation");
  });
});

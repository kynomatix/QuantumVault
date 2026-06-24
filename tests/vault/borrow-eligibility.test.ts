import { describe, it, expect, afterEach } from "vitest";
import { evaluateBorrowPreview, previewBorrowEligibility } from "../../server/vault/borrow-eligibility";
import { buildBorrowExposureContext } from "../../server/vault/borrow-exposure-context";
import { UNREADABLE_ORACLE_CONTEXT } from "../../server/vault/borrow-eligibility";
import type { BorrowVaultConfig } from "../../server/vault/jupiter-lend-borrow-route";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const INF_MINT = "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm";
const WALLET = "WaLLet1111111111111111111111111111111111111";

function vault(over: Partial<BorrowVaultConfig> = {}): BorrowVaultConfig {
  return {
    vaultId: 43,
    vaultAddress: "vault43",
    oracleAddress: "oracle43",
    collateralMint: INF_MINT,
    collateralSymbol: "INF",
    collateralDecimals: 9,
    debtMint: USDC,
    debtSymbol: "USDC",
    debtDecimals: 6,
    maxLtv: 0.75,
    liquidationThreshold: 0.8,
    liquidationPenalty: 0.05,
    borrowApr: 0.0466,
    supplyApr: 0.03,
    borrowFee: 0,
    utilization: 0.5,
    oraclePriceLiquidateUsd: 200,
    oraclePriceOperateUsd: 200,
    marketPriceUsd: 200,
    borrowableUsdcRaw: "1000000000000",
    withdrawableCollateralRaw: "1000000000",
    minimumBorrowingRaw: "1000000",
    ...over,
  };
}

const emptyExposure = () => buildBorrowExposureContext([], INF_MINT, USDC);

afterEach(() => {
  delete process.env.BORROW_OWNER_WALLET;
});

describe("evaluateBorrowPreview", () => {
  it("vault unreadable → ok:false, vault_unreadable", () => {
    const r = evaluateBorrowPreview({
      walletAddress: WALLET,
      vault: null,
      exposureResult: null,
      collateralRaw: BigInt(10_000_000_000),
      existingDebtRaw: BigInt(0),
      requestedDebtRaw: BigInt(100_000_000),
      oracle: UNREADABLE_ORACLE_CONTEXT,
    });
    expect(r.ok).toBe(false);
    expect(r.allowed).toBe(false);
    expect(r.projection).toBeNull();
    expect(r.reasons[0].code).toBe("vault_unreadable");
  });

  it("exposure book unreadable → ok:false, surfaces exposure reason", () => {
    const badExposure = buildBorrowExposureContext(
      [
        {
          status: "active",
          collateralMint: INF_MINT,
          collateralAssetKey: "inf",
          debtAssetKey: "usdc",
          debtMint: USDC,
          debtAmountRaw: "not-a-number",
        },
      ],
      INF_MINT,
      USDC,
    );
    const r = evaluateBorrowPreview({
      walletAddress: WALLET,
      vault: vault(),
      exposureResult: badExposure,
      collateralRaw: BigInt(10_000_000_000),
      existingDebtRaw: BigInt(0),
      requestedDebtRaw: BigInt(100_000_000),
      oracle: UNREADABLE_ORACLE_CONTEXT,
    });
    expect(r.ok).toBe(false);
    expect(r.collateral).not.toBeNull();
    expect(r.reasons.some((x) => x.code === "exposure_row_unreadable_debt")).toBe(true);
  });

  it("readable vault + empty book → ok:true, projection computed, oracle fails closed", () => {
    const r = evaluateBorrowPreview({
      walletAddress: WALLET,
      vault: vault(),
      exposureResult: emptyExposure(),
      collateralRaw: BigInt(10_000_000_000), // 10 INF
      existingDebtRaw: BigInt(0),
      requestedDebtRaw: BigInt(100_000_000), // $100
      oracle: UNREADABLE_ORACLE_CONTEXT,
    });
    expect(r.ok).toBe(true);
    expect(r.allowed).toBe(false); // oracle unreadable + not allowlisted
    expect(r.projection!.collateralValueUsd).toBeCloseTo(2000, 6); // 10 * $200
    expect(r.projection!.projectedLtv).toBeCloseTo(0.05, 6); // 100/2000
    expect(r.reasons.some((x) => x.code === "oracle_unreadable")).toBe(true);
    expect(r.reasons.some((x) => x.code === "price_move_unreadable")).toBe(true);
    expect(r.reasons.some((x) => x.code === "not_borrow_allowlisted")).toBe(true);
    // vault 43 IS on the launch collateral allowlist:
    expect(r.reasons.some((x) => x.code === "collateral_not_allowlisted")).toBe(false);
  });

  it("non-allowlisted vault id → collateral_not_allowlisted", () => {
    const r = evaluateBorrowPreview({
      walletAddress: WALLET,
      vault: vault({ vaultId: 99 }),
      exposureResult: emptyExposure(),
      collateralRaw: BigInt(10_000_000_000),
      existingDebtRaw: BigInt(0),
      requestedDebtRaw: BigInt(100_000_000),
      oracle: UNREADABLE_ORACLE_CONTEXT,
    });
    expect(r.reasons.some((x) => x.code === "collateral_not_allowlisted")).toBe(true);
  });

  it("owner wallet (env) clears the allowlist gate", () => {
    process.env.BORROW_OWNER_WALLET = WALLET;
    const r = evaluateBorrowPreview({
      walletAddress: WALLET,
      vault: vault(),
      exposureResult: emptyExposure(),
      collateralRaw: BigInt(10_000_000_000),
      existingDebtRaw: BigInt(0),
      requestedDebtRaw: BigInt(100_000_000),
      oracle: UNREADABLE_ORACLE_CONTEXT,
    });
    expect(r.reasons.some((x) => x.code === "not_borrow_allowlisted")).toBe(false);
    // Still denied on oracle (proves the env change only moved the allowlist gate):
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => x.code === "oracle_unreadable")).toBe(true);
  });
});

describe("previewBorrowEligibility (async wrapper, money-adjacent path)", () => {
  it("owner + allowlisted collateral + oracle unreadable still denies (the route's actual path)", async () => {
    process.env.BORROW_OWNER_WALLET = WALLET;
    const r = await previewBorrowEligibility(
      WALLET,
      {
        collateralMint: INF_MINT,
        collateralRaw: BigInt(10_000_000_000),
        requestedDebtRaw: BigInt(100_000_000),
      },
      {
        getVaultConfig: async () => vault(),
        getActiveBorrowPositionsAllWallets: async () => [],
      },
    );
    expect(r.ok).toBe(true);
    // Owner-wallet + vault 43 allowlisted → both allowlist gates clear, yet the
    // wrapper hardwires UNREADABLE_ORACLE_CONTEXT so the gate MUST still deny.
    expect(r.allowed).toBe(false);
    expect(r.reasons.some((x) => x.code === "not_borrow_allowlisted")).toBe(false);
    expect(r.reasons.some((x) => x.code === "collateral_not_allowlisted")).toBe(false);
    expect(r.reasons.some((x) => x.code === "oracle_unreadable")).toBe(true);
    expect(r.reasons.some((x) => x.code === "price_move_unreadable")).toBe(true);
    expect(r.projection!.projectedLtv).toBeCloseTo(0.05, 6);
  });

  it("unreadable vault config → wrapper denies without touching exposure", async () => {
    let exposureCalled = false;
    const r = await previewBorrowEligibility(
      WALLET,
      {
        collateralMint: INF_MINT,
        collateralRaw: BigInt(10_000_000_000),
        requestedDebtRaw: BigInt(100_000_000),
      },
      {
        getVaultConfig: async () => null,
        getActiveBorrowPositionsAllWallets: async () => {
          exposureCalled = true;
          return [];
        },
      },
    );
    expect(r.ok).toBe(false);
    expect(r.allowed).toBe(false);
    expect(r.reasons[0].code).toBe("vault_unreadable");
    expect(exposureCalled).toBe(false);
  });
});

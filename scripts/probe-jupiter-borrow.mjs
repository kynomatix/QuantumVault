/**
 * Phase A hard-gate probe (READ-ONLY, no money, no RPC, no API key).
 *
 * Proves we can authoritatively read the loan-risk surface from Jupiter Lend
 * (Fluid) borrow vaults BEFORE any code that moves money. Fetches live vault
 * config from the free lite-api and asserts every field our borrow engine
 * needs is present and non-empty:
 *   - borrowRate / supplyRate        (carry math)
 *   - collateralFactor               (max LTV the protocol allows)
 *   - liquidationThreshold           (where liquidation begins)
 *   - liquidationPenalty             (cost of being liquidated)
 *   - borrowLimitUtilization         (the audit's key catch: a full pool can
 *                                     block withdrawals/repay-routing)
 *   - withdrawable / borrowable      (live liquidity caps)
 *   - minimumBorrowing               (dust floor)
 *   - oraclePriceLiquidate           (the price liquidation uses)
 *   - lastUpdateTimestamp            (pool LIQUIDITY-state write time — NOT
 *                                     oracle price freshness. The real oracle
 *                                     staleness gate keys off the oracle's own
 *                                     on-chain publish time (readOraclePrice),
 *                                     never this field.)
 *
 * Run: node scripts/probe-jupiter-borrow.mjs
 */

const REQUIRED_TOP = [
  "borrowRate",
  "supplyRate",
  "collateralFactor",
  "liquidationThreshold",
  "liquidationPenalty",
  "borrowLimitUtilization",
  "minimumBorrowing",
  "borrowable",
  "withdrawable",
  "oraclePriceLiquidate",
];

function nonEmpty(v) {
  return v !== undefined && v !== null && String(v).length > 0;
}

async function main() {
  const { Client } = await import("@jup-ag/lend/api");
  const client = new Client(); // no key → https://lite-api.jup.ag/lend

  const started = Date.now();
  const vaults = await client.borrow.getVaults();
  const ms = Date.now() - started;

  console.log(`Fetched ${vaults.length} borrow vault(s) in ${ms}ms\n`);

  // We borrow USDC against collateral, so the vaults of interest have
  // borrowToken == USDC. Print those (the collateral is the supplyToken).
  const usdcBorrow = vaults.filter(
    (v) => (v.borrowToken?.symbol || "").toUpperCase() === "USDC",
  );
  console.log(
    `Vaults where you borrow USDC against collateral: ${usdcBorrow.length}`,
  );
  console.log(
    `Collateral assets available: ${usdcBorrow
      .map((v) => v.supplyToken?.symbol)
      .join(", ")}\n`,
  );

  let gatePass = true;

  for (const v of usdcBorrow) {
    const col = v.supplyToken?.symbol || "?";
    const missing = REQUIRED_TOP.filter((k) => !nonEmpty(v[k]));
    const freshTs = v.liquidityBorrowData?.lastUpdateTimestamp;
    const ageSec = freshTs ? Math.round(Date.now() / 1000 - Number(freshTs)) : null;
    if (missing.length) gatePass = false;

    console.log(`── ${col} → USDC  (vaultId ${v.id})`);
    console.log(`   borrowRate           ${v.borrowRate}`);
    console.log(`   supplyRate           ${v.supplyRate}`);
    console.log(`   collateralFactor     ${v.collateralFactor}`);
    console.log(`   liquidationThreshold ${v.liquidationThreshold}`);
    console.log(`   liquidationPenalty   ${v.liquidationPenalty}`);
    console.log(`   borrowFee            ${v.borrowFee}`);
    console.log(`   utilization          ${v.borrowLimitUtilization}`);
    console.log(`   minimumBorrowing     ${v.minimumBorrowing}`);
    console.log(`   borrowable (live)    ${v.borrowable}`);
    console.log(`   withdrawable (live)  ${v.withdrawable}`);
    console.log(`   oraclePriceLiquidate ${v.oraclePriceLiquidate}`);
    console.log(`   oraclePriceOperate   ${v.oraclePriceOperate}`);
    console.log(`   collateral price     ${v.supplyToken?.price}`);
    console.log(`   oracle source        ${v.oracleSources?.map((s) => Object.keys(s.sourceType || {}).join("")).join(",")}`);
    console.log(`   liquidity age (s)    ${ageSec === null ? "n/a" : ageSec}  (pool state, NOT oracle price age)`);
    if (missing.length) console.log(`   ⚠️ MISSING: ${missing.join(", ")}`);
    console.log("");
  }

  console.log(
    gatePass
      ? "✅ HARD GATE: every required risk field is present on every USDC-borrow vault."
      : "❌ HARD GATE FAILED: one or more required fields missing (see ⚠️ above).",
  );
}

main().catch((e) => {
  console.error("PROBE ERROR:", e?.message || e);
  process.exit(1);
});

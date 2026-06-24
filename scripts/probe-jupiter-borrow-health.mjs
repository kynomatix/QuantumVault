/**
 * Phase B hard-gate probe (READ-ONLY, NO money).
 *
 * Phase A proved the REST config read. Phase B proves the ON-CHAIN read path
 * the live-health monitor depends on, via our own RPC:
 *   1. REST getVaults()  → find the INF→USDC vault, decode its risk surface.
 *   2. getVaultsProgram() → the Anchor program loads against our RPC.
 *   3. readOraclePrice()  → the on-chain oracle price (the price the protocol
 *                           liquidates against), cross-checked vs the REST value.
 *   4. getFinalPosition() → simulate a hypothetical borrow from a SYNTHETIC
 *                           empty position (tick=INIT_TICK, col/debt=0). Bonus:
 *                           proves the on-chain simulate path, but a failure here
 *                           does NOT fail the gate (the SDK may require a real
 *                           position to simulate against — that is exercised in
 *                           Phase C against the first controlled position).
 *
 * getCurrentPosition() is intentionally NOT exercised: zero borrow positions
 * exist yet, so its end-to-end proof is deferred to Phase C's first position.
 *
 * Run: node scripts/probe-jupiter-borrow-health.mjs
 */

function resolveRpc() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return null;
}

function decode1e15(raw) {
  return Number(raw) / 1e15;
}

async function main() {
  let gatePass = true;

  // 1. REST config (proven Phase A; re-decoded here so the probe is self-contained).
  const { Client } = await import("@jup-ag/lend/api");
  const client = new Client();
  const vaults = await client.borrow.getVaults();
  const v = vaults.find(
    (x) =>
      String(x.supplyToken?.symbol || "").toUpperCase() === "INF" &&
      String(x.borrowToken?.symbol || "").toUpperCase() === "USDC",
  );
  if (!v) {
    console.error("❌ HARD GATE FAILED: no INF→USDC vault in the REST response.");
    process.exit(1);
  }

  const restPrice = decode1e15(v.oraclePriceLiquidate);
  console.log(`── INF → USDC  (vaultId ${v.id})`);
  console.log(`   oracle account        ${v.oracle}`);
  console.log(`   maxLtv (factor)       ${(Number(v.collateralFactor) / 1000 * 100).toFixed(1)}%`);
  console.log(`   liquidationThreshold  ${(Number(v.liquidationThreshold) / 1000 * 100).toFixed(1)}%`);
  console.log(`   liquidationPenalty    ${(Number(v.liquidationPenalty) / 10000 * 100).toFixed(2)}%`);
  console.log(`   borrowApr             ${(Number(v.borrowRate) / 10000 * 100).toFixed(2)}%`);
  console.log(`   utilization           ${(decode1e15(v.borrowLimitUtilization) * 100).toFixed(2)}%`);
  console.log(`   REST oracle price     $${restPrice.toFixed(4)}`);
  console.log("");

  // RPC-dependent steps.
  const rpc = resolveRpc();
  if (!rpc) {
    console.error("⚠️  No SOLANA_RPC_URL / HELIUS_API_KEY in env — skipping on-chain proof.");
    console.error("❌ HARD GATE INCOMPLETE: on-chain read path NOT proven (no RPC).");
    process.exit(1);
  }

  const { Connection, PublicKey } = await import("@solana/web3.js");
  const borrow = await import("@jup-ag/lend/borrow");
  const BN = (await import("bn.js")).default;
  const connection = new Connection(rpc, "confirmed");
  const READONLY_SIGNER = new PublicKey("11111111111111111111111111111111");

  // 2. Program loads.
  let program;
  try {
    program = borrow.getVaultsProgram({ connection, signer: READONLY_SIGNER });
    console.log(`   ✅ getVaultsProgram loaded (programId ${program?.programId?.toBase58?.() ?? "?"})`);
  } catch (e) {
    gatePass = false;
    console.log(`   ❌ getVaultsProgram failed: ${e?.message || e}`);
  }

  // 3. On-chain oracle read + cross-check vs REST.
  try {
    // Omit `signer`: with one the SDK routes through Anchor tx simulate (needs a
    // real fee-payer) and throws; without it, it does a plain account read.
    const reading = await borrow.readOraclePrice({
      connection,
      oracle: new PublicKey(v.oracle),
    });
    const onchain = decode1e15(String(reading.oraclePriceLiquidate ?? reading.oraclePriceOperate));
    const driftPct = restPrice > 0 ? Math.abs(onchain - restPrice) / restPrice * 100 : null;
    if (!(onchain > 0)) throw new Error("oracle price decoded to <= 0");
    console.log(`   ✅ readOraclePrice on-chain = $${onchain.toFixed(4)} (REST $${restPrice.toFixed(4)}, drift ${driftPct === null ? "n/a" : driftPct.toFixed(3) + "%"})`);
  } catch (e) {
    gatePass = false;
    console.log(`   ❌ readOraclePrice failed: ${e?.message || e}`);
  }

  // 4. On-chain simulate from a synthetic empty position (BONUS — does not gate).
  try {
    const colDecimals = Number(v.supplyToken.decimals);
    const colRaw = new BN((100 * 10 ** colDecimals).toString()); // 100 INF
    const debtRaw = new BN((5000 * 1e6).toString()); // 5000 USDC
    const synthetic = {
      tick: borrow.INIT_TICK,
      tickId: 0,
      colRaw: new BN(0),
      finalAmount: new BN(0),
      debtRaw: new BN(0),
      dustDebtRaw: new BN(0),
      isSupplyOnlyPosition: false,
      userLiquidationStatus: false,
      postLiquidationBranchId: 0,
    };
    const finalPos = await borrow.getFinalPosition({
      vaultId: v.id,
      currentPosition: synthetic,
      newColAmount: colRaw,
      newDebtAmount: debtRaw,
      program,
      connection,
      signer: READONLY_SIGNER,
    });
    console.log(`   ✅ getFinalPosition simulate (100 INF / 5000 USDC) → tick ${Number(finalPos.tick)}, col ${finalPos.colRaw?.toString()}, debt ${finalPos.debtRaw?.toString()}`);
  } catch (e) {
    console.log(`   ⚠️ getFinalPosition simulate from synthetic empty position not supported here (deferred to Phase C real position): ${e?.message || e}`);
  }

  console.log("");
  console.log(
    gatePass
      ? "✅ HARD GATE: on-chain borrow read path proven (program + oracle price) via our RPC."
      : "❌ HARD GATE FAILED: an on-chain read primitive failed (see ❌ above).",
  );
  if (!gatePass) process.exit(1);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e?.message || e);
  process.exit(1);
});

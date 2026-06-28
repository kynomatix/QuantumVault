/**
 * Phase C probe (READ-ONLY, NO money, NO UMK, NO wallet auth).
 *
 * Phases A/B proved the REST config read + the on-chain program/oracle read
 * path against a SYNTHETIC empty position. They explicitly DEFERRED the one
 * thing that needs a real position: `getCurrentPosition()`.
 *
 * This probe closes that gap. Point it at the FIRST controlled borrow position
 * (a user must open it from the app — the open path requires a live wallet
 * session UMK and cannot be driven headlessly) and it dumps EVERY field the
 * live-health monitor reads, raw + decoded, so we can validate:
 *   - colRaw / debtRaw / dustDebtRaw scaling (SDK normalizes to max(dec,9) dp)
 *   - tick, tickId, isSupplyOnlyPosition
 *   - userLiquidationStatus  (the at-risk boolean our alerts key off)
 *   - oracle price + derived LTV / healthFactor / liquidation distance
 *
 * `getCurrentPosition` is keyed by (vaultId, positionId) ONLY — no owner key,
 * no signing — so this is a pure public read.
 *
 * Run:
 *   node scripts/probe-jupiter-borrow-position.mjs --position <id> [--collateral INF]
 *
 * Tip: get <id> from the borrow_positions row after the app opens the position
 *   (SELECT position_id FROM borrow_positions WHERE wallet_address = '...').
 *
 * ★ To capture the LIQUIDATED read shape (the remaining unknown that gates the
 *   terminal "you were liquidated" alert): run this BEFORE and AFTER a real
 *   liquidation on the same (vaultId, positionId) and diff the raw dump.
 */

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function resolveRpc() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY) {
    return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  }
  return null;
}

const decode1e15 = (raw) => Number(raw) / 1e15;

// SDK position amounts come normalized to max(decimals, 9) dp. Convert to NATIVE
// token base units (matches positionRawToNativeRaw in jupiter-lend-borrow-route).
function positionRawToNative(posRawStr, decimals, mode) {
  const normDp = Math.max(decimals, 9);
  const scale = 10n ** BigInt(normDp - decimals);
  const v = BigInt(posRawStr);
  if (scale === 1n) return v;
  return mode === "ceil" ? (v + scale - 1n) / scale : v / scale; // ceil debt, floor collateral
}

// Recursively stringify BN / bigint so the raw dump is faithful.
function plain(x) {
  if (x == null) return x;
  if (typeof x === "bigint") return x.toString();
  if (typeof x === "object") {
    if (typeof x.toString === "function" && (x.constructor?.name === "BN" || x._bn)) {
      return x.toString();
    }
    if (Array.isArray(x)) return x.map(plain);
    const out = {};
    for (const k of Object.keys(x)) out[k] = plain(x[k]);
    return out;
  }
  return x;
}

async function main() {
  const collateralSymbol = (arg("collateral", "INF") || "INF").toUpperCase();
  const positionIdArg = arg("position");
  const positionId = positionIdArg != null ? Number(positionIdArg) : null;

  // 1. REST vault config (proven Phase A) → vaultId, decimals, thresholds, oracle.
  const { Client } = await import("@jup-ag/lend/api");
  const client = new Client();
  const vaults = await client.borrow.getVaults();
  const v = vaults.find(
    (x) =>
      String(x.supplyToken?.symbol || "").toUpperCase() === collateralSymbol &&
      String(x.borrowToken?.symbol || "").toUpperCase() === "USDC",
  );
  if (!v) {
    console.error(`❌ no ${collateralSymbol}→USDC vault in the REST response.`);
    process.exit(1);
  }

  const colDecimals = Number(v.supplyToken.decimals);
  const debtDecimals = Number(v.borrowToken.decimals);
  // NB: decode scales (/1000 for factor & threshold, /10000 for penalty) are
  // copied from the existing probes and are themselves PART of what this run
  // validates — eyeball raw vs decoded below.
  const maxLtvFrac = Number(v.collateralFactor) / 1000;
  const thresholdFrac = Number(v.liquidationThreshold) / 1000;
  const penaltyFrac = Number(v.liquidationPenalty) / 10000;
  const restPrice = decode1e15(v.oraclePriceLiquidate);

  console.log(`── ${collateralSymbol} → USDC   vaultId ${v.id}`);
  console.log(`   collateral decimals   ${colDecimals}   debt decimals ${debtDecimals}`);
  console.log(`   maxLtv (factor)       raw ${v.collateralFactor}  → ${(maxLtvFrac * 100).toFixed(1)}%`);
  console.log(`   liquidationThreshold  raw ${v.liquidationThreshold}  → ${(thresholdFrac * 100).toFixed(1)}%`);
  console.log(`   liquidationPenalty    raw ${v.liquidationPenalty}  → ${(penaltyFrac * 100).toFixed(2)}%`);
  console.log(`   oracle account        ${v.oracle}`);
  console.log("");

  // 2. On-chain oracle price (the price the protocol liquidates against).
  const rpc = resolveRpc();
  if (!rpc) {
    console.error("❌ no SOLANA_RPC_URL / HELIUS_API_KEY — cannot do on-chain read.");
    process.exit(1);
  }
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const borrow = await import("@jup-ag/lend/borrow");
  const connection = new Connection(rpc, "confirmed");

  let oraclePriceUsd = restPrice;
  try {
    const reading = await borrow.readOraclePrice({ connection, oracle: new PublicKey(v.oracle) });
    oraclePriceUsd = decode1e15(String(reading.oraclePriceLiquidate ?? reading.oraclePriceOperate));
    console.log(`   on-chain oracle price $${oraclePriceUsd.toFixed(4)}  (REST $${restPrice.toFixed(4)})`);
  } catch (e) {
    console.log(`   ⚠️ readOraclePrice failed, falling back to REST price: ${e?.message || e}`);
  }
  console.log("");

  if (positionId == null || !Number.isInteger(positionId) || positionId <= 0) {
    console.log("ℹ️  No valid --position <id> given. Vault config + oracle proven above.");
    console.log("    Re-run with --position <id> once the app has opened the position.");
    return;
  }

  // 3. THE deferred read: getCurrentPosition (vaultId, positionId) — public read.
  let pos;
  try {
    pos = await borrow.getCurrentPosition({ vaultId: v.id, positionId, connection });
  } catch (e) {
    console.error(`❌ getCurrentPosition threw for (vault ${v.id}, position ${positionId}): ${e?.message || e}`);
    process.exit(1);
  }
  if (!pos) {
    console.error(`❌ getCurrentPosition returned null for (vault ${v.id}, position ${positionId}).`);
    console.error("   Either the position doesn't exist yet, or the id is wrong.");
    process.exit(1);
  }

  console.log(`✅ getCurrentPosition(vault ${v.id}, position ${positionId}) — RAW dump:`);
  console.log(JSON.stringify(plain(pos), null, 2));
  console.log("");

  // 4. Field presence gate (mirrors readLivePositionHealth's fail-closed check).
  const need = ["colRaw", "debtRaw", "tick", "userLiquidationStatus"];
  const missing = need.filter((k) => pos[k] == null);
  if (missing.length) {
    console.log(`⚠️  MISSING fields our engine needs: ${missing.join(", ")} (engine fails CLOSED on these).`);
  } else {
    console.log("✅ all engine-required fields present (colRaw, debtRaw, tick, userLiquidationStatus).");
  }

  if (pos.colRaw == null || pos.debtRaw == null) {
    console.log("   colRaw/debtRaw unreadable → cannot derive health. Stop.");
    return;
  }

  // 5. Decode to native + derive LTV / healthFactor / liquidation distance.
  const colNativeRaw = positionRawToNative(pos.colRaw.toString(), colDecimals, "floor");
  const debtNativeRaw = positionRawToNative(pos.debtRaw.toString(), debtDecimals, "ceil");
  const dustDebtRaw = pos.dustDebtRaw != null ? pos.dustDebtRaw.toString() : "n/a";

  const colTokens = Number(colNativeRaw) / 10 ** colDecimals;
  const debtTokens = Number(debtNativeRaw) / 10 ** debtDecimals;
  const collateralValueUsd = colTokens * oraclePriceUsd;
  const debtUsd = debtTokens; // USDC ≈ $1
  const ltv = collateralValueUsd > 0 ? debtUsd / collateralValueUsd : null;
  const healthFactor = debtUsd > 0 ? (collateralValueUsd * thresholdFrac) / debtUsd : null;

  console.log("");
  console.log("── DECODED ──────────────────────────────────────────");
  console.log(`   colRaw (norm)         ${pos.colRaw.toString()}  → native ${colNativeRaw}  (${colTokens} ${collateralSymbol})`);
  console.log(`   debtRaw (norm)        ${pos.debtRaw.toString()}  → native ${debtNativeRaw}  (${debtTokens} USDC)`);
  console.log(`   dustDebtRaw           ${dustDebtRaw}`);
  console.log(`   tick / tickId         ${Number(pos.tick)} / ${pos.tickId != null ? Number(pos.tickId) : "n/a"}`);
  console.log(`   isSupplyOnlyPosition  ${pos.isSupplyOnlyPosition}`);
  console.log(`   userLiquidationStatus ${pos.userLiquidationStatus}  ← at-risk boolean`);
  console.log("");
  console.log(`   collateral value      $${collateralValueUsd.toFixed(4)}`);
  console.log(`   debt                  $${debtUsd.toFixed(4)}`);
  console.log(`   LTV                   ${ltv == null ? "n/a" : (ltv * 100).toFixed(2) + "%"}  (max-open ${(maxLtvFrac * 100).toFixed(1)}%, liq @ ${(thresholdFrac * 100).toFixed(1)}%)`);
  console.log(`   healthFactor          ${healthFactor == null ? "n/a (no debt)" : healthFactor.toFixed(3)}  (>1 safe, <=1 liquidatable)`);
  if (ltv != null) {
    const headroomPct = (thresholdFrac - ltv) * 100;
    console.log(`   headroom to liq        ${headroomPct.toFixed(2)} percentage points of LTV`);
  }
  console.log("");
  console.log("Done. Validate the decoded numbers against an explorer / the app UI.");
}

main().catch((e) => {
  console.error("PROBE ERROR:", e?.message || e);
  process.exit(1);
});

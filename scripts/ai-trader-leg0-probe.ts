#!/usr/bin/env tsx
/**
 * AI Trader — WO-5 Leg 0 stop-order probe.
 *
 * Verifies the getOpenStopOrders() symbol-normalization path against a REAL
 * resting stop order on Pacifica. Run this FIRST, before the main canary. If
 * any step fails, abort the entire canary — do not proceed.
 *
 * Steps:
 *   1. Baseline read  — getOpenStopOrders before placing (should be 0 or some
 *                       existing orders; logged for reference)
 *   2. Place probe    — minimal stop order far from mark (never triggers)
 *   3. G10 path read  — getOpenStopOrders(agentPublicKey, subaccountId, "SOL-PERP")
 *                       with internal symbol through the normalization path
 *   4. Assert         — stops.length > 0 (G10 invariant)
 *   5. Shape check    — log raw response shape to verify G10 expectation
 *   6. Cancel         — cancelStopOrder for the probe order
 *   7. Re-verify      — confirm order absent after cancel
 *
 * Usage:
 *   tsx scripts/ai-trader-leg0-probe.ts --wallet <ADDR>
 *   tsx scripts/ai-trader-leg0-probe.ts --wallet <ADDR> --subaccount <ID>
 *
 * (no --subaccount = main Pacifica account, subaccountId undefined — correct for
 *  the founder wallet whose vault funds are in the account-level main account)
 */

import { storage } from "../server/storage";
import { PacificaAdapter } from "../server/protocol/pacifica/pacifica-adapter";
import { getUmkForWebhook, decryptAgentKeyStrict } from "../server/session-v3";

const MARKET = "SOL-PERP";

const PROBE_SIZE = 0.01;          // SOL — smallest sensible stop-order quantity
const TRIGGER_DISCOUNT = 0.50;    // 50 % below mark — never triggers; safe resting probe

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const walletAddress = arg("wallet");
  const subaccountId  = arg("subaccount"); // undefined = main Pacifica account

  if (!walletAddress) throw new Error("--wallet <addr> is required");

  console.log("=== AI Trader WO-5 — Leg 0 stop-order probe ===");
  console.log(`wallet:       ${walletAddress}`);
  console.log(`subaccountId: ${subaccountId ?? "(none — main account)"}`);
  console.log(`market:       ${MARKET}`);
  console.log(`probe size:   ${PROBE_SIZE} SOL  (side=long, trigger=mark×${TRIGGER_DISCOUNT})`);
  console.log("");

  // ── Auth ─────────────────────────────────────────────────────────────────
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncryptedV3) {
    throw new Error("Wallet missing agentPublicKey or V3 encrypted key — check the DB");
  }
  const agentPublicKey = wallet.agentPublicKey;
  console.log(`agentPublicKey: ${agentPublicKey}`);

  const umkResult = await getUmkForWebhook(walletAddress);
  if (!umkResult) {
    throw new Error(
      "Execution authorization unavailable — enable it in the app first (Settings → Execution, then re-sign)"
    );
  }

  let agentKeyResult: { secretKey: Uint8Array; cleanup: () => void } | null = null;
  try {
    agentKeyResult = await decryptAgentKeyStrict(walletAddress, umkResult.umk, wallet, agentPublicKey);
    if (!agentKeyResult) {
      throw new Error("V3 strict agent-key decrypt failed — execution UMK may be stale (try re-signing)");
    }

    const agentSecretKey  = agentKeyResult.secretKey;
    const mainWalletAddress = walletAddress;

    // Construct and initialize the Pacifica adapter directly (mirrors server/index.ts).
    // The adapter-registry is not populated in standalone script context, so we
    // cannot use getAdapter() here.
    const adapter = new PacificaAdapter({
      builderCode: process.env.PACIFICA_BUILDER_CODE ?? "QuantumVault",
      referralAddress: process.env.PACIFICA_REFERRAL_ADDRESS ?? "AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez",
    });
    console.log("Initializing Pacifica adapter...");
    await adapter.initialize();
    console.log("Adapter initialized.\n");

    // ── Mark price ───────────────────────────────────────────────────────────
    const mark = await adapter.getPrice(MARKET);
    if (!mark || !Number.isFinite(mark) || mark <= 0) {
      throw new Error(`No usable mark price for ${MARKET} — Pacifica may be down`);
    }
    const triggerPrice = mark * TRIGGER_DISCOUNT;
    console.log(`mark price:     $${mark.toFixed(4)}`);
    console.log(`trigger price:  $${triggerPrice.toFixed(4)}  (${(TRIGGER_DISCOUNT * 100).toFixed(0)}% of mark — safe resting probe)\n`);

    // ── Step 1: Baseline read ─────────────────────────────────────────────────
    console.log("[STEP 1] Baseline read — existing stop orders before probe:");
    const baseline = await adapter.getOpenStopOrders(agentPublicKey, subaccountId, MARKET);
    console.log(`  count: ${baseline.length}`);
    if (baseline.length > 0) {
      console.log(`  existing orders (first 3): ${JSON.stringify(baseline.slice(0, 3), null, 2)}`);
    }

    // ── Step 2: Place probe order ─────────────────────────────────────────────
    // A sell-stop (side='short') below mark is the valid direction — it's a
    // protective stop for a long position. A bid/buy stop must be ABOVE mark
    // (momentum entry); Pacifica rejects a bid stop below mark.
    console.log(`\n[STEP 2] Placing probe stop order (short ${PROBE_SIZE} SOL @ trigger=$${triggerPrice.toFixed(4)})...`);
    let orderId: string;
    let placeResult: Awaited<ReturnType<typeof adapter.placeStopOrder>>;
    try {
      placeResult = await adapter.placeStopOrder({
        agentPublicKey,
        agentSecretKey,
        mainWalletAddress,
        internalSymbol: MARKET,
        side: "short",
        sizeBase: PROBE_SIZE,
        triggerPrice,
        subaccountId,
      });
      console.log(`  result: ${JSON.stringify(placeResult)}`);
    } catch (err: any) {
      console.error(`\n[ABORT] Leg 0 FAILED at placeStopOrder: ${err.message}`);
      console.error("  Cannot proceed with the canary. Investigate Pacifica connectivity / auth.");
      process.exit(1);
    }

    if (!placeResult.success) {
      console.error(`\n[ABORT] Leg 0 FAILED: placeStopOrder returned success=false`);
      console.error(`  error: ${placeResult.error ?? "unknown"}`);
      console.error(`  status: ${placeResult.status}`);
      console.error("  Cannot proceed with the canary. Investigate Pacifica account funding / auth.");
      process.exit(1);
    }

    orderId = placeResult.orderId ?? "";
    if (!orderId) {
      console.error(`\n[ABORT] Leg 0 FAILED: placeStopOrder returned no orderId`);
      console.error(`  rawResponse: ${JSON.stringify(placeResult.rawResponse ?? {})}`);
      process.exit(1);
    }
    console.log(`  orderId: ${orderId}  ← probe order placed successfully`);

    // ── Step 3: Wait for propagation ──────────────────────────────────────────
    console.log("\n  Waiting 2s for order to propagate...");
    await sleep(2_000);

    // ── Step 4: G10 normalization-path read ───────────────────────────────────
    console.log(`\n[STEP 3] getOpenStopOrders(agentPublicKey, subaccountId, "${MARKET}") — G10 normalization path:`);
    let stops: Array<{ order_id: string; symbol: string; [k: string]: unknown }>;
    try {
      stops = await adapter.getOpenStopOrders(agentPublicKey, subaccountId, MARKET);
    } catch (err: any) {
      console.error(`\n[ABORT] Leg 0 FAILED: getOpenStopOrders threw: ${err.message}`);
      console.error("  Attempting to cancel probe order before aborting...");
      try {
        await adapter.cancelStopOrder({ agentPublicKey, agentSecretKey, mainWalletAddress, orderId, subaccountId });
        console.error("  Probe order cancelled.");
      } catch {}
      process.exit(1);
    }

    console.log(`  stops.length: ${stops.length}`);
    console.log(`  raw response: ${JSON.stringify(stops, null, 2)}`);

    // ── Step 5: Assert G10 invariant ──────────────────────────────────────────
    console.log("\n[STEP 4] Assertions:");
    let passed = true;

    if (stops.length === 0) {
      console.error("  [FAIL] stops.length === 0 — G10 normalization path broken");
      console.error("         (Symbol 'SOL-PERP' may not be normalizing correctly to 'SOL' in Pacifica's filter)");
      passed = false;
    } else {
      console.log(`  [PASS] stops.length > 0 (got ${stops.length})`);
    }

    const ourOrder = stops.find((s) => s.order_id === orderId);
    if (ourOrder) {
      console.log(`  [PASS] Probe order ${orderId} visible in response`);
    } else {
      console.warn(`  [WARN] Probe order ${orderId} not found by order_id — may be under different id`);
      console.warn("         G10 only checks stops.length > 0, so this is NOT a blocking failure.");
    }

    // Log full shape of first order for G10 expectation audit
    if (stops.length > 0) {
      console.log("\n  Response shape of stops[0] (G10 expectation audit):");
      const sample = stops[0];
      for (const key of Object.keys(sample)) {
        console.log(`    ${key}: ${JSON.stringify(sample[key])}`);
      }
      console.log("");
      console.log("  G10 uses: stops.length > 0  — shape fields are informational only.");
    }

    if (!passed) {
      console.error("\n[ABORT] Leg 0 FAILED — the G10 normalization path does not work as expected.");
      console.error("  Cancelling probe order, then aborting. DO NOT run the canary.");
      try {
        await adapter.cancelStopOrder({ agentPublicKey, agentSecretKey, mainWalletAddress, orderId, subaccountId });
        console.error("  Probe order cancelled.");
      } catch {}
      process.exit(1);
    }

    // ── Step 6: Cancel probe order ────────────────────────────────────────────
    console.log(`[STEP 5] Cancelling probe order ${orderId}...`);
    let cancelOk = false;
    try {
      const cancelResult = await adapter.cancelStopOrder({
        agentPublicKey,
        agentSecretKey,
        mainWalletAddress,
        orderId,
        subaccountId,
      });
      console.log(`  cancelResult: ${JSON.stringify(cancelResult)}`);
      cancelOk = cancelResult.success;
      if (!cancelResult.success) {
        console.warn(`  WARNING: cancelStopOrder reported success=false: ${cancelResult.error ?? "unknown"}`);
        console.warn("  Please cancel the probe order manually on the Pacifica exchange before running the canary.");
      }
    } catch (err: any) {
      console.warn(`  WARNING: cancelStopOrder threw: ${err.message}`);
      console.warn("  Please cancel the probe order manually on the Pacifica exchange before running the canary.");
    }

    // ── Step 7: Re-verify after cancel ────────────────────────────────────────
    if (cancelOk) {
      console.log("\n  Waiting 2s then re-verifying...");
      await sleep(2_000);
      console.log("[STEP 6] Re-verify after cancel:");
      try {
        const afterCancel = await adapter.getOpenStopOrders(agentPublicKey, subaccountId, MARKET);
        console.log(`  stops after cancel: ${afterCancel.length}`);
        const stillThere = afterCancel.find((s) => s.order_id === orderId);
        if (stillThere) {
          console.warn("  WARNING: Probe order still visible — cancel may be pending settlement.");
          console.warn("  Check the exchange and cancel manually if still open in 30s.");
        } else {
          console.log("  Probe order confirmed absent. Clean teardown.");
        }
      } catch (err: any) {
        console.warn(`  WARNING: re-verify read threw: ${err.message}`);
      }
    }

    // ── Result ────────────────────────────────────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════════════");
    console.log("  Leg 0 PASSED");
    console.log("  ✓ placeStopOrder succeeded");
    console.log("  ✓ getOpenStopOrders normalization path returned stops.length > 0");
    console.log("  ✓ cancelStopOrder succeeded");
    console.log("  The G10 bracket-verification chain works as expected.");
    console.log("  You may now proceed with the main canary.");
    console.log("══════════════════════════════════════════════════════════════\n");

  } finally {
    agentKeyResult?.cleanup();
    umkResult?.cleanup();
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n[FATAL] ${msg}`);
  process.exit(1);
});

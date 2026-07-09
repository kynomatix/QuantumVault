#!/usr/bin/env tsx
/**
 * Diagnostic: checks open stop orders for both key addresses,
 * then attempts to cancel a given order id.
 * Usage: tsx scripts/_leg0-debug.ts [orderId]
 */
import { PacificaAdapter } from "../server/protocol/pacifica/pacifica-adapter";
import { storage } from "../server/storage";
import { getUmkForWebhook, decryptAgentKeyStrict } from "../server/session-v3";

const WALLET    = "AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez";
const AGENT_KEY = "G2dCmSk2gtwJAD6pVCXXQv3nCb4n5pzC4wo6fouJYELr";
const CANCEL_ID = process.argv[2] ?? "10482739298";

async function safeGet(adapter: any, path: string, params: Record<string, string>): Promise<unknown> {
  try {
    return await adapter.get(path, params);
  } catch (err: any) {
    return `ERROR: ${err.message}`;
  }
}

(async () => {
  const adapter = new PacificaAdapter({
    builderCode: "QuantumVault",
    referralAddress: WALLET,
  });
  await adapter.initialize();

  console.log("=== GET /orders/stop — agent key, no symbol ===");
  console.log(JSON.stringify(await safeGet(adapter, "/orders/stop", { account: AGENT_KEY }), null, 2));

  console.log("\n=== GET /orders/stop — main wallet, no symbol ===");
  console.log(JSON.stringify(await safeGet(adapter, "/orders/stop", { account: WALLET }), null, 2));

  console.log("\n=== GET /orders/stop — agent key, symbol=SOL ===");
  console.log(JSON.stringify(await safeGet(adapter, "/orders/stop", { account: AGENT_KEY, symbol: "SOL" }), null, 2));

  console.log("\n=== GET /orders/stop — main wallet, symbol=SOL ===");
  console.log(JSON.stringify(await safeGet(adapter, "/orders/stop", { account: WALLET, symbol: "SOL" }), null, 2));

  // Also check /positions/tpsl in case stop orders appear there
  console.log("\n=== GET /positions/tpsl — agent key ===");
  console.log(JSON.stringify(await safeGet(adapter, "/positions/tpsl", { account: AGENT_KEY }), null, 2));

  // Decrypt key and attempt cancel
  console.log(`\n=== Attempting cancel of order ${CANCEL_ID} ===`);
  const wallet = await storage.getWallet(WALLET);
  if (!wallet) { console.error("wallet not found"); process.exit(1); }
  const umkResult = await getUmkForWebhook(wallet);
  if (!umkResult.success || !umkResult.umk) {
    console.error("UMK not available — re-sign in the app first");
    process.exit(1);
  }
  const agentKeyResult = await decryptAgentKeyStrict(WALLET, umkResult.umk, wallet, AGENT_KEY);
  if (!agentKeyResult) { console.error("key decrypt failed"); process.exit(1); }

  try {
    const cr = await adapter.cancelStopOrder({
      agentPublicKey: AGENT_KEY,
      agentSecretKey: agentKeyResult.secretKey,
      mainWalletAddress: WALLET,
      orderId: CANCEL_ID,
    });
    console.log("cancelResult:", JSON.stringify(cr));
  } catch (err: any) {
    console.log("cancel threw:", err.message);
  } finally {
    agentKeyResult.cleanup();
  }

  // Re-query after cancel attempt
  console.log("\n=== GET /orders/stop — agent key, after cancel attempt ===");
  console.log(JSON.stringify(await safeGet(adapter, "/orders/stop", { account: AGENT_KEY }), null, 2));
})();

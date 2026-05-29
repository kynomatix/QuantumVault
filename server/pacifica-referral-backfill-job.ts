import { storage } from "./storage";
import { getUmkForWebhook, decryptAgentKeyStrict } from "./session-v3";
import { getAdapter } from "./protocol/adapter-registry";
import type { PacificaAdapter } from "./protocol/pacifica/pacifica-adapter";

const BACKFILL_INTERVAL_MS = 30 * 60 * 1000; // Every 30 minutes
const INITIAL_DELAY_MS = 60_000; // run ~60s after startup (after adapter init)
const PER_WALLET_DELAY_MS = 500; // gentle spacing to respect Pacifica rate limits

/**
 * One-time-per-account backfill of the Pacifica referral claim on existing
 * MAIN agent wallets.
 *
 * Why this exists: until the Phase 4b fix, the trade path called
 * ensurePacificaEnrollment with the BOT SUBACCOUNT key, so the referral claim
 * was attempted on subaccounts and rejected ("Only main accounts can claim
 * referral codes" — Pacifica requires the claiming wallet to have itself
 * deposited). The result is that existing main accounts were never enrolled as
 * referees. New accounts now get claimed at provision time, but pre-existing
 * ones need a backfill.
 *
 * This job decrypts each eligible wallet's MAIN agent key server-side (no user
 * session) using the proven webhook pattern — getUmkForWebhook +
 * decryptAgentKeyStrict — and calls the adapter's claimReferralCodeForUser with
 * accountKind:'wallet'. On success the adapter flips wallets.pacifica_referral_
 * claimed, so the wallet is skipped on subsequent runs. It is fail-OPEN and
 * idempotent: wallets that can't be processed (execution disabled, no deposit
 * yet, transient error) are simply retried next cycle.
 */
export async function backfillPacificaReferralClaims(): Promise<{ processed: number; claimed: number; skipped: number; failed: number }> {
  const results = { processed: 0, claimed: 0, skipped: 0, failed: 0 };

  // Resolve the Pacifica adapter. If it isn't registered/ready yet, bail quietly
  // — the next cycle will pick it up.
  let adapter: PacificaAdapter;
  try {
    adapter = getAdapter("pacifica") as unknown as PacificaAdapter;
  } catch {
    console.warn("[PacificaReferralBackfill] Pacifica adapter not registered yet; skipping this cycle");
    return results;
  }

  // Only main accounts that have a bot have deposited on Pacifica (subaccounts
  // are funded by transfer from the main account during bot provisioning). That
  // deposit is the prerequisite for a referral claim, so this is the right
  // candidate set.
  const walletAddresses = await storage.getWalletsWithTradingBots();
  if (walletAddresses.length === 0) return results;

  for (const walletAddress of walletAddresses) {
    const wallet = await storage.getWallet(walletAddress);

    // Skip if already claimed, or not V3-configured. The strict decrypt below is
    // the source of truth — legacy blob is intentionally not part of the gate.
    if (!wallet || wallet.pacificaReferralClaimed) {
      results.skipped++;
      continue;
    }
    if (!wallet.agentPublicKey || !wallet.agentPrivateKeyEncryptedV3) {
      results.skipped++;
      continue;
    }

    results.processed++;

    // Decrypt the MAIN agent key server-side. Execution-disabled / emergency-
    // stopped wallets return null here — skip without penalty (retried later).
    const umkResult = await getUmkForWebhook(walletAddress);
    if (!umkResult) {
      results.skipped++;
      continue;
    }

    const agentKeyResult = await decryptAgentKeyStrict(
      walletAddress,
      umkResult.umk,
      wallet,
      wallet.agentPublicKey,
    );
    if (!agentKeyResult) {
      umkResult.cleanup();
      console.error(`[PacificaReferralBackfill] V3 strict decrypt failed for ${walletAddress.slice(0, 8)}...; will retry next cycle`);
      results.failed++;
      continue;
    }

    try {
      const claimed = await adapter.claimReferralCodeForUser({
        agentPublicKey: wallet.agentPublicKey,
        agentSecretKey: agentKeyResult.secretKey,
        accountKind: "wallet",
      });
      if (claimed) {
        console.log(`[PacificaReferralBackfill] Claimed referral for main account ${walletAddress.slice(0, 8)}...`);
        results.claimed++;
      } else {
        // claimReferralCodeForUser is fail-OPEN and already logs the reason
        // (e.g. wallet has not deposited yet). Leave the flag false so it
        // retries next cycle.
        results.failed++;
      }
    } catch (err: any) {
      console.error(`[PacificaReferralBackfill] Claim threw for ${walletAddress.slice(0, 8)}...:`, err?.message || err);
      results.failed++;
    } finally {
      agentKeyResult.cleanup();
      umkResult.cleanup();
    }

    // Gentle spacing between accounts to stay well under Pacifica's
    // 300 credits / 60s rolling rate limit.
    await new Promise((resolve) => setTimeout(resolve, PER_WALLET_DELAY_MS));
  }

  if (results.processed > 0) {
    console.log(`[PacificaReferralBackfill] Complete: ${results.claimed} claimed, ${results.failed} failed, ${results.skipped} skipped (of ${walletAddresses.length} candidates)`);
  }
  return results;
}

let backfillRunning = false;

export function startPacificaReferralBackfillJob(): void {
  console.log("[PacificaReferralBackfill] Starting Pacifica referral backfill service (every 30 minutes)");

  const runOnce = async () => {
    // Single-run guard: a slow pass (many wallets × 500ms spacing) must never
    // overlap with the next interval tick — stacked runs would multiply the
    // Pacifica credit pressure we're spacing to avoid.
    if (backfillRunning) {
      console.log("[PacificaReferralBackfill] Previous run still in progress; skipping this tick");
      return;
    }
    backfillRunning = true;
    try {
      await backfillPacificaReferralClaims();
    } catch (err: any) {
      const msg = err?.message || "";
      if (msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("timeout exceeded") || msg.includes("too many clients") || msg.includes("Connection terminated")) {
        console.warn("[PacificaReferralBackfill] DB timeout — will retry next cycle");
      } else {
        console.error("[PacificaReferralBackfill] Run failed:", err?.message || err);
      }
    } finally {
      backfillRunning = false;
    }
  };

  setTimeout(runOnce, INITIAL_DELAY_MS);
  setInterval(runOnce, BACKFILL_INTERVAL_MS);
}

import { storage } from "./storage";
import { getUmkForWebhook, decryptAgentKeyStrict } from "./session-v3";

/**
 * V3 Phase 4: close an orphaned DRIFT subaccount to reclaim its ~0.023 SOL of
 * on-chain rent, using a strict-decrypted agent key (plaintext Uint8Array). The
 * legacy encrypted blob stored on the orphaned row is intentionally ignored — we
 * always go through UMK + the wallet's v3 envelope so a single source of truth
 * covers all background paths.
 *
 * `orphaned_subaccounts` is a Drift-only table by construction (numeric
 * `drift_subaccount_id`, no protocol column — produced only by the Drift
 * delete/unsubscribe paths). Pacifica subaccounts are recycled via the
 * `protocol_subaccounts` pool and Flash bots have no subaccount, so neither ever
 * lands here. We therefore route straight to the real working close in
 * drift-service (agent-signed on-chain `deleteSubaccount` in the Drift
 * subprocess) — NOT through the default adapter, which post-cutover is Pacifica
 * and has no real close (this background job was silently no-op'ing before).
 * Dynamic import keeps the Drift SDK out of this job's static boot graph.
 */
async function tryCloseDriftSubaccount(agentSecretKey: Uint8Array, subaccountId: number): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const { closeDriftSubaccount } = await import('./drift-service');
    return await closeDriftSubaccount(agentSecretKey, subaccountId);
  } catch (err: any) {
    return { success: false, error: err.message || 'drift close unavailable' };
  }
}

let isCleanupRunning = false;

export async function cleanupOrphanedSubaccounts(): Promise<void> {
  if (isCleanupRunning) {
    console.log("[OrphanedCleanup] Cleanup already in progress, skipping this cycle");
    return;
  }
  
  isCleanupRunning = true;
  
  try {
    const orphaned = await storage.getOrphanedSubaccounts();
    
    if (orphaned.length === 0) {
      return;
    }
    
    const pending = orphaned.filter(o => o.retryCount < 5);
    const maxedOut = orphaned.filter(o => o.retryCount >= 5);
    
    if (maxedOut.length > 0) {
      console.warn(`[OrphanedCleanup] WARNING: ${maxedOut.length} subaccount(s) exceeded max retries and cannot be automatically recovered:`);
      for (const entry of maxedOut) {
        console.warn(`  - Subaccount ${entry.driftSubaccountId} for wallet ${entry.walletAddress} (${entry.retryCount} retries, reason: ${entry.reason || 'unknown'})`);
      }
      console.warn(`[OrphanedCleanup] These subaccounts have ~0.023 SOL locked rent. User may need to use "Reset Drift Account" in Settings.`);
    }
    
    if (pending.length === 0) {
      return;
    }
    
    console.log(`[OrphanedCleanup] Found ${pending.length} orphaned subaccounts to clean up`);
    
    for (const entry of pending) {
      console.log(`[OrphanedCleanup] Attempting to close subaccount ${entry.driftSubaccountId} (retry ${entry.retryCount + 1}/5)`);
      
      try {
        // V3 Phase 4: strict-decrypt the agent key via UMK + the wallet's v3
        // envelope. Auth-unavailable states (missing V3 envelope, execution
        // disabled / emergency-stopped, strict decrypt failure) DO NOT burn
        // the 5-attempt retry budget — bumping retry_count for an auth-paused
        // wallet would permanently max out cleanup before the user can
        // re-enable execution. Defer to the next cleanup cycle instead.
        const wallet = await storage.getWallet(entry.walletAddress);
        if (!wallet?.agentPublicKey || !wallet?.agentPrivateKeyEncryptedV3) {
          console.warn(`[OrphanedCleanup] Wallet ${entry.walletAddress.slice(0,8)}... missing V3 envelope or public key; deferring (retry budget preserved)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        const umkResult = await getUmkForWebhook(entry.walletAddress);
        if (!umkResult) {
          const reason = wallet.emergencyStopTriggered ? 'emergency_stopped' : 'execution_disabled';
          console.warn(`[OrphanedCleanup] Wallet ${entry.walletAddress.slice(0,8)}...: ${reason}; deferring (retry budget preserved)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }
        const agentKeyResult = await decryptAgentKeyStrict(
          entry.walletAddress,
          umkResult.umk,
          wallet,
          wallet.agentPublicKey,
        );
        if (!agentKeyResult) {
          umkResult.cleanup();
          console.error(`[OrphanedCleanup] V3 strict decrypt failed for ${entry.walletAddress.slice(0,8)}...; deferring (retry budget preserved)`);
          await new Promise(resolve => setTimeout(resolve, 2000));
          continue;
        }

        let result;
        try {
          result = await tryCloseDriftSubaccount(
            agentKeyResult.secretKey,
            entry.driftSubaccountId
          );
        } finally {
          agentKeyResult.cleanup();
          umkResult.cleanup();
        }
        
        if (result.success) {
          console.log(`[OrphanedCleanup] Successfully closed subaccount ${entry.driftSubaccountId}, rent reclaimed: ${result.signature}`);
          await storage.deleteOrphanedSubaccount(entry.id);
        } else {
          console.warn(`[OrphanedCleanup] Failed to close subaccount ${entry.driftSubaccountId}: ${result.error}`);
          await storage.updateOrphanedSubaccountRetry(entry.id);
        }
      } catch (error: any) {
        console.error(`[OrphanedCleanup] Error closing subaccount ${entry.driftSubaccountId}:`, error.message);
        await storage.updateOrphanedSubaccountRetry(entry.id);
      }
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log(`[OrphanedCleanup] Cleanup cycle complete`);
  } catch (error: any) {
    const msg = error?.message || "";
    if (msg.includes("Authentication timed out") || msg.includes("connection timeout") || msg.includes("timeout exceeded") || msg.includes("too many clients") || msg.includes("Connection terminated")) {
      console.warn("[OrphanedCleanup] DB timeout — will retry next cycle");
    } else {
      console.error("[OrphanedCleanup] Error during cleanup:", error);
    }
  } finally {
    isCleanupRunning = false;
  }
}

export function startOrphanedSubaccountCleanup(): void {
  console.log("[OrphanedCleanup] Starting orphaned subaccount cleanup service");
  
  setTimeout(() => cleanupOrphanedSubaccounts(), 5000);
  
  setInterval(() => {
    cleanupOrphanedSubaccounts();
  }, 10 * 60 * 1000);
}

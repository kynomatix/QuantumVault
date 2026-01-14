import { storage } from "./storage";
import { closeDriftSubaccount } from "./drift-service";

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
        const result = await closeDriftSubaccount(
          entry.agentPrivateKeyEncrypted,
          entry.driftSubaccountId
        );
        
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
  } catch (error) {
    console.error("[OrphanedCleanup] Error during cleanup:", error);
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

# QuantumVault V3 Security Cleanup Plan

> **Status**: PARTIALLY COMPLETED - January 19, 2026  
> **Last Updated**: January 19, 2026  
> **Risk Level**: LOW to MEDIUM (documented, reversible via git)

This document outlines legacy code, unused dependencies, and dead code that can be safely removed once the v3 security upgrade is fully verified in production.

---

## Pre-Cleanup Checklist

Before executing any cleanup tasks, verify:

- [x] Deposits working reliably (test with small amount)
- [x] Withdrawals working reliably  
- [x] Trade execution working (webhook → Drift order)
- [x] Position tracking accurate (PnL, equity)
- [x] Referral attribution working (check drift.trade referrals)
- [ ] No wallets using legacy encryption (run audit query below)

---

## 0. CRITICAL: Dead Code with Security Implications (HIGH PRIORITY)

Identified during v3 security audit - January 16, 2026.

### `/api/trading-bots/:id/init-wallet` Endpoint

**Status:** ✅ COMPLETED - Removed January 19, 2026

**Problem:** This endpoint used legacy v1 encryption (`generateAgentWallet()` from agent-wallet.ts) instead of v3 (`generateAgentWalletWithMnemonic()`).

**Action Taken:** Removed the entire endpoint from routes.ts and removed unused `generateAgentWallet` import.

---

## 1. Test/Utility Scripts (LOW RISK)

**Status:** ✅ COMPLETED - Removed January 19, 2026

### Server Test Scripts (REMOVED)
```bash
# Files removed:
server/test-crypto-v3.ts
server/test-security-v3-integration.ts
server/test-security-v3-real.ts
server/test-keypair-derivation.mjs
server/test-referrer-lookup.mjs
server/test-deposit-ipc.mjs
```

### Root Directory Scripts (REMOVED)
```bash
# Files removed:
check-balance.mjs
check-balance2.mjs
check-balance3.mjs
fetch-oracle.mjs
fetch-oracle2.mjs
recover-funds.mjs
recover-funds.ts
```

---

## 2. Legacy Crypto Module (MEDIUM RISK)

**Status:** ⚠️ CANNOT REMOVE - Still actively used

### Verification Performed January 19, 2026

The legacy crypto.ts is still imported and used by:
- `server/agent-wallet.ts` - encrypt/decrypt for wallet generation
- `server/routes.ts` - `legacyEncrypt` for backward compatibility during wallet creation (lines 526, 1441)
- `server/session-v3.ts` - `legacyDecrypt` for session handling

**Reason:** The system still creates dual-encrypted wallets (v1 + v3) for backward compatibility. Cannot remove until all wallet creation paths use only v3.

**Future Action Required:**
1. Audit all wallet creation paths to use only v3 encryption
2. Migrate existing wallets to v3-only
3. Then remove crypto.ts

---

## 3. Unused Database Tables (MEDIUM RISK)

**Status:** ⏸️ DEFERRED - Do not drop without explicit user approval

### `trades` Table
The original `trades` table may contain historical data. Do NOT drop without explicit user approval.

### `webhook_logs` Table
This table IS used for webhook deduplication - DO NOT REMOVE.

---

## 4. Unused Builder Functions (LOW-MEDIUM RISK)

**Status:** ⚠️ CANNOT REMOVE - Still actively used

### Verification Performed January 19, 2026

```typescript
buildDepositTransaction()   // USED in routes.ts line 6654
buildWithdrawTransaction()  // USED in routes.ts line 6671
```

These functions are still called for user-initiated deposits/withdrawals (as opposed to agent-executed ones).

---

## 5. Unused NPM Dependencies (LOW RISK)

**Status:** ✅ COMPLETED - Uninstalled January 19, 2026

Packages removed:
- `passport` - Not imported anywhere
- `passport-local` - Not imported anywhere
- `@types/passport` - Type definitions for removed package
- `@types/passport-local` - Type definitions for removed package
- `memorystore` - Not imported anywhere
- `xlsx` - Not imported in code
- `next-themes` - Not imported in client/
- `vaul` - Not imported in client/

---

## 6. Unused Frontend Pages (LOW RISK)

**Status:** ⚠️ CANNOT REMOVE - Still in use

### Verification Performed January 19, 2026

- `WalletManagement.tsx` - Imported as `WalletContent` in App.tsx (line 72)
- All other pages are registered in routes

No unused pages found.

---

## 7. Database Column Cleanup (FUTURE)

**Status:** ⏸️ DEFERRED - Requires full v3 migration first

Legacy columns that can be removed in future schema update:

| Table | Column | Status |
|-------|--------|--------|
| `wallets` | `agent_private_key_encrypted` | Legacy v1 encryption - remove after all wallets migrated to v3 |
| `wallets` | `agent_mnemonic_encrypted` | Legacy v1 mnemonic - remove after v3 migration |

**Do NOT remove these columns** until:
1. All wallets verified to have v3 encryption
2. Legacy crypto.ts removed
3. Full backup taken

---

## Execution Summary

| Section | Status | Notes |
|---------|--------|-------|
| 0. Dead init-wallet endpoint | ✅ COMPLETED | Removed from routes.ts |
| 1. Test/Utility scripts | ✅ COMPLETED | 13 files deleted |
| 2. Legacy crypto.ts | ⚠️ STILL USED | Required for backward compatibility |
| 3. Database tables | ⏸️ DEFERRED | Do not drop without approval |
| 4. Builder functions | ⚠️ STILL USED | Called in routes.ts |
| 5. NPM dependencies | ✅ COMPLETED | 8 packages uninstalled |
| 6. Frontend pages | ⚠️ STILL USED | All pages in use |
| 7. Database columns | ⏸️ DEFERRED | Requires full v3 migration |

---

## Rollback Plan

All cleanup is git-reversible:

```bash
# If something breaks after cleanup
git checkout HEAD~1 -- <deleted-file>

# Or use Replit checkpoints to restore full state
```

---

## 8. Bug Fixes - January 16, 2026

### Fixed: DriftClient userMap Initialization During Bot Funding

**Problem:** When creating a new bot and depositing funds, the error "Cannot read properties of undefined (reading 'addAccount')" occurred.

**Root Cause:** When neither the main Drift account nor the target subaccount exists, the DriftClient is created with `subAccountIds: []` (empty array). When `subscribe()` is called on a DriftClient with an empty subAccountIds, the SDK's internal `userMap` is not properly initialized, causing the "addAccount" error.

**Previous (incorrect) fix approach:** Call `subscribe()` first, then create accounts, then recreate client.

**Actual fix (v2):** Do NOT call `subscribe()` when `subAccountIds` is empty. Instead:
1. Check if accounts exist on-chain
2. If accounts don't exist:
   - Create accounts on-chain using `initializeUserAccount()` (works without subscribe)
   - Create a NEW DriftClient with `subAccountIds` set to the now-existing accounts
   - Subscribe to the new client
3. If accounts already exist:
   - Subscribe to the original DriftClient (which has proper subAccountIds)
   - Switch to target subaccount if needed
4. Proceed with the deposit

**File Changed:** `server/drift-executor.mjs` - `depositToDrift()` function

**Why This Works:** The SDK can create accounts on-chain without being subscribed (just sends the transaction). By creating accounts BEFORE calling `subscribe()`, we ensure the DriftClient has valid subAccountIds when it tries to initialize the userMap during subscription.

---

## 9. Bug Fixes - January 19, 2026

### Fixed: PollingUserAccountSubscriber "addAccount undefined" Error

**Problem:** Trade execution failing with "Cannot read properties of undefined (reading 'addAccount')" at PollingUserAccountSubscriber.

**Root Cause:** When using Drift SDK's polling subscription mode, the `BulkAccountLoader` must be explicitly passed to the DriftClient's `accountSubscription` config. The SDK doesn't create one internally.

**Fix Applied:** Added BulkAccountLoader to all 3 DriftClient instances:
- `drift-executor.mjs` - 2 instances (main execution and WebSocket fallback)
- `drift-service.ts` - 1 instance

**Result:** Trade execution now works reliably.

---

## Notes

- The `AGENT_ENCRYPTION_KEY` environment variable is still needed by v3 security
- The main Drift account (subaccount 0) is intentionally preserved for referral benefits
- Polling subscription (not websocket) is used for deposits/withdrawals for reliability

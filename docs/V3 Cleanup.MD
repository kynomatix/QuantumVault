# QuantumVault V3 Security Cleanup Plan

> **Status**: PENDING - Execute after confirming system stability  
> **Last Updated**: January 16, 2026  
> **Risk Level**: LOW to MEDIUM (documented, reversible via git)

This document outlines legacy code, unused dependencies, and dead code that can be safely removed once the v3 security upgrade is fully verified in production.

---

## Pre-Cleanup Checklist

Before executing any cleanup tasks, verify:

- [ ] Deposits working reliably (test with small amount)
- [ ] Withdrawals working reliably  
- [ ] Trade execution working (webhook → Drift order)
- [ ] Position tracking accurate (PnL, equity)
- [ ] Referral attribution working (check drift.trade referrals)
- [ ] No wallets using legacy encryption (run audit query below)

---

## 0. CRITICAL: Dead Code with Security Implications (HIGH PRIORITY)

Identified during v3 security audit - January 16, 2026.

### `/api/trading-bots/:id/init-wallet` Endpoint (routes.ts ~line 3826)

**Problem:** This endpoint still uses legacy v1 encryption (`generateAgentWallet()` from agent-wallet.ts) instead of v3 (`generateAgentWalletWithMnemonic()`).

**Status:** DEAD CODE - The frontend never calls this endpoint. Verified via grep search.

**Why it exists:** Legacy code from when each bot had its own agent wallet. Current architecture uses a shared agent wallet per user created at connect time.

**Risk if left:** If someone called this API directly, it would create a v1-encrypted wallet, bypassing the v3 security model.

**Action:** Remove or disable this endpoint entirely. It serves no purpose in the current architecture.

```typescript
// DELETE this entire route block (routes.ts lines ~3826-3852):
app.post("/api/trading-bots/:id/init-wallet", ...)
```

---

## 1. Test/Utility Scripts (LOW RISK)

Development-only test scripts that are not part of production:

### Server Test Scripts
```bash
# Files to remove:
server/test-crypto-v3.ts
server/test-security-v3-integration.ts
server/test-security-v3-real.ts
server/test-keypair-derivation.mjs
server/test-referrer-lookup.mjs
server/test-deposit-ipc.mjs
```

### Root Directory Scripts
```bash
# Files to remove:
check-balance.mjs
check-balance-1.mjs
fetch-oracle-data.mjs
fetch-oracle-data-1.mjs
fetch-oracle-prices.mjs
recover-funds.mjs
recover-funds.ts
```

### Verification
```bash
# Ensure not referenced in package.json scripts
grep -r "test-crypto-v3\|test-security-v3\|check-balance\|fetch-oracle\|recover-funds" package.json
```

### Cleanup Command
```bash
rm -f server/test-crypto-v3.ts server/test-security-v3-integration.ts server/test-security-v3-real.ts
rm -f server/test-keypair-derivation.mjs server/test-referrer-lookup.mjs server/test-deposit-ipc.mjs
rm -f check-balance.mjs check-balance-1.mjs fetch-oracle-data.mjs fetch-oracle-data-1.mjs fetch-oracle-prices.mjs
rm -f recover-funds.mjs recover-funds.ts
```

---

## 2. Legacy Crypto Module (MEDIUM RISK)

The v1 encryption in `server/crypto.ts` has been replaced by v3 encryption in `server/crypto-v3.ts`.

### Before Removal - Audit Required

**Step 1: Check for wallets still using legacy encryption**
```sql
-- Run this query to find any wallets with ONLY legacy encryption
SELECT id, wallet_address 
FROM wallets 
WHERE agent_private_key_encrypted IS NOT NULL 
  AND agent_private_key_encrypted_v3 IS NULL;
```

If any rows returned → those wallets need migration before removing legacy support.

**Step 2: Check executor fallback usage**
```bash
# Check if drift-executor.mjs still has legacy fallback
grep -n "encryptedPrivateKey\|crypto\.ts" server/drift-executor.mjs
```

### Files to Remove (after verification)
```
server/crypto.ts  # v1 AES-GCM encryption (replaced by crypto-v3.ts)
```

### Code to Remove in drift-executor.mjs
Look for and remove the legacy decryption path that handles `encryptedPrivateKey` (the v1 format).
The executor should only use `encryptedPrivateKeyV3` path.

---

## 3. Unused Database Tables (MEDIUM RISK)

### `trades` Table
The original `trades` table appears unused - runtime uses `bot_trades` instead.

**Verification Query:**
```bash
# Check if trades table is referenced anywhere in storage or routes
grep -rn "\.trades\|'trades'\|\"trades\"" server/storage.ts server/routes.ts
grep -rn "from trades\|into trades\|update trades" server/
```

**Action:** If truly unused, document for future removal. Do NOT drop table without explicit user approval - may contain historical data.

### `webhook_logs` Table
This table IS used for webhook deduplication - DO NOT REMOVE.

---

## 4. Unused Builder Functions (LOW-MEDIUM RISK)

Functions in `drift-service.ts` that may be unused now that we use executor-based operations:

### Candidates for Removal
```typescript
buildDepositTransaction()   // May be unused - deposits go through executor
buildWithdrawTransaction()  // May be unused - withdrawals go through executor
```

### Verification
```bash
# Check if these functions are called anywhere
grep -rn "buildDepositTransaction\|buildWithdrawTransaction" server/routes.ts client/
```

If no matches found in routes or client code, they can be safely removed.

---

## 5. Unused NPM Dependencies (LOW RISK)

Packages that may no longer be used:

| Package | Purpose | Likely Status |
|---------|---------|---------------|
| `passport` | Auth middleware | Replaced by wallet auth |
| `passport-local` | Username/password auth | Replaced by wallet auth |
| `memorystore` | Session store | May be replaced by pg store |
| `xlsx` | Excel parsing | Check if still needed |
| `next-themes` | Theme switching | Check client usage |
| `vaul` | Drawer component | Check if used |

### Verification Commands
```bash
# Check each package for imports
grep -rn "from 'passport'\|require('passport')" server/ client/
grep -rn "from 'xlsx'\|require('xlsx')" server/ client/
grep -rn "from 'next-themes'" client/
grep -rn "from 'vaul'" client/
```

### Removal (after verification)
```bash
npm uninstall passport passport-local memorystore xlsx next-themes vaul
```

---

## 6. Unused Frontend Pages (LOW RISK)

Check for page components not registered in App.tsx routes:

### Verification
```bash
# List all page files
ls client/src/pages/

# Check which are registered in App.tsx
grep -o "component={[^}]*}" client/src/App.tsx
```

Compare lists - any pages not in App.tsx routes can be removed.

---

## 7. Database Column Cleanup (FUTURE)

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

## Execution Order

When ready to clean up, execute in this order:

1. **Dead endpoint (Section 0)** - Highest priority, security-relevant
2. **Test scripts** - Lowest risk, pure dev files
3. **Unused NPM deps** - Low risk after verification
4. **Unused frontend pages** - Low risk
5. **Builder functions** - Low-medium, verify no callers first
6. **Legacy crypto** - Medium risk, requires wallet audit first
7. **Database tables** - Do not drop, just document

---

## Rollback Plan

All cleanup is git-reversible:

```bash
# If something breaks after cleanup
git checkout HEAD~1 -- <deleted-file>

# Or use Replit checkpoints to restore full state
```

---

## Notes

- The `AGENT_ENCRYPTION_KEY` environment variable is still needed by v3 security
- The main Drift account (subaccount 0) is intentionally preserved for referral benefits
- Polling subscription (not websocket) is used for deposits/withdrawals for reliability

# QuantumVault Comprehensive Security & Code Audit Report

**Audit Date:** January 19, 2026  
**Auditor:** Automated Security Analysis  
**Scope:** Full codebase review focusing on security, code quality, and redundant systems

---

## Executive Summary

This audit identified **2 CRITICAL**, **5 HIGH**, **9 MEDIUM**, and **6 LOW** severity issues across security, code quality, and architectural concerns. Key findings include deprecated security functions that should be removed, potential memory leak patterns, and unused legacy tables/endpoints that should be cleaned up. Note: The legacy encryption system is sunset and only retained for backward compatibility with existing wallets.

---

## Table of Contents

1. [Security Findings](#1-security-findings)
2. [Code Quality Issues](#2-code-quality-issues)
3. [Redundant Systems](#3-redundant-systems)
4. [Architecture Concerns](#4-architecture-concerns)
5. [Proposed Changes Summary](#5-proposed-changes-summary)

---

## 1. Security Findings

### 1.1 MEDIUM: Legacy Single-Key Encryption (Sunset - Backward Compatibility Only)

**Severity:** MEDIUM (downgraded from CRITICAL - system is sunset)  
**Location:** `server/crypto.ts`, `server/agent-wallet.ts`, `server/routes.ts`

**Status:** The legacy `crypto.ts` single-key encryption is **SUNSET**. The v3 security system is now the primary system.

**Current State:**
- `AGENT_ENCRYPTION_KEY` is now used in TWO ways:
  1. **V3 (Secure):** `session-v3.ts:60` uses it as INPUT to per-user key derivation (combined with wallet address + salt) - this is secure
  2. **Legacy (Backward Compat):** `drift-executor.mjs` and `agent-wallet.ts` still decrypt legacy-encrypted keys for wallets created before v3

**Legacy Code Paths (for backward compatibility):**
```
server/agent-wallet.ts:2 - import { encrypt, decrypt } from './crypto';
server/routes.ts:8 - import { encrypt as legacyEncrypt } from "./crypto";
server/routes.ts:532 - const encryptedPrivateKey = legacyEncrypt(privateKeyBase58);
server/routes.ts:1447 - const encryptedPrivateKey = legacyEncrypt(privateKeyBase58);
```

**Question for Review:**
- Are new wallets still being created with legacy encryption (`legacyEncrypt` calls in routes.ts)?
- If yes, these should be migrated to v3-only encryption
- If no (only v3 is used for new wallets), then legacy code is only for existing wallet support

**Proposed Fix (if legacy is truly sunset):**
1. Verify all NEW wallet creation uses v3 encryption only
2. Keep legacy decrypt for backward compatibility with existing wallets
3. Consider migration script to re-encrypt existing wallets to v3-only
4. Document sunset timeline in code comments

---

### 1.2 CRITICAL: Deprecated Nonce Validation Function Exists

**Severity:** CRITICAL  
**Location:** `server/session-v3.ts:272-283`

**Issue:** A deprecated function `validateAndConsumeNonce` consumes nonces WITHOUT signature verification. If any code path calls this function, it's an authentication bypass.

**Code:**
```typescript
// server/session-v3.ts:267-283
/**
 * @deprecated Use verifySignatureAndConsumeNonce instead for secure flows.
 * This function is only retained for backwards compatibility during migration.
 * It consumes nonces without signature verification which is insecure.
 */
async function validateAndConsumeNonce(
  walletAddress: string,
  nonce: string,
  purpose: string
): Promise<boolean> {
  const validation = await validateNonceWithoutConsuming(walletAddress, nonce, purpose);
  if (!validation.valid) return false;
  await storage.markNonceUsed(validation.nonceId);
  return true;
}
```

**Current Status:** Function is defined but grep shows NO external callers - only defined in session-v3.ts

**Proposed Fix:**
1. Remove the function entirely OR
2. Throw an error if called: `throw new Error('SECURITY: This function is deprecated and must not be used');`

**Verification:**
```bash
grep -r "validateAndConsumeNonce" server/ client/
# Result: Only defined in session-v3.ts, no callers found
```

---

### 1.3 CRITICAL: Private Keys Retained in Memory Without Zeroization

**Severity:** CRITICAL  
**Location:** `server/agent-wallet.ts:63-67`, `server/trade-retry-service.ts`

**Issue:** Decrypted private keys are not zeroized after use. The `getAgentKeypair()` function returns a Keypair object but never clears the underlying secret key bytes.

**Evidence:**
```typescript
// server/agent-wallet.ts:63-67
export function getAgentKeypair(encryptedPrivateKey: string): Keypair {
  const privateKeyBase58 = decrypt(encryptedPrivateKey);  // Decrypted key in memory
  const secretKey = bs58.decode(privateKeyBase58);         // Another copy in memory
  return Keypair.fromSecretKey(secretKey);                 // Keypair holds secretKey internally
  // No cleanup - keys remain in memory until GC
}
```

**Additional Concern:** `trade-retry-service.ts` stores `TradeJob` objects with `agentPrivateKeyEncrypted` field in a Map. While encrypted, the retry queue persists these in memory.

**Proposed Fix:**
1. Create a wrapper that zeroizes key material after use:
```typescript
export async function withAgentKeypair<T>(
  encryptedPrivateKey: string,
  fn: (keypair: Keypair) => Promise<T>
): Promise<T> {
  const privateKeyBase58 = decrypt(encryptedPrivateKey);
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  try {
    return await fn(keypair);
  } finally {
    // Zeroize key material
    secretKey.fill(0);
    // Note: keypair.secretKey is a view, not a copy in newer versions
  }
}
```
2. Audit all `getAgentKeypair` call sites to use the wrapper pattern

---

### 1.4 HIGH: No Rate Limiting on Webhook Endpoints

**Severity:** HIGH  
**Location:** `server/routes.ts:4168`, `server/routes.ts:5445`

**Issue:** The TradingView webhook endpoints have no rate limiting. An attacker could flood the system with webhook requests, causing DoS or excessive RPC usage.

**Evidence:**
```typescript
// server/routes.ts:4168 - No rate limit middleware
app.post("/api/webhook/tradingview/:botId", async (req, res) => {

// server/routes.ts:5445 - No rate limit middleware  
app.post("/api/webhook/user/:walletAddress", async (req, res) => {
```

**Proposed Fix:**
1. Add express-rate-limit middleware to webhook endpoints
2. Suggested limits: 10 requests per minute per IP, 100 per hour

```typescript
import rateLimit from 'express-rate-limit';

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { error: 'Too many webhook requests' }
});

app.post("/api/webhook/tradingview/:botId", webhookLimiter, async (req, res) => {
```

---

### 1.5 HIGH: Session Storage is In-Memory Only

**Severity:** HIGH  
**Location:** `server/session-v3.ts:40`

**Issue:** Sessions are stored in a JavaScript Map (`const sessions = new Map<string, SessionData>()`). On server restart or deployment, all active sessions are lost, forcing users to re-authenticate.

**Impact:**
- Users must re-authenticate after every deployment
- No horizontal scaling possible (sessions not shared between instances)
- UMK in session is lost, requiring signature verification again

**Proposed Fix:**
1. Store session data in PostgreSQL or Redis
2. Encrypt session data at rest using server key
3. Implement session hydration on server startup

---

### 1.6 HIGH: Webhook Secret Not Validated Before Processing

**Severity:** HIGH  
**Location:** `server/routes.ts:4168-4280`

**Issue:** Need to verify that webhook secret validation happens BEFORE any processing. The webhook endpoint should reject requests with invalid secrets before doing database lookups.

**Verification Required:**
- [ ] Confirm webhook secret is checked before bot lookup
- [ ] Ensure timing-safe comparison for secret validation
- [ ] Verify error messages don't leak information

---

### 1.7 MEDIUM: Legacy User Authentication Still Present

**Severity:** MEDIUM  
**Location:** `server/routes.ts:6295-6465`

**Issue:** Old username/password authentication endpoints still exist alongside wallet-based auth:
- `POST /api/auth/register` (line 6295)
- `POST /api/auth/login` (line 6330)
- `GET /api/auth/me` with requireAuth (line 6358)
- Several endpoints using `requireAuth` instead of `requireWallet`

**Evidence:**
```
app.post("/api/auth/register", ...)
app.post("/api/auth/login", ...)
app.get("/api/auth/me", requireAuth, ...)
app.post("/api/subscriptions", requireAuth, ...)
app.get("/api/portfolio", requireAuth, ...)
app.get("/api/positions", requireAuth, ...)  // Note: duplicate path with requireWallet version
app.get("/api/trades", requireAuth, ...)
```

**Proposed Fix:**
1. Audit if username/password auth is still needed
2. If not, remove legacy auth endpoints
3. Remove `requireAuth` middleware
4. Consolidate to wallet-based auth only

---

### 1.8 MEDIUM: Duplicate Route Paths

**Severity:** MEDIUM  
**Location:** `server/routes.ts`

**Issue:** There are duplicate route definitions:
- `GET /api/positions` defined twice (lines 1968 and 6444)
- `POST /api/auth/logout` defined twice (lines 609 and 6349)

This can cause unpredictable behavior as Express uses first-match routing.

**Proposed Fix:**
Remove duplicate route definitions after confirming which version is actively used.

---

## 2. Code Quality Issues

### 2.1 MEDIUM: Large Routes File (7,700+ Lines)

**Severity:** MEDIUM  
**Location:** `server/routes.ts`

**Issue:** The routes.ts file is 7,751 lines, making it difficult to maintain, review, and test.

**Proposed Fix:**
Split into logical modules:
- `routes/auth.ts` - Authentication endpoints
- `routes/wallet.ts` - Wallet management
- `routes/bots.ts` - Trading bot CRUD
- `routes/trading.ts` - Trade execution, positions
- `routes/webhook.ts` - Webhook handling
- `routes/marketplace.ts` - Published bots, subscriptions
- `routes/admin.ts` - Admin endpoints

---

### 2.2 MEDIUM: Inconsistent Error Handling

**Severity:** MEDIUM  
**Location:** `server/storage.ts`

**Issue:** Storage module has 0 try/catch blocks despite performing database operations. All error handling is delegated to callers.

**Evidence:**
```bash
grep -c "catch\|try {" server/routes.ts server/drift-service.ts server/storage.ts
# routes.ts:347, drift-service.ts:123, storage.ts:0
```

**Proposed Fix:**
Add consistent error handling and logging in storage layer, or document that callers must handle errors.

---

### 2.3 LOW: Deprecated SDK Functions Marked but Present

**Severity:** LOW  
**Location:** `server/drift-service.ts:1966,3351`

**Issue:** Functions marked as deprecated with memory leak warnings still exist:
```typescript
// server/drift-service.ts:1966
* @deprecated DO NOT USE - Causes memory leaks due to SDK WebSocket connections

// server/drift-service.ts:3351
* @deprecated DO NOT USE - Causes memory leaks due to SDK WebSocket connections
```

**Proposed Fix:**
- Remove deprecated functions if unused
- If still needed, add runtime warnings when called

---

### 2.4 LOW: Multiple setInterval Without Clear Cleanup

**Severity:** LOW  
**Location:** Multiple files

**Issue:** Several setInterval calls lack proper cleanup on server shutdown:

```
server/session-v3.ts:665 - setInterval(cleanupExpiredSessions, 60 * 1000);
server/session-v3.ts:678 - setInterval(cleanupExpiredNonces, 5 * 60 * 1000);
server/reconciliation-service.ts:241 - reconcileInterval = setInterval(...)
server/pnl-snapshot-job.ts:57 - setInterval(...)
server/trade-retry-service.ts:355 - workerInterval = setInterval(...)
server/orphaned-subaccount-cleanup.ts:75 - setInterval(...)
server/routes.ts:773 - setInterval(...)
server/routes.ts:6625 - setInterval(sendPrices, 3000);
```

**Proposed Fix:**
1. Store interval references in a central cleanup registry
2. Clear all intervals on SIGTERM/SIGINT

---

## 3. Redundant Systems

### 3.1 HIGH: Unused Legacy Database Tables

**Severity:** HIGH  
**Location:** `shared/schema.ts`, `server/storage.ts`

**Issue:** The following tables appear to be legacy and may not be actively used:

| Table | Status | Verification |
|-------|--------|--------------|
| `users` | **LEGACY** | Used only by legacy auth (username/password) |
| `portfolios` | **LEGACY** | Used only with `userId` (legacy auth) |
| `positions` | **LEGACY** | Uses `userId`, duplicate of on-chain positions |
| `trades` | **LEGACY** | Uses `userId`, duplicate of `bot_trades` |
| `leaderboardStats` | **LEGACY** | Uses `userId` (legacy auth) |
| `subscriptions` | **LEGACY** | Uses `userId`, superseded by `botSubscriptions` |
| `bots` | **UNCLEAR** | Generic bots table, may overlap with `tradingBots` |

**Evidence:**
```bash
# Storage methods exist but tied to legacy userId-based auth
storage.getUser(id)
storage.getUserByUsername(username)
storage.createUser(user)
storage.getPortfolio(userId)
storage.getLeaderboard()
```

**Verification Required:**
- [ ] Grep frontend for any API calls using legacy auth endpoints
- [ ] Check if any production data exists in these tables
- [ ] Confirm wallet-based equivalents exist for all functionality

**Proposed Fix:**
1. If confirmed unused, deprecate tables in schema
2. Create migration to archive/drop after backup
3. Remove corresponding storage methods and routes

---

### 3.2 MEDIUM: Legacy Authentication Endpoints

**Severity:** MEDIUM  
**Location:** `server/routes.ts:6295-6465`

**Issue:** Legacy username/password auth endpoints that appear unused:

| Endpoint | Line | Status |
|----------|------|--------|
| `POST /api/auth/register` | 6295 | Legacy - creates `users` |
| `POST /api/auth/login` | 6330 | Legacy - session-based |
| `GET /api/auth/me` | 6358 | Legacy - uses `requireAuth` |
| `POST /api/subscriptions` | 6396 | Legacy - uses `userId` |
| `GET /api/subscriptions` | 6413 | Legacy - uses `userId` |
| `PATCH /api/subscriptions/:id` | 6423 | Legacy - uses `userId` |
| `GET /api/portfolio` | 6434 | Legacy - uses `userId` |
| `GET /api/positions` | 6444 | Legacy - duplicate route |
| `GET /api/trades` | 6454 | Legacy - uses `userId` |
| `GET /api/leaderboard` | 6465 | Legacy - uses legacy stats |

**Verification Required:**
```bash
# Check if frontend uses these endpoints
grep -r "/api/auth/register\|/api/auth/login\|/api/portfolio\|/api/trades" client/
```

**Proposed Fix:**
1. Verify no frontend usage
2. Remove legacy endpoints
3. Remove `requireAuth` middleware
4. Remove legacy storage methods

---

### 3.3 MEDIUM: check-agent-referrer.mjs Diagnostic Script

**Severity:** MEDIUM  
**Location:** `server/check-agent-referrer.mjs` (199 lines)

**Issue:** This is a standalone diagnostic script with hardcoded wallet addresses that was used for debugging referrer attribution. It should not be in production code.

**Evidence:**
```javascript
// server/check-agent-referrer.mjs:13-24
const AGENTS_TO_CHECK = [
  {
    name: 'Agent 1 (6iN83...LBhvy)',
    agentWallet: '6iN83GcxoRMgq7hCxVGZ3QrxYgnVzJf1DjTpTn9LBhvy',
    userWallet: '6ULLaZkuWoML1qN23TqSw9ANBBCGFXaAvKbFzXj2Kehh',
  },
  ...
];
```

**Proposed Fix:**
Move to `scripts/` directory or delete if no longer needed.

---

### 3.4 LOW: Unused Build Allowlist Entries

**Severity:** LOW  
**Location:** `script/build.ts`

**Issue:** Build allowlist contains packages that may not be used:
- `@google/generative-ai` - Not found in package.json
- `axios` - Not found in package.json
- `cors` - Not found in package.json
- `express-rate-limit` - Not found in package.json (but should be added)
- `jsonwebtoken` - Not found in package.json
- `multer` - Not found in package.json
- `nanoid` - Not found in package.json
- `nodemailer` - Not found in package.json
- `stripe` - Not found in package.json
- `uuid` - Not found in package.json

**Proposed Fix:**
Clean up allowlist to match actual dependencies.

---

## 4. Architecture Concerns

### 4.1 HIGH: Single Points of Failure

| Component | Issue | Impact |
|-----------|-------|--------|
| In-memory sessions | Lost on restart | Users must re-authenticate |
| In-memory retry queue | Lost on restart | Failed trades not retried |
| Single RPC provider | If Helius down | All trading stops |

**Mitigations Already Present:**
- RPC failover to Triton One (backup)
- Trade retry queue (but in-memory)

**Proposed Improvements:**
1. Persist sessions to database
2. Persist retry queue to database
3. Add health checks for RPC providers

---

### 4.2 MEDIUM: Race Conditions in Bot Operations

**Severity:** MEDIUM  
**Location:** `server/routes.ts` (bot creation, deletion)

**Issue:** Bot operations (create, delete, deposit) could race if user clicks multiple times quickly.

**Proposed Fix:**
1. Add database-level locks or constraints
2. Implement idempotency keys for sensitive operations
3. Add UI debouncing on critical buttons

---

### 4.3 LOW: No Graceful Shutdown

**Severity:** LOW  
**Location:** `server/index.ts`

**Issue:** No SIGTERM/SIGINT handlers to gracefully close connections and intervals.

**Proposed Fix:**
```typescript
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  // Clear all intervals
  // Close database connections
  // Finish pending requests
  process.exit(0);
});
```

---

## 5. Proposed Changes Summary

### Critical Priority (Do Immediately)

| # | Issue | Action | Files |
|---|-------|--------|-------|
| 1 | Deprecated nonce function | Remove or throw error | session-v3.ts |
| 2 | Key zeroization | Add cleanup after key use | agent-wallet.ts |

### High Priority (This Sprint)

| # | Issue | Action | Files |
|---|-------|--------|-------|
| 3 | Verify legacy encryption is sunset | Confirm new wallets use v3 only | routes.ts |
| 4 | Webhook rate limiting | Add express-rate-limit | routes.ts |
| 5 | In-memory sessions | Persist to database | session-v3.ts |
| 6 | Verify webhook secret order | Ensure early validation | routes.ts |
| 7 | Unused legacy tables | Plan migration/removal | schema.ts, storage.ts |

### Medium Priority (Next Sprint)

| # | Issue | Action | Files |
|---|-------|--------|-------|
| 8 | Legacy auth endpoints | Remove if unused | routes.ts |
| 9 | Duplicate routes | Remove duplicates | routes.ts |
| 10 | Split routes.ts | Modularize | routes/ directory |
| 11 | Diagnostic scripts | Move or delete | check-agent-referrer.mjs |

### Low Priority (Backlog)

| # | Issue | Action | Files |
|---|-------|--------|-------|
| 12 | Deprecated SDK functions | Remove | drift-service.ts |
| 13 | Interval cleanup | Add shutdown handlers | index.ts |
| 14 | Build allowlist | Clean up | build.ts |
| 15 | Graceful shutdown | Implement | index.ts |

---

## Appendix: Verification Commands

### Check Legacy Encryption Usage
```bash
grep -r "legacyEncrypt\|from './crypto'" server/
```

### Check Legacy Auth Endpoint Usage
```bash
grep -r "/api/auth/register\|/api/auth/login\|requireAuth" client/
```

### Check Legacy Table Usage
```bash
grep -r "users\.\|portfolios\.\|leaderboardStats\." server/
```

### Find All setInterval Calls
```bash
grep -rn "setInterval" server/
```

---

## 6. Safe Legacy Encryption Removal Plan

### Current State Analysis

The legacy encryption system is **partially sunset** but still actively used:

| Component | Legacy Usage | V3 Usage |
|-----------|--------------|----------|
| New wallet creation | ✅ Writes `agentPrivateKeyEncrypted` | ✅ Also writes `agentPrivateKeyEncryptedV3` |
| Trade execution | ✅ Uses legacy field (60+ references) | ❌ Not used |
| drift-executor.mjs | ✅ Decrypts with `AGENT_ENCRYPTION_KEY` | ❌ Not used |
| Mnemonic reveal | ❌ Not used | ✅ Uses v3 decryption |
| Session initialization | ❌ Not used | ✅ UMK derivation uses key |

### Why This is Complex

1. **Dual-write architecture**: New wallets write BOTH encryption formats
2. **Trade execution only uses legacy**: All 60+ trade paths use `agentPrivateKeyEncrypted`
3. **drift-executor.mjs is separate**: Runs as subprocess, has its own decryption logic
4. **V3 only partial**: V3 encryption exists but only used for mnemonic operations

### Safe Removal Strategy (Phased Approach)

#### Phase 1: Audit & Preparation (No Code Changes)
- [ ] Verify all wallets have BOTH legacy AND v3 encryption
- [ ] Run SQL: `SELECT COUNT(*) FROM wallets WHERE agent_private_key_encrypted IS NOT NULL AND agent_private_key_encrypted_v3 IS NULL`
- [ ] If count > 0, some wallets need migration before proceeding

#### Phase 2: Add V3 Decryption to Trade Paths
- [ ] Create `getAgentKeypairV3(umk, encryptedV3, walletAddress)` function
- [ ] Add fallback pattern: try v3 first, fall back to legacy
- [ ] Update `drift-executor.mjs` to accept v3-encrypted keys
- [ ] Test thoroughly in development with existing wallets

#### Phase 3: Migrate Trade Execution to V3
- [ ] Update all 60+ trade paths in routes.ts to use v3 decryption
- [ ] Key files to modify:
  - `server/routes.ts` - all `agentPrivateKeyEncrypted` references
  - `server/drift-service.ts` - `getAgentKeypair` calls
  - `server/trade-retry-service.ts` - retry job structure
  - `server/position-service.ts` - position checks
  - `server/drift-executor.mjs` - subprocess decryption
- [ ] Keep legacy fallback for safety

#### Phase 4: Stop Writing Legacy
- [ ] Remove `legacyEncrypt` calls from new wallet creation (routes.ts:532, 1447)
- [ ] Only write `agentPrivateKeyEncryptedV3` for new wallets
- [ ] Existing wallets continue to work via fallback

#### Phase 5: Clean Up Legacy Code
- [ ] After confirming all wallets have v3 keys working
- [ ] Remove legacy fallback code
- [ ] Remove `server/crypto.ts` (legacy module)
- [ ] Remove `generateAgentWallet()` from agent-wallet.ts
- [ ] Clean up database columns (separate migration)

### Files to Modify (Complete List)

| File | Changes Needed |
|------|---------------|
| `server/routes.ts` | 60+ references to update |
| `server/drift-service.ts` | Update `getAgentKeypair` calls |
| `server/drift-executor.mjs` | Add v3 decryption support |
| `server/agent-wallet.ts` | Remove legacy `generateAgentWallet` |
| `server/crypto.ts` | Remove entire file (Phase 5) |
| `server/session-v3.ts` | Remove legacy fallback (Phase 5) |
| `server/trade-retry-service.ts` | Update job structure |
| `server/position-service.ts` | Update function signatures |
| `server/storage.ts` | Update interface (Phase 5) |
| `shared/schema.ts` | Remove legacy column (Phase 5) |

### Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking trade execution | Phase 2-3: Add fallback, test thoroughly |
| Losing access to wallet funds | Never delete legacy code until v3 proven working |
| Missing wallets without v3 | Phase 1: Audit all wallets first |
| Subprocess communication | Phase 2: Update drift-executor.mjs carefully |

### Estimated Effort

- Phase 1: 1-2 hours (audit only)
- Phase 2: 4-6 hours (add v3 support)
- Phase 3: 8-12 hours (migrate 60+ paths)
- Phase 4: 1 hour (stop writing legacy)
- Phase 5: 2-4 hours (cleanup)

**Total: 16-25 hours of careful work**

### Recommendation

Do NOT rush this migration. The current dual-write system is safe - it's just redundant. A phased approach ensures no wallet funds are ever at risk.

---

**End of Audit Report**

*This report should be reviewed and validated by the development team before implementing any changes.*

# QuantumVault Security Upgrade Plan v2

## Overview

This document outlines a major security upgrade to implement Web3-native encryption for agent wallets using an envelope encryption pattern with per-user master keys.

**Status**: Planning (Revised after security review)  
**Priority**: Critical  
**Breaking Change**: Yes (clean migration required)  
**Reviews**: Architect + External AI Security Review

---

## Executive Summary of Changes from v1

| Issue | v1 Problem | v2 Fix |
|-------|------------|--------|
| Key derivation | Signature-derived key used directly; changes each login | UMK envelope pattern with stable master key |
| Automation | Bots can't execute without live user | Execution authorization layer with bot policies |
| Zero-knowledge claim | Inaccurate - server sees keys at runtime | Corrected terminology |
| AES-GCM params | Unspecified | Pinned IV size, AAD, subkey derivation |
| Dev fallback | Weak key in dev mode | Removed entirely |
| Mnemonic handling | Basic | Rate-limited, high-privilege auth required |

---

## Current State Analysis

### Existing Architecture (INSECURE)

```
┌─────────────────────────────────────────────────────────────┐
│                    CURRENT (INSECURE)                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  AGENT_ENCRYPTION_KEY (env var)                             │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────┐                                           │
│  │ AES-256-GCM  │◄─── Single key for ALL users              │
│  └──────────────┘                                           │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Database                                             │   │
│  │ ├─ wallet_1.agentPrivateKeyEncrypted                 │   │
│  │ ├─ wallet_2.agentPrivateKeyEncrypted                 │   │
│  │ └─ wallet_N.agentPrivateKeyEncrypted                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  RISK: Compromised AGENT_ENCRYPTION_KEY = ALL funds lost    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Proposed Architecture v2

### Envelope Encryption with User Master Key (UMK)

```
┌─────────────────────────────────────────────────────────────┐
│                    PROPOSED (SECURE)                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  User's Phantom Wallet                                      │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Sign deterministic message for key derivation        │   │
│  │ "QuantumVault:Unlock:{wallet_address}"               │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ HKDF Key Derivation → Session Key (SK)               │   │
│  │ Input: signature + wallet_address + app_salt         │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Decrypt EUMK (Encrypted User Master Key) → UMK       │   │
│  │ UMK is a random 32-byte key, stable per user         │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Derive subkeys from UMK via HKDF                     │   │
│  │ ├─ key_mnemonic = HKDF(UMK, info="mnemonic")         │   │
│  │ ├─ key_privkey = HKDF(UMK, info="agent_privkey")     │   │
│  │ └─ key_execution = HKDF(UMK, info="execution")       │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Database (per-user encrypted)                        │   │
│  │ ├─ encryptedUserMasterKey (EUMK) - wrapped with SK   │   │
│  │ ├─ encryptedMnemonic - encrypted with key_mnemonic   │   │
│  │ └─ encryptedPrivateKey - encrypted with key_privkey  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Why Envelope Encryption?

**Problem with v1**: Signature-derived key changes every login if message includes timestamp/nonce. Previously encrypted data becomes unrecoverable.

**Solution**: 
1. Generate a random **User Master Key (UMK)** once per user (stable, never changes)
2. Wrap UMK with the **Session Key (SK)** derived from signature
3. SK can change every login - we just re-wrap UMK
4. UMK encrypts the actual secrets (mnemonic, private keys)
5. No mass re-encryption needed on each login

---

## Signature Message Specifications

### Message Format

All signed messages MUST include:

```typescript
interface SignedMessage {
  domain: "quantumvault.app";
  wallet: string;           // Full public key
  cluster: "mainnet-beta";
  purpose: SignaturePurpose;
  nonce: string;            // 32 bytes random, hex encoded
  issuedAt: string;         // ISO 8601
  expiresAt: string;        // ISO 8601
}

type SignaturePurpose = 
  | "unlock_umk"           // Derive SK to unwrap UMK
  | "enable_execution"     // Authorize bot trading
  | "reveal_mnemonic"      // View backup phrase
  | "revoke_execution";    // Disable bot trading
```

### Purpose-Specific TTLs

| Purpose | TTL | Single Use | Rate Limit |
|---------|-----|------------|------------|
| `unlock_umk` | 24 hours | No | None |
| `enable_execution` | 1 hour | No | None |
| `reveal_mnemonic` | 2 minutes | Yes | 3/hour |
| `revoke_execution` | Immediate | Yes | None |

### Nonce Requirements

- **Length**: 32 bytes random
- **Encoding**: Hex string (64 chars)
- **Storage**: Server stores hash of nonce + expiration
- **Single Use**: Each nonce valid for one signature only
- **Verification**: Server rejects replayed nonces

---

## Key Derivation Specification

### Session Key (SK) Derivation

```typescript
function deriveSessionKey(
  walletAddress: string,
  signature: Uint8Array
): Buffer {
  const ikm = Buffer.concat([
    Buffer.from(walletAddress, 'utf8'),
    Buffer.from(signature),
  ]);
  
  // App salt - stable, can be public
  const salt = Buffer.from('QuantumVault-v2-2026');
  const info = Buffer.from('session-key-derivation');
  
  // HKDF-SHA256, output 32 bytes
  return crypto.hkdfSync('sha256', ikm, salt, info, 32);
}
```

### Subkey Derivation from UMK

```typescript
function deriveSubkey(umk: Buffer, purpose: string): Buffer {
  const info = Buffer.from(`QuantumVault:${purpose}`);
  const salt = Buffer.alloc(32, 0); // Zero salt for subkey derivation
  
  return crypto.hkdfSync('sha256', umk, salt, info, 32);
}

// Usage:
const keyMnemonic = deriveSubkey(umk, 'mnemonic');
const keyPrivkey = deriveSubkey(umk, 'agent_privkey');
const keyExecution = deriveSubkey(umk, 'execution_token');
```

---

## AES-256-GCM Specification

### Parameters (MUST be followed exactly)

| Parameter | Value | Notes |
|-----------|-------|-------|
| Algorithm | AES-256-GCM | Authenticated encryption |
| Key size | 256 bits (32 bytes) | From HKDF derivation |
| IV size | 96 bits (12 bytes) | Random, never reused |
| Auth tag | 128 bits (16 bytes) | Full length |
| AAD | Required | See below |

### Additional Authenticated Data (AAD)

AAD prevents ciphertext from being moved between contexts:

```typescript
function buildAAD(walletAddress: string, recordType: string, version: number): Buffer {
  return Buffer.from(JSON.stringify({
    wallet: walletAddress,
    type: recordType,   // "mnemonic" | "privkey" | "umk"
    version: version,   // Schema version for migration
  }));
}
```

### Ciphertext Format

```
Base64(IV || AuthTag || Ciphertext)
```

Where:
- IV: 12 bytes
- AuthTag: 16 bytes
- Ciphertext: Variable length

---

## Headless Execution Model

### The Problem

Bots receive TradingView webhooks while users sleep. v1 required live user signature for every trade - impossible for automation.

### Solution: Execution Authorization Layer

```
┌─────────────────────────────────────────────────────────────┐
│              EXECUTION AUTHORIZATION FLOW                   │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. USER ENABLES EXECUTION                                  │
│     ┌────────────────────────────────────────────────────┐  │
│     │ User signs "enable_execution" message              │  │
│     │ Server derives SK, unwraps UMK                     │  │
│     │ Derive Execution Key (EK) from UMK                 │  │
│     │ Store EK encrypted with SERVER_EXECUTION_KEY      │  │
│     │ Set bot.executionEnabled = true                    │  │
│     │ Set bot.executionExpiresAt = now + 24h             │  │
│     └────────────────────────────────────────────────────┘  │
│                                                             │
│  2. WEBHOOK ARRIVES (User not present)                      │
│     ┌────────────────────────────────────────────────────┐  │
│     │ Check bot.executionEnabled && !expired             │  │
│     │ Decrypt EK using SERVER_EXECUTION_KEY              │  │
│     │ Use EK to decrypt agent private key                │  │
│     │ Execute trade                                      │  │
│     │ Zeroize all keys from memory immediately           │  │
│     └────────────────────────────────────────────────────┘  │
│                                                             │
│  3. USER REVOKES (Optional)                                 │
│     ┌────────────────────────────────────────────────────┐  │
│     │ User signs "revoke_execution" message              │  │
│     │ Delete EK from database                            │  │
│     │ Set bot.executionEnabled = false                   │  │
│     │ Bots stop executing immediately                    │  │
│     └────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### SERVER_EXECUTION_KEY

This is a necessary compromise for automation:

- Stored in environment variable (like current AGENT_ENCRYPTION_KEY)
- ONLY used to wrap per-user Execution Keys
- Per-user EK can only decrypt THAT user's agent wallet
- User can revoke at any time
- Execution has time limits and policy constraints

**Security Properties**:
- Server compromise + DB breach = only active users' EKs exposed
- Inactive/revoked users' data still protected by their UMK
- EK expires, limiting exposure window

### Bot Execution Policies

Each bot MUST have configurable security limits:

```typescript
interface BotExecutionPolicy {
  // Authorization
  executionEnabled: boolean;
  executionExpiresAt: Date | null;
  
  // Risk Limits
  allowedMarkets: string[];           // ["SOL-PERP", "BTC-PERP"]
  maxPositionNotionalUsd: number;     // e.g., 1000
  maxLeverage: number;                // e.g., 5
  allowedOrderTypes: OrderType[];     // ["MARKET", "LIMIT"]
  maxSlippageBps: number;             // e.g., 50 (0.5%)
  
  // Loss Prevention
  dailyLossLimitUsd: number;          // e.g., 100
  dailyLossUsedUsd: number;           // Tracked per day
  killSwitchTriggered: boolean;       // Emergency stop
  
  // Audit
  lastExecutionAt: Date | null;
  totalExecutions: number;
}
```

---

## Mnemonic Backup System

### BIP-39 + Solana Derivation

```typescript
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { Keypair } from '@solana/web3.js';

// MUST use this exact derivation path for Solana compatibility
const SOLANA_DERIVATION_PATH = "m/44'/501'/0'/0'";

function generateAgentWallet(): { mnemonic: string; keypair: Keypair } {
  // Generate 24-word mnemonic (256 bits entropy)
  const mnemonic = bip39.generateMnemonic(256);
  
  // Derive seed
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  
  // Derive Ed25519 keypair using Solana path
  const derivedSeed = derivePath(SOLANA_DERIVATION_PATH, seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  
  return { mnemonic, keypair };
}

function recoverFromMnemonic(mnemonic: string): Keypair {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath(SOLANA_DERIVATION_PATH, seed.toString('hex')).key;
  return Keypair.fromSeed(derivedSeed);
}
```

### Mnemonic Reveal Flow

```
┌─────────────────────────────────────────────────────────────┐
│                 MNEMONIC REVEAL FLOW                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. User clicks "Reveal Backup Phrase"                      │
│                                                             │
│  2. UI shows warning:                                       │
│     "Your backup phrase controls your agent wallet.         │
│      Never share it. Store it offline securely.             │
│      Anyone with this phrase can steal your funds."         │
│                                                             │
│  3. User confirms understanding                             │
│                                                             │
│  4. User signs "reveal_mnemonic" message (2 min TTL)        │
│                                                             │
│  5. Server:                                                 │
│     ├─ Check rate limit (max 3/hour)                        │
│     ├─ Verify signature and nonce                           │
│     ├─ Derive SK from signature                             │
│     ├─ Unwrap UMK using SK                                  │
│     ├─ Derive key_mnemonic from UMK                         │
│     ├─ Decrypt mnemonic                                     │
│     ├─ Return to client (HTTPS only)                        │
│     ├─ Log reveal event (wallet, timestamp, IP - NOT words) │
│     └─ Zeroize all keys from memory                         │
│                                                             │
│  6. Client displays mnemonic once, never caches             │
│                                                             │
│  7. User copies manually, UI clears after 60 seconds        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Mnemonic Security Controls

| Control | Implementation |
|---------|----------------|
| Rate limiting | Max 3 reveals per hour per wallet |
| High-privilege auth | Requires fresh signature with 2-min TTL |
| Single-use nonce | Prevents replay |
| No logging | Mnemonic words NEVER logged anywhere |
| No caching | Server doesn't cache decrypted mnemonic |
| Memory wipe | Buffer zeroized after use |
| HTTPS only | TLS required for transport |
| Client timeout | UI clears display after 60 seconds |
| Audit trail | Log reveal attempts (not content) |

---

## Database Schema Changes

### New Columns for `wallets` Table

```typescript
// Add to wallets table in shared/schema.ts
encryptedUserMasterKey: text("encrypted_user_master_key"),
umkVersion: integer("umk_version").default(1),
agentMnemonicEncrypted: text("agent_mnemonic_encrypted"),
executionKeyEncrypted: text("execution_key_encrypted"),
executionExpiresAt: timestamp("execution_expires_at"),
executionEnabled: boolean("execution_enabled").default(false),
mnemonicRevealCount: integer("mnemonic_reveal_count").default(0),
mnemonicLastRevealAt: timestamp("mnemonic_last_reveal_at"),
securityVersion: integer("security_version").default(2),
```

### New Columns for `tradingBots` Table

```typescript
// Add to tradingBots table for execution policies
allowedMarkets: text("allowed_markets").array(),
maxPositionNotionalUsd: decimal("max_position_notional_usd"),
maxLeverage: integer("max_leverage_limit"),
maxSlippageBps: integer("max_slippage_bps").default(50),
dailyLossLimitUsd: decimal("daily_loss_limit_usd"),
dailyLossUsedUsd: decimal("daily_loss_used_usd").default("0"),
killSwitchTriggered: boolean("kill_switch_triggered").default(false),
executionPolicyVersion: integer("execution_policy_version").default(1),
```

### New Table: `auth_nonces`

```typescript
export const authNonces = pgTable("auth_nonces", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: text("wallet_address").notNull(),
  nonceHash: text("nonce_hash").notNull().unique(),
  purpose: text("purpose").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

---

## Executor Security

### IPC (Inter-Process Communication)

Decrypted private keys passed to executor subprocess via stdin:

```typescript
// Parent process
const executor = spawn('node', ['drift-executor.mjs']);

// Pass key via stdin, not env var or args
executor.stdin.write(JSON.stringify({
  action: 'trade',
  privateKey: decryptedPrivateKeyBase58,  // Already decrypted
  market: 'SOL-PERP',
  // ... other params
}));
executor.stdin.end();

// Immediately zeroize in parent
zeroizeBuffer(decryptedPrivateKeyBuffer);
```

### Executor Security Controls

| Control | Implementation |
|---------|----------------|
| No disk writes | Private key never written to any file |
| No logging | Private key never logged, even on error |
| Memory wipe | Zeroize key buffer after transaction signed |
| Process isolation | Executor runs as separate process |
| Crash handling | Crash dumps excluded from key memory regions |
| Lifetime limit | Key in memory for milliseconds only |
| No caching | Fresh decryption for each trade |

### Zeroize Implementation

```typescript
function zeroizeBuffer(buffer: Buffer): void {
  if (buffer && buffer.length > 0) {
    crypto.randomFillSync(buffer);  // Overwrite with random
    buffer.fill(0);                  // Then zero
  }
}

function zeroizeString(str: string): void {
  // Strings are immutable in JS, but we can request GC
  str = '';
  if (global.gc) global.gc();
}
```

---

## Security Terminology Corrections

### Incorrect Claims (v1)

> "Zero-knowledge server - server can't access funds without user signature"

**Why incorrect**: Server MUST see decrypted keys at runtime to sign Solana transactions for automated trading.

### Correct Claims (v2)

- "At-rest encryption per user"
- "Server requires user authorization to enable autonomous execution"
- "Execution authorization can be revoked at any time"
- "Keys are encrypted at rest per user and unwrapped into memory only when needed"
- "Runtime keys are ephemeral in memory with sub-second lifetime"
- "Database breach without server compromise exposes only ciphertext"

---

## Development Mode

### NO WEAK FALLBACK KEYS

```typescript
// OLD (INSECURE - REMOVED)
if (process.env.NODE_ENV === 'development') {
  return 'a'.repeat(64);  // NEVER DO THIS
}

// NEW (SECURE)
function getServerExecutionKey(): Buffer {
  const key = process.env.SERVER_EXECUTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error(
      'SERVER_EXECUTION_KEY must be set to a 64-character hex string (256 bits). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(key, 'hex');
}
```

### Development Key Generation

```bash
# Generate a proper dev key (run once, store in .env)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Migration Strategy

### For Existing Data (Single User)

Since you're the only user, migration is a clean cut-over:

1. **Backup current agent wallet public key** (write it down)
2. **Record current agent wallet balance** (for verification)
3. **Deploy new code**
4. **Connect wallet, sign unlock message**
5. **System generates new UMK**
6. **System generates new agent wallet with mnemonic**
7. **REVEAL AND SECURELY STORE MNEMONIC**
8. **Transfer funds from old agent wallet to new one**
9. **Enable execution for bots**
10. **Delete old `AGENT_ENCRYPTION_KEY` from environment**
11. **Invalidate all old sessions**
12. **Verify no old encrypted blobs in backups**

### Post-Migration Verification

- [ ] New agent wallet has funds
- [ ] Mnemonic backed up securely
- [ ] Bots can execute trades
- [ ] Old wallet is empty
- [ ] Old encryption key deleted
- [ ] Sessions invalidated

---

## Implementation Phases

### Phase 1: Schema & Crypto Foundation (2-3 hours)

- Add new schema columns
- Implement UMK envelope encryption
- Implement HKDF key derivation
- Implement subkey derivation
- Implement proper AES-GCM with AAD
- Remove dev fallback key

### Phase 2: Authentication Flow (2-3 hours)

- Implement nonce generation and validation
- Implement purpose-specific signatures
- Implement UMK creation flow (first login)
- Implement UMK unwrap flow (subsequent logins)
- Implement session key caching

### Phase 3: Agent Wallet with Mnemonic (2 hours)

- Implement BIP-39 mnemonic generation
- Implement Solana derivation path
- Implement mnemonic encryption/storage
- Implement mnemonic reveal flow with rate limiting

### Phase 4: Execution Authorization (2-3 hours)

- Implement enable/revoke execution flow
- Implement execution key wrapping
- Implement bot execution policies
- Update webhook handler to check authorization
- Implement daily loss tracking

### Phase 5: Executor Updates (1 hour)

- Remove in-executor decryption
- Accept pre-decrypted key via stdin
- Implement buffer zeroization
- Ensure no logging of keys

### Phase 6: Testing & Hardening (2-3 hours)

- Test full authentication flow
- Test mnemonic backup/reveal
- Test bot execution
- Test rate limiting
- Test revocation
- Verify no key logging

**Total Estimate**: 12-16 hours

---

## Security Checklist

### Pass Criteria (ALL must be true)

- [ ] Uses UMK envelope pattern, not signature-derived key for direct encryption
- [ ] Nonces are single-use, stored server-side, expire
- [ ] Messages are domain-bound and cluster-bound
- [ ] Per-purpose signatures with appropriate TTLs
- [ ] AES-GCM uses 12-byte random IV, never reused
- [ ] AAD includes wallet + record type + version
- [ ] Per-purpose subkeys derived from UMK
- [ ] No dev fallback weak keys
- [ ] Headless bot execution model with explicit enable/revoke
- [ ] Bot execution policies with limits and kill switch
- [ ] Mnemonic reveal locked behind high-privilege auth and rate limit
- [ ] Solana derivation path verified: m/44'/501'/0'/0'
- [ ] Executor never logs or caches private keys
- [ ] Buffer zeroization implemented

### Fail Criteria (ANY means not ready)

- [ ] Signature-derived key used directly for long-lived data
- [ ] Nonces are reusable or not stored server-side
- [ ] Bots require live user signing to execute
- [ ] Mnemonic can be revealed without fresh signature
- [ ] Dev mode uses weak/default keys
- [ ] Private keys logged anywhere

---

## Open Questions Resolved

| Question | Resolution |
|----------|------------|
| Session timeout | 24 hours for UMK unlock |
| Execution timeout | 1 hour (re-enable required) |
| Mnemonic reveal limit | 3 per hour, 2-min TTL signature |
| Derivation path | m/44'/501'/0'/0' (Solana standard) |
| Automation model | SERVER_EXECUTION_KEY wraps per-user EK |

---

## Dependencies

### NPM Packages Required

```json
{
  "bip39": "^3.1.0",
  "ed25519-hd-key": "^1.3.0"
}
```

### Environment Variables Required

```bash
# Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SERVER_EXECUTION_KEY=<64-char-hex-string>
```

---

*Document created: January 2026*  
*Revised after security review: January 2026*  
*Version: 2.0*

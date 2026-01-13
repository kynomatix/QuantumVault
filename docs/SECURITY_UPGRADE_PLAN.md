# QuantumVault Security Upgrade Plan

## Overview

This document outlines a major security upgrade to implement Web3-native encryption for agent wallets. The upgrade replaces the current server-wide encryption key with per-user key derivation based on wallet signatures.

**Status**: Planning  
**Priority**: Critical  
**Breaking Change**: Yes (clean migration required)

---

## Current State Analysis

### Existing Architecture

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

### Current Files

| File | Purpose |
|------|---------|
| `server/crypto.ts` | AES-256-GCM encrypt/decrypt with static key |
| `server/agent-wallet.ts` | Agent wallet generation (no mnemonic) |
| `server/drift-executor.mjs` | Trade execution, decrypts keys |
| `server/drift-executor-bundle.mjs` | Alternative executor |
| `shared/schema.ts` | Database schema with encrypted key fields |

### Current Weaknesses

1. **Single Point of Failure**: One env var encrypts all wallets
2. **No User Isolation**: Server can decrypt any user's keys
3. **No Backup/Recovery**: Agent wallets have no mnemonic
4. **No Web3 Integration**: Encryption doesn't leverage wallet signatures
5. **Dev Mode Risk**: Falls back to weak key in development

---

## Proposed Architecture

### New Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                    PROPOSED (SECURE)                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  User's Phantom Wallet                                      │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Sign Message: "QuantumVault:{wallet}:{nonce}"        │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ HKDF Key Derivation                                  │   │
│  │ Input: signature + wallet_address + app_salt         │   │
│  │ Output: 256-bit user-specific encryption key         │   │
│  └──────────────────────────────────────────────────────┘   │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────┐                                           │
│  │ AES-256-GCM  │◄─── Unique key PER USER                   │
│  └──────────────┘                                           │
│         │                                                   │
│         ▼                                                   │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Database                                             │   │
│  │ ├─ wallet_1: encrypted with wallet_1's derived key   │   │
│  │ ├─ wallet_2: encrypted with wallet_2's derived key   │   │
│  │ └─ wallet_N: encrypted with wallet_N's derived key   │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
│  SECURITY: Each user's data requires THEIR wallet signature │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Key Derivation Function

```typescript
function deriveUserEncryptionKey(
  walletAddress: string,
  signature: Uint8Array,
  appSalt: string
): Buffer {
  // HKDF (HMAC-based Key Derivation Function)
  // RFC 5869 compliant
  const ikm = Buffer.concat([
    Buffer.from(walletAddress),
    Buffer.from(signature),
  ]);
  
  const salt = Buffer.from(appSalt);
  const info = Buffer.from('QuantumVault-AgentWallet-v1');
  
  return crypto.hkdfSync('sha256', ikm, salt, info, 32);
}
```

### Mnemonic Backup System

```
┌─────────────────────────────────────────────────────────────┐
│                 MNEMONIC BACKUP FLOW                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. CREATE AGENT WALLET                                     │
│     ┌────────────────────────────────────────────────────┐  │
│     │ Generate BIP-39 mnemonic (24 words)                │  │
│     │ Derive keypair from mnemonic                       │  │
│     │ Encrypt mnemonic with user's derived key           │  │
│     │ Store: agentMnemonicEncrypted, agentPublicKey      │  │
│     └────────────────────────────────────────────────────┘  │
│                                                             │
│  2. REVEAL MNEMONIC (User Request)                          │
│     ┌────────────────────────────────────────────────────┐  │
│     │ User signs message with Phantom                    │  │
│     │ Server derives decryption key from signature       │  │
│     │ Decrypt mnemonic                                   │  │
│     │ Return to client (display once, never log)         │  │
│     └────────────────────────────────────────────────────┘  │
│                                                             │
│  3. RECOVER WALLET (New Device)                             │
│     ┌────────────────────────────────────────────────────┐  │
│     │ User enters mnemonic                               │  │
│     │ Derive keypair from mnemonic                       │  │
│     │ User signs new authentication message              │  │
│     │ Re-encrypt mnemonic with new signature-derived key │  │
│     └────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Database Schema Updates

**Files to modify**: `shared/schema.ts`

```typescript
// Add to wallets table:
agentMnemonicEncrypted: text("agent_mnemonic_encrypted"),
encryptionNonce: text("encryption_nonce"),  // For key derivation
encryptionVersion: integer("encryption_version").default(2),
```

**Migration**: 
- Add new columns (nullable for clean migration)
- No data migration needed (re-encrypt on next auth)

### Phase 2: Crypto Module Rewrite

**Files to create/modify**:
- `server/crypto.ts` → Complete rewrite
- `server/crypto-v2.ts` → New module (or replace in-place)

**New Functions**:

```typescript
// Key derivation from wallet signature
export function deriveEncryptionKey(
  walletAddress: string,
  signature: Uint8Array
): Buffer;

// Encrypt with user-specific key
export function encryptForUser(
  plaintext: string,
  userKey: Buffer
): string;

// Decrypt with user-specific key
export function decryptForUser(
  ciphertext: string,
  userKey: Buffer
): string;

// Generate BIP-39 mnemonic
export function generateMnemonic(): string;

// Derive keypair from mnemonic
export function keypairFromMnemonic(mnemonic: string): Keypair;
```

### Phase 3: Agent Wallet Module Updates

**Files to modify**: `server/agent-wallet.ts`

**Changes**:
- Generate mnemonic-based wallets
- Accept user-derived encryption key as parameter
- Return encrypted mnemonic for storage

```typescript
export function generateAgentWallet(userEncryptionKey: Buffer): {
  publicKey: string;
  encryptedMnemonic: string;
  encryptedPrivateKey: string;
}
```

### Phase 4: Authentication Flow Updates

**Files to modify**: 
- `server/routes.ts`
- `client/src/pages/WalletManagement.tsx`
- `client/src/components/WelcomePopup.tsx`

**New Flows**:

1. **Wallet Connection**
   - User signs authentication message
   - Server derives encryption key from signature
   - Key cached in session (memory only, never stored)

2. **Agent Wallet Creation**
   - Requires fresh signature
   - Generate mnemonic + keypair
   - Encrypt with signature-derived key

3. **Trade Execution**
   - Check if encryption key in session
   - If not, prompt user to sign message
   - Decrypt agent private key for trade

4. **Mnemonic Reveal**
   - Require fresh signature (prevent replay)
   - Decrypt and return mnemonic
   - Display once, user copies manually

### Phase 5: Executor Updates

**Files to modify**:
- `server/drift-executor.mjs`
- `server/drift-executor-bundle.mjs`

**Changes**:
- Accept pre-decrypted private key from parent process
- Remove in-executor decryption (key never leaves server memory)
- Pass key via stdin (not env var for security)

### Phase 6: Session Security

**New Session Fields**:

```typescript
interface SecureSession {
  walletAddress: string;
  encryptionKey: Buffer;  // Derived from signature, memory only
  keyExpiry: Date;        // Force re-auth after timeout
}
```

**Session Rules**:
- Encryption key never persisted to database
- Auto-expire after 24 hours (configurable)
- Clear on logout
- Fresh signature required for sensitive operations

---

## Security Properties

### After Upgrade

| Property | Status |
|----------|--------|
| Per-user encryption isolation | ✅ |
| Zero-knowledge server | ✅ (server can't decrypt without user signature) |
| Mnemonic backup | ✅ |
| Cross-device recovery | ✅ |
| Replay attack protection | ✅ (nonce in signature message) |
| Forward secrecy | ✅ (new signature = new key derivation) |
| Quantum-ready | ⚠️ (HKDF+AES-256 considered secure for now) |

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Database breach | Encrypted data useless without user signatures |
| Server compromise | Encryption keys only in memory, ephemeral |
| Session hijacking | Keys expire, sensitive ops need fresh signature |
| Man-in-the-middle | HTTPS + signature verification |
| Replay attacks | Timestamp/nonce in signed messages |

---

## Migration Strategy

### For Existing Data (Your Account)

Since you're the only user, migration is straightforward:

1. **Backup current agent wallet public key** (write it down)
2. **Deploy new code**
3. **Connect wallet, sign new authentication message**
4. **System generates NEW agent wallet** with mnemonic
5. **Transfer funds from old agent wallet to new one**
6. **Delete old encrypted data**

### Future Users

- New users automatically get the secure system
- No legacy code paths needed

---

## Testing Checklist

- [ ] Wallet connection + signature flow
- [ ] Agent wallet generation with mnemonic
- [ ] Mnemonic encryption/decryption
- [ ] Trade execution with derived key
- [ ] Mnemonic reveal flow
- [ ] Session expiry and re-authentication
- [ ] Cross-device recovery
- [ ] Webhook signals still work
- [ ] Position tracking still works
- [ ] No regressions in 1m and 5m bots

---

## Dependencies

### New NPM Packages

```json
{
  "bip39": "^3.1.0",      // BIP-39 mnemonic generation
  "ed25519-hd-key": "^1.3.0"  // HD key derivation for Ed25519
}
```

### Existing (No Changes)

- `@solana/web3.js` - Already has Keypair
- `crypto` - Node.js built-in for HKDF

---

## Rollback Plan

If issues are discovered post-deployment:

1. Old encrypted data already deleted (no rollback to old system)
2. Generate new agent wallet with old (insecure) method temporarily
3. Transfer funds back
4. Fix issues in new system
5. Re-migrate to secure system

**Recommendation**: Test thoroughly in development before deploying.

---

## Timeline Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1: Schema | 30 min | None |
| Phase 2: Crypto | 2 hours | Phase 1 |
| Phase 3: Agent Wallet | 1 hour | Phase 2 |
| Phase 4: Auth Flow | 3 hours | Phase 2, 3 |
| Phase 5: Executors | 1 hour | Phase 2 |
| Phase 6: Sessions | 1 hour | Phase 4 |
| Testing | 2 hours | All phases |

**Total**: ~10-12 hours of implementation

---

## Approval Checklist

- [ ] Security model reviewed
- [ ] Migration strategy approved
- [ ] Backup of current agent wallet addresses
- [ ] Timeline acceptable
- [ ] Ready to proceed

---

## Questions for Review

1. **Session timeout**: How long should encryption key remain valid in session? (Suggested: 24 hours)

2. **Signature message format**: What should users see when signing?
   - Suggested: `"QuantumVault Security: Authorize wallet access\nWallet: {address}\nTimestamp: {iso_date}"`

3. **Mnemonic reveal frequency**: Should we limit how often mnemonic can be revealed?

4. **Recovery flow**: Should recovery be self-service or require verification?

---

*Document created: January 2026*  
*Last updated: January 2026*  
*Author: QuantumVault Development*

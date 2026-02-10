# QuantumVault Security

## Your Funds Are Protected

QuantumVault is built with institutional-grade security to protect your trading capital. This document explains how we keep your funds safe.

---

## How Your Wallet Is Protected

### Your Keys, Your Control

QuantumVault uses a unique **agent wallet** system that keeps you in complete control:

- **You own your agent wallet** - Each user gets a dedicated Solana wallet for trading
- **Recoverable with seed phrase** - Your agent wallet can be restored using a standard 24-word recovery phrase
- **Never shares your main wallet keys** - Your Phantom wallet keys are never stored or transmitted

### Bank-Grade Encryption

All sensitive data is protected with **AES-256-GCM encryption** - the same standard used by banks and governments:

| What's Protected | How It's Protected |
|-----------------|-------------------|
| Agent wallet private key | Encrypted with your personal master key |
| Recovery phrase | Encrypted and only revealed when you request it |
| Session data | Protected with per-user encryption keys |

### Your Personal Master Key (UMK)

Every user has a unique **User Master Key** that:

- Is derived from your wallet signature (only you can generate it)
- Encrypts all your sensitive data
- Is never stored in plain text
- Cannot be accessed without your Phantom wallet

---

## Trade Execution Security

### Signature-Based Authorization

Before QuantumVault can execute trades on your behalf:

1. **You must explicitly enable execution** by signing a message with your Phantom wallet
2. **Each bot requires separate authorization** - revoking one doesn't affect others
3. **You can revoke anytime** - instantly stop all automated trading with one click

### Bot Policy Protection

Your trading limits are cryptographically protected:

- Maximum position sizes cannot be secretly modified
- Allowed markets are locked when you enable a bot
- Any tampering with settings is automatically detected and blocked

### Emergency Stop

If something goes wrong, you have multiple safety options:

- **Revoke Execution** - Immediately stops all automated trading
- **Close All Positions** - One-click to exit all trades
- **Reset Agent Wallet** - Generate a completely new trading wallet

---

## What We Never Do

- **Never store your Phantom private keys** - We only ask you to sign messages
- **Never have access to your main wallet** - Only your dedicated agent wallet
- **Never log sensitive data** - Private keys and recovery phrases are never written to logs
- **Never share your data** - Your encryption keys are unique to you

---

## Recovery Options

### If You Lose Access

Your agent wallet includes a **24-word recovery phrase** that you can:

1. Reveal securely in Settings (requires wallet signature)
2. Import into any standard Solana wallet (Phantom, Solflare, etc.)
3. Recover your trading funds independently

### Rate Limits for Protection

To prevent unauthorized access:

- Recovery phrase can only be revealed **3 times per hour**
- Each reveal requires a fresh signature from your wallet
- Phrase auto-hides after 60 seconds for safety

---

## Technical Security Measures

### Encryption Standards

| Standard | Usage |
|----------|-------|
| AES-256-GCM | All data encryption |
| HKDF-SHA256 | Key derivation |
| Ed25519 | Signature verification |
| BIP-39 | Recovery phrase generation |

### Memory Protection

- Sensitive data is immediately cleared from memory after use
- Private keys never exist as strings (only secure buffers)
- Cryptographic zeroization prevents memory analysis

### Session Security

- Sessions expire after 24 hours of inactivity
- Each signature uses a unique one-time nonce
- Cookies are HTTP-only and secure

---

## Best Practices for Users

### Keep Your Recovery Phrase Safe

1. **Write it down on paper** - never store digitally
2. **Keep in a secure location** - fireproof safe recommended
3. **Never share with anyone** - QuantumVault will never ask for it
4. **Test recovery** - verify you can access before depositing large amounts

### Monitor Your Bots

1. **Check positions regularly** - review open trades daily
2. **Set conservative limits** - start with smaller position sizes
3. **Use execution authorization wisely** - only enable when needed
4. **Review trade history** - check for any unexpected activity

### Secure Your Phantom Wallet

1. **Use a hardware wallet** - Ledger support through Phantom
2. **Enable Phantom's security features** - auto-lock, transaction simulation
3. **Never sign unknown messages** - only sign QuantumVault requests you initiated

---

## Audit & Review

QuantumVault's security has been reviewed by:

- Internal security architect
- AI-assisted security audits (ChatGPT, Gemini Pro)
- Continuous code review and testing

**Security Version**: 3.0  
**Last Updated**: January 2026

---

## Questions?

If you have security concerns or notice suspicious activity:

1. Immediately revoke execution for all bots
2. Use "Close All Positions" in Danger Zone
3. Consider resetting your agent wallet
4. Report the issue through our support channels

Your security is our top priority.

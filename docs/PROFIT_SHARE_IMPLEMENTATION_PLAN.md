# Profit Share Implementation Plan

## Overview

This document outlines the implementation strategy for profit sharing between signal bot creators and their subscribers in the QuantumVault marketplace. The goal is to enable creators to earn 0-10% of subscriber profits in a gas-optimized, reliable manner.

## Current Architecture Context

### Existing Flow
1. Creator publishes bot with `profitSharePercent` (0-10%)
2. Subscriber copies trades from creator's bot via webhook routing
3. Each subscriber has their own Drift subaccount with independent positions
4. When subscriber's position closes/flips, PnL is realized on-chain
5. PnL settlement already happens automatically via Drift SDK

### Key Constraints
- Solana transaction fees are ~$0.00025 per transaction (very cheap)
- Drift PnL settlement must happen before profit can be distributed
- Each subscriber has their own agent wallet (server-managed)
- Creator's wallet address is stored in `publishedBots.creatorWalletAddress`
- Subscription relationship stored in `botSubscriptions` table

---

## Implementation Options

### Option A: Immediate On-Chain Transfer at Position Close (Recommended)

**Description**: Transfer profit share to creator immediately when subscriber's position closes profitably, as part of the same execution flow.

**Flow**:
```
1. Subscriber position closes on Drift
2. Calculate realized PnL from trade
3. If PnL > 0 and profitSharePercent > 0:
   a. Calculate creator's share: profitShare = PnL * (profitSharePercent / 100)
   b. Transfer USDC from subscriber's agent wallet to creator's agent wallet
4. Log the transfer for transparency
```

**Pros**:
- Immediate payment to creators
- No database accumulation needed
- Transparent - on-chain record of every payment
- Simple mental model for users
- Can bundle with existing trade execution flow

**Cons**:
- One extra USDC transfer per profitable close (~$0.00025)
- Requires creator to have agent wallet (already required for publishing)
- Need to handle edge cases (insufficient balance, etc.)

**Gas Cost Analysis**:
- USDC SPL token transfer: ~5,000 compute units
- Current Solana fee: ~$0.00025 per transaction
- If bundled with close order: minimal additional cost
- Standalone transfer if needed: still negligible

---

### Option B: Off-Chain Accumulation with Periodic Settlement

**Description**: Track profit share owed in database, settle periodically (daily/weekly) in batch transactions.

**Flow**:
```
1. Subscriber position closes on Drift
2. Calculate profit share owed
3. Store in database: pending_profit_shares table
4. Daily cron job aggregates all pending shares per creator
5. Execute single batch transfer to each creator
```

**Pros**:
- Fewer on-chain transactions
- Can batch multiple subscribers' shares to same creator
- Lower total gas if many small trades

**Cons**:
- Delayed payment to creators (trust issue)
- Database dependency for financial tracking
- More complex reconciliation
- Potential for disputes if system fails before settlement
- Creators may be upset about delayed payments

**NOT RECOMMENDED**: Adds complexity and trust concerns without significant cost savings given Solana's low fees.

---

### Option C: Hybrid - Threshold-Based Settlement

**Description**: Accumulate small amounts, settle immediately when threshold reached or on position close.

**Flow**:
```
1. Track running profit share in memory/cache per subscription
2. When amount exceeds threshold (e.g., $1) OR position fully closes:
   - Execute on-chain transfer
3. Clear accumulator
```

**Pros**:
- Reduces micro-transactions for very small profits
- Still relatively immediate for meaningful amounts

**Cons**:
- Added complexity
- Still needs some tracking mechanism
- Edge cases around what happens to sub-threshold amounts

**MAYBE**: Could be a future optimization if needed.

---

## Recommended Implementation: Option A

### Detailed Technical Design

#### 1. Data Model (Already Exists)
```typescript
// publishedBots table
profitSharePercent: decimal("profit_share_percent", { precision: 5, scale: 2 }).default("0")

// botSubscriptions table (link subscriber to published bot)
publishedBotId, subscriberWalletAddress, subscriberBotId
```

#### 2. Profit Share Execution Point

**Location**: Trade execution flow after position close is confirmed

**Trigger**: When `syncResult.isClosingTrade === true && syncResult.tradePnl > 0`

**Files to modify**:
- `server/routes.ts` - Multiple webhook handlers that process closes
- `server/drift-executor.mjs` - Could add profit share as post-execution step

#### 3. Implementation Steps

```typescript
// After successful close trade execution:
async function distributeCreatorProfitShare(
  subscriberBotId: string,
  realizedPnl: number,
  subscriberAgentWallet: string
): Promise<{ success: boolean; txSignature?: string; amount?: number }> {
  
  // 1. Get subscription details
  const subscription = await storage.getSubscriptionByBotId(subscriberBotId);
  if (!subscription) return { success: true }; // Not a subscription bot
  
  // 2. Get published bot with profit share %
  const publishedBot = await storage.getPublishedBotById(subscription.publishedBotId);
  if (!publishedBot || parseFloat(publishedBot.profitSharePercent) <= 0) {
    return { success: true }; // No profit share configured
  }
  
  // 3. Calculate profit share
  const profitSharePercent = parseFloat(publishedBot.profitSharePercent);
  const creatorShare = realizedPnl * (profitSharePercent / 100);
  
  // 4. Minimum threshold check (avoid dust transfers)
  if (creatorShare < 0.01) { // Less than 1 cent
    return { success: true }; // Skip dust amounts
  }
  
  // 5. Get creator's agent wallet
  const creatorWallet = await storage.getWallet(publishedBot.creatorWalletAddress);
  if (!creatorWallet?.agentPublicKey) {
    console.warn('[ProfitShare] Creator has no agent wallet');
    return { success: false };
  }
  
  // 6. Execute USDC transfer: subscriber agent -> creator agent
  const txSignature = await transferUsdcBetweenAgents(
    subscriberAgentWallet,
    creatorWallet.agentPublicKey,
    creatorShare
  );
  
  // 7. Log for transparency (optional - could skip to minimize DB)
  console.log(`[ProfitShare] Transferred $${creatorShare.toFixed(4)} to creator ${publishedBot.creatorWalletAddress}`);
  
  return { success: true, txSignature, amount: creatorShare };
}
```

#### 4. USDC Transfer Function

```typescript
async function transferUsdcBetweenAgents(
  fromAgentPublicKey: string,
  toAgentPublicKey: string,
  amount: number
): Promise<string> {
  // Use existing SPL token transfer infrastructure
  // Both wallets are server-managed, so we have signing authority
  
  const fromKeypair = await getAgentKeypair(fromAgentPublicKey);
  const transaction = await createUsdcTransferTransaction(
    fromAgentPublicKey,
    toAgentPublicKey,
    amount
  );
  
  // Sign and send
  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  return signature;
}
```

#### 5. Integration Points

**Option 5a: Bundle with Close Trade (Preferred)**
- Modify the close trade execution to include profit share transfer
- Both operations in same execution context
- If profit share fails, log warning but don't fail the close

**Option 5b: Post-Trade Hook**
- Execute profit share as immediate follow-up to successful close
- Separate transaction but executed synchronously
- Slightly cleaner separation of concerns

#### 6. Edge Cases

| Scenario | Handling |
|----------|----------|
| Subscriber has insufficient USDC | Skip profit share, log warning |
| Creator no longer has agent wallet | Skip profit share, log warning |
| Very small profit (<$0.01 share) | Skip to avoid dust |
| Network failure during transfer | Log failure, don't retry (accept some loss) |
| Position flip (close + open) | Only apply to the close portion's PnL |

#### 7. Transparency & Logging

Minimal DB usage option:
- Log to console/monitoring system only
- On-chain transaction serves as audit trail
- Users can query Solana for transfer history

Optional DB tracking (if needed later):
```sql
CREATE TABLE profit_share_distributions (
  id UUID PRIMARY KEY,
  subscription_id UUID REFERENCES bot_subscriptions(id),
  trade_id UUID REFERENCES bot_trades(id),
  realized_pnl DECIMAL,
  profit_share_percent DECIMAL,
  amount_distributed DECIMAL,
  tx_signature TEXT,
  created_at TIMESTAMP
);
```

---

## Gas Cost Summary

| Action | Cost (SOL) | Cost (USD) |
|--------|------------|------------|
| Close trade on Drift | ~0.00001 | ~$0.0002 |
| USDC transfer (profit share) | ~0.000005 | ~$0.0001 |
| **Total per profitable close** | ~0.000015 | **~$0.0003** |

Conclusion: Gas cost is negligible. Immediate on-chain settlement is practical.

---

## Implementation Phases

### Phase 1: Core Implementation
- [ ] Add `distributeCreatorProfitShare` function
- [ ] Add `transferUsdcBetweenAgents` utility
- [ ] Integrate into close trade handlers
- [ ] Add console logging for monitoring

### Phase 2: UI Transparency
- [ ] Show profit share history in creator dashboard
- [ ] Show profit share deductions in subscriber trade history
- [ ] Display estimated creator earnings on marketplace

### Phase 3: Future Optimizations (If Needed)
- [ ] Batch small amounts with threshold
- [ ] Add optional DB tracking for detailed analytics
- [ ] Creator withdrawal to main wallet option

---

## Open Questions for Review

1. **Dust threshold**: Is $0.01 minimum appropriate, or should it be higher/lower?
2. **Failure handling**: Accept silent failures, or implement retry queue?
3. **Creator notification**: Should creators get Telegram alerts for profit shares?
4. **Tax implications**: Should we track/report profit share distributions?
5. **Partial closes**: How to handle partial position closes with multiple profit share events?

---

## Recommendation

**Proceed with Option A (Immediate On-Chain Transfer)** because:
1. Solana fees are negligible (~$0.0003 total per profitable close)
2. Immediate payment builds trust with creators
3. On-chain record provides transparency without database
4. Minimal additional complexity
5. Aligns with DeFi principles of trustless execution

The implementation can be done in ~4-6 hours for core functionality.

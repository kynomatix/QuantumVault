# Profit Share Implementation Plan

## Overview

This document outlines the implementation strategy for profit sharing between signal bot creators and their subscribers in the QuantumVault marketplace. The goal is to enable creators to earn 0-10% of subscriber profits in a gas-optimized, reliable manner.

**Last Updated**: 2026-01-23 (Phases 1-2 completed)

---

## Critical Design Decisions (Post-Audit)

The following critical fixes were incorporated after external review:

| Issue | Root Cause | Fix |
|-------|------------|-----|
| **Liquidity Gap** | Profit sits in Drift subaccount, not agent wallet | Settle PnL → **Withdraw from Drift** → Transfer to creator |
| **Destination Wallet** | Originally planned for agent-to-agent only | Send directly to creator's **main Phantom wallet** (better UX) |
| **SOL Gas Check** | Agent might have USDC but no SOL for fees | Pre-flight check: require >0.003 SOL before transfer |
| **Hostage Risk** | Failed IOU = subscriber stuck forever | TTL: 50 retries or 7 days → void IOU, release subscriber |
| **Race Conditions** | Multiple retry triggers could double-pay | Status column: `pending` → `processing` → `paid`/`voided` |
| **Net vs Gross PnL** | Could charge fee on money subscriber didn't keep | Use `closeTradePnl` which already subtracts Drift fees |

---

## RPC Optimization Summary

Per-profitable-close RPC call budget (target: minimize without sacrificing reliability):

| Operation | RPC Calls | Optimization Applied |
|-----------|-----------|---------------------|
| Validation (steps 1-5) | 0 | Pure logic, DB query only |
| Drift withdrawal | 3-5 | Unavoidable (SDK-managed) |
| Transfer to creator | 4-5 | Batched lookups (fresh blockhash for reliability) |
| **Total** | **7-10** | Down from 9-11 |

**Key Optimizations:**
1. **Batch account lookups**: `getMultipleAccountsInfo([agent, creatorATA])` instead of 2 separate calls
2. **Skip redundant USDC check**: After Drift withdrawal succeeds, balance is guaranteed
3. **Early exit validation**: 5 validation steps before any RPC call

**Why not reuse blockhash from Drift withdrawal?**
- Solana blockhashes expire in ~60-90 seconds
- Drift withdrawal + confirmation can take 5-45 seconds
- By transfer time, blockhash may be stale → "Blockhash not found" error
- **Decision**: Always fetch fresh blockhash for transfer (1 extra RPC call worth the reliability)

**Why not fewer RPC calls?**
- Drift SDK withdrawal is opaque (3-5 calls unavoidable)
- Transaction send + confirmation are mandatory (2 calls)
- SOL balance check is safety-critical (batched into 1 call)
- Fresh blockhash is reliability-critical (1 call)

---

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

### Key Data Relationships
```
tradingBots.sourcePublishedBotId → publishedBots.id (links subscription bot to source)
botSubscriptions.subscriberBotId → tradingBots.id (links subscription to specific bot)
botSubscriptions.publishedBotId → publishedBots.id (links to the signal source)
publishedBots.profitSharePercent → decimal 0-10 (creator's fee)
publishedBots.creatorWalletAddress → wallets.address (creator's main wallet)
```

---

## Recommended Implementation: Immediate On-Chain Transfer + IOU Failover

### Why This Approach
1. Solana fees are negligible (~$0.0003 total per profitable close)
2. Immediate payment builds trust with creators
3. On-chain record provides transparency
4. IOU failover ensures creators never lose money due to temporary failures
5. Aligns with DeFi principles of trustless execution

### The IOU System (Failover for Failed Transfers)

**Problem**: If an on-chain transfer fails (RPC overload, network issues), the creator could lose their profit share - especially if the subscriber closes their bot after a big win and there are no more trades.

**Solution**: A lightweight "IOU" system that only tracks **failed transfers** in the database. Successful transfers are NOT stored (no database bloat).

```
┌─────────────────────────────────────────────────────────────┐
│  PROFIT SHARE FLOW                                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Trade Closes with Profit                                   │
│         │                                                   │
│         ▼                                                   │
│  ┌─────────────────┐                                        │
│  │ Attempt On-Chain│                                        │
│  │    Transfer     │                                        │
│  └────────┬────────┘                                        │
│           │                                                 │
│     ┌─────┴─────┐                                           │
│     │           │                                           │
│   Success     Fail                                          │
│     │           │                                           │
│     ▼           ▼                                           │
│   Done ✓    Record IOU                                      │
│   (no DB)   in Database                                     │
│                 │                                           │
│                 ▼                                           │
│         Multiple Retry Triggers:                            │
│         • Next trade close                                  │
│         • Background job (every 5 min)                      │
│         • Before subscriber withdrawal                      │
│         • Before bot deletion                               │
│                 │                                           │
│                 ▼                                           │
│            IOU Paid → Delete from DB                        │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Key Principle**: The database is NOT holding funds - it's just an "IOU note" that says "we owe this creator $X, keep trying to pay them." The actual money movement is always on-chain.

### IOU Database Table (Failed Transfers Only)

```sql
CREATE TABLE pending_profit_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_bot_id VARCHAR NOT NULL REFERENCES trading_bots(id),
  subscriber_wallet_address TEXT NOT NULL,
  creator_wallet_address TEXT NOT NULL,  -- Creator's MAIN wallet (Phantom), not agent
  amount DECIMAL(20, 6) NOT NULL,
  realized_pnl DECIMAL(20, 6) NOT NULL,
  profit_share_percent DECIMAL(5, 2) NOT NULL,
  trade_id UUID REFERENCES bot_trades(id),
  published_bot_id VARCHAR NOT NULL,
  drift_subaccount_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'processing', 'paid', 'voided'
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  last_attempt_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for efficient lookups
CREATE INDEX idx_pending_profit_shares_status ON pending_profit_shares(status);
CREATE INDEX idx_pending_profit_shares_subscriber ON pending_profit_shares(subscriber_bot_id);

-- IDEMPOTENCY: Prevent duplicate IOUs for same trade (webhook may fire twice)
CREATE UNIQUE INDEX idx_unique_profit_share 
ON pending_profit_shares(subscriber_bot_id, trade_id) 
WHERE status NOT IN ('voided', 'paid');
```

**Status Column (Prevents Race Conditions):**
| Status | Meaning |
|--------|---------|
| `pending` | Ready for retry attempt |
| `processing` | Currently being attempted (prevents double-send) |
| `paid` | Successfully transferred (will be deleted) |
| `voided` | Max retries exceeded, subscriber released |

**Race Condition Prevention:**
1. Job picks up IOU → Update to `processing`
2. If another trigger tries → Sees `processing` → Skips
3. If `processing` > 5 minutes old → Reset to `pending` (stale/crashed)

**Why only failed transfers?**
- Successful transfers: On-chain record is the audit trail (queryable via Solana explorer)
- Failed transfers: Need tracking to ensure eventual payment
- No bloat: Table only grows when things go wrong (should be rare)

### Payment Retry Triggers

The IOU system has **multiple triggers** to ensure creators get paid even in edge cases:

| Trigger | When | Why |
|---------|------|-----|
| **1. Next trade close** | Subscriber's next profitable close | Most common retry path |
| **2. Background job** | Every 5 minutes | Catches orphaned IOUs |
| **3. Before withdrawal** | Subscriber tries to withdraw USDC | Blocks "cash out and run" |
| **4. Before bot deletion** | Subscriber tries to delete bot | Last line of defense |

**Subscriber cannot escape**: They can't withdraw or delete their bot until pending IOUs are paid. This protects creators.

### IOU Lifecycle

```
1. Transfer attempt fails
   → Insert IOU record (status: 'pending', retry_count: 0)

2. Retry trigger fires
   → Update status to 'processing'
   → Attempt transfer
   → If success: Update status to 'paid', then DELETE record
   → If fail: Increment retry_count, update last_error, reset status to 'pending'

3. Stale 'processing' check (in background job)
   → If status = 'processing' AND last_attempt_at > 5 minutes ago
   → Reset to 'pending' (crashed/timed out attempt)

4. Max retry / TTL reached (HOSTAGE PREVENTION)
   → If retry_count >= 50 OR created_at > 7 days ago
   → Update status to 'voided'
   → Subscriber is RELEASED (can withdraw/delete)
   → Log alert for manual review
   → Creator can contact support to claim

5. Eventually paid
   → DELETE IOU record (no permanent storage)
```

### Hostage Prevention (TTL)

**Problem:** If the creator's wallet is broken/invalid, the transfer will always fail, trapping the subscriber forever.

**Solution:** After max retries or time limit, void the IOU and release the subscriber.

| Limit | Value | Rationale |
|-------|-------|-----------|
| Max retries | 50 | ~4 hours of background retries (every 5 min) |
| Max age | 7 days | Enough time for network issues to resolve |

**When IOU is voided:**
- Subscriber can withdraw/delete their bot
- Creator's funds remain in subscriber's Drift account (not lost)
- Creator can contact support for manual resolution
- Logged for admin review

This prevents a technical failure on the creator's side from permanently locking a subscriber's funds.

### Edge Cases (Post-Audit)

**1. Cross-Margin "Free Collateral" Issue:**
- Subscriber has Bot A: +$100 profit (closing now)
- Subscriber has Bot B: -$150 loss (still open)
- **Problem**: Drift withdrawal fails with "Insufficient Collateral" because overall account is underwater
- **Solution**: IOU is created. Background job retries. Creator gets paid when subscriber's account health improves or losing position closes.
- **Note**: "Profitable Trade" ≠ "Withdrawable Cash" in cross-margin accounts. This is correct behavior.

**2. SOL Starvation (UX Clarity):**
- If agent wallet runs out of SOL, profit share fails → IOU created → withdrawal blocked
- **UI Message should be specific**: "Withdrawal paused: Pending profit share payment. Your agent wallet needs ~0.003 SOL to process this fee."

**3. Drift Rounding (Dust Handling):**
- Drift's internal accounting uses high-precision integers
- Withdrawal of exactly $2.5034 might settle as $2.5033 due to rounding
- **Solution**: If transfer fails with "Insufficient Funds" by tiny amount, retry with `amount - 0.000001`

**4. Partial Withdrawal (New - Post-Audit):**
- Drift withdrawal can succeed but return less than requested if collateral/margin constraints exist
- **Solution**: Verify agent USDC balance after withdrawal meets `creatorShare`. If partial, create IOU for shortfall.

**5. Creator Wallet Validation (New - Post-Audit):**
- Must validate `creatorWalletAddress` is a valid Solana public key before attempting transfer
- **Solution**: Wrap `new PublicKey(creatorMainWallet)` in try/catch. Invalid = create IOU with admin alert.

**6. Admin Notifications for IOUs (New - Post-Audit):**
- Creator and admin should be notified when IOU is created or voided
- **Solution**: Add console logging + optional Telegram notification for:
  - IOU created (with reason)
  - IOU voided (after TTL)
  - IOU paid (success after retry)

---

## Existing Functions to Reuse

### From `server/agent-wallet.ts`:
| Function | Purpose | Notes |
|----------|---------|-------|
| `getAgentKeypair(encryptedPrivateKey)` | Decrypt agent keypair for signing | Already handles encryption |
| `buildWithdrawFromAgentTransaction()` | Transfer USDC from agent to user wallet | Reference for building transfers |
| `executeAgentWithdraw()` | Execute agent withdrawal | Pattern for signing/sending |
| `createTransferInstruction()` | Low-level SPL token transfer | Private helper, reuse pattern |

### From `server/drift-service.ts`:
| Function | Purpose | Notes |
|----------|---------|-------|
| `getConnection()` | Get Solana RPC connection | Standard connection getter |
| `getAgentUsdcBalance(agentPubkey)` | Check USDC balance | Use to verify funds available |

### From `server/storage.ts`:
| Function | Purpose | Notes |
|----------|---------|-------|
| `getPublishedBotById(id)` | Get published bot with profitSharePercent | Returns creator info too |
| `getBotSubscription(pubBotId, wallet)` | Lookup subscription | Need new function by botId |
| `getWallet(address)` | Get wallet with agent keys | To get creator's agent wallet |

---

## New Functions Required

### 1. Storage: `getBotSubscriptionBySubscriberBotId(botId)`

**Location**: `server/storage.ts`

**Purpose**: Look up subscription from the subscriber's bot ID (needed to find creator)

```typescript
async getBotSubscriptionBySubscriberBotId(botId: string): Promise<(BotSubscription & { publishedBot: PublishedBot }) | undefined> {
  const results = await db.select({
    subscription: botSubscriptions,
    publishedBot: publishedBots,
  })
  .from(botSubscriptions)
  .innerJoin(publishedBots, eq(botSubscriptions.publishedBotId, publishedBots.id))
  .where(and(
    eq(botSubscriptions.subscriberBotId, botId),
    eq(botSubscriptions.status, 'active')
  ))
  .limit(1);
  
  if (results.length === 0) return undefined;
  return { ...results[0].subscription, publishedBot: results[0].publishedBot };
}
```

### 2. RPC-Optimized Transfer: `transferUsdcToWallet()`

**Location**: `server/agent-wallet.ts`

**Purpose**: Transfer USDC from subscriber's agent wallet to creator's main Phantom wallet

**RPC Optimization**: Batch account lookups, skip redundant balance check

```
BEFORE (9-11 RPC calls):
1. getBalance (SOL check)
2. getTokenAccountBalance (USDC check)
3. getAccountInfo (creator ATA check)
4. getLatestBlockhash
5. sendRawTransaction
6. confirmTransaction (polling)
+ Drift withdrawal calls

AFTER (4-5 RPC calls for transfer):
1. getMultipleAccountsInfo (SOL + creator ATA in 1 call)
2. getLatestBlockhash (fresh for reliability)
3. sendRawTransaction  
4. confirmTransaction (polling)
+ Drift withdrawal calls (3-5)

SAVINGS: 2-3 fewer RPC calls per profitable close
```

```typescript
export async function transferUsdcToWallet(
  fromAgentPublicKey: string,
  fromEncryptedPrivateKey: string,
  toWalletAddress: string,  // Creator's Phantom wallet
  amountUsdc: number,
): Promise<{ success: boolean; signature?: string; error?: string; solBalance?: number }> {
  try {
    const connection = getConnection();
    const fromKeypair = getAgentKeypair(fromEncryptedPrivateKey);
    const fromPubkey = new PublicKey(fromAgentPublicKey);
    const toPubkey = new PublicKey(toWalletAddress);
    const usdcMint = new PublicKey(USDC_MINT);
    
    const fromAta = getAssociatedTokenAddressSync(usdcMint, fromPubkey);
    const toAta = getAssociatedTokenAddressSync(usdcMint, toPubkey);
    
    const amountLamports = Math.round(amountUsdc * 1_000_000);
    if (amountLamports <= 0) {
      return { success: false, error: 'Invalid amount' };
    }
    
    // RPC OPTIMIZATION: Batch fetch agent SOL balance + creator ATA in 1 call
    const [agentAccountInfo, toAtaInfo] = await connection.getMultipleAccountsInfo([
      fromPubkey,  // Agent wallet (for SOL balance)
      toAta,       // Creator's USDC ATA (check if exists)
    ]);
    
    // Check SOL balance for gas fees (~0.003 SOL needed)
    const solBalance = (agentAccountInfo?.lamports || 0) / 1_000_000_000;
    if (solBalance < 0.003) {
      return { success: false, error: `Insufficient SOL for gas: ${solBalance}`, solBalance };
    }
    
    // NOTE: Skip USDC balance check - Drift withdrawal already succeeded,
    // so balance is guaranteed. Checking again would be redundant RPC call.
    
    const instructions: TransactionInstruction[] = [];
    
    // Create destination ATA if it doesn't exist (already checked via batch)
    if (!toAtaInfo) {
      instructions.push(
        createAssociatedTokenAccountInstruction(
          fromPubkey, // payer (subscriber pays for ATA creation)
          toAta,
          toPubkey,
          usdcMint
        )
      );
    }
    
    // Add transfer instruction
    instructions.push(
      createTransferInstruction(fromAta, toAta, fromPubkey, BigInt(amountLamports))
    );
    
    // Always fetch fresh blockhash for reliability (stale blockhash = tx failure)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    
    const transaction = new Transaction({
      feePayer: fromPubkey,
      blockhash,
      lastValidBlockHeight,
    });
    
    for (const ix of instructions) {
      transaction.add(ix);
    }
    
    transaction.sign(fromKeypair);
    
    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, preflightCommitment: 'confirmed' }
    );
    
    // Wait for confirmation
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    
    return { success: true, signature, solBalance };
  } catch (error: any) {
    console.error('[TransferToWallet] Error:', error.message);
    return { success: false, error: error.message };
  }
}
```

### 3. Profit Share: `distributeCreatorProfitShare()`

**Location**: `server/routes.ts` (or new `server/profit-share.ts`)

**Purpose**: Main profit share distribution logic (RPC-optimized)

**IMPORTANT: `realizedPnl` must be NET profit (after Drift fees)**
The `closeTradePnl` calculated in routes.ts already subtracts fees:
```typescript
tradePnl = (fillPrice - entryPrice) * closeSize - closeFee;  // Already net
```

**RPC Optimization Summary:**
- Steps 1-5: No RPC calls (pure validation logic)
- Step 6: Drift withdrawal (~3-5 RPC calls, unavoidable)
- Step 7: Transfer uses batched `getMultipleAccountsInfo` + blockhash reuse (3-4 RPC calls)
- **Total: 6-9 RPC calls** (down from 9-11)

```typescript
async function distributeCreatorProfitShare(
  subscriberBot: TradingBot,
  subscriberWallet: Wallet,
  netRealizedPnl: number,  // MUST be net profit (after Drift fees)
  subAccountId: number,
): Promise<{ success: boolean; txSignature?: string; amount?: number; skipped?: string; iouCreated?: boolean }> {
  
  // 1-5: Pure validation (NO RPC CALLS)
  if (netRealizedPnl <= 0) {
    return { success: true, skipped: 'No profit to share' };
  }
  
  if (!subscriberBot.sourcePublishedBotId) {
    return { success: true, skipped: 'Not a subscription bot' };
  }
  
  // DB query (not RPC)
  const subscription = await storage.getBotSubscriptionBySubscriberBotId(subscriberBot.id);
  if (!subscription) {
    return { success: true, skipped: 'No active subscription found' };
  }
  
  const profitSharePercent = parseFloat(subscription.publishedBot.profitSharePercent || "0");
  if (profitSharePercent <= 0) {
    return { success: true, skipped: 'No profit share configured' };
  }
  
  const creatorShare = netRealizedPnl * (profitSharePercent / 100);
  if (creatorShare < 0.01) {
    return { success: true, skipped: `Dust amount: $${creatorShare.toFixed(4)}` };
  }
  
  const creatorMainWallet = subscription.publishedBot.creatorWalletAddress;
  if (!creatorMainWallet) {
    return { success: false, error: 'Creator wallet not found' };
  }
  
  // Validate creator wallet is a valid Solana address
  try {
    new PublicKey(creatorMainWallet);
  } catch {
    console.error(`[ProfitShare] Invalid creator wallet address: ${creatorMainWallet}`);
    return { success: false, error: 'Invalid creator wallet address' };
  }
  
  // 6. WITHDRAW from Drift to agent wallet (~3-5 RPC calls)
  // CRITICAL: Profit is in Drift subaccount, not agent SPL wallet
  console.log(`[ProfitShare] Withdrawing $${creatorShare.toFixed(4)} from Drift subaccount ${subAccountId}`);
  const withdrawResult = await withdrawFromDrift(
    subscriberWallet,
    subAccountId,
    creatorShare
  );
  if (!withdrawResult.success) {
    console.error(`[ProfitShare] Drift withdrawal failed: ${withdrawResult.error}`);
    return { success: false, error: `Drift withdrawal failed: ${withdrawResult.error}` };
  }
  
  // 7. Transfer to creator (4-5 RPC calls with optimizations)
  // - SOL balance check is batched inside transferUsdcToWallet
  // - Fresh blockhash fetched for reliability (stale blockhash = tx failure)
  console.log(`[ProfitShare] Transferring $${creatorShare.toFixed(4)} (${profitSharePercent}%) to ${creatorMainWallet}`);
  
  const transferResult = await transferUsdcToWallet(
    subscriberWallet.agentPublicKey!,
    subscriberWallet.agentPrivateKeyEncrypted!,
    creatorMainWallet,
    creatorShare
  );
  
  if (transferResult.success) {
    console.log(`[ProfitShare] SUCCESS: $${creatorShare.toFixed(4)} sent, tx: ${transferResult.signature}`);
    return { success: true, txSignature: transferResult.signature, amount: creatorShare };
  } else {
    console.error(`[ProfitShare] FAILED: ${transferResult.error}`);
    return { success: false, error: transferResult.error, iouCreated: true };
  }
}
```

---

## Integration Points

### Order of Operations After Close Trade

The profit share distribution should be inserted into the existing close trade flow:

```
1. Close position on Drift ✓
2. Record trade in database ✓
3. Sync position from on-chain ✓
4. Route close signal to subscribers ✓
5. Settle PnL (converts realized PnL to USDC in Drift account) ✓
6. ★ WITHDRAW PROFIT SHARE FROM DRIFT ★  ← NEW
7. ★ TRANSFER TO CREATOR'S WALLET ★      ← NEW
8. Auto-withdraw (if threshold exceeded) ✓
9. Send Telegram notifications ✓
```

**CRITICAL: Why Settle PnL comes BEFORE Profit Share:**
When a trade closes on Drift, the profit is in the **Drift subaccount collateral**, NOT the agent's SPL wallet. We must:
1. Settle PnL (makes the realized profit usable in Drift)
2. Withdraw the creator's share from Drift to the agent wallet
3. Transfer from agent wallet to creator's main wallet

If we try to transfer before withdrawing, the agent wallet has insufficient USDC.

**Why this order?**
- After routing: ensures subscribers' trades are initiated first
- After settlePnl: profit is now withdrawable from Drift
- Before auto-withdraw: ensures creator gets their share before excess is withdrawn

### Files to Modify

| File | Location | Change |
|------|----------|--------|
| `server/storage.ts` | Interface + implementation | Add `getBotSubscriptionBySubscriberBotId()` |
| `server/agent-wallet.ts` | New export | Add `transferUsdcToWallet()` (RPC-optimized) |
| `server/routes.ts` | After close in webhook (~line 4906) | Call `distributeCreatorProfitShare()` |
| `server/routes.ts` | After close in user webhook (~line 6162) | Call `distributeCreatorProfitShare()` |
| `server/routes.ts` | After manual close (~line 2450) | Call `distributeCreatorProfitShare()` |
| `server/routes.ts` | After retry close success | Call `distributeCreatorProfitShare()` |

### Integration Code Example

```typescript
// After close trade success, before settlePnl:

// PROFIT SHARE: Distribute creator's share of realized profit
if (closeTradePnl > 0 && bot.sourcePublishedBotId) {
  try {
    const profitShareResult = await distributeCreatorProfitShare(
      bot,
      wallet,
      closeTradePnl
    );
    if (profitShareResult.success && profitShareResult.amount) {
      console.log(`[Webhook] Profit share distributed: $${profitShareResult.amount.toFixed(4)}`);
    } else if (profitShareResult.skipped) {
      console.log(`[Webhook] Profit share skipped: ${profitShareResult.skipped}`);
    }
  } catch (profitShareErr: any) {
    console.error(`[Webhook] Profit share error (non-blocking): ${profitShareErr.message}`);
  }
}

// Then continue with existing settlePnl...
```

---

## Edge Cases & Handling

| Scenario | Handling |
|----------|----------|
| Subscriber has insufficient USDC in agent wallet | Create IOU, retry later (subscriber can't withdraw until paid) |
| Creator has no agent wallet | Skip profit share, log warning (creator must create agent wallet to receive) |
| Creator wallet not found in DB | Skip profit share, log error |
| Very small profit (<$0.01 share) | Skip to avoid dust transfers |
| Network failure during transfer | Create IOU, retry via background job + other triggers |
| RPC overload/rate limit | Create IOU, retry with backoff |
| Position flip (close + open) | Only apply to the close portion's realized PnL |
| Partial position close | Apply profit share on each partial close's realized PnL |
| Bot unsubscribed mid-trade | Use `sourcePublishedBotId` on bot, not subscription status |
| Creator changed profit share % | Use percentage at time of trade (from published bot) |
| Subscriber closes bot after big win | IOUs block deletion until paid |
| Subscriber tries to withdraw before paying | IOUs block withdrawal until paid |
| IOU persists > 24 hours | Log alert for manual review |

---

## Partial Close Handling

When a position is partially closed, the `closeTradePnl` variable in routes.ts already contains only the realized PnL for that partial close. This means:

1. Each partial close generates its own `closeTradePnl`
2. Profit share is calculated and distributed for each partial
3. No special handling needed - existing flow handles it correctly

**Example**:
- Position: 100 SOL long
- First close: 50 SOL, PnL = $25 → Creator share = $2.50 (10%)
- Second close: 50 SOL, PnL = $30 → Creator share = $3.00 (10%)
- Total creator earnings: $5.50

---

## Gas Cost Summary

| Action | Cost (SOL) | Cost (USD) |
|--------|------------|------------|
| Close trade on Drift | ~0.00001 | ~$0.0002 |
| USDC transfer (profit share) | ~0.000005 | ~$0.0001 |
| Create ATA (if needed, one-time) | ~0.00002 | ~$0.0004 |
| **Total per profitable close** | ~0.000015 | **~$0.0003** |

Conclusion: Gas cost is negligible. Immediate on-chain settlement is practical.

---

## Implementation Phases

### Phase 1: Core Transfer System (3-4 hours) ✅ COMPLETED
- [x] Add `getBotSubscriptionBySubscriberBotId()` to storage interface and implementation
- [x] Add `transferUsdcToWallet()` to agent-wallet.ts (RPC-optimized with batched lookups)
- [x] Add `distributeCreatorProfitShare()` function
- [x] Integrate into webhook close handler
- [x] Integrate into user webhook close handler
- [x] Integrate into manual close handler
- [x] Integrate into retry close handler (fully implemented with PnL calculation and IOU failover)
- [x] Add console logging for monitoring

### Phase 2: IOU Failover System (2-3 hours) ✅ COMPLETED
- [x] Create `pending_profit_shares` table in schema
- [x] Add storage functions: `createPendingProfitShare()`, `getPendingProfitSharesBySubscriber()`, `deletePendingProfitShare()`
- [x] Add `retryPendingProfitShares()` function
- [x] Modify `distributeCreatorProfitShare()` to create IOU on failure
- [x] Add IOU check + payment to withdrawal endpoint (block until paid)
- [x] Add IOU check + payment to bot deletion endpoint (block until paid)
- [x] Add background job to retry IOUs every 5 minutes (profit-share-retry-job.ts)

### Phase 3: Testing (2 hours)
- [ ] Test successful profit share distribution
- [ ] Test dust amount handling (< $0.01)
- [ ] Test no-profit scenario
- [ ] Test creator with no agent wallet
- [ ] Test partial close distribution
- [ ] Test IOU creation on RPC failure (mock)
- [ ] Test IOU blocking withdrawal
- [ ] Test IOU blocking bot deletion
- [ ] Test background job retry

### Phase 4: UI Transparency (Future)
- [ ] Show profit share history in creator dashboard
- [ ] Show profit share deductions in subscriber trade history
- [ ] Display estimated creator earnings on marketplace
- [ ] Show pending IOUs (if any) to subscriber

### Phase 5: Optional Enhancements (Future)
- [ ] Telegram notifications for creators receiving profit share
- [ ] Alert system for IOUs persisting > 24 hours
- [ ] Admin dashboard for IOU monitoring

---

## Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| Dust threshold | $0.01 minimum - skip amounts below this |
| Failure handling | IOU system - track failed transfers, retry via multiple triggers |
| Creator notification | Future enhancement - can add Telegram alert |
| Where do funds go? | Creator's agent wallet (they must have one to receive) |
| Partial closes | Each partial triggers its own profit share calculation |
| What if subscriber closes bot after big win? | IOUs block bot deletion until all pending shares paid |
| What if subscriber tries to withdraw first? | IOUs block withdrawal until all pending shares paid |
| Database bloat? | Only failed transfers stored; deleted after successful payment |

---

## Security Considerations

1. **Balance verification**: Always check subscriber has sufficient USDC before attempting transfer
2. **No user signing required**: All transfers are agent-to-agent, fully server-controlled
3. **Non-blocking errors**: Profit share failures don't block trade execution
4. **On-chain audit trail**: All transfers are on-chain, queryable via Solana explorer
5. **Immutable percentage**: Use profitSharePercent from published bot at trade time

---

## Monitoring & Observability

All profit share operations should log with `[ProfitShare]` prefix:

```
[ProfitShare] Distributing $2.50 (10% of $25.00) to creator 7xyz...abc
[ProfitShare] SUCCESS: $2.50 sent to creator, tx: 3abc...xyz
[ProfitShare] FAILED: Insufficient balance: 1.50 < 2.50
[ProfitShare] Skipped: Not a subscription bot
[ProfitShare] Skipped: Dust amount: $0.0045
```

---

## Summary

The profit share implementation reuses existing infrastructure:
- SPL token transfers (agent-wallet.ts)
- Subscription/published bot lookups (storage.ts)
- Close trade flow (routes.ts)
- Background job pattern (existing cron infrastructure)

### New Code Required

**Phase 1 - Core Transfer:**
- 1 storage function: `getBotSubscriptionBySubscriberBotId()` (~15 lines)
- 1 transfer function: `transferUsdcToWallet()` (~70 lines, RPC-optimized)
- 1 distribution function: `distributeCreatorProfitShare()` (~50 lines)
- 4 integration points (~10 lines each)

**Phase 2 - IOU Failover:**
- 1 database table: `pending_profit_shares` (~15 lines schema)
- 3 storage functions: create/get/delete IOUs (~30 lines)
- 1 retry function: `retryPendingProfitShares()` (~40 lines)
- 2 blocking checks: withdrawal + deletion endpoints (~20 lines each)
- 1 background job: 5-minute retry cron (~20 lines)

**Total new code**: ~300 lines
**Estimated time**: 6-8 hours including testing

### Key Design Decisions

1. **Immediate on-chain transfer** - Primary path, no database involvement
2. **IOU only on failure** - Database tracks failed transfers only, no bloat
3. **Multiple retry triggers** - Background job + withdrawal block + deletion block
4. **Creator protection** - Subscriber cannot escape without paying
5. **Delete after payment** - IOUs removed from DB once paid, no permanent storage

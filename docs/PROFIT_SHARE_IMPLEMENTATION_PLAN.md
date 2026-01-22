# Profit Share Implementation Plan

## Overview

This document outlines the implementation strategy for profit sharing between signal bot creators and their subscribers in the QuantumVault marketplace. The goal is to enable creators to earn 0-10% of subscriber profits in a gas-optimized, reliable manner.

**Last Updated**: 2026-01-22

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

## Recommended Implementation: Immediate On-Chain Transfer

### Why This Approach
1. Solana fees are negligible (~$0.0003 total per profitable close)
2. Immediate payment builds trust with creators
3. On-chain record provides transparency without database
4. Minimal additional complexity
5. Aligns with DeFi principles of trustless execution

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

### 2. Agent Wallet: `transferUsdcBetweenAgents()`

**Location**: `server/agent-wallet.ts`

**Purpose**: Transfer USDC directly from subscriber's agent wallet to creator's agent wallet

```typescript
export async function transferUsdcBetweenAgents(
  fromAgentPublicKey: string,
  fromEncryptedPrivateKey: string,
  toAgentPublicKey: string,
  amountUsdc: number,
): Promise<{ success: boolean; signature?: string; error?: string }> {
  try {
    const connection = getConnection();
    const fromKeypair = getAgentKeypair(fromEncryptedPrivateKey);
    const fromPubkey = new PublicKey(fromAgentPublicKey);
    const toPubkey = new PublicKey(toAgentPublicKey);
    const usdcMint = new PublicKey(USDC_MINT);
    
    const fromAta = getAssociatedTokenAddressSync(usdcMint, fromPubkey);
    const toAta = getAssociatedTokenAddressSync(usdcMint, toPubkey);
    
    const amountLamports = Math.round(amountUsdc * 1_000_000);
    if (amountLamports <= 0) {
      return { success: false, error: 'Invalid amount' };
    }
    
    // Check balance first
    const balance = await getAgentUsdcBalance(fromAgentPublicKey);
    if (balance < amountUsdc) {
      return { success: false, error: `Insufficient balance: ${balance} < ${amountUsdc}` };
    }
    
    const instructions: TransactionInstruction[] = [];
    
    // Create destination ATA if it doesn't exist
    const toAtaInfo = await connection.getAccountInfo(toAta);
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
    
    // Wait for confirmation (non-blocking timeout)
    await connection.confirmTransaction({
      signature,
      blockhash,
      lastValidBlockHeight,
    }, 'confirmed');
    
    return { success: true, signature };
  } catch (error: any) {
    console.error('[TransferBetweenAgents] Error:', error.message);
    return { success: false, error: error.message };
  }
}
```

### 3. Profit Share: `distributeCreatorProfitShare()`

**Location**: `server/routes.ts` (or new `server/profit-share.ts`)

**Purpose**: Main profit share distribution logic

```typescript
async function distributeCreatorProfitShare(
  subscriberBot: TradingBot,
  subscriberWallet: Wallet,
  realizedPnl: number,
): Promise<{ success: boolean; txSignature?: string; amount?: number; skipped?: string }> {
  
  // 1. Skip if PnL is not positive
  if (realizedPnl <= 0) {
    return { success: true, skipped: 'No profit to share' };
  }
  
  // 2. Check if this is a subscription bot
  if (!subscriberBot.sourcePublishedBotId) {
    return { success: true, skipped: 'Not a subscription bot' };
  }
  
  // 3. Get subscription and published bot details
  const subscription = await storage.getBotSubscriptionBySubscriberBotId(subscriberBot.id);
  if (!subscription) {
    return { success: true, skipped: 'No active subscription found' };
  }
  
  const profitSharePercent = parseFloat(subscription.publishedBot.profitSharePercent || "0");
  if (profitSharePercent <= 0) {
    return { success: true, skipped: 'No profit share configured' };
  }
  
  // 4. Calculate creator's share
  const creatorShare = realizedPnl * (profitSharePercent / 100);
  
  // 5. Skip dust amounts (less than 1 cent)
  if (creatorShare < 0.01) {
    return { success: true, skipped: `Dust amount: $${creatorShare.toFixed(4)}` };
  }
  
  // 6. Get creator's wallet (check if they have an agent wallet)
  const creatorWallet = await storage.getWallet(subscription.publishedBot.creatorWalletAddress);
  if (!creatorWallet) {
    console.warn(`[ProfitShare] Creator wallet not found: ${subscription.publishedBot.creatorWalletAddress}`);
    return { success: false, error: 'Creator wallet not found' };
  }
  
  // 7. Determine destination: creator's agent wallet if available, otherwise skip
  // NOTE: We can only transfer to agent wallets since we control them
  // If creator has no agent wallet, they must create one to receive profit shares
  if (!creatorWallet.agentPublicKey) {
    console.warn(`[ProfitShare] Creator has no agent wallet, skipping profit share`);
    return { success: true, skipped: 'Creator has no agent wallet' };
  }
  
  // 8. Execute the transfer
  console.log(`[ProfitShare] Distributing $${creatorShare.toFixed(4)} (${profitSharePercent}% of $${realizedPnl.toFixed(4)}) to creator ${creatorWallet.address}`);
  
  const transferResult = await transferUsdcBetweenAgents(
    subscriberWallet.agentPublicKey!,
    subscriberWallet.agentPrivateKeyEncrypted!,
    creatorWallet.agentPublicKey,
    creatorShare
  );
  
  if (transferResult.success) {
    console.log(`[ProfitShare] SUCCESS: $${creatorShare.toFixed(4)} sent to creator, tx: ${transferResult.signature}`);
    return { success: true, txSignature: transferResult.signature, amount: creatorShare };
  } else {
    console.error(`[ProfitShare] FAILED: ${transferResult.error}`);
    return { success: false, error: transferResult.error };
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
5. ★ PROFIT SHARE DISTRIBUTION ★  ← INSERT HERE
6. Settle PnL (for profit reinvest) ✓
7. Auto-withdraw (if threshold exceeded) ✓
8. Send Telegram notifications ✓
```

**Why this order?**
- After routing: ensures subscribers' trades are initiated first
- Before settlePnl: profit share uses margin balance, settlement converts PnL to USDC
- Before auto-withdraw: ensures creator gets their share before profits are withdrawn

### Files to Modify

| File | Location | Change |
|------|----------|--------|
| `server/storage.ts` | Interface + implementation | Add `getBotSubscriptionBySubscriberBotId()` |
| `server/agent-wallet.ts` | New export | Add `transferUsdcBetweenAgents()` |
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
| Subscriber has insufficient USDC in agent wallet | Skip profit share, log warning (their Drift position is separate) |
| Creator has no agent wallet | Skip profit share, log warning (creator must create agent wallet to receive) |
| Creator wallet not found in DB | Skip profit share, log error |
| Very small profit (<$0.01 share) | Skip to avoid dust transfers |
| Network failure during transfer | Log failure, don't retry (accept some loss for simplicity) |
| Position flip (close + open) | Only apply to the close portion's realized PnL |
| Partial position close | Apply profit share on each partial close's realized PnL |
| Bot unsubscribed mid-trade | Use `sourcePublishedBotId` on bot, not subscription status |
| Creator changed profit share % | Use percentage at time of trade (from published bot) |

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

### Phase 1: Core Implementation (3-4 hours)
- [ ] Add `getBotSubscriptionBySubscriberBotId()` to storage interface and implementation
- [ ] Add `transferUsdcBetweenAgents()` to agent-wallet.ts
- [ ] Add `distributeCreatorProfitShare()` function
- [ ] Integrate into webhook close handler
- [ ] Integrate into user webhook close handler
- [ ] Integrate into manual close handler
- [ ] Integrate into retry close handler
- [ ] Add console logging for monitoring

### Phase 2: Testing (1-2 hours)
- [ ] Test with subscription bot closing profitable position
- [ ] Test dust amount handling (< $0.01)
- [ ] Test no-profit scenario
- [ ] Test creator with no agent wallet
- [ ] Test partial close distribution

### Phase 3: UI Transparency (Future)
- [ ] Show profit share history in creator dashboard
- [ ] Show profit share deductions in subscriber trade history
- [ ] Display estimated creator earnings on marketplace

### Phase 4: Optional Enhancements (Future)
- [ ] Database tracking table for analytics
- [ ] Telegram notifications for creators receiving profit share
- [ ] Batch small amounts with threshold (if gas becomes concern)

---

## Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| Dust threshold | $0.01 minimum - skip amounts below this |
| Failure handling | Silent failure with logging (no retry) - accept some loss for simplicity |
| Creator notification | Future enhancement - can add Telegram alert |
| Where do funds go? | Creator's agent wallet (they must have one to receive) |
| Partial closes | Each partial triggers its own profit share calculation |

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

New code needed:
- 1 storage function (~15 lines)
- 1 transfer function (~60 lines)
- 1 distribution function (~50 lines)
- 4 integration points (~10 lines each)

**Total new code**: ~150 lines
**Estimated time**: 4-6 hours including testing

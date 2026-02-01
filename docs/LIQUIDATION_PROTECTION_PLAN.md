# Liquidation Protection Feature Plan

## Overview
A dynamic collateral management system that protects higher-timeframe (HTF) swing trading bots from liquidation during temporary adverse price moves. When price approaches liquidation, the system automatically deposits additional collateral to push the liquidation price further away. When price recovers to safety, it withdraws the extra collateral.

## Problem Statement
HTF swing trades (1H, 2H, 4H+ timeframes) can experience significant drawdowns before reaching their stop-loss or profit target. During volatile market conditions:
- Price may spike toward liquidation price temporarily
- Liquidation triggers a 100% loss of position collateral
- Many times, price reverses and the trade would have been profitable
- Current auto top-up only activates on new trade entry, not during position holding

## Proposed Solution

### Core Concept
"Elastic Collateral" - dynamically adjust collateral based on proximity to liquidation:
1. **Monitor Phase**: Continuously track distance from current price to liquidation price
2. **Protection Phase**: When distance drops below threshold, deposit extra collateral
3. **Recovery Phase**: When distance returns to safe levels, withdraw extra collateral
4. **Tracking**: Record all protection deposits/withdrawals in equity_events table

### User-Facing Settings (per bot)

```typescript
interface LiquidationProtectionSettings {
  enabled: boolean;              // Enable/disable protection
  triggerDistance: number;       // % distance from liquidation to trigger (e.g., 5% = trigger at $95 if liq price is $100)
  safeDistance: number;          // % distance to consider "safe" for withdrawal (e.g., 15%)
  maxProtectionDeposit: number;  // Maximum USD to deposit for protection (cap)
  depositIncrement: number;      // USD to deposit each time (e.g., $5, $10)
  cooldownSeconds: number;       // Minimum seconds between protection actions
}
```

### Default Values
- `triggerDistance`: 5% (trigger protection when 5% away from liquidation)
- `safeDistance`: 15% (consider safe when 15%+ away from liquidation)
- `maxProtectionDeposit`: 50% of bot's maxPositionSize
- `depositIncrement`: $5 (small increments to avoid over-depositing)
- `cooldownSeconds`: 60 (prevent rapid-fire deposits during volatility)

## Technical Implementation

### Phase 1: Database Schema

Add new columns to `trading_bots` table:
```sql
ALTER TABLE trading_bots ADD COLUMN liquidation_protection_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE trading_bots ADD COLUMN lp_trigger_distance NUMERIC(5,2) DEFAULT 5.00;
ALTER TABLE trading_bots ADD COLUMN lp_safe_distance NUMERIC(5,2) DEFAULT 15.00;
ALTER TABLE trading_bots ADD COLUMN lp_max_protection_deposit NUMERIC(12,6) DEFAULT 0;
ALTER TABLE trading_bots ADD COLUMN lp_deposit_increment NUMERIC(12,6) DEFAULT 5.00;
ALTER TABLE trading_bots ADD COLUMN lp_cooldown_seconds INTEGER DEFAULT 60;
ALTER TABLE trading_bots ADD COLUMN lp_current_protection_amount NUMERIC(12,6) DEFAULT 0;
ALTER TABLE trading_bots ADD COLUMN lp_last_action_at TIMESTAMP;
```

New equity event types:
- `protection_deposit` - Collateral added for liquidation protection
- `protection_withdrawal` - Extra collateral removed after price recovery

### Phase 2: Monitoring Service

Create `server/liquidation-protection-service.ts`:

```typescript
interface ProtectionState {
  botId: string;
  currentPrice: number;
  liquidationPrice: number;
  distancePercent: number;
  isInDanger: boolean;
  protectionDeposited: number;
  lastActionAt: Date | null;
}

// Core functions:
async function checkProtectionNeeded(botId: string): Promise<ProtectionAction>
async function executeProtectionDeposit(botId: string, amount: number): Promise<void>
async function executeProtectionWithdrawal(botId: string, amount: number): Promise<void>
async function startProtectionMonitor(): void  // Runs every 30s
```

### Phase 3: Monitoring Logic

```
Every 30 seconds for each bot with open position and protection enabled:
  1. Get current oracle price for market
  2. Get liquidation price from Drift SDK (already available via decodeUser)
  3. Calculate distance: distancePercent = abs(currentPrice - liquidationPrice) / liquidationPrice * 100
  
  IF distancePercent < triggerDistance AND protectionDeposited < maxProtectionDeposit:
    - Check cooldown (lastActionAt + cooldownSeconds < now)
    - Check agent wallet has funds
    - Deposit min(depositIncrement, maxProtectionDeposit - protectionDeposited)
    - Update lp_current_protection_amount
    - Create equity_event with type 'protection_deposit'
    - Log: "[LiquidationProtection] Bot {name}: deposited ${amount} (price {dist}% from liquidation)"
    
  ELSE IF distancePercent > safeDistance AND protectionDeposited > 0:
    - Check cooldown
    - Withdraw min(depositIncrement, protectionDeposited)
    - Update lp_current_protection_amount
    - Create equity_event with type 'protection_withdrawal'
    - Log: "[LiquidationProtection] Bot {name}: withdrew ${amount} (price now {dist}% from liquidation)"
```

### Phase 4: Integration Points

1. **Position Close**: When position closes (manually, stop loss, or signal), automatically withdraw all protection deposits
2. **Bot Pause/Delete**: Return all protection deposits to agent wallet
3. **Reconciliation**: Include protection amounts in position equity calculations
4. **UI Display**: Show protection status, current protection amount, distance to liquidation

### Phase 5: Frontend UI

Add to Bot Settings panel:
```
[ ] Enable Liquidation Protection

When enabled:
  Trigger when ___% from liquidation  [5]
  Safe zone at ___% from liquidation  [15]
  Max protection deposit $___         [50]
  Deposit increment $___              [5]
  Cooldown (seconds) ___              [60]

Current Protection Status:
  Distance to liquidation: 12.5%
  Protection deposited: $15.00
  Last action: 5 min ago
```

## Risk Considerations

### Guardrails
1. **Max Protection Cap**: Never deposit more than maxProtectionDeposit total
2. **Agent Wallet Check**: Only deposit if agent wallet has sufficient USDC
3. **Cooldown Period**: Prevent rapid deposits during flash crashes
4. **Position Verification**: Only act on bots with confirmed open positions
5. **Market Hours**: Consider if market is active/liquid

### Edge Cases
1. **Flash Crash**: Rapid price drop may trigger multiple deposits before recovery
   - Mitigation: Cooldown period + max cap
2. **No Recovery**: Price continues to liquidation despite deposits
   - Mitigation: This extends time for stop-loss to trigger, user accepts risk
3. **Funds Exhausted**: Agent wallet runs out during protection sequence
   - Mitigation: Log warning, pause protection monitoring for that bot
4. **RPC Failures**: Cannot fetch price/liquidation data
   - Mitigation: Skip cycle, retry next interval, don't make decisions on stale data

### User Warnings
Display when enabling:
- "Liquidation Protection can deposit up to ${maxProtectionDeposit} from your agent wallet during price drops"
- "This feature uses agent wallet funds - ensure adequate USDC balance"
- "Protection deposits are NOT guaranteed to prevent liquidation"

## Implementation Timeline

### Phase 1: Foundation (1-2 days)
- [ ] Add database columns via Drizzle schema
- [ ] Create settings UI in bot configuration
- [ ] Add validation for protection settings

### Phase 2: Monitoring Service (2-3 days)
- [ ] Create liquidation-protection-service.ts
- [ ] Implement price/liquidation distance calculation
- [ ] Implement deposit/withdrawal logic
- [ ] Add equity event types

### Phase 3: Integration (1-2 days)
- [ ] Integrate with position close flow
- [ ] Integrate with bot pause/delete flows
- [ ] Add protection status to bot dashboard

### Phase 4: Testing & Polish (1-2 days)
- [ ] Test with small positions
- [ ] Verify deposit/withdrawal flows
- [ ] Add Telegram notifications for protection events
- [ ] Documentation

## RPC Optimization Strategy

### Problem
Running a monitor every 30 seconds that fetches data for every bot with protection enabled could generate excessive RPC calls:
- Per bot: oracle price + account data + liquidation calculation = 2-3 RPC calls
- 10 bots with protection = 20-30 RPC calls every 30 seconds
- 60 calls/minute × 60 minutes = 3,600 calls/hour

### Rate Limiting Reality
**This is the primary concern** - not just cost, but service reliability:

| RPC Provider | Rate Limit | Risk |
|--------------|------------|------|
| Helius Free | 10 req/sec | High - easily exceeded |
| Helius Paid | 50-100 req/sec | Medium - spikes can hit |
| Public RPC | Variable | Very High - unreliable |

**When rate limited:**
- `-32429` errors cascade across all services
- Trade execution fails
- Position reconciliation stops
- Webhooks fail to process
- **Liquidation protection becomes unreliable exactly when needed most**

**Current RPC consumers competing for budget:**
1. DriftPrice service (every 10s)
2. Reconciliation service (every 60s)
3. Trade execution (on-demand)
4. Account info queries (on-demand)
5. Portfolio snapshots (every 12h)
6. **NEW: Liquidation protection monitoring**

**Critical Rule:** Protection monitoring must NOT compete with trade execution. If we're rate-limited during a liquidation crisis, we can't deposit protection funds.

### Optimization Strategies

#### 1. Leverage Existing Cached Data
**Already available without new RPC calls:**
- `DriftPrice` service caches all oracle prices (refreshes every 10s)
- Reconciliation service already fetches account data every 60s
- Portfolio snapshots already decode user accounts

**Implementation:**
```typescript
// Use cached price from DriftPrice service (0 RPC calls)
const cachedPrices = await getPricesFromCache();
const currentPrice = cachedPrices[market];

// Share account data with reconciliation service
// Instead of: individual getAccountInfo per bot
// Do: piggyback on reconciliation's batch fetch
```

#### 2. Batch Account Fetches
**Instead of:** N individual `getAccountInfo` calls
**Do:** Single `getMultipleAccountsInfo` for all protected bots

```typescript
// Collect all user account pubkeys for bots with protection enabled
const userAccountPubkeys = protectedBots.map(bot => 
  deriveUserAccountPubkey(bot.agentPublicKey, bot.driftSubaccountId)
);

// Single RPC call for all accounts
const accountInfos = await connection.getMultipleAccountsInfo(userAccountPubkeys);

// Decode all in memory (no RPC)
accountInfos.forEach((info, i) => {
  const decoded = decodeUser(info.data);
  // Calculate liquidation for each
});
```

**RPC Savings:** N calls → 1 call

#### 3. Rate Limit Backoff & Recovery
When rate limited, back off gracefully:

```typescript
class RateLimitAwareMonitor {
  private backoffMs = 0;
  private consecutiveErrors = 0;
  
  async checkWithBackoff() {
    if (this.backoffMs > 0) {
      await sleep(this.backoffMs);
    }
    
    try {
      await this.doCheck();
      // Success - reduce backoff
      this.backoffMs = Math.max(0, this.backoffMs - 1000);
      this.consecutiveErrors = 0;
    } catch (err) {
      if (isRateLimitError(err)) {
        this.consecutiveErrors++;
        // Exponential backoff: 2s, 4s, 8s, 16s, max 60s
        this.backoffMs = Math.min(60000, 2000 * Math.pow(2, this.consecutiveErrors));
        console.warn(`[LiquidationProtection] Rate limited, backing off ${this.backoffMs}ms`);
      }
    }
  }
}
```

**Priority Queue for RPC Calls:**
```typescript
// Trade execution gets priority over monitoring
const RPC_PRIORITY = {
  TRADE_EXECUTION: 1,      // Highest - never delay
  PROTECTION_DEPOSIT: 2,   // High - time sensitive
  RECONCILIATION: 3,       // Medium
  PROTECTION_CHECK: 4,     // Lower - can wait
  ANALYTICS: 5,            // Lowest
};

// If RPC budget is tight, skip lower priority calls
if (rpcBudgetRemaining < 10 && priority > RPC_PRIORITY.PROTECTION_DEPOSIT) {
  console.log(`[RPC] Skipping ${taskName} - budget tight, saving for critical ops`);
  return;
}
```

#### 4. Staggered Monitoring
Instead of checking all bots simultaneously every 30s, stagger checks:

```typescript
// Spread checks across the interval
const botsPerSecond = Math.ceil(protectedBots.length / 30);
let offset = 0;

setInterval(() => {
  const batch = protectedBots.slice(offset, offset + botsPerSecond);
  checkProtectionForBatch(batch);
  offset = (offset + botsPerSecond) % protectedBots.length;
}, 1000); // Check small batch every second
```

**Benefits:** 
- Smoother RPC load distribution
- Less likely to hit rate limits
- Faster response for first bots in queue

#### 4. Smart Polling Frequency
Adjust check frequency based on distance to liquidation:

| Distance from Liquidation | Check Frequency |
|---------------------------|-----------------|
| > 20%                     | Every 5 minutes |
| 10-20%                    | Every 60 seconds|
| 5-10%                     | Every 30 seconds|
| < 5%                      | Every 10 seconds|

```typescript
function getCheckInterval(distancePercent: number): number {
  if (distancePercent > 20) return 300_000;  // 5 min
  if (distancePercent > 10) return 60_000;   // 1 min  
  if (distancePercent > 5) return 30_000;    // 30 sec
  return 10_000;                              // 10 sec (danger zone)
}
```

#### 5. Position-Aware Filtering
Only monitor bots that actually need monitoring:

```typescript
// Skip bots with no position (FLAT)
const botsToMonitor = await storage.getBotsWithOpenPositions({
  liquidationProtectionEnabled: true
});

// Skip bots already at max protection
const needsMonitoring = botsToMonitor.filter(bot => 
  bot.lpCurrentProtectionAmount < bot.lpMaxProtectionDeposit ||
  bot.lpCurrentProtectionAmount > 0 // Need to check for withdrawal
);
```

#### 6. Shared Service Architecture
Integrate with existing reconciliation service instead of separate monitor:

```typescript
// In reconciliation-service.ts (already runs every 60s)
async function reconcilePosition(bot, accountData) {
  // Existing reconciliation logic...
  
  // Add liquidation protection check (uses same accountData, 0 extra RPC)
  if (bot.liquidationProtectionEnabled) {
    await checkLiquidationProtection(bot, accountData, cachedPrices);
  }
}
```

**Benefits:**
- Zero additional RPC calls for account data
- Reuses existing infrastructure
- Single point of account state management

### RPC Budget Estimate (Optimized)

| Component | Calls/Minute | Notes |
|-----------|--------------|-------|
| Oracle prices | 6 | Already cached by DriftPrice (shared) |
| Account batch fetch | 1 | Single getMultipleAccountsInfo |
| Protection deposits | 0-2 | Only when triggered |
| Protection withdrawals | 0-2 | Only when triggered |
| **Total new RPC** | **~3-5/min** | vs 60+/min unoptimized |

### Implementation Priority

1. **Phase 1**: Piggyback on reconciliation service (0 new scheduled RPC)
2. **Phase 2**: Use cached prices from DriftPrice (0 new price RPC)
3. **Phase 3**: Batch any remaining fetches with getMultipleAccountsInfo
4. **Phase 4**: Add smart polling for danger-zone bots only

### Monitoring & Alerts

Track RPC usage:
```typescript
// Log RPC stats periodically
console.log(`[LiquidationProtection] Stats: checked=${botsChecked}, deposits=${depositsTriggered}, withdrawals=${withdrawalsTriggered}, rpcCalls=${rpcCallsThisCycle}`);
```

Alert if RPC budget exceeded:
```typescript
if (rpcCallsThisMinute > RPC_BUDGET_PER_MINUTE) {
  console.warn(`[LiquidationProtection] RPC budget exceeded: ${rpcCallsThisMinute}/${RPC_BUDGET_PER_MINUTE}`);
  // Reduce check frequency temporarily
}
```

## API Endpoints

```
PATCH /api/bots/:botId/liquidation-protection
  Body: { enabled, triggerDistance, safeDistance, maxProtectionDeposit, ... }

GET /api/bots/:botId/protection-status
  Response: { distancePercent, protectionDeposited, isProtecting, lastAction }

GET /api/bots/:botId/protection-history
  Response: Array of protection deposit/withdrawal events
```

## Notification Integration

Add to Telegram notifications:
- `protection_deposit`: "⚠️ {botName}: Price approaching liquidation ({distance}%). Deposited ${amount} for protection."
- `protection_withdrawal`: "✅ {botName}: Price recovered to safety ({distance}%). Withdrew ${amount} protection deposit."
- `protection_exhausted`: "🚨 {botName}: Max protection reached (${total}). Consider manual intervention."

## Success Metrics

1. **Prevented Liquidations**: Count of times protection activated and position eventually closed profitably or at smaller loss
2. **Protection ROI**: Profit saved vs. protection deposits made
3. **User Adoption**: % of HTF bot users enabling protection

## Future Enhancements

1. **Smart Increment Sizing**: Larger deposits when closer to liquidation
2. **Volatility-Aware Triggers**: Adjust thresholds based on market volatility
3. **Cross-Bot Protection Pool**: Shared protection fund across multiple bots
4. **Auto-Stop-Loss Trigger**: If protection exhausted, auto-close position at reduced loss vs full liquidation

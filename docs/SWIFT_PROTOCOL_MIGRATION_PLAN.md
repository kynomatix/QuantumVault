# Swift Protocol Migration Plan

**Document Created:** January 21, 2026  
**Priority:** Medium (Roadmap V2)  
**Estimated Effort:** 2-3 weeks development + 1 week testing  
**Status:** Planning

---

## Executive Summary

Swift Protocol is Drift's next-generation execution layer that enables **gasless trading with better execution prices**. This document outlines the migration plan to integrate Swift into QuantumVault, replacing the current on-chain `placeAndTakePerpOrder` execution method.

### Key Benefits

| Benefit | Current System | With Swift |
|---------|---------------|------------|
| Gas Fees | ~$0.0001-0.001/trade | $0 |
| Execution Speed | 400-800ms (block time) | Sub-second |
| Slippage | Market order instant fill | Dutch auction (better prices) |
| MEV Protection | None | Built-in |
| SOL Balance Required | Yes (agent wallet) | No |

### Cost Savings Projection

Based on current trading volume:

| Trades | Gas Saved | Estimated Slippage Improvement |
|--------|-----------|-------------------------------|
| 1,000 | ~$1-10 | ~$150-500 (0.05% better fills) |
| 10,000 | ~$10-100 | ~$1,500-5,000 |
| 100,000 | ~$100-1,000 | ~$15,000-50,000 |

---

## Technical Overview

### Current Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│ TradingView     │────▶│ QuantumVault     │────▶│ Solana RPC  │
│ Webhook         │     │ Server           │     │ (on-chain)  │
└─────────────────┘     │                  │     └─────────────┘
                        │ drift-executor   │            │
                        │ placeAndTake     │            ▼
                        │ PerpOrder()      │     ┌─────────────┐
                        └──────────────────┘     │ Drift       │
                                                 │ Protocol    │
                                                 └─────────────┘
```

**Current Flow:**
1. Webhook received → Agent key decrypted
2. `DriftClient.placeAndTakePerpOrder()` called
3. Transaction signed by agent wallet
4. Transaction submitted to Solana RPC
5. Agent wallet pays gas fees
6. Wait for block confirmation (~400-800ms)

### Swift Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│ TradingView     │────▶│ QuantumVault     │────▶│ Swift API   │
│ Webhook         │     │ Server           │     │ (off-chain) │
└─────────────────┘     │                  │     └─────────────┘
                        │ swift-executor   │            │
                        │ signSwiftOrder() │            ▼
                        │ submitToSwift()  │     ┌─────────────┐
                        └──────────────────┘     │ Market      │
                                                 │ Makers      │
                                                 │ & Keepers   │
                                                 └─────────────┘
                                                        │
                                                        ▼
                                                 ┌─────────────┐
                                                 │ Drift       │
                                                 │ Protocol    │
                                                 │ (on-chain)  │
                                                 └─────────────┘
```

**Swift Flow:**
1. Webhook received → Agent key decrypted
2. Swift order message created and signed off-chain
3. Signed message submitted to Swift API (`https://swift.drift.trade`)
4. Market makers compete via Dutch auction
5. Keeper executes winning fill on-chain (pays gas)
6. Order filled with better price (~sub-second)

---

## Implementation Plan

### Phase 1: Research & SDK Integration (Week 1)

#### 1.1 SDK Version Check

Ensure we're using a Swift-compatible SDK version:

```bash
npm list @drift-labs/sdk
# Required: v2.146.0 or higher with Swift support
```

#### 1.2 Swift API Exploration

**Swift API Endpoint:** `https://swift.drift.trade`

**Key SDK Methods to Integrate:**
- `signSignedMsgOrderParamsMessage()` - Sign Swift order
- `generateSignedMsgUuid()` - Generate unique order ID
- HTTP POST to Swift API for order submission

#### 1.3 Create Swift Service Module

Create new file: `server/swift-executor.ts`

```typescript
// server/swift-executor.ts
import { DriftClient, OrderType, PositionDirection, MarketType } from '@drift-labs/sdk';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';

const SWIFT_API_URL = 'https://swift.drift.trade';

interface SwiftOrderParams {
  marketIndex: number;
  direction: 'long' | 'short';
  baseAssetAmount: BN;
  price?: BN;
  reduceOnly?: boolean;
  subAccountId: number;
}

interface SwiftOrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
  fillPrice?: number;
  fillAmount?: number;
}

export async function executeSwiftOrder(
  driftClient: DriftClient,
  keypair: Keypair,
  params: SwiftOrderParams
): Promise<SwiftOrderResult> {
  try {
    // 1. Get current slot for order timing
    const slot = await driftClient.connection.getSlot();
    
    // 2. Build Swift order message
    const orderMessage = {
      signedMsgOrderParams: {
        orderType: OrderType.MARKET,
        marketType: MarketType.PERP,
        marketIndex: params.marketIndex,
        direction: params.direction === 'long' 
          ? PositionDirection.LONG 
          : PositionDirection.SHORT,
        baseAssetAmount: params.baseAssetAmount,
        reduceOnly: params.reduceOnly ?? false,
      },
      subAccountId: params.subAccountId,
      slot: new BN(slot),
      uuid: generateSignedMsgUuid(),
      stopLossOrderParams: null,
      takeProfitOrderParams: null,
    };
    
    // 3. Sign the message off-chain
    const { orderParams, signature } = 
      driftClient.signSignedMsgOrderParamsMessage(orderMessage);
    
    // 4. Submit to Swift API
    const response = await fetch(SWIFT_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        orderParams,
        signature: Buffer.from(signature).toString('base64'),
        publicKey: keypair.publicKey.toString(),
      }),
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Swift API error: ${error}`);
    }
    
    const result = await response.json();
    
    return {
      success: true,
      orderId: result.orderId,
      fillPrice: result.fillPrice,
      fillAmount: result.fillAmount,
    };
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function generateSignedMsgUuid(): Uint8Array {
  // Generate 8-byte UUID for Swift order
  const uuid = new Uint8Array(8);
  crypto.getRandomValues(uuid);
  return uuid;
}
```

### Phase 2: Parallel Execution Path (Week 1-2)

#### 2.1 Add Swift Toggle

Add per-bot configuration for Swift execution:

```sql
-- Migration: Add swift_enabled to trading_bots
ALTER TABLE trading_bots 
ADD COLUMN swift_enabled BOOLEAN DEFAULT true NOT NULL;
```

Update schema:
```typescript
// shared/schema.ts
export const tradingBots = pgTable("trading_bots", {
  // ... existing fields
  swiftEnabled: boolean("swift_enabled").default(true).notNull(),
});
```

#### 2.2 Execution Router

Modify `drift-service.ts` to route between Swift and legacy:

```typescript
// server/drift-service.ts

export async function executeTrade(
  params: TradeParams,
  options: { useSwift?: boolean } = {}
): Promise<TradeResult> {
  const useSwift = options.useSwift ?? true;
  
  if (useSwift) {
    try {
      return await executeSwiftTrade(params);
    } catch (error) {
      // Fallback to legacy on Swift failure
      console.warn('[Trade] Swift failed, falling back to legacy:', error);
      return await executeLegacyTrade(params);
    }
  }
  
  return await executeLegacyTrade(params);
}
```

### Phase 3: Webhook Integration (Week 2)

#### 3.1 Update Webhook Handler

Modify `routes.ts` webhook to use Swift:

```typescript
// In /api/webhook/tradingview/:botId handler

// Check if bot has Swift enabled
const useSwift = bot.swiftEnabled ?? true;

// Execute trade with appropriate method
const tradeResult = await executeTrade({
  privateKeyBase58,
  market: bot.market,
  side: orderSide,
  sizeInBase: sizeInBase,
  subAccountId: bot.driftSubaccountId,
  reduceOnly: isCloseSignal,
}, {
  useSwift,
});
```

#### 3.2 Update Trade Logging

Capture Swift-specific metadata:

```typescript
// Update bot_trades table
await storage.createBotTrade({
  // ... existing fields
  executionMethod: useSwift ? 'swift' : 'legacy',
  swiftOrderId: tradeResult.swiftOrderId,
  auctionDuration: tradeResult.auctionDurationMs,
});
```

### Phase 4: Error Handling & Retry Logic (Week 2)

#### 4.1 Swift-Specific Error Handling

```typescript
// server/swift-executor.ts

const SWIFT_ERRORS = {
  NO_LIQUIDITY: 'No market makers available',
  AUCTION_TIMEOUT: 'Dutch auction timed out',
  STALE_SLOT: 'Slot too old for Swift execution',
  API_UNAVAILABLE: 'Swift API temporarily unavailable',
};

function isSwiftRetryable(error: string): boolean {
  // Retry on temporary failures
  return (
    error.includes('timeout') ||
    error.includes('temporarily unavailable') ||
    error.includes('429') ||
    error.includes('stale slot')
  );
}
```

#### 4.2 Automatic Fallback

```typescript
// In trade execution
async function executeWithFallback(params: TradeParams): Promise<TradeResult> {
  // Attempt 1: Swift
  const swiftResult = await executeSwiftOrder(params);
  
  if (swiftResult.success) {
    return swiftResult;
  }
  
  // Log Swift failure for monitoring
  console.warn(`[Swift] Failed: ${swiftResult.error}, falling back to legacy`);
  
  // Attempt 2: Legacy on-chain
  return await executeLegacyTrade(params);
}
```

### Phase 5: Monitoring & Analytics (Week 3)

#### 5.1 Execution Method Tracking

Add dashboard metrics:
- Swift vs Legacy execution ratio
- Average fill price improvement
- Swift failure rate and reasons
- Gas savings tracking

```typescript
// Track execution stats per bot
interface ExecutionStats {
  totalTrades: number;
  swiftTrades: number;
  legacyTrades: number;
  swiftFailures: number;
  avgSwiftSavings: number; // vs legacy fill price
  totalGasSaved: number;
}
```

#### 5.2 Health Monitoring

Monitor Swift API availability:

```typescript
// Periodic Swift health check
async function checkSwiftHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${SWIFT_API_URL}/health`, {
      timeout: 5000,
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Disable Swift globally if API is down
let swiftGloballyEnabled = true;

setInterval(async () => {
  swiftGloballyEnabled = await checkSwiftHealth();
  if (!swiftGloballyEnabled) {
    console.warn('[Swift] API health check failed, using legacy execution');
  }
}, 30000); // Check every 30 seconds
```

---

## Migration Strategy

### Rollout Plan

| Phase | Description | Timeline |
|-------|-------------|----------|
| 1 | Internal testing (dev environment) | Week 1 |
| 2 | Beta users opt-in (10% of bots) | Week 2 |
| 3 | Default on for new bots | Week 3 |
| 4 | Migrate existing bots (with user notification) | Week 4 |
| 5 | Remove legacy path (optional) | Month 2+ |

### Backward Compatibility

- Maintain legacy `placeAndTakePerpOrder` path indefinitely
- Swift as default, legacy as fallback
- Per-bot toggle to disable Swift if issues arise
- No changes to existing webhook format or URLs

### Rollback Plan

If Swift causes issues:

1. **Immediate:** Set `swiftGloballyEnabled = false` in config
2. **Per-user:** Set `swift_enabled = false` on affected bots
3. **Full rollback:** Deploy previous version without Swift code

---

## API Reference

### Swift API Endpoint

**URL:** `https://swift.drift.trade`

**Authentication:** Signed message from user's wallet

### Request Format

```typescript
POST /order

{
  "orderParams": {
    "orderType": "market",
    "marketType": "perp",
    "marketIndex": 0,
    "direction": "long",
    "baseAssetAmount": "1000000000",
    "reduceOnly": false
  },
  "subAccountId": 0,
  "slot": 123456789,
  "uuid": "base64-encoded-8-bytes",
  "signature": "base64-encoded-ed25519-signature",
  "publicKey": "base58-wallet-address"
}
```

### Response Format

```typescript
{
  "success": true,
  "orderId": "swift-order-uuid",
  "status": "filled",
  "fillPrice": 195.50,
  "fillAmount": 1.0,
  "auctionDurationMs": 150,
  "makerPubkey": "maker-wallet-address"
}
```

### Error Responses

| Status | Error | Retryable |
|--------|-------|-----------|
| 400 | Invalid order parameters | No |
| 401 | Invalid signature | No |
| 429 | Rate limited | Yes |
| 503 | No liquidity available | Yes |
| 504 | Auction timeout | Yes |

---

## SDK Methods Reference

### DriftClient Swift Methods

```typescript
// Sign Swift order message
signSignedMsgOrderParamsMessage(
  orderMessage: SignedMsgOrderParams
): { orderParams: Buffer; signature: Buffer }

// Generate unique order ID
generateSignedMsgUuid(): Uint8Array

// Get Swift order instructions (for keepers)
getPlaceAndMakePerpOrderWithSwiftIxs(
  encodedSwiftMessage: Buffer,
  swiftSignature: Buffer,
  encodedSwiftOrderParamsMessage: Buffer,
  swiftOrderParamsSignature: Buffer,
  takerExpectedOrderId: number,
  takerInfo: TakerInfo,
  orderParams: OptionalOrderParams,
  referrerInfo?: ReferrerInfo,
  subAccountId?: number
): Promise<TransactionInstruction[]>
```

---

## Database Changes

### New Columns

```sql
-- trading_bots table
ALTER TABLE trading_bots 
ADD COLUMN swift_enabled BOOLEAN DEFAULT true NOT NULL;

-- bot_trades table
ALTER TABLE bot_trades
ADD COLUMN execution_method VARCHAR(20) DEFAULT 'legacy',
ADD COLUMN swift_order_id VARCHAR(64),
ADD COLUMN auction_duration_ms INTEGER;
```

### Drizzle Schema

```typescript
// shared/schema.ts additions

// In tradingBots
swiftEnabled: boolean("swift_enabled").default(true).notNull(),

// In botTrades
executionMethod: text("execution_method").default("legacy"),
swiftOrderId: text("swift_order_id"),
auctionDurationMs: integer("auction_duration_ms"),
```

---

## Testing Plan

### Unit Tests

1. Swift message signing
2. UUID generation
3. Error parsing
4. Fallback logic

### Integration Tests

1. Swift API connectivity
2. Order submission and fill confirmation
3. Fallback to legacy on failure
4. Rate limiting handling

### Load Tests

1. Concurrent Swift orders
2. High-frequency webhook processing
3. Failover behavior under load

### Production Validation

1. Compare fill prices: Swift vs Legacy
2. Monitor fill times
3. Track failure rates
4. Verify gas savings

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Swift API downtime | Medium | High | Automatic fallback to legacy |
| Worse fills than legacy | Low | Medium | A/B testing before full rollout |
| Market maker liquidity gaps | Medium | Medium | Monitor and alert on auction failures |
| SDK breaking changes | Low | High | Pin SDK version, test upgrades |
| Increased latency | Low | Low | Sub-second target with legacy fallback |

---

## Success Metrics

### Primary KPIs

- **Gas savings:** $X saved per 10,000 trades
- **Fill price improvement:** X% better than legacy average
- **Execution success rate:** >99% without fallback
- **Latency:** <500ms average fill time

### Secondary KPIs

- Swift adoption rate across bots
- Fallback trigger frequency
- User satisfaction (fewer SOL top-ups needed)

---

## Resources

### Official Documentation

- [Drift Swift Protocol Announcement](https://www.drift.trade/updates/introducing-swift-protocol-a-new-trading-standard-for-solana)
- [Drift SDK Documentation](https://drift-labs.github.io/protocol-v2/sdk/)
- [Drift Protocol v2 Teacher](https://drift-labs.github.io/v2-teacher/#swift)

### SDK References

- [NPM: @drift-labs/sdk](https://www.npmjs.com/package/@drift-labs/sdk)
- [GitHub: drift-labs/protocol-v2](https://github.com/drift-labs/protocol-v2)
- [DriftClient API](https://drift-labs.github.io/protocol-v2/sdk/classes/DriftClient.html)

### Support Channels

- [Drift Discord](https://discord.gg/drift)
- [Drift GitHub Issues](https://github.com/drift-labs/protocol-v2/issues)

---

## Appendix A: Current vs Swift Code Comparison

### Current Implementation (drift-executor.mjs)

```javascript
// Lines 1188-1206
txSig = await driftClient.placeAndTakePerpOrder(
  {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: side === 'buy' ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: sizeInBaseUnits,
    reduceOnly: reduceOnly || false,
  },
  undefined, // makerInfo
  referrerInfo,
);
```

### Swift Implementation (proposed)

```javascript
// Swift order signing (off-chain)
const orderMessage = {
  signedMsgOrderParams: {
    orderType: OrderType.MARKET,
    marketType: MarketType.PERP,
    marketIndex,
    direction: side === 'buy' ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: sizeInBaseUnits,
    reduceOnly: reduceOnly || false,
  },
  subAccountId,
  slot: new BN(await connection.getSlot()),
  uuid: generateSignedMsgUuid(),
};

const { orderParams, signature } = driftClient.signSignedMsgOrderParamsMessage(orderMessage);

// Submit to Swift API (off-chain)
const result = await fetch('https://swift.drift.trade', {
  method: 'POST',
  body: JSON.stringify({ orderParams, signature, publicKey }),
});
```

---

## Appendix B: Feature Flag Configuration

```typescript
// server/config.ts

export const SWIFT_CONFIG = {
  // Global toggle
  enabled: process.env.SWIFT_ENABLED !== 'false',
  
  // API configuration
  apiUrl: process.env.SWIFT_API_URL || 'https://swift.drift.trade',
  
  // Timeouts
  orderTimeoutMs: 5000,
  healthCheckIntervalMs: 30000,
  
  // Retry configuration
  maxRetries: 2,
  retryDelayMs: 500,
  
  // Fallback behavior
  fallbackOnError: true,
  logFallbacks: true,
};
```

---

**Document Maintained By:** Engineering Team  
**Last Updated:** January 21, 2026  
**Next Review:** Before implementation kickoff

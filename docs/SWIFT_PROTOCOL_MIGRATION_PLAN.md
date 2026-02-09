# Swift Protocol Migration Plan

**Document Created:** January 21, 2026  
**Last Updated:** February 9, 2026  
**Priority:** Medium (Roadmap V2)  
**Estimated Effort:** 3-4 weeks development + 2 weeks testing  
**Status:** Planning (Audited - V3 Updated)  
**Version:** 3.0  
**V3 Changelog:** Codebase audit against production system, Swift API research, SDK method verification, market support validation

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current System Architecture (Detailed)](#current-system-architecture-detailed)
3. [Swift Protocol Overview](#swift-protocol-overview)
4. [Gap Analysis](#gap-analysis)
5. [Implementation Plan](#implementation-plan)
6. [Database Schema Changes](#database-schema-changes)
7. [Execution Path Integration](#execution-path-integration)
8. [Profit Sharing Integration](#profit-sharing-integration)
9. [Retry Service Integration](#retry-service-integration)
10. [Security V3 Integration](#security-v3-integration)
11. [Swift-Specific Limitations](#swift-specific-limitations)
12. [Observability & Monitoring](#observability--monitoring)
13. [Testing Plan](#testing-plan)
14. [Migration Strategy](#migration-strategy)
15. [Risks & Mitigations](#risks--mitigations)
16. [Rollback Plan](#rollback-plan)
17. [Success Metrics](#success-metrics)
18. [Appendices](#appendices)
19. [V3 Audit Findings & Corrections](#v3-audit-findings--corrections)

---

## Executive Summary

Swift Protocol is Drift's next-generation execution layer that enables **gasless trading with better execution prices** through off-chain order signing and market maker competition via Dutch auctions.

This document outlines the comprehensive migration plan to integrate Swift into QuantumVault, operating **in parallel** with the current on-chain `placeAndTakePerpOrder` execution method, with automatic fallback capabilities.

### Key Benefits

| Benefit | Current System | With Swift |
|---------|---------------|------------|
| Gas Fees | ~$0.0001-0.001/trade | $0 (keeper pays) |
| Execution Speed | 400-800ms (block time) | Sub-second |
| Slippage | Market order instant fill | Dutch auction (better prices) |
| MEV Protection | None | Built-in |
| SOL Balance Required | Yes (agent wallet) | No (for trading, still needed for withdrawals) |

### RPC Impact Analysis (V3 Updated)

Swift's primary advantage for QuantumVault is **massive RPC usage reduction**, especially for subscriber routing:

| Scenario | Current RPC Calls | With Swift | Reduction |
|----------|------------------|------------|-----------|
| Single trade | ~2 heavy (simulate + send) | 1 light (getSlot) | ~90% |
| 10 subscribers | ~20 heavy calls | 1 getSlot + 10 HTTP POSTs to swift.drift.trade | ~95% |
| 15 subscribers | ~30 heavy calls | 1 getSlot + 15 HTTP POSTs to swift.drift.trade | ~97% |

**Key insight:** Swift POST requests go to `swift.drift.trade`, NOT to Helius/Triton RPC. They do not count against the 50 req/sec Helius Dev tier limit. Only position checks and getSlot still use RPC.

### Cost Savings Projection

| Trades | Gas Saved | Estimated Slippage Improvement |
|--------|-----------|-------------------------------|
| 1,000 | ~$1-10 | ~$150-500 (0.05% better fills) |
| 10,000 | ~$10-100 | ~$1,500-5,000 |
| 100,000 | ~$100-1,000 | ~$15,000-50,000 |

### Scope

This migration affects:
- 4 trade execution paths (webhook, manual, subscriber routing, retry worker)
- Profit sharing flow (depends on position close detection)
- Trade retry service (new error types, order ID tracking)
- Database schema (new tracking fields)
- Monitoring infrastructure (new metrics)

---

## Current System Architecture (Detailed)

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           QUANTUMVAULT SERVER                                │
│                                                                              │
│  ┌──────────────────┐     ┌────────────────────┐     ┌──────────────────┐  │
│  │  Webhook Handler │     │  drift-service.ts  │     │ drift-executor   │  │
│  │  (routes.ts)     │────▶│  (orchestration)   │────▶│ (subprocess)     │  │
│  └──────────────────┘     └────────────────────┘     └──────────────────┘  │
│           │                         │                         │             │
│           │                         │                         ▼             │
│  ┌────────▼─────────┐     ┌────────▼────────┐      ┌──────────────────┐   │
│  │ Subscriber       │     │ Trade Retry     │      │ Solana RPC       │   │
│  │ Routing          │     │ Service         │      │ (Helius/Triton)  │   │
│  └──────────────────┘     └─────────────────┘      └──────────────────┘   │
│           │                         │                         │             │
│           │                         │                         ▼             │
│  ┌────────▼─────────┐     ┌────────▼────────┐      ┌──────────────────┐   │
│  │ Profit Share     │     │ PostgreSQL      │      │ Drift Protocol   │   │
│  │ Service          │     │ (trade logs)    │      │ (on-chain)       │   │
│  └──────────────────┘     └─────────────────┘      └──────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Four Execution Paths

The system has **4 distinct trade execution paths** that all must support Swift:

#### Path 1: TradingView Webhook (`/api/webhook/tradingview/:botId`)

```
TradingView Alert
       │
       ▼
POST /api/webhook/tradingview/:botId?secret=xxx
       │
       ▼
┌─────────────────────────────────────┐
│ 1. Validate webhook secret          │
│ 2. Deduplicate via signalHash       │
│ 3. Decrypt agent private key (UMK)  │
│ 4. Compute trade sizing             │
│ 5. Call executePerpOrder()          │
│    └─▶ Spawns drift-executor.mjs    │
│        └─▶ placeAndTakePerpOrder()  │
│ 6. Log trade to bot_trades          │
│ 7. Route to subscribers (if pub'd)  │
└─────────────────────────────────────┘
```

**File:** `server/routes.ts` (lines ~4872-6096)

#### Path 2: Manual Trade (`/api/trading-bots/:id/manual-trade`)

```
User clicks "Trade" in UI
       │
       ▼
POST /api/trading-bots/:id/manual-trade
       │
       ▼
┌─────────────────────────────────────┐
│ 1. Verify wallet ownership          │
│ 2. Decrypt agent private key        │
│ 3. Use bot's configured settings    │
│ 4. Call executePerpOrder()          │
│ 5. Log trade to bot_trades          │
└─────────────────────────────────────┘
```

**File:** `server/routes.ts` (lines ~3210-3400)

#### Path 3: Subscriber Routing (`routeSignalToSubscribers()`) — V3 UPDATED

**V3 CORRECTION:** Subscriber routing is now **decoupled** from source bot execution status. The plan originally described routing as happening only after a successful source bot trade. The current system has **4 routing trigger points**:

```
Signal Received at Webhook
       │
       ├─▶ Source bot PAUSED? ─────▶ parseSignalForRouting() ─▶ routeSignalToSubscribers() ─▶ return 400
       │
       ├─▶ Auth DISABLED? ─────────▶ parseSignalForRouting() ─▶ routeSignalToSubscribers() ─▶ return 403
       │
       ├─▶ Auth EXPIRED? ─────────▶ parseSignalForRouting() ─▶ routeSignalToSubscribers() ─▶ return 403
       │
       ├─▶ Source bot executes OK ─▶ routeSignalToSubscribers() ─▶ continue
       │
       └─▶ Retry worker succeeds ──▶ routeSignalToSubscribers() (via registerRoutingCallback)
```

**Key design feature:** `parseSignalForRouting()` extracts signal data (action, contracts, price, isCloseSignal) **without decrypting the agent key**, enabling routing at early-exit points before key decryption.

The routing function itself:
```
┌─────────────────────────────────────┐
│ 1. Find all active subscribers      │
│ 2. For each subscriber bot:         │
│    a. Get subscriber wallet         │
│    b. Compute proportional sizing   │
│       via computeTradeSizingAndTopUp│
│    c. Decrypt subscriber agent key  │  ◀── Uses LEGACY path (not UMK)
│    d. Call executePerpOrder()       │
│    e. Log trade                     │
│    f. If close + profit → share     │
│ 3. Execute in parallel              │
└─────────────────────────────────────┘
```

**File:** `server/routes.ts` (lines ~650-1100)

**CRITICAL NOTE:** Subscriber routing uses the **legacy encrypted key path** because subscriber wallet owners don't have active sessions. Their UMK is not available. This is documented in `PHASE 6.2 SECURITY NOTE`.

**Swift integration must support all 4 routing trigger points.** The Swift executor wrapper should work identically regardless of which trigger point initiated routing.

#### Path 4: Trade Retry Worker (`trade-retry-service.ts`)

```
Failed Trade (rate limit, transient error)
       │
       ▼
┌─────────────────────────────────────┐
│ queueTradeRetry({                   │
│   botId, market, side, size,        │
│   priority: 'critical' | 'normal', │
│   agentPrivateKeyEncrypted,         │
│   entryPrice (for close orders),    │
│ })                                  │
└─────────────────────────────────────┘
       │
       ▼ (after backoff)
┌─────────────────────────────────────┐
│ 1. Check retry count < max          │
│ 2. Re-execute trade                 │
│    - Close: closePerpPosition()     │
│    - Open: executePerpOrder()       │
│ 3. On success: remove from queue    │
│ 4. On failure: increment, requeue   │
│ 5. Max attempts: pause bot          │
└─────────────────────────────────────┘
```

**File:** `server/trade-retry-service.ts`

**Configuration:**
- Normal priority: 5 max attempts, 5s base backoff
- Critical priority (closes): 10 max attempts, 2.5s base backoff
- Max backoff: 60 seconds
- Queue persisted to `trade_retry_queue` table

**V3 UPDATE - Cooldown Retry System:** The retry service now includes a cooldown re-queue mechanism not covered in the original plan:
- After exhausting normal retries (5 or 10 attempts), timeout errors trigger a **cooldown re-queue**
- `cooldownRetries` field tracks delayed re-queue count (max 2)
- `COOLDOWN_DELAY_MS` = 2 minutes between cooldown re-queues
- Swift retry strategy must integrate with this: Swift failures should count toward cooldown eligibility

**V3 UPDATE - Routing on Retry Success:** The retry worker routes signals to subscribers on successful retry via `registerRoutingCallback`. Swift retries that succeed must also trigger this routing callback.

### RPC Failover Architecture

```
┌─────────────────────────────────────┐
│           FAILOVER STATE            │
│                                     │
│  activeRpc: 'primary' | 'backup'    │
│  switchedToBackupAt: timestamp      │
│  consecutivePrimaryFailures: int    │
│  cooldownMs: 180000 (3 minutes)     │
└─────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────┐
│ getWorkingConnection()              │
│                                     │
│ 1. If on backup, check cooldown     │
│ 2. Try active RPC (getSlot 5s)      │
│ 3. On fail, switch to backup        │
│ 4. Return working connection        │
└─────────────────────────────────────┘
```

**Primary RPC:** Helius (`HELIUS_API_KEY`)  
**Backup RPC:** Triton (`TRITON_ONE_RPC`)

**IMPORTANT:** Swift execution still requires RPC for:
- Fetching current slot (order timing)
- Reading position state (for close verification)
- PnL settlement after trades
- Account health checks

### Security V3 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    SECURITY V3 KEY HIERARCHY                     │
│                                                                  │
│  User Wallet ──signature──▶ Derive UMK (User Master Key)        │
│                                     │                            │
│                    ┌────────────────┼────────────────┐          │
│                    ▼                ▼                ▼          │
│              key_privkey      key_mnemonic    key_execution     │
│                    │                │                │          │
│                    ▼                ▼                ▼          │
│         Agent Private Key   Seed Phrase    Trade Execution      │
│         (encrypted)         (encrypted)    Authorization        │
│                                                                  │
│  Per-Bot Storage:                                                │
│  - executionActive: boolean                                      │
│  - umkEncryptedForBot: encrypted UMK                            │
│  - policyHmac: HMAC of (market, leverage, maxPositionSize)      │
└─────────────────────────────────────────────────────────────────┘
```

**Swift Integration Requirements:**
- Must access agent keypair for Swift message signing
- Must verify policyHmac before executing trades
- Must respect emergencyStopTriggered flag

### Profit Sharing Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    PROFIT SHARE FLOW                             │
│                                                                  │
│  Subscriber Position Closed                                      │
│           │                                                      │
│           ▼                                                      │
│  Calculate Realized PnL                                          │
│           │                                                      │
│           ▼ (if PnL > 0)                                        │
│  profitShareAmount = realizedPnl × (profitSharePercent / 100)   │
│           │                                                      │
│           ▼                                                      │
│  ┌────────────────────────────────────────┐                     │
│  │ 1. Withdraw USDC from Drift subaccount │                     │
│  │ 2. Transfer USDC to creator wallet     │                     │
│  │    └─▶ On failure: Create IOU record   │                     │
│  └────────────────────────────────────────┘                     │
│           │                                                      │
│           ▼                                                      │
│  IOU Retry Job (every 5 minutes)                                │
│  - Max 50 retries or 7 days                                      │
│  - Void after TTL (release hostage)                             │
└─────────────────────────────────────────────────────────────────┘
```

**Database:** `pending_profit_shares` table

**Swift Integration Concern:** Profit sharing depends on:
1. Detecting position close
2. Knowing the fill price
3. Calculating realized PnL

With Swift, fill confirmation is async. Must ensure PnL calculation happens after on-chain settlement.

---

## Swift Protocol Overview

### What is Swift?

Swift is Drift's off-chain order matching system that:
1. Accepts signed order messages
2. Runs Dutch auctions among market makers
3. Has keepers execute winning fills on-chain
4. Provides better prices and zero gas for traders

### Swift API

**Endpoint:** `https://swift.drift.trade`

**Flow:**
```
Client                    Swift API                Market Makers        Solana
  │                           │                         │                 │
  │ 1. Sign order message     │                         │                 │
  │──────────────────────────▶│                         │                 │
  │                           │ 2. Broadcast to MMs     │                 │
  │                           │────────────────────────▶│                 │
  │                           │                         │ 3. Submit bids  │
  │                           │◀────────────────────────│                 │
  │                           │ 4. Dutch auction        │                 │
  │                           │ 5. Select winner        │                 │
  │                           │                         │ 6. Execute fill │
  │                           │                         │────────────────▶│
  │ 7. Return fill result     │                         │                 │
  │◀──────────────────────────│                         │                 │
```

### Swift vs Legacy Comparison

| Aspect | Legacy (placeAndTakePerpOrder) | Swift |
|--------|-------------------------------|-------|
| Transaction | Client signs & submits tx | Client signs message only |
| Gas Payment | Client (agent wallet) | Keeper (market maker) |
| Execution | Immediate on-chain | Async via Dutch auction |
| Fill Price | AMM price | Auction-determined (usually better) |
| Latency | 400-800ms (block time) | Sub-second |
| Failure Mode | RPC/blockchain errors | API errors + no liquidity |
| Reduce-Only | Native flag | Native flag (confirmed supported) |

### Market Support (V3 Updated - February 2026)

**Swift supports ALL perpetual futures markets on Drift.** This was confirmed via official Drift documentation and the March 2025 launch announcement. The original plan's assumption that only SOL/BTC/ETH were supported is incorrect.

All 85+ markets in QuantumVault's `PERP_MARKET_INDICES` are Swift-eligible, including:
- Major pairs: SOL, BTC, ETH
- Currently traded: RENDER, FARTCOIN, PENGU, TNSR, AVAX, IP, XPL
- All other listed perpetual futures

**No market allowlist is needed.** The `supportedMarkets` config proposed in the original plan should be removed or replaced with a dynamic check.

Spot market Swift support was announced as "coming soon" in March 2025 but has not been confirmed as live.

### SDK Integration (V3 Updated)

The Drift SDK (`@drift-labs/sdk`) has built-in Swift methods on `DriftClient`:

| Method | Purpose |
|--------|---------|
| `encodeSwiftOrderParamsMessage()` | Encode order params for signing |
| `decodeSwiftOrderParamsMessage()` | Decode Swift order messages |
| `encodeSwiftServerMessage()` | Encode server-side Swift messages |
| `decodeSwiftServerMessage()` | Decode server responses |
| `placeAndMakeSwiftPerpOrder()` | Full Swift perp order (maker side) |

**Swift Order Flow (from official v2-teacher docs):**

```typescript
// 1. Build order message with current slot and UUID
const swiftMessage = SignedMsgOrderParamsMessage({
  signed_msg_order_params: orderParams,
  sub_account_id: subAccountId,
  slot: currentSlot,           // 1 RPC call: getSlot
  uuid: generateSignedMsgUUID(),
  stop_loss_order_params: null,
  take_profit_order_params: null
});

// 2. Sign with agent keypair (same key used for legacy transactions)
const signed = driftClient.signSignedMsgOrderParamsMessage(swiftMessage);

// 3. POST to Swift API (NOT RPC - does not count against Helius rate limit)
const response = await axios.post('https://swift.drift.trade/orders', {
  market_index: marketIndex,
  market_type: 'perp',
  message: signed.message,       // base64-encoded
  signature: signed.signature,   // base64-encoded
  taker_authority: agentPublicKey
});
```

**Builder Codes:** Swift orders exclusively support Drift Builder Codes for revenue sharing. Registering as a builder would earn a fee on every Swift trade the platform executes - potential additional revenue stream.

**Drift v3 Context:** Drift v3 launched December 2025 with 85% of orders filling within 400ms. Swift is being made the default trading method platform-wide.

---

## Gap Analysis

### Summary of Gaps in Original Plan

| Gap Area | Original Coverage | Required |
|----------|-------------------|----------|
| Architecture documentation | Simplified diagram | Full 4-path detail |
| Execution paths | Webhook only | All 4 paths |
| Subscriber routing | Not mentioned | Critical for marketplace |
| Retry service | Not mentioned | Order ID tracking, error types |
| Profit sharing | Not mentioned | Fill detection, PnL timing |
| Security V3 | Not mentioned | UMK access, policy HMAC |
| Database schema | Basic (3 columns) | Comprehensive (8+ columns, audit table) |
| Swift limitations | Not covered | Reduce-only, partial fills, expiry |
| Observability | Basic health check | Full metrics suite |
| RPC usage | Not addressed | Still needed for reads |

### Detailed Gap Breakdown

#### Gap 1: Execution Path Coverage

**Problem:** Original plan only covered webhook execution.

**Solution:** Document and implement Swift for all 4 paths:
- Webhook handler
- Manual trade endpoint
- Subscriber routing function
- Trade retry worker

#### Gap 2: Subscriber Routing Complexity

**Problem:** Subscriber routing executes trades for N bots from one signal.

**Challenges:**
- Parallel Swift submissions (N API calls)
- Different Swift order IDs per subscriber
- Fallback handling if one fails
- Uses legacy encrypted key (not UMK)

**Solution:** See [Execution Path Integration](#execution-path-integration) section.

#### Gap 3: Retry Service Integration

**Problem:** Retry service doesn't track Swift-specific data.

**Required:**
- Swift order ID tracking across retries
- Different error classification (Swift API vs RPC)
- Retry strategy: retry Swift → fallback → legacy retry
- Critical priority handling for Swift close failures

**Solution:** See [Retry Service Integration](#retry-service-integration) section.

#### Gap 4: Profit Sharing Flow

**Problem:** Profit sharing depends on synchronous close detection.

**Challenges:**
- Swift fills are async
- Need to wait for on-chain settlement
- Partial fills complicate PnL calculation

**Solution:** See [Profit Sharing Integration](#profit-sharing-integration) section.

#### Gap 5: Database Schema Gaps

**Problem:** Original schema changes insufficient.

**Required additions:**
- Swift order tracking (UUID, status, timestamps)
- Audit trail for debugging
- Retry queue enhancements

**Solution:** See [Database Schema Changes](#database-schema-changes) section.

#### Gap 6: Swift-Specific Limitations

**Problem:** Swift has different semantics than legacy.

**Not addressed:**
- Reduce-only behavior differences
- Order expiry (slot window)
- Partial fills
- Position flip handling
- Dust position cleanup
- Market liquidity variations

**Solution:** See [Swift-Specific Limitations](#swift-specific-limitations) section.

#### Gap 7: Observability Gaps

**Problem:** Basic health check insufficient.

**Required:**
- API latency percentiles (p50, p95, p99)
- Order acceptance vs fill rate
- Auction duration distribution
- Fallback trigger frequency by error type
- Price improvement tracking
- Per-market liquidity monitoring
- Alerting on degradation

**Solution:** See [Observability & Monitoring](#observability--monitoring) section.

---

## Implementation Plan

### Phase 0: Documentation & Preparation (Days 1-3)

- [x] Comprehensive architecture documentation (this document)
- [ ] Swift API research and testing
- [ ] SDK method verification
- [ ] Define error taxonomy
- [ ] Set up development environment with Swift testnet (if available)

### Phase 1: Infrastructure Setup (Week 1)

#### 1.1 Database Migrations

```sql
-- See Database Schema Changes section for full SQL
```

#### 1.2 Swift Configuration Module

Create `server/swift-config.ts`:

```typescript
export const SWIFT_CONFIG = {
  enabled: process.env.SWIFT_ENABLED !== 'false',
  apiUrl: process.env.SWIFT_API_URL || 'https://swift.drift.trade',
  orderTimeoutMs: parseInt(process.env.SWIFT_ORDER_TIMEOUT_MS || '5000'),
  healthCheckIntervalMs: 30000,
  maxRetriesBeforeFallback: 2,
  retryDelayMs: 500,
  fallbackOnError: true,
  
  // V3 UPDATE: Swift supports ALL perp markets on Drift (confirmed Feb 2026).
  // No market allowlist needed. All 85+ markets in PERP_MARKET_INDICES are eligible.
  // Removed hardcoded supportedMarkets - all perps use Swift by default.
  
  // Error classification
  retryableErrors: [
    'timeout',
    'temporarily unavailable',
    '429',
    '503',
    '504',
    'stale slot',
  ],
  
  // Metrics
  metricsEnabled: true,
};
```

#### 1.3 Swift Health Monitor

Create `server/swift-health.ts`:

```typescript
interface SwiftHealthState {
  isHealthy: boolean;
  lastCheckAt: Date;
  lastHealthyAt: Date | null;
  consecutiveFailures: number;
  latencyMs: number | null;
}

let swiftHealth: SwiftHealthState = {
  isHealthy: true,
  lastCheckAt: new Date(),
  lastHealthyAt: null,
  consecutiveFailures: 0,
  latencyMs: null,
};

export function isSwiftAvailable(): boolean {
  return SWIFT_CONFIG.enabled && swiftHealth.isHealthy;
}

export async function checkSwiftHealth(): Promise<boolean> {
  const start = Date.now();
  try {
    const response = await fetch(`${SWIFT_CONFIG.apiUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    
    const latency = Date.now() - start;
    
    if (response.ok) {
      swiftHealth = {
        isHealthy: true,
        lastCheckAt: new Date(),
        lastHealthyAt: new Date(),
        consecutiveFailures: 0,
        latencyMs: latency,
      };
      return true;
    }
  } catch (error) {
    swiftHealth.consecutiveFailures++;
    swiftHealth.lastCheckAt = new Date();
    
    // Disable after 3 consecutive failures
    if (swiftHealth.consecutiveFailures >= 3) {
      swiftHealth.isHealthy = false;
      console.warn('[Swift] Marked unhealthy after 3 failures');
    }
  }
  
  return false;
}

// Start health check interval
setInterval(checkSwiftHealth, SWIFT_CONFIG.healthCheckIntervalMs);
```

### Phase 2: Swift Executor Module (Week 1)

#### 2.1 Create Swift Executor

Create `server/swift-executor.ts` (or add to `drift-executor.mjs`):

```typescript
import { DriftClient, OrderType, PositionDirection, MarketType } from '@drift-labs/sdk';
import { Keypair } from '@solana/web3.js';
import BN from 'bn.js';
import crypto from 'crypto';

const SWIFT_API_URL = process.env.SWIFT_API_URL || 'https://swift.drift.trade';

export interface SwiftOrderParams {
  marketIndex: number;
  direction: 'long' | 'short';
  baseAssetAmount: BN;
  price?: BN;
  reduceOnly?: boolean;
  subAccountId: number;
}

export interface SwiftOrderResult {
  success: boolean;
  executionMethod: 'swift' | 'legacy';
  swiftOrderId?: string;
  txSignature?: string;
  fillPrice?: number;
  fillAmount?: number;
  auctionDurationMs?: number;
  keeperPubkey?: string;
  priceImprovement?: number;
  error?: string;
  errorCode?: string;
  isRetryable?: boolean;
}

export function generateSwiftUuid(): Uint8Array {
  const uuid = new Uint8Array(8);
  crypto.getRandomValues(uuid);
  return uuid;
}

export async function executeSwiftOrder(
  driftClient: DriftClient,
  params: SwiftOrderParams
): Promise<SwiftOrderResult> {
  const startTime = Date.now();
  const uuid = generateSwiftUuid();
  const uuidHex = Buffer.from(uuid).toString('hex');
  
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
      uuid,
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
        orderParams: Buffer.from(orderParams).toString('base64'),
        signature: Buffer.from(signature).toString('base64'),
        publicKey: driftClient.wallet.publicKey.toString(),
      }),
      signal: AbortSignal.timeout(SWIFT_CONFIG.orderTimeoutMs),
    });
    
    const auctionDurationMs = Date.now() - startTime;
    
    if (!response.ok) {
      const errorText = await response.text();
      const isRetryable = isSwiftRetryableError(response.status, errorText);
      
      return {
        success: false,
        executionMethod: 'swift',
        swiftOrderId: uuidHex,
        error: `Swift API error (${response.status}): ${errorText}`,
        errorCode: String(response.status),
        isRetryable,
        auctionDurationMs,
      };
    }
    
    const result = await response.json();
    
    return {
      success: true,
      executionMethod: 'swift',
      swiftOrderId: uuidHex,
      txSignature: result.txSignature,
      fillPrice: result.fillPrice,
      fillAmount: result.fillAmount,
      auctionDurationMs,
      keeperPubkey: result.makerPubkey,
      priceImprovement: result.priceImprovement,
    };
    
  } catch (error) {
    const errorStr = error instanceof Error ? error.message : String(error);
    const isRetryable = isSwiftRetryableError(0, errorStr);
    
    return {
      success: false,
      executionMethod: 'swift',
      swiftOrderId: uuidHex,
      error: errorStr,
      isRetryable,
    };
  }
}

function isSwiftRetryableError(status: number, error: string): boolean {
  if (status === 429 || status === 503 || status === 504) return true;
  
  const lowerError = error.toLowerCase();
  return (
    lowerError.includes('timeout') ||
    lowerError.includes('temporarily unavailable') ||
    lowerError.includes('stale slot') ||
    lowerError.includes('no liquidity') ||
    lowerError.includes('auction timeout')
  );
}
```

#### 2.2 Execution Router with Fallback

Add to `server/drift-service.ts`:

```typescript
import { executeSwiftOrder, SwiftOrderResult } from './swift-executor';
import { isSwiftAvailable } from './swift-health';

export interface TradeExecutionOptions {
  useSwift?: boolean;
  fallbackToLegacy?: boolean;
  priority?: 'normal' | 'critical';
}

export async function executeTradeWithSwift(
  params: TradeParams,
  options: TradeExecutionOptions = {}
): Promise<TradeResult> {
  const useSwift = options.useSwift ?? isSwiftAvailable();
  const fallbackToLegacy = options.fallbackToLegacy ?? true;
  
  // Check if market supports Swift
  const marketSupportsSwift = SWIFT_CONFIG.supportedMarkets.includes(params.market);
  
  if (useSwift && marketSupportsSwift) {
    const swiftResult = await executeSwiftOrder(driftClient, {
      marketIndex: params.marketIndex,
      direction: params.side,
      baseAssetAmount: params.baseAssetAmount,
      reduceOnly: params.reduceOnly,
      subAccountId: params.subAccountId,
    });
    
    if (swiftResult.success) {
      return {
        ...swiftResult,
        executionMethod: 'swift',
      };
    }
    
    // Log Swift failure
    console.warn(`[Trade] Swift failed: ${swiftResult.error}`);
    recordSwiftFailure(params.market, swiftResult.error);
    
    if (!fallbackToLegacy) {
      return swiftResult;
    }
    
    // Fallback to legacy
    console.log('[Trade] Falling back to legacy execution');
  }
  
  // Legacy execution
  const legacyResult = await executeLegacyTrade(params);
  return {
    ...legacyResult,
    executionMethod: 'legacy',
    swiftAttempted: useSwift && marketSupportsSwift,
    swiftError: useSwift ? 'Fallback triggered' : undefined,
  };
}
```

### Phase 3: Integration with Execution Paths (Week 2)

See [Execution Path Integration](#execution-path-integration) section for detailed implementation.

### Phase 4: Profit Sharing & Retry Integration (Week 2-3)

See:
- [Profit Sharing Integration](#profit-sharing-integration)
- [Retry Service Integration](#retry-service-integration)

### Phase 5: Observability & Testing (Week 3-4)

See:
- [Observability & Monitoring](#observability--monitoring)
- [Testing Plan](#testing-plan)

### Phase 6: Staged Rollout (Week 4+)

See [Migration Strategy](#migration-strategy) section.

---

## Database Schema Changes

### trading_bots Table Additions

```sql
ALTER TABLE trading_bots 
ADD COLUMN swift_enabled BOOLEAN DEFAULT true NOT NULL,
ADD COLUMN swift_fallback_enabled BOOLEAN DEFAULT true NOT NULL;
```

### bot_trades Table Additions

```sql
ALTER TABLE bot_trades
ADD COLUMN execution_method VARCHAR(20) DEFAULT 'legacy' NOT NULL,
ADD COLUMN swift_order_id VARCHAR(64),
ADD COLUMN swift_status VARCHAR(20),  -- 'submitted', 'filled', 'failed', 'fallback'
ADD COLUMN swift_submitted_at TIMESTAMP,
ADD COLUMN swift_filled_at TIMESTAMP,
ADD COLUMN auction_duration_ms INTEGER,
ADD COLUMN keeper_pubkey TEXT,
ADD COLUMN price_improvement DECIMAL(10, 4),  -- percentage vs oracle
ADD COLUMN fallback_reason TEXT;
```

### trade_retry_queue Table Additions

```sql
ALTER TABLE trade_retry_queue
ADD COLUMN swift_order_id VARCHAR(64),
ADD COLUMN original_execution_method VARCHAR(20) DEFAULT 'legacy',
ADD COLUMN swift_attempts INTEGER DEFAULT 0,
ADD COLUMN last_swift_error TEXT;
```

### New Table: swift_order_logs

```sql
CREATE TABLE swift_order_logs (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id VARCHAR(255) REFERENCES bot_trades(id) ON DELETE CASCADE,
  swift_order_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(30) NOT NULL,  -- 'submitted', 'accepted', 'filled', 'failed', 'expired'
  timestamp TIMESTAMP DEFAULT NOW() NOT NULL,
  request_payload JSONB,
  response_payload JSONB,
  error_code VARCHAR(20),
  error_message TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_swift_order_logs_trade_id ON swift_order_logs(trade_id);
CREATE INDEX idx_swift_order_logs_swift_order_id ON swift_order_logs(swift_order_id);
CREATE INDEX idx_swift_order_logs_event_type ON swift_order_logs(event_type);
```

### Drizzle Schema Updates

```typescript
// shared/schema.ts

// Add to tradingBots
swiftEnabled: boolean("swift_enabled").default(true).notNull(),
swiftFallbackEnabled: boolean("swift_fallback_enabled").default(true).notNull(),

// Add to botTrades
executionMethod: text("execution_method").default("legacy").notNull(),
swiftOrderId: text("swift_order_id"),
swiftStatus: text("swift_status"),
swiftSubmittedAt: timestamp("swift_submitted_at"),
swiftFilledAt: timestamp("swift_filled_at"),
auctionDurationMs: integer("auction_duration_ms"),
keeperPubkey: text("keeper_pubkey"),
priceImprovement: decimal("price_improvement", { precision: 10, scale: 4 }),
fallbackReason: text("fallback_reason"),

// Add to tradeRetryQueue
swiftOrderId: text("swift_order_id"),
originalExecutionMethod: text("original_execution_method").default("legacy"),
swiftAttempts: integer("swift_attempts").default(0),
lastSwiftError: text("last_swift_error"),

// New table
export const swiftOrderLogs = pgTable("swift_order_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradeId: varchar("trade_id").references(() => botTrades.id, { onDelete: "cascade" }),
  swiftOrderId: text("swift_order_id").notNull(),
  eventType: text("event_type").notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  requestPayload: jsonb("request_payload"),
  responsePayload: jsonb("response_payload"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

---

## Execution Path Integration

### Path 1: Webhook Handler

**File:** `server/routes.ts`

**Changes Required:**

```typescript
// In /api/webhook/tradingview/:botId handler

// 1. Check Swift configuration
const useSwift = bot.swiftEnabled ?? true;
const fallbackEnabled = bot.swiftFallbackEnabled ?? true;

// 2. Execute with Swift support
const tradeResult = await executeTradeWithSwift({
  privateKeyBase58,
  market: bot.market,
  side: orderSide,
  sizeInBase,
  subAccountId: bot.driftSubaccountId,
  reduceOnly: isCloseSignal,
}, {
  useSwift,
  fallbackToLegacy: fallbackEnabled,
  priority: isCloseSignal ? 'critical' : 'normal',
});

// 3. Log with Swift metadata
const trade = await storage.createBotTrade({
  tradingBotId: bot.id,
  walletAddress: bot.walletAddress,
  market: bot.market,
  side: orderSide,
  size: sizeInBase.toString(),
  price: tradeResult.fillPrice?.toString() || '0',
  status: tradeResult.success ? 'completed' : 'failed',
  txSignature: tradeResult.txSignature,
  errorMessage: tradeResult.error,
  // Swift fields
  executionMethod: tradeResult.executionMethod,
  swiftOrderId: tradeResult.swiftOrderId,
  swiftStatus: tradeResult.success ? 'filled' : 'failed',
  auctionDurationMs: tradeResult.auctionDurationMs,
  keeperPubkey: tradeResult.keeperPubkey,
  priceImprovement: tradeResult.priceImprovement?.toString(),
  fallbackReason: tradeResult.swiftError,
});
```

### Path 2: Manual Trade

**File:** `server/routes.ts`

**Changes Required:**

Same pattern as webhook, but respecting user's real-time decision:

```typescript
// In /api/trading-bots/:id/manual-trade handler

// Allow override via request body
const useSwift = req.body.useSwift ?? bot.swiftEnabled ?? true;

const tradeResult = await executeTradeWithSwift(params, {
  useSwift,
  fallbackToLegacy: true,
  priority: 'normal',
});
```

### Path 3: Subscriber Routing

**File:** `server/routes.ts` - `routeSignalToSubscribers()`

**Challenges:**
1. N subscribers = N Swift submissions
2. Different wallets, different subaccounts
3. Uses legacy encrypted key (not UMK)
4. Partial failures (some Swift, some legacy)

**Changes Required:**

```typescript
async function routeSignalToSubscribers(
  publishedBot: PublishedBot,
  signal: Signal,
  options: { useSwift?: boolean } = {}
): Promise<RoutingResult[]> {
  const subscribers = await storage.getActiveSubscriptions(publishedBot.id);
  
  // Determine Swift usage per subscriber bot
  const results: RoutingResult[] = [];
  
  // Process in batches to avoid overwhelming Swift API
  const BATCH_SIZE = 5;
  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);
    
    const batchResults = await Promise.allSettled(
      batch.map(async (sub) => {
        const subBot = await storage.getTradingBotById(sub.subscriberBotId);
        if (!subBot || !subBot.isActive) return null;
        
        // Subscriber bot's Swift preference
        const useSwift = options.useSwift ?? subBot.swiftEnabled ?? true;
        
        // Execute trade for subscriber
        // NOTE: Uses legacy key path (agentPrivateKeyEncrypted)
        const result = await executeTradeWithSwift({
          encryptedPrivateKey: subBot.agentPrivateKeyEncrypted,
          market: subBot.market,
          side: signal.action === 'buy' ? 'long' : 'short',
          sizeInBase: calculateSubscriberSize(sub, signal),
          subAccountId: subBot.driftSubaccountId,
          reduceOnly: signal.isClose,
        }, {
          useSwift,
          fallbackToLegacy: true,
          priority: signal.isClose ? 'critical' : 'normal',
        });
        
        return {
          subscriberBotId: subBot.id,
          ...result,
        };
      })
    );
    
    results.push(...batchResults.filter(r => r.status === 'fulfilled').map(r => r.value));
    
    // Small delay between batches
    if (i + BATCH_SIZE < subscribers.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  
  return results;
}
```

### Path 4: Trade Retry Worker

**File:** `server/trade-retry-service.ts`

See [Retry Service Integration](#retry-service-integration) section.

---

## Profit Sharing Integration

### Current Profit Share Flow

```
Position Close Detected
       │
       ├─▶ Calculate realizedPnl from fill
       │
       ├─▶ If pnl > 0 && isSubscriberBot:
       │      profitShare = pnl × profitSharePercent
       │
       ├─▶ Withdraw profitShare from Drift subaccount
       │
       ├─▶ Transfer USDC to creator wallet
       │      └─▶ On failure: Create IOU
       │
       └─▶ Log profit share event
```

### Swift Integration Challenges

1. **Async Fill Confirmation:** Swift fills may not be immediately confirmed
2. **Fill Price Source:** Need to use Swift-reported fill price, not oracle
3. **Partial Fills:** May receive partial fill → need to handle proportional profit share
4. **Settlement Timing:** On-chain PnL settlement happens after keeper execution

### Updated Flow with Swift

```typescript
async function handleSubscriberClose(
  subscriberBot: TradingBot,
  closeResult: TradeResult
): Promise<void> {
  if (!closeResult.success) return;
  
  const publishedBot = await storage.getPublishedBotByTradingBotId(
    subscriberBot.sourcePublishedBotId
  );
  if (!publishedBot || parseFloat(publishedBot.profitSharePercent) <= 0) return;
  
  // Use the fill price from execution result
  // For Swift: this is the auction fill price
  // For Legacy: this is calculated from position or oracle
  const fillPrice = closeResult.fillPrice;
  if (!fillPrice) {
    console.warn('[ProfitShare] No fill price available, skipping');
    return;
  }
  
  // Get entry price from position tracking
  const entryPrice = await getPositionEntryPrice(subscriberBot);
  if (!entryPrice) return;
  
  // Calculate realized PnL
  const realizedPnl = calculateRealizedPnl({
    entryPrice,
    exitPrice: fillPrice,
    size: closeResult.fillAmount || closeResult.size,
    direction: subscriberBot.side,
  });
  
  if (realizedPnl <= 0) return;
  
  // Calculate profit share
  const profitSharePercent = parseFloat(publishedBot.profitSharePercent);
  const profitShareAmount = realizedPnl * (profitSharePercent / 100);
  
  // Execute profit share transfer
  await executeProfitShareTransfer({
    subscriberBot,
    creatorWallet: publishedBot.creatorWalletAddress,
    amount: profitShareAmount,
    realizedPnl,
    profitSharePercent,
    tradeId: closeResult.tradeId,
    publishedBotId: publishedBot.id,
  });
}
```

### Handling Swift Partial Fills

If Swift returns a partial fill:

```typescript
if (swiftResult.fillAmount && swiftResult.fillAmount < requestedAmount) {
  console.log(`[Swift] Partial fill: ${swiftResult.fillAmount}/${requestedAmount}`);
  
  // For profit share, use actual fill amount
  const partialPnl = calculateRealizedPnl({
    entryPrice,
    exitPrice: swiftResult.fillPrice,
    size: swiftResult.fillAmount,  // Use partial amount
    direction,
  });
  
  // May need to queue remainder for retry
  const remainder = requestedAmount - swiftResult.fillAmount;
  if (remainder > minimumOrderSize) {
    await queueTradeRetry({
      ...originalParams,
      size: remainder,
      isRemainder: true,
    });
  }
}
```

---

## Retry Service Integration

### Current Retry Service

- Handles rate limits and transient errors
- `priority: 'critical'` for close orders (10 attempts, 2.5s base backoff)
- `priority: 'normal'` for open orders (5 attempts, 5s base backoff)
- Persists to `trade_retry_queue` table

### Swift-Specific Requirements

1. **Track Swift Order ID:** Allow correlation across retries
2. **Different Error Classification:** Swift API errors vs RPC errors
3. **Retry Strategy Options:**
   - Retry Swift first, then fallback to legacy
   - Immediate fallback on certain errors
   - Always use legacy on retry
4. **Entry Price for Close Retries:** Required for profit share calculation

### Updated Retry Job Interface

```typescript
export interface RetryJob {
  id: string;
  botId: string;
  walletAddress: string;
  agentPrivateKeyEncrypted: string;
  agentPublicKey: string;
  market: string;
  side: 'long' | 'short' | 'close';
  size: number;
  subAccountId: number;
  reduceOnly: boolean;
  slippageBps: number;
  privateKeyBase58?: string;
  priority: 'critical' | 'normal';
  attempts: number;
  maxAttempts: number;
  nextRetryAt: number;
  createdAt: number;
  lastError?: string;
  originalTradeId?: string;
  webhookPayload?: unknown;
  entryPrice?: number;
  
  // Swift-specific
  swiftOrderId?: string;
  originalExecutionMethod: 'swift' | 'legacy';
  swiftAttempts: number;
  lastSwiftError?: string;
  useSwiftOnRetry: boolean;
}
```

### Updated Retry Execution

```typescript
async function executeRetry(job: RetryJob): Promise<RetryResult> {
  // Decide whether to try Swift on retry
  let useSwift = job.useSwiftOnRetry;
  
  // Don't use Swift on retry if:
  // 1. Original Swift failure was non-retryable
  // 2. Already exceeded Swift retry limit (2 attempts)
  // 3. Swift globally unavailable
  if (job.swiftAttempts >= 2) {
    useSwift = false;
    console.log(`[Retry] Job ${job.id}: Switching to legacy after ${job.swiftAttempts} Swift failures`);
  }
  
  if (!isSwiftAvailable()) {
    useSwift = false;
  }
  
  // Execute with appropriate method
  const result = await executeTradeWithSwift({
    encryptedPrivateKey: job.agentPrivateKeyEncrypted,
    market: job.market,
    side: job.side,
    sizeInBase: job.size,
    subAccountId: job.subAccountId,
    reduceOnly: job.reduceOnly,
  }, {
    useSwift,
    fallbackToLegacy: true,
    priority: job.priority,
  });
  
  // Update job with Swift attempt info
  if (result.executionMethod === 'swift') {
    job.swiftAttempts++;
    job.swiftOrderId = result.swiftOrderId;
    if (!result.success) {
      job.lastSwiftError = result.error;
    }
  }
  
  return result;
}
```

### Swift Error Classification

```typescript
const SWIFT_ERROR_CLASSIFICATION = {
  // Retryable with Swift
  RETRYABLE_SWIFT: [
    'timeout',
    'temporarily unavailable',
    '429',
    '503',
    '504',
    'stale slot',
  ],
  
  // Retryable with legacy only
  FALLBACK_TO_LEGACY: [
    'no liquidity',
    'auction timeout',
    'market not supported',
  ],
  
  // Non-retryable
  PERMANENT: [
    'invalid signature',
    'invalid order parameters',
    '400',
    '401',
  ],
};

function classifySwiftError(error: string): 'retry_swift' | 'fallback_legacy' | 'permanent' {
  const lowerError = error.toLowerCase();
  
  if (SWIFT_ERROR_CLASSIFICATION.PERMANENT.some(e => lowerError.includes(e))) {
    return 'permanent';
  }
  
  if (SWIFT_ERROR_CLASSIFICATION.FALLBACK_TO_LEGACY.some(e => lowerError.includes(e))) {
    return 'fallback_legacy';
  }
  
  return 'retry_swift';
}
```

---

## Security V3 Integration

### UMK Access for Swift Signing

Swift order signing requires the agent keypair. Current security architecture:

```
UMK (User Master Key)
    │
    ├─▶ Derive key_privkey
    │       │
    │       └─▶ Decrypt agentPrivateKeyEncryptedV3
    │               │
    │               └─▶ Agent Keypair (for signing)
```

**No changes required** - Swift uses the same keypair for signing messages as legacy uses for transaction signing.

### Policy HMAC Verification

Before executing any trade (Swift or legacy), verify bot policy hasn't been tampered:

```typescript
async function verifyBotPolicy(bot: TradingBot): Promise<boolean> {
  if (!bot.policyHmac) {
    console.warn(`[Security] Bot ${bot.id} has no policy HMAC`);
    return true; // Allow for migration period
  }
  
  const expectedHmac = computePolicyHmac({
    market: bot.market,
    leverage: bot.leverage,
    maxPositionSize: bot.maxPositionSize,
  });
  
  if (bot.policyHmac !== expectedHmac) {
    console.error(`[Security] Bot ${bot.id} policy HMAC mismatch - possible tampering`);
    return false;
  }
  
  return true;
}
```

### Emergency Stop Handling

Check emergency stop before Swift submission:

```typescript
async function canExecuteTrade(walletAddress: string): Promise<boolean> {
  const wallet = await storage.getWallet(walletAddress);
  
  if (wallet?.emergencyStopTriggered) {
    console.log(`[Security] Emergency stop active for ${walletAddress}`);
    return false;
  }
  
  return true;
}
```

### Subscriber Routing Security Note

**IMPORTANT:** Subscriber routing uses the **legacy encrypted key path** (`agentPrivateKeyEncrypted`), not UMK-based encryption.

This is documented in `PHASE 6.2 SECURITY NOTE`:

> Subscriber Routing uses LEGACY encrypted key path. This is INTENTIONAL because subscriber wallet owners belong to DIFFERENT users who do not have active sessions during webhook processing.

Swift integration maintains this behavior - subscriber trades use the legacy key for signing.

---

## Swift-Specific Limitations

### Reduce-Only Semantics (V3 Updated)

**Legacy behavior:** `reduceOnly: true` ensures order only reduces position.

**V3 CONFIRMED:** Swift natively supports the `reduceOnly` flag with identical semantics to legacy orders. The `immediateOrCancel` (IOC) flag is also supported. No special handling needed for reduce-only Swift orders.

**Position verification before close:** Even though `reduceOnly` is supported, the system should still verify position existence via `PositionService.getPositionForExecution()` before submitting close orders, consistent with current behavior:

```typescript
async function executeSwiftClose(params: CloseParams): Promise<SwiftOrderResult> {
  // First verify position exists
  const position = await PositionService.getPositionForExecution(params.botId, params.agentPublicKey, params.subAccountId, params.market);
  
  if (!position || position.baseAssetAmount.isZero()) {
    return {
      success: true,
      executionMethod: 'swift',
      note: 'No position to close',
    };
  }
  
  // Submit close order with actual position size
  return executeSwiftOrder({
    ...params,
    baseAssetAmount: position.baseAssetAmount.abs(),
    direction: position.baseAssetAmount.gt(0) ? 'short' : 'long', // Opposite direction
    reduceOnly: true,
  });
}
```

### Order Expiry

Swift orders expire after a slot window (typically ~10-20 slots, 4-8 seconds).

**Handling:**
```typescript
if (swiftError.includes('stale slot') || swiftError.includes('expired')) {
  // Order expired before execution
  // Retry with fresh slot
  return classifySwiftError('retry_swift');
}
```

### Partial Fills

Swift may partially fill large orders based on available liquidity.

**Handling:**
```typescript
interface SwiftFillResult {
  requestedAmount: number;
  filledAmount: number;
  fillPrice: number;
  remainderAmount: number;
}

if (result.filledAmount < result.requestedAmount) {
  // Queue remainder
  const remainder = result.requestedAmount - result.filledAmount;
  if (remainder >= MINIMUM_ORDER_SIZE) {
    await queueTradeRetry({
      ...originalParams,
      size: remainder,
      isPartialFillRemainder: true,
    });
  }
}
```

### Position Flips

Changing from long to short (or vice versa) requires:
1. Close existing position
2. Open new position in opposite direction

**Implementation:**
```typescript
async function executePositionFlip(params: FlipParams): Promise<FlipResult> {
  // Step 1: Close existing position
  const closeResult = await executeSwiftClose({
    ...params,
    direction: params.currentDirection,
    reduceOnly: true,
  });
  
  if (!closeResult.success) {
    return { success: false, error: `Close failed: ${closeResult.error}` };
  }
  
  // Step 2: Open new position in opposite direction
  const openResult = await executeSwiftOrder({
    ...params,
    direction: params.newDirection,
    reduceOnly: false,
  });
  
  return {
    success: openResult.success,
    closeResult,
    openResult,
  };
}
```

### Dust Position Cleanup

Positions smaller than minimum order size can't be closed normally.

**Swift handling:**
```typescript
const MINIMUM_SWIFT_ORDER_SIZE = 0.001; // Example, verify with Swift docs

if (positionSize < MINIMUM_SWIFT_ORDER_SIZE) {
  console.log(`[Swift] Position too small for Swift: ${positionSize}, using legacy`);
  return executeLegacyClose(params);
}
```

### Market Liquidity Variations (V3 Updated)

**V3 CORRECTION:** The original plan assumed only 3 markets (SOL, BTC, ETH) had Swift liquidity. As of February 2026, Swift is live for **all perpetual futures markets** on Drift. The tiered liquidity model is no longer needed.

**Recommended approach:** Use Swift for all markets with automatic fallback to legacy. Monitor per-market fill rates and auction durations via the metrics system. If a specific market consistently fails on Swift (>10% failure rate over 24h), log a warning but continue attempting Swift with fallback.

```typescript
// V3: No market tier system needed. All markets use Swift with fallback.
function shouldUseSwift(market: string): boolean {
  if (!isSwiftAvailable()) return false;
  // All perp markets are Swift-eligible
  return true;
}
```

---

## Observability & Monitoring

### Required Metrics

#### Swift API Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `swift_orders_total` | Counter | Total Swift orders submitted |
| `swift_orders_success` | Counter | Successful Swift fills |
| `swift_orders_failed` | Counter | Failed Swift orders |
| `swift_orders_fallback` | Counter | Orders that fell back to legacy |
| `swift_api_latency_ms` | Histogram | Swift API response time |
| `swift_auction_duration_ms` | Histogram | Time from submit to fill |
| `swift_price_improvement_bps` | Histogram | Fill price vs oracle (basis points) |

#### Per-Market Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `swift_orders_by_market` | Counter | Swift orders per market |
| `swift_success_rate_by_market` | Gauge | Success rate per market |
| `swift_avg_fill_time_by_market` | Gauge | Average fill time per market |

#### Error Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `swift_errors_by_type` | Counter | Errors categorized by type |
| `swift_retries_total` | Counter | Total retry attempts |
| `swift_fallback_reasons` | Counter | Fallback reasons categorized |

### Implementation

```typescript
// server/swift-metrics.ts

interface SwiftMetrics {
  ordersTotal: number;
  ordersSuccess: number;
  ordersFailed: number;
  ordersFallback: number;
  latencyHistogram: number[];
  auctionDurationHistogram: number[];
  priceImprovementHistogram: number[];
  errorsByType: Record<string, number>;
  byMarket: Record<string, MarketMetrics>;
}

interface MarketMetrics {
  ordersTotal: number;
  ordersSuccess: number;
  avgFillTimeMs: number;
  avgPriceImprovementBps: number;
}

const metrics: SwiftMetrics = {
  ordersTotal: 0,
  ordersSuccess: 0,
  ordersFailed: 0,
  ordersFallback: 0,
  latencyHistogram: [],
  auctionDurationHistogram: [],
  priceImprovementHistogram: [],
  errorsByType: {},
  byMarket: {},
};

export function recordSwiftOrder(result: SwiftOrderResult, market: string): void {
  metrics.ordersTotal++;
  
  if (result.success) {
    metrics.ordersSuccess++;
    if (result.auctionDurationMs) {
      metrics.auctionDurationHistogram.push(result.auctionDurationMs);
    }
    if (result.priceImprovement) {
      metrics.priceImprovementHistogram.push(result.priceImprovement);
    }
  } else {
    if (result.executionMethod === 'legacy' && result.swiftAttempted) {
      metrics.ordersFallback++;
    } else {
      metrics.ordersFailed++;
    }
    
    if (result.errorCode) {
      metrics.errorsByType[result.errorCode] = (metrics.errorsByType[result.errorCode] || 0) + 1;
    }
  }
  
  // Update market-specific metrics
  if (!metrics.byMarket[market]) {
    metrics.byMarket[market] = { ordersTotal: 0, ordersSuccess: 0, avgFillTimeMs: 0, avgPriceImprovementBps: 0 };
  }
  metrics.byMarket[market].ordersTotal++;
  if (result.success) {
    metrics.byMarket[market].ordersSuccess++;
  }
}

export function getSwiftMetrics(): SwiftMetrics {
  return { ...metrics };
}
```

### Alerting Rules

| Alert | Condition | Severity |
|-------|-----------|----------|
| Swift API Down | Health check fails 3x consecutive | High |
| High Fallback Rate | Fallback rate > 10% over 5 min | Medium |
| Swift Latency Spike | p95 latency > 2s | Medium |
| Market Liquidity Issue | Market success rate < 50% | Medium |
| Swift Errors Spike | Error rate > 5% over 5 min | High |

### Dashboard Endpoints

```typescript
// GET /api/admin/swift-metrics
app.get("/api/admin/swift-metrics", requireAdmin, (req, res) => {
  const metrics = getSwiftMetrics();
  res.json({
    summary: {
      totalOrders: metrics.ordersTotal,
      successRate: metrics.ordersSuccess / metrics.ordersTotal,
      fallbackRate: metrics.ordersFallback / metrics.ordersTotal,
      avgLatencyMs: average(metrics.latencyHistogram),
      avgPriceImprovementBps: average(metrics.priceImprovementHistogram),
    },
    byMarket: metrics.byMarket,
    errorBreakdown: metrics.errorsByType,
  });
});
```

---

## Testing Plan

### Unit Tests

| Test | Description |
|------|-------------|
| Swift message signing | Verify SDK signing methods work correctly |
| UUID generation | Verify unique 8-byte UUIDs |
| Error classification | Verify error categorization logic |
| Fallback logic | Verify fallback triggers correctly |
| Retry strategy | Verify Swift → legacy fallback on retry |

### Integration Tests

| Test | Description |
|------|-------------|
| Swift API connectivity | Connect to Swift API, verify health check |
| Order submission | Submit test order, verify acceptance |
| Order fill | Submit order, verify fill response |
| Fallback on failure | Force Swift failure, verify legacy execution |
| Rate limiting | Verify rate limit handling |

### End-to-End Tests

| Test | Scenario |
|------|----------|
| Webhook → Swift | Full webhook flow with Swift execution |
| Subscriber routing | Multiple subscriber Swift trades |
| Position close | Close position with profit share |
| Position flip | Long → Short with Swift |
| Retry flow | Failed trade → retry → success |

### Load Tests

| Test | Description |
|------|-------------|
| Concurrent orders | 100 simultaneous Swift orders |
| Subscriber burst | 50 subscribers from single signal |
| Mixed execution | 50% Swift, 50% legacy |
| Failover stress | Swift down, verify fallback handles load |

### Production Validation

| Metric | Target | Validation Period |
|--------|--------|-------------------|
| Swift success rate | > 95% | 1 week |
| Fallback rate | < 5% | 1 week |
| Price improvement | > 0.02% average | 2 weeks |
| Latency p95 | < 1000ms | 1 week |

---

## Migration Strategy

### Staged Rollout

| Phase | Description | Timeline | Criteria to Proceed |
|-------|-------------|----------|---------------------|
| 0 | Documentation & 3rd party audit | Week 0 | Audit complete |
| 1 | Dev environment testing | Week 1-2 | All tests pass |
| 2 | Internal team testing (1% of traffic) | Week 3 | 99% success rate |
| 3 | Beta users opt-in (10% of bots) | Week 4 | 98% success rate |
| 4 | Default on for new bots | Week 5 | No critical issues |
| 5 | Migrate existing bots (with notification) | Week 6 | User opt-out available |
| 6 | Swift as primary (legacy as fallback) | Week 8+ | Stable for 2 weeks |

### Feature Flags

```typescript
const SWIFT_FEATURE_FLAGS = {
  // Global controls
  SWIFT_GLOBALLY_ENABLED: true,
  SWIFT_PERCENTAGE_ROLLOUT: 10, // 10% of requests use Swift
  
  // V3 UPDATE: All perp markets support Swift. No market allowlist needed.
  // SWIFT_MARKETS_ENABLED removed - all markets eligible by default.
  
  // Behavioral controls
  SWIFT_FALLBACK_ENABLED: true,
  SWIFT_RETRY_WITH_SWIFT: true,
  SWIFT_CRITICAL_ORDERS_LEGACY: false, // Use legacy for critical closes
};
```

### User Communication

Before migration:
- Blog post explaining Swift benefits
- In-app notification about upcoming change
- Email to active users

During migration:
- Dashboard indicator showing execution method
- Option to disable Swift per bot
- Support channel for issues

---

## Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Swift API downtime | Medium | High | Automatic fallback to legacy |
| Worse fills than legacy | Low | Medium | A/B testing before rollout; per-market monitoring |
| Market maker liquidity gaps | Medium | Medium | Per-market Swift enablement; fallback on no-liquidity |
| SDK breaking changes | Low | High | Pin SDK version; test before upgrades |
| Increased complexity | Medium | Medium | Comprehensive testing; gradual rollout |
| Profit share timing issues | Medium | High | Verify fill before profit share calculation |
| Partial fill handling | Medium | Medium | Remainder queueing; proportional profit share |
| Security regression | Low | Critical | Security V3 compatibility verification |

---

## Rollback Plan

### Immediate Rollback (< 1 minute)

```typescript
// Set environment variable or feature flag
SWIFT_GLOBALLY_ENABLED=false
```

This immediately routes all trades to legacy execution.

### Per-Bot Rollback

```sql
UPDATE trading_bots 
SET swift_enabled = false 
WHERE id = 'affected-bot-id';
```

### Full Code Rollback

1. Deploy previous version without Swift code
2. All trades automatically use legacy path
3. Swift database fields remain but are unused

### Post-Rollback Analysis

1. Review Swift order logs for failure patterns
2. Analyze metrics for root cause
3. Document issues for fix
4. Plan re-deployment with fixes

---

## Success Metrics

### Primary KPIs

| KPI | Target | Measurement |
|-----|--------|-------------|
| Gas savings | $0 per trade | Track SOL spend reduction |
| Fill price improvement | > 0.03% average | Compare Swift vs oracle |
| Execution success rate | > 99% without fallback | Swift success / total Swift |
| Latency | < 500ms average | Swift API to fill time |

### Secondary KPIs

| KPI | Target | Measurement |
|-----|--------|-------------|
| Swift adoption rate | > 80% of eligible trades | Swift attempts / total trades |
| Fallback rate | < 5% | Fallback / Swift attempts |
| User satisfaction | Positive feedback | Reduced SOL top-up requests |
| Retry reduction | 30% fewer retries | Compare retry queue size |

---

---

## V3 Audit Findings & Corrections

**Audit Date:** February 9, 2026  
**Scope:** Full codebase audit against production system + Swift API research

### Finding 1: Decoupled Subscriber Routing (Critical)

**Original assumption:** Routing happens only after successful source bot trade.  
**Reality:** System now has 4 routing trigger points using `parseSignalForRouting()` for lightweight signal extraction without key decryption. Routing works when source bot is paused, auth disabled, auth expired, or executing normally. Retry worker also routes via `registerRoutingCallback`.  
**Impact:** Swift integration must work at all 4 trigger points, not just post-trade.  
**Status:** Updated in Path 3 documentation above.

### Finding 2: Unified Trade Sizing (`computeTradeSizingAndTopUp`)

**Original assumption:** Plan's Swift execution paths bypass trade sizing.  
**Reality:** A 300+ line unified helper handles auto top-up, profit reinvestment mode, dynamic leverage capping, minimum order enforcement, and bot auto-pause on insufficient funds. All trade execution paths go through this.  
**Impact:** Swift trades MUST route through `computeTradeSizingAndTopUp` before order submission. Do not bypass it.  
**Status:** Updated in subscriber routing code examples.

### Finding 3: PositionService for Close Verification

**Original assumption:** Plan references generic "getOnChainPosition" for reduce-only checks.  
**Reality:** `PositionService.getPositionForExecution()` is the established path. Uses byte-parsing (not SDK) to avoid WebSocket memory leaks.  
**Impact:** Swift close orders should use `PositionService`, not build a new position check.  
**Status:** Updated in Reduce-Only Semantics section.

### Finding 4: All Perp Markets Support Swift

**Original assumption:** Only SOL, BTC, ETH supported.  
**Reality:** Swift launched March 2025 for ALL perpetual futures markets on Drift. All 85+ markets in QuantumVault's `PERP_MARKET_INDICES` are eligible.  
**Impact:** Remove `supportedMarkets` allowlist. No market tiering needed.  
**Status:** Updated throughout document.

### Finding 5: Reduce-Only Natively Supported

**Original assumption:** "Different semantics (TBD)" for reduce-only.  
**Reality:** Swift natively supports `reduceOnly` flag with identical semantics to legacy orders.  
**Impact:** No special reduce-only handling needed.  
**Status:** Updated in Swift-Specific Limitations section.

### Finding 6: Cooldown Retry System

**Original assumption:** Plan doesn't account for cooldown retries.  
**Reality:** Retry service has `cooldownRetries` field and 2-minute cooldown re-queue for timeout errors (max 2 cooldown retries).  
**Impact:** Swift retry strategy must integrate with cooldown system.  
**Status:** Updated in Path 4 documentation.

### Finding 7: Subprocess Architecture Decision

**Original assumption:** Not addressed.  
**Reality:** Current trades run in `drift-executor.mjs` subprocess via stdin/stdout JSON. Swift is sign-message + HTTP POST (no heavy transaction building).  
**Recommendation:** Run Swift in main Node process (lighter weight), keep legacy subprocess as fallback. This avoids modifying `drift-executor.mjs` and is architecturally cleaner since Swift doesn't need process isolation.  
**Status:** New architectural recommendation.

### Finding 8: SDK Has Built-in Swift Methods

**Original assumption:** Plan proposes custom HTTP client for Swift API.  
**Reality:** `@drift-labs/sdk` DriftClient has `encodeSwiftOrderParamsMessage()`, `decodeSwiftServerMessage()`, `placeAndMakeSwiftPerpOrder()`, and related methods.  
**Impact:** Can leverage SDK methods instead of building from scratch.  
**Status:** Updated in Swift Protocol Overview section.

### Finding 9: Builder Codes Revenue Opportunity

**Original assumption:** Not mentioned.  
**Reality:** Builder Codes are limited to Swift orders only. Registering as a Drift builder would earn platform fees on every Swift trade executed.  
**Impact:** Additional revenue stream worth exploring during implementation.  
**Status:** Noted in SDK Integration section.

### Finding 10: Latency Budget Gap

**Original assumption:** Plan doesn't specify total timeout for Swift attempt + fallback.  
**Reality:** Need aggressive Swift timeout (recommended 3 seconds) so Swift + fallback total stays under 5 seconds. Current webhook response time is 1-2 seconds.  
**Impact:** Add `SWIFT_ORDER_TIMEOUT_MS: 3000` config (not 5000 as originally proposed).  
**Status:** Recommended config change.

### Finding 11: Subscriber Batch Efficiency

**Original assumption:** Each subscriber independently discovers Swift failure and falls back.  
**Reality:** For batches of N subscribers, if Swift goes unhealthy mid-batch, remaining subscribers should skip Swift proactively.  
**Impact:** Add shared `swiftHealthy` flag checked at start of each subscriber execution within a batch.  
**Status:** New recommendation for subscriber routing.

### Finding 12: Database Schema - No Swift Fields Exist Yet

**Original assumption:** Plan proposes adding `swiftEnabled` per bot and `executionMethod` per trade.  
**Reality:** Neither `tradingBots` nor `bot_trades` schemas have any Swift-related columns. Current `trade_retry_queue` also lacks Swift fields.  
**Impact:** Schema migration needed before implementation. Fields to add:
- `bot_trades`: `executionMethod` (text, 'swift' | 'legacy')
- `trade_retry_queue`: Consider adding `swiftAttempts`, `lastSwiftError` columns
- `tradingBots`: Consider global Swift config vs per-bot `swiftEnabled` flag  
**Status:** Schema migration required as Phase 1 prerequisite.

---

## Appendices

### Appendix A: Swift API Reference

**Endpoint:** `https://swift.drift.trade`

**Request:**
```json
POST /order
{
  "orderParams": "base64-encoded-signed-order-params",
  "signature": "base64-encoded-ed25519-signature",
  "publicKey": "base58-wallet-address"
}
```

**Response (Success):**
```json
{
  "success": true,
  "orderId": "swift-order-uuid",
  "status": "filled",
  "txSignature": "solana-tx-signature",
  "fillPrice": 195.50,
  "fillAmount": 1.0,
  "auctionDurationMs": 150,
  "makerPubkey": "maker-wallet-address",
  "priceImprovement": 0.0005
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "No liquidity available",
  "errorCode": "NO_LIQUIDITY"
}
```

### Appendix B: Error Code Reference

| Code | Description | Retryable | Fallback |
|------|-------------|-----------|----------|
| 400 | Invalid parameters | No | No |
| 401 | Invalid signature | No | No |
| 429 | Rate limited | Yes | No |
| 503 | No liquidity | Yes | Yes |
| 504 | Auction timeout | Yes | Yes |
| STALE_SLOT | Order expired | Yes | No |
| PARTIAL_FILL | Partially filled | N/A | Queue remainder |

### Appendix C: SDK Methods

```typescript
// DriftClient methods for Swift

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

### Appendix D: Configuration Reference

```typescript
// Environment variables
SWIFT_ENABLED=true                          // Global toggle
SWIFT_API_URL=https://swift.drift.trade     // API endpoint
SWIFT_ORDER_TIMEOUT_MS=5000                 // Order submission timeout
SWIFT_HEALTH_CHECK_INTERVAL_MS=30000        // Health check frequency
SWIFT_MAX_RETRIES_BEFORE_FALLBACK=2         // Max Swift retries before legacy
SWIFT_SUPPORTED_MARKETS=SOL-PERP,BTC-PERP,ETH-PERP  // Comma-separated markets
```

### Appendix E: Database Migration Script

```sql
-- Migration: Add Swift support fields
-- Run with: npm run db:push

-- 1. trading_bots additions
ALTER TABLE trading_bots 
ADD COLUMN IF NOT EXISTS swift_enabled BOOLEAN DEFAULT true NOT NULL,
ADD COLUMN IF NOT EXISTS swift_fallback_enabled BOOLEAN DEFAULT true NOT NULL;

-- 2. bot_trades additions
ALTER TABLE bot_trades
ADD COLUMN IF NOT EXISTS execution_method VARCHAR(20) DEFAULT 'legacy' NOT NULL,
ADD COLUMN IF NOT EXISTS swift_order_id VARCHAR(64),
ADD COLUMN IF NOT EXISTS swift_status VARCHAR(20),
ADD COLUMN IF NOT EXISTS swift_submitted_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS swift_filled_at TIMESTAMP,
ADD COLUMN IF NOT EXISTS auction_duration_ms INTEGER,
ADD COLUMN IF NOT EXISTS keeper_pubkey TEXT,
ADD COLUMN IF NOT EXISTS price_improvement DECIMAL(10, 4),
ADD COLUMN IF NOT EXISTS fallback_reason TEXT;

-- 3. trade_retry_queue additions
ALTER TABLE trade_retry_queue
ADD COLUMN IF NOT EXISTS swift_order_id VARCHAR(64),
ADD COLUMN IF NOT EXISTS original_execution_method VARCHAR(20) DEFAULT 'legacy',
ADD COLUMN IF NOT EXISTS swift_attempts INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_swift_error TEXT;

-- 4. New audit table
CREATE TABLE IF NOT EXISTS swift_order_logs (
  id VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_id VARCHAR(255) REFERENCES bot_trades(id) ON DELETE CASCADE,
  swift_order_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  timestamp TIMESTAMP DEFAULT NOW() NOT NULL,
  request_payload JSONB,
  response_payload JSONB,
  error_code VARCHAR(20),
  error_message TEXT,
  latency_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_swift_order_logs_trade_id ON swift_order_logs(trade_id);
CREATE INDEX IF NOT EXISTS idx_swift_order_logs_swift_order_id ON swift_order_logs(swift_order_id);
CREATE INDEX IF NOT EXISTS idx_swift_order_logs_event_type ON swift_order_logs(event_type);
```

---

## Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-21 | Engineering | Initial draft |
| 2.0 | 2026-01-26 | Engineering | Comprehensive gap analysis update; added detailed architecture documentation, all 4 execution paths, profit sharing integration, retry service integration, security V3 compatibility, Swift limitations, observability requirements, comprehensive testing plan |
| 3.0 | 2026-02-09 | Engineering + AI Audit | Codebase audit: decoupled routing, computeTradeSizingAndTopUp, PositionService, all-market support, SDK methods, cooldown retries, subprocess architecture, Builder Codes |

---

**Document Maintained By:** Engineering Team  
**Last Updated:** February 9, 2026  
**Next Review:** Before implementation kickoff  
**Status:** Planning (Audited - V3 Updated)

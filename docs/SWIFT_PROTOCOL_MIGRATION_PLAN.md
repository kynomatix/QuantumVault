# Swift Protocol Migration & Integration Plan

**Created:** January 21, 2026  
**Last Updated:** February 9, 2026  
**Version:** 4.3  
**Status:** Ready for External Audit  
**V4 Changelog:** Merged research + integration plan into single document; addressed external auditor feedback on reduce-only, subaccount workarounds, fee calculation, and key signing

---

## Table of Contents

### Part 1: System Architecture & Research
1. [Executive Summary](#1-executive-summary)
2. [Current System Architecture](#2-current-system-architecture)
3. [Swift Protocol Overview](#3-swift-protocol-overview)

### Part 2: Gap Analysis & Audit Findings
4. [Gap Analysis](#4-gap-analysis)
5. [V3 Audit Findings & Corrections](#5-v3-audit-findings--corrections)
6. [Swift-Specific Limitations](#6-swift-specific-limitations)

### Part 3: Integration Plan
7. [Architecture Decision: Where Swift Lives](#7-architecture-decision-where-swift-lives)
8. [Step-by-Step Integration Path (Steps 1–9)](#8-step-by-step-integration-path)
9. [Security V3 Compatibility](#9-security-v3-compatibility)
10. [Audit Findings Coverage Map](#10-audit-findings-coverage-map)
11. [File Change Summary](#11-file-change-summary)
12. [Risk Summary](#12-risk-summary)
13. [What This Plan Does NOT Cover](#13-what-this-plan-does-not-cover)
14. [Dependencies & Prerequisites](#14-dependencies--prerequisites)
15. [Timeline Estimate](#15-timeline-estimate)

### Part 4: External Auditor Responses
16. [External Auditor Responses](#16-external-auditor-responses)

### Part 5: Appendices
17. [Appendix A: Swift API Reference](#17-appendix-a-swift-api-reference)
18. [Appendix B: Error Code Reference](#18-appendix-b-error-code-reference)
19. [Appendix C: SDK Methods](#19-appendix-c-sdk-methods)
20. [Appendix D: Configuration Reference](#20-appendix-d-configuration-reference)
21. [Appendix E: Database Migration Script](#21-appendix-e-database-migration-script)
22. [Document History](#22-document-history)

---

# Part 1: System Architecture & Research

---

## 1. Executive Summary

Swift Protocol is Drift's next-generation execution layer that enables **gasless trading with better execution prices** through off-chain order signing and market maker competition via Dutch auctions.

This document is the **single source of truth** for the Swift Protocol integration into QuantumVault. It contains the research, architecture, gap analysis, audit findings, step-by-step implementation plan, and external auditor responses. Swift operates **in parallel** with the current on-chain `placeAndTakePerpOrder` execution method, with automatic fallback capabilities.

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

## 2. Current System Architecture

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

## 3. Swift Protocol Overview

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

### Market Support (V3 Updated — February 2026)

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

**Builder Codes:** Swift orders exclusively support Drift Builder Codes for revenue sharing. Registering as a builder would earn a fee on every Swift trade the platform executes — potential additional revenue stream.

**Drift v3 Context:** Drift v3 launched December 2025 with 85% of orders filling within 400ms. Swift is being made the default trading method platform-wide.

---

# Part 2: Gap Analysis & Audit Findings

---

## 4. Gap Analysis

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

#### Gap 3: Retry Service Integration

**Problem:** Retry service doesn't track Swift-specific data.

**Required:**
- Swift order ID tracking across retries
- Different error classification (Swift API vs RPC)
- Retry strategy: retry Swift → fallback → legacy retry
- Critical priority handling for Swift close failures

#### Gap 4: Profit Sharing Flow

**Problem:** Profit sharing depends on synchronous close detection.

**Challenges:**
- Swift fills are async
- Need to wait for on-chain settlement
- Partial fills complicate PnL calculation

#### Gap 5: Database Schema Gaps

**Problem:** Original schema changes insufficient.

**Required additions:**
- Swift order tracking (UUID, status, timestamps)
- Audit trail for debugging
- Retry queue enhancements

#### Gap 6: Swift-Specific Limitations

**Problem:** Swift has different semantics than legacy.

**Not addressed:**
- Reduce-only behavior differences
- Order expiry (slot window)
- Partial fills
- Position flip handling
- Dust position cleanup
- Market liquidity variations

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

---

## 5. V3 Audit Findings & Corrections

**Audit Date:** February 9, 2026  
**Scope:** Full codebase audit against production system + Swift API research

### Finding 1: Decoupled Subscriber Routing (Critical)

**Original assumption:** Routing happens only after successful source bot trade.  
**Reality:** System now has 4 routing trigger points using `parseSignalForRouting()` for lightweight signal extraction without key decryption. Routing works when source bot is paused, auth disabled, auth expired, or executing normally. Retry worker also routes via `registerRoutingCallback`.  
**Impact:** Swift integration must work at all 4 trigger points, not just post-trade.  
**Status:** Addressed in Integration Plan Step 4 verification gates.

### Finding 2: Unified Trade Sizing (`computeTradeSizingAndTopUp`)

**Original assumption:** Plan's Swift execution paths bypass trade sizing.  
**Reality:** A 300+ line unified helper handles auto top-up, profit reinvestment mode, dynamic leverage capping, minimum order enforcement, and bot auto-pause on insufficient funds. All trade execution paths go through this.  
**Impact:** Swift trades MUST route through `computeTradeSizingAndTopUp` before order submission. Do not bypass it.  
**Status:** Addressed in Integration Plan Step 4 critical rules.

### Finding 3: PositionService for Close Verification

**Original assumption:** Plan references generic "getOnChainPosition" for reduce-only checks.  
**Reality:** `PositionService.getPositionForExecution()` is the established path. Uses byte-parsing (not SDK) to avoid WebSocket memory leaks.  
**Impact:** Swift close orders should use `PositionService`, not build a new position check.  
**Status:** Addressed in Integration Plan Step 4 critical rules.

### Finding 4: All Perp Markets Support Swift

**Original assumption:** Only SOL, BTC, ETH supported.  
**Reality:** Swift launched March 2025 for ALL perpetual futures markets on Drift. All 85+ markets in QuantumVault's `PERP_MARKET_INDICES` are eligible.  
**Impact:** Remove `supportedMarkets` allowlist. No market tiering needed.  
**Status:** Addressed in Integration Plan Step 2 config.

### Finding 5: Reduce-Only Natively Supported

**Original assumption:** "Different semantics (TBD)" for reduce-only.  
**Reality:** Swift natively supports `reduceOnly` flag with identical semantics to legacy orders.  
**Impact:** No special reduce-only handling needed.  
**Status:** Addressed in Section 6 (Swift-Specific Limitations) and Integration Plan Step 4.

### Finding 6: Cooldown Retry System

**Original assumption:** Plan doesn't account for cooldown retries.  
**Reality:** Retry service has `cooldownRetries` field and 2-minute cooldown re-queue for timeout errors (max 2 cooldown retries).  
**Impact:** Swift retry strategy must integrate with cooldown system.  
**Status:** Addressed in Integration Plan Step 6.

### Finding 7: Subprocess Architecture Decision

**Original assumption:** Not addressed.  
**Reality:** Current trades run in `drift-executor.mjs` subprocess via stdin/stdout JSON. Swift is sign-message + HTTP POST (no heavy transaction building).  
**Recommendation:** Run Swift in main Node process (lighter weight), keep legacy subprocess as fallback. This avoids modifying `drift-executor.mjs` and is architecturally cleaner since Swift doesn't need process isolation.  
**Status:** Addressed in Integration Plan Section 7 (Architecture Decision).

### Finding 8: SDK Has Built-in Swift Methods

**Original assumption:** Plan proposes custom HTTP client for Swift API.  
**Reality:** `@drift-labs/sdk` DriftClient has `encodeSwiftOrderParamsMessage()`, `decodeSwiftServerMessage()`, `placeAndMakeSwiftPerpOrder()`, and related methods.  
**Impact:** Can leverage SDK methods instead of building from scratch.  
**Status:** Addressed in Integration Plan Step 3.

### Finding 9: Builder Codes Revenue Opportunity

**Original assumption:** Not mentioned.  
**Reality:** Builder Codes are limited to Swift orders only. Registering as a Drift builder would earn platform fees on every Swift trade executed.  
**Impact:** Additional revenue stream worth exploring during implementation.  
**Status:** Addressed in Integration Plan Step 9 (optional).

### Finding 10: Latency Budget Gap

**Original assumption:** Plan doesn't specify total timeout for Swift attempt + fallback.  
**Reality:** Need aggressive Swift timeout (recommended 3 seconds) so Swift + fallback total stays under 5 seconds. Current webhook response time is 1-2 seconds.  
**Impact:** Add `SWIFT_ORDER_TIMEOUT_MS: 3000` config (not 5000 as originally proposed).  
**Status:** Addressed in Integration Plan Step 2 config.

### Finding 11: Subscriber Batch Efficiency

**Original assumption:** Each subscriber independently discovers Swift failure and falls back.  
**Reality:** For batches of N subscribers, if Swift goes unhealthy mid-batch, remaining subscribers should skip Swift proactively.  
**Impact:** Add shared `swiftHealthy` flag checked at start of each subscriber execution within a batch.  
**Status:** Addressed in Integration Plan Step 4.

### Finding 12: Database Schema — No Swift Fields Exist Yet

**Original assumption:** Plan proposes adding `swiftEnabled` per bot and `executionMethod` per trade.  
**Reality:** Neither `tradingBots` nor `bot_trades` schemas have any Swift-related columns. Current `trade_retry_queue` also lacks Swift fields.  
**Impact:** Schema migration needed before implementation.  
**Status:** Addressed in Integration Plan Step 1.

---

## 6. Swift-Specific Limitations

### Reduce-Only Semantics (V3 Updated — Confirmed Resolved)

**Legacy behavior:** `reduceOnly: true` ensures order only reduces position.

**Swift behavior:** Swift natively supports the `reduceOnly` flag with identical semantics to legacy orders. The `immediateOrCancel` (IOC) flag is also supported. No special handling needed for reduce-only Swift orders.

**AUDITOR NOTE (February 2026):** An external audit flagged concern about a race condition in a "check-then-submit" pattern for reduce-only orders. This concern was based on an earlier version of this document that was uncertain about Swift's reduce-only support. **This has been resolved:** Swift natively supports the `reduceOnly` flag with identical semantics to legacy `placeAndTakePerpOrder`. No "check-then-submit" pattern is needed. The `reduceOnly` flag is passed directly in the Swift order parameters. The only pre-submission position check is via `PositionService.getPositionForExecution()` to determine IF a close is needed (i.e., does a position exist to close), not to enforce reduce-only behavior — that's handled by the protocol.

**Position verification before close:** Even though `reduceOnly` is supported, the system should still verify position existence via `PositionService.getPositionForExecution()` before submitting close orders, consistent with current behavior:

```typescript
async function executeSwiftClose(params: CloseParams): Promise<SwiftOrderResult> {
  // First verify position exists (determines IF we need to close — NOT enforcing reduce-only)
  const position = await PositionService.getPositionForExecution(params.botId, params.agentPublicKey, params.subAccountId, params.market);
  
  if (!position || position.baseAssetAmount.isZero()) {
    return {
      success: true,
      executionMethod: 'swift',
      note: 'No position to close',
    };
  }
  
  // Submit close order with actual position size — reduceOnly enforced by protocol
  return executeSwiftOrder({
    ...params,
    baseAssetAmount: position.baseAssetAmount.abs(),
    direction: position.baseAssetAmount.gt(0) ? 'short' : 'long',
    reduceOnly: true,
  });
}
```

### Order Expiry

Swift orders expire after a slot window (typically ~10-20 slots, 4-8 seconds).

**Handling:**
```typescript
if (swiftError.includes('stale slot') || swiftError.includes('expired')) {
  // Order expired before execution — retry with fresh slot
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
const MINIMUM_SWIFT_ORDER_SIZE = 0.001; // Verify with Swift docs

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
  return true;
}
```

---

# Part 3: Integration Plan

---

## 7. Architecture Decision: Where Swift Lives

**Decision:** Swift execution runs in the **main Node.js process**, not in the `drift-executor.mjs` subprocess.

**Rationale:**
- Swift is sign-a-message + HTTP POST — no heavy transaction building, no process isolation needed
- `drift-executor.mjs` stays untouched as the legacy fallback path
- The Swift executor is a new module (`server/swift-executor.ts`) called from `drift-service.ts`
- If Swift fails, the existing subprocess path fires as fallback — zero changes to proven code

```
                        ┌─────────────────────────┐
                        │   executePerpOrder()     │
                        │   (drift-service.ts)     │
                        └──────────┬──────────────┘
                                   │
                        ┌──────────▼──────────────┐
                        │  Should use Swift?       │
                        │  (swift-config.ts)       │
                        └──────┬─────────┬────────┘
                               │ YES     │ NO
                    ┌──────────▼───┐  ┌──▼──────────────┐
                    │ swift-       │  │ drift-executor   │
                    │ executor.ts  │  │ .mjs subprocess  │
                    │ (main proc)  │  │ (unchanged)      │
                    └──────┬───────┘  └─────────────────┘
                           │
                    ┌──────▼───────┐
                    │ Swift fail?  │
                    │ fallback →   │──▶ drift-executor.mjs
                    └──────────────┘
```

---

## 8. Step-by-Step Integration Path

Each step has:
- **What** you're building
- **Where** in the codebase it goes
- **How** to verify it works
- **Gate** criteria before proceeding to the next step

Nothing proceeds without passing its gate.

### Implementation Progress Tracker

| Step | Description | Status | Date Completed |
|------|-------------|--------|----------------|
| 1 | Database Schema Migration | - [x] COMPLETED | Feb 9, 2026 |
| 2 | Swift Configuration Module | - [x] COMPLETED | Feb 9, 2026 |
| 3 | Swift Executor Module | - [x] COMPLETED | Feb 9, 2026 |
| 4 | Integration — executePerpOrder Wrapper | - [ ] NOT STARTED | |
| 5 | Trade Logging Updates | - [ ] NOT STARTED | |
| 6 | Retry Service Integration | - [ ] NOT STARTED | |
| 7 | Observability & Metrics | - [ ] NOT STARTED | |
| 8 | Controlled Activation | - [ ] NOT STARTED | |
| 9 | Builder Code Registration (Optional) | - [ ] NOT STARTED | |

**How to use:** When completing a step, change `- [ ] NOT STARTED` to `- [x] COMPLETED` and fill in the date. This tracker is the first thing to check when resuming work to know where you left off.

---

### Step 1: Database Schema Migration — ✅ COMPLETED (Feb 9, 2026)

**What:** Add Swift tracking columns to existing tables.

**Where:** `shared/schema.ts`

**Changes:**

```
bot_trades table — ADD:
  executionMethod  text  default 'legacy'    // 'swift' | 'legacy'
  swiftOrderId     text  nullable            // Swift UUID for tracking
  auctionDurationMs integer nullable         // How long the auction took
  priceImprovement  decimal nullable         // Fill price vs oracle (bps)

trade_retry_queue table — ADD:
  swiftAttempts       integer  default 0     // Swift-specific retry count
  originalExecMethod  text     default 'legacy'  // What method was tried first
```

**Not adding:**
- No `swiftEnabled` per bot — Swift is a global platform capability with automatic fallback, not a per-bot setting
- No separate `swift_order_logs` audit table yet — the `executionMethod` column on `bot_trades` gives us tracking without a new table. Add the audit table later if debugging requires it

**Verify:**
1. Run `npm run db:push` — migration completes without errors
2. Query `SELECT column_name FROM information_schema.columns WHERE table_name = 'bot_trades'` — new columns exist
3. Existing trades still load in the UI — no regressions

**Gate:** Schema migration applied, existing data intact, app starts normally.

---

### Step 2: Swift Configuration Module — ✅ COMPLETED (Feb 9, 2026)

**What:** Central config for Swift behavior, health tracking, and error classification.

**Where:** New file `server/swift-config.ts`

**Contents:**

```
SWIFT_CONFIG:
  enabled:           env SWIFT_ENABLED (default: false — OFF until Step 7)
  apiUrl:            'https://swift.drift.trade'
  orderTimeoutMs:    3000  (aggressive — leaves room for legacy fallback within 5s total)
  healthCheckMs:     30000
  maxSwiftRetries:   2     (then fall back to legacy)
  fallbackEnabled:   true  (always fall back to legacy on Swift failure)

SWIFT_HEALTH (in-memory state):
  isHealthy:              boolean
  lastCheckAt:            timestamp
  consecutiveFailures:    number
  latencyMs:              number

isSwiftAvailable():       returns enabled && isHealthy
shouldUseSwift():         returns isSwiftAvailable() (no market filtering — all markets eligible)

SWIFT_ERROR_CLASSIFICATION:
  RETRYABLE_SWIFT:     ['timeout', '429', '503', '504', 'stale slot']
  FALLBACK_TO_LEGACY:  ['no liquidity', 'auction timeout']
  PERMANENT:           ['invalid signature', 'invalid order parameters', '400', '401']
  classifySwiftError(error) → 'retry_swift' | 'fallback_legacy' | 'permanent'
```

**Verify:**
1. Module imports without errors
2. `isSwiftAvailable()` returns `false` (SWIFT_ENABLED defaults to false)
3. Error classification returns correct categories for test strings

**Gate:** Config module compiles, health state tracks correctly, error classification is accurate.

---

### Step 3: Swift Executor Module — ✅ COMPLETED (Feb 9, 2026)

**What:** The core module that signs Swift order messages and submits them to the Swift API.

**Where:** New file `server/swift-executor.ts`

**Function signature:**

```typescript
export async function executeSwiftOrder(params: {
  privateKeyBase58: string;        // Decrypted agent key (same key used for legacy)
  agentPublicKey: string;
  market: string;                  // e.g., 'SOL-PERP'
  marketIndex: number;
  side: 'long' | 'short';
  sizeInBase: number;
  subAccountId: number;
  reduceOnly: boolean;
  slippageBps?: number;
}): Promise<SwiftOrderResult>
```

**Internal flow:**
1. Get current slot from RPC (1 lightweight `getSlot` call)
2. Build `SignedMsgOrderParamsMessage` with slot, UUID, order params
3. Sign with agent keypair using `driftClient.signSignedMsgOrderParamsMessage()`
4. POST to `https://swift.drift.trade/orders` with 3-second timeout
5. Parse response — return success with fill details or error with classification

**Return type:**
```typescript
interface SwiftOrderResult {
  success: boolean;
  executionMethod: 'swift';
  txSignature?: string;           // On-chain signature from keeper
  swiftOrderId?: string;          // Swift UUID
  fillPrice?: number;
  fillAmount?: number;
  auctionDurationMs?: number;
  priceImprovement?: number;      // vs oracle, in bps
  error?: string;
  errorClassification?: 'retry_swift' | 'fallback_legacy' | 'permanent';
}
```

**Key implementation details:**
- Uses `@drift-labs/sdk` built-in methods for message encoding/signing
- Does NOT create a full DriftClient with subscriptions — only needs a lightweight client for signing
- Requires an active RPC connection only for `getSlot()` — uses existing `getConnection()` from drift-service
- Does NOT handle trade sizing — that's done upstream by `computeTradeSizingAndTopUp`
- Does NOT handle position checks — that's done upstream by `PositionService.getPositionForExecution()`

**Implementation Investigation Required (V4.3 — February 2026):**

The current `getAgentDriftClient()` (drift-service.ts line 571-641) creates a full DriftClient with polling subscriptions and calls `driftClient.subscribe()` with a 15-second timeout. This is the HEAVY operation. Swift's "lightweight client" claim requires verification:

The `signSignedMsgOrderParamsMessage()` method lives on `DriftClient`. Three approaches to avoid full subscription:

1. **No-subscribe DriftClient (preferred):** Create a `DriftClient` instance but skip `subscribe()`. Test whether `signSignedMsgOrderParamsMessage()` works without subscriptions — since signing is a pure cryptographic operation using the wallet's keypair, it likely doesn't need account data.

2. **Manual signing fallback:** If the SDK requires subscriptions for signing, use `nacl.sign()` directly with the Keypair to sign the serialized Swift order message. This bypasses `DriftClient` entirely but requires understanding the exact message format.

3. **Custom subscription type:** Create `DriftClient` with `accountSubscription: { type: 'custom' }` to avoid loading account data while still having a valid client instance.

**RESOLVED (Feb 9, 2026):** Approach 1 (no-subscribe DriftClient) confirmed working. `signSignedMsgOrderParamsMessage()` works WITHOUT calling `subscribe()` — it only needs the wallet keypair for ed25519 signing. Swift signing overhead is ~0ms (plus getSlot RPC call ~100ms). The SDK return type is `{ orderParams: Buffer(126), signature: Uint8Array(64) }` — NOT `{ signedMessage, signature }` as originally assumed.

**Implementation notes:**
- `generateSignedMsgUuid()` returns `Uint8Array(8)`
- `@solana/web3.js` type mismatch between app and SDK's bundled version resolved with `as any` casts at the SDK boundary
- Swift API request format: `{ market_index, market_type, message (base64), signature (base64), taker_authority }`
- No existing files import swift-executor or swift-config — zero side effects on existing system

**getSlot() Failure Handling:**

Swift signing requires a current slot number from `getSlot()` RPC call. If this fails:
- Uses primary RPC from `getPrimaryRpcUrl()` for getSlot
- If RPC is down, `getSlot()` will fail → Swift attempt fails → classify as `fallback_legacy` → proceed to legacy subprocess
- No separate retry of `getSlot()` — the 3-second Swift timeout covers the entire operation including the `getSlot()` call

**Verified:**
1. Module compiles with zero LSP errors
2. Signing works with test keypair without DriftClient.subscribe()
3. Error classification verified: timeout→retry_swift, no liquidity→fallback_legacy, invalid signature→permanent
4. All imports resolve, no side effects on existing system

**Gate:** ✅ PASSED — Swift executor signs messages correctly, submits to API with correct format, classifies errors accurately.

---

### Step 4: Integration Point — `executePerpOrder` Wrapper — ⬜ NOT STARTED

**What:** Modify `executePerpOrder()` in `drift-service.ts` to try Swift first, fall back to legacy subprocess.

**Where:** `server/drift-service.ts`, function `executePerpOrder()` (line ~3248)

**Current flow:**
```
executePerpOrder() → spawn drift-executor.mjs → placeAndTakePerpOrder → return result
```

**New flow:**
```
executePerpOrder()
  │
  ├─ shouldUseSwift()? ─── YES ──▶ executeSwiftOrder()
  │                                      │
  │                                 Success? ──▶ return swift result
  │                                      │
  │                                 Fail (fallback_legacy)? ──▶ continue to legacy
  │                                 Fail (permanent)? ──▶ return error
  │
  └─ NO (or Swift failed with fallback) ──▶ spawn drift-executor.mjs (existing code, unchanged)
```

**Critical rules:**
- The `executePerpOrder` function signature does NOT change — all callers (webhook, manual, subscriber, retry) are unaffected
- Swift is tried first, legacy is fallback — never the other way around
- If Swift succeeds, the result is mapped to the same return type as legacy
- If Swift fails with `fallback_legacy` classification, log the Swift error and proceed to legacy — no extra delay
- If Swift fails with `permanent` classification, return the error immediately — don't waste time on legacy
- The `executionMethod` ('swift' or 'legacy') is added to the return object so callers can log it

**`closePerpPosition` Coverage (V4.1 — February 2026):**

An external code review identified that `closePerpPosition()` in `drift-service.ts` is a **separate function** from `executePerpOrder()` — it has its own independent SDK/subprocess execution path. Close orders throughout the codebase call `closePerpPosition()` directly:

- Subscriber routing close (`routes.ts` ~line 819)
- Retry service close (`trade-retry-service.ts` ~line 356)
- Webhook close (`routes.ts` ~line 5558)
- Manual close (`routes.ts` ~line 3127)
- Position flip close (`routes.ts` ~line 6030)
- Dust cleanup retry (`routes.ts` ~line 3301, 5652)

**Resolution:** `closePerpPosition()` must receive the same Swift-first orchestration as `executePerpOrder()`. The approach:

1. Add the same `shouldUseSwift()` → `executeSwiftOrder()` → fallback logic to `closePerpPosition()`
2. Swift close orders use `reduceOnly: true` (natively supported, per Finding #5)
3. The `closePerpPosition` return type gains `executionMethod`, `fillPrice`, and `actualFee` fields
4. All callers that currently use `signal.price` as a fill estimate should use the actual `fillPrice` from the result when available (see "Fill Price Accuracy" below)

This is included in Step 4's implementation scope. Both `executePerpOrder` and `closePerpPosition` are orchestration points.

**Fill Price Accuracy (Pre-existing Issue, Swift-Amplified):**

The current codebase uses the signal price as the fill price for close orders in several places (most notably subscriber routing at `routes.ts` ~line 828: `const fillPrice = parseFloat(signal.price)`). This is inaccurate because:
- Legacy fills can slip from the signal price due to slippage
- Swift fills go through a Dutch auction and may fill at a different price

This is a pre-existing issue (not introduced by Swift), but Swift's auction mechanism makes it more important to fix. When Swift is integrated, the `closePerpPosition` result will include the actual `fillPrice` from the Swift API response or the on-chain fill. Callers should prefer this over the signal price:

```typescript
// BEFORE (current — uses signal price as estimate):
const fillPrice = parseFloat(signal.price);

// AFTER (Swift integration — uses actual fill when available):
const fillPrice = closeResult.fillPrice || parseFloat(signal.price);
```

This change is included in Step 5 (Trade Logging Updates) scope.

**What stays the same:**
- `computeTradeSizingAndTopUp` is called BEFORE `executePerpOrder` — sizing logic unchanged
- `PositionService.getPositionForExecution()` is called BEFORE close orders — position checks unchanged
- The subprocess stagger logic still applies to legacy fallback calls
- RPC failover for legacy calls is unchanged
- Profit sharing flow downstream is unchanged — it just gets the fill price from whichever method succeeded

**Verify:**
1. Set `SWIFT_ENABLED=false` → all trades use legacy subprocess (zero behavior change)
2. Set `SWIFT_ENABLED=true` with Swift API mocked to return success → trades execute via Swift
3. Set `SWIFT_ENABLED=true` with Swift API mocked to fail → trades fall back to legacy subprocess
4. Measure total latency: Swift attempt (3s timeout) + legacy fallback should complete under 5 seconds total
5. Existing webhook flow end-to-end works with `SWIFT_ENABLED=false`
6. Verify `reduceOnly: true` close orders work correctly via Swift — position should close, not open a new one
7. Verify all 4 subscriber routing trigger points work with Swift:
   - Source bot **paused** → `parseSignalForRouting()` → `routeSignalToSubscribers()` → subscribers execute via Swift
   - Source bot **auth disabled** → same routing path → subscribers execute via Swift
   - Source bot **auth expired** → same routing path → subscribers execute via Swift
   - Source bot **executes normally** → subscribers execute via Swift
   - **Retry worker success** → `registerRoutingCallback` → subscribers execute via Swift

**Gate:** All 4 execution paths (webhook, manual, subscriber, retry) AND all 4+1 routing trigger points work with both `SWIFT_ENABLED=true` and `false`. Fallback behavior is correct. `reduceOnly` close orders behave identically to legacy. No regressions on existing functionality.

---

### Step 5: Trade Logging Updates — ⬜ NOT STARTED

**What:** Record which execution method was used and Swift-specific metadata in `bot_trades`.

**Where:** `server/routes.ts` — all places that insert into `bot_trades`

**Changes:**
- When logging a trade, include `executionMethod: result.executionMethod || 'legacy'`
- When Swift was used, include `swiftOrderId`, `auctionDurationMs`, `priceImprovement`
- When Swift failed and legacy was used, include `executionMethod: 'legacy'` (the failed Swift attempt is logged in server console only — no extra DB write for failed attempts at this stage)

**Locations to update (all trade logging sites):**

`executePerpOrder` callers (open/trade orders):
1. Webhook handler trade log (`server/routes.ts` ~line 5700-5800)
2. Manual trade endpoint trade log (`server/routes.ts` ~line 3200-3400)
3. Subscriber routing open trade log (`server/routes.ts` ~line 1001)
4. Retry worker open trade log (`server/trade-retry-service.ts` ~line 484)

`closePerpPosition` callers (close orders — use `fillPrice` from result when available):
5. Subscriber routing close log (`server/routes.ts` ~line 828) — currently uses `parseFloat(signal.price)`, must use `closeResult.fillPrice || parseFloat(signal.price)`
6. Webhook close log (`server/routes.ts` ~line 5558-5600)
7. Manual close in webhook handler (`server/routes.ts` ~line 3106-3140)
8. Position flip close log (`server/routes.ts` ~line 6030-6050)
9. Dust cleanup close log (`server/routes.ts` ~line 3301, 5652)
10. Retry worker close log (`server/trade-retry-service.ts` ~line 389-495) — also update hardcoded fee (see Step 6)
11. User webhook close log (`server/routes.ts` ~line 6806)
12. Emergency close endpoint (`server/routes.ts` ~line 9080)

**Verify:**
1. Execute a trade with Swift enabled → `bot_trades` row has `execution_method = 'swift'`
2. Execute a trade with Swift disabled → `bot_trades` row has `execution_method = 'legacy'`
3. Execute a trade where Swift fails → `bot_trades` row has `execution_method = 'legacy'`
4. Dashboard trade history still displays correctly — new columns don't break existing queries

**Gate:** All trades are logged with correct execution method. No existing queries or UI broken.

---

### Step 6: Retry Service Integration — ⬜ NOT STARTED

**What:** Update trade retry service to handle Swift-specific retry behavior.

**Where:** `server/trade-retry-service.ts`

**Changes:**

When a trade is queued for retry:
- Record `originalExecMethod` (was it originally a Swift trade?)
- Initialize `swiftAttempts = 0`

When executing a retry:
- If `swiftAttempts < 2` and `isSwiftAvailable()` → try Swift
- If Swift fails on retry → increment `swiftAttempts`, try legacy
- If `swiftAttempts >= 2` → skip Swift, go straight to legacy
- Cooldown re-queue logic stays the same — Swift failures count toward cooldown eligibility

Cooldown integration specifics:
- Swift timeout errors (`classifySwiftError → 'retry_swift'`) that exhaust max attempts should trigger the existing `isTimeoutError` / `isTransientError` check for cooldown eligibility
- `cooldownRetries` counter (max 2, 2-minute delay) applies regardless of whether the original failure was Swift or legacy
- A Swift `'fallback_legacy'` error that then also fails on legacy counts as a single attempt toward the retry limit

**Fee estimation on successful retry:**
- Current retry service (trade-retry-service.ts line 461-462) hardcodes `fee = notional * 0.0005` for all successful retries
- This doesn't match the executor's 0.00045 rate AND doesn't account for Swift's gasless nature
- When a retry succeeds, use the `actualFee` from the execution result when available: `const fee = result.actualFee || notional * 0.00045;`
- This ensures Swift retries that succeed don't overestimate fees

When retry succeeds via routing callback:
- `registerRoutingCallback(routeSignalToSubscribers)` works the same regardless of execution method — no changes needed to the callback mechanism itself

**Verify:**
1. Queue a retry with Swift enabled → first retry attempts Swift
2. Force 2 Swift failures on retry → third retry goes directly to legacy
3. Cooldown re-queue still triggers after max attempts (both Swift-originated and legacy-originated failures)
4. Verify `cooldownRetries` increments correctly when Swift timeout errors exhaust normal retry attempts
5. Successful retry still triggers subscriber routing callback

**Gate:** Retry service correctly handles Swift retries, respects max Swift attempts, falls back to legacy, integrates with existing cooldown system (including `cooldownRetries` and 2-minute delay), and triggers routing callback on success.

---

### Step 7: Observability & Metrics — ⬜ NOT STARTED

**What:** Add structured metrics tracking for Swift performance. This must be in place BEFORE production activation so we can monitor from day one.

**Where:** New file `server/swift-metrics.ts`, plus a new admin endpoint

**Metrics tracked (in-memory counters, queryable via API):**
- Total Swift orders submitted
- Swift success count / failure count / fallback count
- Average latency (ms)
- Average price improvement (bps)
- Per-market breakdown
- Error type distribution

**Admin endpoint:**
```
GET /api/admin/swift-metrics
→ Returns JSON with all metrics
```

**Verify:**
1. Execute several trades → metrics endpoint shows accurate counts
2. Force a fallback → fallback counter increments
3. Metrics survive across trades within a server session
4. Metrics reset on server restart (acceptable for V1 — persistent metrics are a later enhancement)

**Gate:** Metrics are accurate and accessible. Deployed and ready before Swift is enabled in production.

---

### Step 8: Controlled Activation — ⬜ NOT STARTED

**What:** Enable Swift in production with monitoring.

**Where:** Environment variable `SWIFT_ENABLED=true`

**Activation sequence:**

```
Day 1:  Set SWIFT_ENABLED=true
        Monitor: Console logs for Swift attempts, success/failure
        Monitor: GET /api/admin/swift-metrics for real-time counters
        Watch:   First 10 trades — all should either succeed via Swift or fallback cleanly
        Check:   bot_trades table shows execution_method values

Day 2:  Review 24h of data
        Check:   Swift success rate (target: >90%)
        Check:   Fallback rate (target: <10%)
        Check:   No increase in failed trades vs pre-Swift baseline
        Check:   Trade latency hasn't degraded significantly
        Check:   Per-market metrics via /api/admin/swift-metrics

Day 3:  If stable, consider this the baseline
        If issues: Set SWIFT_ENABLED=false (instant rollback, no code change)

Week 2: Review per-market Swift performance
        Identify any markets with consistently low fill rates
        Review RPC usage patterns — should see reduction in Helius calls
```

**Emergency rollback:** Set `SWIFT_ENABLED=false` → immediate return to legacy-only, no code deployment needed.

**Verify:**
1. Production trades execute via Swift successfully
2. Fallback works when Swift API has issues
3. No increase in trade failures
4. Metrics endpoint shows accurate data from live trades
5. Console logging provides clear visibility into execution path

**Gate:** 48 hours of stable Swift execution in production with >90% Swift success rate and clean fallback behavior, validated by metrics data.

---

### Step 9: Builder Code Registration (Optional — Revenue) — ⬜ NOT STARTED

**What:** Register QuantumVault as a Drift Builder to earn fees on Swift trades.

**Where:** Drift Builder Code program (on-chain registration, one-time)

**Requirements:**
- Register a builder code with Drift Protocol
- Add `builderIdx` and `builderFee` to Swift order submissions in `swift-executor.ts`
- Builder fees are paid by the protocol, not the user — no impact on user fill prices

**Verify:**
1. Confirm builder registration on-chain
2. Verify builder fee appears in Swift order submissions
3. Check builder fee revenue accrual on Drift

**Gate:** Builder code registered, fees flowing. This step is optional and can be deferred.

---

## 9. Security V3 Compatibility

Swift signing uses the **same agent keypair** as legacy transaction signing. The key access path is identical:

**For webhook/manual trades (UMK path):**
```
Session → UMK → derive key_privkey → decrypt agentPrivateKeyEncryptedV3 → agent keypair → sign Swift message
```

**For subscriber routing (legacy path):**
```
agentPrivateKeyEncrypted → decrypt with AGENT_ENCRYPTION_KEY → agent keypair → sign Swift message
```

**What stays the same:**
- `policyHmac` verification happens BEFORE `executePerpOrder` is called — Swift changes nothing here
- `emergencyStopTriggered` check happens BEFORE trade execution — Swift changes nothing here
- `executionActive` check on the bot happens BEFORE trade execution — Swift changes nothing here
- The decrypted `privateKeyBase58` is passed to `executeSwiftOrder()` the same way it's passed to the subprocess

**Verification gate (applies to Step 4):**
- Confirm Swift trades respect emergency stop — trigger emergency stop, verify Swift trade is blocked
- Confirm Swift trades respect `executionActive: false` — disable execution, verify Swift trade is blocked
- Confirm Swift trades verify `policyHmac` — tamper with bot config, verify trade is rejected
- Confirm subscriber routing uses legacy key path for Swift signing — not UMK (subscribers have no session)

---

## 10. Audit Findings Coverage Map

This section maps every finding from the v3.0 audit to a specific step in this integration plan. An external auditor can use this to verify completeness.

| # | Audit Finding | Covered In | How Addressed |
|---|---------------|------------|---------------|
| 1 | Decoupled subscriber routing (4 trigger points) | Step 4 (verify gate #7) | All 5 routing entry points explicitly verified: paused, auth disabled, auth expired, normal, retry callback. Swift works identically at all points because it's inside `executePerpOrder()` which all paths call. |
| 2 | Unified trade sizing (`computeTradeSizingAndTopUp`) | Step 4 (critical rules) | Explicitly stated: sizing is called BEFORE `executePerpOrder`. Swift does NOT bypass it. No changes to sizing logic. |
| 3 | PositionService for close verification | Step 4 (critical rules) | Explicitly stated: `PositionService.getPositionForExecution()` is called BEFORE close orders. Swift does NOT bypass it. No changes to position service. |
| 4 | All perp markets support Swift | Step 2 (config) | No market allowlist. `shouldUseSwift()` returns true for all markets. No tiering. |
| 5 | Reduce-only natively supported | Step 4 (verify gate #6) | `reduceOnly` flag passed through to Swift order params. Explicit verification gate confirms close-only behavior. |
| 6 | Cooldown retry system | Step 6 (cooldown specifics) | Swift failures map to existing `isTimeoutError`/`isTransientError`. `cooldownRetries` applies to both Swift and legacy failures. Explicit verify gates #3-4. |
| 7 | Subprocess architecture decision | Section 7 (Architecture Decision) | Swift in main process, legacy subprocess untouched as fallback. `drift-executor.mjs` not modified. |
| 8 | SDK has built-in Swift methods | Step 3 (implementation details) | Uses `@drift-labs/sdk` built-in methods for message encoding/signing. No custom HTTP client for message building. |
| 9 | Builder Codes revenue opportunity | Step 9 (optional) | Deferred to after stable activation. Does not block core integration. |
| 10 | Latency budget gap | Step 2 (config: 3000ms), Step 4 (verify gate #4) | Swift timeout set to 3000ms (not 5000ms). Total Swift + fallback must complete under 5 seconds. |
| 11 | Subscriber batch efficiency | Step 4 (routing verification) | `isSwiftAvailable()` checked at entry of each subscriber execution. If Swift health degrades mid-batch, remaining subscribers fall back immediately via health state. |
| 12 | Database schema — no Swift fields exist | Step 1 (schema migration) | Adds `executionMethod`, `swiftOrderId`, `auctionDurationMs`, `priceImprovement` to `bot_trades`. Adds `swiftAttempts`, `originalExecMethod` to `trade_retry_queue`. Audit log table deferred — traceability via `executionMethod` + console logs for V1. |

### Schema Decision Justification

The migration plan v3.0 proposed additional fields that this plan omits. Here's why:

| Proposed Field | Decision | Reasoning |
|----------------|----------|-----------|
| `swift_enabled` per bot | Omitted | Swift is a platform optimization, not a per-bot feature. Global env var toggle is simpler and more reliable. |
| `swift_status` on bot_trades | Omitted | The `executionMethod` column tells us whether Swift was used. The Swift API response status is logged to console. Add if debugging requires it. |
| `swift_submitted_at` / `swift_filled_at` | Omitted | `executed_at` already exists. Auction duration is captured in `auctionDurationMs`. Sub-second timing not needed for V1. |
| `fallback_reason` on bot_trades | Omitted | Fallback reasons are logged to console with full context. DB column adds schema complexity without clear V1 benefit. |
| `keeper_pubkey` on bot_trades | Omitted | Keeper identity is informational only. No V1 use case requires querying by keeper. |
| `swift_order_logs` table | Deferred | Full audit log table adds schema complexity. Console logs + `executionMethod` on `bot_trades` provide sufficient traceability for V1. Add when debugging requires queryable audit trail. |

---

## 11. File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `shared/schema.ts` | Modify | Add Swift columns to `botTrades` and `tradeRetryQueue` |
| `server/swift-config.ts` | **New** | Swift configuration, health monitoring, error classification |
| `server/swift-executor.ts` | **New** | Swift order signing, submission, and result parsing |
| `server/swift-metrics.ts` | **New** | In-memory metrics tracking |
| `server/drift-service.ts` | Modify | Add Swift-first logic to both `executePerpOrder()` and `closePerpPosition()` |
| `server/routes.ts` | Modify | Pass `executionMethod` when logging trades, add metrics endpoint |
| `server/trade-retry-service.ts` | Modify | Add Swift retry tracking and fallback logic |

**Files NOT modified:**
| File | Reason |
|------|--------|
| `server/drift-executor.mjs` | Legacy subprocess stays untouched — it's the fallback |
| `server/position-service.ts` | Position checks happen upstream, no Swift-specific changes |
| `server/routes.ts` (routing logic) | `routeSignalToSubscribers` calls `executePerpOrder` — the Swift logic is inside that function, so routing just works |
| Client/frontend files | No UI changes needed for V1 — `executionMethod` can be shown in trade history later |

---

## 12. Risk Summary

| Risk | Mitigation |
|------|------------|
| Swift API goes down | Automatic fallback to legacy subprocess — instant, no human intervention |
| Swift increases latency | 3-second timeout ensures fallback fires quickly. Total worst-case: ~5-6 seconds |
| Swift signs incorrect order | Same keypair and order params as legacy — the signing input is identical |
| Schema migration breaks existing data | Columns are additive (nullable or with defaults) — no existing data modified |
| Swift + legacy both fail | Same outcome as today when legacy fails — trade goes to retry queue |
| `SWIFT_ENABLED` accidentally set wrong | Defaults to `false` — must be explicitly enabled. Set to `false` for instant rollback |
| Position flat during flip | Close-then-open creates a flat window. Swift's async nature may widen this gap vs legacy. Accepted risk — retry service handles failed opens. Same behavior as legacy, not a regression. |

---

## 13. What This Plan Does NOT Cover (Future Work)

These are explicitly deferred to keep the initial integration focused:

1. **Per-bot Swift toggle in UI** — Not needed for V1. Swift is a platform-level optimization.
2. **Swift-only mode (disable legacy)** — Only after months of proven Swift stability.
3. **Spot market Swift support** — Not confirmed live yet. Add when Drift announces.
4. **Swift audit log table** — Add if debugging requires more granularity than `bot_trades.executionMethod` provides.
5. **Frontend execution method display** — Nice-to-have, add to trade history table later.
6. **Persistent metrics (DB-backed)** — In-memory metrics are fine for V1. Persist if needed for historical analysis.
7. **Partial fill handling** — Swift typically fills fully for the order sizes QuantumVault uses. Handle if it becomes an issue in practice.

---

## 14. Dependencies & Prerequisites

Before starting Step 1:

- [ ] Drift SDK version supports Swift methods (`encodeSwiftOrderParamsMessage`, `signSignedMsgOrderParamsMessage`)
  - **Check:** `npm list @drift-labs/sdk` and verify version includes Swift support
- [ ] Swift API endpoint (`https://swift.drift.trade`) is accessible from production server
  - **Check:** `curl -s https://swift.drift.trade/health` returns a response
- [ ] Subscriber routing fix is deployed to production (currently blocked)
  - **Reason:** Steps 4-6 need subscriber routing working to verify end-to-end
- [ ] External audit of this plan is complete

---

## 15. Timeline Estimate

| Step | Effort | Dependencies |
|------|--------|--------------|
| Step 1: Schema migration | 1 hour | None |
| Step 2: Config module | 2-3 hours | None |
| Step 3: Swift executor | 1-2 days | SDK version verified |
| Step 4: executePerpOrder wrapper | 1 day | Steps 1-3 |
| Step 5: Trade logging | 2-3 hours | Step 4 |
| Step 6: Retry integration | 3-4 hours | Step 4 |
| Step 7: Metrics | 3-4 hours | Steps 4-6 (must be ready before activation) |
| Step 8: Controlled activation | 2-3 days monitoring | Steps 1-7 deployed |
| Step 9: Builder codes | 1-2 hours | Step 8 stable |

**Total development:** ~4-5 days of implementation + 3 days of monitoring  
**Total elapsed:** ~2 weeks including buffer and monitoring

---

# Part 4: External Auditor Responses

---

## 16. External Auditor Responses

**Audit Source:** External code review, February 2026  
**Scope:** Review of migration plan against production codebase (`server/drift-executor.mjs`, `shared/schema.ts`, etc.)

### Response 1: Reduce-Only Race Condition

**Auditor concern:** The "check-then-submit" pattern in `executeSwiftClose` introduces a race condition between position fetch and order submission.

**Response:** This concern is valid for the code shown in the v2.0 plan, but has been resolved. Our v3.0 audit (Finding #5) confirmed that **Swift natively supports the `reduceOnly` flag** with identical semantics to legacy orders. The "check-then-submit" pattern was proposed when we were uncertain about Swift's reduce-only support. It is NOT part of the implementation plan.

The actual flow for close orders:
1. `PositionService.getPositionForExecution()` checks if a position exists (determines IF we need to close)
2. If position exists, `executePerpOrder()` is called with `reduceOnly: true`
3. Swift order includes `reduceOnly: true` in the order params — the protocol enforces it

No race condition exists because `reduceOnly` is enforced at the protocol level, not via a client-side size check.

### Response 2: Subaccount SDK Workaround

**Auditor concern:** `drift-executor.mjs` contains a critical workaround for `subAccountId > 0` where it manually fetches User account data because SDK websocket subscriptions fail. Does Swift need this same workaround?

**Response:** No. The Swift execution path does NOT require full DriftClient subscription. Here's why:

| Operation | Legacy (drift-executor.mjs) | Swift (swift-executor.ts) |
|-----------|---------------------------|---------------------------|
| DriftClient subscription | Required (full account data needed for tx building) | NOT required |
| User account data | Needed for remaining accounts in transaction | NOT needed — Swift message only needs order params |
| Subaccount workaround | Required (lines 1180-1220 in drift-executor.mjs) | NOT required |
| What's needed | Full SDK setup with market subscriptions | Keypair for signing + getSlot() for slot number |

Swift signing requires:
- The agent keypair (for message signing — Ed25519, same as transaction signing)
- The current Solana slot (1 lightweight RPC call)
- Order parameters (market index, direction, size, reduce-only, etc.)

It does NOT require:
- DriftClient `subscribe()` call
- User account data loading
- Market data subscriptions
- The subaccount workaround

The subaccount workaround only exists because `placeAndTakePerpOrder` needs remaining accounts derived from the User account. Swift bypasses this entirely because the keeper (market maker) builds the on-chain transaction, not our client.

**However:** If Swift fails and we fall back to legacy, the legacy subprocess (`drift-executor.mjs`) still uses its existing workaround. No change needed there.

### Response 3: Execution Orchestrator Pattern

**Auditor concern:** There is no "orchestrator" layer in the current code that can switch between Swift and Legacy methods. You need to refactor `executeTrade`.

**Response:** This is exactly what Step 4 of the integration plan implements. The approach:

- `executePerpOrder()` in `server/drift-service.ts` becomes the orchestrator
- It tries Swift first (via `executeSwiftOrder()` in the new `server/swift-executor.ts`)
- If Swift fails with a `fallback_legacy` classification, it proceeds to the existing subprocess spawn
- The existing `drift-executor.mjs` is NOT modified — it remains the legacy fallback path
- The function signature of `executePerpOrder()` does NOT change — all callers are unaffected

The auditor's suggestion to rename `executeTrade` to `executeLegacyTrade` is not needed because the legacy path already lives in a separate subprocess (`drift-executor.mjs`). The orchestration happens at the `executePerpOrder()` level in the main process.

### Response 4: Fee Calculation for Swift Trades

**Auditor concern:** The current code estimates fees as `notional * 0.00045` and deducts gas. If Swift trades have different fee structures (no gas, potentially different taker fees), PnL calculations and profit sharing will be incorrect.

**Response:** Valid concern. This needs to be addressed in the implementation. Here's the plan:

**Gas fees:** Swift trades are gasless (keeper pays gas). The fee estimation should NOT include gas for Swift trades. The `executionMethod` field on the trade result allows downstream code to conditionally include/exclude gas estimates.

**Taker fees:** Swift Dutch auction fills may have different effective fees than direct AMM fills. However, Drift protocol fees are set at the protocol level per user tier, not per execution method. The taker fee rate should be the same for Swift and legacy.

**Implementation change (added to Step 4):**
- The `SwiftOrderResult` includes `actualFee` from the Swift API response when available
- When Swift is used, the fee returned is the Swift-reported fee (or estimated from the same formula minus gas)
- Profit sharing uses the fee from the trade result, regardless of execution method
- No gas fee deduction for Swift trades since the keeper pays gas

**Impact:** This is a refinement within Step 4's implementation, not a structural change. The existing profit sharing flow already uses the fee from the trade result — it just needs the Swift result to report the correct fee.

### Response 5: Subscriber Key Signing Format

**Auditor concern:** The plan assumes Swift signing uses the same key format as legacy transactions. If Swift requires a different signer interface (off-chain message signer vs transaction signer), subscriber keys might need a different adapter.

**Response:** Both operations use Ed25519 signing. The difference is what's being signed:

| Aspect | Legacy Transaction | Swift Message |
|--------|-------------------|---------------|
| Key type | Ed25519 (Solana Keypair) | Ed25519 (same Keypair) |
| What's signed | Serialized Solana Transaction | Serialized Swift OrderParams message |
| Signing function | `Transaction.sign(keypair)` | `driftClient.signSignedMsgOrderParamsMessage(message)` |
| Key format | `Keypair.fromSecretKey(bs58.decode(privateKeyBase58))` | Same — `Keypair.fromSecretKey(bs58.decode(privateKeyBase58))` |

The subscriber's `agentPrivateKeyEncrypted` is decrypted to a `privateKeyBase58` string, which is then used to create a `Keypair`. This `Keypair` is used for both legacy transaction signing and Swift message signing. No adapter needed.

The Drift SDK's `signSignedMsgOrderParamsMessage` internally uses the same `Keypair` that `DriftClient` is initialized with. The key loading path is identical for both execution methods.

---

## External Code Review #2 (February 9, 2026)

**Audit Source:** External automated code review (Codex 5.2), February 2026
**Scope:** Comparison of migration plan against live codebase for implementation readiness

### Review Summary

The review identified 5 items by comparing the plan's described architecture against the current production code. Three of these are expected pre-implementation gaps (the plan describes work that hasn't been done yet). Two required plan updates:

| # | Finding | Status | Action |
|---|---------|--------|--------|
| 1 | Schema changes not in current schema | Expected | Step 1 adds these columns. No schema changes should exist before implementation begins. |
| 2 | `executePerpOrder` has no Swift branch | Expected | Step 4 adds the Swift branch. This is the core implementation step. |
| 3 | `closePerpPosition` bypasses `executePerpOrder` | **Valid — Plan Updated** | `closePerpPosition()` is a separate function with its own execution path. Step 4 updated to cover both orchestration points. See "closePerpPosition Coverage (V4.1)" in Step 4. |
| 4 | Subscriber-close PnL uses signal price, not actual fill | **Valid — Pre-existing issue** | Not Swift-specific, but Swift amplifies it. Step 4 updated with "Fill Price Accuracy" section. Step 5 scope includes using actual fill prices. |
| 5 | Retry logic not Swift-aware | Expected | Step 6 adds Swift error classification and Swift retry counters. |

### Response to Finding 3: closePerpPosition Separate Execution Path

The reviewer correctly identified that `closePerpPosition()` has its own independent SDK/subprocess flow — it does NOT call `executePerpOrder()`. This means Swift integration at `executePerpOrder()` alone would leave all close orders on legacy.

**Resolution:** Step 4 has been updated (V4.1) to explicitly include `closePerpPosition()` as a second orchestration point. Both functions will receive the `shouldUseSwift() → executeSwiftOrder() → fallback` pattern. All 6 call sites for `closePerpPosition` are documented in Step 4.

### Response to Finding 4: Signal Price vs Fill Price

The reviewer correctly identified that subscriber routing uses `parseFloat(signal.price)` as the fill price for PnL calculations, regardless of actual execution fill price. This is inaccurate today (legacy fills can slip) and will be more inaccurate with Swift (auction fills).

**Resolution:** Step 4 now includes a "Fill Price Accuracy" section. When Swift (or enhanced legacy) returns an actual `fillPrice`, callers should use it: `closeResult.fillPrice || parseFloat(signal.price)`. This is included in Step 5's scope for trade logging updates.

**Note:** This is a pre-existing accuracy issue, not a Swift regression. Fixing it during Swift integration is a natural improvement.

### Response to Findings 1, 2, 5: Expected Pre-Implementation State

These findings describe work that the integration plan explicitly schedules:
- **Finding 1 (Schema):** Step 1 is "Database Schema Migration" — adding `executionMethod`, `swiftOrderId`, etc.
- **Finding 2 (Swift branch):** Step 4 is "Integration Point — executePerpOrder Wrapper" — adding the Swift-first orchestration
- **Finding 5 (Retry logic):** Step 6 is "Retry Service Integration" — adding Swift error classification

These columns/branches/classifications intentionally do not exist in the current codebase. The plan is a pre-implementation document awaiting audit approval before any code changes begin. The absence of these changes confirms the plan accurately describes what needs to be built.

---

## External Code Review #3 (February 9, 2026)

**Audit Source:** External automated code review (ChatGPT), February 2026
**Scope:** Second pass comparison of migration plan against live codebase

### Review Summary

This review identified 8 items. **7 of 8 are duplicates of findings already addressed in v4.0/v4.1.** One new item was identified regarding slippage tracking schema alignment.

| # | Finding | Status | Already Addressed In |
|---|---------|--------|---------------------|
| 1 | Fee model mismatch (gasless vs current fee accounting) | Duplicate | v4.0 — External Auditor Response #4 (Fee Calculation) |
| 2 | Close paths bypass `executePerpOrder` | Duplicate | v4.1 — closePerpPosition Coverage section in Step 4 |
| 3 | Swift error classification missing from retry service | Duplicate | v4.1 — External Code Review #2, Finding #5 → Step 6 |
| 4 | `executePerpOrder` only has SDK/subprocess paths | Duplicate | v4.1 — External Code Review #2, Finding #2 → Step 4 |
| 5 | PnL uses estimates not actual fills | Duplicate | v4.1 — Fill Price Accuracy section in Step 4 |
| 6 | Subaccount subscription quirks could break Swift | Duplicate | v4.0 — External Auditor Response #2 (Subaccount SDK Workaround) |
| 7 | Subscriber routing has multiple entry points | Duplicate | Step 4 verify criteria — all 4+1 routing trigger points explicitly listed |
| 8 | Schema for slippage tracking not in place | **New — Noted** | See response below |

### Response to Finding 8: PnL Refinement Schema Alignment

A separate `docs/pnl-refinement-plan.md` describes future schema fields (`actualFillPrice`, `slippageBps`, `slippageAmount`, `expectedPrice`) that are not yet in the schema. The reviewer notes that Swift will surface this data (fill price, price improvement) and it should be stored.

**Response:** This is a valid forward-looking observation. The Swift schema additions in Step 1 already include `priceImprovement` (decimal). The `fillPrice` from Swift responses will be stored via the existing `price` column in `bot_trades`. However, the PnL refinement plan's additional fields (`slippageBps`, `slippageAmount`, `expectedPrice`) are out of scope for the Swift migration — they belong to a separate improvement initiative.

**Recommendation:** After Swift integration is stable, the PnL refinement schema can be implemented as a follow-on. Swift will make this easier because it provides actual fill data instead of oracle estimates. This is noted in Section 13 ("What This Plan Does NOT Cover") as future work.

### Note on Duplicate Findings

Seven of eight findings in this review were previously identified and addressed. This indicates the plan's documentation of prior reviews is comprehensive — auditors can verify that each concern has a documented response by checking the External Auditor Responses section (Part 4) and External Code Review #2 above.

---

# Part 5: Appendices

---

## 17. Appendix A: Swift API Reference

**Endpoint:** `https://swift.drift.trade`

**Request:**
```json
POST /orders
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

---

## 18. Appendix B: Error Code Reference

| Code | Description | Retryable | Fallback |
|------|-------------|-----------|----------|
| 400 | Invalid parameters | No | No |
| 401 | Invalid signature | No | No |
| 429 | Rate limited | Yes | No |
| 503 | No liquidity | Yes | Yes |
| 504 | Auction timeout | Yes | Yes |
| STALE_SLOT | Order expired | Yes | No |
| PARTIAL_FILL | Partially filled | N/A | Queue remainder |

---

## 19. Appendix C: SDK Methods

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

---

## 20. Appendix D: Configuration Reference

```typescript
// Environment variables
SWIFT_ENABLED=true                          // Global toggle
SWIFT_API_URL=https://swift.drift.trade     // API endpoint
SWIFT_ORDER_TIMEOUT_MS=3000                 // Order submission timeout (aggressive for fallback budget)
SWIFT_HEALTH_CHECK_INTERVAL_MS=30000        // Health check frequency
SWIFT_MAX_RETRIES_BEFORE_FALLBACK=2         // Max Swift retries before legacy
```

---

## 21. Appendix E: Database Migration Script

```sql
-- Migration: Add Swift support fields
-- Run with: npm run db:push

-- 1. bot_trades additions
ALTER TABLE bot_trades
ADD COLUMN IF NOT EXISTS execution_method VARCHAR(20) DEFAULT 'legacy' NOT NULL,
ADD COLUMN IF NOT EXISTS swift_order_id VARCHAR(64),
ADD COLUMN IF NOT EXISTS auction_duration_ms INTEGER,
ADD COLUMN IF NOT EXISTS price_improvement DECIMAL(10, 4);

-- 2. trade_retry_queue additions
ALTER TABLE trade_retry_queue
ADD COLUMN IF NOT EXISTS original_execution_method VARCHAR(20) DEFAULT 'legacy',
ADD COLUMN IF NOT EXISTS swift_attempts INTEGER DEFAULT 0;
```

---

## 22. Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-21 | Engineering | Initial draft |
| 2.0 | 2026-01-26 | Engineering | Comprehensive gap analysis, all 4 execution paths, profit sharing, retry service, security V3, Swift limitations, observability, testing plan |
| 3.0 | 2026-02-09 | Engineering + AI Audit | Codebase audit: decoupled routing, computeTradeSizingAndTopUp, PositionService, all-market support, SDK methods, cooldown retries, subprocess architecture, Builder Codes |
| 4.0 | 2026-02-09 | Engineering | Merged research + integration plan into single document; added external auditor responses; corrected reduce-only, subaccount, fee calculation, and key signing sections |
| 4.1 | 2026-02-09 | Engineering | Addressed Codex 5.2 code review: added closePerpPosition Swift coverage to Step 4; added fill price accuracy section; documented 5 review findings with responses |
| 4.2 | 2026-02-09 | Engineering | Addressed ChatGPT code review: 7/8 findings confirmed as duplicates of v4.0/v4.1; 1 new finding (PnL refinement schema alignment) noted as future work |
| 4.3 | 2026-02-09 | Engineering (Internal Audit) | Internal audit: clarified DriftClient initialization for Swift signing; added getSlot failure handling; listed all closePerpPosition callers; updated retry fee calculation; added position flip timing as accepted risk |

---

**Document Maintained By:** Engineering Team  
**Last Updated:** February 9, 2026  
**Next Review:** Before implementation kickoff  
**Status:** Ready for External Audit — Single Source of Truth

---

## 23. Post-Implementation Cleanup Checklist

When all 10 implementation steps are completed and validated in production:

- [ ] All 10 steps marked as COMPLETED in this document
- [ ] Swift is running in production with `SWIFT_ENABLED=true`
- [ ] Monitoring confirms Swift success rate > 90% for at least 48 hours
- [ ] Legacy fallback is working correctly for any Swift failures
- [ ] Remove the "Active Implementation Directive — Swift Protocol Migration" section from `replit.md`
- [ ] Update `replit.md` System Architecture to reflect Swift as the primary execution method
- [ ] Move this document to `docs/archive/` or mark status as "COMPLETED"

This ensures `replit.md` doesn't permanently reference this plan after it's been fully implemented, keeping the agent's session context clean for future work.

# PnL Refinement Plan

## Overview

This document outlines the plan to refine PnL (Profit and Loss) calculations in QuantumVault to account for trading fees, slippage, funding payments, and price discrepancies. The goal is to provide users with accurate, transparent performance metrics.

---

## Current State

### What We Track

| Component | Location | Method |
|-----------|----------|--------|
| **Unrealized PnL** | `position-service.ts` | `(markPrice - entryPrice) × size` from on-chain data |
| **Realized PnL** | `bot_positions.realizedPnl` | Accumulated when positions close |
| **Trading Fees** | `bot_positions.totalFees` | Sum of fees from each trade |
| **Entry Price** | `bot_positions.avgEntryPrice` | Weighted average from trades |
| **Fill Price** | `drift-executor.mjs` | Estimated from oracle price at execution time |

### What We Don't Track

| Component | Impact | Notes |
|-----------|--------|-------|
| **Funding Payments** | Can be significant over time | Perpetuals accrue funding every hour |
| **Actual Fill Price** | Affects realized PnL accuracy | Currently using oracle estimate, not tx fill |
| **Slippage** | Hidden cost not surfaced to user | Difference between expected and actual fill |
| **Settlement vs Display Price** | Confuses unrealized PnL | Oracle price (settlement) vs mark price (display) |

### Known Discrepancies

Dashboard shows:
- Net P&L: -$0.01
- Cumulative Chart PnL: +$1.40
- Unrealized P&L: -$0.54

Possible causes:
1. Fees tracked but not subtracted from displayed totals
2. Chart shows realized only, dashboard shows net (realized + unrealized)
3. Funding payments affecting on-chain equity but not tracked locally

---

## Proposed Improvements

### Phase 1: Fee Integration (Priority: High)

**Objective**: Ensure displayed PnL correctly subtracts accumulated fees.

**Changes**:
1. Update dashboard calculation: `Net PnL = realizedPnl + unrealizedPnl - totalFees`
2. Add fee breakdown to bot stats display
3. Show per-trade fee in trade history

**Files to modify**:
- `client/src/components/BotCard.tsx` - Display logic
- `server/routes.ts` - API response calculation
- `client/src/pages/AppPage.tsx` - Dashboard totals

**Complexity**: Low
**Risk**: Low

---

### Phase 2: Funding Payment Tracking (Priority: High)

**Objective**: Track hourly funding payments that affect position profitability.

**Background**:
- Drift perpetuals settle funding every hour
- Longs pay shorts (or vice versa) based on funding rate
- Can significantly impact PnL over multi-day positions

**Implementation Options**:

#### Option A: Periodic Funding Fetch
- Add scheduled job to fetch funding history from Drift
- Store in new `funding_payments` table
- Aggregate into position PnL

#### Option B: On-Position-Close Calculation
- When closing a position, calculate total funding paid/received
- Use Drift's historical funding API
- Add to realized PnL calculation

**Drift API for funding**:
```
GET /fundingPayments?userAccount={pubkey}&subAccountId={id}
```

**New table schema**:
```typescript
fundingPayments: pgTable("funding_payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").notNull(),
  market: varchar("market").notNull(),
  fundingRate: varchar("funding_rate").notNull(),
  paymentAmount: varchar("payment_amount").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
})
```

**Complexity**: Medium
**Risk**: Low

---

### Phase 3: Actual Fill Price Parsing (Priority: Medium)

**Objective**: Get precise execution prices from transaction logs instead of oracle estimates.

**Current approach** (`drift-executor.mjs`):
```javascript
fillPrice = oracleData?.price?.toNumber() / 1e6;
```

**Proposed approach**:
1. After transaction confirmation, parse transaction logs
2. Extract `OrderFillEvent` from Drift program logs
3. Use actual `quoteAssetAmountFilled / baseAssetAmountFilled` for precise price

**Order fill event contains**:
- `baseAssetAmountFilled`: Actual size filled
- `quoteAssetAmountFilled`: Actual quote amount (USDC)
- `takerFee`: Actual fee charged
- `makerFee`: Maker rebate (if applicable)

**Implementation**:
```typescript
async function parseOrderFill(signature: string): Promise<{
  fillPrice: number;
  baseFilled: number;
  quoteFilled: number;
  fee: number;
}> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  
  // Parse Drift program logs for OrderFillEvent
  const logs = tx?.meta?.logMessages || [];
  // ... extract fill data from logs
}
```

**Complexity**: Medium-High
**Risk**: Medium (parsing can be fragile across SDK versions)

---

### Phase 4: Slippage Tracking (Priority: Low)

**Objective**: Track and display slippage per trade for transparency.

**Definition**: `slippage = actualFillPrice - expectedPrice`

**Implementation**:
1. Record expected price (oracle at signal time) in webhook handler
2. Compare to actual fill price after execution
3. Store slippage amount in trades table
4. Display in trade history and aggregate in stats

**Schema addition**:
```typescript
// Add to trades table
expectedPrice: varchar("expected_price"),
actualPrice: varchar("actual_price"),
slippageAmount: varchar("slippage_amount"),
slippagePercent: varchar("slippage_percent"),
```

**Complexity**: Medium
**Risk**: Low

---

### Phase 5: Oracle vs Mark Price Clarity (Priority: Low)

**Objective**: Clarify which price is used where and why values might differ.

**Context**:
- **Mark Price**: Used for display, based on order book
- **Oracle Price**: Used for settlement, funding, liquidations

**Changes**:
1. Add tooltip explaining price sources
2. Show both prices in position details
3. Document why unrealized PnL might differ from settled PnL

**Complexity**: Low
**Risk**: None

---

## Data Model Changes

### New Tables

```typescript
// Funding payments tracking
fundingPayments: pgTable("funding_payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").notNull().references(() => tradingBots.id),
  market: varchar("market").notNull(),
  fundingRate: varchar("funding_rate").notNull(),
  paymentAmount: varchar("payment_amount").notNull(),
  positionSide: varchar("position_side").notNull(), // LONG or SHORT
  positionSize: varchar("position_size").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
})
```

### Schema Modifications

```typescript
// Add to existing trades table
trades: {
  // ... existing columns
  expectedPrice: varchar("expected_price"),
  actualFillPrice: varchar("actual_fill_price"),
  slippageAmount: varchar("slippage_amount"),
  slippageBps: integer("slippage_bps"), // basis points
}

// Add to existing bot_positions table
botPositions: {
  // ... existing columns
  totalFundingPaid: varchar("total_funding_paid").default("0"),
  totalFundingReceived: varchar("total_funding_received").default("0"),
}
```

---

## API Changes

### Updated Endpoints

**GET /api/bots/:id/position**
```json
{
  "position": {
    "unrealizedPnl": -0.54,
    "realizedPnl": 1.40,
    "totalFees": 0.27,
    "totalFunding": -0.08,
    "netPnl": 0.51
  }
}
```

**GET /api/bots/:id/stats**
```json
{
  "stats": {
    "totalPnl": 0.51,
    "grossPnl": 0.86,
    "totalFees": 0.27,
    "totalFunding": -0.08,
    "avgSlippageBps": 12,
    "winRate": 0.50
  }
}
```

---

## Implementation Order

1. **Phase 1: Fee Integration** (1-2 hours)
   - Quick win, ensures fees are properly deducted from displayed PnL
   
2. **Phase 2: Funding Tracking** (4-6 hours)
   - High impact for users holding positions overnight
   - Requires new table and scheduled job

3. **Phase 3: Actual Fill Price** (3-4 hours)
   - Improves accuracy of realized PnL
   - Depends on stable transaction parsing

4. **Phase 4: Slippage Tracking** (2-3 hours)
   - Transparency feature
   - Requires schema migration

5. **Phase 5: Price Clarity** (1 hour)
   - UI/UX improvement
   - No backend changes

---

## Testing Plan

### Unit Tests
- Verify PnL calculation with fees subtracted
- Verify funding aggregation logic
- Verify slippage calculation

### Integration Tests
- Execute trade and verify fill price parsing
- Verify funding payment fetch from Drift API
- End-to-end PnL calculation with all components

### Manual Testing
- Compare dashboard PnL to on-chain account equity
- Verify funding payments match Drift UI
- Check slippage against expected values

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Transaction parsing breaks with SDK update | Fill prices become inaccurate | Version lock SDK, add fallback to oracle price |
| Funding API rate limits | Missing funding data | Implement backoff, cache responses |
| Historical data migration | Old positions missing data | Only apply to new trades/positions |
| Performance impact from extra API calls | Slower trade confirmation | Async post-trade processing |

---

## Success Metrics

1. **Dashboard PnL matches on-chain equity** (within 0.1% for active positions)
2. **Trade history shows accurate per-trade PnL** including fees
3. **Users can see funding payment impact** on long-held positions
4. **Slippage is visible** and averages under 50bps

---

## Notes

- All monetary values stored as strings to preserve decimal precision
- Use `Decimal.js` for all PnL calculations to avoid floating point errors
- Funding payments are denominated in USDC
- Slippage can be negative (price improvement) or positive (worse fill)

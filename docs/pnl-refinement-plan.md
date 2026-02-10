# PNL REFINEMENT PLAN

## Overview

Plan to refine PnL (Profit and Loss) calculations in QuantumVault to account for funding payments, slippage, and fill price accuracy. The goal is to give users accurate, transparent performance metrics that match what they see on-chain.

---

## Current State

### What We Track

| Component | Where | How |
|-----------|-------|-----|
| Unrealized PnL | `server/position-service.ts` | `(markPrice - entryPrice) × size` from on-chain data via `decodeUser` |
| Realized PnL | `bot_positions.realizedPnl` | Accumulated when positions close |
| Trading Fees | `bot_positions.totalFees` | Sum of taker/maker fees from each trade |
| Entry Price | `bot_positions.avgEntryPrice` | Weighted average from executed trades |
| Fill Price | `server/swift-executor.ts` / `server/routes.ts` | Swift returns auction fill price; legacy uses oracle estimate |
| PnL Snapshots | `pnl_snapshots` table | Periodic snapshots for marketplace signal performance |

### What We Don't Track

| Component | Impact | Notes |
|-----------|--------|-------|
| Funding Payments | Significant over multi-hour holds | Perpetuals accrue funding every hour on Drift |
| Slippage | Hidden cost not surfaced to user | Difference between signal price and actual fill |
| Oracle vs Mark Price | Can confuse unrealized PnL display | Oracle (settlement) vs mark (display) differ slightly |

### What's Already Handled

- **Fee integration**: Fees are tracked per trade and displayed in bot stats (`totalFees`, `realizedPnl`)
- **Swift fill prices**: Swift Protocol returns actual auction fill prices, giving accurate execution data for most trades
- **Net PnL calculation**: Routes already compute `realizedPnl` and `totalFees` separately for display
- **Portfolio snapshots**: `server/portfolio-snapshot-job.ts` captures periodic equity snapshots

---

## Remaining Improvements

### Phase 1: Funding Payment Tracking (Priority: High)

**Why it matters**: Drift perpetuals settle funding every hour. If you're long and funding is negative, you're quietly losing money that never shows up on the dashboard. For positions held more than a few minutes, this can add up.

**Approach — On Position Close**:
When a position closes, fetch the total funding paid/received during that position's lifetime from the Drift data API and include it in the realized PnL breakdown.

**Drift data API endpoint**:
```
GET https://data.api.drift.trade/fundingPayments?userAccount={pubkey}&subAccountId={id}
```

**Schema addition**:
```typescript
fundingPayments: pgTable("funding_payments", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  tradingBotId: varchar("trading_bot_id").notNull(),
  market: varchar("market").notNull(),
  fundingRate: varchar("funding_rate").notNull(),
  paymentAmount: varchar("payment_amount").notNull(),
  positionSide: varchar("position_side").notNull(),
  positionSize: varchar("position_size").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
})
```

**Display changes**:
- Show funding paid/received in `TradeHistoryModal.tsx` per closed position
- Add funding total to bot stats in `App.tsx`

**Complexity**: Medium  
**Risk**: Low — read-only API call after position close, no impact on trade execution

---

### Phase 2: Slippage Tracking (Priority: Medium)

**Why it matters**: Users send a signal at a certain price, but the actual fill can differ. Tracking this helps users understand execution quality and compare Swift vs legacy fills.

**How it works**:
1. Record the signal price (from webhook payload `price` field) when a trade is received
2. Compare to the actual fill price after execution
3. Store the difference as slippage

**Schema addition to `bot_trades` table**:
```typescript
expectedPrice: decimal("expected_price", { precision: 20, scale: 6 }),
slippageAmount: decimal("slippage_amount", { precision: 20, scale: 6 }),
slippageBps: integer("slippage_bps"),
```

**Display changes**:
- Show slippage per trade in `TradeHistoryModal.tsx`
- Show average slippage in bot stats (useful for comparing Swift vs legacy)

**Complexity**: Low-Medium  
**Risk**: Low

---

### Phase 3: Legacy Fill Price Accuracy (Priority: Low)

**Why it matters**: Legacy `placeAndTakePerpOrder` trades currently estimate fill price from the oracle at execution time. The actual fill price can differ.

**Current state**: Swift trades already return accurate fill prices from the auction. This only affects legacy fallback trades.

**Approach**: After a legacy trade confirms, parse the transaction logs to extract the `OrderFillEvent` which contains:
- `baseAssetAmountFilled` — actual size filled
- `quoteAssetAmountFilled` — actual USDC amount
- `takerFee` — actual fee charged

**Why it's low priority**: With Swift handling most trades now, legacy fills are becoming rare (fallback only). The oracle estimate is usually close enough.

**Complexity**: Medium  
**Risk**: Medium — transaction log parsing can be fragile across Drift SDK versions

---

### Phase 4: Price Source Clarity (Priority: Low)

**Why it matters**: Users sometimes see slightly different PnL values between the dashboard and Drift's own UI. This is because oracle price (used for settlement/liquidation) and mark price (used for display) can differ by a few cents.

**Changes**:
- Add a small info tooltip in position display explaining which price is used
- Show both oracle and mark price in position details when they differ significantly

**Files to update**:
- `client/src/pages/App.tsx` — position display section

**Complexity**: Low  
**Risk**: None

---

## Files Reference

### Server
- `server/routes.ts` — API routes, PnL calculations, position data
- `server/position-service.ts` — On-chain position fetching via `decodeUser`
- `server/swift-executor.ts` — Swift Protocol execution with fill prices
- `server/drift-service.ts` — Drift SDK client management
- `server/drift-data-api.ts` — Drift data API calls (prices, APY)
- `server/portfolio-snapshot-job.ts` — Periodic equity snapshots
- `server/pnl-snapshot-job.ts` — PnL snapshots for marketplace

### Client
- `client/src/pages/App.tsx` — Main dashboard with position display and bot stats
- `client/src/components/TradeHistoryModal.tsx` — Per-trade history view
- `client/src/components/BotDetailsModal.tsx` — Bot performance details
- `client/src/components/SharePnLCard.tsx` — Shareable PnL cards

### Schema
- `shared/schema.ts` — All database table definitions

---

## Implementation Priority

| Phase | What | Time Estimate | Impact |
|-------|------|---------------|--------|
| 1 | Funding payment tracking | 4-6 hours | High — hidden costs become visible |
| 2 | Slippage tracking | 2-3 hours | Medium — execution quality transparency |
| 3 | Legacy fill price parsing | 3-4 hours | Low — Swift already handles this well |
| 4 | Price source clarity | 1 hour | Low — UI polish |

---

## Success Metrics

1. Dashboard PnL matches on-chain equity within 0.1% for active positions
2. Users can see funding payment impact on positions held longer than 1 hour
3. Slippage is visible per trade, with averages shown per bot
4. Swift vs legacy execution quality is measurable

---

## Notes

- All monetary values stored as strings/decimals to preserve precision
- Funding payments are denominated in USDC
- Slippage can be negative (price improvement) or positive (worse fill)
- 1-minute bots will rarely accumulate meaningful funding, but hourly+ bots will
- Swift trades already provide accurate fill data — this plan focuses on filling the remaining gaps

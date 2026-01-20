# Grid Bot Implementation Plan for Drift Protocol

## Executive Summary

This document outlines a comprehensive strategy for implementing grid trading bots on Drift Protocol, working within the **32 limit order limitation** while enabling users to create strategies with potentially hundreds of virtual grid levels.

---

## Problem Statement

### User Need
- Grid bots capitalize on sideways/choppy markets by placing buy orders below current price and sell orders above
- Popular platforms like Pionex allow hundreds of grid levels
- Users want automated "set and forget" grid strategies

### Drift Protocol Constraints
- **Maximum 32 open limit orders per subaccount**
- Limit orders require sufficient orderbook liquidity to fill at reasonable prices
- Orders must be managed server-side (users don't sign each order)

### Challenge
How do we offer a grid bot experience with 100+ virtual grids while only having 32 active limit orders at any time?

---

## Solution: Rolling Limit Order System

### Core Concept

Maintain a **virtual grid** of N levels (e.g., 100 grids) but only place the **closest 32 orders** to current price on-chain. As orders fill or price moves, dynamically adjust which virtual grids have active limit orders.

```
Virtual Grid (100 levels)              Active Orders (max 32)
┌─────────────────────────────┐       ┌─────────────────────────┐
│ Grid 100: Sell $110.00      │       │                         │
│ Grid 99:  Sell $109.50      │       │                         │
│ ...                         │       │                         │
│ Grid 60:  Sell $105.00      │  ───► │ Order: Sell $105.00     │
│ Grid 59:  Sell $104.50      │  ───► │ Order: Sell $104.50     │
│ ...                         │  ───► │ (16 sell orders)        │
│ ═══ Current Price $100 ═══  │       │                         │
│ Grid 40:  Buy $99.50        │  ───► │ Order: Buy $99.50       │
│ Grid 39:  Buy $99.00        │  ───► │ Order: Buy $99.00       │
│ ...                         │  ───► │ (16 buy orders)         │
│ Grid 1:   Buy $75.00        │       │                         │
└─────────────────────────────┘       └─────────────────────────┘
```

### Rolling Order Logic

When an order fills:
1. Remove filled order from active set
2. Check if next virtual grid level should become active
3. Place new limit order for that level
4. Maintain buy/sell balance around current price

When price moves significantly:
1. Cancel orders that are now "too far" from price
2. Activate virtual grids that are now "close enough"
3. Rebalance order distribution

---

## Detailed Technical Design

### 1. Grid Configuration Model

```typescript
interface GridBotConfig {
  // Basic settings
  id: string;
  name: string;
  market: string;  // e.g., "SOL-PERP"
  
  // Grid range
  upperPrice: number;      // Top of grid range
  lowerPrice: number;      // Bottom of grid range
  gridCount: number;       // Total virtual grids (e.g., 100)
  
  // Position sizing
  totalInvestment: number; // Total USDC to use
  orderSizePerGrid: number; // Calculated: totalInvestment / gridCount
  
  // Strategy type
  strategyType: 'neutral' | 'long_bias' | 'short_bias';
  
  // Advanced settings
  useScaleOrders: boolean;        // Use Drift's built-in scale orders
  scaleType: 'ascending' | 'descending' | 'flat';
  takeProfitPercent?: number;     // Optional TP per grid
  stopLossPercent?: number;       // Optional SL for entire grid
  
  // State
  status: 'active' | 'paused' | 'stopped';
  createdAt: Date;
}

interface VirtualGrid {
  level: number;           // Grid level (1 to gridCount)
  price: number;           // Price for this grid
  side: 'buy' | 'sell';    // Order side
  status: 'pending' | 'active' | 'filled' | 'cancelled';
  orderId?: string;        // Drift order ID if active on-chain
  filledAt?: Date;
  pnl?: number;            // Realized PnL when closed
}
```

### 2. Grid Calculation Engine

```typescript
function calculateGridLevels(config: GridBotConfig): VirtualGrid[] {
  const grids: VirtualGrid[] = [];
  const priceRange = config.upperPrice - config.lowerPrice;
  const gridSpacing = priceRange / config.gridCount;
  
  for (let i = 0; i < config.gridCount; i++) {
    const price = config.lowerPrice + (i * gridSpacing);
    grids.push({
      level: i + 1,
      price: parseFloat(price.toFixed(4)),
      side: price > currentPrice ? 'sell' : 'buy',
      status: 'pending',
    });
  }
  
  return grids;
}

function determineActiveGrids(
  allGrids: VirtualGrid[],
  currentPrice: number,
  maxOrders: number = 32
): VirtualGrid[] {
  // Split available orders: half buys, half sells
  const maxPerSide = Math.floor(maxOrders / 2);
  
  const buyGrids = allGrids
    .filter(g => g.side === 'buy' && g.status === 'pending')
    .sort((a, b) => b.price - a.price)  // Closest to price first
    .slice(0, maxPerSide);
    
  const sellGrids = allGrids
    .filter(g => g.side === 'sell' && g.status === 'pending')
    .sort((a, b) => a.price - b.price)  // Closest to price first
    .slice(0, maxPerSide);
    
  return [...buyGrids, ...sellGrids];
}
```

### 3. Order Management Loop

```typescript
async function gridOrderManagementLoop(botId: string): Promise<void> {
  const bot = await storage.getGridBot(botId);
  if (!bot || bot.status !== 'active') return;
  
  const currentPrice = await getCurrentMarketPrice(bot.market);
  const allGrids = await storage.getVirtualGrids(botId);
  
  // 1. Check for filled orders
  const activeOrders = await driftClient.getOpenOrders(bot.subaccountId);
  for (const grid of allGrids.filter(g => g.status === 'active')) {
    const order = activeOrders.find(o => o.orderId === grid.orderId);
    if (!order) {
      // Order was filled or cancelled
      await handleFilledGrid(bot, grid, currentPrice);
    }
  }
  
  // 2. Determine which grids should be active
  const shouldBeActive = determineActiveGrids(allGrids, currentPrice, 32);
  
  // 3. Cancel orders that shouldn't be active anymore
  const currentlyActive = allGrids.filter(g => g.status === 'active');
  for (const grid of currentlyActive) {
    if (!shouldBeActive.find(g => g.level === grid.level)) {
      await cancelGridOrder(bot, grid);
    }
  }
  
  // 4. Place orders for grids that should be active but aren't
  for (const grid of shouldBeActive) {
    if (grid.status === 'pending') {
      await placeGridOrder(bot, grid);
    }
  }
}

async function handleFilledGrid(
  bot: GridBotConfig,
  filledGrid: VirtualGrid,
  currentPrice: number
): Promise<void> {
  // Mark as filled
  await storage.updateVirtualGrid(filledGrid.id, { 
    status: 'filled',
    filledAt: new Date(),
  });
  
  // Calculate PnL if this was a closing order
  // (depends on grid strategy - see Strategy Types below)
  
  // Create the "opposite" order for this grid level
  // Buy filled -> place sell at same level (or higher for profit)
  // Sell filled -> place buy at same level (or lower for profit)
  await createOppositeOrder(bot, filledGrid, currentPrice);
}
```

### 4. Leveraging Drift Scale Orders

Drift has built-in scale order functionality that can help maximize the 32 order limit:

```typescript
interface ScaleOrderParams {
  market: string;
  side: 'buy' | 'sell';
  totalSize: number;        // Total position size
  orderCount: number;       // Number of orders (max 32)
  startPrice: number;       // First order price
  endPrice: number;         // Last order price
  scaleType: 'ascending' | 'descending' | 'flat';
  // ascending: smaller orders first, larger at end
  // descending: larger orders first, smaller at end
  // flat: equal size orders
}

async function placeScaleOrders(params: ScaleOrderParams): Promise<void> {
  // Use Drift SDK's scale order functionality
  await driftClient.placeScaleOrders({
    marketIndex: getMarketIndex(params.market),
    direction: params.side === 'buy' ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: params.totalSize,
    numOrders: params.orderCount,
    startPrice: params.startPrice,
    endPrice: params.endPrice,
    orderType: OrderType.LIMIT,
    postOnly: true,  // Maker orders for better fees
  });
}
```

**Scale Order Advantages**:
- Single transaction to place multiple orders
- Built-in price distribution
- Ascending/descending can weight orders toward support/resistance levels

---

## Grid Strategy Types

### 1. Neutral Grid (Range Trading)

Best for sideways markets. Equal buy and sell orders around current price.

```
Configuration:
- Range: $90 - $110
- Current price: $100
- Grids: 40
- Order split: 20 buys below, 20 sells above

Behavior:
- Buy at $99, sell at $101 (profit $2)
- Continuously cycle between buys and sells
- Profit = Grid spacing × Number of cycles
```

### 2. Long Bias Grid

For uptrending markets. More buy orders, fewer sell orders.

```
Configuration:
- Same range, but 30 buy grids, 10 sell grids
- Scale type: ascending (larger buys at lower prices)

Behavior:
- Accumulate more on dips
- Take partial profits on pops
- Net long exposure over time
```

### 3. Short Bias Grid

For downtrending markets. More sell orders, fewer buy orders.

```
Configuration:
- 10 buy grids, 30 sell grids
- Scale type: descending (larger sells at higher prices)

Behavior:
- Scale into shorts on rallies
- Take profits on dips
- Net short exposure over time
```

---

## Intelligent Range Setting

### Auto-Range Suggestions

Help users set appropriate grid ranges based on market data:

```typescript
interface RangeSuggestion {
  conservative: { lower: number; upper: number };  // 1 ATR range
  moderate: { lower: number; upper: number };      // 2 ATR range
  aggressive: { lower: number; upper: number };    // 3 ATR range
  reasoning: string;
}

async function suggestGridRange(market: string): Promise<RangeSuggestion> {
  // Fetch historical data
  const prices = await getHistoricalPrices(market, '7d');
  const currentPrice = prices[prices.length - 1];
  
  // Calculate ATR (Average True Range)
  const atr = calculateATR(prices, 14);
  
  // Calculate recent support/resistance
  const { support, resistance } = findKeyLevels(prices);
  
  return {
    conservative: {
      lower: Math.max(support, currentPrice - atr),
      upper: Math.min(resistance, currentPrice + atr),
    },
    moderate: {
      lower: currentPrice - (2 * atr),
      upper: currentPrice + (2 * atr),
    },
    aggressive: {
      lower: currentPrice - (3 * atr),
      upper: currentPrice + (3 * atr),
    },
    reasoning: `Based on 14-day ATR of $${atr.toFixed(2)} and key levels at $${support.toFixed(2)} (support) / $${resistance.toFixed(2)} (resistance)`,
  };
}
```

### Visual Range Selector

UI component showing:
- Current price line
- 7-day price history overlay
- Draggable upper/lower bounds
- Grid density preview
- Estimated profit per cycle

---

## Polling vs Event-Driven Updates

### Approach: Hybrid Polling

Since we can't get real-time order fill notifications from Drift directly:

```typescript
// Poll every 5-10 seconds for active grid bots
const GRID_POLL_INTERVAL = 5000;

async function startGridPolling(): Promise<void> {
  setInterval(async () => {
    const activeGridBots = await storage.getActiveGridBots();
    
    for (const bot of activeGridBots) {
      try {
        await gridOrderManagementLoop(bot.id);
      } catch (error) {
        console.error(`[GridBot] Error processing ${bot.id}:`, error);
      }
    }
  }, GRID_POLL_INTERVAL);
}
```

### Optimization: Price-Based Triggers

Only run full loop when price moves significantly:

```typescript
const lastKnownPrices: Map<string, number> = new Map();
const PRICE_CHANGE_THRESHOLD = 0.5; // 0.5% price change

async function shouldUpdateGridBot(bot: GridBotConfig): Promise<boolean> {
  const currentPrice = await getCurrentMarketPrice(bot.market);
  const lastPrice = lastKnownPrices.get(bot.id) || currentPrice;
  
  const changePercent = Math.abs((currentPrice - lastPrice) / lastPrice) * 100;
  
  if (changePercent >= PRICE_CHANGE_THRESHOLD) {
    lastKnownPrices.set(bot.id, currentPrice);
    return true;
  }
  
  return false;
}
```

---

## Risk Management

### Position Limits

```typescript
interface GridRiskLimits {
  maxPositionSize: number;      // Max total position across all grids
  maxDrawdownPercent: number;   // Stop grid if drawdown exceeds
  maxGridLevelsFromPrice: number; // Don't place orders > N grids from price
}

async function checkRiskLimits(bot: GridBotConfig): Promise<boolean> {
  const position = await getPosition(bot.subaccountId, bot.market);
  const equity = await getEquity(bot.subaccountId);
  const unrealizedPnl = position?.unrealizedPnl || 0;
  
  // Check drawdown
  if (unrealizedPnl < 0) {
    const drawdownPercent = Math.abs(unrealizedPnl / equity) * 100;
    if (drawdownPercent > bot.riskLimits.maxDrawdownPercent) {
      await pauseGridBot(bot.id, 'Max drawdown exceeded');
      return false;
    }
  }
  
  // Check position size
  if (Math.abs(position?.size || 0) > bot.riskLimits.maxPositionSize) {
    // Stop adding to position
    return false;
  }
  
  return true;
}
```

### Stop Loss / Take Profit

Optional overall grid stop loss:

```typescript
async function checkGridStopLoss(bot: GridBotConfig): Promise<void> {
  if (!bot.stopLossPercent) return;
  
  const totalPnl = await calculateGridTotalPnl(bot.id);
  const initialInvestment = bot.totalInvestment;
  const pnlPercent = (totalPnl / initialInvestment) * 100;
  
  if (pnlPercent <= -bot.stopLossPercent) {
    await stopGridBot(bot.id, 'Stop loss triggered');
    await closeAllPositions(bot.subaccountId);
  }
}
```

---

## Database Schema Additions

```typescript
// Grid bot configuration
export const gridBots = pgTable("grid_bots", {
  id: varchar("id").primaryKey(),
  tradingBotId: varchar("trading_bot_id").references(() => tradingBots.id),
  walletAddress: text("wallet_address").notNull(),
  
  // Configuration
  market: text("market").notNull(),
  upperPrice: decimal("upper_price").notNull(),
  lowerPrice: decimal("lower_price").notNull(),
  gridCount: integer("grid_count").notNull(),
  totalInvestment: decimal("total_investment").notNull(),
  
  // Strategy
  strategyType: text("strategy_type").notNull(), // neutral, long_bias, short_bias
  useScaleOrders: boolean("use_scale_orders").default(false),
  scaleType: text("scale_type"), // ascending, descending, flat
  
  // Risk
  stopLossPercent: decimal("stop_loss_percent"),
  takeProfitPercent: decimal("take_profit_percent"),
  
  // State
  status: text("status").notNull().default("active"),
  totalCycles: integer("total_cycles").default(0),
  totalPnl: decimal("total_pnl").default("0"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Virtual grid levels (in-memory or cached, not necessarily persisted)
export const virtualGrids = pgTable("virtual_grids", {
  id: varchar("id").primaryKey(),
  gridBotId: varchar("grid_bot_id").references(() => gridBots.id),
  
  level: integer("level").notNull(),
  price: decimal("price").notNull(),
  side: text("side").notNull(), // buy, sell
  status: text("status").notNull(), // pending, active, filled
  
  orderId: varchar("order_id"),
  filledAt: timestamp("filled_at"),
  filledPrice: decimal("filled_price"),
  pnl: decimal("pnl"),
});
```

---

## Limitations & Considerations

### Drift Protocol Limitations

| Limitation | Impact | Mitigation |
|------------|--------|------------|
| 32 order max | Can't have all grids active | Rolling order system |
| Limit orders need liquidity | May not fill at exact price | Use popular markets, accept slippage |
| No order fill webhooks | Must poll for fills | 5-second polling loop |
| Subaccount rent ~0.035 SOL | Cost per grid bot | Already handled in bot creation |

### Market Considerations

| Factor | Consideration |
|--------|---------------|
| Low liquidity markets | Wider spreads, worse fills - warn users |
| High volatility | Grids may all fill one direction quickly |
| Trending markets | Neutral grids may accumulate losing positions |
| Funding rates | Long/short bias affects funding payments |

### Operational Considerations

| Factor | Consideration |
|--------|---------------|
| Server uptime | Grid management requires constant polling |
| RPC rate limits | Batch order operations where possible |
| Order placement speed | Use priority fees during volatility |
| Error recovery | Graceful handling of failed order placements |

---

## Implementation Phases

### Phase 1: Core Infrastructure (2-3 days)
- [ ] Database schema for grid bots
- [ ] Grid calculation engine
- [ ] Basic order placement/cancellation
- [ ] Polling loop for order management

### Phase 2: Rolling Order System (2-3 days)
- [ ] Virtual grid state management
- [ ] Active order determination logic
- [ ] Filled order detection and handling
- [ ] Opposite order creation

### Phase 3: Drift Scale Order Integration (1-2 days)
- [ ] Integrate scale order SDK methods
- [ ] Ascending/descending/flat distribution
- [ ] Batch order placement

### Phase 4: UI/UX (2-3 days)
- [ ] Grid configuration form
- [ ] Visual range selector
- [ ] Auto-range suggestions
- [ ] Grid status dashboard
- [ ] PnL tracking display

### Phase 5: Risk Management (1-2 days)
- [ ] Position limit checks
- [ ] Drawdown monitoring
- [ ] Stop loss / take profit triggers
- [ ] User alerts

### Phase 6: Testing & Optimization (2-3 days)
- [ ] Unit tests for grid calculations
- [ ] Integration tests with Drift devnet
- [ ] Performance optimization
- [ ] Edge case handling

**Total Estimated Time: 10-16 days**

---

## Open Questions for Audit

1. **Order Priority**: When price moves fast, which orders get placed first - closest to price, or largest size?

2. **Partial Fills**: How to handle partially filled orders? Wait for full fill or manage partial?

3. **Rebalancing Frequency**: How often should we rebalance active orders as price moves?

4. **Memory vs Database**: Should virtual grids be stored in DB or held in memory with periodic snapshots?

5. **Multi-Market Grids**: Should one grid bot span multiple markets, or one market per bot?

6. **Grid Spacing**: Linear spacing, or should we support logarithmic/percentage-based spacing?

7. **Initial Position**: When starting grid bot, should it immediately take a position at current price?

8. **Profit Lock**: When a grid cycle completes profitably, auto-withdraw profits or reinvest?

---

## Competitive Analysis

### Pionex Grid Bot Features
- Hundreds of grids
- AI-suggested ranges
- Arithmetic vs geometric grids
- Trailing up/down
- Auto-compound profits

### 3Commas Grid Features
- Multi-pair grids
- DCA integration
- Smart coverage
- Take profit levels

### Features to Consider Adding Later
- Trailing grid (moves with trend)
- Geometric grid spacing (% based)
- Multi-leg grids (different spacing in different ranges)
- AI-driven range adjustment

---

## Conclusion

The rolling limit order system enables grid bot functionality within Drift's 32 order constraint by:

1. Maintaining virtual state of all grid levels
2. Only activating the 32 most relevant orders at any time
3. Dynamically replacing filled orders with new ones
4. Leveraging Drift's scale orders for efficient batch placement

This approach provides users with a Pionex-like grid trading experience while respecting protocol limitations.

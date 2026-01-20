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

### Rolling Order Logic (Clarified)

**Key Insight**: All grid levels are PRE-CALCULATED at bot creation. No real-time price calculation needed.

**Initial Setup (Long Grid Example):**
1. Calculate all 100 grid price levels at bot creation and store them
2. Place 16 BUY scale orders below current price (levels 1-16 from bottom)
3. Place 16 REDUCE-ONLY sell orders above current price (levels closest above)
4. Track: `lowestActiveBuyLevel`, `highestActiveSellLevel`

**When a BUY order fills:**
1. Mark that grid level as "filled"
2. Look up the NEXT pre-calculated buy level (below lowest active)
3. Place new buy limit order at that exact price
4. Update `lowestActiveBuyLevel`

**When a SELL (reduce-only) order fills:**
1. Mark that grid level as "filled"  
2. Look up the NEXT pre-calculated sell level (above highest active)
3. Place new reduce-only sell at that exact price
4. Update `highestActiveSellLevel`

**Grid Expansion Pattern:**
```
Initial State:           After 3 Buy Fills:
                         
Sell 16 ────────         Sell 19 ──────── (new)
Sell 15                  Sell 18 (new)
...                      Sell 17 (new)
Sell 1  ────────         Sell 16
═══ Current Price ═══    ...
Buy 16  ────────         Sell 1
Buy 15                   ═══ Price dropped ═══
...                      Buy 16
Buy 1   ────────         Buy 15
                         ...
                         Buy 4  ──────── (now lowest)
                         Buy 3  (filled)
                         Buy 2  (filled)
                         Buy 1  (filled)
```

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

### 2. Grid Calculation Engine (Pre-Calculated PRICES and SIZES at Bot Creation)

```typescript
interface VirtualGrid {
  level: number;
  price: number;
  size: number;           // Pre-calculated size for this level
  side: 'buy' | 'sell';
  isReduceOnly: boolean;
  status: 'pending' | 'active' | 'filled';
}

// Called ONCE when bot is created - stores all levels WITH sizes
function calculateAndStoreGridLevels(config: GridBotConfig, startPrice: number): VirtualGrid[] {
  const grids: VirtualGrid[] = [];
  const priceRange = config.upperPrice - config.lowerPrice;
  const gridSpacing = priceRange / (config.gridCount - 1);
  
  // Split grids into buy/sell counts
  const buyCount = Math.floor((startPrice - config.lowerPrice) / gridSpacing);
  const sellCount = config.gridCount - buyCount;
  
  // Calculate sizes based on scale type
  const buySizes = calculateScaledSizes(buyCount, config.totalInvestment * 0.5, config.buyScaleType);
  const sellSizes = calculateScaledSizes(sellCount, config.totalInvestment * 0.5, config.sellScaleType);
  
  let buyIndex = 0;
  let sellIndex = 0;
  
  for (let i = 0; i < config.gridCount; i++) {
    const price = config.lowerPrice + (i * gridSpacing);
    const isBuy = price < startPrice;
    
    grids.push({
      level: i + 1,
      price: parseFloat(price.toFixed(4)),
      side: isBuy ? 'buy' : 'sell',
      size: isBuy ? buySizes[buyIndex++] : sellSizes[sellIndex++],  // Pre-calculated size!
      isReduceOnly: !isBuy,  // All sells are reduce-only in long grid
      status: 'pending',
    });
  }
  
  // Store to database - prices AND sizes never change
  await storage.storeGridLevels(config.id, grids);
  return grids;
}

// Calculate sizes following ascending/descending/flat pattern
function calculateScaledSizes(
  orderCount: number,
  totalCapital: number,
  scaleType: 'ascending' | 'descending' | 'flat'
): number[] {
  const sizes: number[] = [];
  
  if (scaleType === 'flat') {
    // Equal sizes
    const sizePerOrder = totalCapital / orderCount;
    for (let i = 0; i < orderCount; i++) {
      sizes.push(sizePerOrder);
    }
    return sizes;
  }
  
  // For ascending/descending: use arithmetic progression
  // Sum of 1+2+3+...+n = n(n+1)/2
  const sumOfWeights = (orderCount * (orderCount + 1)) / 2;
  const unitSize = totalCapital / sumOfWeights;
  
  for (let i = 0; i < orderCount; i++) {
    const weight = scaleType === 'ascending' 
      ? orderCount - i      // Largest first (for buys: biggest at lowest price)
      : i + 1;              // Smallest first (for buys: smallest at lowest price)
    sizes.push(unitSize * weight);
  }
  
  return sizes;
}

/*
Example: 16 buy orders, $1000 capital, ASCENDING

sumOfWeights = 16 * 17 / 2 = 136
unitSize = $1000 / 136 = $7.35

Level 1 (lowest price):  weight=16, size = $117.60 (LARGEST)
Level 2:                 weight=15, size = $110.25
...
Level 15:                weight=2,  size = $14.70
Level 16 (near entry):   weight=1,  size = $7.35  (SMALLEST)

Result: Most capital deployed at best prices (lowest)
*/
```

// State tracking (stored in grid bot record)
interface GridBotState {
  lowestActiveBuyLevel: number;   // e.g., level 5
  highestActiveSellLevel: number; // e.g., level 60
  nextBuyLevel: number;           // Next level to place when buy fills
  nextSellLevel: number;          // Next level to place when sell fills
}

// Initial placement - uses scale orders for efficiency
async function placeInitialGridOrders(
  config: GridBotConfig,
  grids: VirtualGrid[],
  startPrice: number
): Promise<void> {
  const buyGrids = grids.filter(g => g.price < startPrice).slice(-16); // Top 16 buys (closest)
  const sellGrids = grids.filter(g => g.price > startPrice).slice(0, 16); // Bottom 16 sells (closest)
  
  // Place 16 buy scale orders
  await driftClient.placeScaleOrders({
    direction: PositionDirection.LONG,
    numOrders: buyGrids.length,
    startPrice: buyGrids[0].price,
    endPrice: buyGrids[buyGrids.length - 1].price,
    // ... size config
  });
  
  // Place 16 reduce-only sell scale orders
  await driftClient.placeScaleOrders({
    direction: PositionDirection.SHORT,
    reduceOnly: true,
    numOrders: sellGrids.length,
    startPrice: sellGrids[0].price,
    endPrice: sellGrids[sellGrids.length - 1].price,
    // ... size config
  });
  
  // Initialize state
  await storage.updateGridBotState(config.id, {
    lowestActiveBuyLevel: buyGrids[0].level,
    highestActiveSellLevel: sellGrids[sellGrids.length - 1].level,
    nextBuyLevel: buyGrids[0].level - 1,  // Next buy goes one level lower
    nextSellLevel: sellGrids[sellGrids.length - 1].level + 1,  // Next sell goes one level higher
  });
}
```

### 3. Order Management Loop (Simplified with Pre-Calculated Levels)

```typescript
async function gridOrderManagementLoop(botId: string): Promise<void> {
  const bot = await storage.getGridBot(botId);
  if (!bot || bot.status !== 'active') return;
  
  const state = bot.state as GridBotState;
  const grids = await storage.getGridLevels(botId);  // Pre-calculated, immutable
  
  // 1. Get current open orders from Drift
  const activeOrders = await driftClient.getOpenOrders(bot.subaccountId);
  const activeOrderPrices = new Set(activeOrders.map(o => o.price.toFixed(4)));
  
  // 2. Find which grid levels had orders that are now missing (filled)
  const activeGrids = grids.filter(g => g.status === 'active');
  const filledGrids: VirtualGrid[] = [];
  
  for (const grid of activeGrids) {
    if (!activeOrderPrices.has(grid.price.toFixed(4))) {
      filledGrids.push(grid);
    }
  }
  
  // 3. Process each filled grid
  for (const filledGrid of filledGrids) {
    await handleFilledGrid(bot, filledGrid, state, grids);
  }
}

async function handleFilledGrid(
  bot: GridBotConfig,
  filledGrid: VirtualGrid,
  state: GridBotState,
  grids: VirtualGrid[]
): Promise<void> {
  // Mark as filled
  await storage.updateGridLevel(filledGrid.id, { 
    status: 'filled',
    filledAt: new Date(),
  });
  
  if (filledGrid.side === 'buy') {
    // BUY filled - place next buy at lower level (if available)
    if (state.nextBuyLevel >= 1) {
      const nextBuyGrid = grids.find(g => g.level === state.nextBuyLevel);
      if (nextBuyGrid) {
        await placeSingleOrder(bot, nextBuyGrid);
        
        // Update state
        await storage.updateGridBotState(bot.id, {
          lowestActiveBuyLevel: state.nextBuyLevel,
          nextBuyLevel: state.nextBuyLevel - 1,
        });
      }
    }
    
    // Also place a new reduce-only sell above current highest
    if (state.nextSellLevel <= grids.length) {
      const nextSellGrid = grids.find(g => g.level === state.nextSellLevel);
      if (nextSellGrid) {
        await placeSingleOrder(bot, nextSellGrid, { reduceOnly: true });
        
        await storage.updateGridBotState(bot.id, {
          highestActiveSellLevel: state.nextSellLevel,
          nextSellLevel: state.nextSellLevel + 1,
        });
      }
    }
    
  } else {
    // SELL (reduce-only) filled - profit taken!
    // Place next sell at higher level (if available)
    if (state.nextSellLevel <= grids.length) {
      const nextSellGrid = grids.find(g => g.level === state.nextSellLevel);
      if (nextSellGrid) {
        await placeSingleOrder(bot, nextSellGrid, { reduceOnly: true });
        
        await storage.updateGridBotState(bot.id, {
          highestActiveSellLevel: state.nextSellLevel,
          nextSellLevel: state.nextSellLevel + 1,
        });
      }
    }
  }
}

async function placeSingleOrder(bot: GridBotConfig, grid: VirtualGrid): Promise<void> {
  // Price AND size are pre-calculated - no calculation needed!
  await driftClient.placePerpOrder({
    marketIndex: getMarketIndex(bot.market),
    direction: grid.side === 'buy' ? PositionDirection.LONG : PositionDirection.SHORT,
    orderType: OrderType.LIMIT,
    price: grid.price,                    // Pre-calculated
    baseAssetAmount: grid.size,           // Pre-calculated with ascending/descending
    reduceOnly: grid.isReduceOnly,        // Pre-set (all sells are reduce-only)
    postOnly: true,                       // Maker fees
  });
  
  await storage.updateGridLevel(grid.id, { status: 'active' });
}

/*
Why this works:

When a buy at Level 5 ($85, size 4.5 SOL) fills:
1. Look up Level 4 from pre-calculated list
2. Level 4 = $83, size 5.0 SOL (already computed with ascending scale)
3. Place order instantly - no math needed

The ascending/descending pattern CONTINUES automatically because
all sizes were calculated upfront following the same progression.
*/
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

### Why Ascending/Descending Scale Orders Give an Edge

The key advantage over flat grid systems is **cost basis optimization**:

**Ascending (for Long Grid Buys):**
```
Grid Level | Price  | Size   | Effect
──────────────────────────────────────
Level 1    | $80    | 5 SOL  | Largest buy at lowest price
Level 2    | $82    | 4 SOL  | 
Level 3    | $84    | 3 SOL  | 
...
Level 16   | $98    | 0.5 SOL| Smallest buy near entry

Result: Average cost basis is MUCH LOWER than flat sizing
        - More capital deployed at better prices
        - Less capital at risky prices near entry
        - If price dumps, you accumulate more at discount
```

**Descending (for Aggressive Entry):**
```
Grid Level | Price  | Size   | Effect
──────────────────────────────────────
Level 1    | $80    | 0.5 SOL| Small buys at extreme lows
Level 2    | $82    | 1 SOL  | 
...
Level 16   | $98    | 5 SOL  | Largest buy near entry

Result: Gets positioned quickly if price doesn't drop much
        - More aggressive profit-taking above entry
        - Fringe orders are small "just in case" orders
        - Good for trending markets where dips are shallow
```

### Critical: Why Reduce-Only Sells Are Essential

Without reduce-only on sell orders, this dangerous scenario occurs:

```
Scenario: Price drops, then rallies sharply

1. Bot places: 16 buys below, 16 sells above
2. Price drops: Only 5 buys fill (5 SOL long position)
3. Price rallies past ALL sell levels
4. All 16 sells fill...

WITHOUT reduce-only:
  - First 5 sells close the long (correct)
  - Next 11 sells OPEN A SHORT POSITION (WRONG!)
  - User now has -11 SOL short they didn't want

WITH reduce-only:
  - First 5 sells close the long (correct)  
  - Remaining 11 sells are REJECTED (no position to reduce)
  - User's position is flat, no accidental short
```

### 1. Neutral Grid (Range Trading)

Best for sideways markets. Flat sizing, equal buy and sell orders.

```
Configuration:
- Range: $90 - $110
- Current price: $100
- Grids: 40
- Order split: 20 buys below, 20 sells above
- Scale type: FLAT (equal sizes)

Behavior:
- Buy at $99, sell at $101 (profit $2)
- Continuously cycle between buys and sells
- Profit = Grid spacing × Number of cycles
```

### 2. Long Bias Grid (Recommended)

For accumulation strategies. Ascending buys, descending reduce-only sells.

```
Configuration:
- Range: $80 - $120
- Current price: $100
- Grids: 100
- Scale type: ASCENDING for buys, DESCENDING for sells

Buy Side (Ascending):
- Level 1 ($80): 5 SOL (largest - best price)
- Level 50 ($99): 0.5 SOL (smallest - near entry)

Sell Side (Reduce-Only, Descending):
- Level 51 ($101): 2 SOL (take profit aggressively near entry)
- Level 100 ($120): 0.2 SOL (small takes at extreme highs)

Result:
- Cost basis ends up lower than entry price
- Most profit taken near entry (where fills are likely)
- Fringe sells are small "moonbag" takes
```

### 3. Short Bias Grid

For distribution strategies. Descending buys, ascending reduce-only sells.

```
Configuration:
- Opposite of long bias
- Scale type: DESCENDING for buys, ASCENDING for sells

Behavior:
- Small buys at low prices (just covering shorts)
- Large sells at high prices (main position)
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

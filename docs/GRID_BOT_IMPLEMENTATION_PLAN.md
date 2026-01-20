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

## Capital Allocation Model

### Why Entry Orders Need Capital, Profit Orders Don't

In perpetual futures, only **entry orders** require margin capital. Profit-taking orders (reduce-only) simply close existing positions and don't need additional margin.

```
LONG GRID CAPITAL FLOW:

1. User deposits $1,000 USDC as margin
2. Bot places BUY orders using this margin
3. When buys fill → position opens (margin used)
4. SELL orders are reduce-only → no additional margin needed
5. When sells fill → position closes → margin freed + PnL realized

Capital needed = Maximum position size from entry orders only
```

### Capital Allocation for Grid Sizing

```typescript
/*
CAPITAL ALLOCATION:

Total investment is allocated to ENTRY orders only (the side that opens positions).
Profit orders (reduce-only) don't require additional capital.

For LONG grid:
- Entry = BUY orders (need margin)
- Profit = SELL orders (reduce-only, no margin)
- Allocate 100% of totalInvestment to buy side sizing

For SHORT grid:
- Entry = SELL orders (need margin)  
- Profit = BUY orders (reduce-only, no margin)
- Allocate 100% of totalInvestment to sell side sizing

The ascending/descending scale applies to order SIZES, not capital allocation.
*/

function calculateGridCapitalAllocation(config: GridBotConfig): {
  entryCapital: number;
  profitCapital: number;
} {
  // Entry orders use the full investment as margin backing
  // Profit orders (reduce-only) don't need capital - they just close positions
  return {
    entryCapital: config.totalInvestment,
    profitCapital: 0,  // Reduce-only orders don't need margin
  };
}

// Updated size calculation reflecting this
function calculateAndStoreGridLevels(config: GridBotConfig, startPrice: number): VirtualGrid[] {
  // ... price calculation same as before ...
  
  const entryCount = /* grids below/above startPrice based on direction */;
  const profitCount = config.gridCount - entryCount;
  
  // Entry orders sized based on total investment
  // Each entry order's size is calculated so that if ALL entry orders fill,
  // the total position equals totalInvestment at average cost
  const entrySizes = calculateScaledSizes(
    entryCount,
    config.totalInvestment,     // Full capital to entry side
    config.entryScaleType
  );
  
  // Profit order sizes mirror the entry sizes they're meant to close
  // This ensures each sell can close what the corresponding buy opened
  const profitSizes = calculateScaledSizes(
    profitCount,
    config.totalInvestment,     // Same total value for matching closes
    config.profitScaleType
  );
  
  // ...rest of grid building...
}
```

### Leverage Considerations

```typescript
/*
LEVERAGE IMPACT:

User's totalInvestment is MARGIN, not position size.
Actual position size = margin × leverage

Example with 5x leverage:
- totalInvestment = $1,000 (margin)
- Max position value = $5,000
- If SOL = $100, max position = 50 SOL

Grid sizing must account for this:
*/

function calculatePositionSizePerGrid(
  config: GridBotConfig,
  leverage: number
): number {
  const maxPositionValue = config.totalInvestment * leverage;
  const entryGridCount = /* count of entry grids */;
  
  // For flat scaling
  const avgSizePerGrid = maxPositionValue / entryGridCount;
  
  // Apply ascending/descending distribution
  return avgSizePerGrid;  // Adjusted by scale type
}
```

---

## Detailed Technical Design

### 1. Grid Configuration Model

```typescript
interface GridBotConfig {
  // Basic settings
  id: string;
  name: string;
  market: string;                  // e.g., "SOL-PERP"
  marketIndex: number;             // Drift market index (for SDK calls)
  driftSubaccountId: number;       // Drift subaccount for this bot
  walletAddress: string;
  
  // Grid range
  upperPrice: number;              // Top of grid range
  lowerPrice: number;              // Bottom of grid range
  gridCount: number;               // Total virtual grids (e.g., 100)
  startPrice: number;              // Price when bot was created
  
  // Position sizing
  totalInvestment: number;         // Total USDC to use as margin
  
  // Direction
  direction: 'long' | 'short';     // Long = buy below/sell above, Short = sell above/buy below
  
  // INDEPENDENT SCALE TYPES for entry and profit-taking
  entryScaleType: 'ascending' | 'descending' | 'flat';
  profitScaleType: 'ascending' | 'descending' | 'flat';
  
  /*
  Long Grid Examples:
  ───────────────────
  Entry = ASCENDING, Profit = DESCENDING (Conservative)
    - Large buys at low prices (lower cost basis)
    - Large sells near entry (take profit quickly)
    
  Entry = DESCENDING, Profit = ASCENDING (Aggressive)
    - Large buys near entry (get positioned fast)
    - Large sells at high prices (ride the trend)
    
  Entry = DESCENDING, Profit = DESCENDING (Balanced Aggressive)
    - Large buys near entry (get positioned fast)  
    - Large sells near entry (take profit quickly)
    - Fringe orders are small on both sides
  
  Entry = ASCENDING, Profit = ASCENDING (Moon Strategy)
    - Large buys at low prices (accumulate on dumps)
    - Large sells at high prices (maximize upside)
    - Risk: most profit locked in unlikely high fills
  */
  
  // Risk settings
  stopLossPercent?: number;
  
  // Rolling State (tracked in database, loaded into config)
  lowestActiveBuyLevel?: number;
  highestActiveSellLevel?: number;
  nextBuyLevel?: number;
  nextSellLevel?: number;
  
  // Status
  status: 'active' | 'paused' | 'stopped' | 'range_exhausted';
  createdAt: Date;
}

interface VirtualGrid {
  id: string;                      // Unique ID for this grid level
  level: number;                   // Grid level (1 to gridCount)
  price: number;                   // Pre-calculated price (IMMUTABLE)
  size: number;                    // Pre-calculated size (IMMUTABLE)
  side: 'buy' | 'sell';            // Order side
  isReduceOnly: boolean;           // true for profit-taking orders
  status: 'pending' | 'active' | 'filled' | 'cancelled';
  driftOrderId?: number;           // Drift's order ID when active (for fill tracking)
  filledAt?: Date;
  filledPrice?: number;            // Actual fill price
  filledSize?: number;             // For partial fill tracking
}
```

### 2. Grid Calculation Engine (Pre-Calculated PRICES and SIZES at Bot Creation)

```typescript
// Uses VirtualGrid interface defined above (id, level, price, size, side, isReduceOnly, status, driftOrderId, filledAt, filledPrice, filledSize)

// Called ONCE when bot is created - stores all levels WITH sizes
function calculateAndStoreGridLevels(config: GridBotConfig, startPrice: number): VirtualGrid[] {
  const grids: VirtualGrid[] = [];
  const priceRange = config.upperPrice - config.lowerPrice;
  const gridSpacing = priceRange / (config.gridCount - 1);
  
  // Split grids into entry/profit counts based on direction
  const entryCount = Math.floor((startPrice - config.lowerPrice) / gridSpacing);
  const profitCount = config.gridCount - entryCount;
  
  // For LONG: buys are entry, sells are profit-taking
  // For SHORT: sells are entry, buys are profit-taking (inverted)
  const isLong = config.direction === 'long';
  
  // Calculate sizes using INDEPENDENT scale types
  // Entry orders get 100% of capital (they need margin)
  // Profit orders mirror entry sizes (they just close positions)
  const entrySizes = calculateScaledSizes(
    entryCount, 
    config.totalInvestment,     // 100% to entry side (margin requirement)
    config.entryScaleType       // User's choice for entry side
  );
  
  // Profit orders: size distribution follows profitScaleType
  // Total profit size = total entry size (to fully close all entries)
  const profitSizes = calculateScaledSizes(
    profitCount, 
    config.totalInvestment,     // Mirrors entry capital for full closure
    config.profitScaleType      // User's choice for profit side (independent!)
  );
  
  let entryIndex = 0;
  let profitIndex = 0;
  
  for (let i = 0; i < config.gridCount; i++) {
    const price = config.lowerPrice + (i * gridSpacing);
    const isEntryOrder = isLong ? (price < startPrice) : (price > startPrice);
    
    grids.push({
      level: i + 1,
      price: parseFloat(price.toFixed(4)),
      side: isLong 
        ? (price < startPrice ? 'buy' : 'sell')    // Long: buy below, sell above
        : (price > startPrice ? 'sell' : 'buy'),   // Short: sell above, buy below
      size: isEntryOrder 
        ? entrySizes[entryIndex++]   // Entry orders use entryScaleType
        : profitSizes[profitIndex++], // Profit orders use profitScaleType
      isReduceOnly: !isEntryOrder,   // Profit-taking orders are always reduce-only
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

/*
STATE TRACKING:

Rolling state is stored directly in the GridBotConfig (and gridBots table):
- lowestActiveBuyLevel: The lowest grid level with an active buy order
- highestActiveSellLevel: The highest grid level with an active sell order  
- nextBuyLevel: Next level to place when a buy fills (expands downward)
- nextSellLevel: Next level to place when a sell fills (expands upward)

This eliminates the need for a separate GridBotState interface - all state
is part of the bot configuration and persisted in the gridBots table schema.

See GridBotConfig interface above and gridBots schema below for field definitions.
*/

// Initial placement - places orders individually to capture orderIds
// (Scale orders could be used but require orderId mapping - see note below)
async function placeInitialGridOrders(
  config: GridBotConfig,
  grids: VirtualGrid[],
  startPrice: number
): Promise<void> {
  const buyGrids = grids
    .filter(g => g.price < startPrice && g.status === 'pending')
    .sort((a, b) => b.price - a.price)  // Closest to price first
    .slice(0, 16);
    
  const sellGrids = grids
    .filter(g => g.price > startPrice && g.status === 'pending')
    .sort((a, b) => a.price - b.price)  // Closest to price first
    .slice(0, 16);
  
  // Place each order individually using tracked placement
  // This captures driftOrderId for each grid level
  for (const grid of buyGrids) {
    await placeSingleOrderWithTracking(config, grid);
  }
  
  for (const grid of sellGrids) {
    await placeSingleOrderWithTracking(config, grid);
  }
  
  // Initialize rolling state
  const lowestBuy = buyGrids.length > 0 ? Math.min(...buyGrids.map(g => g.level)) : 0;
  const highestSell = sellGrids.length > 0 ? Math.max(...sellGrids.map(g => g.level)) : config.gridCount;
  
  await storage.updateGridBot(config.id, {
    lowestActiveBuyLevel: lowestBuy,
    highestActiveSellLevel: highestSell,
    nextBuyLevel: lowestBuy - 1,
    nextSellLevel: highestSell + 1,
  });
}

/*
NOTE ON SCALE ORDERS:

Drift's placeScaleOrders batches multiple orders in one transaction, which is 
more efficient but returns multiple orderIds. To use scale orders with our 
orderId tracking:

1. Call placeScaleOrders and capture the response
2. Response contains array of orderIds in price order
3. Map each orderId to corresponding grid level
4. Update each grid's driftOrderId

For simplicity, initial implementation uses individual order placement.
Scale order optimization can be added later if initial placement speed 
becomes a bottleneck.
*/
```

### 3. Order Management Loop (Unified with Auditable Fill Detection)

```typescript
/*
MAIN POLLING LOOP:
- Runs every 5 seconds for each active grid bot
- Uses orderId tracking for reliable fill detection
- Respects 32-order limit at all times
*/

async function gridOrderManagementLoop(botId: string): Promise<void> {
  const bot = await storage.getGridBot(botId);
  if (!bot || bot.status !== 'active') return;
  
  // Skip if range exhausted (all grids used)
  if (bot.status === 'range_exhausted') {
    return;
  }
  
  // Fetch grid levels (prices/sizes are immutable, status is mutable)
  const grids = await storage.getGridLevels(botId);
  
  // STEP 1: Detect filled and cancelled orders using orderId tracking
  const { filled, cancelled } = await detectFilledOrders(bot, grids);
  
  // STEP 2: Process state changes
  await processOrderStateChanges(bot, grids, filled, cancelled);
  
  // STEP 3: Check for partial fills (update filledSize for visibility)
  await checkPartialFills(bot, grids);
  
  // STEP 4: Rebalance to maintain optimal order distribution
  // Re-fetch grids after state changes
  const updatedGrids = await storage.getGridLevels(botId);
  await rebalanceActiveOrders(bot, updatedGrids);
  
  // STEP 5: Check for range exhaustion
  await handleRangeExhaustion(bot, updatedGrids);
}

// Place order and track orderId for fill detection
async function placeSingleOrderWithTracking(
  bot: GridBotConfig, 
  grid: VirtualGrid
): Promise<boolean> {
  try {
    const result = await driftClient.placePerpOrder({
      marketIndex: bot.marketIndex,
      direction: grid.side === 'buy' ? PositionDirection.LONG : PositionDirection.SHORT,
      orderType: OrderType.LIMIT,
      price: grid.price,                    // Pre-calculated
      baseAssetAmount: grid.size,           // Pre-calculated
      reduceOnly: grid.isReduceOnly,        // Pre-set
      postOnly: true,
    });
    
    // Store Drift's orderId for reliable fill tracking
    await storage.updateGridLevel(grid.id, { 
      status: 'active',
      driftOrderId: result.orderId,
    });
    
    return true;
  } catch (err) {
    console.error(`[GridBot] Failed to place order for level ${grid.level}: ${err.message}`);
    return false;
  }
}

// Handle filled grid - update state and queue expansion orders
// Note: Actual order placement happens in rebalanceActiveOrders to respect 32-order limit
async function handleFilledGrid(
  bot: GridBotConfig,
  filledGrid: VirtualGrid,
  grids: VirtualGrid[]
): Promise<void> {
  // Mark grid as filled
  await storage.updateGridLevel(filledGrid.id, { 
    status: 'filled',
    filledAt: new Date(),
    driftOrderId: null,
  });
  
  // Update rolling state based on which side filled
  if (filledGrid.side === 'buy') {
    // BUY filled - update nextBuyLevel to expand grid downward
    const newNextBuy = (bot.nextBuyLevel ?? filledGrid.level) - 1;
    await storage.updateGridBot(bot.id, {
      nextBuyLevel: Math.max(0, newNextBuy),
    });
    
    // Increment cycle count (buy+sell = 1 cycle, but track partial)
    console.log(`[GridBot ${bot.id}] Buy filled at level ${filledGrid.level}, price ${filledGrid.price}`);
    
  } else {
    // SELL (reduce-only) filled - profit taken!
    const newNextSell = (bot.nextSellLevel ?? filledGrid.level) + 1;
    await storage.updateGridBot(bot.id, {
      nextSellLevel: Math.min(bot.gridCount + 1, newNextSell),
      totalCycles: (bot.totalCycles ?? 0) + 1,
    });
    
    console.log(`[GridBot ${bot.id}] Sell filled at level ${filledGrid.level}, price ${filledGrid.price}`);
  }
  
  // Note: New orders will be placed by rebalanceActiveOrders in the main loop
  // This ensures we never exceed 32 orders
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

/*
REBALANCING LOGIC:
- Maintains optimal order distribution around current price
- NEVER exceeds 32 orders (Drift hard limit)
- Cancels far orders before placing new ones
*/

const MAX_ORDERS = 32;
const TARGET_PER_SIDE = 16;

async function rebalanceActiveOrders(bot: GridBotConfig, grids: VirtualGrid[]): Promise<void> {
  const currentPrice = await getCurrentMarketPrice(bot.market);
  const priceRange = bot.upperPrice - bot.lowerPrice;
  
  // Get current state
  const activeGrids = grids.filter(g => g.status === 'active');
  const pendingGrids = grids.filter(g => g.status === 'pending');
  
  // Track counts (will be updated as we cancel/place)
  let totalActive = activeGrids.length;
  let activeBuyCount = activeGrids.filter(g => g.side === 'buy').length;
  let activeSellCount = activeGrids.filter(g => g.side === 'sell').length;
  
  // STEP 1: Cancel far orders if we need room for closer ones
  // Only cancel if there are pending orders closer to price than active ones
  const ordersToCancel = determineOrdersToCancel(
    activeGrids, 
    pendingGrids, 
    currentPrice, 
    priceRange
  );
  
  for (const grid of ordersToCancel) {
    await cancelGridOrder(bot, grid);
    totalActive--;
    if (grid.side === 'buy') activeBuyCount--;
    else activeSellCount--;
  }
  
  // STEP 2: Calculate available slots (never exceed 32)
  const slotsAvailable = MAX_ORDERS - totalActive;
  
  if (slotsAvailable <= 0) {
    return;  // At limit, nothing to do
  }
  
  // STEP 3: Distribute slots between buys and sells
  const buyNeed = Math.max(0, TARGET_PER_SIDE - activeBuyCount);
  const sellNeed = Math.max(0, TARGET_PER_SIDE - activeSellCount);
  
  // Allocate proportionally, respecting available slots
  let buySlots = Math.min(buyNeed, Math.ceil(slotsAvailable / 2));
  let sellSlots = Math.min(sellNeed, slotsAvailable - buySlots);
  
  // STEP 4: Place orders (closest to current price first)
  let ordersPlaced = 0;
  
  if (buySlots > 0) {
    const pendingBuys = pendingGrids
      .filter(g => g.side === 'buy')
      .sort((a, b) => b.price - a.price);  // Closest to price first
      
    for (const grid of pendingBuys.slice(0, buySlots)) {
      if (ordersPlaced + totalActive >= MAX_ORDERS) break;  // Safety check
      const success = await placeSingleOrderWithTracking(bot, grid);
      if (success) ordersPlaced++;
    }
  }
  
  if (sellSlots > 0) {
    const pendingSells = pendingGrids
      .filter(g => g.side === 'sell')
      .sort((a, b) => a.price - b.price);  // Closest to price first
      
    for (const grid of pendingSells.slice(0, sellSlots)) {
      if (ordersPlaced + totalActive >= MAX_ORDERS) break;  // Safety check
      const success = await placeSingleOrderWithTracking(bot, grid);
      if (success) ordersPlaced++;
    }
  }
}

/*
CANCEL POLICY FOR RAPID VOLATILITY:

During rapid price moves, many orders may fill quickly. This policy ensures
we never exceed 32 orders while keeping orders close to current price.

Policy: Cancel up to 4 orders per cycle if needed
- This throttles cancellations to prevent order spam
- Combined with 5-second polling, adapts within 20-30 seconds
- If price moves faster than this, some distant orders remain (acceptable)
*/

function determineOrdersToCancel(
  activeGrids: VirtualGrid[],
  pendingGrids: VirtualGrid[],
  currentPrice: number,
  priceRange: number
): VirtualGrid[] {
  const toCancel: VirtualGrid[] = [];
  const MAX_CANCELS_PER_CYCLE = 4;  // Throttle to prevent order spam
  
  // Only cancel if we're at or near the 32-order limit
  if (activeGrids.length < MAX_ORDERS - 4) {
    return [];  // Plenty of room, no need to cancel
  }
  
  // Calculate distance from current price for each order
  const activeWithDistance = activeGrids.map(g => ({
    grid: g,
    distance: Math.abs(g.price - currentPrice) / priceRange,
  })).sort((a, b) => b.distance - a.distance);  // Furthest first
  
  const pendingWithDistance = pendingGrids.map(g => ({
    grid: g,
    distance: Math.abs(g.price - currentPrice) / priceRange,
  })).sort((a, b) => a.distance - b.distance);  // Closest first
  
  // Cancel furthest active orders if pending orders are significantly closer
  for (let i = 0; i < Math.min(activeWithDistance.length, MAX_CANCELS_PER_CYCLE); i++) {
    const furthest = activeWithDistance[i];
    const closest = pendingWithDistance[i];
    
    if (!furthest || !closest) break;
    
    // Cancel if pending is >10% of range closer than active
    if (furthest.distance - closest.distance > 0.1) {
      toCancel.push(furthest.grid);
    } else {
      break;  // No more beneficial swaps
    }
  }
  
  return toCancel;
}

// Safe cancel that updates grid state
async function cancelGridOrder(bot: GridBotConfig, grid: VirtualGrid): Promise<void> {
  try {
    if (grid.driftOrderId) {
      await driftClient.cancelOrder(bot.driftSubaccountId, grid.driftOrderId);
    }
  } catch (err) {
    // Order may already be filled/cancelled - proceed with state update
    console.log(`[GridBot] Cancel failed for order ${grid.driftOrderId}: ${err.message}`);
  }
  
  // Update state regardless (order is gone either way)
  await storage.updateGridLevel(grid.id, {
    status: 'pending',
    driftOrderId: null,
  });
}
```

### 3.1 Fill Detection Policy (Auditable)

```typescript
/*
FILL DETECTION POLICY:

We use Drift's orderId (not price matching) to detect fills reliably.

FLOW:
1. When placing order → store driftOrderId in grid level
2. Each poll cycle → get all open orders from Drift
3. For each grid with status='active':
   a. If driftOrderId NOT in open orders → order was filled or cancelled
   b. Verify by checking Drift order history or position change
4. Mark grid as 'filled' and place next order

WHY orderId TRACKING:
- Price matching is unsafe (multiple orders at same price possible)
- orderId is unique and definitive
- Drift's getOrderHistory can confirm fill vs cancel if needed

EDGE CASE: Order cancelled externally
- If orderId is gone but position didn't change → order was cancelled
- Reset grid to 'pending' so it can be re-placed
*/

async function detectFilledOrders(
  bot: GridBotConfig, 
  grids: VirtualGrid[]
): Promise<{ filled: VirtualGrid[]; cancelled: VirtualGrid[] }> {
  const activeOrders = await driftClient.getOpenOrders(bot.driftSubaccountId);
  const activeOrderIds = new Map(activeOrders.map(o => [o.orderId, o]));
  
  const filled: VirtualGrid[] = [];
  const cancelled: VirtualGrid[] = [];
  
  // Get current position for verification
  const position = await driftClient.getPosition(bot.marketIndex);
  const positionSize = position?.baseAssetAmount || 0;
  
  for (const grid of grids.filter(g => g.status === 'active' && g.driftOrderId)) {
    const order = activeOrderIds.get(grid.driftOrderId);
    
    if (!order) {
      // Order is gone - determine if filled or cancelled
      // Check order history for definitive answer
      const orderHistory = await driftClient.getOrderHistory(grid.driftOrderId);
      
      if (orderHistory?.status === 'filled') {
        filled.push(grid);
      } else {
        // Order was cancelled - reset to pending
        cancelled.push(grid);
      }
    }
  }
  
  return { filled, cancelled };
}

// Process detected fills and cancellations
async function processOrderStateChanges(
  bot: GridBotConfig,
  grids: VirtualGrid[],
  filled: VirtualGrid[],
  cancelled: VirtualGrid[]
): Promise<void> {
  // Handle filled orders - place next orders
  for (const grid of filled) {
    await handleFilledGrid(bot, grid, grids);
  }
  
  // Handle cancelled orders - reset to pending for re-placement
  for (const grid of cancelled) {
    await storage.updateGridLevel(grid.id, {
      status: 'pending',
      driftOrderId: null,
    });
  }
  
  // Rebalance will re-place cancelled orders if needed
}
```

### 3.2 Partial Fill Handling Policy

```typescript
/*
PARTIAL FILL POLICY:

Drift limit orders can be partially filled. Our strategy:

1. CHECK FOR PARTIAL FILLS: When an order is still active but has 
   baseAssetAmountFilled > 0, it's partially filled.

2. POLICY: Wait for full fill (recommended for simplicity)
   - Don't place new orders until the current level fully fills
   - Track filledSize for user visibility
   - If order sits partially filled too long, user can manually cancel

3. STATE TRACKING:
   - Grid stays 'active' while partially filled
   - filledSize updated each poll cycle
   - When order fully fills, transitions to 'filled'
*/

async function checkPartialFills(bot: GridBotConfig, grids: VirtualGrid[]): Promise<void> {
  const activeOrders = await driftClient.getOpenOrders(bot.driftSubaccountId);
  
  for (const order of activeOrders) {
    const grid = grids.find(g => g.driftOrderId === order.orderId);
    if (!grid) continue;
    
    if (order.baseAssetAmountFilled > 0) {
      // Track partial fill progress
      await storage.updateGridLevel(grid.id, {
        filledSize: order.baseAssetAmountFilled,
      });
      
      console.log(`[GridBot] Partial fill on level ${grid.level}: ${order.baseAssetAmountFilled}/${order.baseAssetAmount}`);
    }
  }
}
```

### 3.2 Range Exhaustion Handling

```typescript
/*
RANGE EXHAUSTION: What happens when grid boundaries are reached?

Scenario 1: All buy levels filled (price dumped through entire range)
- nextBuyLevel < 1 (no more buy levels)
- Bot continues with sell orders only
- When sells fill, they take profit but can't place new buys below range

Scenario 2: All sell levels filled (price pumped through entire range)  
- nextSellLevel > gridCount (no more sell levels)
- Bot continues with buy orders only (if any position remains)
- When buys fill, they add to position but can't place new sells above range

Scenario 3: Both sides exhausted
- No pending orders left
- Mark bot as 'range_exhausted'
- Notify user - they may want to:
  a) Close remaining position manually
  b) Create new grid bot with updated range
  c) Wait for price to return to range
*/

async function handleRangeExhaustion(bot: GridBotConfig, grids: VirtualGrid[]): Promise<void> {
  const pendingGrids = grids.filter(g => g.status === 'pending');
  const activeGrids = grids.filter(g => g.status === 'active');
  
  if (pendingGrids.length === 0 && activeGrids.length === 0) {
    // All grids used - range exhausted
    await storage.updateGridBot(bot.id, { status: 'range_exhausted' });
    
    // Notify user
    await notifyUser(bot.walletAddress, {
      type: 'grid_range_exhausted',
      message: `Grid bot "${bot.name}" has used all ${bot.gridCount} levels. Price has moved outside your range ($${bot.lowerPrice} - $${bot.upperPrice}).`,
      suggestion: 'Consider creating a new grid with an updated price range.',
    });
    
    return;
  }
  
  // One side exhausted - log but continue
  const pendingBuys = pendingGrids.filter(g => g.side === 'buy').length;
  const pendingSells = pendingGrids.filter(g => g.side === 'sell').length;
  
  if (pendingBuys === 0) {
    console.log(`[GridBot ${bot.id}] Buy side exhausted - price below range`);
  }
  if (pendingSells === 0) {
    console.log(`[GridBot ${bot.id}] Sell side exhausted - price above range`);
  }
}
```

### 4. Drift Scale Orders (Future Optimization)

Drift has built-in scale order functionality that could optimize initial placement:

```typescript
/*
SCALE ORDERS - POTENTIAL OPTIMIZATION:

Drift's placeScaleOrders places multiple orders in a single transaction.
This could speed up initial placement from ~32 transactions to 2.

IMPORTANT: To use scale orders with our orderId tracking system:

1. placeScaleOrders returns an array of orderIds
2. Map each orderId to corresponding grid level by price
3. Store driftOrderId in each grid level

Example integration (not used in initial implementation):
*/

interface ScaleOrderResult {
  orderIds: number[];        // Array of Drift orderIds
  prices: number[];          // Corresponding prices
}

async function placeScaleOrdersWithTracking(
  bot: GridBotConfig,
  grids: VirtualGrid[],
  side: 'buy' | 'sell'
): Promise<void> {
  const targetGrids = grids.filter(g => g.side === side && g.status === 'pending');
  if (targetGrids.length === 0) return;
  
  // Place scale orders
  const result: ScaleOrderResult = await driftClient.placeScaleOrders({
    marketIndex: bot.marketIndex,
    direction: side === 'buy' ? PositionDirection.LONG : PositionDirection.SHORT,
    baseAssetAmount: targetGrids.reduce((sum, g) => sum + g.size, 0),
    numOrders: targetGrids.length,
    startPrice: targetGrids[0].price,
    endPrice: targetGrids[targetGrids.length - 1].price,
    orderType: OrderType.LIMIT,
    reduceOnly: side === 'sell',  // Sells are reduce-only
    postOnly: true,
  });
  
  // Map orderIds to grid levels by matching prices
  for (let i = 0; i < result.orderIds.length; i++) {
    const grid = targetGrids.find(g => 
      Math.abs(g.price - result.prices[i]) < 0.0001
    );
    if (grid) {
      await storage.updateGridLevel(grid.id, {
        status: 'active',
        driftOrderId: result.orderIds[i],  // Critical for fill tracking!
      });
    }
  }
}
```

**Scale Order Advantages** (future optimization):
- Single transaction for multiple orders (faster initial setup)
- Built-in price distribution
- Lower transaction fees

**Current Implementation**: Uses individual order placement via 
`placeSingleOrderWithTracking` for simplicity and guaranteed orderId tracking.

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
  driftSubaccountId: integer("drift_subaccount_id").notNull(),
  
  // Configuration
  market: text("market").notNull(),
  marketIndex: integer("market_index").notNull(),
  upperPrice: decimal("upper_price").notNull(),
  lowerPrice: decimal("lower_price").notNull(),
  gridCount: integer("grid_count").notNull(),
  totalInvestment: decimal("total_investment").notNull(),
  startPrice: decimal("start_price").notNull(),  // Price when bot was created
  
  // Direction & Independent Scale Types
  direction: text("direction").notNull(),  // 'long' or 'short'
  entryScaleType: text("entry_scale_type").notNull(),   // ascending, descending, flat
  profitScaleType: text("profit_scale_type").notNull(), // ascending, descending, flat
  
  // Risk
  stopLossPercent: decimal("stop_loss_percent"),
  
  // Rolling State Tracking
  lowestActiveBuyLevel: integer("lowest_active_buy_level"),
  highestActiveSellLevel: integer("highest_active_sell_level"),
  nextBuyLevel: integer("next_buy_level"),
  nextSellLevel: integer("next_sell_level"),
  
  // Statistics
  status: text("status").notNull().default("active"),  // active, paused, stopped, range_exhausted
  totalCycles: integer("total_cycles").default(0),
  totalPnl: decimal("total_pnl").default("0"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Pre-calculated grid levels (IMMUTABLE after creation - prices and sizes never change)
export const gridLevels = pgTable("grid_levels", {
  id: varchar("id").primaryKey(),
  gridBotId: varchar("grid_bot_id").references(() => gridBots.id),
  
  // Pre-calculated at bot creation (IMMUTABLE)
  level: integer("level").notNull(),           // 1 = lowest price, N = highest
  price: decimal("price").notNull(),           // Pre-calculated price
  size: decimal("size").notNull(),             // Pre-calculated size (ascending/descending applied)
  side: text("side").notNull(),                // 'buy' or 'sell'
  isReduceOnly: boolean("is_reduce_only").notNull(),  // true for profit-taking orders
  
  // Mutable state
  status: text("status").notNull(),            // pending, active, filled, cancelled
  driftOrderId: integer("drift_order_id"),     // Drift's order ID when active (for tracking fills)
  
  // Fill tracking
  filledAt: timestamp("filled_at"),
  filledPrice: decimal("filled_price"),
  filledSize: decimal("filled_size"),          // For partial fill tracking
  
  createdAt: timestamp("created_at").defaultNow(),
});

// Index for fast lookups
// CREATE INDEX idx_grid_levels_bot_status ON grid_levels(grid_bot_id, status);
// CREATE INDEX idx_grid_levels_bot_level ON grid_levels(grid_bot_id, level);
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

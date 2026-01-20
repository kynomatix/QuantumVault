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

## Integration with Existing Bot Architecture

### Overview

Grid bots MUST leverage the existing bot architecture patterns rather than reinventing the wheel. The following systems are already implemented and tested:

1. **Subaccount Management**: Each bot uses a dedicated Drift subaccount for isolation
2. **Capital Deposits**: `executeAgentDriftDeposit`, `executeAgentTransferBetweenSubaccounts`
3. **PnL Settlement**: `settleAllPnl` frees up margin by settling unrealized PnL
4. **Leverage Configuration**: Per-bot leverage stored in schema with policy HMAC integrity
5. **Margin Checks**: Drift SDK rejects insufficient collateral orders with specific error codes

### Leverage Configuration (Match Existing Bots)

```typescript
/*
LEVERAGE CONFIGURATION - REUSE EXISTING PATTERNS

Existing trading_bots schema stores:
- leverage: integer("leverage").default(1).notNull()
- policyHmac: HMAC of (market, leverage, maxPositionSize) for integrity

Grid bots should follow the same pattern:
*/

interface GridBotConfig {
  // ... existing fields ...
  
  // Match trading_bots schema
  leverage: number;           // User-configured leverage (1-20 depending on market tier)
  totalInvestment: number;    // USDC amount deposited for this bot
  policyHmac: string;         // HMAC of (market, leverage, gridCount, etc.) for integrity
  
  // New fields for grid-specific config
  gridCount: number;
  upperPrice: number;
  lowerPrice: number;
  entryScaleType: 'ascending' | 'descending' | 'flat';
  profitScaleType: 'ascending' | 'descending' | 'flat';
}

// Grid bot creation validates leverage against market tier limits
async function validateGridBotLeverage(
  marketIndex: number,
  requestedLeverage: number
): Promise<{ valid: boolean; maxAllowed: number; error?: string }> {
  const marketInfo = await getMarketBySymbol(/* ... */);
  const maxLeverage = getMarketMaxLeverage(marketIndex);
  
  if (requestedLeverage > maxLeverage) {
    return {
      valid: false,
      maxAllowed: maxLeverage,
      error: `Max leverage for this market is ${maxLeverage}x`,
    };
  }
  
  return { valid: true, maxAllowed: maxLeverage };
}
```

### Initial Investment and Capital Flow (Match Existing Bots)

```typescript
/*
CAPITAL FLOW - LEVERAGE EXISTING PATTERNS

Existing bot creation flow (from server/routes.ts):
1. User configures bot with totalInvestment
2. System transfers USDC from main subaccount (0) to bot's subaccount
3. Bot trades within that capital allocation
4. PnL stays in subaccount (or withdrawn based on settings)

Grid bots should use the SAME capital flow:
*/

async function createGridBot(
  walletAddress: string,
  config: CreateGridBotRequest
): Promise<GridBot> {
  const wallet = await storage.getWallet(walletAddress);
  if (!wallet || !wallet.agentPublicKey) {
    throw new Error('Wallet not configured with agent wallet');
  }
  
  // STEP 1: Allocate subaccount (same as trading bots)
  const nextSubId = await getNextOnChainSubaccountId(wallet.agentPublicKey);
  
  // STEP 2: Transfer initial investment to subaccount
  // REUSE: executeAgentTransferBetweenSubaccounts from drift-service.ts
  const transferResult = await executeAgentTransferBetweenSubaccounts(
    wallet.agentPublicKey,
    0,                        // From main subaccount
    nextSubId,                // To bot subaccount
    config.totalInvestment    // Amount in USDC
  );
  
  if (!transferResult.success) {
    throw new Error(`Failed to transfer capital: ${transferResult.error}`);
  }
  
  // STEP 3: Calculate position sizing based on leverage
  // With 3x leverage and $1000 investment, max position = $3000 notional
  const maxNotionalValue = config.totalInvestment * config.leverage;
  
  // STEP 4: Create bot record with HMAC integrity check
  // REUSE: computeBotPolicyHmac from session-v3.ts
  const policyHmac = await computeBotPolicyHmac(
    walletAddress,
    config.market,
    config.leverage,
    maxNotionalValue
  );
  
  // STEP 5: Generate and store grid levels
  const grids = generateVirtualGridWithSizing({
    ...config,
    totalInvestment: maxNotionalValue,  // Use leveraged amount for sizing
  });
  
  // STEP 6: Store bot and grid levels
  const bot = await storage.createGridBot({
    walletAddress,
    driftSubaccountId: nextSubId,
    leverage: config.leverage,
    totalInvestment: config.totalInvestment,
    policyHmac,
    ...config,
  });
  
  await storage.storeGridLevels(bot.id, grids);
  
  return bot;
}
```

### PnL Settlement for Margin Management

```typescript
/*
PnL SETTLEMENT - LEVERAGE EXISTING settleAllPnl

In grid trading, continuous buy/sell cycles generate floating PnL.
This PnL is "unrealized" until settled, and doesn't free up margin.

When to settle PnL (REUSE existing patterns):
1. Before placing new orders if margin is tight
2. After a profit cycle completes (position returns to zero)
3. Periodically (every N minutes) to keep margin fluid
4. When bot detects InsufficientCollateral error

EXISTING FUNCTION: settleAllPnl(encryptedPrivateKey, subAccountId)
- Lives in: server/drift-service.ts
- Called by: routes.ts during reset, webhook after profit closes
*/

async function ensureSufficientMarginForGrid(
  bot: GridBotConfig,
  wallet: Wallet,
  requiredMargin: number
): Promise<{ success: boolean; error?: string }> {
  // STEP 1: Check current account health
  const accountInfo = await getDriftAccountInfo(wallet.agentPublicKey, bot.driftSubaccountId);
  const freeCollateral = accountInfo.freeCollateral;
  
  if (freeCollateral >= requiredMargin) {
    return { success: true };
  }
  
  // STEP 2: Try settling PnL to free up margin
  // REUSE: settleAllPnl from drift-service.ts
  console.log(`[GridBot] Low margin ($${freeCollateral}), settling PnL...`);
  
  const settleResult = await settleAllPnl(
    wallet.agentPublicKey,
    bot.driftSubaccountId
  );
  
  if (settleResult.success) {
    console.log(`[GridBot] Settled PnL for ${settleResult.settledMarkets?.length || 0} market(s)`);
  }
  
  // STEP 3: Re-check margin after settlement
  const updatedInfo = await getDriftAccountInfo(wallet.agentPublicKey, bot.driftSubaccountId);
  
  if (updatedInfo.freeCollateral >= requiredMargin) {
    return { success: true };
  }
  
  // STEP 4: Still not enough - pause bot and notify user
  return {
    success: false,
    error: `Insufficient margin after PnL settlement. Need $${requiredMargin}, have $${updatedInfo.freeCollateral}`,
  };
}

// Integrate into order placement flow
async function placeGridOrderWithMarginCheck(
  bot: GridBotConfig,
  grid: VirtualGrid,
  wallet: Wallet
): Promise<OrderPlacementResult> {
  // Calculate margin needed for this order
  const marginRequired = calculateMarginRequired(grid.size, grid.price, bot.leverage);
  
  // Ensure sufficient margin (may settle PnL)
  const marginCheck = await ensureSufficientMarginForGrid(bot, wallet, marginRequired);
  
  if (!marginCheck.success) {
    // Pause bot - can't place orders without margin
    await storage.updateGridBot(bot.id, { status: 'paused' });
    await notifyUser(wallet.address, {
      type: 'grid_insufficient_margin',
      message: marginCheck.error,
    });
    return { success: false, error: 'insufficient_margin', retryable: false };
  }
  
  // Place order using existing error handling patterns
  return await placeSingleOrderWithRetry(bot, grid);
}
```

### Automatic PnL Settlement Triggers

```typescript
/*
AUTO-SETTLEMENT TRIGGERS:

1. AFTER PROFIT CYCLE COMPLETES (position returns to zero)
   - Already implemented in calculateGridBotPnL
   - Add settlement call when cycle detected

2. ON INSUFFICIENT MARGIN ERROR
   - Handle Drift error 6010 (InsufficientCollateral)
   - Settle PnL and retry

3. PERIODIC MAINTENANCE (every 10 minutes)
   - Settle any floating PnL to keep margin fluid
   - Prevents margin squeeze during volatile periods

4. BEFORE MAJOR OPERATIONS
   - Before adding more capital
   - Before stopping bot and withdrawing
*/

async function periodicGridBotMaintenance(botId: string): Promise<void> {
  const bot = await storage.getGridBot(botId);
  if (!bot || bot.status !== 'active') return;
  
  const wallet = await storage.getWallet(bot.walletAddress);
  if (!wallet?.agentPublicKey) return;
  
  // Settle any floating PnL
  try {
    const settleResult = await settleAllPnl(
      wallet.agentPublicKey,
      bot.driftSubaccountId
    );
    
    if (settleResult.success && settleResult.settledMarkets?.length > 0) {
      console.log(`[GridBot Maintenance] Settled PnL for ${settleResult.settledMarkets.length} market(s)`);
    }
  } catch (err: any) {
    // Non-fatal - log and continue
    console.warn(`[GridBot Maintenance] PnL settlement error: ${err.message}`);
  }
}

// Schedule: Run every 10 minutes for active grid bots
// setInterval(() => runForAllActiveGridBots(periodicGridBotMaintenance), 10 * 60 * 1000);
```

### Margin Calculation for Grid Orders

```typescript
/*
MARGIN CALCULATION:

For perpetual futures with leverage:
  Margin Required = (Order Size × Price) / Leverage

Example:
- Order: Buy 0.1 BTC at $50,000
- Leverage: 5x
- Margin = (0.1 × 50000) / 5 = $1,000 USDC
*/

function calculateMarginRequired(
  size: number,
  price: number,
  leverage: number
): number {
  const notionalValue = size * price;
  const marginRequired = notionalValue / leverage;
  
  // Add 10% buffer for price movement and fees
  return marginRequired * 1.10;
}

// Calculate total margin needed for initial grid placement
function calculateInitialMarginRequirement(
  grids: VirtualGrid[],
  leverage: number,
  direction: 'long' | 'short'
): number {
  // Only entry orders need margin (buys for long, sells for short)
  const entryGrids = grids.filter(g => 
    direction === 'long' ? g.side === 'buy' : g.side === 'sell'
  );
  
  // Sum margin for all entry orders
  let totalMargin = 0;
  for (const grid of entryGrids) {
    totalMargin += calculateMarginRequired(grid.size, grid.price, leverage);
  }
  
  return totalMargin;
}
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
// Uses VirtualGrid interface defined above

/*
CRITICAL INVARIANT: SIZE CONTINUITY

Every grid level (1 to gridCount) is assigned a FIXED price and size at bot creation.
These values NEVER change, regardless of:
- When the order is placed (initial 16 or later expansion)
- Current market price
- Which orders have filled

This guarantees that when order 17 is placed after a fill, it gets the SAME size
it would have had if placed initially - the ascending/descending pattern continues
perfectly because all sizes were pre-calculated for the entire grid.

Level → Price → Size mapping is IMMUTABLE after bot creation.
*/

// Called ONCE when bot is created - stores all levels WITH sizes
function calculateAndStoreGridLevels(config: GridBotConfig, startPrice: number): VirtualGrid[] {
  const grids: VirtualGrid[] = [];
  const priceRange = config.upperPrice - config.lowerPrice;
  const gridSpacing = priceRange / (config.gridCount - 1);
  
  /*
  BOUNDARY HANDLING:
  
  For LONG grid: Entry = Buy (below startPrice), Profit = Sell (above startPrice)
  For SHORT grid: Entry = Sell (above startPrice), Profit = Buy (below startPrice)
  
  CRITICAL RULE: The grid level at exactly startPrice belongs to PROFIT side.
  This is enforced by using strict < comparison, not <=.
  
  If startPrice is between grid levels (most common), this is straightforward.
  If startPrice is exactly on a grid level, that level becomes the first profit level.
  */
  
  const isLong = config.direction === 'long';
  
  // Calculate entry/profit split based on direction
  // For LONG: entry levels are price < startPrice
  // For SHORT: entry levels are price > startPrice
  const allLevelPrices: number[] = [];
  for (let i = 0; i < config.gridCount; i++) {
    allLevelPrices.push(config.lowerPrice + (i * gridSpacing));
  }
  
  // Count levels on each side using consistent boundary rule
  // STRICT LESS THAN for entry (< not <=) ensures boundary level goes to profit
  const entryLevels = allLevelPrices.filter(p => isLong ? (p < startPrice) : (p > startPrice));
  const profitLevels = allLevelPrices.filter(p => isLong ? (p >= startPrice) : (p <= startPrice));
  
  const entryCount = entryLevels.length;
  const profitCount = profitLevels.length;
  
  // EDGE CASE: Handle when startPrice is at or beyond grid boundaries
  // If entryCount = 0: All grids are profit-taking (warn user, but valid)
  // If profitCount = 0: All grids are entry (warn user, no profit-taking possible)
  if (entryCount === 0) {
    console.warn(`[GridBot] No entry levels - startPrice ${startPrice} is at/below grid bottom`);
  }
  if (profitCount === 0) {
    console.warn(`[GridBot] No profit levels - startPrice ${startPrice} is at/above grid top`);
  }
  
  // Calculate entry sizes using full capital
  const entrySizes = entryCount > 0 
    ? calculateScaledSizes(entryCount, config.totalInvestment, config.entryScaleType)
    : [];
  
  /*
  PROFIT SIZE CALCULATION:
  
  Profit orders are reduce-only - they close entry positions.
  The TOTAL profit size must equal TOTAL entry size to fully close all entries.
  
  However, individual profit order sizes follow profitScaleType distribution.
  This means:
  - Sum of all profit sizes = Sum of all entry sizes = totalInvestment
  - But distribution within profit side can differ from entry side
  
  Example with 50 entry grids, 50 profit grids:
  - Entry ascending: Largest buys at bottom, smallest near start
  - Profit descending: Largest sells near start, smallest at top
  - Both sides sum to totalInvestment, but distributed differently
  
  PARTIAL FILL CONSIDERATION:
  If not all entries fill, reduce-only orders will naturally limit sells
  to actual position size. Extra profit orders simply won't execute.
  */
  const profitSizes = profitCount > 0
    ? calculateScaledSizes(profitCount, config.totalInvestment, config.profitScaleType)
    : [];
  
  // Build grid levels with explicit entry/profit assignment
  let entryIndex = 0;
  let profitIndex = 0;
  
  for (let i = 0; i < config.gridCount; i++) {
    const price = allLevelPrices[i];
    
    // Use same boundary rule as count calculation
    const isEntryLevel = isLong ? (price < startPrice) : (price > startPrice);
    
    const side = isLong
      ? (price < startPrice ? 'buy' : 'sell')
      : (price > startPrice ? 'sell' : 'buy');
    
    // Size comes from pre-calculated arrays - indices guaranteed to match
    const size = isEntryLevel
      ? (entryIndex < entrySizes.length ? entrySizes[entryIndex++] : 0)
      : (profitIndex < profitSizes.length ? profitSizes[profitIndex++] : 0);
    
    grids.push({
      id: generateId(),
      level: i + 1,
      price: parseFloat(price.toFixed(4)),
      side,
      size,
      isReduceOnly: !isEntryLevel,
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
  /*
  BOUNDARY RULE ENFORCEMENT:
  - Buys: price < startPrice (strict less than)
  - Sells: price >= startPrice (greater than OR EQUAL)
  
  This ensures if startPrice is exactly on a grid level, that level is
  treated as profit (sell) side, not entry (buy) side.
  
  This matches the boundary rule in grid generation: the level at exactly
  startPrice belongs to the profit side.
  */
  
  const isLong = config.direction === 'long';
  
  // For LONG: buys are entries (< startPrice), sells are profits (>= startPrice)
  // For SHORT: sells are entries (> startPrice), buys are profits (<= startPrice)
  const buyGrids = grids
    .filter(g => {
      if (isLong) {
        return g.side === 'buy' && g.price < startPrice && g.status === 'pending';
      } else {
        return g.side === 'buy' && g.price <= startPrice && g.status === 'pending';
      }
    })
    .sort((a, b) => b.price - a.price)  // Closest to price first
    .slice(0, 16);
    
  const sellGrids = grids
    .filter(g => {
      if (isLong) {
        return g.side === 'sell' && g.price >= startPrice && g.status === 'pending';
      } else {
        return g.side === 'sell' && g.price > startPrice && g.status === 'pending';
      }
    })
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
  const { filled, cancelled, fillDetails } = await detectFilledOrders(bot, grids);
  
  // STEP 2: Process state changes (includes full fill recording)
  await processOrderStateChanges(bot, grids, filled, cancelled, fillDetails);
  
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
      // NOTE: Do NOT increment totalCycles here!
      // Cycles are calculated dynamically from fills in calculateGridBotPnL
      // A cycle completes when position returns to zero, not on every sell fill
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
  
  /*
  STEP 4: Place orders using DETERMINISTIC SEQUENTIAL PLACEMENT
  
  CRITICAL ALGORITHM:
  
  We generate an explicit ordered list of levels to place, starting from
  the current next* level and working outward. This guarantees:
  - No levels are skipped
  - The ascending/descending size pattern is preserved
  - Missing/cancelled levels are handled correctly
  
  For buys: [nextBuyLevel, nextBuyLevel-1, nextBuyLevel-2, ...]
  For sells: [nextSellLevel, nextSellLevel+1, nextSellLevel+2, ...]
  */
  
  let ordersPlaced = 0;
  
  if (buySlots > 0) {
    // Generate deterministic buy level sequence
    const buyLevelsToPlace = generateBuyLevelSequence(
      bot.nextBuyLevel ?? 0,
      pendingGrids.filter(g => g.side === 'buy'),
      buySlots
    );
    
    for (const level of buyLevelsToPlace) {
      if (ordersPlaced + totalActive >= MAX_ORDERS) break;
      
      const grid = pendingGrids.find(g => g.side === 'buy' && g.level === level);
      if (grid) {
        const success = await placeSingleOrderWithTracking(bot, grid);
        if (success) ordersPlaced++;
      }
    }
  }
  
  if (sellSlots > 0) {
    // Generate deterministic sell level sequence
    const sellLevelsToPlace = generateSellLevelSequence(
      bot.nextSellLevel ?? bot.gridCount,
      pendingGrids.filter(g => g.side === 'sell'),
      sellSlots
    );
    
    for (const level of sellLevelsToPlace) {
      if (ordersPlaced + totalActive >= MAX_ORDERS) break;
      
      const grid = pendingGrids.find(g => g.side === 'sell' && g.level === level);
      if (grid) {
        const success = await placeSingleOrderWithTracking(bot, grid);
        if (success) ordersPlaced++;
      }
    }
  }
  
  // STEP 5: After placement, recalculate state to ensure consistency
  await recalculateGridBotState(bot.id, grids);
}

/*
DETERMINISTIC LEVEL SEQUENCE GENERATION:

Generate ordered list of levels to place, starting from next* and working outward.
Skips levels that are already filled or active (not pending).
*/

function generateBuyLevelSequence(
  startLevel: number,
  pendingBuys: VirtualGrid[],
  maxCount: number
): number[] {
  const pendingLevelSet = new Set(pendingBuys.map(g => g.level));
  const sequence: number[] = [];
  
  // CRITICAL: If startLevel is invalid (0 or out of range), derive from pending levels
  // Use highest pending buy level (closest to price) as starting point
  let level = startLevel;
  if (level <= 0 || !pendingLevelSet.has(level)) {
    const pendingLevels = Array.from(pendingLevelSet);
    if (pendingLevels.length === 0) return [];
    level = Math.max(...pendingLevels);  // Start from highest pending
  }
  
  // Start from level and work DOWN
  while (sequence.length < maxCount && level >= 1) {
    if (pendingLevelSet.has(level)) {
      sequence.push(level);
    }
    // If level is not pending (filled/active), skip it - don't break
    level--;
  }
  
  return sequence;
}

function generateSellLevelSequence(
  startLevel: number,
  pendingSells: VirtualGrid[],
  maxCount: number
): number[] {
  const pendingLevelSet = new Set(pendingSells.map(g => g.level));
  const sequence: number[] = [];
  
  // CRITICAL: If startLevel is invalid or out of range, derive from pending levels
  // Use lowest pending sell level (closest to price) as starting point
  let level = startLevel;
  const pendingLevels = Array.from(pendingLevelSet);
  if (pendingLevels.length === 0) return [];
  
  const minPending = Math.min(...pendingLevels);
  const maxPending = Math.max(...pendingLevels);
  
  if (level > maxPending || level <= 0 || !pendingLevelSet.has(level)) {
    level = minPending;  // Start from lowest pending (closest to price)
  }
  
  // Start from level and work UP
  while (sequence.length < maxCount && level <= maxPending) {
    if (pendingLevelSet.has(level)) {
      sequence.push(level);
    }
    // If level is not pending (filled/active), skip it - don't break
    level++;
  }
  
  return sequence;
}

/*
STATE RECALCULATION:

After each rebalance cycle, recalculate state from actual grid statuses.
This prevents drift between next* values and actual active/pending levels.
*/

async function recalculateGridBotState(botId: string, grids: VirtualGrid[]): Promise<void> {
  const activeGrids = grids.filter(g => g.status === 'active');
  const pendingGrids = grids.filter(g => g.status === 'pending');
  
  const activeBuys = activeGrids.filter(g => g.side === 'buy');
  const activeSells = activeGrids.filter(g => g.side === 'sell');
  const pendingBuys = pendingGrids.filter(g => g.side === 'buy');
  const pendingSells = pendingGrids.filter(g => g.side === 'sell');
  
  // Calculate current boundaries
  const lowestActiveBuyLevel = activeBuys.length > 0
    ? Math.min(...activeBuys.map(g => g.level))
    : 0;
  const highestActiveSellLevel = activeSells.length > 0
    ? Math.max(...activeSells.map(g => g.level))
    : 0;
  
  // Calculate next levels (next pending below/above current active range)
  const nextBuyLevel = pendingBuys.length > 0
    ? Math.max(...pendingBuys.map(g => g.level))  // Highest pending buy (closest to price)
    : 0;
  const nextSellLevel = pendingSells.length > 0
    ? Math.min(...pendingSells.map(g => g.level)) // Lowest pending sell (closest to price)
    : grids.length;
  
  await storage.updateGridBot(botId, {
    lowestActiveBuyLevel,
    highestActiveSellLevel,
    nextBuyLevel,
    nextSellLevel,
  });
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
): Promise<{ filled: VirtualGrid[]; cancelled: VirtualGrid[]; fillDetails: Map<string, OrderHistoryRecord> }> {
  /*
  FILL DETECTION - UNIFIED WITH RATE-LIMITED HELPERS
  
  Uses rate-limited API wrapper for all Drift calls to prevent rate limiting.
  Stores fill details for accurate PnL recording.
  */
  
  const activeOrders = await rateLimitedClient.executeWithRateLimit(
    () => driftClient.getOpenOrders(bot.driftSubaccountId)
  );
  const activeOrderIds = new Map(activeOrders.map(o => [o.orderId, o]));
  
  const filled: VirtualGrid[] = [];
  const cancelled: VirtualGrid[] = [];
  const fillDetails = new Map<string, OrderHistoryRecord>();
  
  for (const grid of grids.filter(g => g.status === 'active' && g.driftOrderId)) {
    const order = activeOrderIds.get(grid.driftOrderId);
    
    if (!order) {
      // Order is gone - determine if filled or cancelled
      // Use rate-limited, paginated helper for order history
      const orderHistory = await getCompleteOrderHistory(
        bot.driftSubaccountId,
        grid.driftOrderId
      );
      
      if (orderHistory?.status === 'filled') {
        filled.push(grid);
        // Store fill details for PnL recording
        fillDetails.set(grid.id, orderHistory);
      } else if (orderHistory?.status === 'cancelled' || orderHistory?.status === 'expired') {
        cancelled.push(grid);
      } else {
        // Could not determine status - log warning and treat as cancelled
        // (reconciliation will fix if this was actually a fill)
        console.warn(`[GridBot] Unknown order status for ${grid.driftOrderId}, treating as cancelled`);
        cancelled.push(grid);
      }
    }
  }
  
  return { filled, cancelled, fillDetails };
}

// Process detected fills and cancellations
async function processOrderStateChanges(
  bot: GridBotConfig,
  grids: VirtualGrid[],
  filled: VirtualGrid[],
  cancelled: VirtualGrid[],
  fillDetails: Map<string, OrderHistoryRecord>
): Promise<void> {
  // Handle filled orders - record fill and queue expansion
  for (const grid of filled) {
    const details = fillDetails.get(grid.id);
    
    // CRITICAL: Record full fill to gridFills for accurate PnL tracking
    // This completes any partial fills and ensures cost basis is correct
    await recordFullFill(grid, bot, details);
    
    // Then handle the grid state transition
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
PARTIAL FILL POLICY - CLARIFIED:

Grid bots face a unique partial fill challenge: if entries partially fill
but profits fully fill, the position can become unbalanced.

CHOSEN POLICY: WAIT FOR FULL FILL + TRACK PARTIAL SIZES

1. Grid stays 'active' while order is partially filled
2. Track filledSize for visibility and PnL accuracy
3. Record partial fills to gridFills table for accurate cost basis
4. Order remains in 32-order count until fully filled or cancelled
5. User can manually cancel partial fills if desired

WHY NOT IMMEDIATE REPLACEMENT:
- Replacing partial fills adds complexity (cancel + new order)
- Partially filled orders are still providing liquidity
- Most orders eventually fill fully in active markets

PnL IMPLICATION:
- Partial fills are recorded with their actual fill prices
- Cost basis uses weighted average of all fills
- This prevents incorrect PnL from treating partial fills differently

REDUCE-ONLY BEHAVIOR:
- Reduce-only profit orders naturally limit to actual position size
- If entries only partially filled, excess profit orders won't execute
- This is safe and expected behavior
*/

async function checkPartialFills(bot: GridBotConfig, grids: VirtualGrid[]): Promise<void> {
  const activeOrders = await driftClient.getOpenOrders(bot.driftSubaccountId);
  
  for (const order of activeOrders) {
    const grid = grids.find(g => g.driftOrderId === order.orderId);
    if (!grid) continue;
    
    const previousFilledSize = grid.filledSize || 0;
    const currentFilledSize = order.baseAssetAmountFilled || 0;
    
    // Only process if there's new fill activity
    if (currentFilledSize > previousFilledSize) {
      const newFillSize = currentFilledSize - previousFilledSize;
      
      // Record the partial fill for PnL tracking
      await storage.insertGridFill({
        gridLevelId: grid.id,
        gridBotId: bot.id,
        side: grid.side,
        price: order.avgFillPrice || grid.price,  // Use actual fill price
        size: newFillSize,
        fee: estimateFee(newFillSize, order.avgFillPrice || grid.price),
        feeAsset: 'USDC',
        filledAt: new Date(),
        isPartial: true,
      });
      
      // Update grid's tracked filled size
      await storage.updateGridLevel(grid.id, {
        filledSize: currentFilledSize,
      });
      
      console.log(`[GridBot] Partial fill on level ${grid.level}: ${currentFilledSize}/${order.baseAssetAmount}`);
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

## Crash Recovery and State Reconciliation

### Startup Reconciliation Procedure

When the server restarts, grid bot state may be out of sync with on-chain state:

```typescript
/*
STARTUP RECONCILIATION:

After server crash/restart, the database may have stale order state.
This procedure rehydrates state from Drift and fixes inconsistencies.
*/

async function reconcileGridBotOnStartup(botId: string): Promise<void> {
  const bot = await storage.getGridBot(botId);
  if (!bot || bot.status === 'stopped') return;
  
  const grids = await storage.getGridLevels(botId);
  
  // STEP 1: Fetch all open orders from Drift
  const openOrders = await driftClient.getOpenOrders(bot.driftSubaccountId);
  const openOrderMap = new Map(openOrders.map(o => [o.orderId, o]));
  
  // STEP 2: Reconcile each grid level
  for (const grid of grids) {
    if (grid.status === 'active') {
      if (!grid.driftOrderId || !openOrderMap.has(grid.driftOrderId)) {
        // Order is gone - was it filled or cancelled?
        const history = await driftClient.getOrderHistory(grid.driftOrderId);
        
        if (history?.status === 'filled') {
          await storage.updateGridLevel(grid.id, {
            status: 'filled',
            filledAt: new Date(history.filledAt),
            filledPrice: history.avgFillPrice,
            driftOrderId: null,
          });
        } else {
          // Order was cancelled or expired - reset to pending
          await storage.updateGridLevel(grid.id, {
            status: 'pending',
            driftOrderId: null,
          });
        }
      }
    }
  }
  
  // STEP 3: Find orphaned orders (on-chain but not in DB)
  const trackedOrderIds = new Set(
    grids.filter(g => g.driftOrderId).map(g => g.driftOrderId)
  );
  
  for (const order of openOrders) {
    if (!trackedOrderIds.has(order.orderId)) {
      // Orphan order - match by price to grid level
      const matchingGrid = grids.find(g => 
        Math.abs(g.price - order.price) < 0.0001 && g.status === 'pending'
      );
      
      if (matchingGrid) {
        await storage.updateGridLevel(matchingGrid.id, {
          status: 'active',
          driftOrderId: order.orderId,
        });
      } else {
        // No matching grid - cancel orphan order
        console.log(`[GridBot] Cancelling orphan order ${order.orderId}`);
        await driftClient.cancelOrder(bot.driftSubaccountId, order.orderId);
      }
    }
  }
  
  // STEP 4: Recalculate rolling state
  const activeGrids = await storage.getGridLevels(botId);
  const activeBuys = activeGrids.filter(g => g.status === 'active' && g.side === 'buy');
  const activeSells = activeGrids.filter(g => g.status === 'active' && g.side === 'sell');
  
  await storage.updateGridBot(bot.id, {
    lowestActiveBuyLevel: activeBuys.length > 0 
      ? Math.min(...activeBuys.map(g => g.level)) 
      : 0,
    highestActiveSellLevel: activeSells.length > 0 
      ? Math.max(...activeSells.map(g => g.level)) 
      : bot.gridCount,
  });
  
  console.log(`[GridBot] Reconciliation complete for ${botId}`);
}

// Call on server startup for all active grid bots
async function reconcileAllGridBotsOnStartup(): Promise<void> {
  const activeBots = await storage.getGridBotsByStatus(['active', 'paused']);
  
  for (const bot of activeBots) {
    try {
      await reconcileGridBotOnStartup(bot.id);
    } catch (err) {
      console.error(`[GridBot] Reconciliation failed for ${bot.id}:`, err);
      // Mark as needing attention
      await storage.updateGridBot(bot.id, { status: 'paused' });
    }
  }
}
```

### Periodic Full Reconciliation

Run every 5 minutes to catch any state drift:

```typescript
async function periodicReconciliation(): Promise<void> {
  const activeBots = await storage.getGridBotsByStatus(['active']);
  
  for (const bot of activeBots) {
    // Light reconciliation - just verify order counts match
    const grids = await storage.getGridLevels(bot.id);
    const dbActiveCount = grids.filter(g => g.status === 'active').length;
    
    const openOrders = await driftClient.getOpenOrders(bot.driftSubaccountId);
    const onChainCount = openOrders.length;
    
    if (dbActiveCount !== onChainCount) {
      console.log(`[GridBot] State mismatch for ${bot.id}: DB=${dbActiveCount}, Chain=${onChainCount}`);
      await reconcileGridBotOnStartup(bot.id);  // Full reconciliation
    }
  }
}

// Schedule: setInterval(periodicReconciliation, 5 * 60 * 1000);
```

---

## Drift Protocol Failure Modes

### Order Placement Failures

```typescript
/*
DRIFT SDK FAILURE MODES AND HANDLING:

1. POST-ONLY REJECTION
   - Occurs when order would immediately fill (cross the spread)
   - Solution: Retry with slightly better price, or skip and wait

2. INSUFFICIENT MARGIN
   - Account doesn't have enough collateral
   - Solution: Pause bot, notify user, wait for deposit

3. ORDER EXPIRED
   - Order sat too long without filling
   - Solution: Detect in reconciliation, reset to pending

4. RPC FAILURE
   - Network issues, rate limiting, node unavailable
   - Solution: Exponential backoff retry (max 3 attempts)

5. PARTIAL FILL TIMEOUT
   - Order partially filled but remaining stuck
   - Solution: Track partial fills, user can cancel remainder

6. ACCOUNT NOT INITIALIZED
   - Subaccount doesn't exist
   - Solution: Initialize before first trade
*/

interface OrderPlacementResult {
  success: boolean;
  orderId?: number;
  error?: 'post_only_rejected' | 'insufficient_margin' | 'rpc_failure' | 'unknown';
  retryable: boolean;
}

async function placeSingleOrderWithRetry(
  bot: GridBotConfig,
  grid: VirtualGrid,
  maxRetries: number = 3
): Promise<OrderPlacementResult> {
  let lastError: string | undefined;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await driftClient.placePerpOrder({
        marketIndex: bot.marketIndex,
        direction: grid.side === 'buy' ? PositionDirection.LONG : PositionDirection.SHORT,
        orderType: OrderType.LIMIT,
        price: grid.price,
        baseAssetAmount: grid.size,
        reduceOnly: grid.isReduceOnly,
        postOnly: true,
      });
      
      await storage.updateGridLevel(grid.id, {
        status: 'active',
        driftOrderId: result.orderId,
      });
      
      return { success: true, orderId: result.orderId, retryable: false };
      
    } catch (err) {
      lastError = err.message;
      
      // Parse Drift error codes
      if (err.message.includes('PostOnlyWouldFill') || err.code === 6081) {
        // Post-only rejected - price moved, not retryable immediately
        return { success: false, error: 'post_only_rejected', retryable: false };
      }
      
      if (err.message.includes('InsufficientCollateral') || err.code === 6010) {
        // Not enough margin - pause bot
        await storage.updateGridBot(bot.id, { status: 'paused' });
        await notifyUser(bot.walletAddress, {
          type: 'grid_insufficient_margin',
          message: `Grid bot paused: insufficient margin to place orders.`,
        });
        return { success: false, error: 'insufficient_margin', retryable: false };
      }
      
      // RPC/network error - retryable with backoff
      console.log(`[GridBot] Order placement attempt ${attempt} failed: ${err.message}`);
      
      if (attempt < maxRetries) {
        await sleep(1000 * Math.pow(2, attempt));  // Exponential backoff
      }
    }
  }
  
  console.error(`[GridBot] Order placement failed after ${maxRetries} attempts: ${lastError}`);
  return { success: false, error: 'rpc_failure', retryable: true };
}
```

### Handling Order Expiry

```typescript
/*
ORDER EXPIRY:

Drift limit orders can expire. Our handling:
- Default: Use GTC (Good Till Cancel) orders - no expiry
- If order expires before fill: Detect in reconciliation, reset to pending
- Periodic reconciliation will re-place the order
*/

// When fetching order history, check for expired status
async function detectExpiredOrders(bot: GridBotConfig, grids: VirtualGrid[]): Promise<VirtualGrid[]> {
  const expired: VirtualGrid[] = [];
  
  for (const grid of grids.filter(g => g.status === 'active' && g.driftOrderId)) {
    try {
      const history = await driftClient.getOrderHistory(grid.driftOrderId);
      
      if (history?.status === 'expired' || history?.status === 'cancelled') {
        expired.push(grid);
      }
    } catch (err) {
      // If we can't get history, check if order exists
      const openOrders = await driftClient.getOpenOrders(bot.driftSubaccountId);
      if (!openOrders.find(o => o.orderId === grid.driftOrderId)) {
        expired.push(grid);
      }
    }
  }
  
  return expired;
}
```

---

## Financial Tracking and PnL

### Fee Tracking and Fill Recording

```typescript
/*
FULL FILL RECORDING:

When an order fully fills, we must record the final fill to gridFills.
This ensures complete PnL tracking even if we missed some partial fills.

The recordFullFill function calculates the remaining unfilled portion
and records it, ensuring the sum of all fills equals the original order size.
*/

async function recordFullFill(
  grid: VirtualGrid,
  bot: GridBotConfig,
  fillDetails: OrderHistoryRecord | undefined
): Promise<void> {
  // Get previously recorded partial fills for this grid
  const existingFills = await storage.getGridFillsByLevel(grid.id);
  const alreadyRecordedSize = existingFills.reduce((sum, f) => sum + Number(f.size), 0);
  
  // Calculate remaining size to record
  const totalOrderSize = Number(grid.size);
  const remainingSize = totalOrderSize - alreadyRecordedSize;
  
  if (remainingSize <= 0.000001) {
    // Already fully recorded (from partial fills)
    return;
  }
  
  // Use fill details for accurate price, or fall back to grid price
  const fillPrice = fillDetails?.avgFillPrice || grid.price;
  
  // Record the remaining portion of the fill
  await storage.insertGridFill({
    gridLevelId: grid.id,
    gridBotId: bot.id,
    side: grid.side,
    price: fillPrice,
    size: remainingSize,
    fee: estimateFee(remainingSize, fillPrice),
    feeAsset: 'USDC',
    filledAt: fillDetails?.filledAt ? new Date(fillDetails.filledAt) : new Date(),
    isPartial: false,
  });
  
  // Update bot's total fees
  await storage.incrementGridBotFees(bot.id, estimateFee(remainingSize, fillPrice));
  
  console.log(`[GridBot] Recorded full fill for level ${grid.level}: ${remainingSize} at ${fillPrice}`);
}

interface GridFillRecord {
  gridLevelId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  fee: number;          // Maker/taker fee paid
  feeAsset: 'USDC';
  timestamp: Date;
}

// Fee calculation per fill
async function recordGridFill(
  grid: VirtualGrid,
  fillDetails: DriftFillEvent
): Promise<void> {
  const fee = calculateFee(fillDetails);
  
  await storage.insertGridFill({
    gridLevelId: grid.id,
    gridBotId: grid.gridBotId,
    side: grid.side,
    price: fillDetails.price,
    size: fillDetails.baseAssetAmount,
    fee: fee,
    feeAsset: 'USDC',
    timestamp: new Date(fillDetails.ts),
  });
  
  // Update bot's total fees
  await storage.incrementGridBotFees(grid.gridBotId, fee);
}

function calculateFee(fill: DriftFillEvent): number {
  // Drift fee structure:
  // Maker (postOnly): 0% to -0.01% (rebate for some tiers)
  // Taker: 0.05% to 0.1%
  
  // Since we use postOnly, typically maker fees
  const feeRate = fill.makerFee || 0;  // Usually 0 or negative (rebate)
  return fill.quoteAssetAmount * feeRate;
}
```

### PnL Calculation and Inventory Model

```typescript
/*
INVENTORY MODEL: WEIGHTED AVERAGE COST (WAC)

Grid bots use Weighted Average Cost for PnL calculation because:
1. Simpler than FIFO/LIFO to implement correctly
2. Natural fit for partial fills across multiple levels
3. Works well with independent entry/profit scale types
4. Matches how Drift's position tracking works internally

HOW IT WORKS:
- Track total entry position and total entry cost
- Average cost = total cost / total position
- When profit (closing) order fills, PnL = (fill price - average cost) × size
- Update average cost after each fill (new entry adds to cost, close removes from position)

CYCLE DEFINITION:
A "cycle" is completed when position changes sign (goes flat and reverses).
For long grids: buy builds position, sell closes it. Cycle completes when position = 0.
For short grids: sell builds position, buy closes it. Cycle completes when position = 0.

We track "cycleCount" as number of times position returned to 0 from non-zero.
*/

interface GridInventory {
  entryPosition: number;      // Total base asset from entry fills
  entryCost: number;          // Total quote asset spent on entries
  averageCost: number;        // entryCost / entryPosition
  currentPosition: number;    // Net position (entry - profit)
}

interface GridBotPnL {
  realizedPnl: number;        // PnL from completed closes
  unrealizedPnl: number;      // Open position mark-to-market
  totalFees: number;          // All fees paid
  netPnl: number;             // realizedPnl - totalFees
  cycleCount: number;         // Times position returned to zero
  averageEntryCost: number;   // Current weighted average entry price
}

async function calculateGridBotPnL(botId: string): Promise<GridBotPnL> {
  const bot = await storage.getGridBot(botId);
  const fills = await storage.getGridFills(botId);
  
  // Sort fills by timestamp for correct processing order
  const sortedFills = [...fills].sort((a, b) => 
    new Date(a.filledAt).getTime() - new Date(b.filledAt).getTime()
  );
  
  // Determine which side is "entry" based on grid direction
  const isLong = bot.direction === 'long';
  const entrySide = isLong ? 'buy' : 'sell';
  const closeSide = isLong ? 'sell' : 'buy';
  
  // Process fills in order using weighted average cost
  let entryPosition = 0;
  let entryCost = 0;
  let realizedPnl = 0;
  let cycleCount = 0;
  let wasNonZero = false;
  
  for (const fill of sortedFills) {
    if (fill.side === entrySide) {
      // Entry fill: add to position and cost
      entryCost += Number(fill.price) * Number(fill.size);
      entryPosition += Number(fill.size);
      wasNonZero = true;
    } else {
      // Close fill: calculate PnL and reduce position
      const avgCost = entryPosition > 0 ? entryCost / entryPosition : 0;
      const closeSize = Math.min(Number(fill.size), entryPosition);
      
      // PnL = (close price - average entry cost) × close size
      realizedPnl += (Number(fill.price) - avgCost) * closeSize;
      
      // Reduce position and cost proportionally
      if (entryPosition > 0) {
        const reduction = closeSize / entryPosition;
        entryCost *= (1 - reduction);
        entryPosition -= closeSize;
      }
      
      // Check for cycle completion (position returned to zero)
      if (wasNonZero && entryPosition <= 0.0001) {
        cycleCount++;
        wasNonZero = false;
        entryPosition = 0;
        entryCost = 0;
      }
    }
  }
  
  // Sum all fees
  const totalFees = fills.reduce((sum, f) => sum + Number(f.fee), 0);
  
  // Get unrealized PnL from current position
  const position = await driftClient.getPosition(bot.marketIndex, bot.driftSubaccountId);
  const unrealizedPnl = position?.unrealizedPnl || 0;
  
  const averageEntryCost = entryPosition > 0 ? entryCost / entryPosition : 0;
  
  return {
    realizedPnl,
    unrealizedPnl,
    totalFees,
    netPnl: realizedPnl - totalFees,
    cycleCount,
    averageEntryCost,
  };
}
```

### Partial Fill PnL Handling

```typescript
/*
PARTIAL FILL PnL:

When orders partially fill, we track partial positions:
- Record each partial fill with its price and size
- PnL is calculated using weighted average cost basis
- Ensures accurate tracking even with messy partial fills
*/

async function handlePartialFillPnL(
  grid: VirtualGrid,
  partialFillSize: number,
  fillPrice: number
): Promise<void> {
  // Record the partial fill
  await storage.insertGridFill({
    gridLevelId: grid.id,
    gridBotId: grid.gridBotId,
    side: grid.side,
    price: fillPrice,
    size: partialFillSize,
    fee: estimateFee(partialFillSize, fillPrice),
    feeAsset: 'USDC',
    timestamp: new Date(),
    isPartial: true,
  });
  
  // Update grid's filled size
  const currentFilledSize = grid.filledSize || 0;
  await storage.updateGridLevel(grid.id, {
    filledSize: currentFilledSize + partialFillSize,
  });
}
```

---

## User Controls and Notifications

### User Control Actions

```typescript
/*
USER CONTROLS:

Users need ability to:
1. Pause bot (cancel all orders, keep position)
2. Resume bot (re-place orders)
3. Stop bot (cancel orders, close position, withdraw)
4. Adjust range (stop and recreate with new params)
5. Manual sync (force reconciliation)
*/

async function pauseGridBot(botId: string): Promise<void> {
  const bot = await storage.getGridBot(botId);
  const grids = await storage.getGridLevels(botId);
  
  // Cancel all active orders
  for (const grid of grids.filter(g => g.status === 'active')) {
    await cancelGridOrder(bot, grid);
  }
  
  await storage.updateGridBot(botId, { status: 'paused' });
  
  await notifyUser(bot.walletAddress, {
    type: 'grid_paused',
    message: `Grid bot "${bot.name}" has been paused. All orders cancelled.`,
  });
}

async function resumeGridBot(botId: string): Promise<void> {
  const bot = await storage.getGridBot(botId);
  const grids = await storage.getGridLevels(botId);
  
  // Run reconciliation first
  await reconcileGridBotOnStartup(botId);
  
  // Update status
  await storage.updateGridBot(botId, { status: 'active' });
  
  // Rebalance will place new orders
  await rebalanceActiveOrders(bot, grids);
  
  await notifyUser(bot.walletAddress, {
    type: 'grid_resumed',
    message: `Grid bot "${bot.name}" has been resumed.`,
  });
}

async function stopGridBot(botId: string, closePosition: boolean = false): Promise<void> {
  const bot = await storage.getGridBot(botId);
  
  // Pause first (cancels orders)
  await pauseGridBot(botId);
  
  if (closePosition) {
    // Close any open position
    const position = await driftClient.getPosition(bot.marketIndex, bot.driftSubaccountId);
    if (position && Math.abs(position.baseAssetAmount) > 0) {
      await driftClient.closePosition(bot.marketIndex, bot.driftSubaccountId);
    }
  }
  
  await storage.updateGridBot(botId, { status: 'stopped' });
  
  await notifyUser(bot.walletAddress, {
    type: 'grid_stopped',
    message: `Grid bot "${bot.name}" has been stopped.${closePosition ? ' Position closed.' : ''}`,
  });
}

async function forceReconciliation(botId: string): Promise<void> {
  await reconcileGridBotOnStartup(botId);
  
  await notifyUser(bot.walletAddress, {
    type: 'grid_synced',
    message: `Grid bot state synchronized with on-chain data.`,
  });
}
```

### Notification Events

```typescript
/*
NOTIFICATION TYPES:

Users should be notified of:
1. Order fills (configurable - can be noisy)
2. Failed order placements
3. Insufficient margin
4. Range exhaustion
5. Bot paused/resumed/stopped
6. State sync issues
*/

type GridNotificationType = 
  | 'grid_fill'              // Order filled (optional, can be noisy)
  | 'grid_cycle_complete'    // Buy+sell cycle completed with PnL
  | 'grid_placement_failed'  // Order couldn't be placed
  | 'grid_insufficient_margin'
  | 'grid_range_exhausted'
  | 'grid_paused'
  | 'grid_resumed'
  | 'grid_stopped'
  | 'grid_synced'
  | 'grid_error';

interface GridNotification {
  type: GridNotificationType;
  botId: string;
  message: string;
  data?: Record<string, any>;
  timestamp: Date;
}

// User notification preferences (stored per wallet)
interface GridNotificationPreferences {
  notifyOnFill: boolean;           // Default: false (too noisy)
  notifyOnCycleComplete: boolean;  // Default: true
  notifyOnError: boolean;          // Default: true
  notifyOnStatusChange: boolean;   // Default: true
}
```

---

## API Rate Limiting and Pagination

### Drift API Rate Limits

```typescript
/*
DRIFT RPC RATE LIMITING STRATEGY:

Drift uses Solana RPC which has rate limits. Our strategy:

1. BATCHING: Combine multiple calls where possible
   - getOpenOrders returns all orders in one call (good)
   - Use getMultipleAccountsInfo instead of multiple getAccountInfo

2. RATE LIMITING: Implement per-second call limits
   - Helius: 50 RPS for standard, 100 RPS for pro
   - Public RPC: ~10 RPS (unreliable)
   
3. EXPONENTIAL BACKOFF: On rate limit errors
   - Initial delay: 100ms
   - Max delay: 5000ms
   - Max retries: 3

4. REQUEST QUEUING: For high-activity bots
   - Queue requests when approaching rate limits
   - Prioritize critical operations (fills, cancels)
*/

interface RateLimitConfig {
  maxRequestsPerSecond: number;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  maxRequestsPerSecond: 30,  // Conservative for shared RPC
  maxRetries: 3,
  initialBackoffMs: 100,
  maxBackoffMs: 5000,
};

class RateLimitedDriftClient {
  private requestCount = 0;
  private windowStart = Date.now();
  
  async executeWithRateLimit<T>(
    operation: () => Promise<T>,
    priority: 'critical' | 'normal' = 'normal'
  ): Promise<T> {
    // Check rate limit
    const now = Date.now();
    if (now - this.windowStart > 1000) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    
    if (this.requestCount >= DEFAULT_RATE_LIMIT.maxRequestsPerSecond) {
      // Wait for next window
      const waitTime = 1000 - (now - this.windowStart);
      await sleep(waitTime);
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
    
    this.requestCount++;
    
    // Execute with retry
    let lastError: Error | undefined;
    let backoff = DEFAULT_RATE_LIMIT.initialBackoffMs;
    
    for (let attempt = 0; attempt < DEFAULT_RATE_LIMIT.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err;
        
        // Check for rate limit error
        if (err.message?.includes('429') || err.message?.includes('rate limit')) {
          await sleep(backoff);
          backoff = Math.min(backoff * 2, DEFAULT_RATE_LIMIT.maxBackoffMs);
          continue;
        }
        
        // Non-rate-limit error - throw immediately
        throw err;
      }
    }
    
    throw lastError;
  }
}
```

### Order History Pagination

```typescript
/*
ORDER HISTORY PAGINATION:

Drift's getOrderHistory may return paginated results for active traders.
We need to handle this for accurate fill detection.
*/

async function getCompleteOrderHistory(
  subaccountId: number,
  orderId: number
): Promise<OrderHistoryRecord | null> {
  try {
    // First try direct lookup (most common case)
    const history = await rateLimitedClient.executeWithRateLimit(
      () => driftClient.getOrderHistory(orderId)
    );
    
    if (history) return history;
    
    // If not found, may need to search recent history
    const recentHistory = await rateLimitedClient.executeWithRateLimit(
      () => driftClient.getOrderHistoryForSubaccount(subaccountId, { limit: 100 })
    );
    
    return recentHistory.find(h => h.orderId === orderId) || null;
    
  } catch (err) {
    console.error(`[GridBot] Failed to get order history for ${orderId}:`, err);
    return null;
  }
}
```

---

## Storage Interface Requirements

### Required Storage Methods

```typescript
/*
STORAGE INTERFACE:

The grid bot system requires these storage methods.
Implementation should use Drizzle ORM with PostgreSQL.
*/

interface IGridBotStorage {
  // Grid Bot CRUD
  createGridBot(bot: InsertGridBot): Promise<GridBot>;
  getGridBot(id: string): Promise<GridBot | null>;
  getGridBotsByWallet(walletAddress: string): Promise<GridBot[]>;
  getGridBotsByStatus(statuses: string[]): Promise<GridBot[]>;
  updateGridBot(id: string, updates: Partial<GridBot>): Promise<void>;
  
  // Grid Levels
  storeGridLevels(botId: string, levels: VirtualGrid[]): Promise<void>;
  getGridLevels(botId: string): Promise<VirtualGrid[]>;
  updateGridLevel(id: string, updates: Partial<VirtualGrid>): Promise<void>;
  
  // Grid Fills (PnL tracking)
  insertGridFill(fill: InsertGridFill): Promise<void>;
  getGridFills(botId: string): Promise<GridFill[]>;
  getGridFillsByLevel(levelId: string): Promise<GridFill[]>;
  incrementGridBotFees(botId: string, fee: number): Promise<void>;
  
  // Batch operations for efficiency
  updateGridLevelsBatch(updates: Array<{ id: string; updates: Partial<VirtualGrid> }>): Promise<void>;
}

// API Routes needed
const gridBotRoutes = {
  // Bot management
  'POST /api/grid-bots': 'Create grid bot',
  'GET /api/grid-bots': 'List user grid bots',
  'GET /api/grid-bots/:id': 'Get grid bot details',
  'PATCH /api/grid-bots/:id': 'Update grid bot settings',
  'DELETE /api/grid-bots/:id': 'Delete grid bot',
  
  // Bot actions
  'POST /api/grid-bots/:id/pause': 'Pause grid bot',
  'POST /api/grid-bots/:id/resume': 'Resume grid bot',
  'POST /api/grid-bots/:id/stop': 'Stop grid bot',
  'POST /api/grid-bots/:id/sync': 'Force reconciliation',
  
  // Data retrieval
  'GET /api/grid-bots/:id/levels': 'Get grid levels with status',
  'GET /api/grid-bots/:id/fills': 'Get fill history',
  'GET /api/grid-bots/:id/pnl': 'Get PnL summary',
};
```

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
  
  // Configuration (MATCHES trading_bots pattern)
  market: text("market").notNull(),
  marketIndex: integer("market_index").notNull(),
  upperPrice: decimal("upper_price").notNull(),
  lowerPrice: decimal("lower_price").notNull(),
  gridCount: integer("grid_count").notNull(),
  
  // Investment & Leverage (SAME AS trading_bots)
  totalInvestment: decimal("total_investment", { precision: 20, scale: 2 }).notNull(),
  leverage: integer("leverage").default(1).notNull(),           // User-configured leverage
  policyHmac: text("policy_hmac"),                              // HMAC integrity check
  
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
  // NOTE: totalCycles is NOT stored in DB - it's calculated dynamically from fills
  // in calculateGridBotPnL() using WAC inventory model. A cycle completes when
  // position returns to zero, not on every profit fill. This prevents stale/incorrect counts.
  totalFees: decimal("total_fees").default("0"),      // Accumulated fees for reference
  
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

// Grid fill records for PnL tracking
export const gridFills = pgTable("grid_fills", {
  id: varchar("id").primaryKey(),
  gridLevelId: varchar("grid_level_id").references(() => gridLevels.id),
  gridBotId: varchar("grid_bot_id").references(() => gridBots.id),
  
  // Fill details
  side: text("side").notNull(),                // 'buy' or 'sell'
  price: decimal("price").notNull(),
  size: decimal("size").notNull(),
  fee: decimal("fee").notNull(),
  feeAsset: text("fee_asset").default("USDC"),
  isPartial: boolean("is_partial").default(false),
  
  // Timestamps
  filledAt: timestamp("filled_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// CREATE INDEX idx_grid_fills_bot ON grid_fills(grid_bot_id);
// CREATE INDEX idx_grid_fills_level ON grid_fills(grid_level_id);
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

# QuantumVault Vaults Architecture

## Overview

Vaults represent an advanced capital management layer that utilizes Drift Protocol's Subaccount 0 for multi-asset collateral deposits, lending/borrowing capabilities, and yield optimization. This system will enable users to maximize capital efficiency while funding isolated trading bots.

## Core Concepts

### Current Architecture (Bots Only)
```
Agent Wallet (USDC) → Bot Subaccount (1, 2, 3...) → Isolated Trading
```

### Future Architecture (Vaults + Bots)
```
User Deposits → Vault (Subaccount 0) → Multi-Asset Collateral
                      ↓
              Lending/Borrowing Layer
                      ↓
              USDC Borrowed Against Collateral
                      ↓
            Bot Subaccounts (1, 2, 3...) → Isolated Trading
```

## Drift Protocol Foundation

### Subaccount 0 as the Vault
- **Purpose**: Central collateral pool and lending/borrowing hub
- **Multi-Asset Support**: Accepts SOL, BTC, ETH, stablecoins, LSTs, and yield-bearing tokens
- **Cross-Collateral**: All deposited assets contribute to borrowing power
- **Isolation**: Bots continue operating on separate subaccounts (1, 2, 3...) with USDC only

### Collateral Weights (Drift Protocol)

| Asset Type | Initial Weight | Maintenance Weight | Notes |
|------------|---------------|-------------------|-------|
| USDC | 100% | 100% | Full margin, no haircut |
| PYUSD | ~100% | ~100% | PayPal stablecoin |
| USDS | ~100% | ~100% | Sky ecosystem stablecoin |
| SOL | 80% | 90% | Volatile asset haircut |
| BTC | 85% | 92% | Blue chip crypto |
| ETH | 85% | 92% | Blue chip crypto |
| LSTs (JitoSOL, mSOL) | 75-80% | 85-90% | Yield-bearing + volatility |

**Key Insight**: USDC has 100% collateral weight, making it the strongest margin asset. However, yield-bearing stablecoins that also have ~100% weight can provide additional returns.

### Yield-Bearing Stablecoins on Drift

| Token | Type | Estimated APY | Collateral Weight |
|-------|------|---------------|------------------|
| USDC (Drift Lending) | Variable | 5-15%+ | 100% |
| pyUSD | Fiat-backed | Base only | ~100% |
| USDS | Sky/Maker | Variable | ~100% |
| USDe (Ethena) | Synthetic | 15-25% | TBD |

## Vault Features

### 1. Multi-Asset Deposits

Users can deposit any supported Drift collateral asset into their Vault (Subaccount 0):

```typescript
interface VaultDeposit {
  asset: 'USDC' | 'SOL' | 'BTC' | 'ETH' | 'JitoSOL' | 'mSOL' | 'PYUSD' | 'USDS';
  amount: number;
  collateralValue: number; // After weight applied
}
```

**User Flow**:
1. User deposits SOL, BTC, or any supported asset
2. Vault calculates effective collateral value (asset × weight)
3. User can borrow USDC against collateral
4. Borrowed USDC funds trading bots

### 2. Automatic Stablecoin Optimization

The system can automatically swap stablecoins to maximize yield while maintaining 100% collateral weight:

```typescript
interface StablecoinOptimizer {
  // Compare yields
  driftUsdcApy: number;      // Current Drift USDC lending rate
  yieldBearingApy: number;   // Yield-bearing stablecoin rate
  
  // Decision logic
  shouldSwap(): boolean {
    // Swap to yield-bearing if:
    // 1. Yield-bearing APY > Drift USDC APY
    // 2. Yield-bearing has 100% collateral weight
    // 3. Sufficient liquidity for swap
  }
}
```

**Optimization Flow**:
1. Monitor Drift USDC deposit APY (currently fetched via API)
2. Compare against yield-bearing stablecoin rates
3. If yield-bearing offers better returns AND has 100% weight:
   - Swap user's USDC to yield-bearing stablecoin
   - Maintain full collateral value
   - Earn additional yield
4. Reverse swap if Drift rates become more competitive

### 3. Borrow-to-Fund Bots

Instead of requiring users to deposit USDC directly to bots, they can borrow against their collateral:

```typescript
interface BorrowToFund {
  // User's vault state
  totalCollateralValue: number;   // Sum of (asset × weight)
  currentBorrows: number;         // Existing USDC borrows
  availableToBorrow: number;      // Collateral - borrows - buffer
  
  // Bot funding
  targetBot: string;              // Bot ID
  borrowAmount: number;           // USDC to borrow
  
  // Safety
  healthFactorAfterBorrow: number;
  liquidationRisk: 'low' | 'medium' | 'high';
}
```

**Flow**:
1. User has $10,000 SOL deposited (80% weight = $8,000 collateral)
2. User wants to fund a bot with $2,000
3. System borrows $2,000 USDC against SOL collateral
4. $2,000 USDC deposited to bot's subaccount
5. Bot trades isolated with USDC
6. User pays borrow interest on $2,000

### 4. Capital Efficiency Modes

#### Conservative Mode
- Max 50% of available borrow capacity used
- Higher health factor maintained
- Lower liquidation risk
- Suitable for volatile market conditions

#### Balanced Mode
- Max 70% of available borrow capacity
- Moderate health factor
- Standard operations

#### Aggressive Mode
- Max 85% of available borrow capacity
- Lower health factor
- Higher capital efficiency
- Requires user acknowledgment of risks

## Integration with Current Bot System

### Bot Isolation Preserved
```
Vault (Subaccount 0)           Bot Subaccounts (1, 2, 3...)
├── Multi-asset collateral     ├── USDC only
├── Lending/borrowing          ├── No borrowing
├── Cross-margin risk          ├── Isolated margin
└── Capital source             └── Trading execution
```

### Funding Flow
```typescript
async function fundBotFromVault(botId: string, amount: number) {
  // 1. Check vault health
  const vault = await getVaultState(userId);
  if (vault.availableToBorrow < amount) {
    throw new Error('Insufficient borrow capacity');
  }
  
  // 2. Borrow USDC from vault (subaccount 0)
  await borrowUsdc(vault.subaccount, amount);
  
  // 3. Transfer to bot's subaccount
  await transferBetweenSubaccounts(0, bot.driftSubaccountId, amount);
  
  // 4. Update bot state
  await updateBotFunding(botId, amount);
}
```

### Auto Top-Up Enhancement
With Vaults, auto top-up can use borrowed funds:

```typescript
if (bot.autoTopUp && botNeedsMargin) {
  // Current: Check agent wallet USDC balance
  // Enhanced: Check vault borrow capacity
  
  const vault = await getVaultState(userId);
  
  if (vault.availableToBorrow >= shortfall) {
    // Borrow and fund bot
    await borrowAndFund(vault, bot, shortfall);
  } else if (agentWalletUsdc >= shortfall) {
    // Fallback to direct deposit
    await directDeposit(bot, shortfall);
  } else {
    // Pause bot
    await pauseBot(bot, 'Insufficient vault capacity and wallet balance');
  }
}
```

## Health Monitoring

### Vault Health Factor
```typescript
interface VaultHealth {
  totalCollateral: number;      // Sum of weighted assets
  totalBorrows: number;         // Outstanding USDC borrows
  healthFactor: number;         // Collateral / Borrows
  
  // Thresholds
  liquidationThreshold: 1.0;    // Below this = liquidation
  warningThreshold: 1.2;        // Below this = warning
  safeThreshold: 1.5;           // Above this = safe
}
```

### Risk Alerts
- **Yellow Alert** (Health < 1.5): Notify user, suggest adding collateral
- **Orange Alert** (Health < 1.3): Pause new bot funding, active warning
- **Red Alert** (Health < 1.2): Auto-close bot positions, emergency mode

## Database Schema Extensions

```typescript
// New tables for Vaults
export const vaults = pgTable("vaults", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: varchar("wallet_address").notNull().references(() => wallets.walletAddress),
  totalCollateralUsd: real("total_collateral_usd").default(0),
  totalBorrowsUsd: real("total_borrows_usd").default(0),
  healthFactor: real("health_factor").default(999),
  capitalMode: varchar("capital_mode").default("balanced"), // conservative, balanced, aggressive
  autoOptimizeStables: boolean("auto_optimize_stables").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const vaultDeposits = pgTable("vault_deposits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vaultId: varchar("vault_id").references(() => vaults.id),
  asset: varchar("asset").notNull(), // USDC, SOL, BTC, etc.
  amount: real("amount").notNull(),
  collateralWeight: real("collateral_weight").notNull(),
  collateralValue: real("collateral_value").notNull(),
  depositedAt: timestamp("deposited_at").defaultNow(),
});

export const vaultBorrows = pgTable("vault_borrows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  vaultId: varchar("vault_id").references(() => vaults.id),
  asset: varchar("asset").default("USDC"),
  amount: real("amount").notNull(),
  interestRate: real("interest_rate").notNull(),
  purpose: varchar("purpose"), // bot_funding, withdrawal, etc.
  botId: varchar("bot_id").references(() => tradingBots.id),
  borrowedAt: timestamp("borrowed_at").defaultNow(),
});
```

## Implementation Phases

### Phase 1: Vault Foundation
- [ ] Create Vault entity tied to user wallet
- [ ] Track Subaccount 0 deposits and balances
- [ ] Display vault health and collateral breakdown
- [ ] Basic deposit/withdraw for USDC

### Phase 2: Multi-Asset Support
- [ ] Support SOL, BTC, ETH deposits to vault
- [ ] Implement collateral weight calculations
- [ ] Show effective collateral value per asset
- [ ] Asset-specific deposit/withdraw flows

### Phase 3: Borrow Integration
- [ ] Implement USDC borrowing against collateral
- [ ] Track borrow positions and interest
- [ ] Health factor monitoring and alerts
- [ ] Bot funding via borrowed USDC

### Phase 4: Yield Optimization
- [ ] Monitor Drift USDC lending APY
- [ ] Track yield-bearing stablecoin rates
- [ ] Implement auto-swap logic
- [ ] User controls for optimization preferences

### Phase 5: Advanced Features
- [ ] Capital efficiency modes
- [ ] Auto-deleverage during risk events
- [ ] Cross-bot capital rebalancing
- [ ] Vault performance analytics

## API Endpoints (Planned)

```typescript
// Vault management
GET    /api/vault                    // Get user's vault state
POST   /api/vault/deposit            // Deposit asset to vault
POST   /api/vault/withdraw           // Withdraw asset from vault
GET    /api/vault/health             // Get health metrics

// Borrowing
POST   /api/vault/borrow             // Borrow USDC against collateral
POST   /api/vault/repay              // Repay borrowed USDC
GET    /api/vault/borrows            // List active borrows

// Bot integration
POST   /api/vault/fund-bot           // Fund bot from vault (borrow + transfer)
POST   /api/vault/recall-from-bot    // Recall funds from bot to vault

// Optimization
GET    /api/vault/yield-comparison   // Compare stablecoin yields
POST   /api/vault/optimize           // Execute yield optimization
PUT    /api/vault/settings           // Update vault settings
```

## Risk Considerations

### Liquidation Risk
- Volatile collateral (SOL, BTC) can drop in value
- Borrows remain fixed in USDC
- Health factor can deteriorate rapidly
- Need robust monitoring and alerts

### Interest Rate Risk
- Borrow rates fluctuate based on utilization
- High rates during market stress
- Must account for interest in bot profitability

### Smart Contract Risk
- Reliance on Drift Protocol's lending/borrowing
- Oracle price feed accuracy
- Protocol upgrade compatibility

### Mitigation Strategies
1. Conservative default settings
2. Real-time health monitoring
3. Automatic position reduction
4. Clear risk disclosures to users
5. Emergency stop functionality

## Dependencies

- Drift SDK borrow/lend functions
- Spot market data for collateral assets
- Interest rate APIs
- Oracle price feeds
- Existing bot infrastructure

## Notes

- This architecture builds on the existing agent wallet and subaccount system
- Each bot remains isolated with USDC-only margin
- Vault adds capital efficiency without changing bot execution
- User can choose between direct funding (current) or vault funding (new)
- Gradual rollout recommended to validate stability

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

## Intelligent Automation Layer (Agentic Features)

The "agent" in QuantumVault refers to autonomous decision-making systems that optimize capital without requiring user intervention. These are rule-based intelligent systems - no LLM required - that continuously monitor conditions and take action.

### Philosophy

```
Traditional Manual Flow:
User monitors → User decides → User executes → User monitors again

Agentic Flow:
System monitors → System decides (based on rules) → System executes → System reports
```

The goal is to make money work harder automatically while users sleep.

### Core Agentic Behaviors

#### 1. Yield Arbitrage Agent

Continuously monitors yield opportunities and reallocates capital:

```typescript
interface YieldArbitrageAgent {
  // Inputs (monitored continuously)
  driftUsdcLendingApy: number;      // Current Drift lending rate
  yieldBearingStableApys: Map<string, number>; // PYUSD, USDS, USDe rates
  jupiterSwapRates: Map<string, number>;       // Swap costs
  
  // Decision Logic
  evaluate(): YieldDecision {
    const bestYield = this.findBestYieldOpportunity();
    const currentYield = this.getCurrentAllocation();
    const swapCost = this.calculateSwapCost(currentYield, bestYield);
    const breakEvenDays = swapCost / (bestYield.apy - currentYield.apy);
    
    // Only swap if breakeven < 7 days and difference > 1%
    if (breakEvenDays < 7 && (bestYield.apy - currentYield.apy) > 0.01) {
      return { action: 'swap', from: currentYield.asset, to: bestYield.asset };
    }
    return { action: 'hold' };
  }
}
```

**Triggers**:
- Every 6 hours: Check yield rates
- On significant rate change (>2%): Immediate evaluation
- After any deposit: Evaluate new capital placement

#### 2. Profit Distribution Agent

Automatically allocates realized profits based on user preferences:

```typescript
interface ProfitDistributionAgent {
  // User-configured preferences
  reinvestPercent: number;          // % back into trading
  yieldFarmPercent: number;         // % to yield optimization
  withdrawPercent: number;          // % to agent wallet for withdrawal
  compoundThreshold: number;        // Min profit before distribution
  
  // Decision Logic
  onProfitRealized(profit: number, botId: string): void {
    if (profit < this.compoundThreshold) {
      // Accumulate small profits
      return;
    }
    
    const reinvestAmount = profit * this.reinvestPercent;
    const yieldAmount = profit * this.yieldFarmPercent;
    const withdrawAmount = profit * this.withdrawPercent;
    
    // Execute distribution
    if (reinvestAmount > 0) this.depositToBot(botId, reinvestAmount);
    if (yieldAmount > 0) this.depositToYieldVault(yieldAmount);
    if (withdrawAmount > 0) this.transferToAgentWallet(withdrawAmount);
  }
}
```

**User Controls**:
- Reinvest/Yield/Withdraw split percentages
- Minimum threshold before distribution
- Per-bot or global settings

#### 3. Risk Management Agent

Monitors health and takes protective actions:

```typescript
interface RiskManagementAgent {
  // Thresholds (user-configurable)
  warningHealthFactor: number;      // Default: 1.5
  criticalHealthFactor: number;     // Default: 1.2
  emergencyHealthFactor: number;    // Default: 1.1
  
  // Actions by severity
  onHealthChange(currentHealth: number): void {
    if (currentHealth < this.emergencyHealthFactor) {
      // EMERGENCY: Close losing positions, repay borrows
      this.emergencyDeleverage();
      this.notifyUser('emergency');
    } else if (currentHealth < this.criticalHealthFactor) {
      // CRITICAL: Pause new trades, start unwinding
      this.pauseAllBots();
      this.startGradualDeleverage();
      this.notifyUser('critical');
    } else if (currentHealth < this.warningHealthFactor) {
      // WARNING: Notify user, suggest action
      this.notifyUser('warning');
    }
  }
  
  emergencyDeleverage(): void {
    // 1. Close all bot positions at market
    // 2. Sweep funds back to vault
    // 3. Repay borrows to restore health
    // 4. Hold remaining as USDC
  }
}
```

**Escalation Ladder**:
1. Warning (Health < 1.5): Telegram/email notification
2. Critical (Health < 1.2): Pause bots, gradual unwind
3. Emergency (Health < 1.1): Force close everything

#### 4. Capital Rebalancing Agent

Optimizes capital allocation across bots based on performance:

```typescript
interface CapitalRebalancingAgent {
  // Evaluation period
  evaluationWindow: number;         // Days to analyze (default: 30)
  rebalanceThreshold: number;       // Min % difference to act (default: 10%)
  
  // Performance metrics
  calculateBotScore(bot: Bot): number {
    const sharpeRatio = this.calculateSharpe(bot);
    const winRate = bot.winningTrades / bot.totalTrades;
    const profitFactor = bot.grossProfit / bot.grossLoss;
    const drawdown = bot.maxDrawdown;
    
    // Weighted score
    return (sharpeRatio * 0.3) + (winRate * 0.2) + 
           (profitFactor * 0.3) + ((1 - drawdown) * 0.2);
  }
  
  rebalance(): void {
    const scores = this.bots.map(b => ({ bot: b, score: this.calculateBotScore(b) }));
    const totalScore = scores.reduce((sum, s) => sum + s.score, 0);
    
    // Calculate ideal allocation per bot
    for (const { bot, score } of scores) {
      const idealPercent = score / totalScore;
      const currentPercent = bot.equity / this.totalEquity;
      
      if (Math.abs(idealPercent - currentPercent) > this.rebalanceThreshold) {
        // Rebalance: move capital from underperformers to top performers
        this.adjustAllocation(bot, idealPercent);
      }
    }
  }
}
```

**Schedule**:
- Weekly evaluation
- Only rebalance if difference exceeds threshold
- Never rebalance during open positions

#### 5. Market Regime Detection Agent

Adjusts strategy parameters based on market conditions:

```typescript
interface MarketRegimeAgent {
  // Regime types
  regimes: ['trending_up', 'trending_down', 'ranging', 'high_volatility', 'low_volatility'];
  
  // Detection using price data
  detectRegime(market: string): MarketRegime {
    const prices = this.getPrices(market, 30); // 30 days
    const trend = this.calculateTrend(prices);
    const volatility = this.calculateVolatility(prices);
    const adx = this.calculateADX(prices);
    
    if (volatility > 0.05) return 'high_volatility';
    if (adx > 25 && trend > 0) return 'trending_up';
    if (adx > 25 && trend < 0) return 'trending_down';
    if (adx < 20) return 'ranging';
    return 'low_volatility';
  }
  
  // Adjust bot parameters based on regime
  adjustForRegime(bot: Bot, regime: MarketRegime): void {
    switch (regime) {
      case 'high_volatility':
        // Reduce position sizes, widen stops
        bot.effectiveMaxPosition = bot.maxPositionSize * 0.5;
        break;
      case 'trending_up':
      case 'trending_down':
        // Full position sizes for trends
        bot.effectiveMaxPosition = bot.maxPositionSize;
        break;
      case 'ranging':
        // Smaller positions, tighter management
        bot.effectiveMaxPosition = bot.maxPositionSize * 0.7;
        break;
    }
  }
}
```

**No LLM Needed**: Uses standard technical indicators (ADX, ATR, moving averages) to classify regimes.

### Notification & Reporting Agent

Keeps users informed without requiring them to check:

```typescript
interface NotificationAgent {
  // Digest preferences
  dailyDigest: boolean;
  weeklyReport: boolean;
  instantAlerts: string[];  // ['trade_executed', 'position_closed', 'risk_warning']
  
  // Daily digest content
  generateDailyDigest(): Digest {
    return {
      totalPnl: this.calculateDayPnl(),
      openPositions: this.getOpenPositions(),
      yieldEarned: this.getYieldEarnings(),
      vaultHealth: this.getVaultHealth(),
      topPerformer: this.getBestBot(),
      recommendations: this.generateRecommendations(),
    };
  }
  
  // Recommendations (rule-based)
  generateRecommendations(): string[] {
    const recs = [];
    if (this.vaultHealth < 1.5) recs.push('Consider adding collateral');
    if (this.idleCapital > 1000) recs.push('You have idle capital earning 0%');
    if (this.worstBot.drawdown > 0.2) recs.push(`${worstBot.name} is underperforming`);
    return recs;
  }
}
```

### Agent Execution Schedule

| Agent | Frequency | Trigger |
|-------|-----------|---------|
| Yield Arbitrage | Every 6 hours | Rate change >2% |
| Profit Distribution | On position close | Profit > threshold |
| Risk Management | Every minute | Health change |
| Capital Rebalancing | Weekly | Score divergence >10% |
| Market Regime | Daily | Volatility spike |
| Notifications | Per preference | Event-based |

### Database Schema for Agents

```typescript
export const agentConfigs = pgTable("agent_configs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: varchar("wallet_address").notNull(),
  
  // Yield agent
  yieldOptimizationEnabled: boolean("yield_optimization_enabled").default(false),
  minYieldDifferencePercent: real("min_yield_difference_percent").default(1.0),
  
  // Profit distribution
  profitReinvestPercent: real("profit_reinvest_percent").default(100),
  profitYieldPercent: real("profit_yield_percent").default(0),
  profitWithdrawPercent: real("profit_withdraw_percent").default(0),
  profitCompoundThreshold: real("profit_compound_threshold").default(10),
  
  // Risk management
  warningHealthFactor: real("warning_health_factor").default(1.5),
  criticalHealthFactor: real("critical_health_factor").default(1.2),
  autoDeleverageEnabled: boolean("auto_deleverage_enabled").default(true),
  
  // Capital rebalancing
  rebalancingEnabled: boolean("rebalancing_enabled").default(false),
  rebalanceThresholdPercent: real("rebalance_threshold_percent").default(10),
  
  // Market regime
  regimeAdjustmentEnabled: boolean("regime_adjustment_enabled").default(false),
  
  // Notifications
  telegramDigestEnabled: boolean("telegram_digest_enabled").default(true),
  digestFrequency: varchar("digest_frequency").default("daily"),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const agentActions = pgTable("agent_actions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  walletAddress: varchar("wallet_address").notNull(),
  agentType: varchar("agent_type").notNull(), // yield, profit, risk, rebalance, regime
  action: varchar("action").notNull(),
  details: jsonb("details"),
  result: varchar("result"), // success, failed, skipped
  executedAt: timestamp("executed_at").defaultNow(),
});
```

### Why No LLM?

| Feature | LLM Approach | Rule-Based Approach | Winner |
|---------|-------------|---------------------|--------|
| Yield comparison | Ask GPT which is better | Compare APY numbers | Rules (faster, cheaper) |
| Risk alerts | "Is this risky?" | Health < threshold | Rules (deterministic) |
| Rebalancing | "Which bot is best?" | Calculate Sharpe ratio | Rules (reproducible) |
| Market regime | "What's the market like?" | ADX + volatility | Rules (no API cost) |

LLMs add latency, cost, and non-determinism. For financial decisions, deterministic rule-based systems are preferred.

**When LLM might help**:
- Natural language reports ("Your bot made $500 because SOL pumped 10%")
- Strategy suggestions based on market news
- Conversational interface for settings

These are nice-to-haves, not core functionality.

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

export const DOCS_MARKDOWN = `# QuantumVault Documentation

> **QuantumVault** — Automated perpetual futures trading on Solana via Drift Protocol.
> Website: [https://myquantumvault.com](https://myquantumvault.com)

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Wallet Setup](#wallet-setup)
3. [Funding Your Account](#funding-your-account)
4. [Creating Trading Bots](#creating-trading-bots)
   - [Profit Reinvest](#profit-reinvest)
   - [Auto Withdraw](#auto-withdraw)
   - [Auto Top-Up](#auto-top-up)
   - [Using These Features Together](#using-these-features-together)
5. [TradingView Integration](#tradingview-integration)
6. [Bot Management](#bot-management)
7. [Marketplace](#marketplace)
8. [Settings & Referrals](#settings--referrals)
9. [Security](#security)
10. [Swift Execution](#swift-execution)
11. [AI Agent Integration](#ai-agent-integration)
12. [QuantumLab Overview](#quantumlab-overview)
13. [Strategy Library](#strategy-library)
14. [Optimizer](#optimizer)
15. [Backtesting Engine](#backtesting-engine)
16. [Results & Heatmap](#results--heatmap)
17. [Insights & Guided Mode](#insights--guided-mode)

---

## Getting Started

QuantumVault is an automated trading platform built on Solana that connects your TradingView alerts to Drift Protocol for perpetual futures trading. Execute trades automatically based on your technical analysis signals with minimal latency.

### How It Works

1. **Connect Wallet** — Connect your Phantom wallet to create your account and agent wallet.
2. **Fund Your Account** — Deposit SOL for transaction fees and USDC for trading.
3. **Create a Bot** — Set up a trading bot with your preferred market and leverage settings.
4. **Connect TradingView** — Set up webhook alerts in TradingView to trigger your bot's trades.

> **Note:** All trades are executed on Drift Protocol, a decentralized perpetual futures exchange on Solana. Your funds remain in your control through your agent wallet.

---

## Wallet Setup

QuantumVault uses a two-wallet system for security and automation: your personal Phantom wallet for deposits/withdrawals, and a platform-managed agent wallet for executing trades.

### Your Phantom Wallet

This is your personal Solana wallet that you connect to the platform. You use it to:

- Sign in to your account
- Deposit and withdraw funds
- Approve transactions

### Agent Wallet

When you first connect, QuantumVault creates a dedicated agent wallet for you. This wallet:

- Holds your trading funds (USDC)
- Holds SOL for transaction fees
- Executes trades automatically when signals arrive
- Is unique to your account and fully controlled by you

> **Warning:** Never share your agent wallet's address publicly. While funds can only be withdrawn to your connected Phantom wallet, keeping your setup private adds an extra layer of security.

### Connecting Your Wallet

1. Install the Phantom wallet browser extension from phantom.app
2. Create or import a Solana wallet in Phantom
3. Visit QuantumVault and click "Connect Wallet"
4. Approve the connection in the Phantom popup
5. Complete the welcome flow to fund your agent wallet

---

## Funding Your Account

To start trading, you need to fund your agent wallet with both SOL (for transaction fees) and USDC (for trading capital).

### SOL for Account Setup & Fees

SOL covers a one-time account setup (~0.05 SOL for your Drift trading account and Swift execution authorization) plus ongoing transaction fees. We recommend depositing at least 0.1 SOL to cover setup and many trades. Most trades via Swift cost no gas at all.

| Item                     | Amount          |
|--------------------------|-----------------|
| Recommended SOL deposit  | 0.1 - 0.5 SOL  |
| Typical trade cost       | ~$0.002         |

### USDC for Trading

USDC is the trading currency on Drift Protocol. Your USDC is held in your agent wallet and can be allocated to individual bots or the Drift trading account.

### Capital Flow

\`\`\`
Phantom Wallet → Agent Wallet → Drift Account
\`\`\`

When you deposit to a bot, funds move from your agent wallet to that bot's Drift subaccount. Each bot has an isolated subaccount for safety.

> **Tip:** Your USDC earns interest while sitting in Drift! The current APY is displayed in your bot settings and adjusts based on market conditions.

---

## Creating Trading Bots

Bots are automated trading agents that execute trades based on TradingView webhook signals. Each bot trades a single market with your specified settings.

### Bot Settings

- **Market** — Choose which perpetual market to trade (e.g., SOL-PERP, BTC-PERP, ETH-PERP). Each bot trades one market only.
- **Leverage** — Set your leverage multiplier (1x to 20x depending on market). Higher leverage amplifies both gains and losses.
- **Investment Amount** — The USDC amount allocated to this bot. This is your maximum position size before leverage.
- **Direction** — Choose "Both" for long and short signals, or restrict to "Long Only" or "Short Only".

### Automated Capital Management

These three features let you fully automate how your bot handles money. Instead of manually depositing, withdrawing, and adjusting your investment — the system does it for you.

- **Profit Reinvest** — Grow your trades as you win
- **Auto Withdraw** — Take profits automatically
- **Auto Top-Up** — Refill when running low

---

### Profit Reinvest

By default, your bot trades with a fixed amount you set (e.g., $100). When **Profit Reinvest** is enabled, your bot uses everything it has available instead.

#### OFF (Default)

- You set $100 → Bot always trades $100
- Even if bot grows to $200, still trades $100
- If margin is low, scales to 95% of available capacity

#### ON

- Bot has $100 → Trades $90*
- Bot grows to $200 → Trades $180*

**\\*Profit Reinvest Buffer:** Trades execute at 90% of available margin to ensure fills. This reserves headroom for trading fees, slippage, oracle price drift, and price movement during transaction confirmation.

**Normal Mode Scaling:** If your bot's margin falls below your investment amount (e.g., after losses), trades scale down to 95% of available capacity until equity recovers.

> 💡 Use this to compound your profits and grow position sizes over time.

---

### Auto Withdraw

Set a threshold amount. When your bot's balance goes above this number, the extra money is automatically moved to your agent wallet.

#### How it works

1. You set threshold to **$100**
2. Your bot wins a trade and now has **$150**
3. System automatically withdraws **$50** to your agent wallet
4. Bot continues with $100, profits are safe

> ✅ Happens automatically after each trade closes.

---

### Auto Top-Up

When a trade signal arrives, if your bot's equity is below your investment amount, this feature automatically tops up from your agent wallet so you can trade at full size.

#### How it works

1. A trade signal arrives from TradingView
2. Bot has **$4** equity, but investment is **$10**
3. System deposits **$6** from your agent wallet
4. Trade executes at **full $100 position** (not scaled down)

> ℹ️ Requires USDC in your agent wallet to work.

---

### Using These Features Together

All three features are compatible and can create powerful automation.

#### "Keep $100 Working" Strategy

**Configuration:** Profit Reinvest ON • Auto Withdraw at $100 • Auto Top-Up ON

| When you win | When you lose | The result |
|---|---|---|
| Balance → $150 | Balance → $5 | Bot stays at ~$100 |
| Auto Withdraw takes $50 | Auto Top-Up adds funds | Profits accumulate |
| Bot stays at $100 | Bot keeps trading | In your agent wallet |

> **Warning:** Always test your bot with a small amount first. Start with low leverage until you're confident in your signal strategy.

> **💡 Let Your Bot Prove Itself:** Start with low capital and enable **Profit Reinvest**. As your bot wins trades, it will naturally grow its position sizes. This way, you only scale up with real profits — not hopeful deposits. A bot that can't grow on its own isn't ready for larger capital.

---

## TradingView Integration

Connect your TradingView alerts to QuantumVault using webhooks. When your strategy generates a signal, TradingView sends it directly to your bot for execution.

### Setting Up Webhooks

1. Create or select a bot in QuantumVault
2. Go to the Webhook tab in your bot settings
3. Copy your unique webhook URL
4. In TradingView, create an alert on your strategy
5. Enable "Webhook URL" and paste your URL
6. Set the message format (see below)

### Message Format

Use this template for your TradingView alert message:

\`\`\`json
{
  "action": "{{strategy.order.action}}",
  "contracts": "{{strategy.order.contracts}}",
  "position_size": "{{strategy.position_size}}"
}
\`\`\`

### Signal Types

#### Long Entry (Buy)

\`\`\`json
{
  "action": "buy",
  "contracts": "1",
  "position_size": "1"
}
\`\`\`

#### Short Entry (Sell)

\`\`\`json
{
  "action": "sell",
  "contracts": "1",
  "position_size": "1"
}
\`\`\`

#### Close Position

\`\`\`json
{
  "action": "sell",
  "contracts": "0",
  "position_size": "0"
}
\`\`\`

When position_size is 0, the bot closes any open position.

### Position Sizing

The "contracts" value from TradingView is interpreted as a percentage of your bot's max position size. For example, if your bot has $100 allocated and contracts = 1, it uses 100% of available capital. If contracts = 0.5, it uses 50%.

#### Why positions open at ~90% of max size

When you set a $100 investment at 10x leverage, your theoretical max position is $1,000. However, actual trades open at approximately **90%** of this amount (~$900) for important reasons:

- **Margin Buffer** — Drift requires a safety cushion to accept orders
- **Trading Fees** — Opening fees reduce available margin
- **Price Slippage** — Market orders may fill at slightly different prices
- **Health Protection** — Prevents immediate liquidation risk on entry

*Example: $20 at 10x = $200 max → $180 actual position (90%). This is intentional and protects your trade.*

> **Note:** Signals are processed in real-time with typical execution latency under 2 seconds. Your bot must be active (not paused) to execute trades.

---

## Bot Management

Monitor and control your bots from the dashboard. Each bot can be individually configured, paused, or deleted.

### Bot States

- 🟣 **Active** — Bot is listening for signals and will execute trades
- 🟡 **Paused** — Bot ignores signals but keeps existing positions
- 🔴 **Has Position** — Bot has an open trade (shown in position card)

### Manual Trading

When your bot doesn't have an open position, you can manually trigger a trade directly from the bot management drawer. This is useful if you:

- Found a good strategy but missed the last signal
- Want to get into a position immediately after creating a bot
- See a market opportunity and want to act on it right away

Manual trades use your bot's existing settings for position sizing, leverage, and market. Simply click **Buy** or **Sell** to open a long or short position. Once a position is open, you can close it manually or wait for your TradingView strategy to send a close signal.

### Managing Equity

Each bot has its own equity pool. You can deposit USDC to increase trading capital or withdraw to take profits.

- **Add Equity** — Transfer USDC from agent wallet to bot
- **Withdraw Equity** — Move USDC from bot back to agent wallet
- **Close Position** — Manually close the current trade

### Viewing History

The History tab shows all executed trades with entry/exit prices, PnL, and fees. The Equity tab shows deposits, withdrawals, and balance changes over time.

### Pausing a Bot

Pausing a bot stops it from executing new trades. If the bot has an open position, you'll be asked whether to close it or keep it open. Paused bots still accrue interest on deposited USDC.

### Deleting a Bot

> **Warning:** Deleting a bot will close any open positions and sweep all funds back to your agent wallet. This action cannot be undone. Make sure to withdraw any funds you want to keep before deleting.

---

## Marketplace

The marketplace lets you share your successful strategies or copy trades from other users. Published bots broadcast their signals to subscribers.

### Publishing Your Bot

Share your trading strategy with the community:

1. Open your bot and ensure it has a trading history
2. Click "Publish to Marketplace" in the bot menu
3. Add a name and description for your strategy
4. Accept the terms and publish
5. Share your bot link on social media

Published bots display your performance metrics (win rate, PnL, trade count) so subscribers can evaluate your strategy.

### Subscribing to a Bot

Copy trades from successful traders:

1. Browse the marketplace for published bots
2. Review the bot's performance metrics and description
3. Click "Subscribe" and set your investment amount
4. Choose your leverage (can differ from the source bot)
5. Confirm subscription to start receiving signals

> **Note:** Subscriber bots execute trades proportionally. If the source bot uses 50% of their capital, your bot uses 50% of yours — adjusted for your own leverage and investment.

### Performance Metrics

| Metric | Description |
|---|---|
| PnL | Profit/loss over different time periods |
| Win Rate | Percentage of profitable trades |
| Subscribers | Number of users copying this bot |
| Trade Count | Total trades executed |

---

## Settings & Referrals

Customize your profile, manage security, and earn rewards by inviting others to the platform.

### Profile Settings

- **Display Name** — How you appear on the leaderboard and marketplace
- **X Username** — Link your Twitter/X for social proof
- **Default Leverage** — Pre-fill leverage when creating bots
- **Slippage** — Maximum price slippage for trade execution

### Notifications

Connect Telegram to receive real-time alerts about your trades:

- Trade executed notifications
- Trade failed alerts
- Position closed updates

### Security Features

QuantumVault includes robust security controls in the Settings area:

- **Execution Authorization** — Enable or revoke automated trading
- **Agent Wallet Backup** — View your 24-word recovery phrase
- **Reset Agent Wallet** — Generate a new agent wallet if needed

> **Note:** For detailed information about how your funds are protected, see the Security section.

### Referral Program

Grow the QuantumVault community and be rewarded for it:

1. Find your unique referral code in Settings
2. Share your referral link with friends
3. Your referrals are tracked and attributed to your account

#### Building Towards Something Bigger

Every referral you make is permanently recorded. As QuantumVault evolves, early supporters and active community builders will be recognized and rewarded in meaningful ways.

*We're building more than just a trading platform. Your contributions today shape what's coming tomorrow.*

### Danger Zone

These actions are irreversible. Use with caution:

- **Close All Trades** — Immediately closes all open positions across all your bots. Use this in emergencies to exit all trades at once.
- **Reset Drift Account** — Closes all positions, withdraws funds, and deletes all bot subaccounts. Start fresh.
- **Reset Agent Wallet** — Withdraws all funds to your Phantom wallet and creates a completely new agent wallet.

---

## Security

QuantumVault is built with institutional-grade security to protect your trading capital. Your funds are always under your control.

### Your Keys, Your Control

- **You Own Your Agent Wallet** — Each user gets a dedicated Solana wallet for trading. You can back it up with a standard 24-word recovery phrase and restore it in any Solana wallet.
- **Phantom Keys Never Shared** — Your main Phantom wallet keys are never stored or transmitted. We only ask you to sign messages to verify your identity — never transactions that could drain your wallet.

### Bank-Grade Encryption

All sensitive data is protected with AES-256-GCM encryption — the same standard used by banks and governments worldwide.

| What's Protected | How |
|---|---|
| Agent Wallet Key | Encrypted with your personal master key |
| Recovery Phrase | Encrypted and only revealed on request |
| Session Data | Protected with per-user encryption keys |
| Bot Policies | Cryptographically signed to prevent tampering |

### Your Personal Master Key

Every user has a unique User Master Key (UMK) that:

- Is derived from your wallet signature (only you can generate it)
- Encrypts all your sensitive data
- Is never stored in plain text
- Cannot be accessed without your Phantom wallet

### Trade Execution Security

- **Signature-Based Authorization** — Before any bot can trade, you must explicitly enable execution by signing a message with your Phantom wallet. You can revoke this at any time.
- **Bot Policy Protection** — Your trading limits (max position size, leverage, markets) are cryptographically protected. Any tampering is automatically detected and blocked.
- **Emergency Stop** — One-click to revoke all execution authorization, close all positions, or reset your entire agent wallet if needed.

### What We Never Do

- ❌ Store your Phantom private keys
- ❌ Access your main wallet
- ❌ Log sensitive data
- ❌ Share your encryption keys

### Recovery Options

Your agent wallet includes a 24-word recovery phrase that you can:

1. Reveal securely in Settings (requires wallet signature)
2. Import into any standard Solana wallet (Phantom, Solflare, etc.)
3. Use to recover your trading funds independently

> **Warning:** Keep your recovery phrase safe! Write it down on paper and store it securely. Never share it with anyone — QuantumVault will never ask for your recovery phrase.

### Best Practices

#### Keep Your Recovery Phrase Safe

- Write it down on paper — never store digitally
- Keep in a secure location (fireproof safe recommended)
- Test recovery before depositing large amounts

#### Monitor Your Bots

- Review open positions daily
- Set conservative limits initially
- Check trade history for unexpected activity

#### Secure Your Phantom Wallet

- Consider using a hardware wallet (Ledger via Phantom)
- Enable Phantom's auto-lock feature
- Never sign unknown messages

> QuantumVault's security has been reviewed by internal architects and AI-assisted security audits. We continuously update our security practices to protect your funds.

---

## Swift Execution

Swift is a faster, cheaper way to execute your trades on Drift Protocol. Instead of sending transactions directly to the Solana blockchain, Swift sends your trade intent to professional market makers who compete to fill your order — resulting in gasless trades, better prices, and lower fees.

### Why Swift Is Better for You

- **Gasless Trading** — No SOL burned per trade. Swift eliminates blockchain gas fees so you keep more of your profits.
- **Better Fills** — Market makers compete in an auction to fill your order, often giving you price improvement over standard execution.
- **Lower Fees** — Swift taker fees can be lower than standard on-chain execution, saving you money on every trade.
- **Reduced RPC Pressure** — Fewer blockchain calls means more reliable execution, especially important for high-frequency strategies on 1-minute charts.

### How It Works

1. Your bot receives a trading signal (from TradingView or AI agent)
2. QuantumVault creates a signed trade intent and submits it to Swift's auction
3. Professional market makers compete to fill your order at the best price
4. Trade is settled on-chain — you can verify it on Solana explorer

### Automatic Fallback & Trade Protection

If Swift can't fill your trade (this is rare), QuantumVault automatically falls back to direct on-chain execution. Before switching, it verifies your current position to ensure the same trade isn't executed twice — protecting you from unintended double exposure. You don't need to configure anything — it's completely seamless and your trades will always go through safely.

### Minimum Trade Size for Swift

Swift routes trades through market maker auctions. For very small trades, market makers may not participate in the auction, so there's a minimum trade size of **$25 notional value** for Swift execution. Trades below this threshold automatically use direct on-chain execution instead.

#### How Notional Value Is Calculated

Notional value = number of contracts × current price. For example, trading 0.5 SOL-PERP at $120 = $60 notional — this qualifies for Swift execution.

| Parameter | Value |
|---|---|
| Swift Minimum | $25 notional value |

> **Note:** If your trade is below the minimum, it still executes normally — just via direct on-chain transaction instead of Swift. The only difference is a small gas fee (~0.000005 SOL per trade).

### Market Liquidity & Swift Availability

Swift relies on professional market makers to compete in an auction and fill your trade. This works best on popular, high-volume markets where market makers are actively looking for orders to fill. On smaller or newer altcoin markets, there may be fewer market makers participating, which means Swift auctions are less likely to get filled.

#### Best Markets for Swift

High-volume markets like **SOL, BTC, ETH, SUI** and other major tokens tend to have the most active market makers, so Swift fills are more consistent.

Smaller altcoin markets with lower trading volume may see Swift auctions go unfilled more frequently. When this happens, your trade automatically switches to direct on-chain execution — no action needed from you, and your trade still goes through.

> **Note:** Even if Swift doesn't fill on a particular market, it doesn't cost you anything extra. The system simply falls back to direct on-chain execution seamlessly. As markets grow in popularity and attract more market makers, Swift fill rates will improve over time.

### What You Need to Know

- Swift is enabled by default for all trades above $25 notional value. No setup required on your end.
- A one-time account setup (~0.05 SOL) is required when you first start trading. This covers both your Drift account and Swift authorization.
- In rare edge cases, a trade may take a few extra seconds if Swift needs to fall back to direct execution. This is normal and your trade will still complete.

### Swift Status

| Parameter | Value |
|---|---|
| Swift Status | ✅ Active |
| Fallback | Automatic |
| Minimum Trade Size | $25 notional |
| Setup Required | None (auto-configured) |

---

## AI Agent Integration

Connect AI trading agents like OpenClaw, AutoGPT, or custom LLM-powered bots to QuantumVault for automated perpetual futures trading on Drift Protocol. Your AI handles the intelligence, QuantumVault handles safe execution.

> **Note:** AI agents send webhook signals just like TradingView. QuantumVault executes trades on Drift Protocol with automatic retry, RPC failover, and position management.

### Why Use QuantumVault as Your Execution Layer?

**Your AI Agent:**
- Market analysis & signals
- Sentiment monitoring
- On-chain tracking
- Decision making

**QuantumVault:**
- Drift Protocol execution
- Position management
- Auto retry & failover
- Secure key handling

### Webhook API Endpoint

Send HTTP POST requests to trigger trades:

\`\`\`
POST /api/webhook/{botId}
\`\`\`

### Open Position (Long/Short)

Send \`action: "buy"\` for long positions or \`action: "sell"\` for short:

\`\`\`json
{
  "botId": "your-bot-uuid",
  "action": "buy",
  "contracts": "50",
  "position_size": "100",
  "price": "1.15"
}
\`\`\`

| Field | Description |
|---|---|
| \`botId\` | Your bot's UUID (must match URL) |
| \`action\` | "buy" for long, "sell" for short |
| \`contracts\` | Position size (used for proportional sizing) |
| \`position_size\` | Strategy's max position (for ratio calculation) |
| \`price\` | Current price (optional, for logging) |

### Close Position

Set \`position_size: "0"\` to close the entire position:

\`\`\`json
{
  "botId": "your-bot-uuid",
  "action": "sell",
  "contracts": "0",
  "position_size": "0"
}
\`\`\`

### Response Format

Successful trades return details including the Solana transaction signature:

\`\`\`json
{
  "success": true,
  "action": "buy",
  "side": "long",
  "tradeId": "trade-uuid",
  "market": "SUI-PERP",
  "size": "43.47",
  "price": "1.15",
  "txSignature": "5xYz..."
}
\`\`\`

### Position Sizing

QuantumVault calculates trade size proportionally based on your bot's max position:

\`\`\`
Trade Size = (contracts / position_size) × Bot's Max Position
\`\`\`

**Example:** If your bot's max position is $100 and you send \`contracts: "50", position_size: "100"\`, QuantumVault will execute a $50 trade (50% of max).

### OpenClaw Skill Example

Create a skill file for OpenClaw to send signals to QuantumVault:

\`\`\`markdown
# QuantumVault Trader Skill

## Commands

### Go Long
POST {{QUANTUMVAULT_URL}}/api/webhook/{{BOT_ID}}
{
  "botId": "{{BOT_ID}}",
  "action": "buy",
  "contracts": "{{AMOUNT}}",
  "position_size": "100"
}

### Go Short
POST {{QUANTUMVAULT_URL}}/api/webhook/{{BOT_ID}}
{
  "botId": "{{BOT_ID}}",
  "action": "sell",
  "contracts": "{{AMOUNT}}",
  "position_size": "100"
}

### Close Position
POST {{QUANTUMVAULT_URL}}/api/webhook/{{BOT_ID}}
{
  "botId": "{{BOT_ID}}",
  "action": "sell",
  "contracts": "0",
  "position_size": "0"
}
\`\`\`

### Error Handling

Common error codes your agent may receive:

| Error | Cause |
|---|---|
| \`BOT_NOT_FOUND\` | Invalid botId in URL or payload |
| \`BOT_PAUSED\` | Bot is paused in QuantumVault |
| \`INSUFFICIENT_MARGIN\` | Not enough USDC for trade |
| \`EXECUTION_DISABLED\` | Execution not enabled in settings |
| \`DUPLICATE_SIGNAL\` | Same signal sent twice (auto-deduplicated) |

> QuantumVault automatically retries failed trades with exponential backoff. Your AI agent doesn't need to implement retry logic.

### Security Best Practices

- **Separate Concerns** — Your AI agent only sends signals — it never holds private keys. QuantumVault manages wallet security separately.
- **Set Position Limits** — Configure max position size in QuantumVault to limit exposure regardless of what signals your AI sends.
- **Test with Small Amounts** — Start with $10-50 max position until you've verified your AI's logic works correctly.

### Supported Markets

QuantumVault supports all Drift Protocol perpetual markets including:

\`SOL-PERP\` \`BTC-PERP\` \`ETH-PERP\` \`SUI-PERP\` \`APT-PERP\` \`ARB-PERP\` \`DOGE-PERP\` \`WIF-PERP\` \`BONK-PERP\` \`PEPE-PERP\` \`JUP-PERP\` \`RENDER-PERP\`

### Copy Trading Integration

Turn your AI trading signals into a subscription service:

1. Publish your bot in the Marketplace
2. Set your creator fee percentage (e.g., 10% of profits)
3. Others subscribe and copy your AI-generated trades
4. Earn automatically when subscribers profit

> **Note:** For full API documentation including all endpoints, see the detailed integration guide at \`/docs/OPENCLAW_INTEGRATION.md\` in the repository.

---

## QuantumLab Overview

QuantumLab is QuantumVault's built-in backtesting and strategy optimization engine. It lets you take any Pine Script strategy from TradingView, import it directly, and run thousands of parameter combinations against historical data to find configurations that actually perform well before risking real capital.

### What Makes It Different

- **Pine Script Native** — Paste your TradingView strategy code directly. QuantumLab's parser extracts all \`input.int()\`, \`input.float()\`, \`input.bool()\`, and \`input.string()\` declarations automatically, preserving groups, min/max ranges, steps, and options.
- **Automated Optimization** — Instead of manually tweaking parameters one by one, the optimizer tests thousands of random configurations, finds the best performers, and then refines around them. A single run can explore more combinations than months of manual testing.
- **Risk-Aware Scoring** — Results are ranked by a composite score that weighs low drawdown (40%), win rate (35%), profit factor (15%), and net profit (10%). This surfaces strategies that are consistent and survivable, not just the ones with the highest raw return.
- **Guided Mode** — After a few optimization runs, the Insights system analyzes your results and can guide future runs toward the most promising parameter ranges automatically, dramatically improving search efficiency.

### Accessing QuantumLab

Navigate to \`/quantumlab\` in your browser. QuantumLab is a standalone tool that does not require a wallet connection or any live trading setup. It operates entirely on historical data.

### Workflow

1. Import your Pine Script strategy into the Strategy Library.
2. Select a strategy, choose tickers and timeframes, and configure the optimizer.
3. Run an optimization — the engine backtests thousands of parameter combinations.
4. Review results sorted by composite score. Inspect individual trades and equity curves.
5. Use the Heatmap to compare performance across ticker/timeframe combinations.
6. Generate an Insights report to understand which parameters matter most.
7. Enable Guided Mode on subsequent runs to focus the search on the best ranges.
8. Export your best parameters back to Pine Script format for use in TradingView.

### Data Sources

QuantumLab fetches historical OHLCV (open, high, low, close, volume) candle data from OKX perpetual futures markets. For tickers not listed on OKX (such as DRIFT, TNSR, CLOUD, IO, DBR, and MNT), it automatically falls back to Gate.io.

Fetched candle data is cached in the database so subsequent runs on the same ticker, timeframe, and date range are instant. You can view cache statistics and clear the cache from the settings area.

> **Note:** QuantumLab runs backtests at true 1x leverage baseline ($1,000 initial capital with $1,000 position size). Risk analysis then calculates the maximum safe leverage from the observed drawdown, capped at 20x.

---

## Strategy Library

The Strategy Library is where you store and manage your Pine Script strategies. Each strategy preserves its full source code, parsed parameter definitions, and optimization history across runs.

### Importing a Strategy

1. Copy your full Pine Script strategy code from TradingView's Pine Editor.
2. Paste it into the code editor on the Main tab in QuantumLab.
3. Click "Parse" — the parser extracts all input declarations and displays them grouped by their Pine Script groups.
4. Give your strategy a name and click "Save" to add it to the library.

### What Gets Parsed

The Pine Script parser uses a quote-aware character-by-character approach (not regex) to correctly handle parentheses inside quoted strings like titles and tooltips. It extracts:

**Supported Input Types:**
- \`input.int()\` — Integer parameters
- \`input.float()\` — Decimal parameters
- \`input.bool()\` — Toggle parameters
- \`input.string()\` — Dropdown parameters

**Extracted Properties:** For each input: variable name, default value, title, min/max values, step size, group name, and options list (for string inputs). Date-related inputs like \`input.time()\` are automatically detected and excluded from optimization.

> **Important:** Make sure your Pine Script uses \`minval\` and \`maxval\` on your inputs. Without them, the optimizer has no range boundaries and will use very wide defaults, which leads to wasted iterations testing extreme or meaningless values.

---

## Optimizer

The optimizer is the core of QuantumLab. It takes your strategy's parsed parameters and systematically searches for combinations that produce the best risk-adjusted performance across your chosen markets and timeframes.

### Configuration

**Tickers & Timeframes:** Select one or more tickers (SOL, BTC, ETH, AVAX, etc.) and timeframes (1m, 5m, 15m, 30m, 1h, 2h, 4h, 8h, 12h). The optimizer runs each combination independently, so selecting 3 tickers and 2 timeframes means 6 separate optimization passes.

**Basic Settings:**
- **Date Range** — Historical period to backtest over. Longer ranges give more trades and more reliable statistics.
- **Random Samples** — How many random parameter combinations to test per ticker/timeframe combo. More samples means a wider search but longer run times. Default: 2,000.
- **Top K** — How many of the best random results to keep for refinement. Default: 10.
- **Refinements per Seed** — How many jittered variations to test around each top result. Default: 50.

**Advanced Settings:**
- **Min Trades** — Minimum number of trades a result must have to be considered valid. Filters out lucky one-trade wonders. Default: 10.
- **Max Drawdown Cap** — Maximum allowed drawdown percentage. Any configuration exceeding this is discarded. Default: 30%.
- **Min Avg Bars Held** — Minimum average bars a position must be held. Filters out same-bar scalp artifacts. Default: 1. Set to 0 for 8h/12h timeframes.
- **Mode** — "Random + Refine" runs both stages. "Random Only" skips the refinement phase for faster exploration.

### How the Search Works

1. **Random Search** — The optimizer generates random parameter combinations within each input's min/max range, respecting step sizes and option lists. Each combination is backtested against the historical data and scored.
2. **Refinement** — The top K results become "seeds." The optimizer generates small jittered variations around each seed — tweaking values by small amounts to explore nearby configurations. This often finds improvements that random search misses.

### Progress & Checkpointing

During a run, you can monitor progress in real time via the live progress display showing the current stage (Random Search / Refinement), iteration count, elapsed time, and best score so far. The optimizer saves checkpoints every 60 seconds, so if your session disconnects or the server restarts, the run automatically resumes from where it left off.

### Worker Thread Isolation

Optimization runs execute in a dedicated Node.js Worker Thread, completely isolated from the main server. This means even intensive multi-hour optimization jobs won't slow down your live trading, webhook processing, or position management. Only one optimization can run at a time.

---

## Backtesting Engine

The backtesting engine faithfully reproduces how a Pine Script strategy behaves on TradingView, including its entry/exit logic, indicator calculations, and order fill mechanics.

### Entry Logic

The engine uses a pending order system that matches TradingView's behavior. When the strategy generates a buy or sell signal on bar N, the entry is placed as a pending order and fills at the open price of bar N+1. This prevents look-ahead bias.

### Exit Modes

The engine supports two exit fill modes, controlled by the \`process_orders_on_close\` setting in your Pine Script's \`strategy()\` header:

**Intrabar Mode (default)** — When \`process_orders_on_close\` is \`false\` (or not set):
- Take-profit levels are checked against the bar's high (for longs) or low (for shorts)
- Stop-loss levels are checked against the bar's low (for longs) or high (for shorts)
- Trailing stops track bar extremes via high/low
- Fills happen at the exact TP/SL level price, not the next bar's open

**On-Close Mode** — When \`process_orders_on_close = true\`:
- TP/SL levels are checked against the bar's close price only
- Fills happen at the next bar's open price
- More conservative, may produce fewer stops than Intrabar mode

### Indicator Calculations

All indicators match TradingView's exact formulas:
- **Squeeze Momentum** — LazyBear formula: \`close - avg(avg(highest, lowest), sma)\`
- **Bollinger Bands** — Standard deviation bands around SMA
- **Keltner Channel** — SMA-based center with ATR-based bands (not EMA-based)
- **ATR** — RMA-based (Wilder's smoothing), matching TradingView's \`ta.atr()\`
- **Hull MA** — Weighted moving average for trend direction filtering
- **EMA** — Exponential moving average for trend bias filtering
- **RSI** — Relative Strength Index for extreme condition exits
- **ADX** — Average Directional Index for trend strength exits

### Stop Loss Modes

ATR-Based, Percentage, Bollinger Band, Keltner Band

### Take Profit Modes

Up to 3 independent take-profit levels, each with configurable quantity percentage: ATR-Based, Percentage, Risk Multiple (R:R)

### Advanced Exit Features

- **Trailing Stop** — Activates immediately, after TP1, or after TP2. Tracks close price as the position moves in your favor, then closes if price retraces by the trail offset. Trail tracking uses \`close\` (not high/low) per Pine's behavior.
- **Breakeven Stop** — Moves the stop loss to entry price (plus a configurable offset) after TP1 or TP2 is hit.
- **Conditional Exits** — Momentum flip, Hull MA flip, re-squeeze, RSI extreme, and ADX drop can each trigger a position close. These always use next-bar-open fills.

### Entry Filters

- **Squeeze Detection** — Standard mode requires BB inside KC. Alternative mode uses BB Width Percentile ranking.
- **Hull MA Trend Filter** — Only allows long entries when Hull MA slope is positive and short when negative.
- **EMA Trend Bias** — Longs only above the EMA, shorts only below.
- **Volume Surge Filter** — Requires current bar's volume to exceed volume SMA by a configurable multiplier.
- **Cooldown Bars** — Enforces a waiting period after a position closes before the next entry is allowed.
- **Candle Body Filter** — Requires minimum body-to-range ratio on entry candles.

### Leverage & Risk Math

All backtests run at 1x leverage ($1,000 capital, $1,000 position size). After the backtest completes, risk analysis calculates the maximum safe leverage:

\`\`\`
max_leverage = min(20, floor((100 / max_drawdown%) * 0.8))
\`\`\`

The 0.8 safety factor provides a 20% buffer. The hard cap is 20x regardless of how low the drawdown is.

---

## Results & Heatmap

### Results Tab

- **Run History** — Lists all completed and paused optimization runs with date, ticker/timeframe combos tested, number of results found, and status.
- **Result Cards** — Each result shows composite score, net profit %, win rate, max drawdown, profit factor, total trades, and the full parameter set used.
- **Trade Inspector** — Click any result to see its full trade list with entry/exit dates, direction, prices, PnL, and exit reason.
- **Equity Curve** — Visual plot of account equity over time for any individual result.
- **Export to Pine Script** — Generates Pine Script code with optimized parameter values injected back into your original strategy.

### Risk Analysis

Each result includes: Max Safe Leverage, Projected Return (at leverage), Max Drawdown at Leverage, and Risk Rating (Low / Medium / High).

### Heatmap Tab

A grid visualization showing how your strategy performs across all tested ticker/timeframe combinations. Each cell shows the best composite score, color-coded from red (poor) through yellow (average) to green (strong). Click any cell to see detailed results for that combination.

---

## Insights & Guided Mode

The Insights system analyzes data across all optimization runs for a strategy to surface statistical patterns — which parameters matter most, which ticker/timeframe combinations work best, and which value ranges consistently produce strong results.

### Generating a Report

1. Go to the Insights tab and select a strategy.
2. Optionally choose a specific ticker/timeframe focus (e.g., "SOL 2h") or leave on "All Results" for a general cross-market report.
3. Click "Generate Report." The report is auto-saved to the database for future reference.

### What the Report Contains

- **Parameter Sensitivity** — For each parameter, shows its impact score (how much it affects results), the best-performing value ranges split into buckets, and optimal direction. High-impact parameters are worth focusing on; low-impact ones can often be left at defaults.
- **Ticker & Timeframe Fit** — Ranks which tickers and timeframes consistently produce the strongest results for this strategy.
- **Directional Bias** — Shows whether the strategy performs better on long trades, short trades, or is balanced.
- **Trade Patterns** — Statistical analysis of trade duration, win/loss ratio, and exit reason distribution across all tested configurations.
- **Top 10 Best / Top 5 Worst Configurations** — The exact parameter sets that produced the best and worst results, with full metrics.
- **Parameter Correlations** — Which parameter combinations work together vs against each other.
- **Recommendations** — Actionable suggestions based on the analysis.

### Saved Reports

Reports auto-save when generated. Past reports are listed below the generate button with their timestamp, total results analyzed, and number of runs included. Click any saved report to load it without regenerating. Reports with a specific ticker/timeframe focus are labeled accordingly.

### Guided Mode

Guided Mode is an optional feature that uses your saved Insights reports to make future optimization runs smarter. Instead of searching completely randomly, the optimizer perturbs proven winning configurations to explore nearby parameter space more effectively.

**How Guided Mode Works:**

- **Perturbation Search (preferred)** — When your Insights report contains top configurations (the best-performing parameter sets), the optimizer picks a random seed from the top 10 and applies gaussian noise to each parameter. High-impact parameters get small perturbations (8% of range), medium-impact get 15%, and low-impact get 30% — focusing exploration where precision matters most. Booleans keep the seed value 85% of the time, strings 80%.
- **Bucket Search (fallback)** — If no top configurations are available (older reports), the optimizer falls back to narrowing parameter ranges to the best-performing quartile buckets from the sensitivity analysis.
- **80/20 Split** — 80% of samples use guided parameters (perturbation or bucket), while 20% remain fully random to avoid getting trapped in local optima.
- **Per-Combo Preference** — If a filtered insights report exists for the specific ticker/timeframe being optimized (e.g., a "SOL 2h" focused report), the optimizer prefers that over a general report. It falls back to the latest general report if no focused match exists.
- **Refinement Unchanged** — The jitter/refinement stage around top results works the same way whether guided mode is on or off.

### Enabling Guided Mode

1. Run 2-3 standard optimization runs first (2,000+ random samples each) to build up enough data.
2. Generate an Insights report on the Insights tab.
3. On the Main tab, open Advanced Settings and toggle "Use Insights" on.
4. Run your optimization. The progress label will show "Perturbation Search" (with top configs) or "Guided Search" (bucket fallback) instead of "Random Search."

> **Warning:** Don't enable Guided Mode on your first optimization runs. The sensitivity analysis needs at least ~4,000 total configurations tested across multiple runs to distinguish real patterns from noise. Using it too early may narrow the search prematurely.

> **Note:** Guided Mode is off by default. The toggle only appears when the selected strategy has at least one saved Insights report. Regenerate your report after running more optimizations to update the top configs that perturbation uses.

---

*QuantumVault — Built on Solana. Powered by Drift Protocol.*
*Website: [https://myquantumvault.com](https://myquantumvault.com)*
`;

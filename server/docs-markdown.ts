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

*QuantumVault — Built on Solana. Powered by Drift Protocol.*
*Website: [https://myquantumvault.com](https://myquantumvault.com)*
`;

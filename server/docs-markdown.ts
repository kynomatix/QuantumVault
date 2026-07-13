export const DOCS_MARKDOWN = `# QuantumVault Documentation

> **QuantumVault** — Automated perpetual futures trading on Solana.
> Website: [https://myquantumvault.com](https://myquantumvault.com)

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Wallet Setup](#wallet-setup)
3. [Funding Your Account](#funding-your-account)
   - [Deposit Any Token (Auto-Swap to USDC)](#deposit-any-token-auto-swap-to-usdc)
   - [Supported Exchanges & Withdrawal Costs](#supported-exchanges--withdrawal-costs)
4. [Creating Trading Bots](#creating-trading-bots)
   - [Profit Reinvest](#profit-reinvest)
   - [Auto Withdraw](#auto-withdraw)
   - [Auto Top-Up](#auto-top-up)
   - [Auto-Park Idle Funds](#auto-park-idle-funds)
   - [Using These Features Together](#using-these-features-together)
5. [TradingView Integration](#tradingview-integration)
6. [Bot Management](#bot-management)
7. [Marketplace](#marketplace)
8. [Settings & Referrals](#settings--referrals)
9. [Security](#security)
10. [Trade Execution](#trade-execution)
11. [AI Agent Integration](#ai-agent-integration)
12. [Vaults Overview](#vaults-overview)
13. [Yield Destinations](#yield-destinations)
14. [Safety & Funding](#safety--funding)
15. [Borrow Overview](#borrow-overview)
16. [Per-Bot Borrow](#per-bot-borrow)
17. [QuantumLab Overview](#quantumlab-overview)
18. [Strategy Library](#strategy-library)
19. [Optimizer](#optimizer)
   - [Out-of-Sample Validation & Robustness Score](#out-of-sample-validation--robustness-score)
20. [Backtesting Engine](#backtesting-engine)
21. [Results & Heatmap](#results--heatmap)
22. [Insights & Guided Mode](#insights--guided-mode)
23. [Lab Assistant](#lab-assistant)

---

## Getting Started

QuantumVault is an automated trading platform built on Solana that connects your TradingView alerts to perpetual futures trading. Execute trades automatically based on your technical analysis signals with minimal latency.

### How It Works

1. **Connect Wallet** — Connect your Solana wallet to create your account and agent wallet.
2. **Fund Your Account** — Deposit SOL for transaction fees and USDC for trading.
3. **Create a Bot** — Set up a trading bot with your preferred market and leverage settings.
4. **Connect TradingView** — Set up webhook alerts in TradingView to trigger your bot's trades.

> **Note:** All trades are executed on decentralized perpetual futures exchanges on Solana. Your funds remain in your control through your agent wallet.

---

## Wallet Setup

QuantumVault uses a two-wallet system for security and automation: your personal Solana wallet for deposits/withdrawals, and a platform-managed agent wallet for executing trades.

### Your Solana Wallet

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

> **Warning:** Never share your agent wallet's address publicly. While funds can only be withdrawn to your connected Solana wallet, keeping your setup private adds an extra layer of security.

### Connecting Your Wallet

1. Install a Solana wallet — Phantom (phantom.app), Jupiter, or any Wallet Standard-compatible wallet
2. On Solana Seeker, your on-device wallet is detected automatically via Mobile Wallet Adapter
3. Visit QuantumVault and click "Connect Wallet"
4. Approve the connection in your wallet
5. Complete the welcome flow to fund your agent wallet

---

## Funding Your Account

To start trading, you need to fund your agent wallet with both SOL (for transaction fees) and USDC (for trading capital).

### SOL for Account Setup & Fees

SOL covers a one-time account setup (~0.05 SOL for your trading account initialization) plus ongoing transaction fees. We recommend depositing at least 0.1 SOL to cover setup and many trades. Flash bots each run from their own wallet, so they need a little extra SOL (about 0.025 SOL per bot) the first time you create them — see Supported Exchanges below.

| Item                     | Amount          |
|--------------------------|-----------------|
| Recommended SOL deposit  | 0.1 - 0.5 SOL  |
| Typical trade cost       | ~$0.002         |

### USDC for Trading

USDC is the trading currency. Your USDC is held in your agent wallet and can be allocated to individual bots or your trading account.

### Deposit Any Token (Auto-Swap to USDC)

You don't need to already hold USDC. QuantumVault accepts almost any Solana asset — SOL or any SPL token in your wallet — and automatically converts it to USDC for trading.

1. Open the deposit dialog and switch to the **"Any asset"** tab — your wallet's tokens are listed with their balances and dollar values.
2. Pick a token and amount. A live quote shows how much USDC you'll receive, including price impact.
3. Sign one transfer in your wallet to move the token into your bot wallet.
4. QuantumVault converts it to USDC for you automatically, routed through Jupiter for the best available price.

> **Note:** Swaps use a 1% slippage limit by default, and you'll be warned before confirming if a token's price impact is high (over 3%). When you deposit SOL, a small amount (~0.02 SOL) is kept back to cover network fees.

If the transfer goes through but the conversion doesn't, your token stays safely in your bot wallet — just tap **Retry conversion** in the deposit dialog to finish the swap. No funds are lost.

**For AI agents:** Call \`GET /api/wallet/tokens\` to list swappable tokens, \`GET /api/swap/quote?inputMint=<mint>&amountRaw=<raw>\` for a quote, then \`POST /api/agent/deposit-token\` ({ mint, amountRaw }) to build the user transfer, and \`POST /api/agent/swap-to-usdc\` ({ mint }) to run the server-side swap. If the swap step fails, retry \`POST /api/agent/swap-to-usdc\` — the token is already in the bot wallet and the swap is idempotent.

### Capital Flow

\`\`\`
Your Solana Wallet → Agent Wallet → Trading Account
\`\`\`

When you deposit to a bot, funds move from your agent wallet to that bot's trading subaccount. Each bot has an isolated subaccount for safety.

> **Tip:** Your USDC may earn interest while deposited in the exchange. The current APY (if available) is displayed in your bot settings.

### Supported Exchanges & Withdrawal Costs

QuantumVault routes each bot to a perpetual exchange on Solana. You choose the exchange when you create a bot (Pacifica is the default). Minimum transfer amounts and withdrawal fees are set by each exchange, not by QuantumVault:

| Exchange            | Minimum transfer | Withdrawal fee | SOL to create a bot | Wallet model |
|---------------------|------------------|----------------|---------------------|--------------|
| Pacifica (default)  | $10 USDC         | $1 USDC        | ~0.005 SOL          | Isolated subaccount under your agent wallet |
| Flash               | 0.1 USDC         | None           | ~0.025 SOL (reclaimed on delete) | Isolated per-bot wallet (recoverable from your 24-word phrase) |
| Drift (legacy)      | 0.1 USDC         | None           | n/a (no new bots)   | Isolated subaccount |

> **Note:** Pacifica is the only exchange with a real protocol minimum ($10) and an on-chain withdrawal fee ($1), so QuantumVault batches small amounts into larger withdrawals. Flash and Drift transfers carry no fee and only a small 0.1 USDC floor.

> **Drift is legacy:** Existing Drift bots keep running, but you can no longer create new ones. New bots are created on Pacifica or Flash.

**Which should you pick?** Pacifica is the simple default. Flash is better for smaller amounts (no $10 floor) and frequent profit-taking (no withdrawal fee), and each Flash bot runs from its own wallet that you can always recover from your 24-word recovery phrase — it just needs a bit more SOL up front to create. Creators who publish Flash bots are also paid their profit share immediately as trades close, rather than in a later batch.

---

## Creating Trading Bots

Bots are automated trading agents that execute trades based on TradingView webhook signals. Each bot trades a single market with your specified settings.

### Bot Settings

- **Exchange** — Choose where the bot trades: **Pacifica** (default) or **Flash**. Your choice sets the fees, minimums, and how much SOL is needed to create the bot (see Funding → Supported Exchanges). If your agent wallet is low on SOL, QuantumVault prompts you to top up before the bot can be created.
- **Market** — Choose which perpetual market to trade (e.g., SOL-PERP, BTC-PERP, ETH-PERP). Each bot trades one market only.
- **Leverage** — Set your leverage multiplier (1x to 20x depending on market). Higher leverage amplifies both gains and losses.
- **Investment Amount** — The USDC amount allocated to this bot. This is your maximum position size before leverage.
- **Direction** — Choose "Both" for long and short signals, or restrict to "Long Only" or "Short Only".

> **Flash TP/SL note:** On Flash, very small positions can be too small to attach automatic take-profit / stop-loss orders. If you rely on TP/SL, give the bot enough capital (and leverage) so each position clears Flash's minimum size.

### Automated Capital Management

These features let you fully automate how your bot handles money. Instead of manually depositing, withdrawing, and adjusting your investment — the system does it for you. In a bot's settings they're grouped into **Position Growth** (how the bot sizes its trades) and **Cash Management** (what happens to profits and idle cash).

- **Profit Reinvest** — Grow your trades as you win *(Position Growth)*
- **Auto Top-Up** — Refill when running low *(Position Growth)*
- **Auto Withdraw** — Take profits automatically *(Cash Management)*
- **Auto-Park Idle Funds** — Earn yield between trades, Flash only *(Cash Management)*

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

### Auto-Park Idle Funds

*Flash bots only.* Turn this on and your bot's spare USDC never sits idle. About a minute after a position fully closes, the leftover cash is parked into a yield Vault automatically — then pulled back just before the next trade. You earn between trades without lifting a finger.

#### The full cycle

1. Spare USDC sits in a yield Vault, earning.
2. A trade signal arrives.
3. The Vault unparks to back the trade — by default, everything, for the full safety buffer.
4. The position opens and runs.
5. The position fully closes (take-profit, stop-loss, or a close signal).
6. About a minute later, the leftover USDC is parked again — back to earning.

If a new trade opens during that short wait (a quick flip or re-entry), the repark is skipped, so funds the bot is about to use are never parked by mistake. Parking is also skipped when there's less than about $5 of spare cash, to avoid tiny, pointless transfers. It's a persistent per-bot setting — turn it on once and it keeps working after every trade.

#### Choose your yield token — and switch any time

Each Flash bot remembers which yield Vault it parks into. Pick the token once in the bot's settings and it sticks — every auto-park and manual park uses it. Change it whenever you like and hit **Save**: if money is already parked in the old token, QuantumVault **moves it into the new one for you** — one swap, no manual unpark-then-repark. If the bot is mid-trade when you switch, the move happens automatically the next time the position fully closes.

#### Full buffer, or keep spare earning

You decide how much comes back when a position opens. **Full buffer** (the default, and the safest) pulls **all** your parked USDC back, so your entire cash cushion is backing the trade — parking can never thin the buffer that keeps a position away from its liquidation price. **Keep spare earning** pulls back only enough to fund the trade and leaves the rest earning yield — a slimmer cushion, your call. In **Full buffer** mode, if your parked funds can't be pulled back when a trade is about to open, the bot **skips that signal and tries again** rather than opening with a reduced buffer. Keep spare earning trades with whatever margin is already free.

> ℹ️ Available on Flash bots, where each bot has its own isolated wallet. See **Vaults → Safety & Funding** for the money-safety details.

---

### Using These Features Together

These features are compatible and can create powerful automation.

#### "Keep $100 Working" Strategy

**Configuration:** Profit Reinvest ON • Auto Withdraw at $100 • Auto Top-Up ON • Auto-Park ON (Flash)

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

- **Margin Buffer** — The exchange requires a safety cushion to accept orders
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

QuantumVault sends trade alerts and on-demand reports via **@QuantumVaultAlertsBot** on Telegram. No third-party service required — it uses Telegram's Bot API directly.

#### Connecting Telegram

1. Open Settings → Telegram and click **Connect Telegram**
2. A QR code appears — scan it with your phone's camera, or tap the link on mobile
3. Telegram opens the bot and sends \`/start\` automatically
4. The bot replies "✅ Connected to QuantumVault!" and your wallet is linked
5. The settings panel updates to Connected status

> **Tip:** You can link the same Telegram chat to multiple QuantumVault wallets by repeating this flow from each wallet's Settings.

#### Alert Types

| Alert | Trigger |
|-------|---------|
| Trade Executed | Bot successfully opens a position |
| Trade Failed | Execution error (includes reason) |
| Position Closed | Position closes — includes realized PnL |
| Daily Summary (opt-in) | One message per day at 16:00 UTC: equity, 24h PnL, trade count, open positions |

#### Bot Commands

Once connected, message the bot directly for on-demand info:

| Command | What it does |
|---------|-------------|
| \`/status\` | Shows which wallets are linked to this chat |
| \`/accounts\` | Lists all linked QuantumVault wallets |
| \`/summary\` | Equity, 24h PnL, and open positions snapshot |
| \`/positions\` | All open positions across linked wallets |
| \`/today\` | Today's trades and realized PnL |
| \`/help\` | Shows all available commands |
| \`/disconnect\` | Unlinks every wallet from this chat |

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
- **Reset Trading Account** — Closes all positions, withdraws funds, and deletes all bot subaccounts. Start fresh.
- **Reset Agent Wallet** — Withdraws all funds to your Solana wallet and creates a completely new agent wallet.

---

## Security

QuantumVault is built with institutional-grade security to protect your trading capital. Your funds are always under your control.

### Your Keys, Your Control

- **You Own Your Agent Wallet** — Each user gets a dedicated Solana wallet for trading. You can back it up with a standard 24-word recovery phrase and restore it in any Solana wallet.
- **Your Wallet Keys Stay Yours** — Your connected wallet's keys are never stored or transmitted. We only ask you to sign messages to verify your identity — never transactions that could drain your wallet.

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
- Cannot be accessed without your connected Solana wallet

### Trade Execution Security

- **Signature-Based Authorization** — Before any bot can trade, you must explicitly enable execution by signing a message with your Solana wallet. You can revoke this at any time.
- **Bot Policy Protection** — Your trading limits (max position size, leverage, markets) are cryptographically protected. Any tampering is automatically detected and blocked.
- **Emergency Stop** — One-click to revoke all execution authorization, close all positions, or reset your entire agent wallet if needed.

### What We Never Do

- ❌ Store your wallet's private keys
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

#### Secure Your Solana Wallet

- Consider using a hardware wallet (Ledger via Phantom or Solflare)
- Enable your wallet's auto-lock feature
- Never sign unknown messages

> QuantumVault's security has been reviewed by internal architects and AI-assisted security audits. We continuously update our security practices to protect your funds.

---

## Trade Execution

QuantumVault executes your trades on decentralized perpetual futures exchanges on Solana. The platform handles order routing, retry logic, and position management so your signals are executed reliably with minimal latency.

### How Trades Are Executed

When a trading signal is received, QuantumVault handles the full execution pipeline automatically:

1. Your bot receives a trading signal (from TradingView or AI agent)
2. QuantumVault validates the signal and checks your current position
3. The trade is submitted to the exchange with optimized parameters
4. Trade is settled on-chain — you can verify it on Solana explorer

### Execution Features

- **Low Latency** — Trades are submitted directly to the exchange with minimal delay from signal to execution.
- **Automatic Retry** — Failed trades are automatically retried with RPC failover to ensure your signals get executed.
- **Competitive Fees** — Trading fees are kept low through optimized exchange routing and fee tier management.
- **Position Safety** — Before every trade, QuantumVault verifies your current position to prevent double exposure or conflicting orders.

### Trade Size

#### How Notional Value Is Calculated

Notional value = number of contracts × current price. For example, trading 0.5 SOL-PERP at $120 = $60 notional value.

| Parameter | Value |
|---|---|
| Minimum Trade Size | Varies by exchange |

### What You Need to Know

- A one-time account setup (~0.05 SOL) is required when you first start trading. This covers your trading account initialization.
- Each bot has its own isolated trading subaccount for safety. Funds are managed per-bot.
- In rare edge cases, a trade may take a few extra seconds due to network conditions. This is normal and your trade will still complete.

### Execution Status

| Parameter | Value |
|---|---|
| Execution Status | ✅ Active |
| Retry Logic | Automatic |
| Setup Required | One-time account initialization |

---

## AI Agent Integration

Connect AI trading agents like OpenClaw, AutoGPT, or custom LLM-powered bots to QuantumVault for automated perpetual futures trading. Your AI handles the intelligence, QuantumVault handles safe execution.

> **Note:** AI agents send webhook signals just like TradingView. QuantumVault executes trades with automatic retry, RPC failover, and position management.

### Why Use QuantumVault as Your Execution Layer?

**Your AI Agent:**
- Market analysis & signals
- Sentiment monitoring
- On-chain tracking
- Decision making

**QuantumVault:**
- Exchange execution
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

QuantumVault supports a wide range of perpetual markets including:

\`SOL-PERP\` \`BTC-PERP\` \`ETH-PERP\` \`SUI-PERP\` \`APT-PERP\` \`ARB-PERP\` \`DOGE-PERP\` \`WIF-PERP\` \`BONK-PERP\` \`PEPE-PERP\` \`JUP-PERP\` \`RENDER-PERP\`

### Copy Trading Integration

Turn your AI trading signals into a subscription service:

1. Publish your bot in the Marketplace
2. Set your creator fee percentage (e.g., 10% of profits)
3. Others subscribe and copy your AI-generated trades
4. Earn automatically when subscribers profit

> **Note:** For full API documentation including all endpoints, see the detailed integration guide at \`/docs/OPENCLAW_INTEGRATION.md\` in the repository.

---

## Vaults Overview

Vaults come in two kinds. **Stable Vaults** park your idle USDC into a yield token that trades near $1 — simple, lower-risk, one tap in and one tap out. **Asset Vaults** put your SOL or other assets into a DeFi strategy that the platform manages automatically on your behalf — higher yield potential, but more complex and leveraged.

Both types live in the Vaults tab. You can use them independently or together.

### What Makes It Different

- **Custody, not a casino** — Your funds stay in your own agent wallet the whole time. QuantumVault only signs the move into and out of the yield token; it never takes custody of your money.
- **One tap in, one tap out** — There are no sliders or amounts to set. "Park all spare USDC" puts your full idle balance to work; "Unpark all to USDC" pulls the whole position back. The platform reads your real on-chain balance and moves all of it.
- **Always counted** — Parked funds still count as part of your balance and your profit/loss, so parking money never looks like a loss. The live value of your position is always included in your totals.
- **Funds your trades automatically** — When you open a trade and your spendable USDC isn't enough, your Vault automatically pulls it back to fund the position — a Flash bot restores its full safety buffer by default, while account-level parking pulls back just what's needed. You never have to unpark by hand before trading.

### Where to Find It

Open your dashboard and select the **Vaults** tab. You'll see how much spare USDC you have, plus a short menu of yield destinations shown as cards. Tap a card to open its details, then park or unpark.

### How It Works

1. Open the Vaults tab — your spare (idle) USDC is shown at the top.
2. Pick a yield destination card and open it.
3. Tap "Park all spare USDC" — the platform moves your full idle balance into the yield token.
4. Your position now earns; its live value shows as "Earning" on the card.
5. Tap "Unpark all to USDC" anytime to pull the whole balance back to plain USDC.

> **Note:** Your funds stay in your wallet — QuantumVault only handles the move. Every park and unpark is capped at a small price-impact limit, so a thin market can't move your money at a bad price.

---

## Stable Vaults

Stable Vaults park your idle USDC into yield tokens that trade near $1 — a simple way to put spare cash to work without taking on extra complexity. One tap to park your full idle balance, one tap to pull it all back.

### Two Types of Stable Destination

- **Stable** — Trades near $1 and earns yield. Your principal stays in USDC terms and the value accrues over time. The lower-risk choice.
- **Floating** — The price can move up or down rather than holding a fixed $1. Higher potential yield, but one option (OnRe ONyc) can lose value.

### Available Destinations

The ranges below are estimates (marked "est."). In the app, once a destination's real return is available, the live number replaces the estimate automatically. Measured rates come from public on-chain yield data and reflect each destination's recent realized return — not reward-token incentives a passive holder may not receive.

- **Kamino USDC** (~4-9% est., Stable) — Your USDC is supplied to Kamino's USDC lending market and earns interest. Principal stays in USDC terms.
- **Perena USD\\*** (~10% est., Stable) — A yield-bearing stablecoin backed by a pool of stablecoins. Trades near $1; value accrues from the pool's yield.
- **Jupiter Lend USDC** (~4-5% est., Stable) — Your USDC is supplied to Jupiter's USDC lending market and earns interest. Principal stays in USDC terms.
- **Ondo USDY** (~4-5% est., Floating) — A Treasury-backed yield token. Non-US persons only (Regulation S). The price floats up as it earns.
- **OnRe ONyc** (~10-12% est., Floating) — Tokenized reinsurance. The price floats with insurance results and can lose value — the highest-risk option here.

> **Important:** "est." ranges are estimates, not guarantees; the app shows the real measured rate once it's available. No APY is guaranteed — they move with market conditions. Floating destinations can change in value: OnRe ONyc can lose value, and Ondo USDY is restricted to non-US persons under its own terms. Choose what fits your situation.

---

## Safety & Funding

Vaults are built money-safe first. The platform never guesses about your money — it reads the blockchain, acts only on what actually happened, and stops if anything looks wrong.

### Money-Safety Principles

- **On-chain truth** — Balances are read directly from the blockchain, never estimated. What the chain says is the source of truth.
- **Realized amounts only** — You're credited only the actual USDC that comes back from a move, not an expected or quoted amount.
- **Price-impact cap** — Every park and unpark is capped at a small price-impact limit, so a thin market can't move your money at a bad price.
- **Fail-closed** — If a balance can't be read or a move looks unsafe, the action stops rather than risk your funds.

### Parked Funds Still Count

Your parked position is always included in your total balance and your profit/loss — whether you park at your account level or for an individual bot. Parking spare USDC into a Vault never shows up as a loss, and a bot whose spare cash is parked never reads as empty: the live value of what you've parked is counted right alongside your trading funds.

### Parked Funds Back Your Trades

When you place a trade — by hand or from a TradingView/webhook signal — and your spendable USDC isn't enough to cover it, QuantumVault automatically unparks your spare cash to fund it. A Flash bot pulls back its **full buffer** by default — every parked dollar, so your whole cushion backs the position (you can switch it to just-enough in the bot's settings). Account-level parking pulls back just what the trade needs, plus a small buffer for fees and price movement. Either way, a parked bot is never falsely paused as "underfunded," the rest keeps earning, and you don't have to remember to unpark first.

> **Note:** This auto-funding is hands-off by design. A Flash bot restores its full buffer by default; account-level parking pulls back only what the trade needs. Either way, you don't lift a finger.

### Reparked After Each Trade (Auto-Park Idle Funds)

The other half of hands-off cash management. Turn on **Auto-park idle funds** in a bot's settings and, about a minute after the bot's position fully closes, all its spare USDC is parked back into yield automatically — so the cash earns between trades instead of sitting idle. If a new trade opens during that short wait (a quick flip or re-entry), the repark is skipped, so funds the bot is about to use are never parked by mistake. Parking is also skipped when there's less than about $5 of spare cash, to avoid tiny, pointless transfers.

Put together with the auto-funding above, a Flash bot runs a fully automatic loop:

1. Spare USDC sits in a yield Vault, earning.
2. A trade signal arrives.
3. The Vault unparks to back the trade — by default, everything, for the full safety buffer.
4. The position opens and runs.
5. The position fully closes (take-profit, stop-loss, or a close signal).
6. About a minute later, the leftover USDC is parked again — back to earning.

> **Note:** Auto-park idle funds is available on Flash bots, where each bot has its own isolated wallet. It's a persistent per-bot setting — turn it on once and it keeps working after every trade. All the same money-safety rules apply: on-chain truth, realized amounts only, price-impact cap, and fail-closed.

---

## Asset Vaults

Asset Vaults are a different kind of vault from the Stable Vaults above. Instead of parking idle USDC into a yield token, an Asset Vault puts your SOL or other assets to work through a DeFi strategy — fully managed by the platform on your behalf.

### Stable Vaults vs Asset Vaults

- **Stable Vaults** — Your USDC earns yield in a near-$1 token. Simple, lower-risk, one tap in and one tap out. Great for idle trading capital.
- **Asset Vaults** — Your SOL or other assets run a DeFi strategy. Leveraged positions, higher yield potential, and fully automated management — but with more risk.

### Automated Management

Asset Vaults are actively managed. The platform checks each position every minute and acts without you having to do anything: it unwinds automatically if conditions turn against you, re-engages when they improve, and can switch pairs when a better opportunity opens up. You receive a Telegram alert for every significant action.

> **Important:** Asset Vaults use leverage. A leveraged position can be liquidated if borrow rates spike sharply or market conditions move against it quickly. Only use funds you can afford to have tied up in a position.

---

## SOL Loop Vault

The SOL Loop Vault earns boosted staking yield by looping your SOL through a liquid staking token (LST). You pick an LST pair and a leverage level; the platform opens and manages the position automatically from that point on.

### How the Loop Works

A loop multiplies your effective staking yield. In plain terms:

1. Your SOL is converted to an LST (INF, mSOL, JitoSOL, JupSOL, or dfdvSOL).
2. That LST is used as collateral to borrow more SOL.
3. The borrowed SOL is also converted to the same LST.
4. Now you hold more LST than you started with — the whole stack earns staking yield.
5. The borrow costs a rate; the staking yield across the whole stack has to beat it to produce a net gain.

At 3× leverage, for example, you earn staking yield on roughly 3× your original SOL, minus the borrow rate on the extra 2× you borrowed. If the LST yields 8% and the borrow costs 4%, your net is roughly 8% × 3 − 4% × 2 = 16% on your original SOL. Rates shift with the market, so the platform monitors them every minute.

### What the Platform Manages For You

- **Automatic safety unwind** — If your health factor drops toward liquidation, or borrow rates flip so the position is losing money, the platform fully unwinds to unleveraged holding. Your LST stays in your wallet but the debt is cleared. You get a Telegram alert.
- **Automatic re-levering** — After a safety unwind, when conditions improve, the platform re-opens the loop at your chosen leverage. You earn again without lifting a finger.
- **Pair switching (hopping)** — The platform watches all available LST pairs. If another pair consistently pays more — at least 2% better APY for three consecutive checks — it fully unwinds the current position and re-loops onto the better pair. Your funds stay in the vault the whole time. You get a Telegram notification when this happens.

### Available Pairs

- **INF** (Infinity by Sanctum) — Diversified LST index, broad exposure.
- **mSOL** (Marinade staked SOL) — Liquid staking from Marinade Finance.
- **JitoSOL** (Jito staked SOL) — Includes MEV rewards on top of staking yield.
- **JupSOL** (Jupiter staked SOL) — Jupiter's liquid staking token.
- **dfdvSOL** (DeFi Development Corp Staked SOL) — Corporate validator LST from DFDV (Nasdaq-listed). Currently the highest staking yield of the five pairs. Its lending liquidation threshold is lower (0.80 vs 0.95 for the others), which caps effective leverage at ~2.6× — lower than the other pairs but still profitable when carry is positive.

### How to Open a Position

1. Open the **Vaults** tab and find the Asset Vaults section.
2. Tap the SOL Loop card to see current rates for each pair.
3. Pick your LST pair — the live carry rate for each is shown.
4. Choose your leverage — up to ~3.7× for INF, JitoSOL, and JupSOL; ~3.2× for mSOL; ~2.6× for dfdvSOL.
5. Confirm — the platform opens the loop on-chain and starts monitoring it.

### Risks

- **Liquidation risk** — A leveraged position can be partially liquidated if the health factor falls too low. The platform unwinds early to try to prevent this, but cannot guarantee protection in sudden, extreme market moves.
- **Rate risk** — If borrow rates rise above the staking yield, the position costs money to hold. The platform unwinds automatically in this case, but you may exit at a loss if rates moved sharply.
- **LST depeg risk** — LSTs track SOL closely but are not perfectly pegged. A significant depeg event would reduce collateral value and could trigger a safety unwind or, in a severe case, a partial liquidation.

> **Note:** You receive a Telegram notification for every automatic action — safety unwind, re-lever, and pair switch. If Telegram alerts are off, check the position card in the Vaults tab for its current status.

---

## Borrow Overview

Borrow lets you use lending collateral you already hold — such as SOL, a staked-SOL token, or BTC — as security to borrow extra USDC without selling anything. The borrowed cash lands in your account wallet (or straight into a bot), so your trading capital grows while your collateral stays intact.

This is different from a loan from a bank. You never hand your collateral to QuantumVault. The collateral token stays in your own agent wallet; the platform only signs the on-chain borrow instruction. You can repay the debt anytime to release your collateral.

> **Note:** Borrow is built on Jupiter Lend (Fluid), a lending protocol with high capital efficiency. It runs in isolated vaults — one collateral asset paired with one debt asset (USDC) per position.

### Supported Collateral

You can borrow USDC against any of these assets:

- **SOL & staked SOL** — SOL, INF, JitoSOL, mSOL
- **Bitcoin** — WBTC, cbBTC, xBTC, LBTC
- **Other tokens** — JLP, JUP, syrupUSDC
- **Tokenized stocks** — TSLAx, NVDAx, SPYx, QQQx (available only during US market hours; their price feeds go stale off-hours by design)

The Lending section only shows the collaterals you already hold in your wallet — by design, so the list stays focused on what you can actually supply. If you hold a supported asset but do not see it, make sure it is in your account wallet.

### What Makes It Different

- **Keep your collateral** — You borrow USDC against your collateral without selling it. It stays in your wallet — and if it is a staked-SOL token like INF or JitoSOL, it keeps earning staking yield — while the borrowed USDC funds your trades.
- **One position per collateral** — You can open one borrow position per collateral type. The position tracks your pledged collateral, your owed USDC, and your health factor in real time.
- **Borrowed cash is real trading capital** — The USDC you borrow lands directly in your account wallet (or bot wallet for per-bot borrowing) and can be used for trades immediately. It is treated as a liability, not a deposit, so your profit/loss stays honest.
- **Repay anytime** — Tap "Repay Debt" to clear all or part of the loan. Partial repayments lower your debt; full repayments close the position and return your collateral.

### Where to Find It

Open the **Wallet** page and look for the **Lending** section. It shows your open borrow positions, pledged collateral, live health factor, and the eligible collaterals you currently hold — ready to supply.

### How It Works

1. Supply collateral — Pick an eligible collateral (e.g. INF) from the list and add it to the lending pool. The tokens stay in your wallet but are now pledged.
2. Borrow USDC — Choose how much USDC to borrow, up to a safe limit computed from your collateral value and the vault's maximum LTV. The cash arrives in your wallet immediately.
3. Trade or park — Use the borrowed USDC for bots, or park it into a Vault for yield (a "carry trade" — see below).
4. Repay or close — Repay the debt in full or in part. A full repayment closes the position and releases your collateral.

> **Important:** Borrowed USDC is a liability. It is subtracted from your displayed net worth so your profit/loss is not inflated. The cash itself is real — you can trade with it — but the debt is tracked separately and must be repaid.

### Borrow Rate (APR)

The interest you pay is called the borrow rate and is shown as an APR on your position. It is the cost of keeping the loan open. The rate changes with market demand for USDC in the lending pool. Your position card shows the live rate; it is updated from the blockchain each time you open the page.

### Health Factor & Liquidation

Your position has a health factor that measures how close you are to liquidation:

- **Healthy** — Your collateral value is well above the minimum required. You can borrow more or withdraw collateral safely.
- **Caution** — Your collateral value is getting close to the minimum. Consider repaying part of the debt or adding more collateral.
- **Critical** — Your position is at risk of liquidation. If the collateral value drops further, the protocol may sell part of your collateral to cover the debt. You will receive a Telegram alert before this happens.

The liquidation threshold is the collateral price at which your position becomes at risk. It is shown on your position card. If the price approaches this level, act promptly.

### Carry Trade

A carry trade is when you borrow USDC at one rate and park it into a Vault destination that earns a higher rate. The difference is your net edge:

- Positive edge (Vault APY > borrow APR) — The Vault earns more than the loan costs. Net gain.
- Negative edge (Vault APY < borrow APR) — The loan costs more than the Vault earns. Net loss.

The Equity tab on a bot with an open per-bot borrow shows a "Carry Advisor" that recommends whether to park, repay, or hold based on the current edge. It is read-only — you tap to act, the advisor does not act on its own.

> **Warning:** A carry trade is not risk-free. The collateral price can drop (liquidation risk), the Vault yield can change, and the borrow rate can rise. The advisor only compares rates; it does not protect you from price moves.

---

## Per-Bot Borrow

Per-bot borrow is the same idea as account-level borrow, but scoped to a single bot. You pledge the bot's own eligible collateral, borrow USDC against it, and the cash lands directly in that bot's balance. When the bot closes, the system automatically repays the debt and returns the collateral to your account.

This is available on Flash bots, where each bot has its own isolated wallet.

### Where to Find It

Open a bot's **Bot Management Drawer** and go to the **Equity** tab. If the bot holds eligible collateral, you will see a "Borrow Against Collateral" card. Tap it to open the borrow flow.

### How It Works

1. Open the Equity tab on a Flash bot that holds eligible collateral.
2. Tap "Borrow Against Collateral" — the system shows your pledged collateral, current debt, and a safe borrow limit.
3. Choose an amount and confirm. The USDC lands in the bot's wallet immediately.
4. The bot's displayed balance grows by the borrowed amount, but the debt is subtracted from its net PnL so the numbers stay honest.
5. When you close or delete the bot, the system automatically repays the debt and moves the released collateral back to your account.

### Automatic Close & Repay

When you unsubscribe or delete a bot with an open per-bot borrow:

1. The system checks if the bot still owes USDC.
2. If yes, it funds a small USDC top-up from your account wallet (to cover accrued interest), then repays the full debt.
3. Once the debt is cleared, it withdraws the collateral and transfers it back to your account wallet.
4. The position is closed and the collateral is yours again.

This is fully automatic. You do not need to manually repay before closing a bot.

> **Note:** The auto-repay step uses your account's spare USDC to cover any interest that accrued since the last display update. If your account wallet has no spare USDC, the close may pause at "needs attention" and ask you to fund a small top-up. Once funded, the close resumes automatically on retry.

### Debt & Your Bot's Displayed PnL

The bot's displayed balance includes the borrowed USDC (it is real cash the bot can trade with), but its net profit/loss subtracts the debt. This keeps the PnL honest: borrowing does not look like instant profit.

- Bot Balance = exchange balance + parked value − borrow debt
- PnL = Bot Balance − total deposited − borrow debt

The debt is shown separately on the Equity tab so you always know what you owe.

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

### Out-of-Sample Validation & Robustness Score

A backtest that's been tuned to its own history will look great on paper and lose money live — this is called *overfitting*, and it's the single biggest reason optimized strategies fail in the real world. QuantumLab guards against it with an out-of-sample (OOS) holdout.

**How the holdout works:**

- When you set an out-of-sample fraction, QuantumLab reserves the most recent slice of your date range (for example, the final 20%) as a holdout the optimizer is never allowed to see.
- The random search and refinement run **only** on the older in-sample portion. The optimizer picks its winners without ever touching the holdout — so it can't memorize it.
- The surviving configurations are then replayed across the full period, and their trades are split into in-sample (IS) and out-of-sample (OOS) groups by entry time.

**The Robustness Score** re-ranks results to reward strategies that hold up on data they were never trained on:

- Out-of-sample performance is weighted roughly **twice** as heavily as in-sample (about 0.65 vs 0.35).
- A divergence penalty pushes down any strategy whose risk-adjusted return collapses from in-sample to out-of-sample — the tell-tale signature of overfitting.
- The underlying quality score is risk-first: Sharpe ratio leads, followed by return-to-drawdown, profit factor, and win rate, all discounted by a trade-count confidence factor so a handful of lucky trades can't top the rankings.
- If the holdout produced too few trades to judge (fewer than 5), it's marked **insufficient** rather than shown as a misleading number, and the result is honestly demoted instead of rewarded.

A configuration with strong, consistent out-of-sample numbers is far more likely to survive live conditions than one that only shines in-sample. In the Results table, this robustness surfaces as a plain-language verdict ("Robust", "Some decay", and so on) alongside each result's out-of-sample net profit, with the full in-sample vs out-of-sample breakdown in the Robustness tab.

> **Honest limitation:** the holdout is a single in-sample / out-of-sample split, not a rolling walk-forward. Slippage is modeled only as a configurable cost (a small charge deducted on each fill), not a simulation of worse fill prices or order-queue effects. Use robustness to weed out overfit configurations — not as a guarantee of live profit.

### Deep Search

Deep Search is an optional mode that adds 3 additional refinement rounds after the standard random + refine pass. Each round re-ranks all results and refines the top seeds again with a progressively tighter jitter radius:

- **Round 1** — 12% jitter radius, all optimizable parameters perturbed
- **Round 2** — 8% jitter radius, re-ranked seeds from Round 1
- **Round 3** — 5% jitter radius, fine-tuning the absolute best configurations

Unlike the standard refinement (which only jitters 4 random parameters at 15% radius), Deep Search jitters **all** numeric parameters simultaneously at each step, making it much more thorough at exploring the neighborhood around a good configuration.

**Iteration math:** Deep Search uses the same Top K and Refinements/Seed settings as the standard pass for each round. With settings of 6000/60/120, Deep Search adds 3 × 60 × 120 = 21,600 additional iterations on top of the standard 13,200, for a total of 34,800. That's roughly 2.6x the work of a standard run.

**When to use it:** Deep Search is most valuable when you've already found a promising configuration and want to squeeze out every last improvement. It's automatically disabled in Smoke Test mode.

**Combining with Guided Mode:** Deep Search and Guided Mode (Use Insights) work independently and can be used together. Guided Mode improves the random search phase by seeding it with known-good configurations from past runs, while Deep Search improves the refinement phase by adding more rounds of narrowing perturbation. Using both gives you the best of both approaches.

### Smoke Test

Smoke Test is a quick validation mode designed to give you a rough picture in a few minutes rather than committing to a full sweep. When you click the Smoke Test button:

- Only the **first selected ticker** and **first selected timeframe** are tested (one combo instead of all combos).
- **Random Samples** are capped at 100, **Top K** at 5, and **Refinements** at 20.
- Deep Search is automatically disabled.

Use Smoke Test to quickly verify that your Pine Script parses correctly, your parameter ranges are reasonable, and the strategy generates valid trades before committing to a full multi-hour sweep.

### Run Queue

QuantumLab processes one optimization at a time in a dedicated worker thread. When you submit a new run (sweep, refine, or smoke test) while another is already running, it is automatically added to a **queue** instead of being rejected.

**How the Queue Works:**

- When you submit a run and the system is busy, the run is saved with status "queued" and assigned a position number in the queue.
- You will see a notification that the run has been queued, along with its position.
- The **Queue button** in the top navigation shows a violet badge with the total count of active + queued items.
- Click the Queue button to open the **Queue Drawer**, which shows the currently running job and all queued runs in order.
- In the Queue Drawer, you can **reorder** queued runs by dragging them up or down, **cancel** queued runs, or **resume** paused runs.
- When the active run finishes, the next queued run starts automatically.
- If you submit a run while the lab process is still starting up (e.g., after a server restart), the run is queued directly into the database and will be picked up as soon as the lab is ready — no waiting required.

**Queue Polling:** The Queue Drawer polls for updates every 2 seconds when open, and the badge updates every 10 seconds in the background.

### Progress & Checkpointing

During a run, you can monitor progress in real time via the live progress display showing the current stage (Random Search / Refinement), iteration count, elapsed time, and best score so far. The optimizer saves checkpoints every 60 seconds, so if your session disconnects or the server restarts, the run automatically resumes from where it left off.

When a run completes, you receive a toast notification saying "Results are ready in the Results tab." The page does not automatically switch away from what you are doing — you can navigate to Results at your convenience.

### Worker Thread Isolation

Optimization runs execute in a dedicated Node.js Worker Thread, completely isolated from the main server. This means even intensive multi-hour optimization jobs won't slow down your live trading, webhook processing, or position management. Only one optimization can run at a time — additional runs are automatically queued.

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
- **OOS / Robustness Column** — When a run used an out-of-sample holdout, each result also shows its out-of-sample (OOS) net profit and a robustness verdict (e.g. "Robust" or "Some decay") for how well it held up on data the optimizer never saw (see Optimizer → Out-of-Sample Validation & Robustness Score). Judge configurations by robustness, not raw net profit — it's the best on-platform defense against overfitting.
- **Trade Inspector** — Click any result to see its full trade list with entry/exit dates, direction, prices, PnL, and exit reason.
- **Equity Curve** — Visual plot of account equity over time for any individual result.
- **Export to Pine Script** — Generates Pine Script code with optimized parameter values injected back into your original strategy.

### Risk Analysis

Each result includes: Max Safe Leverage, Projected Return (at leverage), Max Drawdown at Leverage, and Risk Rating (Low / Medium / High).

### Heatmap Tab

A grid visualization showing how your strategy performs across all tested ticker/timeframe combinations. Each cell shows the best composite score, color-coded from red (poor) through yellow (average) to green (strong). Click any cell to see detailed results for that combination.

### Refine (Coordinate Tuning)

After reviewing your results, you can **Refine** any specific ticker/timeframe combination to squeeze out further improvements. The Refine button appears on individual result cards and on Heatmap cells.

**What Refine Does:**

Refine uses **coordinate tuning** — a systematic optimization method that is fundamentally different from the standard random search + jitter approach:

1. **Single-Parameter Sweeps** — Takes your current best parameter set and varies one parameter at a time while holding all others fixed. For each parameter, it tests a grid of values across the parameter's full range, with finer resolution near the current best value.
2. **Impact Ranking** — After sweeping all parameters individually, it identifies the 2-3 parameters that had the biggest impact on the score (the ones where changing them made the most difference).
3. **Pairwise Grid Search** — For the top-impact parameter pairs, it runs a 2D grid search testing combinations of those parameters together. This catches interactions that single-parameter sweeps miss.
4. **Bool & String Handling** — Boolean parameters test both values. String parameters test all available options.

**When to Use Refine:**

- After a standard optimization run has found a good configuration, Refine can often find 5-15% further improvement by precisely tuning individual parameters.
- Refine is especially useful for high-impact parameters where the optimal value may fall between the random search grid points.
- You can Refine the same combo multiple times. Each Refine run uses the latest insights to guide its search.

**Queue Integration:** If an optimization is already running when you click Refine, the refine job is automatically added to the queue. You can queue up multiple Refine runs across different ticker/timeframe combos and they will execute sequentially.

---

## Insights & Guided Mode

The Insights system analyzes data across all optimization runs for a strategy to surface statistical patterns — which parameters matter most, which ticker/timeframe combinations work best, and which value ranges consistently produce strong results.

### Generating a Report

1. Go to the Insights tab and select a strategy.
2. Optionally choose a specific ticker/timeframe focus (e.g., "SOL 2h") or leave on "All Results" for a general cross-market report.
3. Click "Generate Report." The report is auto-saved to the database for future reference.

### What the Report Contains

- **Parameter Sensitivity** — For each parameter, shows its impact score (how much it affects results), the best-performing value ranges split into buckets, and optimal direction. Each bucket also includes an exit profile showing how trades exit in that parameter range — whether configs with high values stop out more vs reaching TP, for example. High-impact parameters are worth focusing on; low-impact ones can often be left at defaults.
- **Ticker & Timeframe Fit** — Ranks which tickers and timeframes consistently produce the strongest results for this strategy. Each combo includes a full exit reason breakdown so you can see if a poor-performing combo fails from stop outs, never reaching TP, or trades never qualifying.
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

## Lab Assistant

The Lab Assistant is an AI chat built into QuantumLab that can actually *drive* the lab for you. Instead of clicking through every tab, you describe what you want in plain English and the assistant does the work — drafting strategies, running and refining backtests, reading your results, and explaining what's going on.

### What It Can Do

- **Draft a strategy from an idea** — Describe a strategy in plain English ("a breakout strategy on SOL that uses a trailing stop") and the assistant writes the Pine Script and saves it to your library.
- **Run and refine backtests** — Ask it to backtest a strategy across markets and timeframes, then refine the best configurations. It sets up the runs and watches them complete.
- **Read and rank your results** — It pulls up your results and ranks them by robustness (out-of-sample performance), so you see what actually held up, not just what fit history best.
- **Explain wins and losses** — Ask why a strategy is winning or losing and it walks through the metrics in everyday language.
- **Improve a weak strategy** — Point it at an underperformer and it suggests and applies concrete changes.

### Getting Started

1. Open QuantumLab and tap the assistant button (the chat button on the QuantumLab screen).
2. Tell it what you want to do. You can chat and navigate the lab without any setup.
3. To let it run AI-powered work (drafting, refining, insights), add your own OpenRouter API key in the AI Strategy Creator. The assistant uses *your* key, so you stay in control of model choice and cost.

### Auto-Run

Type a goal into the composer and tap **Auto** to hand the whole loop to the assistant: it drafts, backtests, and refines toward your goal, pausing to confirm before any paid AI step. Tapping Auto with an empty composer simply explains what Auto does — it never silently does nothing.

### Your Key Stays Private

- The assistant never needs your key just to chat or move you around the lab — only the AI-powered actions do.
- Your API key goes straight into an encrypted keystore. If you ever paste a key into the chat by mistake, it is rejected on the spot and never stored as a message.

### Reconnecting

If your session goes idle and you reconnect your wallet, the assistant may tell you it's "locked" — your key is still saved, but the session needs a quick re-sign to unlock it. Tap **Reconnect to unlock**, approve the signature in your wallet, and it's back to full strength. (Until then, it will only give canned answers rather than pretending everything is fine.)

---

## QuantumLab Agent API

Every QuantumLab endpoint is fully accessible over HTTP using a **Bearer token**. This lets AI agents (Claude, MCP tools, custom scripts) drive the entire backtest pipeline — parse Pine Script, run optimizations, read results, generate insights — without needing a browser session.

### Getting a Token

1. Open **Settings → API Tokens** in QuantumVault.
2. Click **Generate Token** and give it a label (e.g. "Claude MCP").
3. Copy the token immediately — it won't be shown again.
4. Tokens start with \`qv_\` and are stored as SHA-256 hashes server-side.

### Authentication

Add the token to every request:

\`\`\`
Authorization: Bearer qv_<your-token>
\`\`\`

All \`/api/lab/*\` endpoints require this header (or an active browser session). Requests without a valid token receive \`401 Unauthorized\`.

### Typical Agent Workflow

\`\`\`
1. Parse Pine Script     →  POST /api/lab/parse-pine
2. Save strategy         →  POST /api/lab/strategies
3. Submit backtest run   →  POST /api/lab/run-optimization
4. Poll progress         →  GET  /api/lab/job/:id/progress
5. Read results          →  GET  /api/lab/runs/:id/results
6. Generate insights     →  POST /api/lab/strategies/:id/insights-report
7. Iterate with guidance →  repeat step 3 with useInsights: true
\`\`\`

### Reference

#### Metadata

\`\`\`
GET /api/lab/tickers       — Array of available ticker strings (SOL, BTC, ETH …)
GET /api/lab/timeframes    — Array of available timeframe strings (1m, 5m, 1h …)
\`\`\`

#### Parse Pine Script

\`\`\`
POST /api/lab/parse-pine
Content-Type: application/json

{ "code": "<full pine script source>" }
\`\`\`

Returns the parsed \`inputs\` array and \`groups\` object. Feed these directly into the \`POST /api/lab/strategies\` body.

#### Strategies

\`\`\`
GET  /api/lab/strategies              — List strategies owned by this token's wallet
GET  /api/lab/strategies/:id          — Get one strategy
POST /api/lab/strategies              — Create a strategy
DELETE /api/lab/strategies/:id        — Delete a strategy
\`\`\`

**Create body:**

\`\`\`json
{
  "name": "My Strategy",
  "pineScript": "<full source>",
  "parsedInputs": { ... },
  "groups": { ... },
  "description": "optional"
}
\`\`\`

#### Run Optimization

\`\`\`
POST /api/lab/run-optimization
\`\`\`

\`\`\`json
{
  "strategyId": 42,
  "tickers": ["SOL", "ETH"],
  "timeframes": ["1h", "4h"],
  "startDate": "2024-01-01",
  "endDate": "2025-01-01",
  "randomSamples": 2000,
  "topK": 10,
  "refinementsPerSeed": 50,
  "minTrades": 10,
  "maxDrawdownCap": 30,
  "mode": "sweep",
  "useInsights": false,
  "deepSearch": false
}
\`\`\`

**mode values:** \`"sweep"\` (full run) or \`"smoke"\` (quick 100-sample validation).

**Response (starts immediately):**
\`\`\`json
{ "jobId": "abc123", "runId": 99 }
\`\`\`

**Response (queued because another run is active):**
\`\`\`json
{ "queued": true, "runId": 99, "queueOrder": 2 }
\`\`\`

If queued, poll the run status at \`GET /api/lab/runs/:id\` until \`status\` becomes \`"running"\`, then switch to the progress endpoint.

#### Progress

\`\`\`
GET /api/lab/job/:jobId/progress
\`\`\`

Returns:
\`\`\`json
{
  "stage": "random_search",
  "iterationsDone": 840,
  "iterationsTotal": 2000,
  "elapsedMs": 12400,
  "bestScore": 0.71,
  "status": "running"
}
\`\`\`

\`status\` values: \`"running"\` / \`"complete"\` / \`"failed"\` / \`"paused"\`.
Poll every 2–5 seconds until \`status\` is \`"complete"\` or \`"failed"\`.

#### Results

\`\`\`
GET  /api/lab/runs/:id/results          — All results for a run
GET  /api/lab/strategies/:id/top-results — Best results across all runs for a strategy
GET  /api/lab/strategies/:id/all-results — Every result for a strategy (paginated)
GET  /api/lab/results/:resultId          — Single result with full trade list + equity curve
\`\`\`

Each result includes: \`score\`, \`netProfitPercent\`, \`winRatePercent\`, \`maxDrawdownPercent\`, \`profitFactor\`, \`totalTrades\`, \`sharpeRatio\`, \`params\`, \`ticker\`, \`timeframe\`.

#### Insights

\`\`\`
POST /api/lab/strategies/:id/insights-report   — Generate (and save) an insights report
GET  /api/lab/strategies/:id/insights-reports  — List saved reports
\`\`\`

**Generate body (all optional):**
\`\`\`json
{
  "ticker": "SOL",
  "timeframe": "2h"
}
\`\`\`

Omit \`ticker\`/\`timeframe\` for a cross-market general report. The report is automatically saved. Re-generate after accumulating more results so Guided Mode has fresh data to work from.

#### Queue Management

\`\`\`
GET    /api/lab/queue              — List queued and active runs
POST   /api/lab/queue/reorder      — Reorder queued items
DELETE /api/lab/queue/:id          — Cancel a queued run
POST   /api/lab/job/:id/cancel     — Cancel the currently running job
\`\`\`

#### Refine (Coordinate Tuning)

\`\`\`
POST /api/lab/runs/:id/refine
\`\`\`

\`\`\`json
{ "ticker": "SOL", "timeframe": "1h" }
\`\`\`

Runs coordinate tuning on the best result for that ticker/timeframe combination. Adds to queue if the system is busy.

#### Export

\`\`\`
GET /api/lab/export/csv/:runId      — Download results as CSV
\`\`\`

#### Cache

\`\`\`
GET    /api/lab/cache/stats   — Candle cache statistics
DELETE /api/lab/cache          — Clear the candle cache
\`\`\`

### Rate Limiting & Best Practices

- **One active job at a time.** Additional jobs queue automatically — check \`queueOrder\` in the response and poll \`GET /api/lab/queue\` to monitor position.
- **Poll at reasonable intervals.** 2–5 seconds for active progress, 10–30 seconds for queue position.
- **Use smoke mode first.** Before a long multi-hour sweep, run \`mode: "smoke"\` to verify your Pine Script parses and the strategy produces valid trades.
- **Guided mode needs warmup.** Run 2-3 standard sweeps before setting \`useInsights: true\`. The sensitivity analysis needs ~4,000+ configurations to identify real patterns.
- **Tokens are wallet-scoped.** Results returned are always scoped to the wallet that owns the token — the same user isolation as the browser UI.

---

## AI Trader

AI Trader is QuantumVault's built-in autonomous trading agent. Instead of writing signals or connecting TradingView, an AI model watches the market, decides whether to go long, short, or flat, and places a bracketed order — entry + stop-loss + take-profit — on your chosen exchange. Between trades it waits for the next candle close and decides again.

Every bot **starts in paper mode**. It tracks every hypothetical trade, simulates fills conservatively, and requires a passing paper record before the live toggle unlocks. No real money moves until you choose to fund it after graduation.

### How It Decides

At each analysis cycle the bot builds a market context package and sends it to the AI:

- Last 100 candles of the selected timeframe plus 30 candles of the timeframe above (higher-timeframe trend context)
- Indicators: EMA 20/50/200, RSI, MACD, ATR, ADX, Bollinger Bands, VWAP, OBV — values plus short recent deltas
- Market microstate: mark price, funding rate (current + next), open interest trend, 24h volume
- Smart money positioning (COT) — weekly Bitcoin futures positioning from the CFTC's Commitment of Traders report, applied as a macro bias across all crypto markets (see below)
- Account state: allocated collateral, any open position, unrealized PnL
- The bot's own last 10 closed trades — so the AI can learn from its mistakes and avoid repeating them
- Session & time awareness — current trading session (Asia / London / New York / Weekend), proximity to the weekly candle open (±12h before / 2h after Monday 00:00 UTC), proximity to each daily candle open
- Dow trend structure — swing classification on both the selected timeframe and the parent timeframe (higher-high / higher-low uptrend; lower-low / lower-high downtrend; mixed; or insufficient data), plus an aligned / misaligned flag comparing the two timeframes
- Touch-counted price levels — up to 4 significant zones from the last 400 bars, each with a touch count, status (intact / lost / reclaimed), and distance from the current price
- W/M formations — double-top and double-bottom patterns: reported only when two symmetrical extremes are 10–60 bars apart, within 0.25 ATR of each other, and current price is within 0.5% of the confirmed neckline (the actionability window)

#### Smart money positioning (COT)

Every briefing includes a positioning signal from the CFTC's Commitment of Traders report — the same public filing professional futures traders read each week.

The mechanic: the CFTC collects position data for all large Bitcoin futures traders. Commercial hedgers — companies using futures to manage real Bitcoin exposure — behave like smart money, historically positioning well ahead of major moves. Speculators and smaller retail traders are the crowd. Each group's net position is converted into a 0–100 index over a rolling 120-week window. When the smart-money index crosses down through the crowd index — commercials selling into crowd euphoria — the macro bias tilts short. The inverse cross tilts long. Crosses near the extremes carry more weight than crossovers in the middle.

Honest scope:

- **Source** — CFTC's official Bitcoin Legacy futures-only report. Because BTC sets the broad crypto market regime, the signal applies to all crypto markets. It weakens when a coin moves independently of BTC on its own catalyst.
- **Cadence** — weekly. The CFTC releases data each Friday for the prior Tuesday; the bias updates once per week and holds constant between releases.
- **Role** — a bias on how much to trust a directional setup, not an entry trigger. A bearish macro bias doesn't prevent a long trade; it raises the bar. Price action, technicals, and hard guardrails still govern every decision.
- **Auditability** — every decision records the positioning state it saw — accumulating, distributing, or neutral — alongside the index values. The track record shows whether the signal helped over time.

Most automated traders only see price data — this gives the AI the same positioning context professional futures traders check weekly.

#### Session & time awareness

Each briefing stamps the current trading session (Asia, London, London/New York overlap, New York, or Weekend), proximity to the weekly candle open (±12h before / 2h after Monday 00:00 UTC), and proximity to each daily candle open (±1h window). Weekend conditions signal thin liquidity and elevated false-move risk; session overlaps signal the highest-probability breakout windows; proximity to a weekly open flags the market-structure resets that institutional traders track. Sessions are fixed UTC boundaries — no DST adjustment.

#### Dow trend structure

Swing points are classified on both the selected timeframe and the parent timeframe, yielding a label for each: uptrend (higher-highs + higher-lows), downtrend (lower-lows + lower-highs), mixed (structure broken), or insufficient data (not enough swings yet). The two labels are then compared — aligned (both agree on direction) or misaligned (they diverge). The AI uses this without doing the swing work itself: a counter-trend setup against an aligned downtrend on both timeframes is a meaningful headwind; a trade with the aligned trend gets a structural tailwind.

#### Touch-counted price levels

Up to four significant price zones are extracted from the last 400 bars of the selected timeframe. Each zone reports its central price, touch count (how many times price has tested it), and status: intact (holding), lost (decisively broken), or reclaimed (broken and then returned to). Distance from the current price is included so the AI can judge proximity to the nearest structure. A level touched five times is meaningfully different from one touched twice — the AI is given both the count and the current status.

#### W/M formations (double tops & bottoms)

Double-top (M) and double-bottom (W) patterns are detected on every candle close. A formation is only reported when all conditions hold: two symmetrical extremes 10–60 bars apart, each within 0.25 ATR of the other, a confirmed neckline, and current price within 0.5% of that neckline (the actionability window). Patterns outside this window are omitted — stale setups that already played out add noise, not signal. When a live pattern is present the AI receives the peak prices, neckline level, and pattern age in bars.

The AI returns a structured decision — not prose. It specifies direction, leverage, size, stop-loss price, take-profit price, a confidence score (1–10), and a plain-English rationale. The rationale is shown verbatim in the decision card: it is what the bot "thought" and is the primary trust surface.

**Flat is a valid decision.** "No trade" is fully supported and common. The bot is evaluated on risk-adjusted return net of fees, not on activity. A flat decision in Auto mode schedules the next analysis at the next candle close and does nothing else.

### The Decision Card

Each decision renders as a card showing: direction and entry type (e.g. LONG at market), stop-loss price and distance %, take-profit price and distance %, leverage, size as a percentage of allocation, risk/reward ratio, confidence score, and the model's rationale verbatim.

In Suggest mode you choose Execute, Skip, or Ask Again. In Auto mode the decision executes immediately and is logged for review.

### Hard Guardrails

Every decision passes through code-enforced guardrails before any order is placed. The AI's output is a request; the guardrail layer decides what executes.

Key rules (always active in both risk profiles):

- **Mandatory stop-loss** — Every trade must have a stop-loss on the correct side, within a timeframe-appropriate distance band. No exceptions.
- **SL verification after entry** — After an entry fills, the bracket (SL + TP) is verified on the exchange with a bounded retry. If the bracket cannot be confirmed, the position is immediately closed at market and the bot pauses. A naked position is never held, even briefly.
- **Minimum risk/reward** — TP must deliver at least 1.2× risk after fees. Decisions with poor RR are rejected.
- **Leverage clamp** — Hard ceiling of 5× in the current version, with a volatility-based smart cap below that.
- **Stale data = no trade** — If the candle feed is stale or gapped, the bot refuses to call the AI at all and stays flat.

---

### Paper Trials & Graduation

Every AI Trader bot must pass a paper trial before it can trade real funds.

**Default graduation criteria:**

| Criterion | LTF (15m / 1h) | HTF (4h / 1d) |
|-----------|----------------|----------------|
| Trial period | 30 days | 30 days |
| Closed paper trades | ≥ 10 | ≥ 5 |
| Net paper PnL (after simulated fees + slippage) | > 0 | > 0 |
| Profit factor (gross wins ÷ gross losses) | ≥ 1.1 | ≥ 1.1 |
| Max paper drawdown — mark-to-market, including open positions | ≤ 30% | ≤ 30% |

The drawdown check uses the mark-to-market equity curve — not just closed trades. A bot sitting on a large floating loss cannot graduate on the strength of its closed record. The profit factor floor (≥ 1.1) blocks a lucky-variance record (nine losses, one windfall) from counting as proof.

HTF bots get a lower trade-count default because a 1d bot may only find a few valid setups per month — same 30-day clock, realistic bar.

**Graduation is an unlock, not an auto-flip.** When criteria pass, you receive a Telegram + in-app notification. The live toggle becomes available — funding real money is always an explicit action you take.

If the trial fails (period elapsed, criteria not met), the card shows the honest verdict and offers Restart Trial. A failed trial is the system working: money saved.

Paper fills are biased against flattery: taker fees on both entry and exit legs, plus a 0.05% synthetic slippage penalty per leg. A bot that barely passes on paper is not one you want to fund.

> **Note:** Paper performance does not guarantee live performance. Fill prices, real slippage, and market regime all differ from simulation. Graduation is a gate, not a promise.

---

### Modes

**Suggest** (default) — The AI proposes a trade and waits. You see the full decision card, then tap Execute, Skip, or Ask Again. Nothing executes without your tap. Good when you want to stay in the loop.

**Auto** — The AI executes decisions directly at each candle close and schedules the next analysis automatically. After a trade closes, the bot can either wait for you ("Wait for me") or immediately begin the next analysis cycle ("Ask AI again automatically"). Good for true set-and-forget operation.

You can switch modes from the bot settings at any time. A switch while a position is open takes effect after the current trade closes.

---

### Risk Profiles

**Guarded** (default) — Loss-pacing circuit breakers are active:

- Daily loss ≥ 15% of allocation → force flat, pause, Telegram alert. User-resume only.
- 3 consecutive stop-losses → pause + notify.
- Trade frequency capped (max 6/day for LTF, 2/day for HTF).

**Degen** — Loss-pacing circuit breakers are off. The bot runs until the allocation is depleted below the minimum order size, then stops and reports. There is no daily loss limit and no consecutive-loss brake. A 20 trades/day hard ceiling still applies as a malfunction guard — not a strategy limit. Requires typed confirmation at creation: you acknowledge the allocation can go to zero without the bot pausing.

All other safety rules — mandatory SL, bracket verification, stale-data refusal, LLM timeout protection — are always active in both modes. Degen disables the loss-pacing rules, not the malfunction-protection rules.

---

### Position Sizing

By default AI Trader uses **discretionary sizing**: the AI picks a size percentage (10–90% of allocation) and the guardrail layer clamps it to the permitted band. All existing bots work this way.

**Risk-based sizing** is an optional per-bot mode that derives position size automatically from three inputs:

1. **Live equity** — read fresh from the exchange at decision time (free collateral for live bots; simulated for paper). A bot that has drawn down will risk a smaller absolute dollar amount on the next trade — losses automatically shrink subsequent risk.
2. **Your risk band** — the fraction of live equity to risk per trade, set as a minimum % (at confidence 1) and a maximum % (at confidence 10). Default band: 0.5%–1.5%. Allowed range: 0.1%–3.0%.
3. **Stop distance** — the stop-loss price determines position size. A tighter stop yields a larger position for the same dollar risk; a wider stop yields a smaller one. The AI is told that stop quality drives size, incentivizing careful stop placement over inflated stops.

Leverage is derived from the resulting size — the AI's requested leverage is ignored. The AI's size request is also ignored; only its confidence score and stop placement matter.

**Minimum stop distance: 1%.** A stop tighter than this would allow entry slippage to consume the entire risk budget before the trade even started — such decisions are rejected in risk-based mode.

Risk-based sizing does not disable any other guardrail. G1–G4 (leverage ceiling, SL distance band, minimum RR, fee-clearing TP) still run. Switching a live bot to risk-based requires an active venue subaccount (the equity read needs a real account). Paper bots can switch freely. The decision card shows the risk percentage used and the dollar risk budget committed on each trade.

---

### Net P&L Definition

**Net P&L = sum of realized trade PnL − trading fees − LLM API costs**

- **Realized trade PnL** — the profit or loss from each closed trade at actual fill prices (paper: simulated prices)
- **Trading fees** — taker fee on entry + taker fee on exit for each trade
- **LLM API costs** — the cost of each OpenRouter API call, shown separately in the bot detail view

Open positions contribute unrealized PnL to the equity curve and to the drawdown check, but are not included in realized net P&L until closed.

---

### Going Live

1. Wait for your bot to pass its paper trial (founder accounts can waive the trial for testing).
2. Open the bot drawer and tap **Go Live**.
3. Fund the bot — enter how much USDC to allocate. The transfer goes to the bot's isolated subaccount, the same as a regular trading bot.
4. The bot begins its first live analysis cycle at the next candle close of the chosen timeframe.

**Stopping the bot** — Tap Stop at any time. The bot cancels all open orders, closes any open position at market, and leaves your funds in the subaccount to withdraw normally.

On Flash bots with idle-funds parking enabled, funds park automatically back into the Vault after each trade closes — earning yield while the bot waits for the next setup. On Pacifica, idle funds stay in the subaccount (the $10 min withdrawal + $1 fee makes parking uneconomical on small allocations).

---

### Models & Costs

AI Trader uses your own OpenRouter API key — the same key as the AI Strategy Creator in QuantumLab. You stay in control of which models run and what they cost.

**Decision frequency:** The bot runs one analysis at every candle close — approximately **96 decisions/day on 15m, 24 on 1h, 6 on 4h, 1–2 on 1d**. The Guarded trade-frequency cap limits *trades placed*, not decisions; most candle closes will produce a flat call.

**Model defaults (pre-selected by timeframe, overridable at any time):**
- **15m / 1h → Qwen3.7 Max** — disciplined and cheap. Qwen3.7 Max is also the winner of Alpha Arena Season 1, the only published real-money LLM trading competition (+22.3% return).
- **4h / 1d → Claude Opus 4.8** — deepest reasoning; at 6 or fewer calls per day the cost is manageable.

**Cost by model and timeframe** (matches the in-app selector estimates):

| Model | Per call | 15m / day | 1h / day | 4h / day | 1d / day |
|---|---|---|---|---|---|
| Claude Opus 4.8 | ~$0.10 | ~$9.60 | ~$2.40 | ~$0.60 | ~$0.20 |
| Qwen3.7 Max | ~$0.003 | ~$0.29 | ~$0.07 | ~$0.02 | ~$0.006 |
| DeepSeek V4 Pro | ~$0.002 | ~$0.19 | ~$0.05 | ~$0.01 | ~$0.004 |
| DeepSeek V4 Flash | <$0.001 | ~$0.10 | ~$0.02 | <$0.01 | <$0.01 |

Opus on a 15m bot costs roughly $9–10/day — which is exactly why Qwen is the default for short timeframes.

**Net P&L definition:**

> Net P&L = realized PnL + unrealized PnL − cumulative LLM cost

LLM cost is **subtracted** from displayed Net P&L — it is not a separate line shown alongside a clean number. A bot that wins less than its AI bill is not profitable; the definition makes this visible rather than hiding the overhead. Cumulative LLM spend is also broken out individually in the bot detail view.

The first 3 paper decisions run without a key so you can see the decision format before committing.

---

### FAQ

**Does the bot always trade when it analyzes?**
No. "Flat" (no trade) is a valid and common decision. The AI is instructed to stand aside unless it finds a setup that clears its internal guardrails: minimum 1.5 risk/reward, mandatory stop-loss beyond obvious structure, fee-clearing TP distance. In Auto mode, a flat decision schedules the next analysis at the next candle close and does nothing else.

**Can it lose my entire allocation?**
In Degen mode: yes, that is the explicit contract you confirm at creation. In Guarded mode: the daily-loss circuit breaker (15% of allocation) force-flattens and pauses the bot long before a full loss is possible in a single day. Per-trade loss is also bounded by the mandatory stop-loss.

**What happens if stop-loss placement fails after entry?**
The bot closes the position at market immediately and pauses. It will never hold a naked position, even briefly. This is enforced in code — not the prompt — and fires on every entry.

**Can the AI close early before SL or TP?**
Not in the current version. Entry + bracket (SL + TP) go on the exchange; the exchange manages the exit. The Stop button is always available for user-initiated close.

**What if the model call times out or fails?**
The bot stays flat and retries at the next candle close. An aborted cycle never places an order. In Auto mode this is silent unless it happens repeatedly — in which case check your OpenRouter key and balance.

**Can I use a different model?**
Yes. You choose the model per-bot in the creation flow or adjust it in bot settings at any time. The platform pre-selects by timeframe (Qwen3.7 Max for 15m/1h, Claude Opus 4.8 for 4h/1d), but any manual choice sticks. The decision card always shows which model was used.

**Does the bot reason differently on weekends or at different times of day?**
It can. The session context tells the AI which session is active (Asia, London, New York, or Weekend) and whether it is near a weekly or daily candle open. A weekend setup can be treated differently from a mid-week London-session breakout. The context is available input, not a forced rule — the AI decides how much weight to give it.

**What are the "significant price levels" the bot sees?**
Up to four key price zones extracted from the last 400 bars — structural highs and lows that price has tested repeatedly. Each level carries a touch count, a status (intact, lost, or reclaimed), and distance from the current price. These are real chart structure levels, not indicator lines or round numbers.

**What happens if a context layer — session, Dow structure, price levels — is unavailable?**
Context enrichment is fail-open: if any block encounters an error it is omitted from the briefing. The AI proceeds with whatever context it has. A missing block never pauses or blocks a decision cycle — the bot stays flat at worst, never errors out.

**Is this financial advice?**
No. AI Trader is a tool, not financial advice. The AI's reasoning is shown verbatim so you can evaluate it yourself. Past paper performance does not predict live results.

---

### Disclaimer

AI Trader is an automated trading tool. It is not financial advice. No AI system — including this one — can guarantee profits or protect against losses in live markets.

Paper results are simulated with conservative assumptions but cannot replicate real fill prices, real slippage, or changing market regimes. A passing paper record is not a promise of live profitability.

You are responsible for all losses. Never allocate more than you can afford to lose entirely. Trading perpetual futures involves leverage. Leveraged positions can be liquidated. The platform's guardrails reduce the speed of loss but do not eliminate it.

The AI models used make mistakes. Guardrails catch certain classes of bad decisions but cannot catch every possible error in judgment. QuantumVault provides execution infrastructure. The trading decisions are made by an AI model. Use this feature with that distinction clearly in mind.

---

*QuantumVault — Built on Solana.*
*Website: [https://myquantumvault.com](https://myquantumvault.com)*
`;

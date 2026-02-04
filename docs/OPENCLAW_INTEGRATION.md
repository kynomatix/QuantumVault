# OpenClaw Integration Guide

> Connect your OpenClaw AI agent to QuantumVault for automated perpetual futures trading on Drift Protocol.

## Overview

OpenClaw is an open-source autonomous AI agent that can monitor markets, analyze sentiment, and make trading decisions. QuantumVault provides robust execution infrastructure for Drift Protocol perpetual futures on Solana.

**Why integrate?**
- OpenClaw handles the *intelligence* (when to trade)
- QuantumVault handles the *execution* (how to trade safely)

| OpenClaw | QuantumVault |
|----------|--------------|
| AI-driven signal generation | Battle-tested Drift execution |
| Sentiment analysis | Position management |
| On-chain monitoring | Auto top-up & margin handling |
| 24/7 autonomous decisions | RPC failover & retry system |
| Customizable skills | Copy trading marketplace |

---

## Quick Start

### 1. Create a Bot in QuantumVault

1. Connect your Phantom wallet to QuantumVault
2. Go to **Bots** tab → **Create Bot**
3. Select your market (e.g., `SUI-PERP`, `SOL-PERP`, `BTC-PERP`)
4. Set your **Max Position Size** (e.g., $100)
5. Copy your **Bot ID** and **Webhook URL**

Your webhook URL will look like:
```
https://your-quantumvault-domain.replit.app/api/webhook/{BOT_ID}
```

### 2. Fund Your Bot

Deposit USDC to your bot's agent wallet:
1. Go to **Wallet** tab
2. Click **Deposit** on the bot you want to fund
3. Send USDC from your Phantom wallet

---

## Webhook API Reference

### Endpoint
```
POST /api/webhook/{BOT_ID}
```

### Headers
```
Content-Type: application/json
```

### Request Body

#### Open Position (Long/Short)
```json
{
  "botId": "your-bot-uuid",
  "action": "buy",
  "contracts": "10",
  "position_size": "100",
  "price": "1.15"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `botId` | string | Your bot's UUID (must match URL) |
| `action` | string | `"buy"` for long, `"sell"` for short |
| `contracts` | string | Number of contracts (used for proportional sizing) |
| `position_size` | string | Strategy's max position (used for proportional sizing) |
| `price` | string | Current price (optional, used for logging) |

#### Close Position
```json
{
  "botId": "your-bot-uuid",
  "action": "sell",
  "contracts": "0",
  "position_size": "0"
}
```

When `position_size` is `"0"` or contracts equals position_size in opposite direction, QuantumVault closes the entire position.

#### Position Flip (Reverse)
```json
{
  "botId": "your-bot-uuid",
  "action": "sell",
  "contracts": "20",
  "position_size": "-20"
}
```

Negative `position_size` indicates a flip from long to short (or vice versa). QuantumVault will close the existing position first, then open in the new direction.

### Response

**Success:**
```json
{
  "success": true,
  "action": "buy",
  "side": "long",
  "tradeId": "trade-uuid",
  "market": "SUI-PERP",
  "size": "8.69565217",
  "price": "1.15",
  "txSignature": "5xYz..."
}
```

**Error:**
```json
{
  "success": false,
  "error": "Bot is paused",
  "code": "BOT_PAUSED"
}
```

---

## OpenClaw Skill Example

Create a skill file for OpenClaw to send signals to QuantumVault:

### `quantumvault-trader.md`

```markdown
# QuantumVault Trader Skill

## Description
Execute perpetual futures trades on Drift Protocol via QuantumVault.

## Configuration
- QUANTUMVAULT_URL: Your QuantumVault deployment URL
- QUANTUMVAULT_BOT_ID: Your bot's UUID

## Commands

### Open Long Position
When I say "go long [AMOUNT]% on [MARKET]", send a webhook:

POST {{QUANTUMVAULT_URL}}/api/webhook/{{QUANTUMVAULT_BOT_ID}}
Content-Type: application/json

{
  "botId": "{{QUANTUMVAULT_BOT_ID}}",
  "action": "buy",
  "contracts": "{{AMOUNT}}",
  "position_size": "100"
}

### Open Short Position  
When I say "go short [AMOUNT]% on [MARKET]", send a webhook:

POST {{QUANTUMVAULT_URL}}/api/webhook/{{QUANTUMVAULT_BOT_ID}}
Content-Type: application/json

{
  "botId": "{{QUANTUMVAULT_BOT_ID}}",
  "action": "sell",
  "contracts": "{{AMOUNT}}",
  "position_size": "100"
}

### Close Position
When I say "close position" or "flatten", send a webhook:

POST {{QUANTUMVAULT_URL}}/api/webhook/{{QUANTUMVAULT_BOT_ID}}
Content-Type: application/json

{
  "botId": "{{QUANTUMVAULT_BOT_ID}}",
  "action": "sell",
  "contracts": "0",
  "position_size": "0"
}

## Example Usage
- "Go long 50% on SUI" → Opens 50% of max position size as long
- "Go short 100% on SOL" → Opens full short position
- "Close position" → Closes any open position
```

---

## Advanced: Automated Trading Logic

### Example OpenClaw Prompt

```
You are a crypto trading assistant connected to QuantumVault.

Monitor SUI-PERP and execute trades based on:
1. RSI > 70 on 1H chart → Close longs, consider short
2. RSI < 30 on 1H chart → Close shorts, consider long
3. Price breaks above 20-day MA → Go long 50%
4. Price breaks below 20-day MA → Go short 50%

Before each trade:
- Check current position via GET /api/trading-bots/{botId}
- Never exceed 100% position size
- Always use proper risk management

Send webhooks to: https://quantumvault.replit.app/api/webhook/{botId}
```

### Example with On-Chain Monitoring

```
Monitor wallet 0xWhale... for large SUI movements.

If whale buys > $100k SUI:
- Wait 30 seconds (avoid front-running detection)
- Go long 25% on SUI-PERP via QuantumVault webhook

If whale sells > $100k SUI:
- Close any long position immediately
- Consider short 25%

Always log reasoning before executing trades.
```

---

## Position Sizing

QuantumVault calculates trade size proportionally:

```
Trade Size = (contracts / position_size) × Bot's Max Position Size
```

**Example:**
- Bot Max Position: $100
- Signal: `contracts: "50", position_size: "100"`
- Result: $50 trade (50% of max)

This allows OpenClaw to send percentage-based signals that scale to each bot's configuration.

---

## Error Handling

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `BOT_NOT_FOUND` | Invalid botId | Check your bot UUID |
| `BOT_PAUSED` | Bot is paused | Resume bot in QuantumVault UI |
| `INSUFFICIENT_MARGIN` | Not enough USDC | Deposit more funds |
| `EXECUTION_DISABLED` | Trading disabled | Enable execution in settings |
| `DUPLICATE_SIGNAL` | Same signal sent twice | QuantumVault deduplicates automatically |

### Retry Logic

QuantumVault automatically retries failed trades with exponential backoff:
- Transient errors (timeouts, RPC issues) → Auto-retry up to 5 times
- Permanent errors (insufficient margin) → Marked as failed, notification sent

OpenClaw doesn't need to implement retry logic.

---

## Security Best Practices

### 1. Use QuantumVault as Execution Layer
OpenClaw only sends signals, never holds private keys. QuantumVault manages wallet security.

### 2. Set Position Limits
Configure `Max Position Size` in QuantumVault to limit exposure regardless of what signals OpenClaw sends.

### 3. Enable Notifications
Connect Telegram in QuantumVault settings to receive trade alerts and error notifications.

### 4. Test with Small Amounts
Start with $10-50 max position size until you've verified your OpenClaw logic works correctly.

### 5. Monitor Performance
Check QuantumVault's trade history and PnL tracking to evaluate your OpenClaw strategy.

---

## API Endpoints for OpenClaw

### Get Bot Status
```
GET /api/trading-bots/{botId}
```
Returns current position, PnL, and bot configuration.

### Get Open Position
```
GET /api/trading-bots/{botId}/position
```
Returns current open position details (side, size, entry price, unrealized PnL).

### Get Recent Trades
```
GET /api/trading-bots/{botId}/trades
```
Returns trade history for the bot.

### Get Account Balance
```
GET /api/trading-bots/{botId}/account-info
```
Returns USDC balance, free collateral, and account health.

---

## Supported Markets

QuantumVault supports all Drift Protocol perpetual markets:

| Market | Index | Description |
|--------|-------|-------------|
| SOL-PERP | 0 | Solana |
| BTC-PERP | 1 | Bitcoin |
| ETH-PERP | 2 | Ethereum |
| SUI-PERP | 9 | Sui |
| APT-PERP | 3 | Aptos |
| ARB-PERP | 6 | Arbitrum |
| DOGE-PERP | 7 | Dogecoin |
| WIF-PERP | 23 | dogwifhat |
| BONK-PERP | 4 | Bonk (1M) |
| PEPE-PERP | 10 | Pepe (1M) |
| JUP-PERP | 24 | Jupiter |
| RENDER-PERP | 12 | Render |
| ... | ... | [Full list on Drift](https://app.drift.trade) |

---

## Copy Trading Integration

If you want to share your OpenClaw signals with others:

1. **Publish Your Bot**: Go to Marketplace → Publish Bot
2. **Set Creator Fee**: Choose your profit share percentage (e.g., 10%)
3. **Share Your Bot**: Others can subscribe and copy your trades
4. **Earn Profits**: When subscribers profit, you earn your fee automatically

This turns your OpenClaw strategy into a signal service that others can subscribe to.

---

## Troubleshooting

### Webhook Not Working
1. Verify bot ID matches in URL and payload
2. Check bot is active (not paused)
3. Ensure bot has USDC balance
4. Check QuantumVault logs for errors

### Trades Not Executing
1. Verify execution is enabled in wallet settings
2. Check if position would exceed max size
3. Look for "INSUFFICIENT_MARGIN" errors
4. Verify market is not paused on Drift

### Position Not Closing
1. Send `position_size: "0"` to trigger close
2. Verify you have an open position first
3. Check for "NO_POSITION" error response

---

## Support

- **QuantumVault Issues**: Check the app's error logs and notifications
- **OpenClaw Issues**: Refer to OpenClaw documentation and community
- **Drift Protocol**: [docs.drift.trade](https://docs.drift.trade)

---

## Example Complete Flow

```
1. OpenClaw monitors Twitter for SUI sentiment
2. Detects bullish sentiment spike
3. Sends webhook: {"action": "buy", "contracts": "50", "position_size": "100"}
4. QuantumVault receives signal
5. Calculates: 50% of $100 max = $50 trade
6. Checks margin: $75 available ✓
7. Executes on Drift: Long 44 SUI-PERP @ $1.13
8. Records trade, updates position
9. Sends Telegram notification: "Opened LONG 44 SUI @ $1.13"
10. OpenClaw continues monitoring...
11. Sentiment turns bearish
12. Sends webhook: {"action": "sell", "contracts": "0", "position_size": "0"}
13. QuantumVault closes position
14. PnL calculated and recorded
15. If bot is published, profit share distributed to creator
```

---

*This integration guide is for QuantumVault on Drift Protocol. Always test with small amounts first. Not financial advice.*

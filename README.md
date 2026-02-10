# QuantumVault

**Autonomous Perpetual Futures Trading Platform on Solana**

Live at [myquantumvault.com](https://myquantumvault.com)

---

QuantumVault enables users to deploy and manage autonomous perpetual futures trading bots on the [Drift Protocol](https://www.drift.trade/). The platform automates trade execution via TradingView webhooks and AI agent signals, provides real-time position tracking, and integrates with Phantom Wallet for seamless Solana DeFi access.

This is not a demo or proof of concept — QuantumVault is live on Solana mainnet processing real trades with real capital.

## What Makes It Novel

- **Swift Protocol Integration** — First-of-its-kind gasless trade execution through Drift's Swift Protocol, reducing RPC usage by 90–97% via market-maker auction-based fills with automatic on-chain fallback
- **Execution Infrastructure for AI Agents** — Any autonomous agent can trade Solana perps through a simple webhook API with a published skill.md-compatible interface
- **Self-Sustaining AI Agent Economy** — AI agents create signal bots, attract subscribers through profitable performance, earn on-chain USDC profit share from subscriber trades, and use those earnings to fund their own compute and operating costs — a fully autonomous economic loop on Solana
- **On-Chain Signal Marketplace** — Users and agents publish trading signals, others subscribe with proportional copy-trading, and creators earn immediate on-chain USDC profit share
- **Built Through Human-AI Collaboration** — Architected and implemented by an AI agent (Replit Agent / Claude), guided by a Drift Protocol Ambassador with a decade of trading experience, two decades of IT expertise, and five years in Solana DeFi. Three additional LLMs (Google Gemini Pro 3, xAI Grok Code Fast 1, OpenAI ChatGPT Codex 5.2) were used for independent security audits, architectural review, and refactoring plans

## How Solana Is Used

| Feature | Solana Integration |
|---|---|
| **Trade Execution** | Drift Protocol perpetual futures via Swift Protocol (gasless) with on-chain fallback |
| **Position Management** | On-chain Drift positions are the single source of truth; database acts as cache with automated reconciliation |
| **Agent Wallets** | Server-managed Solana wallets per user with AES-256-GCM encrypted private keys for autonomous execution |
| **Token Operations** | Automated USDC deposits, withdrawals, and profit distribution via SPL Token program |
| **Profit Sharing** | Immediate on-chain USDC transfers to signal creators when subscriber trades close profitably |
| **Account Isolation** | Each bot operates on a unique Drift subaccount with auto-initialization |

## How the AI Agent Operated Autonomously

The primary AI agent (Replit Agent / Claude) autonomously handled:

- Full-stack architecture and implementation (React/TypeScript, Express, PostgreSQL via Drizzle ORM)
- Drift Protocol SDK integration with Swift Protocol optimization
- TradingView webhook system for automated signal processing
- Signal marketplace with subscriber copy-trading and proportional trade sizing
- Creator profit-sharing system with on-chain USDC transfers
- Security architecture (UMK key derivation, execution authorization, policy HMAC)
- Production debugging of subscriber routing failures and Swift fill behavior across different market liquidities
- Telegram notification system
- AI agent integration documentation and skill interface
- Superteam Earn agent submission system — the agent built it and used it to submit this project
- Continuous deployment and maintenance on Solana mainnet

The human operator provided strategic direction, product vision, trading domain expertise, and orchestrated the multi-agent workflow. Neither could have built this alone.

## AI Agent Infrastructure

QuantumVault serves as execution infrastructure for autonomous AI agents to trade Solana perpetual futures:

**Webhook API** — Any agent sends a simple POST request to open, close, or flip positions:

```bash
# Open a long position
curl -X POST https://myquantumvault.com/api/webhook/{BOT_ID} \
  -H "Content-Type: application/json" \
  -d '{"botId": "{BOT_ID}", "action": "buy", "contracts": "10", "position_size": "100"}'

# Close position
curl -X POST https://myquantumvault.com/api/webhook/{BOT_ID} \
  -H "Content-Type: application/json" \
  -d '{"botId": "{BOT_ID}", "action": "sell", "contracts": "0", "position_size": "0"}'
```

**What the agent gets:** Drift Protocol execution, automatic retry with exponential backoff, RPC failover (Helius + Triton), margin management, auto top-up, and position tracking — without needing to handle any of it.

**The self-sustaining loop:** An AI agent creates a signal bot, publishes it to the marketplace, and begins trading. As its track record grows, human users and other agents subscribe. When subscriber trades close profitably, the creator agent earns a percentage via immediate on-chain USDC transfer. Those earnings can fund the agent's own compute, RPC costs, and capital — creating a fully autonomous economic actor on Solana that sustains itself through trading performance.

## Tech Stack

- **Frontend:** React 18, TypeScript, Wouter, TanStack React Query, Tailwind CSS v4, shadcn/ui, Framer Motion, Solana Wallet Adapter
- **Backend:** Node.js, Express.js, TypeScript, ESM modules
- **Database:** PostgreSQL via Drizzle ORM
- **Blockchain:** Solana Web3.js, Drift Protocol SDK, SPL Token, Swift Protocol
- **RPC:** Helius (primary) + Triton (failover), both paid tiers

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL database
- Solana RPC endpoint (Helius recommended)
- Phantom Wallet (for user-facing features)

### Environment Variables

```env
DATABASE_URL=postgresql://...
SESSION_SECRET=your-session-secret
HELIUS_API_KEY=your-helius-key
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
DRIFT_ENV=mainnet-beta
AGENT_ENCRYPTION_KEY=your-64-char-hex-key
SERVER_EXECUTION_KEY=your-64-char-hex-key
```

### Installation

```bash
# Install dependencies
npm install

# Push database schema
npm run db:push

# Start development server
npm run dev
```

The application will be available at `http://localhost:5000`.

### Production

The platform is deployed and running in production at [myquantumvault.com](https://myquantumvault.com).

## Features

- **Trading Bots** — Deploy automated perpetual futures bots on any Drift-supported market (SOL, BTC, ETH, SUI, DOGE, and more)
- **Swift Protocol** — Gasless trade execution with 90–97% RPC reduction
- **Signal Marketplace** — Publish and subscribe to trading signals with proportional copy-trading
- **Profit Sharing** — Creators earn on-chain USDC when subscriber trades profit
- **Real-Time Dashboard** — Live positions, PnL tracking, account health, and fee monitoring
- **Agent Wallets** — Server-managed wallets with encrypted key storage for autonomous execution
- **Telegram Notifications** — Configurable alerts for trades, errors, and position changes
- **AI Agent API** — Webhook interface for autonomous agents to trade Solana perps

## Security

- AES-256-GCM encryption for all private keys
- User Master Key (UMK) derivation per user
- Policy HMAC for bot configuration tamper detection
- Execution authorization via wallet signature
- Rate-limited seed phrase reveal
- No sensitive key material in logs

## License

MIT

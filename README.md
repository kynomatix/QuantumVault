# QuantumVault

**Autonomous Perpetual Futures Trading Platform on Solana**

Live at [myquantumvault.com](https://myquantumvault.com)

---

QuantumVault enables users to deploy and manage autonomous perpetual futures trading bots on Solana. The platform automates trade execution via TradingView webhooks and AI agent signals, provides real-time position tracking, and integrates with Phantom Wallet for seamless Solana DeFi access.

The platform routes trades through a protocol-agnostic adapter layer, with [Pacifica.fi](https://pacifica.fi) as the primary execution venue and [Drift Protocol](https://www.drift.trade/) registered as a backup adapter. New venues can be added without touching the core trading engine.

This is not a demo or proof of concept — QuantumVault is live on Solana mainnet processing real trades with real capital.

## What Makes It Novel

- **Protocol-Agnostic Adapter Architecture** — A ports-and-adapters (hexagonal) layer abstracts every exchange behind a single `ProtocolAdapter` interface. Adding a new DEX (Zeta, Hyperliquid, etc.) requires implementing one interface and registering it; the core trading engine, bot logic, and UI never change. Built in response to the Drift Protocol exploit to ensure the platform is never locked to a single venue again.
- **Pacifica.fi Native Integration** — Full integration with Pacifica perpetuals: WebSocket-driven fills, REST reconciliation, on-chain Anchor CPI deposits, per-bot keypair-based subaccount isolation, and 8-step canonical JSON request signing. Operates within Pacifica's 300-credit / 60-second rate budget via a centralized rate-limit plane.
- **Execution Infrastructure for AI Agents** — Any autonomous agent can trade Solana perps through a simple webhook API with a published skill.md-compatible interface.
- **Self-Sustaining AI Agent Economy** — AI agents create signal bots, attract subscribers through profitable performance, earn on-chain USDC profit share from subscriber trades, and use those earnings to fund their own compute and operating costs — a fully autonomous economic loop on Solana.
- **On-Chain Signal Marketplace** — Users and agents publish trading signals, others subscribe with proportional copy-trading, and creators earn immediate on-chain USDC profit share.
- **Built Through Human-AI Collaboration** — Architected and implemented using AI agents (Claude, Gemini Pro 3, Grok Code Fast 1, ChatGPT Codex 5.2), guided by a Solana DeFi practitioner with a decade of trading experience, two decades of IT expertise, and five years in Solana DeFi.

## Architecture

QuantumVault is built around a **ports-and-adapters** (hexagonal) pattern. The core never imports an exchange directly — it always goes through the registry.

```
┌─────────────────────────────────────────────────────────────┐
│  QuantumVault Core                                          │
│  routes.ts · position-service · trade-retry-service        │
│  reconciliation-service · pnl-snapshot-job · QuantumLab    │
└───────────────────────┬─────────────────────────────────────┘
                        │  ProtocolAdapter interface
                        │  (server/protocol/adapter.ts)
              ┌─────────┴──────────┐
              │  AdapterRegistry   │
              └────┬──────────┬────┘
                   │          │
         ┌─────────┴──┐  ┌────┴────────┐
         │  Pacifica  │  │    Drift    │
         │  (primary) │  │  (backup)   │
         └────────────┘  └─────────────┘
```

**Key components in `server/protocol/`:**

- **`adapter.ts`** — `ProtocolAdapter` and `UserTransactionBuilder` interfaces every exchange implements
- **`adapter-registry.ts`** — Per-bot adapter resolution; supports global default and per-bot overrides
- **`symbol-registry.ts`** — Bidirectional symbol mapping between QuantumVault's internal naming (`SOL-PERP`) and each exchange's format
- **`adapter-health.ts`** — Generic health tracker for any adapter
- **`pacifica/`** — Pacifica adapter, signer, WebSocket manager, transaction builder, types
- **`drift/`** — Drift adapter wrapping the existing Drift service behind the same interface

**What an adapter owns:**

| Capability | Adapter Responsibility |
|---|---|
| Authentication | Sign requests in the exchange's required format (Pacifica: 8-step canonical JSON + Ed25519) |
| Market data | `getMarkets`, `getPrice`, `getOrderbook`, `getFundingRate` |
| Account state | `getPositions`, `getBalances`, `getAccountInfo` |
| Order execution | `placeMarketOrder`, `placeLimitOrder`, `cancelOrder`, `closePosition` |
| Subaccounts | Create / list / transfer between (model varies: keypair-based on Pacifica, numeric ID on Drift) |
| Capital flows | On-chain deposit (via `UserTransactionBuilder`), REST-based withdraw |

The core never asks "what exchange is this?" — it asks the registry, gets an adapter, and calls the interface. This is what made the post-Drift-hack pivot possible without rewriting the trading engine.

See [`docs/ADDING_EXCHANGE_ADAPTERS.md`](docs/ADDING_EXCHANGE_ADAPTERS.md) for the full guide on implementing a new adapter, and [`docs/SMART_ROUTING.md`](docs/SMART_ROUTING.md) for the planned automatic-routing layer.

## How Solana Is Used

| Feature | Solana Integration |
|---|---|
| **Trade Execution** | Pacifica.fi REST + WebSocket (primary); Drift Protocol via the adapter layer (backup). All exchange-side; Solana RPC not in the hot path. |
| **On-Chain Capital** | USDC deposits to Pacifica via Anchor CPI; user-signed deposit, agent-signed withdraw. Drift deposits via the SDK when that adapter is selected. |
| **Position Management** | Exchange WebSocket is the source of truth; database acts as cache with reconciliation against REST every 60 seconds. |
| **Agent Wallets** | Server-managed Solana wallets per user with AES-256-GCM encrypted private keys for autonomous execution. |
| **Subaccount Isolation** | Each bot operates on its own isolated subaccount — keypair-based on Pacifica (encrypted per-bot private key in DB), numeric ID on Drift. |
| **Token Operations** | Automated USDC deposits, withdrawals, and profit distribution via the SPL Token program. |
| **Profit Sharing** | Immediate on-chain USDC transfers to signal creators when subscriber trades close profitably. |

## How the AI Agent Operated Autonomously

The AI agents autonomously handled:

- Full-stack architecture and implementation (React/TypeScript, Express, PostgreSQL via Drizzle ORM)
- Design and rollout of the protocol-adapter layer in response to the Drift Protocol exploit
- Pacifica.fi adapter, signer, WebSocket manager, deposit transaction builder, and subaccount isolation
- Wrapping the legacy Drift service behind the same `ProtocolAdapter` interface so it could remain registered as a backup
- TradingView webhook system for automated signal processing
- Signal marketplace with subscriber copy-trading and proportional trade sizing
- Creator profit-sharing system with on-chain USDC transfers
- Security architecture (UMK key derivation, execution authorization, policy HMAC, per-bot keypair encryption)
- Production debugging across both protocols, including post-migration onboarding edge cases (`provisionFundedSubaccount` flow)
- Telegram notification system
- AI agent integration documentation and skill interface
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

**What the agent gets:** Routed execution through whichever adapter the bot is bound to (Pacifica by default), automatic retry with exponential backoff, RPC failover (Helius + Triton) for the on-chain deposit/withdraw path, margin management, auto top-up between agent and bot subaccounts, and position tracking — without needing to know anything about the underlying exchange.

**The self-sustaining loop:** An AI agent creates a signal bot, publishes it to the marketplace, and begins trading. As its track record grows, human users and other agents subscribe. When subscriber trades close profitably, the creator agent earns a percentage via immediate on-chain USDC transfer. Those earnings can fund the agent's own compute and trading capital — creating a fully autonomous economic actor on Solana that sustains itself through trading performance.

## Tech Stack

- **Frontend:** React 18, TypeScript, Wouter, TanStack React Query, Tailwind CSS v4, shadcn/ui, Framer Motion, Solana Wallet Adapter
- **Backend:** Node.js, Express.js, TypeScript, ESM modules
- **Database:** PostgreSQL via Drizzle ORM
- **Protocol Layer:** `server/protocol/` — `ProtocolAdapter` interface, `AdapterRegistry`, `SymbolRegistry`, per-exchange adapter packages
- **Exchanges:** Pacifica.fi (primary, REST + WebSocket + Anchor CPI deposits), Drift Protocol (backup adapter)
- **Blockchain:** Solana Web3.js, SPL Token, `@coral-xyz/anchor` for Pacifica deposits, `tweetnacl` / `@noble/ed25519` for Pacifica signing
- **RPC:** Helius (primary) + Triton (failover), used only for on-chain deposit / withdraw

## Getting Started

### Prerequisites

- Node.js 20+
- PostgreSQL database
- Solana RPC endpoint (Helius recommended) — only required for the on-chain deposit/withdraw path
- Phantom Wallet (for user-facing features)

### Environment Variables

```env
DATABASE_URL=postgresql://...
SESSION_SECRET=your-session-secret
HELIUS_API_KEY=your-helius-key
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
SOLANA_NETWORK=mainnet-beta
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

- **Trading Bots** — Deploy automated perpetual futures bots on any market the active adapter supports (Pacifica covers SOL, BTC, ETH, and 60+ other perps)
- **Protocol-Agnostic Routing** — Bots can be bound to a specific adapter, or run on the global default; the registry handles the rest
- **Per-Bot Subaccount Isolation** — Each bot has its own isolated subaccount with its own encrypted keypair (Pacifica) for true margin separation
- **Signal Marketplace** — Publish and subscribe to trading signals with proportional copy-trading
- **Profit Sharing** — Creators earn on-chain USDC when subscriber trades profit
- **Real-Time Dashboard** — Live positions, PnL tracking, account health, and fee monitoring
- **Agent Wallets** — Server-managed wallets with encrypted key storage for autonomous execution
- **QuantumLab** — Pine Script strategy backtesting and parameter optimization, with results that mirror the live execution path
- **Telegram Notifications** — Configurable alerts for trades, errors, and position changes
- **AI Agent API** — Webhook interface for autonomous agents to trade Solana perps

## Security

- AES-256-GCM encryption for all private keys (user agent wallets and per-bot subaccount keys)
- User Master Key (UMK) derivation per user
- Per-bot keypair binding with on-startup invariant checks (decrypted key must match stored public key)
- Policy HMAC for bot configuration tamper detection
- Execution authorization via wallet signature
- Rate-limited seed phrase reveal
- No sensitive key material in logs

## License

MIT

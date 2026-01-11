# QuantumVault - Solana Bot Trading Platform

## Overview

QuantumVault is a Solana-based bot trading platform designed for deploying and managing perpetual futures trading bots on the Drift Protocol. It integrates with Phantom Wallet, enables automated trade execution via TradingView webhooks, and provides real-time position tracking. The platform aims to offer a robust and user-friendly experience for automated DeFi trading.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter
- **State Management**: TanStack React Query for server state, React hooks for local state
- **Styling**: Tailwind CSS v4 with shadcn/ui (New York style)
- **Animations**: Framer Motion
- **Wallet Integration**: Solana Wallet Adapter with Phantom support
- **Build Tool**: Vite

### Backend
- **Runtime**: Node.js with Express.js
- **Language**: TypeScript with ESM modules
- **Session Management**: Express-session with cookie-based authentication
- **API Design**: RESTful endpoints
- **Build**: esbuild

### Data Storage
- **Database**: PostgreSQL via Drizzle ORM
- **Schema**: Defined in `shared/schema.ts`
- **Tables**: Users, wallets, bots, tradingBots, botTrades, botPositions, equityEvents, webhookLogs, subscriptions, portfolios, positions, trades, leaderboardStats.
- **Migrations**: Drizzle-kit

### Core Features
- **Real-Time Position Tracking**: The `bot_positions` table tracks running positions per bot/market, including PnL and fees. Position updates are precise using Decimal.js.
- **Fee Tracking**: Drift Taker Fee (0.05%) is tracked per trade and accumulated in `bot_positions.totalFees` for accurate PnL and breakeven calculations.
- **Authentication**: Primarily Solana wallet-based (Phantom), with traditional username/password as a secondary option.
- **Monorepo Structure**: Organized into `client/`, `server/`, and `shared/` directories.
- **Agent Wallet Architecture**: A server-managed Solana wallet per user for autonomous trading, with encrypted private keys.
    - **Simplified Capital Flow**: User deposits USDC from Phantom to Agent Wallet, then manually to Drift. Withdrawals go from Agent Wallet to Phantom.
    - **Trade Execution**: TradingView webhook signals trigger `placeAndTakePerpOrder` on Drift Protocol via the agent wallet.
    - **TradingView Signal Logic (CRITICAL - DO NOT CHANGE)**: TradingView `contracts` are converted from `USDT / price` to a **percentage** of `bot.maxPositionSize`. `tradeAmountUsd = (usdtValue / 100) * bot.maxPositionSize`. This logic ensures pyramiding strategies work as intended.
- **Close Signal Detection**: `strategy.position_size = 0` from TradingView triggers a reduce-only close order for existing positions.
    - **On-Chain Verification**: Close signals ALWAYS query on-chain position first via `PositionService.getPositionForExecution()` before execution.
    - **Reduce-Only Enforcement**: Close orders are executed with `reduceOnly: true` to prevent accidental position openings.
    - **Enhanced Logging**: Close signal flow logs every step for debugging: detection, on-chain query result, execution.
- **Position Flip Detection**: Signals in the opposite direction of an open position trigger a two-step process: first, close the existing position using the **actual on-chain Drift position size** (queried via `getPerpPositions`), then open a new one in the signal direction. This ensures complete position closes without "dust" remaining.
- **Bot Pause Behavior**: Pausing a bot (`isActive: false`) automatically triggers a close of any open positions associated with it.
- **Webhook Deduplication**: `webhook_logs` table uses a `signal_hash` to prevent duplicate processing of TradingView signals.
- **Equity Event Tracking**: Tracks deposits and withdrawals for transaction history, ensuring idempotency.
- **Drift Subaccounts**: Each bot is assigned a unique `driftSubaccountId` for isolation. Trades execute on the bot's specific subaccount. Subaccounts are auto-initialized when users deposit funds to a bot.
- **Drift Account Parsing**: **ALWAYS use byte-parsing** for position reading to avoid memory leaks:
    1. **Byte-Parsing (`getPerpPositions`)**: Raw RPC calls with custom byte parsing - used for ALL position reading including close position detection. This is lightweight and doesn't create WebSocket connections.
    2. **SDK-Based (`getPerpPositionsSDK`)**: Uses official Drift SDK - **AVOID for position reading** due to memory leaks. Only use for trade execution where we need to submit transactions.
- **Account Health Metrics**: Uses byte-parsing to display account health factor, collateral values, and positions. SDK methods are AVOIDED to prevent memory leaks.
- **On-Chain-First Architecture**: On-chain Drift positions are ALWAYS the source of truth. Database is treated as a cache that can be wrong.
    - **PositionService** (`server/position-service.ts`): Central service for all position queries. Uses byte-parsing exclusively to avoid memory leaks from Drift SDK WebSocket connections.
    - **Critical Operations**: Close signals, position flips, and manual close all query on-chain directly using `PositionService.getPositionForExecution()` with byte-parsing - NEVER trust database for these operations.
    - **Drift Detection & Auto-Correction**: When on-chain differs from database, logs a warning and automatically updates database to match on-chain.
    - **UI Data Freshness**: API responses include `source` ('on-chain' | 'database') and `driftDetected` flags so UI can show data reliability.
    - **Market Normalization**: Uses regex to normalize market names (strips PERP, USD, separators) ensuring `SOL-PERP`, `SOLPERP`, `SOL/USD` all match correctly.
- **Automated Position Reconciliation**: Multi-layer sync ensures database stays updated:
    1. **Immediate Post-Trade Sync**: `syncPositionFromOnChain()` called after every successful trade. Queries actual on-chain position and updates database.
    2. **Periodic Background Sync (60s)**: `startPeriodicReconciliation()` runs every 60 seconds, checking all active bots.
    3. **Manual Sync Button**: UI button for user-triggered reconciliation.
    - **Realized PnL Tracking**: Calculated when positions close/reduce. Formula: `(fillPrice - avgEntry) * closedSize - proratedFee`. Fees are prorated for flip/overclose trades.
    - **On-Chain Position Reading**: Uses `getPerpPositions()` with raw RPC calls (`connection.getAccountInfo()`) and custom byte parsing, NOT Drift SDK WebSocket subscriptions which are unreliable.

## Known Issues

- **Memory Leak (Drift SDK WebSocket Connections)**: The Drift SDK creates WebSocket connections that don't properly cleanup, causing `accountUnsubscribe` timeout errors. Under heavy load, this can lead to JavaScript heap out of memory crashes. Mitigation: Use byte-parsing (`getPerpPositions`) instead of SDK-based methods for position reading. The SDK is reserved ONLY for trade execution where we must submit transactions.

## External Dependencies

### Blockchain & DeFi
- **Solana Web3.js**: Core Solana blockchain interaction.
- **Drift Protocol SDK**: For perpetual futures trading on Drift.
- **SPL Token**: For Solana Program Library token interactions.
- **RPC Endpoint**: Configurable via `SOLANA_RPC_URL`, defaults to Helius API key for reliability, with a fallback to public mainnet RPC.
- **Drift Protocol Configuration**: Uses Solana Mainnet-Beta by default, with real USDC.

### Database
- **PostgreSQL**: Required database.
- **Drizzle ORM**: Type-safe database queries.

### Environment Variables
- `DATABASE_URL`
- `SESSION_SECRET`
- `HELIUS_API_KEY` (recommended for production)
- `SOLANA_RPC_URL` (optional, overrides Helius)
- `DRIFT_ENV` (defaults to mainnet-beta)

### Frontend Libraries
- **shadcn/ui**: Component library based on Radix UI primitives.
- **React Hook Form with Zod**: For form management and validation.
- **Recharts**: For data visualization.
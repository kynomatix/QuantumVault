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
- **Position Flip Detection**: Signals in the opposite direction of an open position trigger a two-step process: first, close the existing position, then open a new one in the signal direction.
- **Bot Pause Behavior**: Pausing a bot (`isActive: false`) automatically triggers a close of any open positions associated with it.
- **Webhook Deduplication**: `webhook_logs` table uses a `signal_hash` to prevent duplicate processing of TradingView signals.
- **Equity Event Tracking**: Tracks deposits and withdrawals for transaction history, ensuring idempotency.
- **Drift Subaccounts**: Currently, all trades execute on `subaccount 0`. Multi-subaccount support is planned.
- **Drift Account Parsing**: Custom byte parsing is used for Solana Drift User and PerpPosition accounts to extract balances and positions, as direct Drift SDK usage has dependency conflicts.
- **Account Health Metrics**: Uses official Drift SDK methods (`getHealth()`, `getMarginRatio()`, `getTotalCollateral()`, `getFreeCollateral()`, `getUnrealizedPNL()`) to display account health factor, collateral values, and per-position liquidation prices on the dashboard.

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
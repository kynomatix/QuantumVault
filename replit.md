# QuantumVault - Solana Bot Trading Platform

## Overview
QuantumVault is a Solana-based bot trading platform enabling the deployment and management of perpetual futures trading bots on the Drift Protocol. It offers automated trade execution via TradingView webhooks, real-time position tracking, and Phantom Wallet integration. The platform aims to provide a robust and user-friendly experience for automated DeFi trading, leveraging Solana for high-speed, low-cost transactions. Key capabilities include real-time PnL tracking, automated position management, and robust error handling for critical trading operations. The platform also integrates a referral system for Drift Protocol, contributing to operational sustainability and offering user benefits.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Core Architecture
- **Monorepo Structure**: Organized into `client/`, `server/`, and `shared/` directories.
- **Agent Wallet Architecture**: Server-managed Solana wallet per user for autonomous trading, with encrypted private keys and simplified capital flow.
- **On-Chain-First Architecture**: On-chain Drift positions are the single source of truth. The database acts as a cache, with automated reconciliation and correction mechanisms.
- **Drift Subaccounts**: Each bot operates on a unique `driftSubaccountId` for isolation, with auto-initialization upon user deposits.
- **Referral Integration**: All new Drift accounts created are attributed to the platform's referral code (`kryptolytix`) for fee benefits and platform sustainability.

### Technical Stack
- **Frontend**: React 18 (TypeScript), Wouter for routing, TanStack React Query for server state, Tailwind CSS v4 with shadcn/ui (New York style), Framer Motion for animations, Solana Wallet Adapter (Phantom), Vite build tool.
- **Backend**: Node.js with Express.js (TypeScript, ESM modules), Express-session for cookie-based authentication, RESTful API design, esbuild for compilation.
- **Data Storage**: PostgreSQL via Drizzle ORM, with a defined schema for users, wallets, bots, trades, positions, and more. Migrations handled by Drizzle-kit.

### Key Features
- **Automated Trade Execution**: TradingView webhook signals trigger `placeAndTakePerpOrder` on Drift Protocol. Includes critical logic for converting TradingView `contracts` to a percentage of `bot.maxPositionSize` for pyramiding.
- **Robust Position Management**:
    - **Close Signal Detection**: `strategy.position_size = 0` from TradingView triggers a reduce-only close order. Close signals are prioritized, verified on-chain, and executed with `reduceOnly: true`. Enhanced logging and a guaranteed return mechanism prevent accidental open orders.
    - **Position Flip Detection**: Signals in the opposite direction trigger a two-step process: close existing position (using actual on-chain size), then open a new one.
    - **Close Order Precision**: Uses `closePerpPosition()` without explicit size, relying on DriftClient to query exact BN values, preventing float precision loss. Includes graceful handling for already closed positions and a dust cleanup retry loop.
- **Bot Lifecycle Management**: Pausing a bot (`isActive: false`) closes open positions. Bot deletion includes safety checks on agent wallet balance and an auto-sweep mechanism for funds.
- **Bot Deletion Safety (Jan 2026 Fix)**: Bot deletion correctly checks the AGENT wallet address for Drift balance before deletion. Force delete auto-sweeps funds from subaccounts to main account. Guards prevent deletion if wallet data is missing.
- **User Webhook Close Signal Fix (Jan 2026)**: Added close signal detection to the user-scoped webhook (`/api/webhook/user/:walletAddress`). Previously only the bot-scoped webhook had this logic, causing `position_size: "0"` signals to be treated as new trades instead of closes. Both webhook endpoints now properly detect and handle close signals.
- **Single Page Architecture**: All functionality is under `/app` with tab-based navigation (Dashboard, Bots, Wallet, Leaderboard, Settings). Only `/` (landing) and `/app` routes exist.
- **Drift Account Link**: Settings tab includes "View on Drift" button that opens `https://app.drift.trade/portfolio/accounts?authority={agentWalletAddress}` for on-chain balance verification.
- **Real-Time Data**: Tracks running positions, PnL, and fees. Uses `PositionService` for all position queries, leveraging SDK's `decodeUser` for reliable, stateless account parsing to avoid Drift SDK WebSocket memory leaks.
- **Account Health Metrics**: Uses SDK `decodeUser` for accurate account health, collateral, and liquidation price estimates, with conservative calculations for safety.
- **Webhook Deduplication**: `webhook_logs` table prevents duplicate processing of TradingView signals.
- **Equity Event Tracking**: Monitors deposits and withdrawals for transaction history.

## External Dependencies

### Blockchain & DeFi
- **Solana Web3.js**: Core Solana blockchain interaction.
- **Drift Protocol SDK**: For perpetual futures trading on Drift.
- **SPL Token**: For Solana Program Library token interactions.
- **RPC Endpoint**: Configurable via `SOLANA_RPC_URL` (defaults to Helius API key with public mainnet RPC fallback).
- **Drift Protocol Configuration**: Solana Mainnet-Beta (default).

### Database
- **PostgreSQL**: Primary database.
- **Drizzle ORM**: Type-safe database interactions.

### Environment Variables
- `DATABASE_URL`
- `SESSION_SECRET`
- `HELIUS_API_KEY`
- `SOLANA_RPC_URL`
- `DRIFT_ENV`
- `AGENT_ENCRYPTION_KEY`

### Frontend Libraries
- **shadcn/ui**: Component library.
- **React Hook Form with Zod**: Form management and validation.
- **Recharts**: Data visualization.
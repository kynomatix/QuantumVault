# QuantumVault - Solana Bot Trading Platform

## Overview
QuantumVault is a Solana-based bot trading platform designed for deploying and managing perpetual futures trading bots on the Drift Protocol. It facilitates automated trade execution via TradingView webhooks, provides real-time position tracking, and integrates with Phantom Wallet. The platform aims to deliver a robust and user-friendly experience for automated DeFi trading, leveraging Solana for high-speed, low-cost transactions. Key capabilities include real-time PnL tracking, automated position management, and robust error handling. It also incorporates a referral system for Drift Protocol, supporting platform sustainability and offering user benefits. The platform includes a marketplace feature allowing users to publish successful bots and subscribe to others' trading signals, fostering a community-driven trading environment.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Core Architecture
-   **Monorepo Structure**: Organized into `client/`, `server/`, and `shared/` directories.
-   **Agent Wallet Architecture**: Server-managed Solana wallet per user for autonomous trading, with encrypted private keys and simplified capital flow.
-   **On-Chain-First Architecture**: On-chain Drift positions are the single source of truth, with the database acting as a cache and automated reconciliation mechanisms.
-   **Drift Subaccounts**: Each bot operates on a unique `driftSubaccountId` for isolation, with auto-initialization upon user deposits.
-   **Referral Integration**: All new Drift accounts created are attributed to the platform's referral code (`kryptolytix`) for fee benefits and platform sustainability.

### Technical Stack
-   **Frontend**: React 18 (TypeScript), Wouter for routing, TanStack React Query for server state, Tailwind CSS v4 with shadcn/ui (New York style), Framer Motion for animations, Solana Wallet Adapter (Phantom), Vite build tool.
-   **Backend**: Node.js with Express.js (TypeScript, ESM modules), Express-session for cookie-based authentication, RESTful API design, esbuild for compilation.
-   **Data Storage**: PostgreSQL via Drizzle ORM, with a defined schema for users, wallets, bots, trades, positions. Migrations handled by Drizzle-kit.

### Key Features
-   **Automated Trade Execution**: TradingView webhook signals trigger `placeAndTakePerpOrder` on Drift Protocol, including logic for converting TradingView `contracts` to a percentage of `bot.maxPositionSize`.
-   **Robust Position Management**: Includes close signal detection (`strategy.position_size = 0`), position flip detection (two-step close then open), and precise close order execution using `closePerpPosition()` with dust cleanup.
-   **Bot Lifecycle Management**: Bots can be paused (closes open positions) and deleted (includes safety checks on agent wallet balance and auto-sweep). The deletion process now ensures all funds are swept and subaccounts are closed to reclaim rent, with orphaned subaccounts tracked for background retry.
-   **Trading Logic Enhancements**: Implemented fixes for leverage double-counting, ensuring correct trade sizing, and corrected market index mappings for all Drift perp markets.
-   **Dynamic Order Scaling**: Replaced rigid collateral gates with intelligent position scaling. Trades are automatically scaled down based on available margin and scale back up with equity recovery, ensuring continuous trading.
-   **Profit Management**:
    -   **Profit Reinvest**: Allows bots to use full available margin for trade sizing, compounding profits.
    -   **Auto Withdraw Threshold**: Automatically withdraws excess profits to the agent wallet when equity exceeds a defined threshold after position closes.
-   **Dynamic USDC Deposit APY**: Fetches real-time USDC lending APY from Drift Data API (`/rateHistory?marketIndex=0&marketType=spot`) with 5-minute caching. Displayed with `~` prefix in bot management drawer (e.g., `~1.7%`). Used for calculating estimated daily interest earnings.
-   **Reset Drift Account Feature**: A one-click solution to fully reset a user's Drift account, closing positions, settling PnL, sweeping funds, withdrawing to agent wallet, deleting bot subaccounts, and clearing bot assignments. Note: The main Drift account (subaccount 0) is preserved because Drift protocol prevents deletion of referred accounts - this is intentional to maintain referral fee benefits. The ~0.035 SOL rent is forfeited but the account can be reused for future trading.
-   **Single Page Architecture**: All functionality under `/app` with tab-based navigation (Dashboard, Bots, Wallet, Leaderboard, Settings).
-   **Real-Time Data**: Tracks running positions, PnL, and fees using `PositionService` and SDK's `decodeUser` for reliable, stateless account parsing.
-   **Account Health Metrics**: Uses SDK `decodeUser` for accurate account health, collateral, and liquidation price estimates.
-   **Webhook Deduplication**: `webhook_logs` table prevents duplicate processing of TradingView signals.
-   **Equity Event Tracking**: Monitors deposits and withdrawals for transaction history.
-   **Marketplace Feature**:
    -   **Publishing Bots**: Users can publish signal bots (excluding grid bots) with performance stats, subscriber count, and PnL metrics.
    -   **Subscription Flow**: Subscribing creates a new bot with subscriber's capital, linked to the source bot.
    -   **Signal Routing**: Source bot signals are forwarded to active subscriber bots, with proportional trade sizing.
    -   **PnL Snapshot Job**: Background job captures equity snapshots for performance metrics.
-   **Referral System**:
    -   **Referral Code Generation**: Each user receives a unique 6-character alphanumeric referral code.
    -   **Referral Tracking**: `ref` parameter in share URLs tracks referrers upon new user connections.
    -   **Share Integration**: Shareable URLs for published bots include referral codes, with options to share to X (Twitter).

## External Dependencies

### Blockchain & DeFi
-   **Solana Web3.js**: For core Solana blockchain interactions.
-   **Drift Protocol SDK**: For perpetual futures trading on Drift.
-   **SPL Token**: For Solana Program Library token interactions.
-   **RPC Endpoint**: Configurable via `SOLANA_RPC_URL` (defaults to Helius API key with public mainnet RPC fallback).
-   **Drift Protocol Configuration**: Solana Mainnet-Beta (default).

### Database
-   **PostgreSQL**: Primary database.
-   **Drizzle ORM**: Type-safe database interactions.

### Environment Variables
-   `DATABASE_URL`
-   `SESSION_SECRET`
-   `HELIUS_API_KEY`
-   `SOLANA_RPC_URL`
-   `DRIFT_ENV`
-   `AGENT_ENCRYPTION_KEY`

### Frontend Libraries
-   **shadcn/ui**: Component library.
-   **React Hook Form with Zod**: Form management and validation.
-   **Recharts**: Data visualization.
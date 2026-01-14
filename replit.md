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
- **Bot Deletion Rent Reclaim Fix (Jan 2026)**: Fixed critical bug where bot deletion would orphan on-chain Drift subaccounts with ~0.023 SOL rent locked. The delete flow now: (1) Always attempts to sweep ALL funds (including dust) from isolated subaccounts, (2) Attempts to close the on-chain subaccount to reclaim rent, (3) BLOCKS deletion with 409 error if subaccount cannot be closed, preventing orphaned subaccounts. Users are directed to use "Reset Drift Account" in Settings if deletion is blocked.
- **Dust Sweep BN Math Fix (Jan 2026)**: Enhanced drift-executor.mjs `deleteSubaccount` function to sweep ALL spot balances using BN (BigNumber) precision before deletion. Previously, dust amounts (e.g., 0.000634 USDC) survived float-based sweeps and prevented subaccount closure. Now uses `user.getTokenAmount()` to get exact BN values and transfers them via `transferDeposit()` before calling `deleteUser()`. Also fixed argument ordering bugs in reset-drift-account endpoint for `closePerpPosition`, `executeAgentTransferBetweenSubaccounts`, and `executeAgentDriftWithdraw`. The Reset Drift Account feature will now properly clean up orphaned subaccounts (like subaccount 3) and reclaim their rent.
- **User Webhook Close Signal Fix (Jan 2026)**: Added close signal detection to the user-scoped webhook (`/api/webhook/user/:walletAddress`). Previously only the bot-scoped webhook had this logic, causing `position_size: "0"` signals to be treated as new trades instead of closes. Both webhook endpoints now properly detect and handle close signals.
- **Leverage Double-Counting Fix (Jan 2026)**: Fixed critical bug where leverage was applied twice during trade sizing. The `maxPositionSize` field already includes leverage (calculated as `investment × leverage` during bot creation), but the webhook was applying leverage again when calculating contract size. This caused trades to be 10x larger than intended, leading to "InsufficientCollateral" errors. Now `contractSize = tradeAmountUsd / oraclePrice` without additional leverage multiplication. UI validation also added to prevent setting maxPositionSize higher than `botBalance × leverage`.
- **Complete Market Index Map Fix (Jan 2026)**: Fixed critical bug where ZEC-PERP and other non-core markets were routing to SOL-PERP (index 0). The `PERP_MARKET_INDICES` map in `drift-service.ts` only had SOL/BTC/ETH, causing unknown markets to default to index 0. Updated to include all 76+ Drift perp markets (ZEC=38, BONK=4, PENGU=50, AI16Z=51, TRUMP=52, etc.). Both `drift-service.ts` and `drift-executor.mjs` now have synchronized complete market index maps.
- **SDK Referral Attribution Fix (Jan 2026)**: Fixed critical bug where agent wallet Drift accounts created via SDK path were missing the kryptolytix referral attribution. The SDK's `initializeUserAccount` method requires explicit `referrerInfo` parameter but wasn't being passed. Now properly passes `{ referrer: user, referrerStats: userStats }` when initializing subaccount 0 via SDK. Note: Drift referral is set once at account creation and cannot be changed - existing accounts created before this fix won't have referral attribution.
- **Pre-Trade Collateral Gate (Jan 2026)**: Added real-time collateral check before trade execution to prevent InsufficientCollateral errors. When a bot has lost equity due to losses, the configured `maxPositionSize` may exceed what the actual Drift balance can support. The webhook handler now fetches `freeCollateral` from the Drift subaccount and caps trade size to 90% of available margin. Trades are rejected with a clear error message if free collateral is below $1. This ensures trades respect actual on-chain balance rather than just the configured maximum.
- **Reset Drift Account Feature (Jan 2026)**: Added Settings > Danger Zone "Reset Drift Account" button that fully automates account cleanup: (1) Closes all open positions in all subaccounts, (2) Sweeps funds from bot subaccounts to main account, (3) Withdraws all funds from Drift to agent wallet, (4) Deletes all subaccounts in reverse order (highest first, 0 last) to recover rent, (5) Clears bot subaccount assignments in database. This allows users to completely reset their Drift account with one click.
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
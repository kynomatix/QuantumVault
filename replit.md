# QuantumVault - Solana Bot Trading Platform

## Overview
QuantumVault is a Solana-based bot trading platform for deploying and managing perpetual futures trading bots on the Drift Protocol. It automates trade execution via TradingView webhooks, provides real-time position tracking, and integrates with Phantom Wallet. The platform aims for a user-friendly experience in automated DeFi trading, leveraging Solana for high-speed, low-cost transactions. Key capabilities include real-time PnL tracking, automated position management, robust error handling, a referral system for Drift Protocol, and a marketplace for trading signals to foster a community-driven environment.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Core Architecture
-   **Monorepo Structure**: Organized into `client/`, `server/`, and `shared/` directories.
-   **Agent Wallet Architecture**: Server-managed Solana wallet per user for autonomous trading, with encrypted private keys and simplified capital flow.
-   **On-Chain-First Architecture**: Drift positions on-chain are the single source of truth, with the database acting as a cache and automated reconciliation.
-   **Drift Subaccounts**: Each bot operates on a unique `driftSubaccountId` for isolation, with auto-initialization upon user deposits.
-   **Referral Integration**: All new Drift accounts created are attributed to the platform's referral code.

### Technical Stack
-   **Frontend**: React 18 (TypeScript), Wouter for routing, TanStack React Query, Tailwind CSS v4 with shadcn/ui, Framer Motion, Solana Wallet Adapter, Vite.
-   **Backend**: Node.js with Express.js (TypeScript, ESM modules), Express-session, RESTful API design, esbuild.
-   **Data Storage**: PostgreSQL via Drizzle ORM.

### Key Features
-   **Automated Trade Execution**: TradingView webhook signals trigger `placeAndTakePerpOrder` on Drift Protocol, with dynamic sizing.
-   **Robust Position Management**: Includes close signal detection, position flip detection, and precise close order execution.
-   **Bot Lifecycle Management**: Supports pausing and deleting bots, including safety checks.
-   **Unified Trade Execution**: All trade paths use a shared helper for consistent auto top-up, profit reinvestment, trade sizing, and minimum order handling.
-   **Dynamic Order Scaling**: Trades are automatically scaled based on available margin capacity and equity recovery.
-   **Profit Management**: Supports profit reinvestment and automatic withdrawal of excess profits.
-   **Dynamic USDC Deposit APY**: Fetches real-time USDC lending APY from Drift Data API.
-   **Reset Drift Account Feature**: A one-click solution to fully reset a user's Drift account.
-   **Single Page Architecture**: All functionality under `/app` with tab-based navigation.
-   **Real-Time Data**: Tracks running positions, PnL, and fees.
-   **Account Health Metrics**: Uses SDK `decodeUser` for accurate account health, collateral, and liquidation price estimates.
-   **Webhook Deduplication**: Prevents duplicate processing of TradingView signals.
-   **Automatic Trade Retry**: Failed trades are automatically queued for retry with exponential backoff and critical priority for CLOSE orders. On-chain verification prevents duplicate closes. Auto top-up on retry for insufficient collateral.
-   **Equity Event Tracking**: Monitors deposits and withdrawals for transaction history.
-   **Marketplace Feature**: Users can publish signal bots and subscribe to others' trading signals, with proportional trade sizing and PnL snapshots.
-   **Creator Profit Sharing**: Signal bot creators earn a percentage of subscriber profits on profitable trade closes, handled via immediate on-chain USDC transfers with an IOU failover system.
-   **Referral System**: Unique 6-character alphanumeric referral codes for each user.

### Security Architecture
-   **Key Management**: User Master Key (UMK) derived per-user, encrypting secrets with AES-256-GCM, and session-based decryption.
-   **Execution Authorization**: Permanent execution authorization via wallet signature, with emergency stop and policy HMAC for bot configuration tamper detection.
-   **Agent Wallet Backup**: Seed phrase reveal in Settings, signature-gated, rate-limited, and auto-hiding.
-   **Production Deployment Security**: Measures include disabling core dumps, protecting environment variables, and memory security.
-   **Key Logging Policy**: Strict policy to never log sensitive key material.

## External Dependencies

### Blockchain & DeFi
-   **Solana Web3.js**: Core Solana blockchain interactions.
-   **Drift Protocol SDK**: Perpetual futures trading on Drift.
-   **SPL Token**: Solana Program Library token interactions.
-   **RPC Endpoint**: Configurable via `SOLANA_RPC_URL`. Uses Helius as primary with Triton as fallback.
-   **Drift Protocol Configuration**: Solana Mainnet-Beta.

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
-   `SERVER_EXECUTION_KEY`
-   `TELEGRAM_BOT_TOKEN`
-   `TELEGRAM_BOT_USERNAME`

### Telegram Notifications
-   **Direct API Integration**: Uses Telegram Bot API directly for configurable notifications.
-   **Token-based Connection Flow**: User connects via deep link to link `telegramChatId` to wallet.
-   **Multi-wallet Support**: Multiple wallets can share a `telegramChatId`.

## Recent Fixes

### Copy Trading (Marketplace) Routing Fix (Feb 4 2026)
-   **Root cause identified**: The `routeSignalToSubscribers()` function had **silent early returns** at critical checkpoints with no logging, making debugging impossible.
-   **Impact**: Subscriber bots received ZERO trades despite source bots executing successfully. Copy trading was broken with no diagnostic visibility.
-   **Fixes applied**:
    1. Added diagnostic logging at function entry showing source bot ID, signal action, and close status
    2. Added logging for published bot lookup: shows if not found or inactive
    3. Added logging for subscriber query: shows if no subscribers found
    4. Added per-subscriber processing logs: bot ID, name, isActive status, market
    5. Added wallet lookup logs: found status, hasAgentKey status
    6. Added summary log at function end: counts of skipped/success/failed trades and closes
-   **Result**: Live routing test confirmed working - subscriber bots now receive routed trades
-   **Files changed**: `server/routes.ts`

### Subprocess Timeout RPC Failover Fix (Feb 4 2026)
-   **Root cause identified**: Subprocess timeouts (TIMEOUT_SUBPROCESS) weren't triggering RPC failover because timeout errors weren't being detected in the error handler.
-   **Fixes applied**: Added timeout detection (`timeout` and `timed out` keywords) to subprocess result handlers and catch blocks in 4 locations.
-   **Result**: After 2 consecutive timeout errors, system now switches to Triton backup RPC for 3 minutes.
-   **Files changed**: `server/drift-service.ts`
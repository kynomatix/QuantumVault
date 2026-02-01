# QuantumVault - Solana Bot Trading Platform

## Overview
QuantumVault is a Solana-based bot trading platform for deploying and managing perpetual futures trading bots on the Drift Protocol. It automates trade execution via TradingView webhooks, provides real-time position tracking, and integrates with Phantom Wallet. The platform aims to offer a user-friendly experience for automated DeFi trading, leveraging Solana for high-speed, low-cost transactions. Key features include real-time PnL tracking, automated position management, and robust error handling. It also incorporates a referral system for Drift Protocol and a marketplace for users to publish and subscribe to trading signals, fostering a community-driven environment.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Core Architecture
-   **Monorepo Structure**: Organized into `client/`, `server/`, and `shared/` directories.
-   **Agent Wallet Architecture**: Server-managed Solana wallet per user for autonomous trading, with encrypted private keys and simplified capital flow.
-   **On-Chain-First Architecture**: On-chain Drift positions are the single source of truth, with the database acting as a cache and automated reconciliation.
-   **Drift Subaccounts**: Each bot operates on a unique `driftSubaccountId` for isolation, with auto-initialization upon user deposits.
-   **Referral Integration**: All new Drift accounts created are attributed to the platform's referral code (`kryptolytix`).

### Technical Stack
-   **Frontend**: React 18 (TypeScript), Wouter for routing, TanStack React Query, Tailwind CSS v4 with shadcn/ui, Framer Motion, Solana Wallet Adapter, Vite.
-   **Backend**: Node.js with Express.js (TypeScript, ESM modules), Express-session, RESTful API design, esbuild.
-   **Data Storage**: PostgreSQL via Drizzle ORM.

### SDK Loading Architecture
-   **Lazy ESM Import**: DriftClient is loaded lazily via dynamic `import()`.
-   **Trade Execution**: Uses `drift-executor.mjs` subprocess for trade execution.
-   **SDK Version**: `@drift-labs/sdk@2.146.0-beta.7` is the current stable version.
-   **Market Index Mapping**: CRITICAL - `PERP_MARKET_INDICES` and `PERP_MARKET_NAMES` must be sourced from the official Drift SDK (`PerpMarkets['mainnet-beta']`). Drift adds prediction market BETs between regular PERPs (indices 36-41, 43, 46, 48-50, 57-58, 67-68), causing non-sequential indexing. Run `node -e "require('@drift-labs/sdk').PerpMarkets['mainnet-beta'].forEach(m => console.log(m.marketIndex + ': ' + m.symbol))"` to get authoritative values.
-   **Referrer Account Handling**: The executor fetches the user's referrer from their on-chain UserStats account and passes it to the SDK. Fallback to deriving referrer PDAs directly from the known wallet address is implemented for "kryptolytix".
-   **Idempotent Account Initialization**: Gracefully handles Drift errors 6214 ("Account Already Initialized") and Anchor error 3007 ("AccountOwnedByWrongProgram") by logging warnings and proceeding, preventing blocking of deposits/bot creation due to RPC staleness.
-   **Batch Account Verification**: Replaced individual `getAccountInfo` calls with `getMultipleAccountsInfo` for atomic account state checking and verifies account ownership to prevent false negatives from corrupted account data.
-   **UserStats `numberOfSubAccountsCreated` Counter**: Uses `numberOfSubAccountsCreated` from UserStats as the authoritative source for assigning the next subaccount ID, fixing "Invalid sub account id N, must be M" errors.

### Key Features
-   **Automated Trade Execution**: TradingView webhook signals trigger `placeAndTakePerpOrder` on Drift Protocol, with logic for converting `contracts` to a percentage of `bot.maxPositionSize`.
-   **Robust Position Management**: Includes close signal detection, position flip detection, and precise close order execution with dust cleanup.
-   **Bot Lifecycle Management**: Bots can be paused (closes open positions) and deleted (includes safety checks, auto-sweep, and subaccount closure).
-   **Unified Trade Execution**: All 4 trade paths (webhook, user webhook, manual trade, subscriber routing) use the shared `computeTradeSizingAndTopUp` helper for consistent auto top-up, profit reinvest, trade sizing, and minimum order handling.
-   **Dynamic Order Scaling**: Trades are automatically scaled down to 80% of available margin capacity (accounting for fees/slippage/oracle drift) and scaled up with equity recovery.
-   **Profit Management**: Supports profit reinvestment (with automatic PnL settlement after position closes) and automatic withdrawal of excess profits.
-   **Dynamic USDC Deposit APY**: Fetches real-time USDC lending APY from Drift Data API.
-   **Reset Drift Account Feature**: A one-click solution to fully reset a user's Drift account, preserving the main Drift account (subaccount 0).
-   **Single Page Architecture**: All functionality under `/app` with tab-based navigation.
-   **Real-Time Data**: Tracks running positions, PnL, and fees using `PositionService` and SDK's `decodeUser`.
-   **Account Health Metrics**: Uses SDK `decodeUser` for accurate account health, collateral, and liquidation price estimates.
-   **Webhook Deduplication**: `webhook_logs` table prevents duplicate processing of TradingView signals.
-   **Automatic Trade Retry**: Failed trades due to rate limiting are automatically queued for retry with exponential backoff. CLOSE orders get critical priority (10 attempts, shorter backoff) to prevent losses from failed position closures. On-chain position verification prevents duplicate closes.
-   **Auto Top-Up on Retry**: When retrying trades that failed with InsufficientCollateral, uses simple equity-based formula: `deposit = target equity - current equity`. Target equity = Investment Amount (maxPositionSize / leverage). Leverage is irrelevant for deposit calculations - only equity matters.
-   **Equity Event Tracking**: Monitors deposits and withdrawals for transaction history.
-   **Marketplace Feature**: Users can publish signal bots and subscribe to others' trading signals, with proportional trade sizing and PnL snapshots.
-   **Creator Profit Sharing**: Signal bot creators earn 0-10% of subscriber profits on each profitable trade close. Uses immediate on-chain USDC transfers with IOU failover system for failed transactions. Background retry job processes pending IOUs every 5 minutes with TTL enforcement (50 retries or 7 days max). Hostage prevention blocks withdrawal/deletion until IOUs are paid.
-   **Referral System**: Unique 6-character alphanumeric referral codes for each user, tracked via `ref` parameter in share URLs.

### Security Architecture
-   **Key Management**: User Master Key (UMK) derived per-user, encrypting secrets with AES-256-GCM, and session-based decryption.
-   **Execution Authorization**: Permanent execution authorization enabled via wallet signature, persisting until manually revoked. Includes an emergency stop feature and policy HMAC for bot configuration tamper detection.
-   **Agent Wallet Backup**: Seed phrase reveal in Settings, signature-gated, rate-limited, and auto-hiding.
-   **Production Deployment Security**: Disabling core dumps, protecting environment variables, and memory security measures like buffer zeroization.
-   **Key Logging Policy**: Strict policy to never log sensitive key material.

## External Dependencies

### Blockchain & DeFi
-   **Solana Web3.js**: Core Solana blockchain interactions.
-   **Drift Protocol SDK**: Perpetual futures trading on Drift.
-   **SPL Token**: Solana Program Library token interactions.
-   **RPC Endpoint**: Configurable via `SOLANA_RPC_URL` (defaults to Helius API key with public mainnet RPC fallback).
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
-   **Direct API Integration**: Uses Telegram Bot API directly.
-   **Token-based Connection Flow**: User connects via deep link, token validates and links `telegramChatId` to wallet.
-   **Multi-wallet Support**: Multiple wallets can share a `telegramChatId`.
-   **Notification Types**: Configurable notifications for trade executions, failed trades, and position closures.

## Admin Dashboard & Production Debugging

### Production Admin Access
-   **Admin URL**: `https://myquantumvault.com/admin`
-   **Authentication**: Password stored in `ADMIN_PASSWORD` secret
-   **API Access**: Bearer token auth with password for programmatic access

### Admin API Endpoints
-   `GET /api/admin/stats` - Dashboard stats (bots, trades, webhooks, subscriptions)
-   `GET /api/admin/webhook-logs?limit=N` - Recent webhook logs
-   `GET /api/admin/trades?limit=N` - Recent trade history
-   `GET /api/admin/bots` - All trading bots with stats
-   `GET /api/admin/subscriptions` - All marketplace subscriptions
-   `GET /api/admin/subscription-diagnostics` - Deep subscription routing diagnostics
-   `GET /api/admin/pending-profit-shares` - Pending IOU profit shares

### Debugging Commands
To check production data via curl:
```bash
curl -s -H "Authorization: Bearer $ADMIN_PASSWORD" "https://myquantumvault.com/api/admin/subscription-diagnostics"
```

### Known Issues (Jan 2026)
-   **RNDR subscribers have funding problems** - routing works but:
    - Subscriber c57d65fb is PAUSED (wallet only has $0.18 USDC)
    - Subscriber 2afe9363 has autoTopUp=false and insufficient subaccount collateral
-   See `docs/SUBSCRIBER_DIAGNOSTICS.md` for detailed investigation log

### Subscriber Routing Fix (Feb 1 2026)
-   **Root cause identified**: Trade retry system was bypassing subscriber routing. When source bot trades failed with temporary errors (margin, rate limits), webhook handler returned early BEFORE the routing call. Retry service successfully executed trades but had NO routing logic.
-   **Fix applied**: Added `registerRoutingCallback()` to `trade-retry-service.ts`. After successful retry, calls the registered routing function for both OPEN and CLOSE signals.
-   **Verification**: Logs now show `[TradeRetry] Routing callback registered` on startup.
-   **Callback pattern**: Avoids circular dependencies - `routes.ts` registers `routeSignalToSubscribers` at startup.

### Previous Fixes
-   **Jan 30**: Changed fire-and-forget async routing calls to `await routeSignalToSubscribers(...)` 
-   **Jan 29**: Added failed trade records for all routing failure scenarios
-   **Counters tracked**: skippedInactive, tradeSuccess, tradeFailed, closeSuccess, closeFailed
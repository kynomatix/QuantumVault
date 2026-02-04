# QuantumVault - Solana Bot Trading Platform

## Overview
QuantumVault is a Solana-based bot trading platform designed for deploying and managing perpetual futures trading bots on the Drift Protocol. It automates trade execution via TradingView webhooks, provides real-time position tracking, and integrates with Phantom Wallet. The platform aims to deliver a user-friendly experience for automated DeFi trading, leveraging Solana for high-speed, low-cost transactions. Key capabilities include real-time PnL tracking, automated position management, robust error handling, a referral system for Drift Protocol, and a marketplace for trading signals to foster a community-driven environment.

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
-   **Automated Trade Execution**: TradingView webhook signals trigger `placeAndTakePerpOrder` on Drift Protocol, with dynamic sizing based on `bot.maxPositionSize`.
-   **Robust Position Management**: Includes close signal detection, position flip detection, and precise close order execution with dust cleanup.
-   **Bot Lifecycle Management**: Supports pausing and deleting bots, including safety checks and subaccount closure.
-   **Unified Trade Execution**: All trade paths (webhook, user webhook, manual trade, subscriber routing) use a shared helper for consistent auto top-up, profit reinvestment, trade sizing, and minimum order handling.
-   **Dynamic Order Scaling**: Trades are automatically scaled based on available margin capacity and equity recovery.
-   **Profit Management**: Supports profit reinvestment and automatic withdrawal of excess profits.
-   **Dynamic USDC Deposit APY**: Fetches real-time USDC lending APY from Drift Data API.
-   **Reset Drift Account Feature**: A one-click solution to fully reset a user's Drift account, preserving the main Drift account.
-   **Single Page Architecture**: All functionality under `/app` with tab-based navigation.
-   **Real-Time Data**: Tracks running positions, PnL, and fees.
-   **Account Health Metrics**: Uses SDK `decodeUser` for accurate account health, collateral, and liquidation price estimates.
-   **Webhook Deduplication**: Prevents duplicate processing of TradingView signals.
-   **Automatic Trade Retry**: Failed trades are automatically queued for retry with exponential backoff and critical priority for CLOSE orders. On-chain verification prevents duplicate closes.
-   **Auto Top-Up on Retry**: When retrying trades that failed due to insufficient collateral, an equity-based formula determines the deposit amount.
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
-   **Direct API Integration**: Uses Telegram Bot API directly for configurable notifications (trade executions, failed trades, position closures).
-   **Token-based Connection Flow**: User connects via deep link to link `telegramChatId` to wallet.
-   **Multi-wallet Support**: Multiple wallets can share a `telegramChatId`.

## Recent Fixes

### Trade Retry System Audit & Fix (Feb 3 2026)
-   **Root cause identified**: In-memory retry queue used custom-generated IDs (`retry_XXXXX`) while database used auto-generated UUIDs. This ID mismatch caused database updates to fail silently, and jobs loaded on restart had different IDs than what was originally queued.
-   **Fixes applied**: 
    1. Persist job to database FIRST to obtain database-generated ID
    2. Use database ID for in-memory queue (instead of custom ID)
    3. Fallback to generated ID only if database persistence fails
    4. Added `webhookPayload` (jsonb) and `entryPrice` (decimal) columns to `trade_retry_queue` schema
    5. Updated `queueTradeRetry()` to persist these fields for restart survival
    6. Updated `startRetryWorker()` to restore these fields when loading from database
-   **Benefits**: 
    - Database updates now work correctly with matching IDs
    - Jobs loaded on restart match their original IDs
    - Routing to subscribers works after restart (webhookPayload preserved)
    - Profit share calculation works after restart (entryPrice preserved)
-   **RPC Failover Audit**: File-based persistence at `/tmp/drift_rpc_failover_state.json` verified working:
    - Atomic write pattern (temp file + rename) prevents corruption
    - State shared across subprocess invocations
    - Cooldown logic correctly switches back to primary after 3 minutes
    - Note: State is per-instance (not shared across multiple server instances)
-   **Files changed**: `server/trade-retry-service.ts`, `shared/schema.ts`

### Manual Close Endpoint Trade History Fix (Feb 3 2026)
-   **Root cause identified**: Manual close endpoint (`/api/trading-bots/:id/close-position`) created trade record ONLY on success. When close failed with transient error and was queued for retry, no trade record existed and no `originalTradeId` was passed to retry queue. When retry succeeded, the original "failed" status couldn't be updated because there was no linked trade.
-   **Fix applied**:
    1. Create pending trade record BEFORE attempting close execution
    2. Pass `originalTradeId: pendingCloseTrade.id` to retry queue
    3. Update existing trade record on success (instead of creating new one)
    4. Mark trade as "failed" on permanent failure (not transient)
-   **Result**: When retry succeeds, trade status updates from "pending" to "recovered", showing correct history
-   **Files changed**: `server/routes.ts`

### Trade Retry On-Chain Verification for OPEN Trades (Feb 3 2026)
-   **Root cause identified**: When a trade attempt times out but actually succeeds on-chain, the retry system marks it as failed. The retry service already verified on-chain positions for CLOSE orders (to prevent duplicate closes), but not for OPEN orders (long/short).
-   **Scenario**: Trade submitted → SDK times out → marked as "failed" → but transaction actually confirmed on-chain → position exists
-   **Fix applied**: Added on-chain position verification BEFORE retrying OPEN trades:
    1. Query existing positions via `getPerpPositions()`
    2. If position exists in the intended direction, recognize trade as already executed
    3. Update trade status to "recovered" with message "Trade succeeded on-chain despite timeout"
    4. Skip unnecessary retry attempts
-   **Result**: Trades that timed out but succeeded will now show "Recovered" instead of "Failed"
-   **Files changed**: `server/trade-retry-service.ts`

### Error Categories & RPC Failover Fix (Feb 3 2026)
-   **Problem identified**: Timeout errors were misleadingly labeled as "429 rate limit" regardless of actual cause. RPC failover wasn't triggering because 429 errors weren't being tracked at the TypeScript level (only in subprocess).
-   **Error Categories defined** in `server/drift-service.ts`:
    - `TIMEOUT_TRADE`: Trade execution timed out after 10 seconds
    - `TIMEOUT_CLOSE`: Close execution timed out after 10 seconds
    - `TIMEOUT_SUBPROCESS`: Subprocess operation timed out after 10 seconds
    - `RPC_RATE_LIMIT`: RPC provider returned 429 rate limit error
    - `RPC_CONNECTION`: Failed to connect to RPC endpoint (includes "Connection terminated unexpectedly")
    - `INSUFFICIENT_MARGIN`: Not enough collateral for trade
    - `INSUFFICIENT_FREE_COLLATERAL`: Free collateral below requirement
    - `NO_POSITION`: No open position found to close
    - `REDUCE_ONLY_VIOLATION`: Reduce-only order would increase position
    - `UNKNOWN_MARKET`: Market index not found
    - `MARKET_PAUSED`: Market is currently paused
-   **RPC Failover fixes**:
    1. Added `reportRPCError()` function that handles both rate limits and connection errors
    2. Failover state now tracked at TypeScript level, shared with subprocess via `/tmp/drift_rpc_failover_state.json`
    3. Both 429 errors AND connection errors (terminated unexpectedly, econnreset, socket hang up) trigger failover
    4. Successful trades reset the error counter
    5. Threshold: 2 consecutive RPC errors → switch to Triton backup for 3 minutes
-   **Result**: Accurate error reporting enables proper RPC failover for both rate limiting AND connection drops
-   **Files changed**: `server/drift-service.ts`, `server/trade-retry-service.ts`

### Connection Error Handling Fix (Feb 3 2026)
-   **Root cause identified**: "Connection terminated unexpectedly" errors were not triggering RPC failover, causing trades to fail repeatedly on the same dead RPC endpoint.
-   **Scenario observed**: FART 4H OI Skalpa bot failed 32 retry attempts at 12:00 UTC with "Connection terminated unexpectedly", but manual retry at 12:16 UTC succeeded.
-   **Fixes applied**:
    1. Removed misleading `normalizeRateLimitError()` that labeled all timeouts as "429 rate limit"
    2. Added connection errors to `isTransientError()`: connection terminated, terminated unexpectedly, econnreset, econnrefused, socket hang up
    3. Added timeout errors to `isTransientError()`: TIMEOUT_SUBPROCESS, TIMEOUT_TRADE, TIMEOUT_CLOSE, timed out
    4. Connection errors now trigger `reportRPCError('connection')` which increments failover counter
    5. Error categorization via `categorizeError()` now catches "terminated unexpectedly" as RPC_CONNECTION
-   **Result**: Connection drops now trigger RPC failover to Triton backup, preventing repeated failures on dead primary RPC
-   **Files changed**: `server/drift-service.ts`, `server/trade-retry-service.ts`

### CRITICAL: Subprocess Timeout Not Triggering Failover (Feb 4 2026)
-   **Root cause identified**: Previous fix added timeout detection but only in the in-process DriftClient path. When subprocess times out after 10 seconds and returns `TIMEOUT_SUBPROCESS` error, the error handler checked for `429`, `connection terminated`, `econnreset`, `socket hang up` - but NOT for `timeout` or `timed out`.
-   **Impact**: 145 trades failed overnight with `TIMEOUT_SUBPROCESS` errors. Triton backup was never triggered because timeouts didn't increment the failover counter.
-   **Production data**: Retry queue showed jobs with 20-57 attempts (max should be 5-10), all with `TIMEOUT_SUBPROCESS` error, all hitting the same dead Helius RPC.
-   **Fixes applied**:
    1. Added timeout detection to subprocess result handler: `errLower.includes('timeout') || errLower.includes('timed out')`
    2. Added same detection to subprocess catch blocks (both trade and close paths)
    3. Timeout errors now call `reportRPCError('connection')` to increment failover counter
    4. After 2 consecutive timeout errors, system will now switch to Triton backup for 3 minutes
-   **Key code locations fixed** (4 places in `server/drift-service.ts`):
    - Line ~3368: Subprocess result handler for trades
    - Line ~3406: Catch block for trades
    - Line ~3540: Subprocess result handler for closes
    - Line ~3581: Catch block for closes
-   **Result**: Subprocess timeouts now properly trigger RPC failover to Triton, preventing the overnight failure scenario
-   **Files changed**: `server/drift-service.ts`
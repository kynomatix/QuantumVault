# QuantumVault - Solana Bot Trading Platform

## Overview
QuantumVault is a Solana-based bot trading platform for deploying and managing perpetual futures trading bots on the Drift Protocol. It automates trade execution via TradingView webhooks, provides real-time position tracking, and integrates with Phantom Wallet. The platform aims for a user-friendly experience in automated DeFi trading, leveraging Solana for high-speed, low-cost transactions. Key capabilities include real-time PnL tracking, automated position management, robust error handling, a referral system for Drift Protocol, and a marketplace for trading signals to foster a community-driven environment.

## User Preferences
Preferred communication style: Simple, everyday language.

### CRITICAL: Do NOT Attempt These Fixes
-   **NEVER use minimal/reduced DriftClient subscription for the close path in drift-executor.mjs.** On Feb 16 2026, passing `marketIndex` to `createDriftClient()` for closes caused "DriftClient has no user for user id X" errors in production, breaking all position closes on non-zero subaccounts. The close path MUST use full subscription (no `requiredPerpMarketIndex`) so the SDK has time to load user account data via BulkAccountLoader. The open/trade path can use minimal subscription with proper fallbacks, but closes cannot.

### Public URL Policy
-   **Production URL**: https://myquantumvault.com/ — ALWAYS use this for any external-facing references, submissions, documentation, or communications.
-   **NEVER** share or broadcast the Replit URL externally. The Replit URL is internal only.

### Assets
-   **Pitchdeck**: Available for investor/partner presentations and grant applications when relevant.
-   **GitHub**: https://github.com/kynomatix/QuantumVault

### Superteam Earn Agent
-   **Agent Name**: quantumvault-agent
-   **Agent ID**: 3447347d-709d-4727-845a-fb95968457ab
-   **Claim Code**: F7B595763A80A2D1FD3A52D1
-   **Username**: quantumvault-agent-chocolate-83

### RPC Configuration
-   **Primary RPC**: Helius Dev Tier (PAID - not free tier)
-   **Backup RPC**: Triton (funded and available for failover)
-   Both RPCs are paid tiers with higher rate limits than free tier.

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
-   **Swift-First Trade Execution**: All trades route through Swift Protocol (gasless, MM-auction-based fills) with automatic fallback to legacy `placeAndTakePerpOrder`. Late-fill guard prevents double execution during fallback. Emergency rollback via `SWIFT_ENABLED=false`.
-   **Unified Trade Execution**: All trade paths (webhook, manual, subscriber, close) use a shared helper for consistent auto top-up, profit reinvestment, trade sizing, and minimum order handling. Dynamic order scaling based on margin capacity and equity recovery.
-   **Profit Management**: Supports profit reinvestment and automatic withdrawal of excess profits. Dynamic USDC Deposit APY fetched from Drift Data API.
-   **Account Management**: One-click reset for Drift accounts.
-   **User Interface**: Single Page Architecture with tab-based navigation for real-time data (running positions, PnL, fees) and account health metrics using SDK `decodeUser`.
-   **Reliability**: Webhook deduplication, automatic trade retry with exponential backoff and critical priority for CLOSE orders, on-chain verification for duplicate closes, and auto top-up on retry.
-   **Equity Event Tracking**: Monitors deposits and withdrawals for transaction history.
-   **Marketplace**: Users can publish signal bots and subscribe to others' trading signals, with proportional trade sizing and PnL snapshots. Subscriber trades execute sequentially with 2s stagger to prevent RPC contention (see `SUBSCRIBER_DIAGNOSTICS.md`).
-   **Creator Profit Sharing**: Signal bot creators earn a percentage of subscriber profits on profitable trade closes via immediate on-chain USDC transfers with an IOU failover system.
-   **Referral System**: Unique 6-character alphanumeric referral codes for each user.
-   **QuantumLab (Backtesting)**: Hidden at `/quantumlab` (no nav button). Pine Script strategy backtesting and optimization engine with OKX perpetual futures OHLCV data (Gate.io fallback for tickers not on OKX like DRIFT, TNSR, CLOUD, IO, DBR, MNT), random search + refinement optimizer, risk analysis, and strategy library. **Engine Fidelity**: Engine faithfully matches Pine Script behavior — LazyBear squeeze momentum formula (`close - avg(avg(highest, lowest), sma)`), RMA-based ATR (Wilder's smoothing), SMA-based Keltner Channel, next-bar-open entry fills via pending order system, configurable exit fill mode via `process_orders_on_close` from Pine Script `strategy()` header — when `false` (default): intrabar TP/SL fills at exact level prices using high/low detection (TPs check `high` for longs / `low` for shorts, SLs check `low` for longs / `high` for shorts, trail tracks bar extremes); when `true`: close-based detection with next-bar-open fills. Parsed automatically from strategy header and stored in `strategySettings.processOrdersOnClose`. All SL modes (ATR/Percentage/BB Band/Keltner Band), all TP modes (ATR/Percentage/Risk Multiple), conditional exits (momentum flip/hull flip/re-squeeze/RSI extreme/ADX drop — these still use next-bar-open fills), breakeven stop, trail activation modes, cooldown bars, EMA trend bias, candle body filter, squeeze lookback window, and BB Width percentile alternative compression. **Pine Parser**: Uses quote-aware character-by-character parsing (not regex) to find closing `)` of `input.xxx(...)` and `strategy(...)` calls — handles parens inside quoted titles/tooltips like `"BB Width Percentile (alt mode)"` without truncating keyword args. Both `parsePineScript` (input extraction) and `injectParamsIntoPineScript` (export) use this approach. Backend at `server/lab/` with APIs at `/api/lab/`. DB tables: `lab_strategies`, `lab_optimization_runs` (with `checkpoint` JSONB column), `lab_optimization_results`, `lab_candle_cache` (persistent OHLCV cache). Max 1 concurrent optimization job. Styled to match Docs page (violet/slate theme with sidebar navigation). **Worker Thread Isolation**: The optimizer runs in a Node.js Worker Thread (`server/lab/optimizer-worker.ts`) to prevent CPU-intensive backtesting from starving the Express event loop, DB connections, and trading operations. Candle data is fetched on the main thread and passed to the worker via `workerData`. All DB operations (checkpoints, results) happen on the main thread via worker messages. In dev mode, the worker is spawned via `eval` with `tsx/cjs`; in production, it's a separate esbuild bundle (`dist/optimizer-worker.cjs`). **Checkpoint/Resume**: Time-based checkpoints every 60s (not iteration-based) to minimize DB contention. Partial results saved to `lab_optimization_results` table. Checkpoint JSONB is lightweight (iteration counters only). `cleanupStaleRuns` checks both checkpoint JSONB and results table — runs with persisted results are marked "paused" not "failed". Frontend detects dead jobs after 5 failed SSE reconnects. **Candle Cache**: OHLCV data cached in PostgreSQL (`lab_candle_cache` table). Cache management via `GET /api/lab/cache/stats` and `DELETE /api/lab/cache`. **Strategy Insights**: 4th tab in QuantumLab for statistical analysis across all optimization runs for a strategy. Analysis engine in `client/src/lib/strategy-insights.ts` produces parameter sensitivity, ticker/timeframe fit, directional bias, trade patterns, and actionable recommendations. Backend endpoint `GET /api/lab/strategies/:id/all-results` aggregates all results across runs. "Copy Report" button formats the report as Claude-friendly text for strategy improvement suggestions. **Saved Insights Reports**: Reports auto-save to `lab_insights_reports` table on generation. Users can load past reports from a collapsible list. **Guided Mode Optimizer**: Optional "Use Insights" toggle in Advanced Settings (off by default). When enabled, reads the latest saved insights report and narrows parameter ranges to best-performing buckets from `paramSensitivity` data. 80% of random samples use narrowed ranges, 20% remain fully random to avoid local optima. High-impact parameters (above median `impactScore`) get finer-grained step sizes. Progress label shows "Guided Search" instead of "Random Search". **Insights Focus Filter**: "Focus" dropdown on Insights tab lets users generate reports for a specific ticker+timeframe combo (e.g., SOL 2h) or "All Results" for a general cross-market report. Filter info is stored with saved reports and displayed in the saved reports list. Guided Mode prefers a filtered report matching the current run's ticker/timeframe, falling back to the latest report. Empty filter combos show a warning toast.

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
-   **RPC Endpoint**: Configurable via `SOLANA_RPC_URL`, uses Helius as primary with Triton as fallback.
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
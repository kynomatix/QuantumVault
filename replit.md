# QuantumVault - Solana Bot Trading Platform

## ⚠️ ACTIVE MIGRATION: Pacifica Protocol Adapter Architecture

**`PACIFICA_MIGRATION.md` is the SINGLE SOURCE OF TRUTH for all migration work.**

QuantumVault is migrating from Drift Protocol to a protocol-agnostic adapter architecture, with Pacifica.fi as the first adapter. This is the next major change to the application.

**MANDATORY RULES for any migration-related work:**
1. **READ `PACIFICA_MIGRATION.md` FIRST** before writing ANY code that touches: protocol adapters, signing, order execution, subaccounts, symbol mapping, deposit/withdraw flows, market data, position reads, reconciliation, trade-retry, leverage cache, or any file listed in the migration scope.
2. **DO NOT deviate from the plan.** The document has been audited across multiple architect reviews and cross-referenced against Pacifica's official API documentation. Going off-script risks breaking production systems.
3. **Follow the phased approach** (Phases 0→7, including 5b). Do not skip phases or mix work from different phases.
4. **Check the document for the specific interface, type, or endpoint** before implementing. The signing protocol, operation types, endpoint paths, and type definitions are all specified precisely.
5. **If something isn't covered in the doc**, stop and flag it — do not improvise. The doc may need updating before the work proceeds.

**How to navigate the doc:**
- **Phase Navigation Index** (top of Master Progress Tracker): tells you which sections to load for each phase — follow this to avoid reading the full 2,196-line doc
- **Phase markers**: grep for `PHASE_N_START` / `PHASE_N_END` to find any phase instantly (e.g., `grep PHASE_3_START`)
- **Section 17**: AUTHORITATIVE phase checklists with ordering, section cross-references, and verification commands
- **Master Progress Tracker**: summary view for quick scanning — sync with Section 17 periodically
- **Critical Findings section**: VERIFICATION items, not build tasks — check off when phase work addresses them

**Key reference sections:**
- §4: ProtocolAdapter + UserTransactionBuilder interfaces (split by signing model)
- §5: SymbolRegistry design + normalizeMarket consolidation
- §6: Pacifica API endpoints with operation types
- §7: Complete 8-step signing protocol with pitfalls
- §14: File-by-file migration scope (21 server files + startup sequence)
- §15: Database schema changes (additive only)
- §18: Critical execution risks

**Workflow:** When starting a phase, check the Phase Navigation Index for which sections to read. Work through Section 17's phase checklist top-to-bottom. Phase 3 has explicit Group A→B→C ordering — follow it.

**Status:** Phase 1 in progress — building protocol adapter foundation. Testnet verification deferred (will test with real capital later).

### Engineering Standards for Migration Work

**These apply to ALL migration code. This platform holds user capital — code quality is non-negotiable.**

**Architect Review:** After completing each numbered step within a phase (e.g., Phase 1 step 3, Phase 3 Group B step 7), run an architect review before moving to the next step. Do not batch multiple steps and review at the end — review each step individually. The architect should evaluate: correctness against the migration doc spec, error handling completeness, security of key material handling, and adherence to the memory/RPC/rate-limit standards below.

**Memory Efficiency (Critical — Replit-hosted, constrained environment):**
- No unbounded in-memory collections. Every Map, array, or cache MUST have a max size or TTL-based eviction.
- WebSocket event buffers must be bounded — process events inline or use a fixed-size ring buffer, never accumulate indefinitely.
- Market data caches: use TTL (e.g., 60s for prices, 5min for market metadata). Stale entries must be evicted, not just overwritten.
- No `@drift-labs/sdk` patterns — the entire point of this migration is eliminating that memory footprint. The Pacifica adapter must be a thin REST/WS client, not a fat SDK wrapper.
- If a service holds per-bot state in memory (like trade-retry-service), ensure cleanup on bot deletion/deactivation.
- When reviewing: check for `new Map()` or `{}` used as caches without size limits — flag them.

**RPC Cost (Solana on-chain calls — minimize aggressively):**
- After migration, Solana RPC is ONLY needed for deposit/withdraw (on-chain USDC transfers). All market data, positions, orders, balances come from Pacifica REST/WS — zero RPC cost.
- Do NOT add new Solana RPC calls for anything the adapter can provide. If you're tempted to read on-chain state, check if the adapter already has a method for it.
- Batch RPC calls where unavoidable (e.g., `getMultipleAccountsInfo` instead of N × `getAccountInfo`).
- Existing RPC config (Helius primary, Triton backup) remains for the deposit/withdraw path only.

**Pacifica Rate Limit Budget (300 credits / 60s rolling, shared across ALL subaccounts):**
- Every Pacifica REST call costs credits. Heavy GETs (positions, account info) cost more than light ones (prices).
- WebSocket is the primary data path — REST is fallback/reconciliation only. Do not poll REST when WS is healthy.
- Reconciliation loop (60s interval) must be budgeted: N bots × position read cost must fit within the credit budget with headroom for order placement.
- When WS disconnects, REST polling kicks in at 5s intervals — this burns credits fast. Track credit usage and reduce polling frequency if approaching limit.
- 429 responses must trigger exponential backoff, not immediate retry.
- When reviewing: calculate worst-case credit consumption for any new polling loop or batch read pattern.

---

## Overview
QuantumVault is a Solana-based bot trading platform for deploying and managing perpetual futures trading bots. It automates trade execution via TradingView webhooks, provides real-time position tracking, and integrates with Phantom Wallet. The platform aims for a user-friendly experience in automated DeFi trading, leveraging Solana for high-speed, low-cost transactions. Key capabilities include real-time PnL tracking, automated position management, robust error handling, and a marketplace for trading signals to foster a community-driven environment.

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
-   **QuantumLab Child Process**: The lab runs as an isolated forked child process (`server/lab/index.ts`) on port 5050. The main server proxies all `/api/lab/*` requests via `http-proxy-middleware`. Auth is translated from session cookies to trusted `x-lab-wallet`/`x-lab-auth` headers. A supervisor (`server/lab/supervisor.ts`) manages lifecycle: auto-restart with exponential backoff, periodic health checks, graceful shutdown. **Restart circuit breaker**: After 8 consecutive failures within 5 minutes, the supervisor suspends all restarts for 5 minutes to prevent SIGKILL death spirals from exhausting the DB connection pool. After cooldown it attempts a fresh spawn. Health checks also respect this suspension. The lab process has its own smaller DB pool (`DB_POOL_SIZE=2`) vs the main server's default (`DB_POOL_SIZE=15`). Total connections (17) stays within Replit Postgres limits. Pool has `connectionTimeoutMillis=10000` and `idleTimeoutMillis=30000` for fast failure detection. **Checkpoint throttling**: Refine/deep search stages use time-based checkpoint intervals (60s standard / 180s low-TF) matching random search — prevents DB write saturation from fast Phase B compiler. Write coalescing on the routes handler skips stale checkpoints when a newer one arrives before the write completes. **Worker watchdog**: In-process watchdog (30s interval) detects frozen worker threads that stop sending messages but don't exit. If no message for 180s, terminates the worker to trigger normal retry flow. DB-level staleness threshold is 240s (aligned to be well above checkpoint write intervals). SSE heartbeat to browser is 25s. **Background service backoff**: Reconciliation, ProfitShare, and OrphanedCleanup services detect DB timeout errors ("Authentication timed out", "connection timeout", "too many clients") and back off instead of flooding logs. Build produces `dist/lab-server.cjs` alongside `dist/index.cjs`. **Pre-boot Queuing**: When the lab process isn't ready yet, `run-optimization` and `refine` requests are intercepted by the main server (`server/index.ts`) and queued directly into the DB — no 503 error is shown. The lab picks them up via `pumpQueue` once booted. **Queue-first UX**: The frontend never auto-switches to the Results tab on job completion; instead it shows a toast notification. A violet badge on the Queue nav button shows the count of active + queued runs. Server auto-queues on concurrency conflicts instead of returning 409 errors.
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
-   **QuantumLab (Backtesting)**: Hidden at `/quantumlab` (no nav button). Pine Script strategy backtesting and optimization engine with OKX perpetual futures OHLCV data (Gate.io fallback for tickers not on OKX like DRIFT, TNSR, CLOUD, IO, DBR, MNT), random search + refinement optimizer, risk analysis, and strategy library. **Per-User Scoping**: All lab strategies, optimization runs, results, and insights reports are scoped to the connected wallet via `requireLabAuth` middleware. The `userId` column on `lab_strategies` and `lab_optimization_runs` stores the wallet address. Ownership is verified on all CRUD operations (403 on mismatch). A one-time startup backfill assigns unowned records to the default owner. **Engine Fidelity**: Engine faithfully matches Pine Script `strategy.close()` behavior — LazyBear squeeze momentum formula (`close - avg(avg(highest, lowest), sma)`), RMA-based ATR (Wilder's smoothing), SMA-based Keltner Channel, next-bar-open entry fills via pending order system. All exit detection uses `close` price (matching Pine's `close >= tpLevel`, `close <= stopLevel`), all exit fills are next-bar-open via `pendingExit` system (matching `strategy.close()` semantics). Trail tracking uses `close` (not high/low) per Pine's `newTrail = close * (1 - trailPct/100)`. Trail/BE activation distance uses `close - entry` per Pine's `close - _entry >= trailActAtr * entryAtr`. Entry-bar guard (`justEntered`) prevents same-bar exit artifacts. **processOrdersOnClose Deferred Fills**: When `process_orders_on_close=true`, all strategy orders (entry/close/close_all) are queued during bar script execution and filled AFTER the script completes at close price — ensuring `strategy.position_size` stays at pre-order value during execution, matching TradingView's deferred-fill semantics. Fill order: closes → entries → evaluateExits. All SL modes (ATR/Percentage/BB Band/Keltner Band), all TP modes (ATR/Percentage/Risk Multiple), conditional exits (momentum flip/hull flip/re-squeeze/RSI extreme/ADX drop — these still use next-bar-open fills), breakeven stop, trail activation modes, cooldown bars, EMA trend bias, candle body filter, squeeze lookback window, and BB Width percentile alternative compression. **Deep Search**: Optional mode adding 3 additional refinement rounds after the standard pass with wider jitter radii (12% → 8% → 5%) and step-aware perturbation that guarantees minimum 1-step movement on coarse parameters. Uses diversity-aware seed selection (greedy max-min distance) instead of top-K cloning. Staged seeding: R1 uses diverse post-refine results, R2 seeds from best + novel R1 discoveries, R3 includes ~25% fresh exploratory seeds. Parameter deduplication via canonicalized signatures prevents re-testing identical configs (bounded 4-attempt retry). Uses full topK × refinementsPerSeed iterations per round. Works independently of and can combine with Guided Mode. Disabled in Smoke Test. **Pine Parser**: Uses quote-aware character-by-character parsing (not regex) to find closing `)` of `input.xxx(...)` and `strategy(...)` calls — handles parens inside quoted titles/tooltips like `"BB Width Percentile (alt mode)"` without truncating keyword args. Both `parsePineScript` (input extraction) and `injectParamsIntoPineScript` (export) use this approach. Backend at `server/lab/` with APIs at `/api/lab/`. DB tables: `lab_strategies`, `lab_optimization_runs` (with `checkpoint` JSONB column), `lab_optimization_results`, `lab_candle_cache` (persistent OHLCV cache). Max 1 concurrent optimization job. Styled to match Docs page (violet/slate theme with sidebar navigation). **Worker Thread Isolation**: The optimizer runs in a Node.js Worker Thread (`server/lab/optimizer-worker.ts`) to prevent CPU-intensive backtesting from starving the Express event loop, DB connections, and trading operations. Candle data is fetched on the main thread and passed to the worker via `workerData`. All DB operations (checkpoints, results) happen on the main thread via worker messages. In dev mode, the worker is spawned via `eval` with `tsx/cjs`; in production, it's a separate esbuild bundle (`dist/optimizer-worker.cjs`). **Checkpoint/Resume**: Time-based checkpoints every 60s (not iteration-based) to minimize DB contention. Partial results saved to `lab_optimization_results` table. Checkpoint JSONB is lightweight (iteration counters only). `cleanupStaleRuns` checks both checkpoint JSONB and results table — runs with persisted results are marked "paused" not "failed". Frontend detects dead jobs after 5 failed SSE reconnects. **Candle Cache**: OHLCV data cached in PostgreSQL (`lab_candle_cache` table). Cache management via `GET /api/lab/cache/stats` and `DELETE /api/lab/cache`. **Strategy Insights**: 4th tab in QuantumLab for statistical analysis across all optimization runs for a strategy. Analysis engine in `client/src/lib/strategy-insights.ts` produces parameter sensitivity, ticker/timeframe fit, directional bias, trade patterns, and actionable recommendations. Backend endpoint `GET /api/lab/strategies/:id/all-results` aggregates all results across runs. "Copy Report" button formats the report as Claude-friendly text for strategy improvement suggestions. **Saved Insights Reports**: Reports auto-save to `lab_insights_reports` table on generation. Users can load past reports from a collapsible list. **Guided Mode Optimizer**: Optional "Use Insights" toggle in Advanced Settings (off by default). When enabled, reads the latest saved insights report. **Perturbation mode** (preferred): When topConfigs are available from insights, picks a random seed from top 10 configs and applies step-aware gaussian perturbation with minimum 1-step movement — high-impact params get 18% stddev, medium 25%, low 35% of param range. Booleans flip 35% of the time, strings change 35% of the time. Falls back to **bucket mode** (legacy) when no topConfigs: narrows to best-performing quartile buckets from paramSensitivity. Dynamic guided ratio: 50-70% guided (increasing with progress), remainder fully random. Progress label shows "Perturbation Search" / "Guided Search" / "Random Search" accordingly. **Insights Focus Filter**: "Focus" dropdown on Insights tab lets users generate reports for a specific ticker+timeframe combo (e.g., SOL 2h) or "All Results" for a general cross-market report. Filter info is stored with saved reports and displayed in the saved reports list. Guided Mode prefers a filtered report matching the current run's ticker/timeframe, falling back to the latest report. Empty filter combos show a warning toast.

-   **Dynamic Non-Tradable Market Detection & Leverage Tiers**: The leverage cache service (`server/leverage-cache-service.ts`) reads on-chain `PerpMarket` account status via Drift SDK's Borsh decoder every 12 hours. Markets with status `reduceOnly`, `delisted`, or `settlement` are flagged as non-tradable and excluded from `/api/drift/markets`. Max leverage values use a known `DRIFT_LEVERAGE_TIERS` map (matching Drift UI: SOL/BTC/ETH=101x, XRP=20x, most=10x, smaller=5x, KMNO=3x) with on-chain `marginRatioInitial` fallback for unknown markets. A callback invalidates the market cache when the leverage cache refreshes, ensuring the market list always reflects current on-chain state. Bot creation is blocked server-side (`POST /api/trading-bots` rejects with 400 via `isMarketNonTradable()`). The `/api/drift/non-tradable-markets` endpoint exposes the non-tradable list for the frontend. QuantumLab dynamically fetches this list to filter ticker buttons from the config panel (no hardcoded reduce-only list).
-   **Pine Script User Functions & Vectorized Precomputation**: The interpreter supports user-defined functions (e.g., `f_hma`, `f_adx` in Flux Momentum) with **full vectorized precomputation** — user function bodies are executed once as full-series operations during the precompute phase instead of per-bar. This transforms O(n²) complexity into O(n) for chained TA calls inside functions. `tryPrecomputeUserFunc` handles single-return functions, `tryPrecomputeUserFuncMulti` handles tuple-returning functions (like `f_adx` returning `[adx, plusDI, minusDI]`). The `tryGetSeries` function resolves binary expressions, ternary conditionals, math calls, and TA calls inline for full series evaluation. `ta.tr` member expressions are handled directly in both `getSrc` and precompute paths. Incremental TA functions remain as fallback for truly dynamic sources. **`evalSrcFallback`** handles complex expression sources (like `math.abs(x-y)/(z==0?1:z)`) that `getSrc` can't resolve as a full series — it evaluates the expression per-bar, stores in a synthetic var, and routes through incremental TA computation. **Member subscript evaluation** (e.g., `strategy.position_size[1]`) evaluates the member expression at a prior bar instead of returning NA. Performance: Flux Momentum optimization went from 7+ hours to ~13ms per combo (~750x speedup). **Deep Precomputation Cascade (March 2026)**: Expanded `resolveConst()` to fold boolean logic (`not`, `and`, `or`), string comparisons (`==`, `!=`), const `math.*` calls, and const ternaries. Expanded `tryGetSeries()` to lift boolean defaults to series and resolve const-fallback expressions. Added `ta.change`, `ta.crossover`, `ta.crossunder`, `ta.cross` to precompute. Increased precompute passes from 4 to `min(ast.length, 32)` for deep cascades. Added `nz()` handling in both precompute and series resolution. BB Trend Trader went from 7,124ms to ~530ms per backtest (13.4x speedup), projecting 3,800-config optimization from 7.5 hours to ~34 minutes.
-   **Pine Script Compiler (ACTIVE — Phase B complete)**: The Pine-to-JavaScript compiler (`server/lab/pine/compiler.ts`) is fully integrated with `runtime.ts`. The compiled path is automatically used when compilation succeeds, with interpreter fallback. Key optimizations: (1) Bar function body inlined directly into hot loop — builtins access local arrays (`_closeArr[_bar]` instead of `ctx.builtinSeries["close"][ctx.bar]`), `ctx.bar` replaced with local `_bar`, `ctx.vars`/`ctx.pc` pre-bound as locals. (2) Incremental dynamic TA functions (`taDynRma/Ema/Sma/Wma/Highest/Lowest/Barssince/Stdev/Percentrank/Linreg`) bypass full-series recomputation. (3) Slot-based TA caching (`taSlotRead`) — static-source TAs compute once, read O(1) per bar. (4) Local variable expansion — non-var, non-history-accessed declarations (including reassigned) use JS local variables instead of series storage. **Benchmark results (4h SOL, 6936 bars)**: Strategy 1 (Flux Momentum): 20-30x speedup (4000ms→130-200ms). Strategy 5 (Adaptive Regime): 1.5-1.7x. Strategy 6 (BB Trend Trader): 1.4-2.1x. All 4 strategies × 2 param sets pass parity tests (`test-parity.ts`).
-   **Pine Script Interpreter Parity**: The Pine Script interpreter achieves **100% trade-entry parity** with TradingView for the MW Reversal v2 strategy (Run #68: 35/35 entries matched). Key fixes: `na()` function call handling before id-check, and pivot detection using TradingView's semantics (allow equal values on left side, strict on right side for `pivothigh`/`pivotlow`). TV Excel timestamps are in NZ local time (UTC+12/13); QV uses UTC — a 14h match window accounts for the timezone offset. Net profit: QV 171.22% vs TV 173.12% (~2% exit-level rounding diff). **strategy.exit() Cumulative Allocation (TV Parity)**: Multiple `strategy.exit()` calls from the same entry now respect TradingView's code-order cumulative allocation semantics. Each exit's effective qty is `min(exit.qty_percent, remaining_unallocated_pct)` computed in registration (code) order. When TP1 has `qty_percent=100`, it claims the entire position — TP2 and TP3 are deactivated (0% effective qty, stops/limits not evaluated). This fixed SBR v1 where QV was exiting at TP3's closer limit (8.5×ATR) instead of TP1's intended level (9.9×ATR), causing +708% vs TV's +130% for the same parameters.
-   **Dual Optimizer Engine Architecture**: QuantumLab has TWO separate backtest execution engines that coexist:
    1. **Native Engine** (`server/lab/engine.ts`): Hand-written, purpose-built TypeScript for a specific strategy. All indicators are pre-computed upfront as typed arrays, then the trading loop reads from those arrays with zero parsing or interpretation overhead. Extremely fast (~2 min for full optimization). Currently only exists for **Flux Momentum (Strategy 1)**. To route a strategy through the native engine, set `"nativeEngine": true` in its `strategy_settings` JSON column in the `lab_strategies` table. When this flag is set, `pineScript` is stripped from the optimizer config in ALL 6 code paths (direct run, queue pump, auto-retry, resume, lazy recovery, refine) so the worker falls through to the native engine branch in `runBacktest()`.
    2. **Pine Engine** (`server/lab/pine/`): A generalized engine that accepts any Pine Script text, parses it into an AST, compiles it to JavaScript on the fly, and runs it bar-by-bar. Works with any strategy but is inherently slower due to the generalized parsing/compilation/interpretation overhead. Used by all strategies that don't have `nativeEngine: true`. The Pine engine includes a compiler (`compiler.ts`) for optimized execution and an interpreter (`runtime.ts`) as fallback.
    
    **When to add a strategy to the native engine**: If a strategy is run very frequently for optimizations and the Pine engine speed is a bottleneck, a native TypeScript implementation can be written for it and the `nativeEngine` flag set. This requires hand-translating the Pine Script logic into TypeScript and maintaining both versions — only worth doing for stable, high-volume strategies.
    
    **Pine Engine maturity**: The Pine engine is actively evolving. New strategies may use Pine Script features or indicator combinations not yet fully supported, which can cause result divergence from TradingView. This is expected and requires ongoing maintenance as new strategy patterns are encountered. Parity testing (`test-parity.ts`, `test-sbr-compare.ts`) validates accuracy against known reference results.
    
    **Production strategy IDs may differ from development.** Always verify strategy IDs in production before applying `nativeEngine` flags. A startup migration in `registerLabRoutes()` ensures Strategy 1 gets `nativeEngine: true` on boot.

-   **Optimizer Memory Optimization (Lite Search + Combo Chunking)**: The optimizer worker uses a two-tier result pipeline to prevent OOM crashes. During search phases (random/refine/deep/coordinate), only scalar metrics are kept in memory (`LiteBacktestResult`: net profit, win rate, drawdown, profit factor, total trades, avgBarsHeld, params — NO equity curves, NO trade arrays). After each combo's search completes, only the top 10 finalist parameter sets are re-run with full detail to produce equity curves and trade lists for DB storage and UI display. This eliminates ~60-85% of peak memory usage. Additionally, combo candle data is released (`delete candlesByCombo[key]`) and indicator caches cleared between combos, capping peak memory at 1 combo's data instead of all combos. The `meetsFiltersLite` function pre-computes `avgBarsHeld` as a scalar before discarding trade arrays, preserving the `minAvgBarsHeld` filter. The `toLiteResult` helper safely handles both full and already-lite inputs for checkpoint resume compatibility.
-   **Low-Timeframe DB Optimization**: Timeframes ≤30m (1m, 3m, 5m, 15m, 30m) get special treatment to prevent DB connection pool starvation. `isLowTimeframe()` uses unit-aware parsing (e.g. `"15m"` = low, `"1h"` = not low). Changes: (1) Checkpoint intervals increased to 30s first / 3min thereafter (vs 10s/60s for ≥1h), reducing DB write frequency by ~3x. (2) Partial checkpoint result count reduced to 5 (vs 10). (3) Progress reports sent every 25 iterations (vs 10). (4) Final results trimmed via `trimResult()`: trades capped at last 200 (vs 500 for high TF), equity curve downsampled to exactly 500 points (vs 1000). Trimming uses deterministic index sampling with guaranteed first/last point inclusion. This prevents the combo-complete → saveComboResults transaction from inserting multi-MB JSON blobs that exhaust the lab's DB_POOL_SIZE=5 pool.
-   **Queue Reliability**: The run queue has a 30-second watchdog timer that detects stalled queued runs (no active worker, no running/paused blockers) and auto-pumps. All worker error/exit code paths now call `pumpQueue()` to prevent orphaned queued runs. A `/api/lab/queue/kick` endpoint and "Unstick" button in the queue drawer provide manual recovery. The resume endpoint accepts `queued` runs (kicks the pump) instead of rejecting them.
-   **Coordinate Tuning (Refine Mode)**: When a user clicks Refine on a result, the backend runs coordinate tuning instead of the previous perturbation + deep search approach. Coordinate tuning takes the best known result (from prior insights/topConfigs) and systematically varies each optimizable parameter individually while holding others fixed, testing a grid of values across each parameter's range with finer resolution near the current best value. After all single-parameter sweeps, it identifies the top 2-3 highest-impact parameters (by improvement magnitude) and does pairwise grid search over those pairs. Handles bool params (both values) and string params (all options). Includes checkpoint/resume support via `coordinateCompleted` field tracking which parameters have been swept. Config flag: `coordinateTune: true` on `LabOptimizationConfig`. Implementation in `server/lab/optimizer-worker.ts` (`coordinateTune()`, `generateParamGrid()`, `evenSample()`). The normal optimization flow (Random → Refine → Deep Search) remains completely unchanged for standard runs.

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
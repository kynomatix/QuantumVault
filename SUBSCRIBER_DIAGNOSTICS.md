# Subscriber (Copy Trade) Diagnostics

## Overview
This document tracks the subscriber/copy trade execution system in QuantumVault. It covers architecture decisions, known issues, and historical changes for ongoing debugging and development.

## Current Architecture (Feb 2026)

### How Subscriber Routing Works
1. A **source bot** receives a TradingView webhook signal and executes its trade
2. After source trade succeeds, `routeSignalToSubscribers()` is called
3. The function finds all active subscriber bots for that source
4. Subscriber trades are executed **sequentially with a 2-second stagger** between each trade
5. Each subscriber trade goes through the same `executePerpOrder()` / `closePerpPosition()` path as source trades
6. Failed trades are auto-retried via the `TradeRetryService`

### Execution Path
- **Swift-first**: All trades attempt Swift Protocol (gasless, MM-auction fills) before falling back to legacy `placeAndTakePerpOrder`
- **Swift minimum**: $25 notional (configurable via `SWIFT_MIN_NOTIONAL` env var). Trades below this always use legacy
- **Legacy path**: In-process DriftClient → subprocess fallback (20-second timeout)

### Key Files
- `server/routes.ts` — `routeSignalToSubscribers()` function (subscriber routing logic)
- `server/drift-service.ts` — `executePerpOrder()`, `closePerpPosition()` (trade execution)
- `server/swift-executor.ts` — Swift Protocol execution
- `server/trade-retry-service.ts` — Auto-retry for failed trades
- `server/position-service.ts` — On-chain position verification

---

## Historical Changes

### Feb 15, 2026 — Switched from Parallel to Sequential Execution
**Problem**: All subscriber trades fired simultaneously via `Promise.all`, causing RPC contention. Source trades (BUH wallet) ran at 100% success rate while copy trades (F7H3/6ULL wallets) dropped to 50-65% success rate.

**Root cause**: When multiple subscriber bots receive the same signal, `Promise.all` fired 3-5 trade executions at once. These competed with the source bot's post-trade sync AND with each other for RPC bandwidth. The 20-second subprocess timeout was insufficient under this load, causing cascading `TIMEOUT_SUBPROCESS` errors.

**Evidence from production (12h window)**:
- Source bots (BUH wallet): 21/21 trades succeeded (100%)
- Copy bots (F7H3 + 6ULL): 9 executed, 6 recovered, 8 failed (65% success)
- Copy bots using Swift: mostly succeeded (SUI, PENGU)
- Copy bots forced to legacy: mostly failed (FARTCOIN below $25 minimum, RENDER on 6ULL)

**Fix**: Replaced `Promise.all(subscriberBots.map(...))` with a sequential `for` loop with 2-second stagger delay between each subscriber trade. This prevents RPC contention while keeping execution fast enough for trading.

**Trade-off**: With 5 subscribers, total routing takes ~8s (vs ~20s+ with parallel due to timeouts). Sequential execution is actually faster in practice because it avoids the timeout/retry cascade.

### Earlier (Date Unknown) — Queue System Removed
**What existed**: A queue-based execution system was previously implemented for subscriber trade routing.

**Why it was removed**: The queue system was wrapped in a container/abstraction that caused straight-up trade failures. The container/wrapper layer introduced additional failure points rather than solving the concurrency issue. Trades were failing outright instead of just being slow.

**Result**: After removing the queue system, subscriber trades were executed in parallel via `Promise.all`. This was faster when RPC capacity was available, but caused the contention issues described above.

---

## Known Issues & Limitations

### 1. FARTCOIN Copy Trades — Always Legacy
FARTCOIN position sizes (~$18 notional) are below the $25 Swift minimum. These trades always fall back to legacy subprocess execution, making them more vulnerable to RPC contention and timeouts. Options:
- Lower `SWIFT_MIN_NOTIONAL` (risk: Swift may reject very small orders)
- Increase FARTCOIN position size above $25
- Accept legacy-only execution for this market

### 2. Retry Expiration on Stale Signals
Copy trade retries can run for 79-474 minutes before expiring. By the time they succeed, the market has moved significantly. The `MAX_AUTO_RETRY_DURATION_MS` (default ~80 min) may need tuning for copy trades where signal freshness matters more.

### 3. Recovered Trades — PnL Backfill
Recovered close trades (trades that timed out but were found on-chain) previously had null PnL. A startup backfill function `backfillRecoveredClosePnl()` now runs on server start to fix missing PnL for recovered close trades.

### 4. Profit Sharing Dust Threshold
Creator profit sharing (1%) requires at least $0.01 profit to trigger. Very small positions may never generate enough profit to reach this threshold.

---

## Monitoring & Debugging

### Quick Production Checks
```sql
-- Last 12h trade success by wallet
SELECT wallet_address, status, COUNT(*) 
FROM bot_trades 
WHERE executed_at > NOW() - INTERVAL '12 hours'
GROUP BY wallet_address, status 
ORDER BY wallet_address, status;

-- Failed trades with errors
SELECT id, trading_bot_id, wallet_address, market, side, status, error_message, execution_method, executed_at
FROM bot_trades 
WHERE status IN ('failed', 'recovered') 
AND executed_at > NOW() - INTERVAL '12 hours'
ORDER BY executed_at DESC;

-- Retry queue status
SELECT status, COUNT(*) FROM trade_retry_queue GROUP BY status;
```

### Key Log Patterns
- `[Subscriber Routing] Processing N subscribers SEQUENTIALLY` — Sequential routing started
- `[Subscriber Routing] Stagger delay` — Inter-subscriber delay
- `[Subscriber Routing] SUMMARY` — Final routing result with timing
- `TIMEOUT_SUBPROCESS` — Legacy subprocess timed out (20s limit)
- `swift-auction-fill` — Swift execution succeeded (gasless)
- `Auto-retry expired` — Retry gave up after max duration

# QuantumVault Optimization Notes

## Overview
This document tracks code optimizations, refactoring decisions, and cleanup items for future reference.

---

## Bot Management Drawer RPC Optimization

**Date:** January 2025  
**Status:** Complete

### Problem
When the Bot Management Drawer opens, it makes 6 frontend API calls resulting in 7-8 Solana RPC calls:

| Endpoint | RPC Calls | Data Retrieved |
|----------|-----------|----------------|
| `/api/bot/:id/balance` | 2 | usdcBalance, estimatedDailyInterest, realizedPnl, fees |
| `/api/agent/balance` | 3 | mainAccountBalance, solBalance, driftAccountExists |
| `/api/bots/:id/drift-balance` | 1 | totalCollateral, freeCollateral, hasOpenPositions |
| `/api/bots/:id/net-deposited` | 0-1 | netDeposited (DB + optional reconciliation RPC) |
| `/api/trading-bots/:id/position` | 1 | position data, health metrics |
| `/api/user/webhook-url` | 0 | webhookUrl (DB only) |

**Issues identified:**
- Multiple endpoints query the same Drift subaccount
- `subaccountExists` called multiple times for same account
- Agent balance fetched but only `mainAccountBalance` used in drawer

### Solution
Created consolidated endpoint `/api/bots/:id/overview` that:
1. Uses single `getDriftAccountInfo` call for all balance data
2. Combines position service data
3. Batches DB queries
4. Reduces RPC calls from 7-8 to 2-3

### Data Required by Drawer

| Field | Source | Used For |
|-------|--------|----------|
| `driftBalance` (totalCollateral) | Drift account | Bot Equity display, P&L calc |
| `freeCollateral` | Drift account | Withdrawal limit validation |
| `hasOpenPositions` | Drift account | Margin lock warning |
| `netDeposited` | Database | P&L calculation |
| `interestEarned` | Calculated (APY * balance) | Interest display |
| `mainAccountBalance` | Agent USDC balance | "Max" button for Add Equity |
| `usdcBalance` | Drift account | Max position validation |
| `position.*` | PositionService | Position card display |
| `webhookUrl` | Database | Webhook tab |

---

## Endpoints to Review for Cleanup

### Potentially Redundant After Optimization

| Endpoint | Notes | Can Remove? |
|----------|-------|-------------|
| `/api/bot/:id/balance` | Overlaps with `/api/bots/:id/overview` | Keep for now - used elsewhere? |
| `/api/bots/:id/drift-balance` | Overlaps with overview | Check other usages first |
| `/api/bots/:id/net-deposited` | Overlaps with overview | Check other usages first |

### Before Removing Any Endpoint
1. Search codebase for all usages: `grep -r "endpoint-path" client/ server/`
2. Check if used by other components (not just drawer)
3. Test thoroughly after removal

---

## Other Optimization Opportunities (Future)

### RPC Call Reduction
- [ ] Cache `getDriftAccountInfo` results for 5-10 seconds
- [ ] Use `getMultipleAccountsInfo` when querying multiple accounts
- [ ] Lazy load webhook URL (only when webhook tab is opened)

### Database Query Optimization  
- [ ] Add indexes for frequently queried columns
- [ ] Consider caching equity events aggregations

### Frontend Optimizations
- [ ] Reduce drawer re-renders with proper memoization
- [ ] Lazy load trade history (only when history tab opened)

---

## Migration/Cleanup Checklist

When ready to clean up old endpoints:

- [ ] Verify new `/api/bots/:id/overview` is stable in production
- [ ] Search for all usages of old endpoints
- [ ] Remove unused endpoints one at a time
- [ ] Test after each removal
- [ ] Update this document with removal dates

---

## Implementation Status

### Completed
- [x] Created `/api/bots/:id/overview` endpoint in `server/routes.ts`
- [x] Updated `BotManagementDrawer.tsx` with new `fetchBotOverview()` function
- [x] All drawer open/refresh/action callbacks now use consolidated endpoint
- [x] Legacy fetch functions kept for backwards compatibility
- [x] Added Promise.allSettled for graceful degradation on RPC failures
- [x] Added `partialData` flag to response for UI awareness of data completeness
- [x] Added "Partial data" indicator with tooltip in drawer UI

### RPC Call Reduction Achieved
| Before | After |
|--------|-------|
| 6 frontend API calls | 1 frontend API call |
| 7-8 Solana RPC calls | 2-3 Solana RPC calls |

### Legacy Functions Still Present (for cleanup later)
In `BotManagementDrawer.tsx`:
- `fetchBotBalance()` - kept but unused by main flow
- `fetchBotPosition()` - kept but unused by main flow  
- `fetchUserWebhookUrl()` - kept but unused by main flow

---

## Post-Trade Deferred Processing (Feb 6 2026)

**Date:** February 2026  
**Status:** Complete

### Problem
After a successful trade execution (via webhook), the webhook handler performed 4-5 additional RPC-heavy operations **before** returning the HTTP response. This:
- Added 3-8 seconds latency to webhook responses
- Consumed RPC quota on non-critical operations
- Created timeout risk when combined with trade execution RPC calls
- Made subscriber routing block the source bot's webhook response

### Previous Post-Trade Flow (all blocking/awaited)
| Operation | RPC Calls | Purpose | Critical? |
|-----------|-----------|---------|-----------|
| `updateBotTrade()` | 0 (DB) | Record trade result | YES |
| `syncPositionFromOnChain()` | 1 | Update DB position cache | NO - drawer refresh does this |
| `updateTradingBotStats()` | 0 (DB) | Update win/loss/PnL stats | NO - depends on sync result |
| `routeSignalToSubscribers()` | N (subprocess per subscriber) | Copy trading | NO - can run async |
| `settleAllPnl()` | 1 | Convert PnL to USDC | NO (except flip close) |
| `distributeCreatorProfitShare()` | 1-2 | Pay creator | Already async |
| `updateWebhookLog()` | 0 (DB) | Mark webhook processed | YES |
| `sendTradeNotification()` | 0 (HTTP) | Telegram notification | Already async |

### Solution: Fire-and-Forget Post-Trade
Moved non-critical operations to fire-and-forget async blocks. Webhook response returns immediately after critical DB writes.

**Kept blocking (critical path):**
1. `storage.updateBotTrade()` - Must persist trade result
2. `storage.updateWebhookLog()` - Must mark signal as processed (dedup)

**Deferred (fire-and-forget with error logging):**
1. `syncPositionFromOnChain()` - Position data refreshes on drawer open
2. `storage.updateTradingBotStats()` - Stats update with PnL from sync result
3. `routeSignalToSubscribers()` - Copy trading runs independently
4. `settleAllPnl()` - PnL settlement (except during position flip)
5. `distributeCreatorProfitShare()` - Already was async, moved into deferred block
6. Auto-withdraw logic - Runs after PnL settlement

**Exception: FLIP close path**
When profitReinvest is enabled and a position flip occurs (CLOSE then OPEN), `settleAllPnl()` stays blocking between the close and open. This ensures realized profits are available as margin for the new position.

### Applied to All 3 Webhook Paths
1. **OPEN trade** - sync, stats, routing, notification deferred
2. **CLOSE trade** - sync, stats, routing, profit share, settle, auto-withdraw deferred
3. **FLIP trade** - close sync/stats deferred; settleAllPnl kept blocking; open sync/stats/routing deferred

### RPC Budget Impact
| Before (blocking) | After (deferred) |
|-------------------|------------------|
| Trade execution + 2-3 RPC calls in critical path | Trade execution only in critical path |
| Webhook response: 5-15s | Webhook response: 2-5s |
| Subscriber routing blocks response | Subscriber routing runs independently |

---

## Trade Execution RPC Optimization (Feb 6 2026)

**Date:** February 2026  
**Status:** Complete

### Problem
Each trade execution (subprocess) made ~12 RPC calls, creating rate limit risk on Helius Dev tier (50 calls/sec).

### Optimizations Applied
| Optimization | RPC Calls Saved | Details |
|-------------|----------------|---------|
| Referrer caching | 2-3 per trade | Static per wallet, cached in-memory `Map` |
| Connection reuse | 1 per trade | Use `driftClient.connection` instead of new `Connection` |
| Skip `fetchAccounts()` | 1-2 per trade | Use oracle price (loaded during subscribe) as fill estimate |
| Health check caching | 0-1 per trade | Skip `getSlot()` if RPC verified healthy within 30s |
| Dynamic CLOSE timeout | N/A | 30s for CLOSE (was 20s), keeps 20s for OPEN |
| Subprocess staggering | Prevents burst | 2s delay between concurrent subprocess spawns |

### RPC Calls Per Trade
| Before | After |
|--------|-------|
| ~12 calls | ~5-6 calls |

### Error Capture Improvements
- Subprocess returns `{success: false}` with empty error: last 3 stderr lines extracted as fallback
- Empty stdout: last 3 stderr lines used instead of raw dump
- Eliminates "Unknown error" diagnostic blind spots

### Retry TTL for CLOSE Orders
- Reduced from 1 hour to 5 minutes
- Stale close retries are useless after market moves
- Fixed bug: `dbJob.action` (non-existent field) corrected to `dbJob.side`

### Files Changed
- `server/drift-executor.mjs` - Referrer cache, connection reuse, oracle price fill
- `server/drift-service.ts` - Error capture, dynamic timeout, subprocess stagger
- `server/trade-retry-service.ts` - CLOSE TTL reduction, field name fix

---

## Change Log

| Date | Change | Files Modified |
|------|--------|----------------|
| Jan 2025 | Created `/api/bots/:id/overview` endpoint | `server/routes.ts` |
| Jan 2025 | Updated BotManagementDrawer to use new endpoint | `client/src/components/BotManagementDrawer.tsx` |
| Jan 2025 | Replaced all individual fetch calls with fetchBotOverview() | `client/src/components/BotManagementDrawer.tsx` |
| Jan 2025 | Added Promise.allSettled for graceful degradation | `server/routes.ts` |
| Jan 2025 | Added partialData flag and UI indicator | `server/routes.ts`, `client/src/components/BotManagementDrawer.tsx` |
| Feb 2026 | Deferred post-trade processing (sync, stats, routing) to fire-and-forget | `server/routes.ts` |
| Feb 2026 | RPC optimization: referrer cache, connection reuse, oracle fill, health cache | `server/drift-executor.mjs`, `server/drift-service.ts` |
| Feb 2026 | Error capture improvements: stderr fallback, CLOSE timeout/TTL | `server/drift-service.ts`, `server/trade-retry-service.ts` |
| Feb 2026 | Subprocess staggering: 2s delay between concurrent spawns | `server/drift-service.ts` |

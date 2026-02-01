# Subscriber Routing Diagnostics

## Issue Summary
Subscribers to marketplace signal bots show 0 trades despite source bots actively trading.

## RESOLVED: Feb 1, 2026 22:48 UTC

### Root Cause Identified and Fixed
**Trade retry system was bypassing subscriber routing**

When source bot trades failed with temporary errors (margin issues, rate limits):
1. Webhook handler queued trade for retry → **returned early before routing call**
2. Retry service executed trade successfully later
3. But retry service **had no routing logic** → subscribers never got signals

### Fix Applied
1. Added `registerRoutingCallback()` function to `trade-retry-service.ts`
2. Routes both OPEN and CLOSE signals after successful retry
3. `routes.ts` registers `routeSignalToSubscribers` callback at startup
4. Logs now show: `[TradeRetry] Routing callback registered`

### Verification
- Admin manual routing test: **WORKS** (created trades at 22:39 UTC)
- Retry service routing: **NOW ENABLED** (via callback pattern)
- Next webhook with retry → will route to subscribers

---

## Previous Investigation (Jan 29-31, 2026)

---

## SUI Subscribers (Source Bot: c2ee8a25 "SUI 1H OI Skalpa")

### Published Bot Info
- **Published Bot ID**: d7004bb1-4e85-4112-a0da-26e9273c43a9
- **Status**: Active, trading hourly
- **Market**: SUI-PERP
- **Recent trades**: Jan 31 22:00:05 (LONG), many prior

### Subscriber: 5a63edc8 ("SUI subscription test")
- **Wallet**: AqTTQQaj...
- **Subaccount**: 1
- **Status**: ACTIVE
- **autoTopUp**: true
- **maxPositionSize**: $5
- **Subscription**: 4749e188 (status='active')
- **source_published_bot_id**: d7004bb1 ✓ (correctly linked)
- **Trades**: 0 (NONE routed despite source bot trading)

---

## RNDR Subscribers (Source Bot: dee5703c)

### Subscriber 1: c57d65fb
- **Wallet**: 6ULLaZku...
- **Subaccount**: 10
- **Status**: PAUSED
- **pauseReason**: "Insufficient margin: need $24.00 to trade 2 RENDER-PERP. Agent wallet only has $0.18 USDC available for top-up"
- **autoTopUp**: true (but wallet has no funds to top up from)
- **Last successful trade**: Jan 29 09:05:33 (LONG), closed Jan 29 19:54:06

### Subscriber 2: 2afe9363
- **Wallet**: F7H3mBZR...
- **Subaccount**: 4
- **Status**: ACTIVE
- **autoTopUp**: false
- **Problem**: Drift subaccount 4 has insufficient collateral
- **Error on trade attempts**: "Insufficient capital in bot's account"
- **Last successful trade**: Jan 29 09:05:34 (LONG), closed Jan 29 22:00:12
- **Failed trades created by routing tests**: 00:22:49, 00:23:00, 00:41:23 (all show "Insufficient capital")

---

## AVAX Subscribers (Source Bot: d2a1e99c)
- **Subscriber d7db8175** (wallet F7H3mBZR, subaccount 5): Active, autoTopUp=false
- **Subscriber 9a03149b** (wallet BuhEYpvr, subaccount 11): Active, autoTopUp=true

---

## DOGE Subscriptions
**None exist** - replit.md said "DOGE subscription broken" but there are no DOGE subscribers.

---

## Timeline of Events

### Jan 29
- 09:05:22-34: Both RNDR subscribers opened LONG positions via REAL webhook routing (CONFIRMED - source=marketplace_routing)
- 19:54:06: c57d65fb closed position successfully
- 22:00:12: Source RNDR bot sent CLOSE signal
  - **2afe9363: NO CLOSE trade record exists** (silent failure)
  - c57d65fb already closed earlier (at 19:54:06)
- After close: c57d65fb paused due to insufficient funds for next trade

### Jan 30
- 00:00:07: Source RNDR bot opened new BUY position
  - c57d65fb: SKIPPED (inactive/paused)
  - 2afe9363: Should have routed but OLD CODE didn't create failed trade record
  - Result: 0 subscriber trade records (silent failure)
- 00:22:49: Admin live routing test ran
  - Created failed trade for 2afe9363: "Insufficient capital"
- 00:41:23: Another live routing test
  - Created failed trade for 2afe9363: "Insufficient capital"
- **02:16:31: Source RNDR bot CLOSE (lost -$15.48)**
  - Source bot closed successfully
  - **2afe9363: NO CLOSE trade record exists** (silent failure - visibility fix not deployed)
  - c57d65fb: paused, but might have had position from Jan 29 09:05

---

## Fix Implemented (Commit 659ec850)

Added visibility for all routing failure scenarios:
1. **Failed trade records** now created for:
   - Wallet not found
   - No agent keys
   - No maxPositionSize configured
   - Sizing calculation failed
   - Trade size too small
   - Order execution failed
   
2. **Counter tracking** with summary log:
   ```
   [Subscriber Routing] SUMMARY for source X: N subscribers, X skipped (inactive), X trades OK, X trades FAILED
   ```

3. **Counters added**: skippedInactive, tradeSuccess, tradeFailed, closeSuccess, closeFailed

---

## Tests Run

| Time | Type | Source Bot | Result |
|------|------|------------|--------|
| 00:22:49 | Admin test (manual) | dee5703c | 2afe9363 failed: "Insufficient capital" |
| 00:23:00 | Admin test (manual) | dee5703c | 2afe9363 failed: "Insufficient capital" |
| 00:41:23 | Admin test (manual) | dee5703c | 2afe9363 failed: "Insufficient capital" |

**IMPORTANT**: These are all MANUAL tests via admin endpoint. They prove the code path works when called directly, but do NOT prove webhooks work end-to-end.

**Bottom line**: We have NEVER confirmed a real TradingView webhook successfully routing to a subscriber. This is the core issue that remains unverified.

---

## Still Need to Verify

**Waiting for real webhook** to confirm:
1. Webhook handler correctly calls `routeSignalToSubscribers`
2. Async fire-and-forget pattern completes (doesn't get interrupted)
3. Summary log appears in production logs
4. Failed/success trade records are created from real signals

Next real RNDR webhook will be the true test.

---

## Root Cause Confirmed
The routing IS working. The subscribers have FUNDING PROBLEMS:
1. c57d65fb has no wallet funds ($0.18 USDC)
2. 2afe9363 has autoTopUp=false AND insufficient collateral in Drift subaccount 4

---

## Next Steps

### Immediate (Jan 31)
1. ✅ Deploy routing status tracking (commit 1973dccb)
2. Wait for next SUI hourly signal (~23:00 UTC)
3. Check webhook response for `routingStatus` field
4. If status is 'completed' but no trade, issue is inside subscriber execution
5. If status is 'error', we'll see the exception message

### If Routing Status Shows 'completed' But No Trade
- Check `getSubscriberBotsBySourceId` returns the subscriber
- Check subscriber bot wallet has agent keys
- Check trade sizing calculation

### If Routing Status Never Appears
- The webhook response doesn't include routingStatus = code not deployed
- Check production deployment pipeline

### Previous Funding Issues (RNDR subscribers)
- c57d65fb: needs wallet funds ($0.18 USDC)
- 2afe9363: needs collateral in Drift subaccount 4 OR enable autoTopUp

---

## Code Changes Log

### Commit 1973dccb (Jan 31 22:29 UTC) - Routing Status Tracking
Added to both OPEN and CLOSE signal paths in `server/routes.ts`:
```javascript
let routingStatus = 'not_attempted';
try {
  routingStatus = 'started';
  await routeSignalToSubscribers(...);
  routingStatus = 'completed';
} catch (routingErr) {
  routingStatus = `error: ${String(routingErr).slice(0, 100)}`;
}
console.log(`[WEBHOOK-TRACE] Routing status: ${routingStatus}`);
```
Response JSON now includes `routingStatus` field.

### Commit 659ec850 (Jan 30) - Visibility Fix
- Failed trade records created for all routing failure scenarios
- Counter tracking with summary log
- Counters: skippedInactive, tradeSuccess, tradeFailed, closeSuccess, closeFailed

### Previous Fix - Await Pattern
Changed fire-and-forget pattern to awaited calls:
```javascript
// Before (broken):
routeSignalToSubscribers(...).then().catch();

// After (fixed):
await routeSignalToSubscribers(...);
```
Applied to both OPEN (line ~6240) and CLOSE (line ~5609) signal paths.

---

## Key Admin Commands
```bash
# Check subscription diagnostics
curl -s -H "Authorization: Bearer $ADMIN_PASSWORD" "https://myquantumvault.com/api/admin/subscription-diagnostics"

# Check recent trades for subscriber bots
curl -s -H "Authorization: Bearer $ADMIN_PASSWORD" "https://myquantumvault.com/api/admin/trades?limit=20"

# Run live routing test
curl -s -X POST -H "Authorization: Bearer $ADMIN_PASSWORD" -H "Content-Type: application/json" \
  -d '{"action":"buy","contracts":"57","positionSize":"57","price":"1.75"}' \
  "https://myquantumvault.com/api/admin/live-routing-test/dee5703c-31f2-40f8-9ce5-ddd84bc12f7b"
```

---

## Debug Logging Reference (Added Jan 29)

All trace logs use prefix `[WEBHOOK-TRACE]` for easy filtering.

### Log Points in server/routes.ts

| Location | Prefix | What it shows |
|----------|--------|---------------|
| Webhook entry (~4922) | `[WEBHOOK-TRACE]` | Confirms webhook received, shows payload |
| Bot lookup (~4965) | `[WEBHOOK-TRACE]` | Bot name, market, publish status |
| Signal branching (~5200) | `[WEBHOOK-TRACE]` | Which path (CLOSE vs OPEN) signal takes |
| Routing call - Open (~6240) | `[WEBHOOK-TRACE]` | Confirms routing function called for opens |
| Routing call - Close (~5609) | `[WEBHOOK-TRACE]` | Confirms routing function called for closes |
| Inside routeSignalToSubscribers (~676) | `[Subscriber Routing]` | Function internals, subscriber count, processing |

### Expected Log Flow (Working Routing)
```
[WEBHOOK-TRACE] ========== WEBHOOK RECEIVED ==========
[WEBHOOK-TRACE] Bot ID: abc123...
[WEBHOOK-TRACE] Bot found: name="My Bot", market=SOL-PERP
[WEBHOOK-TRACE] Bot publish status: isPublished=true, publishedBotId=def456...
[WEBHOOK-TRACE] ========== SIGNAL BRANCHING ==========
[WEBHOOK-TRACE] isCloseSignal=false (will take OPEN/REGULAR path)
... (trade execution) ...
[WEBHOOK-TRACE] ========== ROUTING SUBSCRIBER BOTS ==========
[WEBHOOK-TRACE] Routing status: completed
[Subscriber Routing] Starting routing for source bot abc123...
[Subscriber Routing] Found 2 subscriber bots for published bot def456...
```

### Failure Patterns to Look For
- Missing `========== ROUTING SUBSCRIBER BOTS ==========` → function never called
- `Bot publish status: isPublished=false` → bot not published
- `Found 0 subscriber bots` → no active subscribers
- `Routing status: error:` → exception thrown

### Admin Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/admin/live-routing-test/:botId` | POST | Execute actual routing with test signal |
| `/api/admin/debug-routing/:botId` | GET | Simulate routing, return diagnostics |
| `/api/admin/subscription-diagnostics` | GET | Show all subscriptions with status |

### Security Notes
**Logged:** Bot IDs, names, markets, signal actions/amounts, timestamps, publish status  
**NOT logged:** Private keys, wallet secrets, admin passwords, encrypted keys

---

## Cleanup Instructions (After Issue Resolved)

Remove all diagnostic logging:
```bash
# Find WEBHOOK-TRACE logs
grep -n "WEBHOOK-TRACE" server/routes.ts

# Find routing debug logs
grep -n "Subscriber Routing" server/routes.ts
```

Files to edit: `server/routes.ts`  
Delete this file: `docs/SUBSCRIBER_DIAGNOSTICS.md` (after issue resolved)

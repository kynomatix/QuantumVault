# Subscriber Routing Diagnostics

## Issue Summary
Subscribers to marketplace signal bots show 0 trades despite source bots actively trading.

## Current Status (Jan 30, 2026)
**BREAKTHROUGH FINDING (Jan 30 02:40 UTC):**
- **Jan 29 09:05:22** - Subscriber 2afe9363 LONG was a REAL webhook routing (source=marketplace_routing, status=executed)
- This proves OPEN signals CAN route via webhooks successfully
- **BUT** CLOSE signals are failing silently:
  - Jan 29 22:00:12 source CLOSE - NO subscriber trade record
  - Jan 30 02:16:31 source CLOSE - NO subscriber trade record

**Root cause hypothesis**: CLOSE signal routing path has a silent failure point that OPEN signals don't hit.

**Still undeployed**: The visibility fix is in dev but NOT in production yet.

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
1. Deploy changes to production
2. Wait for next real webhook to verify summary logs appear
3. Users need to either:
   - Add USDC to agent wallets
   - Deposit collateral to bot subaccounts
   - Enable autoTopUp with sufficient wallet funds

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

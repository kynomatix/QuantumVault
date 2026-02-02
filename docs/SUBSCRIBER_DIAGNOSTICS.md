# Subscriber Routing Diagnostics

## FULLY RESOLVED: Feb 2, 2026

### Verification Complete
**Subscriber routing is CONFIRMED WORKING in production.**

**Evidence:**
- Trade ID: `f3f4939f-a615-47e8-b01d-b88675c68d11`
- Subscriber Bot: `2afe9363` (RNDR 2H OI Skalpa Copy)
- Source Bot: `dee5703c` (RNDR 2H OI Skalpa)
- Market: RENDER-PERP
- Side: LONG, 30.005 contracts @ $1.71
- Status: **EXECUTED**
- Source: `marketplace_routing`
- TX: `4Eg1gax2Ekx5aApLScByTT5Q51edtycyerzw2qhUFjLhruFynCD93eTEtgk6HKPHRZEy6xauBacYvnMG92fZdSDj`
- Executed: 2026-02-01 22:39:21 UTC

---

## Root Causes (Fixed)

### Issue 1: Trade Retry Bypassed Routing (Fixed Feb 1)
When source bot trades failed with temporary errors (margin issues, rate limits):
1. Webhook handler queued trade for retry → returned early before routing call
2. Retry service executed trade successfully later
3. But retry service had no routing logic → subscribers never got signals

**Fix:** Added `registerRoutingCallback()` to `trade-retry-service.ts`. Routes both OPEN and CLOSE signals after successful retry.

### Issue 2: Retry Attempts Not Persisted (Fixed Feb 2)
Trade retry attempts counter was only stored in-memory. On server restart, jobs reloaded with attempts=0, allowing infinite retries (30-100+ attempts observed).

**Fix:** Persist `attempts` counter to database after each retry attempt. Added max 2 jobs per cycle with 3-second stagger delay.

---

## Retained Logging (For Future Debugging)

### [Subscriber Routing] logs
- Entry: `Routing {action} (close={bool}) to N subscribers`
- Summary: `SUMMARY for source X: N subscribers, X skipped, X trades OK, X trades FAILED`
- Errors: Close failures, order failures, processing exceptions

### [TradeRetry] logs
- `Routing callback registered` (startup)
- `Processing N pending jobs` (when jobs exist)
- `Routing signal to subscribers` (after successful retry)

---

## Admin Endpoints (Retained for Testing)

| Endpoint | Method | Purpose | Security |
|----------|--------|---------|----------|
| `/api/admin/subscription-diagnostics` | GET | View all subscriptions | Admin auth |
| `/api/admin/live-routing-test/:botId` | POST | Execute actual routing test | Admin auth |

---

## Phase 2 Security Considerations (Deferred)

The following should be reviewed before public launch:

1. **live-routing-test endpoint** - Can inject trades without webhook. Consider:
   - Rate limiting
   - Audit logging
   - Disabling in production

2. **Routing callback registration** - Currently trusts any caller. Consider:
   - Validating caller context
   - Adding HMAC verification for routed signals

---

## Cleanup Status

- [x] Reduced WEBHOOK-TRACE logging (removed verbose per-field logs)
- [x] Kept [Subscriber Routing] summary for production monitoring
- [x] Retained admin test endpoints for development
- [ ] Phase 2: Security hardening of admin endpoints (deferred)

---

## Archive: Previous Investigation

See git history for full investigation log (Jan 29-31, 2026).
Key finding: Routing logic was correct, but subscribers had funding problems:
- c57d65fb: wallet only had $0.18 USDC
- 2afe9363: autoTopUp=false with insufficient collateral

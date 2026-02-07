# Subscriber Routing Diagnostics

## Architecture: Decoupled Subscriber Routing (Feb 7, 2026)

Subscriber routing is **fully decoupled** from source bot execution status. When a published source bot receives a webhook signal, subscribers receive the signal and can trade independently, even if the source bot is paused, underfunded, or otherwise unable to execute.

### How It Works

1. **Webhook arrives** for a published source bot
2. **If source bot is active**: Normal flow - source executes trade, then routes to subscribers in deferred block
3. **If source bot is paused**: Signal is parsed via `parseSignalForRouting()`, routed to subscribers immediately, then returns "Bot is paused (subscribers routed)"
4. **Trade retry path**: Successful retries also route to subscribers via registered callback

### Signal Routing Entry Points

| Path | When | Location |
|------|------|----------|
| Paused bot routing | Source bot is paused but published | Webhook handler, bot-active check |
| Execution disabled routing | Source wallet execution auth disabled but published | Webhook handler, executionEnabled check |
| Execution expired routing | Source wallet execution auth expired but published | Webhook handler, executionExpiresAt check |
| Close signal deferred | Successful close trade execution | After close response sent |
| Open signal deferred | Successful open trade execution | After open response sent |
| Retry callback | Successful retry execution | `trade-retry-service.ts` |

**Not routed:** Emergency stop (safety mechanism - blocks everything including subscribers), invalid webhook secret, wallet/bot not found.

### Routing Audit Trail

Every routing batch produces a structured JSON audit log:
```
[Subscriber Routing] AUDIT: {"publishedBotId":"...","publishedBotName":"...","subscriberCount":2,"results":{"success":1,"failed":0,"skipped":1,"errors":0},"timestamp":"..."}
```

---

## Previous Issues (Fixed)

### Issue 3: Source Bot Pause Blocked All Subscribers (Fixed Feb 7)
When a source bot was paused, the webhook handler returned "Bot is paused" at line 5155 before routing logic ever ran. All subscribers were blocked from receiving signals.

**Fix:** Added `parseSignalForRouting()` helper and decoupled routing at the pause check. Published bots now route signals to subscribers before returning the paused error.

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
- Entry: `Starting routing for source bot X, signal: action, close=bool`
- Per-subscriber: `Processing subscriber bot X (name), isActive=bool, market=X`
- Wallet lookup: `Wallet lookup for X: found=bool, hasAgentKey=bool`
- Summary: `SUMMARY for source X: N subscribers, X skipped, X trades OK, X trades FAILED`
- Audit: `AUDIT: {structured JSON with results}`
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

## Removed Logging (Re-enable for Debugging)

If subscriber routing stops working, add these logs back to `server/routes.ts`:

### Webhook Entry Logs (around line 5030)
```javascript
// Add after: const { secret } = req.query;
console.log(`[WEBHOOK-TRACE] ========== WEBHOOK RECEIVED ==========`);
console.log(`[WEBHOOK-TRACE] Bot ID: ${botId}`);
console.log(`[WEBHOOK-TRACE] Timestamp: ${new Date().toISOString()}`);
console.log(`[WEBHOOK-TRACE] Payload: ${JSON.stringify(req.body).slice(0, 500)}`);
```

### Bot Lookup Logs (around line 5070)
```javascript
// Add after: const botPublishedInfo = await storage.getPublishedBotByTradingBotId(botId);
console.log(`[WEBHOOK-TRACE] Bot found: name="${bot.name}", market=${bot.market}`);
console.log(`[WEBHOOK-TRACE] Bot publish status: isPublished=${!!botPublishedInfo}, publishedBotId=${botPublishedInfo?.id || 'none'}`);
console.log(`[WEBHOOK-TRACE] Bot active: ${bot.isActive}`);
```

### Signal Branching Logs (around line 5300)
```javascript
// Add after: const isCloseSignal = ...
console.log(`[WEBHOOK-TRACE] ========== SIGNAL BRANCHING ==========`);
console.log(`[WEBHOOK-TRACE] isCloseSignal=${isCloseSignal} (will take ${isCloseSignal ? 'CLOSE' : 'OPEN/REGULAR'} path)`);
console.log(`[WEBHOOK-TRACE] Bot isPublished=${!!botPublishedInfo} - routing ${botPublishedInfo ? 'WILL' : 'will NOT'} be attempted`);
```

### Routing Call Logs (around line 5600 for CLOSE, line 6220 for OPEN)
```javascript
// Add before: await routeSignalToSubscribers(...)
console.log(`[WEBHOOK-TRACE] ========== ROUTING SUBSCRIBER BOTS ==========`);
console.log(`[WEBHOOK-TRACE] Calling routeSignalToSubscribers for bot ${botId}`);
console.log(`[WEBHOOK-TRACE] Signal: action=${action}, contracts=${contracts}, isCloseSignal=${isCloseSignal}`);

// Add after routing completes:
console.log(`[WEBHOOK-TRACE] Routing status: ${routingStatus}`);
```

### Per-Subscriber Verbose Logs (in routeSignalToSubscribers function, around line 680)
```javascript
// Add at start of function:
console.log(`[Subscriber Routing] Starting routing for source bot ${sourceBotId}, signal: ${signal.action}, close=${signal.isCloseSignal}`);
console.log(`[Subscriber Routing] Found published bot: ${publishedBot.id}, active=${publishedBot.isActive}`);
console.log(`[Subscriber Routing] Found ${subscriberBots?.length || 0} subscriber bots`);

// Add inside for loop for each subscriber:
console.log(`[Subscriber Routing] Processing subscriber bot ${subBot.id} (${subBot.name})`);
console.log(`[Subscriber Routing] Subscriber has agent wallet: pubKey=${!!subWallet.agentPublicKey}, encKey=${!!subWallet.agentPrivateKeyEncrypted}`);
console.log(`[Subscriber Routing] Executing ${signal.action} for subscriber bot ${subBot.id}: $${sizingResult.tradeAmountUsd.toFixed(2)}`);
```

### Quick Re-enable Command
```bash
# Find all removed log locations:
grep -n "routeSignalToSubscribers\|isCloseSignal\|botPublishedInfo" server/routes.ts
```

---

## Archive: Previous Investigation

See git history for full investigation log (Jan 29-31, 2026).
Key finding: Routing logic was correct, but subscribers had funding problems:
- c57d65fb: wallet only had $0.18 USDC
- 2afe9363: autoTopUp=false with insufficient collateral

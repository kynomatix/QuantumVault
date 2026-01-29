# Diagnostic Logging - Subscriber Routing Debug

**Added:** January 29, 2026  
**Purpose:** Debug why subscriber trade routing isn't executing in production  
**Status:** Active - Remove after issue is resolved

---

## Summary

Verbose logging has been added throughout the webhook handler to trace exactly where signals flow and why routing might not be executing. All trace logs use the prefix `[WEBHOOK-TRACE]` for easy filtering.

---

## Debug Logging Added

### 1. Webhook Entry (server/routes.ts ~line 4922)
**Prefix:** `[WEBHOOK-TRACE]`
```
========== WEBHOOK RECEIVED ==========
Bot ID: {botId}
Timestamp: {timestamp}
Payload: {truncated payload}
```
**Purpose:** Confirms webhook was received and shows the incoming payload

### 2. Bot Lookup (server/routes.ts ~line 4965)
**Prefix:** `[WEBHOOK-TRACE]`
```
Bot found: name="{name}", market={market}
Bot publish status: isPublished={bool}, publishedBotId={id or 'none'}
Bot active: {bool}
```
**Purpose:** Shows if bot exists and its publish status (critical for routing)

### 3. Signal Branching (server/routes.ts ~line 5200)
**Prefix:** `[WEBHOOK-TRACE]`
```
========== SIGNAL BRANCHING ==========
isCloseSignal={bool} (will take CLOSE or OPEN/REGULAR path)
Bot isPublished={bool} - routing WILL/will NOT be attempted
```
**Purpose:** Shows which code path the signal takes

### 4. Routing Call - Regular Signals (server/routes.ts ~line 6123)
**Prefix:** `[WEBHOOK-TRACE]`
```
========== ROUTING SUBSCRIBER BOTS ==========
Calling routeSignalToSubscribers for bot {botId}
Signal: action={action}, contracts={contracts}, positionSize={positionSize}
Prices: signalPrice={price}, fillPrice={price}
isCloseSignal=false (regular open signal path)
```
**Purpose:** Confirms routing function is being called for regular signals

### 5. Routing Call - Close Signals (server/routes.ts ~line 5499)
**Prefix:** `[WEBHOOK-TRACE]`
```
========== ROUTING SUBSCRIBER BOTS (CLOSE) ==========
Calling routeSignalToSubscribers for CLOSE signal
Bot ID: {botId}, action={action}
isCloseSignal=true (close signal path)
```
**Purpose:** Confirms routing function is being called for close signals

### 6. Inside routeSignalToSubscribers Function (server/routes.ts ~line 676)
**Prefix:** `[Subscriber Routing]`
- Logs when function starts
- Logs if bot is not published (early return)
- Logs if published bot is inactive (early return)
- Logs subscriber count found
- Logs each subscriber being processed
- Logs any wallet configuration issues
- Logs trade execution results

---

## Admin Endpoints Added

### 1. Live Routing Test
**Path:** `POST /api/admin/live-routing-test/:botId`  
**Auth:** Admin password required  
**Purpose:** Actually executes `routeSignalToSubscribers` with a test signal to verify end-to-end routing

**Example:**
```bash
curl -X POST "https://myquantumvault.com/api/admin/live-routing-test/{botId}" \
  -H "Authorization: Bearer {ADMIN_PASSWORD}" \
  -H "Content-Type: application/json" \
  -d '{"action":"buy","contracts":"0.1","positionSize":"1","price":"12"}'
```

### 2. Debug Routing (existing)
**Path:** `GET /api/admin/debug-routing/:botId`  
**Auth:** Admin password required  
**Purpose:** Simulates routing logic and returns diagnostic info without executing trades

### 3. Subscription Diagnostics (existing)
**Path:** `GET /api/admin/subscription-diagnostics`  
**Auth:** Admin password required  
**Purpose:** Shows all subscriptions with routing status and issues

---

## How to Find Logs in Production

### Search for all trace logs:
```bash
# In production logs, search for:
grep "WEBHOOK-TRACE" /path/to/logs

# Or search for subscriber routing:
grep "Subscriber Routing" /path/to/logs
```

### Key patterns to look for:
1. `[WEBHOOK-TRACE] ========== WEBHOOK RECEIVED ==========` - Start of webhook processing
2. `[WEBHOOK-TRACE] Bot publish status` - Shows if routing should happen
3. `[WEBHOOK-TRACE] ========== ROUTING SUBSCRIBER BOTS ==========` - Confirms routing call
4. `[Subscriber Routing] Starting routing` - Inside the routing function
5. `[Subscriber Routing] Found X subscriber bots` - How many will receive the signal

---

## How to Remove All Diagnostics

### Quick removal commands:
```bash
# Find all WEBHOOK-TRACE logs
grep -n "WEBHOOK-TRACE" server/routes.ts

# Find all routing debug logs  
grep -n "Subscriber Routing" server/routes.ts

# Find the live-routing-test endpoint
grep -n "live-routing-test" server/routes.ts
```

### Files to edit:
- `server/routes.ts` - Remove all lines containing `[WEBHOOK-TRACE]`
- `server/routes.ts` - Optionally remove the `/api/admin/live-routing-test/:botId` endpoint block

### Patterns to remove:
1. `console.log(\`[WEBHOOK-TRACE]` - All trace logging (12 lines total)
2. The live-routing-test endpoint block if no longer needed

---

## Security Notes

**What IS logged:**
- Bot IDs (UUIDs)
- Bot names and markets
- Signal actions (buy/sell)
- Signal amounts (contracts, position sizes)
- Timestamps
- Publish status (true/false)

**What is NOT logged:**
- Private keys or secrets
- Wallet private data
- Admin passwords
- Full webhook secrets
- Encrypted key material

**Protection:**
- All admin endpoints require password authentication
- Logging is server-side only (not exposed to clients)
- Payload logging is truncated to 500 characters

---

## Expected Log Flow for Working Routing

When a webhook is received and routing works correctly, you should see this sequence:

```
[WEBHOOK-TRACE] ========== WEBHOOK RECEIVED ==========
[WEBHOOK-TRACE] Bot ID: abc123...
[WEBHOOK-TRACE] Bot found: name="My Bot", market=SOL-PERP
[WEBHOOK-TRACE] Bot publish status: isPublished=true, publishedBotId=def456...
[WEBHOOK-TRACE] Bot active: true
[WEBHOOK-TRACE] ========== SIGNAL BRANCHING ==========
[WEBHOOK-TRACE] isCloseSignal=false (will take OPEN/REGULAR path)
[WEBHOOK-TRACE] Bot isPublished=true - routing WILL be attempted
... (trade execution logs) ...
[WEBHOOK-TRACE] ========== ROUTING SUBSCRIBER BOTS ==========
[WEBHOOK-TRACE] Calling routeSignalToSubscribers for bot abc123...
[Subscriber Routing] Starting routing for source bot abc123...
[Subscriber Routing] Found published bot: def456..., active=true
[Subscriber Routing] Found 2 subscriber bots for published bot def456...
[Subscriber Routing] Processing subscriber bot ghi789...
... (subscriber trade execution) ...
```

**If routing is NOT working, look for:**
- Missing `[WEBHOOK-TRACE] ========== ROUTING SUBSCRIBER BOTS ==========` - function never called
- `Bot publish status: isPublished=false` - bot not published
- `[Subscriber Routing] Source bot is not published` - early return
- `[Subscriber Routing] Found 0 subscriber bots` - no active subscribers

---

## Related Issue

**Problem:** Subscriber trades show 0 despite routing code existing and `canRoute=true`  
**Hypothesis:** Routing function not being called, or early return before subscriber processing  
**Solution:** Deploy this logging, wait for next webhook, analyze production logs

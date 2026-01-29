# Diagnostic Logging - Subscriber Routing Debug

**Added:** January 29, 2026  
**Purpose:** Debug why subscriber trade routing isn't executing in production  
**Status:** Active - Remove after issue is resolved

---

## Debug Logging Added

### 1. Webhook Handler - Regular Signals (server/routes.ts ~line 6100)
**Location:** Inside the webhook signal processing, before `routeSignalToSubscribers` call

```typescript
console.log(`[ROUTING-DEBUG] About to call routeSignalToSubscribers for bot ${bot.id}`);
console.log(`[ROUTING-DEBUG] Bot isPublished: ${bot.isPublished}, publishedBotId: ${bot.publishedBotId}`);
console.log(`[ROUTING-DEBUG] Signal: action=${signal.action}, contracts=${signal.contracts}, positionSize=${signal.positionSize}`);
```

**What it logs:** Confirms routing function is being called and shows bot publish status + signal details

### 2. Webhook Handler - Close Signals (server/routes.ts ~line 5475)
**Location:** Inside close signal detection, before `routeSignalToSubscribers` call

```typescript
console.log(`[ROUTING-DEBUG-CLOSE] About to call routeSignalToSubscribers for CLOSE signal`);
console.log(`[ROUTING-DEBUG-CLOSE] Bot: ${bot.id}, isPublished: ${bot.isPublished}`);
```

**What it logs:** Confirms close signals trigger routing

---

## Admin Endpoint Added

### Live Routing Test Endpoint
**Path:** `POST /api/admin/live-routing-test/:botId`  
**Auth:** Admin password required  
**Purpose:** Simulate webhook signal and test routing end-to-end

**Can be removed:** Yes, after routing is confirmed working

---

## How to Remove

### Quick removal (search for these patterns):
```bash
# Find all routing debug logs
grep -n "ROUTING-DEBUG" server/routes.ts

# Find the admin test endpoint
grep -n "live-routing-test" server/routes.ts
```

### Files to edit:
- `server/routes.ts` - Remove lines containing `[ROUTING-DEBUG]` and `[ROUTING-DEBUG-CLOSE]`
- `server/routes.ts` - Remove the `/api/admin/live-routing-test/:botId` endpoint block (search for "live-routing-test")

---

## Security Notes

- Debug logs may expose: bot IDs, publish status, signal actions
- No sensitive data (keys, passwords, wallet addresses) is logged
- Admin endpoint is protected by password authentication
- All logging uses console.log (server-side only, not exposed to clients)

---

## Related Issue

**Problem:** Subscriber trades show 0 despite routing code existing and `canRoute=true`  
**Root cause hypothesis:** Routing function not being called, or early return before execution  
**Solution:** Deploy logging, wait for next webhook, check production logs

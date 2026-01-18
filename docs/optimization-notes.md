# QuantumVault Optimization Notes

## Overview
This document tracks code optimizations, refactoring decisions, and cleanup items for future reference.

---

## Bot Management Drawer RPC Optimization

**Date:** January 2025  
**Status:** In Progress

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

## Change Log

| Date | Change | Files Modified |
|------|--------|----------------|
| Jan 2025 | Created `/api/bots/:id/overview` endpoint | `server/routes.ts` |
| Jan 2025 | Updated BotManagementDrawer to use new endpoint | `client/src/components/BotManagementDrawer.tsx` |

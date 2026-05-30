---
name: Error-swallowing read helpers (routes.ts)
description: Several exchange-read helpers in server/routes.ts catch errors and return safe defaults — never trust them as guards in money-moving paths.
---

# Error-swallowing read helpers in server/routes.ts

`getPerpPositions` (`catch { return [] }`), `getExchangeBalance` (`catch { return 0 }`),
and `subaccountExists` (`catch { return false }`) all swallow internal errors and
return a "safe" default. They are fine for display/read-only paths, but **fail OPEN**.

**Why:** In a money-moving teardown (unsubscribe / withdraw / delete), treating their
return values as authoritative is dangerous: an exchange/RPC outage makes them report
"no open position" / "zero balance" / "subaccount gone", which can skip capital
recovery and still finalize the teardown — stranding the user's funds. A surrounding
`try/catch` around these helpers is useless because no error ever propagates out of them.

**How to apply:** On any path where a wrong read causes fund loss, call the adapter
DIRECTLY so errors throw and you can fail closed:
- positions: `getDefaultAdapter().getPositions(agentPub, _subIdStr(subId)).map(_mapPositionToDrift)`
- balance: `getDefaultAdapter().getAccountInfo(agentPub, _subIdStr(subId)).balance`
- subaccount existence: `getDefaultAdapter().listSubaccounts(agentPub)` then `.some(s => s.subaccountId === String(subId))`
Wrap in try/catch, return 502 and do NOT mutate/finalize on a read failure. When the
existence check itself fails, record an orphaned-subaccount row before nulling the link
so rent can be reclaimed later (the OrphanedCleanup service handles reclaim).

**Related pre-existing tech debt:** the IOU settlement loop (transfer USDC, then mark
the profit-share row `paid`) is non-atomic and identical across the unsubscribe,
withdraw, and delete routes — a crash between the transfer and the DB update can
double-pay on retry. Don't "fix" it in just one route; track it as a shared change.

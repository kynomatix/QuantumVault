# Swift Protocol Integration Plan

**Created:** February 9, 2026  
**Status:** Ready for External Audit  
**Companion Document:** `docs/SWIFT_PROTOCOL_MIGRATION_PLAN.md` (v3.0 - research & architecture)  
**This Document:** Step-by-step implementation path with go/no-go gates

---

## How to Read This Plan

This is the **build plan**. The companion migration plan (v3.0) contains the research, architecture diagrams, gap analysis, and audit findings. This document turns that research into a concrete sequence of steps.

Each step has:
- **What** you're building
- **Where** in the codebase it goes
- **How** to verify it works
- **Gate** criteria before proceeding to the next step

Nothing proceeds without passing its gate.

---

## Architecture Decision: Where Swift Lives

**Decision:** Swift execution runs in the **main Node.js process**, not in the `drift-executor.mjs` subprocess.

**Rationale:**
- Swift is sign-a-message + HTTP POST — no heavy transaction building, no process isolation needed
- `drift-executor.mjs` stays untouched as the legacy fallback path
- The Swift executor is a new module (`server/swift-executor.ts`) called from `drift-service.ts`
- If Swift fails, the existing subprocess path fires as fallback — zero changes to proven code

```
                        ┌─────────────────────────┐
                        │   executePerpOrder()     │
                        │   (drift-service.ts)     │
                        └──────────┬──────────────┘
                                   │
                        ┌──────────▼──────────────┐
                        │  Should use Swift?       │
                        │  (swift-config.ts)       │
                        └──────┬─────────┬────────┘
                               │ YES     │ NO
                    ┌──────────▼───┐  ┌──▼──────────────┐
                    │ swift-       │  │ drift-executor   │
                    │ executor.ts  │  │ .mjs subprocess  │
                    │ (main proc)  │  │ (unchanged)      │
                    └──────┬───────┘  └─────────────────┘
                           │
                    ┌──────▼───────┐
                    │ Swift fail?  │
                    │ fallback →   │──▶ drift-executor.mjs
                    └──────────────┘
```

---

## Step-by-Step Integration Path

### Step 1: Database Schema Migration

**What:** Add Swift tracking columns to existing tables.

**Where:** `shared/schema.ts`

**Changes:**

```
bot_trades table — ADD:
  executionMethod  text  default 'legacy'    // 'swift' | 'legacy'
  swiftOrderId     text  nullable            // Swift UUID for tracking
  auctionDurationMs integer nullable         // How long the auction took
  priceImprovement  decimal nullable         // Fill price vs oracle (bps)

trade_retry_queue table — ADD:
  swiftAttempts       integer  default 0     // Swift-specific retry count
  originalExecMethod  text     default 'legacy'  // What method was tried first
```

**Not adding:**
- No `swiftEnabled` per bot — Swift is a global platform capability with automatic fallback, not a per-bot setting
- No separate `swift_order_logs` audit table yet — the `executionMethod` column on `bot_trades` gives us tracking without a new table. Add the audit table later if debugging requires it

**Verify:**
1. Run `npm run db:push` — migration completes without errors
2. Query `SELECT column_name FROM information_schema.columns WHERE table_name = 'bot_trades'` — new columns exist
3. Existing trades still load in the UI — no regressions

**Gate:** Schema migration applied, existing data intact, app starts normally.

---

### Step 2: Swift Configuration Module

**What:** Central config for Swift behavior, health tracking, and error classification.

**Where:** New file `server/swift-config.ts`

**Contents:**

```
SWIFT_CONFIG:
  enabled:           env SWIFT_ENABLED (default: false — OFF until Step 7)
  apiUrl:            'https://swift.drift.trade'
  orderTimeoutMs:    3000  (aggressive — leaves room for legacy fallback within 5s total)
  healthCheckMs:     30000
  maxSwiftRetries:   2     (then fall back to legacy)
  fallbackEnabled:   true  (always fall back to legacy on Swift failure)

SWIFT_HEALTH (in-memory state):
  isHealthy:              boolean
  lastCheckAt:            timestamp
  consecutiveFailures:    number
  latencyMs:              number

isSwiftAvailable():       returns enabled && isHealthy
shouldUseSwift():         returns isSwiftAvailable() (no market filtering — all markets eligible)

SWIFT_ERROR_CLASSIFICATION:
  RETRYABLE_SWIFT:     ['timeout', '429', '503', '504', 'stale slot']
  FALLBACK_TO_LEGACY:  ['no liquidity', 'auction timeout']
  PERMANENT:           ['invalid signature', 'invalid order parameters', '400', '401']
  classifySwiftError(error) → 'retry_swift' | 'fallback_legacy' | 'permanent'
```

**Verify:**
1. Module imports without errors
2. `isSwiftAvailable()` returns `false` (SWIFT_ENABLED defaults to false)
3. Error classification returns correct categories for test strings

**Gate:** Config module compiles, health state tracks correctly, error classification is accurate.

---

### Step 3: Swift Executor Module

**What:** The core module that signs Swift order messages and submits them to the Swift API.

**Where:** New file `server/swift-executor.ts`

**Function signature:**

```typescript
export async function executeSwiftOrder(params: {
  privateKeyBase58: string;        // Decrypted agent key (same key used for legacy)
  agentPublicKey: string;
  market: string;                  // e.g., 'SOL-PERP'
  marketIndex: number;
  side: 'long' | 'short';
  sizeInBase: number;
  subAccountId: number;
  reduceOnly: boolean;
  slippageBps?: number;
}): Promise<SwiftOrderResult>
```

**Internal flow:**
1. Get current slot from RPC (1 lightweight `getSlot` call)
2. Build `SignedMsgOrderParamsMessage` with slot, UUID, order params
3. Sign with agent keypair using `driftClient.signSignedMsgOrderParamsMessage()`
4. POST to `https://swift.drift.trade/orders` with 3-second timeout
5. Parse response — return success with fill details or error with classification

**Return type:**
```typescript
interface SwiftOrderResult {
  success: boolean;
  executionMethod: 'swift';
  txSignature?: string;           // On-chain signature from keeper
  swiftOrderId?: string;          // Swift UUID
  fillPrice?: number;
  fillAmount?: number;
  auctionDurationMs?: number;
  priceImprovement?: number;      // vs oracle, in bps
  error?: string;
  errorClassification?: 'retry_swift' | 'fallback_legacy' | 'permanent';
}
```

**Key implementation details:**
- Uses `@drift-labs/sdk` built-in methods for message encoding/signing
- Does NOT create a full DriftClient with subscriptions — only needs a lightweight client for signing
- Requires an active RPC connection only for `getSlot()` — uses existing `getConnection()` from drift-service
- Does NOT handle trade sizing — that's done upstream by `computeTradeSizingAndTopUp`
- Does NOT handle position checks — that's done upstream by `PositionService.getPositionForExecution()`

**Verify:**
1. Unit test: sign a message with a test keypair, verify the signature format matches Swift API expectations
2. Unit test: mock the Swift API POST, verify request body format
3. Unit test: verify error classification for each error type
4. Module compiles and all imports resolve

**Gate:** Swift executor signs messages correctly, submits to API with correct format, classifies errors accurately. All unit tests pass.

---

### Step 4: Integration Point — `executePerpOrder` Wrapper

**What:** Modify `executePerpOrder()` in `drift-service.ts` to try Swift first, fall back to legacy subprocess.

**Where:** `server/drift-service.ts`, function `executePerpOrder()` (line ~3248)

**Current flow:**
```
executePerpOrder() → spawn drift-executor.mjs → placeAndTakePerpOrder → return result
```

**New flow:**
```
executePerpOrder()
  │
  ├─ shouldUseSwift()? ─── YES ──▶ executeSwiftOrder()
  │                                      │
  │                                 Success? ──▶ return swift result
  │                                      │
  │                                 Fail (fallback_legacy)? ──▶ continue to legacy
  │                                 Fail (permanent)? ──▶ return error
  │
  └─ NO (or Swift failed with fallback) ──▶ spawn drift-executor.mjs (existing code, unchanged)
```

**Critical rules:**
- The `executePerpOrder` function signature does NOT change — all callers (webhook, manual, subscriber, retry) are unaffected
- Swift is tried first, legacy is fallback — never the other way around
- If Swift succeeds, the result is mapped to the same return type as legacy
- If Swift fails with `fallback_legacy` classification, log the Swift error and proceed to legacy — no extra delay
- If Swift fails with `permanent` classification, return the error immediately — don't waste time on legacy
- The `executionMethod` ('swift' or 'legacy') is added to the return object so callers can log it

**What stays the same:**
- `computeTradeSizingAndTopUp` is called BEFORE `executePerpOrder` — sizing logic unchanged
- `PositionService.getPositionForExecution()` is called BEFORE close orders — position checks unchanged
- The subprocess stagger logic still applies to legacy fallback calls
- RPC failover for legacy calls is unchanged
- Profit sharing flow downstream is unchanged — it just gets the fill price from whichever method succeeded

**Verify:**
1. Set `SWIFT_ENABLED=false` → all trades use legacy subprocess (zero behavior change)
2. Set `SWIFT_ENABLED=true` with Swift API mocked to return success → trades execute via Swift
3. Set `SWIFT_ENABLED=true` with Swift API mocked to fail → trades fall back to legacy subprocess
4. Measure total latency: Swift attempt (3s timeout) + legacy fallback should complete under 5 seconds total
5. Existing webhook flow end-to-end works with `SWIFT_ENABLED=false`
6. Verify `reduceOnly: true` close orders work correctly via Swift — position should close, not open a new one
7. Verify all 4 subscriber routing trigger points work with Swift:
   - Source bot **paused** → `parseSignalForRouting()` → `routeSignalToSubscribers()` → subscribers execute via Swift
   - Source bot **auth disabled** → same routing path → subscribers execute via Swift
   - Source bot **auth expired** → same routing path → subscribers execute via Swift
   - Source bot **executes normally** → subscribers execute via Swift
   - **Retry worker success** → `registerRoutingCallback` → subscribers execute via Swift

**Gate:** All 4 execution paths (webhook, manual, subscriber, retry) AND all 4+1 routing trigger points work with both `SWIFT_ENABLED=true` and `false`. Fallback behavior is correct. `reduceOnly` close orders behave identically to legacy. No regressions on existing functionality.

---

### Step 5: Trade Logging Updates

**What:** Record which execution method was used and Swift-specific metadata in `bot_trades`.

**Where:** `server/routes.ts` — all places that insert into `bot_trades`

**Changes:**
- When logging a trade, include `executionMethod: result.executionMethod || 'legacy'`
- When Swift was used, include `swiftOrderId`, `auctionDurationMs`, `priceImprovement`
- When Swift failed and legacy was used, include `executionMethod: 'legacy'` (the failed Swift attempt is logged in server console only — no extra DB write for failed attempts at this stage)

**Locations to update (all in `server/routes.ts`):**
1. Webhook handler trade log (~line 5700-5800)
2. Manual trade endpoint trade log (~line 3200-3400)
3. Subscriber routing trade log (~line 800-900)
4. Retry worker trade log (in `trade-retry-service.ts`)

**Verify:**
1. Execute a trade with Swift enabled → `bot_trades` row has `execution_method = 'swift'`
2. Execute a trade with Swift disabled → `bot_trades` row has `execution_method = 'legacy'`
3. Execute a trade where Swift fails → `bot_trades` row has `execution_method = 'legacy'`
4. Dashboard trade history still displays correctly — new columns don't break existing queries

**Gate:** All trades are logged with correct execution method. No existing queries or UI broken.

---

### Step 6: Retry Service Integration

**What:** Update trade retry service to handle Swift-specific retry behavior.

**Where:** `server/trade-retry-service.ts`

**Changes:**

When a trade is queued for retry:
- Record `originalExecMethod` (was it originally a Swift trade?)
- Initialize `swiftAttempts = 0`

When executing a retry:
- If `swiftAttempts < 2` and `isSwiftAvailable()` → try Swift
- If Swift fails on retry → increment `swiftAttempts`, try legacy
- If `swiftAttempts >= 2` → skip Swift, go straight to legacy
- Cooldown re-queue logic stays the same — Swift failures count toward cooldown eligibility

Cooldown integration specifics:
- Swift timeout errors (`classifySwiftError → 'retry_swift'`) that exhaust max attempts should trigger the existing `isTimeoutError` / `isTransientError` check for cooldown eligibility
- `cooldownRetries` counter (max 2, 2-minute delay) applies regardless of whether the original failure was Swift or legacy
- A Swift `'fallback_legacy'` error that then also fails on legacy counts as a single attempt toward the retry limit

When retry succeeds via routing callback:
- `registerRoutingCallback(routeSignalToSubscribers)` works the same regardless of execution method — no changes needed to the callback mechanism itself

**Verify:**
1. Queue a retry with Swift enabled → first retry attempts Swift
2. Force 2 Swift failures on retry → third retry goes directly to legacy
3. Cooldown re-queue still triggers after max attempts (both Swift-originated and legacy-originated failures)
4. Verify `cooldownRetries` increments correctly when Swift timeout errors exhaust normal retry attempts
5. Successful retry still triggers subscriber routing callback

**Gate:** Retry service correctly handles Swift retries, respects max Swift attempts, falls back to legacy, integrates with existing cooldown system (including `cooldownRetries` and 2-minute delay), and triggers routing callback on success.

---

### Step 7: Observability & Metrics

**What:** Add structured metrics tracking for Swift performance. This must be in place BEFORE production activation so we can monitor from day one.

**Where:** New file `server/swift-metrics.ts`, plus a new admin endpoint

**Metrics tracked (in-memory counters, queryable via API):**
- Total Swift orders submitted
- Swift success count / failure count / fallback count
- Average latency (ms)
- Average price improvement (bps)
- Per-market breakdown
- Error type distribution

**Admin endpoint:**
```
GET /api/admin/swift-metrics
→ Returns JSON with all metrics
```

**Verify:**
1. Execute several trades → metrics endpoint shows accurate counts
2. Force a fallback → fallback counter increments
3. Metrics survive across trades within a server session
4. Metrics reset on server restart (acceptable for V1 — persistent metrics are a later enhancement)

**Gate:** Metrics are accurate and accessible. Deployed and ready before Swift is enabled in production.

---

### Step 8: Controlled Activation

**What:** Enable Swift in production with monitoring.

**Where:** Environment variable `SWIFT_ENABLED=true`

**Activation sequence:**

```
Day 1:  Set SWIFT_ENABLED=true
        Monitor: Console logs for Swift attempts, success/failure
        Monitor: GET /api/admin/swift-metrics for real-time counters
        Watch:   First 10 trades — all should either succeed via Swift or fallback cleanly
        Check:   bot_trades table shows execution_method values

Day 2:  Review 24h of data
        Check:   Swift success rate (target: >90%)
        Check:   Fallback rate (target: <10%)
        Check:   No increase in failed trades vs pre-Swift baseline
        Check:   Trade latency hasn't degraded significantly
        Check:   Per-market metrics via /api/admin/swift-metrics

Day 3:  If stable, consider this the baseline
        If issues: Set SWIFT_ENABLED=false (instant rollback, no code change)

Week 2: Review per-market Swift performance
        Identify any markets with consistently low fill rates
        Review RPC usage patterns — should see reduction in Helius calls
```

**Emergency rollback:** Set `SWIFT_ENABLED=false` → immediate return to legacy-only, no code deployment needed.

**Verify:**
1. Production trades execute via Swift successfully
2. Fallback works when Swift API has issues
3. No increase in trade failures
4. Metrics endpoint shows accurate data from live trades
5. Console logging provides clear visibility into execution path

**Gate:** 48 hours of stable Swift execution in production with >90% Swift success rate and clean fallback behavior, validated by metrics data.

---

### Step 9: Builder Code Registration (Optional — Revenue)

**What:** Register QuantumVault as a Drift Builder to earn fees on Swift trades.

**Where:** Drift Builder Code program (on-chain registration, one-time)

**Requirements:**
- Register a builder code with Drift Protocol
- Add `builderIdx` and `builderFee` to Swift order submissions in `swift-executor.ts`
- Builder fees are paid by the protocol, not the user — no impact on user fill prices

**Verify:**
1. Confirm builder registration on-chain
2. Verify builder fee appears in Swift order submissions
3. Check builder fee revenue accrual on Drift

**Gate:** Builder code registered, fees flowing. This step is optional and can be deferred.

---

## File Change Summary

| File | Change Type | Description |
|------|-------------|-------------|
| `shared/schema.ts` | Modify | Add Swift columns to `botTrades` and `tradeRetryQueue` |
| `server/swift-config.ts` | **New** | Swift configuration, health monitoring, error classification |
| `server/swift-executor.ts` | **New** | Swift order signing, submission, and result parsing |
| `server/swift-metrics.ts` | **New** | In-memory metrics tracking |
| `server/drift-service.ts` | Modify | Add Swift-first logic to `executePerpOrder()` |
| `server/routes.ts` | Modify | Pass `executionMethod` when logging trades, add metrics endpoint |
| `server/trade-retry-service.ts` | Modify | Add Swift retry tracking and fallback logic |

**Files NOT modified:**
| File | Reason |
|------|--------|
| `server/drift-executor.mjs` | Legacy subprocess stays untouched — it's the fallback |
| `server/position-service.ts` | Position checks happen upstream, no Swift-specific changes |
| `server/routes.ts` (routing logic) | `routeSignalToSubscribers` calls `executePerpOrder` — the Swift logic is inside that function, so routing just works |
| Client/frontend files | No UI changes needed for V1 — `executionMethod` can be shown in trade history later |

---

## Risk Summary

| Risk | Mitigation |
|------|------------|
| Swift API goes down | Automatic fallback to legacy subprocess — instant, no human intervention |
| Swift increases latency | 3-second timeout ensures fallback fires quickly. Total worst-case: ~5-6 seconds |
| Swift signs incorrect order | Same keypair and order params as legacy — the signing input is identical |
| Schema migration breaks existing data | Columns are additive (nullable or with defaults) — no existing data modified |
| Swift + legacy both fail | Same outcome as today when legacy fails — trade goes to retry queue |
| `SWIFT_ENABLED` accidentally set wrong | Defaults to `false` — must be explicitly enabled. Set to `false` for instant rollback |

---

## Security V3 Compatibility

Swift signing uses the **same agent keypair** as legacy transaction signing. The key access path is identical:

**For webhook/manual trades (UMK path):**
```
Session → UMK → derive key_privkey → decrypt agentPrivateKeyEncryptedV3 → agent keypair → sign Swift message
```

**For subscriber routing (legacy path):**
```
agentPrivateKeyEncrypted → decrypt with AGENT_ENCRYPTION_KEY → agent keypair → sign Swift message
```

**What stays the same:**
- `policyHmac` verification happens BEFORE `executePerpOrder` is called — Swift changes nothing here
- `emergencyStopTriggered` check happens BEFORE trade execution — Swift changes nothing here
- `executionActive` check on the bot happens BEFORE trade execution — Swift changes nothing here
- The decrypted `privateKeyBase58` is passed to `executeSwiftOrder()` the same way it's passed to the subprocess

**Verification gate (applies to Step 4):**
- Confirm Swift trades respect emergency stop — trigger emergency stop, verify Swift trade is blocked
- Confirm Swift trades respect `executionActive: false` — disable execution, verify Swift trade is blocked
- Confirm Swift trades verify `policyHmac` — tamper with bot config, verify trade is rejected
- Confirm subscriber routing uses legacy key path for Swift signing — not UMK (subscribers have no session)

---

## Audit Findings Coverage Map

This section maps every finding from the migration plan v3.0 audit to a specific step in this integration plan. An external auditor can use this to verify completeness.

| # | Audit Finding | Covered In | How Addressed |
|---|---------------|------------|---------------|
| 1 | Decoupled subscriber routing (4 trigger points) | Step 4 (verify gate #7) | All 5 routing entry points explicitly verified: paused, auth disabled, auth expired, normal, retry callback. Swift works identically at all points because it's inside `executePerpOrder()` which all paths call. |
| 2 | Unified trade sizing (`computeTradeSizingAndTopUp`) | Step 4 (critical rules) | Explicitly stated: sizing is called BEFORE `executePerpOrder`. Swift does NOT bypass it. No changes to sizing logic. |
| 3 | PositionService for close verification | Step 4 (critical rules) | Explicitly stated: `PositionService.getPositionForExecution()` is called BEFORE close orders. Swift does NOT bypass it. No changes to position service. |
| 4 | All perp markets support Swift | Step 2 (config) | No market allowlist. `shouldUseSwift()` returns true for all markets. No tiering. |
| 5 | Reduce-only natively supported | Step 4 (verify gate #6) | `reduceOnly` flag passed through to Swift order params. Explicit verification gate confirms close-only behavior. |
| 6 | Cooldown retry system | Step 6 (cooldown specifics) | Swift failures map to existing `isTimeoutError`/`isTransientError`. `cooldownRetries` applies to both Swift and legacy failures. Explicit verify gates #3-4. |
| 7 | Subprocess architecture decision | Architecture Decision section | Swift in main process, legacy subprocess untouched as fallback. `drift-executor.mjs` not modified. |
| 8 | SDK has built-in Swift methods | Step 3 (implementation details) | Uses `@drift-labs/sdk` built-in methods for message encoding/signing. No custom HTTP client for message building. |
| 9 | Builder Codes revenue opportunity | Step 9 (optional) | Deferred to after stable activation. Does not block core integration. |
| 10 | Latency budget gap | Step 2 (config: 3000ms), Step 4 (verify gate #4) | Swift timeout set to 3000ms (not 5000ms). Total Swift + fallback must complete under 5 seconds. |
| 11 | Subscriber batch efficiency | Step 4 (routing verification) | `isSwiftAvailable()` checked at entry of each subscriber execution. If Swift health degrades mid-batch, remaining subscribers fall back immediately via health state. |
| 12 | Database schema — no Swift fields exist | Step 1 (schema migration) | Adds `executionMethod`, `swiftOrderId`, `auctionDurationMs`, `priceImprovement` to `bot_trades`. Adds `swiftAttempts`, `originalExecMethod` to `trade_retry_queue`. Audit log table deferred — traceability via `executionMethod` + console logs for V1. |

### Schema Decision Justification

The migration plan v3.0 proposed additional fields that this plan omits. Here's why:

| Proposed Field | Decision | Reasoning |
|----------------|----------|-----------|
| `swift_enabled` per bot | Omitted | Swift is a platform optimization, not a per-bot feature. Global env var toggle is simpler and more reliable. |
| `swift_status` on bot_trades | Omitted | The `executionMethod` column tells us whether Swift was used. The Swift API response status is logged to console. Add if debugging requires it. |
| `swift_submitted_at` / `swift_filled_at` | Omitted | `executed_at` already exists. Auction duration is captured in `auctionDurationMs`. Sub-second timing not needed for V1. |
| `fallback_reason` on bot_trades | Omitted | Fallback reasons are logged to console with full context. DB column adds schema complexity without clear V1 benefit. |
| `keeper_pubkey` on bot_trades | Omitted | Keeper identity is informational only. No V1 use case requires querying by keeper. |
| `swift_order_logs` table | Deferred | Full audit log table adds schema complexity. Console logs + `executionMethod` on `bot_trades` provide sufficient traceability for V1. Add when debugging requires queryable audit trail. |

---

## What This Plan Does NOT Cover (Future Work)

These are explicitly deferred to keep the initial integration focused:

1. **Per-bot Swift toggle in UI** — Not needed for V1. Swift is a platform-level optimization.
2. **Swift-only mode (disable legacy)** — Only after months of proven Swift stability.
3. **Spot market Swift support** — Not confirmed live yet. Add when Drift announces.
4. **Swift audit log table** — Add if debugging requires more granularity than `bot_trades.executionMethod` provides.
5. **Frontend execution method display** — Nice-to-have, add to trade history table later.
6. **Persistent metrics (DB-backed)** — In-memory metrics are fine for V1. Persist if needed for historical analysis.
7. **Partial fill handling** — Swift typically fills fully for the order sizes QuantumVault uses. Handle if it becomes an issue in practice.

---

## Dependencies & Prerequisites

Before starting Step 1:

- [ ] Drift SDK version supports Swift methods (`encodeSwiftOrderParamsMessage`, `signSignedMsgOrderParamsMessage`)
  - **Check:** `npm list @drift-labs/sdk` and verify version includes Swift support
- [ ] Swift API endpoint (`https://swift.drift.trade`) is accessible from production server
  - **Check:** `curl -s https://swift.drift.trade/health` returns a response
- [ ] Subscriber routing fix is deployed to production (currently blocked)
  - **Reason:** Steps 4-6 need subscriber routing working to verify end-to-end
- [ ] External audit of this plan is complete

---

## Timeline Estimate

| Step | Effort | Dependencies |
|------|--------|--------------|
| Step 1: Schema migration | 1 hour | None |
| Step 2: Config module | 2-3 hours | None |
| Step 3: Swift executor | 1-2 days | SDK version verified |
| Step 4: executePerpOrder wrapper | 1 day | Steps 1-3 |
| Step 5: Trade logging | 2-3 hours | Step 4 |
| Step 6: Retry integration | 3-4 hours | Step 4 |
| Step 7: Metrics | 3-4 hours | Steps 4-6 (must be ready before activation) |
| Step 8: Controlled activation | 2-3 days monitoring | Steps 1-7 deployed |
| Step 9: Builder codes | 1-2 hours | Step 8 stable |

**Total development:** ~4-5 days of implementation + 3 days of monitoring  
**Total elapsed:** ~2 weeks including buffer and monitoring

---

## Document History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-02-09 | Initial integration plan based on migration plan v3.0 audit findings |

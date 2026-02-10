# QuantumVault Platform Fee Plan

## 1. Overview

QuantumVault has two independent revenue streams:

1. **Platform Performance Fee** — A percentage-based fee on trade notional value, charged by QuantumVault to users. Scales with active user count to align platform growth with user benefit.
2. **Drift Builder Code (DBC) Revenue** — Per-order fees earned from Drift Protocol for routing Swift trades. Paid by the protocol's fee infrastructure, not directly by users.

Both revenue streams can operate independently or together. The platform fee is the primary revenue model. Builder Code revenue is supplementary and only applies to Swift orders.

---

## 2. Platform Performance Fee

### Fee Tiers (by Active User Count)

| Phase | Active Users | Fee Rate | Purpose |
|-------|-------------|----------|---------|
| **Developer Preview** | Current | 0.0% | Testing, iteration, early adopters |
| **Bootstrapping** | 0–100 | 0.1% | Minimal fee to cover infrastructure costs |
| **Sustainability** | 101–200 | 0.3% | Sustain development and operations |
| **Maturity** | 201–300 | 1.0% | Full revenue generation |
| **Efficiency** | 300+ | 0.3% (floor) | Reward network scale, attract volume |

### Active User Definition

A user is "active" if they have **at least 1 bot running in the last 30 days**. This is already tracked by the platform analytics system (`calculatePlatformStats` in storage).

### Fee Application

- Fee is applied as a percentage of **trade notional value** (contract size * fill price)
- Charged on **both opens and closes** (consistent with Drift's own fee model)
- Deducted from the user's agent wallet balance at time of trade execution
- Separate from and additive to Drift Protocol's own trading fees (currently ~0.045% after referral discount)

### Implementation Notes

- Current constant `DRIFT_FEE_RATE = 0.00045` in `server/routes.ts` represents the Drift protocol fee estimate only
- Platform fee would be a separate charge, not bundled into the Drift fee constant
- Fee tier lookup should query the current active user count and return the applicable rate
- Fee collection destination: the QuantumVault platform wallet (`AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez`)
- Fee should be collected via on-chain USDC transfer from the user's agent wallet to the platform wallet after successful trade execution
- Must handle insufficient balance gracefully — fee collection failure should not block trade execution

### Transition Plan

1. **Preview → Bootstrapping**: Announce fee introduction in advance, give users time to prepare
2. **Tier changes**: Automatic based on active user count, checked daily during analytics calculation
3. **Transparency**: Display current fee tier and rate in the UI (Settings or Dashboard)
4. **Grace period**: Consider a 7-day notice before each tier increase

---

## 3. Drift Builder Code (DBC) Revenue

### What It Is

Drift Builder Codes allow third-party apps (like QuantumVault) to earn per-order fees when routing trades through Drift. This is Drift's incentive for builders to route order flow through their protocol.

### How It Works

#### One-Time Setup (Platform Side)

1. **QuantumVault registers as a builder** with Drift Protocol using the platform wallet (`AqTTQQajeKDjbDU5sb6JoQfTJ8HfHzpjne2sFmYthCez`)
2. Create a `RevenueShareAccount` on-chain — this is where builder fees accumulate
3. Registration is done via Drift SDK: `driftClient.initializeRevenueShare(builderAuthority)`

#### Per-User Setup (User Side)

1. Each user must initialize a `RevenueShareEscrow` account (one-time, on-chain)
2. The user must **approve QuantumVault as a builder** and set a **maximum fee cap** (in basis points)
3. Done via: `driftClient.initializeRevenueShareEscrow(takerAuthority, numOrders)`
4. Users can approve multiple builders simultaneously

#### Per-Trade Flow

1. Swift orders include `builderIdx` (QuantumVault's builder ID) and `builderFee` (in bps) in order params
2. The user's `RevenueShareEscrow` PDA is included in the transaction
3. On fill, fees are credited to the escrow as a `RevenueShareOrder`
4. During `settle_pnl`, accrued fees are swept from escrow to QuantumVault's `RevenueShareAccount`

#### Key Constraints

- **Swift orders only** — Builder codes currently only work with Swift orders, not legacy on-chain transactions
- **User approval required** — Users must explicitly approve the builder and fee cap; exceeding the cap fails the transaction
- **Market makers must include escrow** — Fillers must include the `RevenueShareEscrow` PDA in fill transactions (derived from user pubkey, no RPC call needed)

### Fee Setting Strategy

Builder fees are configured in **tenth of a basis point** (`feeTenthBps` in the SDK). So `10 feeTenthBps = 1 bps = 0.01%`.

| Strategy | Builder Fee | SDK Value (`feeTenthBps`) | Notes |
|----------|------------|--------------------------|-------|
| **Zero fee (preview)** | 0 bps | 0 | Register builder but charge nothing initially |
| **Minimal** | 1–2 bps (0.01–0.02%) | 10–20 | Barely noticeable, accumulates at scale |
| **Moderate** | 3–5 bps (0.03–0.05%) | 30–50 | Meaningful revenue, still competitive |
| **Aggressive** | 5–10 bps (0.05–0.1%) | 50–100 | Higher revenue but may deter sophisticated traders |

Recommendation: Start at **0 feeTenthBps** during developer preview (register the builder code but don't charge), then introduce 10–30 feeTenthBps (1–3 bps) when the platform fee goes live at bootstrapping phase.

### SDK Field Reference

The Drift SDK `SignedMsgOrderParamsMessage` type accepts these builder fields:
- `builderIdx: number` — Numeric index of the builder in the user's approved builders list (set during on-chain registration)
- `builderFeeTenthBps: number` — Fee amount in 1/10th of a basis point

These go on the **Swift message** (not the order params). The `builderAuthority` (public key) is only used during on-chain registration, not in order submission.

### Relationship to Platform Fee

- Builder Code fees and Platform Performance fees are **independent**
- Builder Code fees are handled entirely on-chain by Drift's program
- Platform Performance fees are handled by QuantumVault's trade execution logic
- Users experience both as part of the total cost of trading on the platform
- Total user cost per trade = Drift protocol fee (~4.5 bps) + Platform fee (0–100 bps) + Builder fee (0–10 bps)

---

## 4. Creator Profit Sharing (Existing)

The marketplace already has a profit sharing system for signal bot creators:

- Creators set a **0–10% profit share** on their published bots
- When a subscriber closes a profitable trade, the configured percentage of realized PnL is sent to the creator
- Transfer is immediate on-chain USDC via the subscriber's agent wallet → creator's main wallet
- Failed transfers create IOU records for automatic retry (every 5 minutes)
- Dust threshold: amounts below $0.01 are skipped

**Platform fee interaction**: When platform fees are introduced, the platform fee should be calculated on the full trade notional, not reduced by profit share amounts. Profit sharing is between creator and subscriber, platform fee is between platform and trader.

---

## 5. Revenue Flow Summary

```
Trade Execution
    │
    ├─── Drift Protocol Fee (~0.045%)
    │    └─ Paid to Drift (with 10% referral discount applied)
    │
    ├─── Platform Performance Fee (0–1.0%)
    │    └─ USDC transfer: user agent wallet → platform wallet
    │    └─ Rate determined by active user tier
    │
    ├─── Builder Code Fee (0–10 bps)
    │    └─ Accrued in RevenueShareEscrow → settled to RevenueShareAccount
    │    └─ Only on Swift orders
    │
    └─── Creator Profit Share (0–10% of realized PnL)
         └─ Only on profitable subscriber closes
         └─ USDC transfer: subscriber agent wallet → creator main wallet
```

---

## 6. Implementation Phases

### Phase 1: Builder Code Registration (Can Do Now)
- Register QuantumVault as a Drift builder on-chain using `driftClient.initializeRevenueShare(builderAuthority)`
- Set builder fee to 0 feeTenthBps (no charge during preview)
- Code-side support already implemented: `builderIdx` and `builderFeeTenthBps` added to Swift message in `swift-executor.ts`
- Activate via env vars: `SWIFT_BUILDER_ENABLED=true`, `SWIFT_BUILDER_IDX=<idx>`, `SWIFT_BUILDER_FEE_TENTH_BPS=<fee>`
- No user-facing changes needed yet (fee is 0)
- **Prerequisite**: Each user's `RevenueShareEscrow` must be initialized and must approve the builder — can be done lazily during first Swift trade

### Phase 2: User Escrow Initialization (With Builder Code)
- Add `RevenueShareEscrow` initialization to user onboarding flow (when agent wallet is created)
- Include escrow PDA in Swift order transactions
- This is invisible to users if builder fee is 0

### Phase 3: Platform Fee Introduction (Bootstrapping Phase)
- Implement fee tier lookup based on active user count
- Add fee calculation to trade execution flow (after successful trade, before stats update)
- Add fee collection: USDC transfer from agent wallet to platform wallet
- Add fee display in UI (current tier, rate, total fees paid)
- Announce to users with advance notice

### Phase 4: Builder Fee Activation (With Platform Fee)
- Increase builder fee from 0 to 1–3 bps
- Bundle builder approval into user onboarding alongside platform fee disclosure
- Display combined fee breakdown in UI

### Phase 5: Dynamic Fee Management
- Admin controls for fee tier thresholds and rates
- Fee analytics dashboard
- Volume-based discounts or loyalty tiers (future)

---

## 7. Key Files

| File | Relevance |
|------|-----------|
| `server/routes.ts` | Trade execution, fee calculation, profit sharing |
| `server/swift-executor.ts` | Swift order submission — add `builderIdx`/`builderFee` here |
| `server/drift-service.ts` | Drift SDK interaction, `executePerpOrder`/`closePerpPosition` |
| `server/storage.ts` | `calculatePlatformStats()` for active user count |
| `server/swift-config.ts` | Swift configuration — add builder config here |
| `shared/schema.ts` | Database schema for fee tracking tables |
| `client/src/pages/PitchDeck.tsx` | Revenue model presentation (source of tier structure) |

---

## 8. Open Questions

1. **Fee collection timing**: Collect fee immediately after trade execution, or batch at end of day/session?
2. **Fee on subscriber trades**: Should platform fee apply to subscriber-routed trades, or only direct trades?
3. **Builder fee cap**: What max fee cap should users approve? (Higher cap = more flexibility, but may concern users)
4. **Fee transparency**: Show fee breakdown per-trade in trade history, or just aggregate in settings?
5. **Referral interaction**: Should users referred by existing users get a fee discount?

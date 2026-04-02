# Pacifica DEX Integration — Migration Scope & Architecture Document

**Date:** April 2026
**Context:** Drift Protocol hack (~$270M). Evaluating Pacifica.fi as primary DEX replacement for QuantumVault perpetual futures trading.

---

## Key Links

| Resource | URL |
|----------|-----|
| API Documentation | https://docs.pacifica.fi/api-documentation/api |
| Builder Program | https://docs.pacifica.fi/builder-program |
| Python SDK | https://github.com/pacifica-fi/python-sdk |
| Testnet App | https://test-app.pacifica.fi (access code: `Pacifica`) |
| Mainnet App | https://app.pacifica.fi |
| Referral Dashboard | https://app.pacifica.fi/referral |
| API Key Management | https://app.pacifica.fi/apikey |
| Contract Specifications | https://docs.pacifica.fi/trading-on-pacifica/contract-specifications |
| Trading Fees | https://docs.pacifica.fi/trading-on-pacifica/trading-fees |
| Referral & Affiliate | https://docs.pacifica.fi/referral-and-affiliate-program |

### Partner / Infrastructure Tools

| Partner | Purpose | URL |
|---------|---------|-----|
| Fuul | Referral & points program provider (on-chain tracking, anti-sybil, payout automation) | https://fuul.xyz |
| Rhinofi | Cross-chain bridge & interoperability (deposit path for non-Solana assets) | https://rhino.fi |
| Privy | Privacy & secure auth toolkit (embedded wallets, email/social onboarding) | https://privy.io |

---

## 1. Why Pacifica

| Criteria | Pacifica | GMTrade | Verdict |
|----------|----------|---------|---------|
| Public REST API | Yes — full CRUD | No public API | Pacifica |
| WebSocket feeds | Yes — orderbook, trades, fills, account | Unknown | Pacifica |
| SDK | Python SDK (GitHub), no TS SDK yet | None | Pacifica |
| Auth model | Solana wallet signatures + Agent Wallets | Raw Anchor calls | Pacifica |
| Subaccounts | Yes — create + fund transfer API | Unknown | Pacifica |
| Markets | 59 perp pairs | 86 pairs | GMTrade has more |
| Volume (24h) | ~$1B | ~$554M | Pacifica |
| Leverage | 3x–50x | Up to 500x | GMTrade |
| Testnet | Yes (`test-api.pacifica.fi`) | Unknown | Pacifica |
| Builder Program | Yes — fee revenue + points | Unknown | Pacifica |

**GMTrade is ruled out** — no public API means we'd need to reverse-engineer their Anchor program IDL. Not viable for production trading bots.

---

## 2. Pacifica API Overview

### Base URLs

| Environment | REST | WebSocket |
|-------------|------|-----------|
| Mainnet | `https://api.pacifica.fi/api/v1` | `wss://ws.pacifica.fi/ws` |
| Testnet | `https://test-api.pacifica.fi/api/v1` | `wss://test-ws.pacifica.fi/ws` |

### REST Endpoints

| Category | Endpoint | Method | Notes |
|----------|----------|--------|-------|
| **Markets** | `/info` | GET | All available trading pairs (verified live) |
| | `/prices` | GET | Current prices |
| | `/klines` | GET | OHLCV candle data |
| | `/book` | GET | Orderbook snapshot |
| | `/trades` | GET | Recent trades |
| | `/funding` | GET | Historical funding rates |
| **Account** | `/account` | GET | Balance, equity, margin, fee tier |
| | `/account/settings` | GET | Current account settings |
| | `/account/leverage` | POST | Update leverage per market |
| | `/account/margin_mode` | POST | Switch cross/isolated |
| | `/positions` | GET | Open positions |
| | `/account/trades` | GET | Trade history |
| | `/account/funding` | GET | Funding payment history |
| | `/account/equity_history` | GET | Equity over time |
| | `/account/balance_history` | GET | Balance over time |
| | `/account/withdraw` | POST | Request withdrawal |
| **Subaccounts** | `/subaccounts/create` | POST | Create subaccount |
| | `/subaccounts/transfer` | POST | Transfer funds between main ↔ sub |
| **Orders** | `/orders/create_market` | POST | Market order (with optional TP/SL) |
| | `/orders/create` | POST | Limit order (GTC/IOC/ALO/TOB) |
| | `/orders/create_stop` | POST | Stop order |
| | `/orders/tp_sl` | POST | Set TP/SL on existing position |
| | `/orders/cancel` | POST | Cancel single order |
| | `/orders/cancel_all` | POST | Cancel all orders |
| | `/orders/cancel_stop` | POST | Cancel stop order |
| | `/orders/batch` | POST | Batch order operations |
| | `/orders/open` | GET | Open orders |
| | `/orders/history` | GET | Order history |
| | `/orders/history/{id}` | GET | Order by ID |
| **API Keys** | `/account/api_keys/create` | POST | Create API config key |
| | `/account/api_keys/revoke` | POST | Revoke API config key |

### WebSocket Channels

| Channel | Type | Payload |
|---------|------|---------|
| `orderbook` | Public | 10-level depth, bids + asks |
| `trades` | Public | Real-time trade stream |
| `bbo` | Public | Best bid/offer |
| `candle` | Public | Live OHLCV updates |
| `account_trades` | Private | Personal fill events |
| `account_orders` | Private | Order state changes |
| `account_positions` | Private | Position updates |

---

## 3. Authentication & Agent Wallet Model

### How Pacifica Auth Works

All POST requests require a **Solana Ed25519 signature** over a canonicalized JSON payload:

1. Build the request payload (account, timestamp, symbol, amount, etc.)
2. Remove the `signature` field
3. **Recursively sort all JSON keys alphabetically**
4. Create compact JSON string (no spaces)
5. Sign the UTF-8 bytes with Ed25519 private key
6. Base58-encode the 64-byte signature

### Agent Wallet Delegation

Pacifica natively supports **agent wallets** — exactly what we already use:

- Generate an agent keypair (Solana Ed25519)
- Register via UI at `app.pacifica.fi/apikey` or via API
- For all POST requests, sign with the **agent wallet's private key** and include `agent_wallet: <AGENT_PUBKEY>` in the payload
- The `account` field still contains the **main wallet address**

### Builder Code Integration

When using the Builder Program (see Section 15), orders can include a `builder_code` parameter. The user must first sign an approval payload authorizing the builder code and a `max_fee_rate`. This is included in the canonical signing payload under a `data` object.

**Impact on QuantumVault:** Our existing `server/agent-wallet.ts` generates Solana keypairs and manages encryption. The keypair generation and storage is **fully reusable**. We only need to:
- Add a registration step (register the agent wallet pubkey with Pacifica)
- Implement the canonical JSON signing function (different from Drift's SDK-based signing)
- Include `builder_code` in order payloads if enrolled in Builder Program

### Key Difference from Drift

| | Drift | Pacifica |
|---|---|---|
| Auth method | SDK-managed (DriftClient handles signing internally) | Manual Ed25519 over canonical JSON |
| Agent concept | Drift subaccounts with delegate authority | Agent wallet pubkey registered via API |
| On-chain setup | Initialize user account + subaccounts on-chain | Deposit triggers account creation; subaccounts via API |

---

## 4. Subaccount System

### Drift's Model (Current)
- Subaccounts are **on-chain Solana accounts** (PDA derived from wallet + subAccountId)
- Each bot gets assigned a `subAccountId` (0, 1, 2, ...)
- Creating a subaccount requires an on-chain transaction (~0.02 SOL rent)
- Positions, orders, and balances are per-subaccount
- We do custom byte-parsing of on-chain User accounts to read positions

### Pacifica's Model
- Subaccounts are created via REST API (`POST /subaccounts/create`)
- Fund transfer between main ↔ sub via REST API (`POST /subaccounts/transfer`)
- **No on-chain transaction needed** to create subaccounts — purely off-chain
- All subaccounts share the same fee tier as the master account
- Subaccount volumes count toward master account fee tier

### Do We Still Need Subaccounts?

**Yes, but the implementation is simpler.** Our bot isolation model (each bot trades in its own subaccount to prevent margin cross-contamination) maps cleanly to Pacifica's subaccount system. The big win is:
- No on-chain initialization transactions
- No rent costs
- No byte-parsing of on-chain account data
- Simple REST calls instead of Solana RPC

**Migration consideration:** We need to map our existing `subAccountId` integer system to whatever identifier Pacifica returns for subaccounts (likely a string/address). The `bots` table schema may need a `pacifica_subaccount_id` column.

---

## 5. Market Coverage Gap Analysis

### Markets We Currently Trade (Drift)

Our `market-registry.ts` has 70 perp markets. The ones actively used by bots:

| Market | Drift Index | Used By |
|--------|-------------|---------|
| SOL-PERP | 0 | Primary — most bot strategies |
| BTC-PERP | 1 | Active |
| ETH-PERP | 2 | Active |
| AVAX-PERP | 22 | Active (AVAX bot) |

### Pacifica Live Markets (Verified April 2026)

**63 perp pairs** confirmed via live API call to `GET https://api.pacifica.fi/api/v1/info`

#### Critical Markets — All Confirmed Available

| Market | Pacifica Symbol | Max Leverage | Min Order | Tick Size | Lot Size |
|--------|----------------|-------------|-----------|-----------|----------|
| SOL | `SOL` | 20x | $10 | 0.01 | 0.01 |
| BTC | `BTC` | 50x | $10 | 1 | 0.00001 |
| ETH | `ETH` | 50x | $10 | 0.1 | 0.0001 |
| AVAX | `AVAX` | 10x | $10 | 0.001 | 0.01 |

**All four actively traded markets are available.**

#### Full Market List (63 markets)

**Crypto (42):** 2Z, AAVE, ADA, ARB, ASTER, AVAX, BCH, BNB, BTC, CRCL, CRV, DOGE, ENA, ETH, FARTCOIN, HYPE, ICP, JUP, kBONK, kPEPE, LDO, LINK, LIT, LTC, MEGA, MON, NEAR, PAXG, PENGU, PIPPIN, PUMP, SOL, STRK, SUI, TAO, TRUMP, UNI, VIRTUAL, WIF, WLFI, WLD, XMR, XPL, XRP, ZEC, ZK, ZRO

**Equities (5):** GOOGL, HOOD, NVDA, PLTR, TSLA

**Commodities (7):** CL (Crude Oil), COPPER, NATGAS, PLATINUM, URNM (Uranium), XAG (Silver), XAU (Gold)

**Forex (2):** EURUSD, USDJPY

**Indices (1):** SP500

**Misc (1):** BP

#### Coverage Gap: Drift Markets NOT on Pacifica (39 markets)

These markets exist on Drift but are NOT available on Pacifica:

`AI16Z, APT, CLOUD, DBR, DRIFT, DYM, FWOG, GOAT, HNT, INJ, IO, IP, JTO, KAITO, KMNO, LAUNCHCOIN, ME, MELANIA, MET, MEW, MICHI, MNT, MOODENG, MOTHER, OP, PNUT, POL, POPCAT, PYTH, RAY, RENDER, RLB, SEI, TIA, TNSR, TON, W, WEN, ZEX`

Most of these are low-cap Solana ecosystem tokens. None are actively traded by our bots. **No impact on current operations.**

#### New Markets Available on Pacifica (34 not on Drift)

`AAVE, BCH, BP, CL, COPPER, CRCL, CRV, ENA, EURUSD, GOOGL, HOOD, ICP, LDO, MEGA, NATGAS, NEAR, NVDA, PIPPIN, PLATINUM, PLTR, SP500, STRK, TSLA, UNI, URNM, USDJPY, VIRTUAL, WLD, WLFI, XAG, XAU, XMR, ZK, ZRO`

Notable additions: **Equities** (TSLA, NVDA, GOOGL, PLTR, HOOD), **Commodities** (Gold, Silver, Oil, Gas, Copper), **Forex** (EUR/USD, USD/JPY), **Index** (S&P 500). These could open new strategy possibilities.

### Symbol Mapping Required

| Our Format (Drift) | Pacifica Format | Notes |
|--------------------|-----------------|---------| 
| `SOL-PERP` | `SOL` | Strip `-PERP` suffix |
| `BTC-PERP` | `BTC` | Strip `-PERP` suffix |
| `1MBONK-PERP` | `kBONK` | Denomination change: `1M` → `k` |
| `1MPEPE-PERP` | `kPEPE` | Denomination change: `1M` → `k` |

Simple adapter: strip `-PERP` suffix for most, handle `1M→k` prefix for BONK/PEPE.

### Leverage Differences

| Market | Drift Max | Pacifica Max | Notes |
|--------|----------|-------------|-------|
| SOL | 20x | 20x | Same |
| BTC | 20x | 50x | Pacifica higher |
| ETH | 20x | 50x | Pacifica higher |
| AVAX | 10x | 10x | Same |

### API Endpoint Correction

The correct markets endpoint is `GET /api/v1/info` (not `/api/v1/markets` or `/api/v1/info/markets` as stated in some docs). Verified via live API call.

---

## 6. Fee Structure

| Tier | 14-Day Volume | Maker | Taker |
|------|---------------|-------|-------|
| 1 | $0+ | 0.015% (1.5 bps) | 0.040% (4.0 bps) |
| 2 | >$5M | 0.012% (1.2 bps) | 0.038% (3.8 bps) |
| 3 | >$10M | 0.009% (0.9 bps) | 0.036% (3.6 bps) |
| 4+ | Higher tiers available | Lower | Lower |

### Comparison with Drift

- Drift base taker fee: ~0.05% (5 bps) for most markets
- Pacifica base taker fee: 0.04% (4 bps) — **slightly cheaper**
- Our current commission constant: `0.0005` (5 bps) — would need updating to `0.0004` for Pacifica
- Market maker program available (opt-in, potential zero maker fees)

### Funding Rates
- **Hourly** funding interval (Drift uses variable intervals)
- Based on gap between orderbook impact prices and oracle prices

---

## 7. Deposit & Withdrawal

| Parameter | Value |
|-----------|-------|
| Collateral | USDC (Solana-native) |
| Minimum deposit | $10 |
| Minimum withdrawal | $1 |
| Withdrawal fee | $1 flat |
| Max account equity (Beta) | $100,000 |
| Max withdrawal/24h (Beta) | $100,000 |
| Settlement | On-chain (Solana) |

### Deposit Flow
1. Connect wallet / sign with agent wallet
2. Send USDC to Pacifica's bridge contract (on-chain Solana transaction)
3. Balance appears in account after on-chain confirmation

### Cross-Chain Deposits
Pacifica partners with **Rhinofi** (rhino.fi) for cross-chain bridging. Users can bridge assets from other chains into Solana USDC. For QuantumVault this is less relevant since our agent wallets already hold Solana-native USDC.

### Key Concern: $100K Equity Cap (Beta)
During beta, accounts are capped at $100K equity. For larger portfolios, this is a constraint. Need to verify if this cap has been lifted or when it will be.

### Impact on QuantumVault
Our current deposit flow (`buildDepositTransaction` / `executeAgentDriftDeposit`) sends USDC to Drift's on-chain program. Pacifica's deposit is similar — send USDC to their bridge contract. The `agent-wallet.ts` USDC transfer logic is mostly reusable; we just change the destination.

---

## 8. Revenue Model — How QuantumVault Makes Money

### Current Model (Drift)

QuantumVault earns revenue through the `kryptolytix` referral code hardcoded into `drift-service.ts`. Every user account initialized through the platform gets this referral baked in at the **on-chain level**:

- **Referrer earns:** 15% of taker fees on every trade
- **User gets:** 5% fee discount
- **Mechanism:** On-chain PDA (`ReferrerName`) set during `initialize_user` instruction on subaccount 0
- **Permanence:** Once set, it's permanent — embedded in the on-chain account state
- **Revenue is automatic:** No manual tracking, no off-chain attribution

### Pacifica Options (Three Tiers)

#### Tier 1: Standard Referral (Open to all)

| Detail | Value |
|--------|-------|
| Eligibility | $10,000 in trading volume |
| Codes available | Up to 20 referral codes + 1 link |
| Referrer reward | 10% of referred users' **points** |
| Referee bonus | 5% bonus in points |
| Distribution | Weekly, automatic |
| Application | None — self-serve at `app.pacifica.fi/referral` |

**Assessment:** This is a **points-based** reward, not direct fee revenue. Points are part of Pacifica's token incentive system. Weaker than Drift's direct USDC fee share. Not a primary revenue path.

#### Tier 2: Affiliate Program (Selective)

| Detail | Value |
|--------|-------|
| Fee share | Up to **40%** of trading fees from referred users |
| Scaling | Scales with total referred volume |
| Spots | Limited — selective approval |
| Target | KOLs, community owners, large trading communities |
| Application | Discord ticket or contact ops@pacifica.fi |

**Assessment:** Potentially **better** than Drift's 15% — up to 40% fee share. But it's selective, requires approval, and the fee-share percentage scales (you don't start at 40%). There's also a catch: if a referred user reaches VIP fee tier or joins the market maker program, the affiliate **stops earning** from them.

#### Tier 3: Builder Program (Best Fit for QuantumVault)

| Detail | Value |
|--------|-------|
| Revenue mechanism | Custom `fee_rate` charged on all orders routed through your builder code |
| Points | Eligible for point rewards for significant contributions |
| Integration | `builder_code` parameter added to order payloads |
| User authorization | Users sign approval for your builder code + max fee rate |
| Application | ops@pacifica.fi, Discord ticket, or @PacificaTGPortalBot on Telegram |

**How it works:**
1. Apply to Builder Program → receive a `builder_code`
2. Set your `fee_rate` (e.g., `0.001` = 0.1% additional fee)
3. Users authorize your builder code by signing an approval payload containing your `builder_code` and a `max_fee_rate`
4. All orders placed through your platform include `builder_code` in the payload
5. You earn the `fee_rate` on every order routed through your code

**Assessment:** This is the **closest equivalent** to our Drift referral model and arguably better:
- Direct fee revenue (not points)
- You control the fee rate
- Applied per-order, not per-account-creation
- Works regardless of user's VIP tier
- No expiration or cutoff

### Revenue Model Comparison

| | Drift (Current) | Pacifica Builder | Pacifica Affiliate |
|---|---|---|---|
| Revenue type | 15% of taker fees | Custom fee_rate per order | Up to 40% of fees |
| Mechanism | On-chain referral PDA | `builder_code` in API payload | Off-chain attribution |
| Permanence | Permanent (on-chain) | Per-order (code must be included) | Subject to VIP/MM cutoff |
| Control | Fixed 15% | You set the rate | Scales with volume |
| Application | None (open) | Required (Builder Program) | Required (selective) |
| Risk | None once set | Must include code in every order | Loses rev if user hits VIP |

### Recommended Approach

1. **Apply to Builder Program first** — this is a prerequisite before migration makes financial sense
2. **Also apply to Affiliate Program** — layered revenue (affiliate attribution + builder fee)
3. Builder code integration is straightforward — just an extra field in order payloads
4. Since we control the order creation code, `builder_code` inclusion is guaranteed for all bot trades

### Implementation Impact

Minimal code change. In `pacifica-service.ts`, every order creation call includes:
```
builder_code: PLATFORM_BUILDER_CODE
```
Users authorize once via a signed approval payload during bot setup. This replaces the current Drift `initialize_user` referral PDA logic.

---

## 9. Current Drift Integration — What Needs to Change

### File-by-File Impact Assessment

#### Server — Core Drift Files (Delete/Replace)

| File | Lines | Migration Action | Replaces With |
|------|-------|-----------------|---------------|
| `drift-service.ts` | 4,120 | **Full rewrite** | `pacifica-service.ts` |
| `drift-executor.mjs` | 2,229 | **Delete** | Not needed — Pacifica is REST, no subprocess |
| `swift-executor.ts` | 425 | **Delete** | No equivalent |
| `swift-config.ts` | 164 | **Delete** | No equivalent |
| `swift-metrics.ts` | ~100 | **Delete** | No equivalent |
| `drift-price.ts` | 208 | **Rewrite** | `pacifica-price.ts` |
| `drift-data-api.ts` | 190 | **Rewrite** | Pacifica equity/trade history endpoints |

#### Server — Dependent Services (Adapt)

| File | Lines | Drift Coupling | Migration Effort | Notes |
|------|-------|----------------|------------------|-------|
| `agent-wallet.ts` | 511 | **Low** | **Minor** | Add Pacifica canonical JSON signing |
| `market-registry.ts` | 187 | **High** | **Rewrite** | Numeric indices → string symbols |
| `position-service.ts` | 450 | **High** | **Rewrite** | REST calls instead of byte parsing |
| `reconciliation-service.ts` | 788 | **High** | **Rewrite** | REST-based position/balance checks |
| `trade-retry-service.ts` | 1,084 | **Medium** | **Adapt** | Error codes change, retry logic stays |
| `leverage-cache-service.ts` | 212 | **High** | **Rewrite** | Use `POST /account/leverage` |
| `market-liquidity-service.ts` | 546 | **High** | **Rewrite** | Use Pacifica orderbook endpoint |
| `portfolio-snapshot-job.ts` | 126 | **Medium** | **Adapt** | Change to Pacifica account calls |
| `pnl-snapshot-job.ts` | 148 | **Medium** | **Adapt** | Change to Pacifica position data |
| `analytics-indexer.ts` | 250 | **Medium** | **Adapt** | Change data source |
| `orphaned-subaccount-cleanup.ts` | 83 | **High** | **Rewrite** | Pacifica subaccount cleanup via API |
| `profit-share-retry-job.ts` | ~150 | **Low** | **Minor** | Profit share logic is exchange-agnostic |

#### Server — Routes (Significant Refactor)

| Area | Endpoint Pattern | Count | Notes |
|------|-----------------|-------|-------|
| Deposit/Withdraw | `/api/agent/drift-deposit`, `/api/agent/drift-withdraw` | 2 | Rename + rewire to Pacifica |
| Bot Balance | `/api/bots/:id/drift-balance` | 1 | Rename + rewire |
| Agent Balance | `/api/agent/drift-balance` | 1 | Rename + rewire |
| Markets | `/api/drift/markets`, `/api/drift/markets/:symbol` | 2 | Rename + rewire to Pacifica markets |
| Leverage | `/api/drift/leverage-limits` | 1 | Rename + use Pacifica leverage data |
| Non-tradable | `/api/drift/non-tradable-markets` | 1 | Rename + adapt |
| USDC APY | `/api/drift/usdc-apy` | 1 | Remove (Drift-specific lending feature) |
| User Deposit/Withdraw | `/api/drift/deposit`, `/api/drift/withdraw`, `/api/drift/balance` | 3 | Rename + rewire |
| Account Reset | `/api/wallet/reset-drift-account` | 1 | Rethink — Pacifica has no on-chain account to reset |
| Cache Status | `/api/drift/markets/cache/status` | 1 | Rename |
| Swift Metrics | Admin swift metrics endpoint | 1 | Remove |
| Trade Execution | Webhook handler, `computeTradeSizingAndTopUp` | — | Rewire execution calls |

**Total: 15+ Drift-named API endpoints to rename/rewire**

#### Client — Frontend Files (16 files total)

| File | Drift Refs | Migration Effort | Notes |
|------|-----------|------------------|-------|
| `lib/drift-constants.ts` | **Complete** | **Rewrite** | Rename to `exchange-constants.ts`; replace `DRIFT_LEVERAGE_TIERS` with Pacifica limits |
| `hooks/useLeverageLimits.ts` | **High** | **Adapt** | Update import + API endpoint reference |
| `lib/strategy-insights.ts` | **Medium** | **Adapt** | Uses `getDriftMaxLeverage` |
| `components/BotManagementDrawer.tsx` | **High** | **Adapt** | 6 Drift API calls, "Drift balance" UI labels |
| `components/CreateBotModal.tsx` | **Medium** | **Adapt** | Calls `/api/drift/markets`, `/api/agent/drift-deposit` |
| `pages/WalletManagement.tsx` | **High** | **Adapt** | "Drift deposit/withdraw" labels and API calls |
| `pages/App.tsx` | **Medium** | **Adapt** | "Reset Drift Account" flow, `driftSubaccountId` in TradingBot type |
| `pages/Docs.tsx` | **High** | **Rewrite** | 50 references to Drift/Swift in documentation content |
| `pages/QuantumLab.tsx` | **Low** | **Adapt** | Calls non-tradable markets + deposit endpoints |
| `hooks/useApi.ts` | **Low** | **Adapt** | `HealthMetrics.marketIndex` type reference |
| `pages/PitchDeck.tsx` | **Medium** | **Adapt** | 13 Drift references in pitch content |
| `pages/Landing.tsx` | **Low** | **Adapt** | 3 Drift references in landing copy |
| `pages/Analytics.tsx` | **Low** | **Adapt** | 1 Drift reference |
| `pages/Admin.tsx` | **Low** | **Adapt** | 1 Drift reference |
| `components/SubscribeBotModal.tsx` | **Low** | **Adapt** | 1 Drift reference |
| `components/WelcomePopup.tsx` | **Low** | **Adapt** | 1 Drift reference |
| `components/EquityHistory.tsx` | **Low** | **Adapt** | 2 Drift references |

#### Server — Additional Missed Files

| File | Drift Reference | Notes |
|------|----------------|-------|
| `server/index.ts` | Imports `syncMarketRegistry` from `drift-service` | Startup initialization — must rewire |
| `server/docs-markdown.ts` | Full documentation content references Drift Protocol, Swift, subaccounts | Content rewrite needed |

#### Shared Schema (`shared/schema.ts`)

| Table | Column | Current (Drift) | Migration |
|-------|--------|----------------|-----------|
| `wallets` | `drift_subaccount` | Integer (on-chain PDA index) | Add `pacifica_subaccount_id: text` |
| `trading_bots` | `drift_subaccount_id` | Integer (per-bot subaccount) | Add `pacifica_subaccount_id: text` |
| `bot_trades` | `tx_signature` | Solana tx signature | Keep for deposit/withdraw; add `pacifica_order_id: text` |
| `bot_trades` | `execution_method` | `'legacy'` / `'swift'` | Add `'pacifica'` value |
| `bot_trades` | `swift_order_id` | Swift-specific UUID | Deprecate (nullable, keep for history) |
| `bot_trades` | `auction_duration_ms` | Drift JIT auction param | Deprecate |
| `equity_events` | `tx_signature` | On-chain deposit/withdraw tx | Keep — Pacifica deposits are still on-chain |
| `orphaned_subaccounts` | `drift_subaccount_id` | On-chain PDA index | Replace with `pacifica_subaccount_id` |
| `bot_positions` | `market` | `SOL-PERP` format | Update to bare symbol (`SOL`) or keep and adapt |

#### NPM Dependencies

| Package | Action |
|---------|--------|
| `@drift-labs/sdk` | **Remove** — largest Drift dependency, causes ESM/CJS issues, memory leaks |
| `@solana/web3.js` | **Keep** — still needed for deposit/withdraw on-chain transactions |
| `@coral-xyz/anchor` | **Evaluate** — may not be needed if all Pacifica interaction is REST |
| `bs58` | **Keep** — needed for Base58 signature encoding |
| `tweetnacl` or `@noble/ed25519` | **Add** — for Ed25519 signing (canonical JSON payloads) |

### Total Impact Summary

| Category | Files | Lines |
|----------|-------|-------|
| Server — Delete | 7 files | ~7,436 |
| Server — Rewrite/Adapt | 12 files | ~4,535 |
| Server — Routes | 1 file | 15+ endpoints |
| Client — Adapt | 10 files | Various |
| Schema | 1 file | ~10 column changes |
| New Files | 4 files | ~3,000-4,000 est. |

### What Stays the Same
- `agent-wallet.ts` — keypair generation, encryption, USDC/SOL transfers (mostly unchanged)
- `server/lab/` — QuantumLab backtesting engine (no Drift dependency)
- `shared/schema.ts` — Structure intact, additive column changes only
- Bot management logic — create/start/stop/configure bot workflows
- Strategy engine — signal generation is independent of execution layer
- Notification service — exchange-agnostic
- Profit share system — exchange-agnostic (just needs correct PnL inputs)

---

## 10. Architecture: Pacifica Service Design

### Proposed New Files

| File | Purpose | Replaces |
|------|---------|----------|
| `pacifica-service.ts` | Core service: auth, orders, positions, balances, subaccounts | `drift-service.ts` |
| `pacifica-price.ts` | Price feeds via REST + WebSocket | `drift-price.ts` |
| `pacifica-ws.ts` | WebSocket connection manager for real-time feeds | New (replaces SDK subscriptions) |
| `pacifica-signer.ts` | Canonical JSON signing, Ed25519 signature generation | New (extracted from agent-wallet) |

### Files to Delete
- `drift-service.ts`
- `drift-executor.mjs`
- `drift-price.ts`
- `drift-data-api.ts`
- `swift-executor.ts`
- `swift-config.ts`

### Key Architecture Differences

**Drift (Current):**
```
Bot Signal → drift-service → DriftClient SDK → Solana RPC → On-chain vAMM
                          ↘ drift-executor (subprocess) → SDK → RPC
                          ↘ swift-executor → Swift protocol → Keeper network
```

**Pacifica (Proposed):**
```
Bot Signal → pacifica-service → REST API (HTTPS) → Off-chain orderbook → On-chain settlement
                             ↘ pacifica-ws → WebSocket (fills, positions)
```

The Pacifica architecture is **significantly simpler**:
- No SDK dependency (just HTTP requests)
- No on-chain byte parsing
- No subprocess executors
- No Swift protocol handling
- No Solana RPC calls for trading (only for deposits/withdrawals)
- No memory leak concerns from SDK WebSocket subscriptions

### Signing Module (`pacifica-signer.ts`)

```
Input: payload object + agent keypair
  → Remove "signature" key
  → Recursively sort all keys
  → JSON.stringify with compact separators
  → Ed25519 sign UTF-8 bytes
  → Base58 encode
Output: Base58 signature string
```

This is the most critical new piece. Every authenticated request goes through this.

---

## 11. Database Schema Changes

Schema changes are **additive only** — no column type changes, no drops of existing columns (preserves historical data).

### New Columns

| Table | Column | Type | Purpose |
|-------|--------|------|---------|
| `trading_bots` | `pacifica_subaccount_id` | `text` | Pacifica subaccount identifier (replaces `drift_subaccount_id` for new bots) |
| `wallets` | `pacifica_subaccount_id` | `text` | Master account's Pacifica subaccount |
| `bot_trades` | `pacifica_order_id` | `text` | Pacifica's UUID-based order ID |

### Column Value Changes (No Schema Change)

| Table.Column | Old Values | New Values |
|-------------|------------|------------|
| `bot_trades.execution_method` | `'legacy'`, `'swift'` | Add `'pacifica'` |
| `bot_trades.tx_signature` | Always populated (Solana tx) | Nullable for Pacifica trades (only deposits/withdrawals are on-chain) |
| `bot_trades.swift_order_id` | Swift UUID | Always null for new trades (keep column for history) |
| `bot_positions.market` | `SOL-PERP` format | Could keep as-is or switch to `SOL` — adapter handles conversion |

### Constants

| Constant | Current | New | Location |
|----------|---------|-----|----------|
| Commission rate | `0.0005` (5 bps) | `0.0004` (4 bps) | Configurable per-environment |
| Market format | `SOL-PERP` (with index) | `SOL` (bare symbol) | Market registry |

### Data Migration Notes
- Existing PnL history, trade logs, and snapshots remain valid and untouched
- Old Drift columns (`drift_subaccount_id`, `swift_order_id`, etc.) are kept for historical queries
- No data migration needed — schema is additive only

---

## 12. Migration Strategy — Phased Approach

### Phase 0: Business Prerequisites (Before any code)
- [ ] Apply to Builder Program (ops@pacifica.fi / Discord / Telegram)
- [ ] Apply to Affiliate Program (Discord ticket)
- [ ] Get Builder Code assigned
- [ ] Verify $100K equity cap status
- [ ] Hit testnet `/markets` endpoint to verify SOL, BTC, ETH, AVAX availability
- [ ] Test agent wallet registration flow on testnet

### Phase 1: Foundation (Est. 2-3 days)
- [ ] Implement `pacifica-signer.ts` (canonical JSON + Ed25519 signing)
- [ ] Implement `pacifica-service.ts` core: auth, account info, positions
- [ ] Hit `/markets` endpoint to confirm SOL, BTC, ETH, AVAX availability
- [ ] Verify agent wallet registration flow on testnet
- [ ] Schema migration: add `pacifica_subaccount_id` + `pacifica_order_id` columns
- [ ] Install `@noble/ed25519` or `tweetnacl` for signing

### Phase 2: Trading (Est. 2-3 days)
- [ ] Implement order placement (market, limit) with `builder_code` inclusion
- [ ] Implement position close
- [ ] Implement `pacifica-price.ts` with REST + WS price feeds
- [ ] Implement `pacifica-ws.ts` WebSocket connection manager
- [ ] Port `trade-retry-service.ts` error handling to Pacifica error codes
- [ ] Port `computeTradeSizingAndTopUp` for Pacifica margin model
- [ ] Delete `drift-executor.mjs`, `swift-executor.ts`, `swift-config.ts`, `swift-metrics.ts`

### Phase 3: Account Management (Est. 1-2 days)
- [ ] Implement subaccount create/transfer via REST
- [ ] Port deposit/withdraw flows (keep on-chain USDC transfer, change destination)
- [ ] Implement `reconciliation-service.ts` using REST account/position data
- [ ] Port leverage management (`POST /account/leverage`)
- [ ] Implement builder code user authorization flow
- [ ] Rewrite `orphaned-subaccount-cleanup.ts` for REST-based cleanup

### Phase 4: Route & Frontend Migration (Est. 2-3 days)
- [ ] Rename all 15+ `/api/drift/*` endpoints to `/api/exchange/*` or similar
- [ ] Update all `drift-service` imports in `routes.ts` to `pacifica-service`
- [ ] Remove USDC APY endpoint (Drift-specific)
- [ ] Rethink "Reset Drift Account" flow for Pacifica
- [ ] Rename `client/src/lib/drift-constants.ts` → `exchange-constants.ts`
- [ ] Update `useLeverageLimits.ts` and `strategy-insights.ts` imports
- [ ] Update `BotManagementDrawer.tsx` API calls and "Drift" UI labels
- [ ] Update `CreateBotModal.tsx` market fetch + deposit calls
- [ ] Update `WalletManagement.tsx` deposit/withdraw labels and calls
- [ ] Update `App.tsx` reset account flow + `TradingBot` type
- [ ] Update `Docs.tsx` documentation content (50 Drift/Swift references)
- [ ] Update `QuantumLab.tsx` deposit + non-tradable market calls

### Phase 5: Monitoring, Analytics & Cleanup (Est. 1-2 days)
- [ ] Port `portfolio-snapshot-job.ts`
- [ ] Port `pnl-snapshot-job.ts`
- [ ] Port `analytics-indexer.ts`
- [ ] Implement equity history via `/account/equity_history`
- [ ] Delete all Drift files (`drift-service.ts`, `drift-price.ts`, `drift-data-api.ts`, `drift-executor.mjs`)
- [ ] Remove `@drift-labs/sdk` from `package.json`
- [ ] Evaluate if `@coral-xyz/anchor` is still needed

### Phase 6: Testing & Cutover (Est. 2-3 days)
- [ ] End-to-end testing on Pacifica testnet (code: `Pacifica`)
- [ ] Test full bot lifecycle: create → deposit → trade → close → withdraw
- [ ] Verify position/PnL reporting accuracy
- [ ] Verify builder code revenue attribution
- [ ] Verify subaccount isolation between bots
- [ ] Frontend smoke test: all pages, all flows
- [ ] Production cutover
- [ ] Monitor first 24h of live trading

**Total estimated effort: 10-16 days** (excluding Phase 0 business prerequisites which depend on Pacifica team response time)

**Revised estimate rationale:** Original 8-13 day estimate missed the frontend migration (10 files, 15+ API endpoint renames, UI label changes, Docs page rewrite) and the full route refactoring scope. Adding Phase 4 accounts for this.

---

## 13. Critical Execution Risks (Architect Review Findings)

The following issues were identified during architect code review and must be resolved before production cutover.

### 13.1 Order Lifecycle State Machine

**Problem:** Drift's execution model is on-chain and atomic — a `placeAndTakePerpOrder` either succeeds or fails in a single transaction. Pacifica is off-chain-first with asynchronous matching. This means orders have intermediate states that Drift doesn't have.

**Pacifica order states:**
```
submitted → acknowledged → partial_fill → filled
                        → canceled
                        → rejected
                        → expired
```

**Required:** Build an explicit order state machine in `pacifica-service.ts` that:
- Assigns a `client_order_id` (UUID) to every order for idempotent retries
- Tracks order state via WebSocket `account_orders` channel
- Handles partial fills (our current system assumes atomic fills)
- Prevents duplicate submissions when TradingView webhooks retry
- Times out orders that aren't acknowledged within N seconds

**Current Drift pattern that breaks:**
```
Webhook → executePerpOrder() → Solana tx → verify on-chain position
```
The "verify on-chain position" step can't work with Pacifica — there's no on-chain position to check until settlement. Must replace with WS fill confirmation + REST position polling fallback.

### 13.2 Fill Confirmation & Reconciliation

**Problem:** The current system verifies trade execution by reading on-chain position state (byte-parsing the Drift User account). With Pacifica, position state is off-chain and comes via REST API or WebSocket events.

**Risk:** If WebSocket events are delayed or lost, the system could:
- Report false success (order accepted but never filled)
- Record phantom PnL (position close reported but position still open)
- Miss fills entirely (WebSocket reconnection gap)

**Required mitigation:**
1. **Primary:** WebSocket `account_trades` channel for real-time fill events
2. **Fallback:** REST `GET /positions` polling on 5-second intervals when WS is disconnected
3. **Reconciliation:** Periodic (60s) position check via REST to catch any missed WS events
4. **Invariant:** Never record PnL or update `bot_trades` status to `filled` until position state is confirmed via at least one of the above methods

### 13.3 Deposit Contract / Destination Validation

**Problem:** The migration doc lists the Pacifica deposit contract address as an open question. This is a **loss-of-funds risk** — sending USDC to the wrong on-chain address is irreversible.

**Required before Phase 1:**
- Identify exact Pacifica bridge contract address on Solana mainnet
- Validate on testnet with small amounts first
- Hardcode and verify the destination in `pacifica-service.ts` with a checksum
- Add a pre-flight validation that confirms the destination account is owned by the expected program

### 13.4 Symbol Canonicalization

**Problem:** The doc says market format "could keep as-is or switch" — this is unsafe. Mixed `SOL-PERP` (Drift) and `SOL` (Pacifica) values in `bot_positions.market` would fragment PnL queries, position history, and strategy insights.

**Required decision:** Pick one canonical format and enforce it:
- **Option A:** Keep `SOL-PERP` internally, convert at the API boundary (adapter in pacifica-service)
- **Option B:** Migrate to `SOL` everywhere (requires updating all historical data)

**Recommendation:** Option A — keep internal format as-is (`SOL-PERP`), convert to bare symbols only when calling Pacifica API, and convert back when receiving responses. Zero data migration needed, zero risk of fragmenting history.

### 13.5 Webhook Idempotency

**Problem:** TradingView webhooks can retry. The current system deduplicates via `signalHash` in `webhook_logs`. This must continue to work, but the order submission path changes:

- **Drift:** Dedup → submit on-chain tx → verify position. If tx fails, retry is safe (new tx).
- **Pacifica:** Dedup → submit via REST → order may be in-flight. If REST times out but order was received, retry creates a **duplicate order**.

**Required:** Use `client_order_id` on all Pacifica orders. This makes retries idempotent at the exchange level — Pacifica will reject a second order with the same `client_order_id`.

---

## 14. General Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| $100K equity cap (beta) | **High** | Verify current limits; may block large portfolios |
| Builder Program rejection | **High** | Apply early; prepare pitch showing volume potential |
| AVAX not available on Pacifica | **Medium** | Check `/markets` — may need to drop AVAX bot |
| No TypeScript SDK | **Low** | REST API is simpler anyway; we build our own thin client |
| Pacifica is newer/less battle-tested | **Medium** | Start with small positions; testnet first |
| WebSocket reliability unknown | **Medium** | Build reconnection logic (we already have SSE reconnect patterns) |
| Rate limiting unknown specifics | **Medium** | API Config Keys available for higher limits |
| Signature format complexity | **Low** | Well-documented; Python SDK has reference implementation |
| Funding rate differences (hourly vs Drift) | **Low** | Update funding calculations in PnL reporting |
| Affiliate revenue cutoff at VIP tier | **Medium** | Builder Program revenue is not subject to this — use both |
| Pacifica itself getting hacked | **Medium** | Off-chain orderbook + on-chain settlement reduces surface area vs fully on-chain DEX |

---

## 15. What We Gain

1. **No SDK dependency** — pure HTTP/WS, no memory leaks, no CJS/ESM compatibility issues
2. **No on-chain byte parsing** — positions/balances come as clean JSON
3. **No subprocess executor** — eliminate `drift-executor.mjs` complexity entirely
4. **Simpler subaccounts** — REST API calls vs on-chain PDA initialization
5. **Lower base fees** — 4 bps taker vs Drift's 5 bps
6. **Sub-10ms API latency** — off-chain matching engine
7. **~4,000 fewer lines of code** — estimated reduction from removing SDK workarounds, byte parsing, Swift protocol, subprocess management
8. **Testnet available** — proper staging environment for integration testing
9. **Builder Program revenue** — potentially higher and more flexible than Drift's fixed 15% referral
10. **No Solana RPC dependency for trading** — eliminates rate limit issues, 429 errors, and RPC failover complexity

---

## 16. Builder Program — Deep Dive

The Builder Program is Pacifica's developer partnership model. It's the most relevant revenue path for QuantumVault because it's designed for exactly our use case: platforms that route order flow through Pacifica.

### How Builder Codes Work

1. **Apply** → Contact ops@pacifica.fi, Discord, or Telegram bot
2. **Receive builder_code** → Unique identifier for your platform
3. **Set fee_rate** → Your custom fee (e.g., `0.001` = 10 bps on top of Pacifica's fees)
4. **User authorization** → User signs a one-time approval payload:
   ```json
   {
     "timestamp": 1716200000000,
     "expiry_window": 5000,
     "type": "approve_builder_code",
     "data": {
       "builder_code": "YOUR_CODE",
       "max_fee_rate": "0.001"
     }
   }
   ```
5. **Order tagging** → Every order includes `builder_code` in the payload
6. **Revenue** → You earn `fee_rate` on every order routed through your code

### Builder vs Drift Referral — Technical Comparison

| Aspect | Drift Referral | Pacifica Builder |
|--------|---------------|------------------|
| Setup | On-chain PDA at account init | One-time user signature |
| Per-order work | None (set and forget) | Must include `builder_code` in every order |
| Revenue control | Fixed 15% | You set the rate |
| Can lose revenue | Never (on-chain permanent) | Only if you stop including the code |
| Implementation | Complex (PDA derivation, referrer lookup, on-chain accounts) | Simple (one field in JSON payload) |

### Pacifica Partner Ecosystem Context

Pacifica uses **Fuul** (fuul.xyz) to power their referral and points infrastructure. Fuul provides:
- On-chain affiliate tracking with anti-sybil/fraud protection
- Points systems with automated distribution
- Leaderboard and competition infrastructure

This means Pacifica's referral attribution is handled by a dedicated third-party system designed for accuracy and fraud prevention — more sophisticated than Drift's simple on-chain PDA approach.

**Privy** (privy.io) handles Pacifica's authentication layer, supporting email/social/wallet login with embedded wallets. This is relevant context but doesn't directly impact our integration since we use our own agent wallet system.

---

## 17. Open Questions (Require Investigation)

### Must-Answer Before Phase 1 (Blockers)

1. **Deposit contract address** — What is the exact on-chain Solana program/account for USDC deposits? This is a **funds-safety blocker** — wrong destination means lost USDC.
2. **Builder Program approval** — Has the application been submitted? What's the timeline? Revenue model depends on this.
3. **Beta equity cap** — Is $100K still the limit? Has it been raised? Blocks large portfolio deployments.
4. **Market list verification** — Does Pacifica have AVAX, SOL, BTC, ETH? What exact symbols? Need to confirm before writing market adapter.

### Should-Answer Before Phase 2

5. **Agent wallet registration** — Can this be done purely via API, or does it require UI interaction for the initial setup?
6. **Partial fill handling** — Does Pacifica support partial fills on market orders? If so, how are they reported via WS?
7. **Order rejection codes** — What error codes does Pacifica return for insufficient margin, invalid symbol, rate limit, etc.?
8. **WebSocket reconnection** — Does Pacifica support resume tokens or sequence IDs for missed events during disconnection?

### Nice-to-Know

9. **Subaccount limits** — How many subaccounts per master account?
10. **Builder fee_rate limits** — Is there a max fee_rate cap?
11. **Historical data depth** — How far back does `/account/equity_history` go?
12. **Cross-margin behavior** — How does cross-margin interact with subaccounts? Is it per-subaccount or account-wide?
13. **Referral + Builder stacking** — Can you earn both affiliate referral and builder fee on the same user's trades?

---

## 18. Decision Framework

### Go with Pacifica if:
- Drift remains compromised or offline for extended period
- Builder Program application is accepted
- AVAX and all actively traded markets are available
- Beta equity cap is lifted or acceptable for current portfolio sizes
- Testnet integration validates successfully

### Hold off if:
- Drift recovers quickly and funds are returned
- Critical markets (SOL, BTC, ETH) missing from Pacifica
- $100K cap blocks meaningful trading and no timeline to lift
- Another DEX emerges with better API/coverage

**Note on Builder Program rejection:** If the Builder Program application is rejected, migration can still proceed — it only affects the *revenue model*, not the trading functionality. The platform would operate without the builder fee revenue stream, relying only on the standard referral program (points-based) or affiliate program if accepted. This is a business decision, not a technical blocker.

### Hybrid option:
- Build `pacifica-service.ts` behind a feature flag
- Keep Drift code in place but disabled
- Switch execution layer via environment variable
- Allows rapid cutover without code deletion

---

## 19. Immediate Next Steps

1. **Apply to Builder Program** — ops@pacifica.fi — this gates the revenue model
2. **Apply to Affiliate Program** — layered revenue opportunity
3. **Hit testnet API** — verify markets, test signing, confirm subaccount flow
4. **Create testnet account** — https://test-app.pacifica.fi (code: `Pacifica`)
5. **Review Python SDK** — https://github.com/pacifica-fi/python-sdk — reference implementation for signing and order flow
6. **Decision point** — once Builder Program status is known, decide go/no-go on full migration

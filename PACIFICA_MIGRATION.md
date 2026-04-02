# Pacifica DEX Integration — Migration Scope & Architecture Document

**Date:** April 2026
**Context:** Drift Protocol hack (~$270M). Evaluating Pacifica.fi as primary DEX replacement for QuantumVault perpetual futures trading.

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
| **Markets** | `/markets` | GET | All available trading pairs |
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

**Impact on QuantumVault:** Our existing `server/agent-wallet.ts` generates Solana keypairs and manages encryption. The keypair generation and storage is **fully reusable**. We only need to:
- Add a registration step (register the agent wallet pubkey with Pacifica)
- Implement the canonical JSON signing function (different from Drift's SDK-based signing)

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

### Pacifica Confirmed Markets

59 perp pairs total. **Confirmed available:**
- BTC, ETH, SOL — all confirmed with 50x max leverage
- Full list is dynamic — fetched via `GET /api/v1/markets`

### Action Required
Before committing to migration, we need to **hit the markets endpoint** to verify:
1. SOL, BTC, ETH, AVAX are all available
2. What symbols Pacifica uses (e.g., `BTC` vs `BTC-PERP` vs `BTCUSD`)
3. Maximum leverage per market
4. Minimum order sizes
5. Price precision / tick sizes

### Symbol Mapping
Pacifica uses **bare symbols** (`BTC`, `SOL`, `ETH`) in API payloads, not `BTC-PERP` format. Our market registry will need an adapter layer.

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

### Key Concern: $100K Equity Cap (Beta)
During beta, accounts are capped at $100K equity. For larger portfolios, this is a constraint. Need to verify if this cap has been lifted or when it will be.

### Impact on QuantumVault
Our current deposit flow (`buildDepositTransaction` / `executeAgentDriftDeposit`) sends USDC to Drift's on-chain program. Pacifica's deposit is similar — send USDC to their bridge contract. The `agent-wallet.ts` USDC transfer logic is mostly reusable; we just change the destination.

---

## 8. Current Drift Integration — What Needs to Change

### File-by-File Impact Assessment

| File | Lines | Drift Coupling | Migration Effort | Notes |
|------|-------|----------------|------------------|-------|
| `drift-service.ts` | 4,120 | **Complete** — core of all Drift interaction | **Full rewrite** | Replace with `pacifica-service.ts` |
| `drift-executor.mjs` | 2,229 | **Complete** — subprocess trade execution | **Full rewrite** | Replace with `pacifica-executor.ts` |
| `swift-executor.ts` | 425 | **Complete** — Drift-specific Swift protocol | **Delete** | Pacifica has no Swift equivalent |
| `swift-config.ts` | 164 | **Complete** | **Delete** | |
| `drift-price.ts` | 208 | **High** — uses Drift Data API for prices | **Rewrite** | Use Pacifica REST + WS prices |
| `drift-data-api.ts` | 190 | **Complete** — Drift analytics API | **Rewrite** | Use Pacifica equity/trade history |
| `agent-wallet.ts` | 511 | **Low** — generic Solana keypair management | **Minor changes** | Add Pacifica signing helper |
| `market-registry.ts` | 187 | **High** — hardcoded Drift market indices | **Rewrite** | Pacifica uses string symbols, not numeric indices |
| `position-service.ts` | 450 | **High** — wraps drift-service position calls | **Rewrite** | Simpler — REST calls instead of byte parsing |
| `reconciliation-service.ts` | 788 | **High** — reconciles Drift on-chain state | **Rewrite** | Simpler — REST-based position/balance checks |
| `trade-retry-service.ts` | 1,084 | **Medium** — retry logic around Drift errors | **Adapt** | Error codes change, retry logic stays |
| `leverage-cache-service.ts` | 212 | **High** — caches Drift leverage per market | **Rewrite** | Use `POST /account/leverage` |
| `market-liquidity-service.ts` | 546 | **High** — uses Drift orderbook data | **Rewrite** | Use Pacifica orderbook endpoint |
| `portfolio-snapshot-job.ts` | 126 | **Medium** — calls drift-service for snapshots | **Adapt** | Change to Pacifica account calls |
| `pnl-snapshot-job.ts` | 148 | **Medium** — calls drift-service for PnL | **Adapt** | Change to Pacifica position data |
| `analytics-indexer.ts` | 250 | **Medium** — indexes Drift trade data | **Adapt** | Change data source |
| `orphaned-subaccount-cleanup.ts` | 83 | **High** — closes Drift subaccounts on-chain | **Rewrite** | Pacifica subaccount cleanup via API |
| `routes.ts` | 10,000+ | **Medium** — calls drift-service functions | **Update imports** | Swap drift-service → pacifica-service |

### Total Lines Requiring Changes: ~11,700+ across dedicated Drift files, plus route updates

### What Stays the Same
- `agent-wallet.ts` — keypair generation, encryption, USDC/SOL transfers (mostly unchanged)
- `server/lab/` — QuantumLab backtesting engine (no Drift dependency)
- `client/` — Frontend is exchange-agnostic (calls our API, not Drift directly)
- `shared/schema.ts` — Database schema (minimal changes, add pacifica IDs)
- Bot management logic — create/start/stop/configure bot workflows
- Strategy engine — signal generation is independent of execution layer

---

## 9. Architecture: Pacifica Service Design

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

## 10. Database Schema Changes

### Minimal Changes Needed

```
bots table:
  + pacifica_subaccount_id: text  (Pacifica subaccount identifier)
  ~ sub_account_id: keep for backward compat, may deprecate

market_registry / config:
  - Remove numeric market index system
  + Use string symbol mapping (BTC, SOL, ETH, etc.)

commission constant:
  ~ Update from 0.0005 to 0.0004 (Pacifica base taker fee)
```

### Data Migration
- Existing bot PnL history, trade logs, and snapshots remain valid
- New trades will use Pacifica order IDs instead of Drift tx signatures
- Position data format changes (entry_price is string, side is "bid"/"ask" not long/short enum)

---

## 11. Migration Strategy — Phased Approach

### Phase 1: Foundation (Est. 2-3 days)
- [ ] Implement `pacifica-signer.ts` (canonical JSON + Ed25519 signing)
- [ ] Implement `pacifica-service.ts` core: auth, account info, positions
- [ ] Hit `/markets` endpoint to verify market coverage
- [ ] Verify agent wallet registration flow
- [ ] Add `pacifica_subaccount_id` to bot schema

### Phase 2: Trading (Est. 2-3 days)
- [ ] Implement order placement (market, limit)
- [ ] Implement position close
- [ ] Implement `pacifica-price.ts` with REST + WS price feeds
- [ ] Port `trade-retry-service.ts` error handling to Pacifica error codes
- [ ] Port `computeTradeSizingAndTopUp` for Pacifica margin model

### Phase 3: Account Management (Est. 1-2 days)
- [ ] Implement subaccount create/transfer
- [ ] Port deposit/withdraw flows
- [ ] Implement `reconciliation-service.ts` using REST account/position data
- [ ] Port leverage management (`POST /account/leverage`)

### Phase 4: Monitoring & Analytics (Est. 1-2 days)
- [ ] Port `portfolio-snapshot-job.ts`
- [ ] Port `pnl-snapshot-job.ts`
- [ ] Port `analytics-indexer.ts`
- [ ] Implement equity history via `/account/equity_history`

### Phase 5: Testing & Cutover (Est. 2-3 days)
- [ ] End-to-end testing on Pacifica testnet
- [ ] Parallel run: verify positions/PnL match between systems
- [ ] Frontend verification (should be transparent)
- [ ] Production cutover
- [ ] Remove Drift code and `@drift-labs/sdk` dependency

**Total estimated effort: 8-13 days**

---

## 12. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| $100K equity cap (beta) | **High** | Verify current limits; may block large portfolios |
| AVAX not available on Pacifica | **Medium** | Check `/markets` — may need to drop AVAX bot |
| No TypeScript SDK | **Low** | REST API is simpler anyway; we build our own thin client |
| Pacifica is newer/less battle-tested | **Medium** | Start with small positions; testnet first |
| WebSocket reliability unknown | **Medium** | Build reconnection logic (we already have SSE reconnect patterns) |
| Rate limiting unknown specifics | **Medium** | API Config Keys available for higher limits |
| Signature format complexity | **Low** | Well-documented; Python SDK has reference implementation |
| Funding rate differences (hourly vs Drift) | **Low** | Update funding calculations in PnL reporting |

---

## 13. What We Gain

1. **No SDK dependency** — pure HTTP/WS, no memory leaks, no CJS/ESM compatibility issues
2. **No on-chain byte parsing** — positions/balances come as clean JSON
3. **No subprocess executor** — eliminate `drift-executor.mjs` complexity entirely
4. **Simpler subaccounts** — REST API calls vs on-chain PDA initialization
5. **Lower base fees** — 4 bps taker vs Drift's 5 bps
6. **Sub-10ms API latency** — off-chain matching engine
7. **~4,000 fewer lines of code** — estimated reduction from removing SDK workarounds, byte parsing, Swift protocol, subprocess management
8. **Testnet available** — proper staging environment for integration testing

---

## 14. Open Questions (Require Investigation)

1. **Market list verification** — Does Pacifica have AVAX? What's the full symbol list?
2. **Beta equity cap** — Is $100K still the limit? Has it been raised?
3. **Agent wallet registration** — Can this be done purely via API, or does it require UI interaction?
4. **Subaccount limits** — How many subaccounts per master account?
5. **Order fill notifications** — How reliable is the WebSocket `account_trades` channel for confirming fills?
6. **Referral/affiliate program** — Is there an equivalent to Drift's referral system for fee sharing?
7. **Historical data depth** — How far back does `/account/equity_history` go?
8. **Cross-margin behavior** — How does cross-margin interact with subaccounts? Is it per-subaccount or account-wide?

---

## 15. Decision Framework

### Go with Pacifica if:
- Drift remains compromised or offline for extended period
- AVAX and all actively traded markets are available
- Beta equity cap is lifted or acceptable for current portfolio sizes
- Testnet integration validates successfully

### Hold off if:
- Drift recovers quickly and funds are returned
- Critical markets (SOL, BTC, ETH) missing from Pacifica
- $100K cap blocks meaningful trading
- Another DEX emerges with better API/coverage

### Hybrid option:
- Build `pacifica-service.ts` behind a feature flag
- Keep Drift code in place but disabled
- Switch execution layer via environment variable
- Allows rapid cutover without code deletion

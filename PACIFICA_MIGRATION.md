# QuantumVault Protocol Adapter Architecture & Pacifica Migration

**Date:** April 2026  
**Status:** PLANNING — No code changes until architect audit is complete  
**Context:** Drift Protocol hack (~$270M). Strategic pivot: build a protocol-agnostic adapter layer so QuantumVault is never locked to a single DEX again. Pacifica.fi is the first adapter implementation.  
**Server files with Drift references:** 21 (19 `.ts` + 2 `.mjs`)

---

## Table of Contents

1. [Strategic Vision](#1-strategic-vision)
2. [Key Links](#2-key-links)
3. [Why Pacifica First](#3-why-pacifica-first)
4. [Protocol Adapter Architecture](#4-protocol-adapter-architecture)
5. [SymbolRegistry Design](#5-symbolregistry-design)
6. [Pacifica Adapter — API Reference](#6-pacifica-adapter--api-reference)
7. [Pacifica Adapter — Authentication & Signing](#7-pacifica-adapter--authentication--signing)
8. [Subaccount System](#8-subaccount-system)
9. [Market Coverage & Symbol Mapping](#9-market-coverage--symbol-mapping)
10. [Fee Structure & Revenue Model](#10-fee-structure--revenue-model)
11. [Deposit & Withdrawal](#11-deposit--withdrawal)
12. [Order Lifecycle & State Machine](#12-order-lifecycle--state-machine)
13. [Reconciliation & Fill Confirmation](#13-reconciliation--fill-confirmation)
14. [Current Codebase — File-by-File Impact](#14-current-codebase--file-by-file-impact)
15. [Database Schema Changes](#15-database-schema-changes)
16. [Dead Code & Technical Debt Cleanup](#16-dead-code--technical-debt-cleanup)
17. [Migration Phases](#17-migration-phases)
18. [Critical Execution Risks](#18-critical-execution-risks)
19. [Risk Assessment](#19-risk-assessment)
20. [What We Gain](#20-what-we-gain)
21. [Open Questions](#21-open-questions)
22. [Decision Framework](#22-decision-framework)
23. [Future: Multi-Protocol & Smart Routing](#23-future-multi-protocol--smart-routing)

---

## 1. Strategic Vision

### The Problem

QuantumVault is hardcoded to Drift Protocol across **17 server files** and **16 client files**. The Drift hack exposed the risk of single-protocol lock-in: when your only DEX goes down, your entire platform goes dark.

### The Solution

Build a **protocol-agnostic adapter architecture** where QuantumVault becomes the execution layer that can route to any Solana perp DEX. No single DEX lock-in. Swap adapters without touching bot logic, strategy engines, or frontend.

### Phased Rollout

| Phase | Goal | Timeline |
|-------|------|----------|
| **Phase 1** | Protocol adapter interface + Pacifica as first adapter | 2-3 weeks active sessions |
| **Phase 2** | Stabilize, monitor, fix edge cases in production | 1-2 weeks |
| **Phase 3** | Second adapter (candidate: Raydium, Flash Trade, or recovered Drift) | 2-3 weeks |
| **Phase 4** | Smart routing layer — split orders across adapters for best execution | Future |

### Design Principles

1. **Internal format is canonical** — `SOL-PERP` is the internal symbol format everywhere. Adapters convert at the boundary.
2. **Adapters are stateless** — all state lives in the database. Adapters are pure execution translators.
3. **Bot logic never imports adapter code directly** — always goes through the interface.
4. **Adapters declare their own capabilities** — markets, leverage limits, min order sizes, tick sizes.
5. **Existing data is never migrated** — schema changes are additive only. Old Drift columns stay for history.

---

## 2. Key Links

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

## 3. Why Pacifica First

| Criteria | Pacifica | GMTrade | Verdict |
|----------|----------|---------|---------|
| Public REST API | Yes — full CRUD | No public API | Pacifica |
| WebSocket feeds | Yes — orderbook, trades, fills, account | Unknown | Pacifica |
| SDK | Python SDK (GitHub), no TS SDK yet | None | Pacifica |
| Auth model | Solana wallet signatures + Agent Wallets | Raw Anchor calls | Pacifica |
| Subaccounts | Yes — create + fund transfer API | Unknown | Pacifica |
| Markets | 63 perp pairs (verified live) | 86 pairs | GMTrade has more |
| Volume (24h) | ~$1B | ~$554M | Pacifica |
| Leverage | 3x–50x | Up to 500x | GMTrade |
| Testnet | Yes (`test-api.pacifica.fi`) | Unknown | Pacifica |
| Builder Program | Yes — fee revenue + points | Unknown | Pacifica |

**GMTrade is ruled out** — no public API means we'd need to reverse-engineer their Anchor program IDL. Not viable for production trading bots.

---

## 4. Protocol Adapter Architecture

### Directory Structure

```
server/protocol/
  adapter.ts              # ProtocolAdapter interface + types
  symbol-registry.ts      # Bidirectional symbol mapping
  adapter-registry.ts     # Registry of available adapters + active adapter accessor
  pacifica/
    pacifica-adapter.ts   # ProtocolAdapter implementation for Pacifica
    pacifica-signer.ts    # Canonical JSON signing for Pacifica API auth
    pacifica-ws.ts        # WebSocket connection manager
    pacifica-types.ts     # Pacifica-specific API response types
```

### Interface Design — Separation of Concerns

The current `drift-service.ts` exports ~25 functions, but they fall into **three distinct categories** that should NOT be mixed into a single interface:

| Category | Example Functions | Who Calls | Who Signs |
|----------|------------------|-----------|-----------|
| **Server-side Execution** | `executePerpOrder`, `closePerpPosition`, `executeAgentDriftDeposit` | Server (webhook, bot logic) | Agent wallet (server holds key) |
| **User Transaction Builders** | `buildDepositTransaction`, `buildWithdrawTransaction`, `buildTransferToSubaccountTransaction` | Frontend (via API route) | User's browser wallet (Phantom, etc.) |
| **Read/Query** | `getPerpPositions`, `getDriftAccountInfo`, `getBatchPerpPositions`, `getMarketPrice` | Server (reconciliation, portfolio, UI) | No signing needed |

**Critical insight:** `buildDepositTransaction` and `buildWithdrawTransaction` are NOT server-executed operations. The server builds a Solana transaction, serializes it, sends it to the frontend, and the **user signs it in their browser wallet**. These cannot go behind the same adapter as server-side execution because the signing model is fundamentally different.

### ProtocolAdapter Interface (Server-Side Execution + Reads)

```typescript
interface ProtocolAdapter {
  readonly protocolName: string;    // e.g. "pacifica", "drift", "raydium"
  readonly protocolVersion: string; // e.g. "1.0.0"

  // --- Lifecycle ---
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }>;
  getCapabilities(): AdapterCapabilities;

  // --- Market Data & Capabilities ---
  getMarkets(): Promise<ProtocolMarket[]>;
  getPrice(internalSymbol: string): Promise<number | null>;
  getAllPrices(): Promise<Record<string, number>>;
  getOrderbook(internalSymbol: string, depth?: number): Promise<OrderbookSnapshot>;
  getFundingRate(internalSymbol: string): Promise<FundingRateInfo>;
  getMaintenanceMarginWeight(internalSymbol: string): number;

  // --- Account Reads ---
  getAccountInfo(agentPublicKey: string, subaccountId?: string): Promise<AccountInfo>;
  getPositions(agentPublicKey: string, subaccountId?: string): Promise<ProtocolPosition[]>;
  getBalances(agentPublicKey: string, subaccountId?: string): Promise<BalanceInfo>;
  getEquityHistory(agentPublicKey: string, params?: HistoryParams): Promise<EquityPoint[]>;
  getTradeHistory(agentPublicKey: string, params?: HistoryParams): Promise<TradeRecord[]>;

  // --- Batch Reads (Performance — portfolio page, reconciliation) ---
  getBatchAccountInfo(agentPublicKey: string, subaccountIds: string[]): Promise<AccountInfo[]>;
  getBatchPositions(agentPublicKey: string, subaccountIds: string[]): Promise<Map<string, ProtocolPosition[]>>;

  // --- Server-Side Order Execution (agent wallet signs) ---
  placeMarketOrder(params: MarketOrderParams): Promise<OrderResult>;
  placeLimitOrder(params: LimitOrderParams): Promise<OrderResult>;
  cancelOrder(params: CancelOrderParams): Promise<CancelResult>;
  cancelAllOrders(agentPublicKey: string, symbol?: string): Promise<CancelResult>;

  // --- Server-Side Position Management ---
  closePosition(params: ClosePositionParams): Promise<OrderResult>;
  setLeverage(agentPublicKey: string, symbol: string, leverage: number): Promise<void>;

  // --- Server-Side Fund Management (agent wallet signs) ---
  executeDeposit(params: AgentDepositParams): Promise<DepositResult>;
  executeWithdraw(params: AgentWithdrawParams): Promise<WithdrawResult>;
  transferBetweenSubaccounts(params: TransferParams): Promise<TransferResult>;

  // --- Subaccounts ---
  createSubaccount(agentPublicKey: string, label?: string): Promise<SubaccountInfo>;
  listSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]>;
  discoverSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]>;
  closeSubaccount?(agentPublicKey: string, subaccountId: string): Promise<void>;

  // --- Settlement ---
  settlePnl(agentPublicKey: string, agentSecretKey: Uint8Array, subaccountId?: string): Promise<SettleResult>;

  // --- Agent Wallet ---
  registerAgentWallet(mainWalletAddress: string, agentPublicKey: string): Promise<void>;

  // --- WebSocket (Optional — adapters may or may not support real-time feeds) ---
  subscribeToFills?(agentPublicKey: string, callback: (fill: FillEvent) => void): Unsubscribe;
  subscribeToPositionUpdates?(agentPublicKey: string, callback: (pos: ProtocolPosition) => void): Unsubscribe;
  subscribeToOrderUpdates?(agentPublicKey: string, callback: (order: OrderUpdate) => void): Unsubscribe;
}
```

### UserTransactionBuilder Interface (Separate — User Signs in Browser)

These functions build unsigned Solana transactions for the user's browser wallet to sign. They are protocol-specific but follow a different pattern than server-side execution.

```typescript
interface UserTransactionBuilder {
  readonly protocolName: string;

  buildDepositTransaction(
    walletAddress: string,
    amountUsdc: number
  ): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }>;

  buildWithdrawTransaction(
    walletAddress: string,
    amountUsdc: number
  ): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }>;

  buildTransferToSubaccountTransaction(
    walletAddress: string,
    subaccountId: string,
    amountUsdc: number
  ): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }>;

  buildTransferFromSubaccountTransaction(
    walletAddress: string,
    subaccountId: string,
    amountUsdc: number
  ): Promise<{ transaction: string; blockhash: string; lastValidBlockHeight: number; message: string }>;
}
```

**Why separate?** For Pacifica, deposit is still an on-chain USDC transfer (user signs in browser) BUT withdrawals may be a REST API call (agent signs server-side). The boundary between "user signs" vs "server signs" is protocol-specific. Some operations may move between interfaces depending on the protocol.

**CRITICAL: Dual-Path Deposit/Withdraw Flows**

The current codebase has TWO distinct deposit/withdraw paths that coexist:

| Path | Route | Signer | When Used |
|------|-------|--------|-----------|
| **User-signed** | `POST /api/drift/deposit` → `buildDepositTransaction()` → serialized tx → frontend → user signs in Phantom | User's browser wallet | Manual deposits from Portfolio page |
| **Agent-signed** | `executeAgentDriftDeposit()` / `executeAgentDriftWithdraw()` | Agent wallet (server holds key) | Automated top-ups by trade-retry-service, profit-share payouts |

Both paths MUST be preserved in the adapter architecture. The migration plan must explicitly handle:
1. `UserTransactionBuilder.buildDepositTransaction()` — for manual user deposits (user signs)
2. `ProtocolAdapter.executeDeposit()` — for automated agent deposits (server signs)
3. `ProtocolAdapter.executeWithdraw()` — for automated agent withdrawals (server signs)
4. `UserTransactionBuilder.buildWithdrawTransaction()` — for manual user withdrawals (user signs), IF Pacifica supports user-signed withdrawal. Otherwise this path is retired and all withdrawals go through agent-signed `executeWithdraw()`.

**For Pacifica specifically:**
- `buildDepositTransaction` → Still needed (on-chain USDC transfer to Pacifica bridge contract, user signs)
- `buildWithdrawTransaction` → May become `adapter.executeWithdraw()` only (Pacifica REST API, agent signs). Need to verify if Pacifica supports user-initiated withdrawals via on-chain tx.
- `buildTransferTo/FromSubaccount` → Becomes `adapter.transferBetweenSubaccounts()` (Pacifica REST API, agent signs)

### Functions That Do NOT Belong Behind an Adapter

Some current `drift-service.ts` functions are platform-internal and should remain as standalone utilities:

| Function | Reason to exclude |
|----------|------------------|
| `getUsdcBalance(walletAddress)` | Reads on-chain USDC balance via Solana RPC — not protocol-specific |
| `subaccountExists(walletAddress, subId)` | Drift-specific on-chain check — replaced by `adapter.listSubaccounts()` |
| `getNextOnChainSubaccountId()` | Drift-specific sequential ID — replaced by `adapter.createSubaccount()` |
```

### Protocol-Neutral Types

```typescript
interface ProtocolMarket {
  internalSymbol: string;    // "SOL-PERP" — our canonical format
  protocolSymbol: string;    // "SOL" (Pacifica) or "SOL-PERP" (Drift) — what the protocol uses
  maxLeverage: number;
  minOrderSizeUsd: number;
  minOrderSizeBase: number;
  tickSize: number;
  lotSize: number;
  isActive: boolean;
  category: string[];        // ["L1", "Infra"]
  fullName: string;          // "Solana" — for UI display (replaces DRIFT_MARKET_METADATA in market-liquidity-service.ts)
  maintenanceMarginWeight: number;  // For liquidation price calc (replaces MAINTENANCE_MARGIN_WEIGHTS in position-service.ts)
  openInterestUsd?: number;  // Current OI — for slippage estimation (replaces Drift on-chain PerpMarket decode)
  warning?: string;          // "High volatility meme token" — for UI risk display
}

interface ProtocolPosition {
  internalSymbol: string;    // "SOL-PERP"
  baseSize: number;          // Positive = long, negative = short
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number | null;
  marginMode: 'cross' | 'isolated';
  subaccountId?: string;
}

interface MarketOrderParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  internalSymbol: string;     // "SOL-PERP" — adapter converts to protocol format
  side: 'long' | 'short';
  sizeBase: number;
  reduceOnly?: boolean;
  clientOrderId?: string;     // UUID for idempotency
  subaccountId?: string;
  builderCode?: string;
}

interface OrderResult {
  success: boolean;
  orderId?: string;           // Protocol's order ID (may be unknown at submit time for async protocols)
  clientOrderId?: string;     // Our UUID — echoed back for durable correlation across restarts
  status: 'submitted' | 'acknowledged' | 'filled' | 'partial_fill' | 'rejected' | 'error';
  fillPrice?: number;
  fillSize?: number;
  fee?: number;
  error?: string;
  rawResponse?: unknown;      // Protocol-specific response for debugging
}

interface AccountInfo {
  equity: number;
  balance: number;
  unrealizedPnl: number;
  availableMargin: number;
  maintenanceMargin: number;
  feeTier: string;
  subaccountId?: string;
}

interface BalanceInfo {
  totalEquity: number;
  freeCollateral: number;
  totalMarginUsed: number;
  unrealizedPnl: number;
}

interface DepositParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  amount: number;              // USDC amount
  subaccountId?: string;
}

interface DepositResult {
  success: boolean;
  txSignature?: string;        // On-chain tx (if applicable)
  error?: string;
}

interface AdapterCapabilities {
  supportsPartialFills: boolean;
  supportsStopOrders: boolean;
  supportsTpSl: boolean;
  supportsBatchOrders: boolean;
  supportsIsolatedMargin: boolean;
  supportsWebSocket: boolean;
  supportsSettlePnl: boolean;
  supportsCloseSubaccount: boolean;
  maxSubaccounts: number | null;     // null = unlimited
  settlementType: 'on-chain' | 'off-chain' | 'hybrid';
}

interface SettleResult {
  success: boolean;
  settledAmount?: number;
  error?: string;
}

type Unsubscribe = () => void;
```

### Adapter Registry

```typescript
// server/protocol/adapter-registry.ts

const adapters = new Map<string, ProtocolAdapter>();
let defaultAdapterId: string = 'pacifica';

function registerAdapter(adapter: ProtocolAdapter): void {
  adapters.set(adapter.protocolName, adapter);
}

function getDefaultAdapter(): ProtocolAdapter {
  const adapter = adapters.get(defaultAdapterId);
  if (!adapter) throw new Error(`No adapter registered for "${defaultAdapterId}"`);
  return adapter;
}

function getAdapterForBot(bot: { activeProtocol?: string }): ProtocolAdapter {
  const protocolName = bot.activeProtocol || defaultAdapterId;
  const adapter = adapters.get(protocolName);
  if (!adapter) throw new Error(`No adapter registered for "${protocolName}"`);
  return adapter;
}

function getAdapter(protocolName: string): ProtocolAdapter {
  const adapter = adapters.get(protocolName);
  if (!adapter) throw new Error(`No adapter registered for "${protocolName}"`);
  return adapter;
}

function setDefaultAdapter(protocolName: string): void {
  if (!adapters.has(protocolName)) throw new Error(`Unknown protocol: ${protocolName}`);
  defaultAdapterId = protocolName;
}

function listAdapters(): string[] {
  return Array.from(adapters.keys());
}
```

**Per-bot protocol resolution:** Each bot has an `active_protocol` column (defaults to `"pacifica"`). When executing trades, the system calls `getAdapterForBot(bot)` to resolve the correct adapter. This supports mixed-protocol scenarios during phased rollout — existing bots can continue on one protocol while new bots use another.

### How Existing Code Changes

**Before (Drift-coupled):**
```
routes.ts → drift-service.ts → DriftClient SDK → Solana RPC → On-chain vAMM
         → drift-executor.mjs (subprocess) → SDK → RPC
         → swift-executor.ts → Swift protocol → Keeper network
```

**After (adapter pattern):**
```
routes.ts → getActiveAdapter() → adapter.placeMarketOrder(params)
                               → adapter.getPositions(agentPubkey)
                               → adapter.deposit(params)
                               → adapter.getPrice(symbol)
```

The adapter boundary is the **only** place where protocol-specific code exists. Everything above it (bot logic, webhook processing, trade sizing, auto-withdraw, profit sharing, PnL calculations, reconciliation) speaks the protocol-neutral types.

### Calling Convention

Every function in routes.ts that currently calls `drift-service.ts` directly will instead:

1. Import `getAdapterForBot` (or `getDefaultAdapter` for non-bot contexts) from `server/protocol/adapter-registry.ts`
2. Get the adapter: `const adapter = getAdapterForBot(bot)` — resolves based on `bot.activeProtocol`
3. Call the adapter method: `const result = await adapter.placeMarketOrder({...})`
4. Handle the protocol-neutral `OrderResult`
5. Check capabilities when needed: `if (adapter.getCapabilities().supportsSettlePnl) { ... }`

The adapter internally:
- Converts `SOL-PERP` → `SOL` (via SymbolRegistry)
- Signs the payload (Pacifica canonical JSON signing)
- Makes the HTTP request
- Converts the response back to protocol-neutral types
- Converts `SOL` → `SOL-PERP` in returned position data

---

## 5. SymbolRegistry Design

### Purpose

Bidirectional mapping between QuantumVault's internal symbol format (`SOL-PERP`) and each protocol's native format. Ensures consistent symbol handling across the entire codebase while letting each adapter use whatever format the protocol expects.

### Interface

```typescript
// server/protocol/symbol-registry.ts

interface SymbolMapping {
  internal: string;    // "SOL-PERP"
  protocol: string;    // "SOL" (Pacifica)
  aliases: string[];   // ["SOLUSD", "SOL/USD"]
}

class SymbolRegistry {
  private toProtocol: Map<string, string>;   // internal → protocol
  private toInternal: Map<string, string>;   // protocol → internal

  constructor(mappings: SymbolMapping[]) { ... }

  internalToProtocol(internal: string): string;   // "SOL-PERP" → "SOL"
  protocolToInternal(protocol: string): string;   // "SOL" → "SOL-PERP"
  isKnownInternal(symbol: string): boolean;
  isKnownProtocol(symbol: string): boolean;
  getAllInternalSymbols(): string[];
  getAllProtocolSymbols(): string[];
}
```

### Pacifica Symbol Mappings

| Internal (QuantumVault) | Pacifica | Notes |
|------------------------|----------|-------|
| `SOL-PERP` | `SOL` | Strip `-PERP` suffix |
| `BTC-PERP` | `BTC` | Strip `-PERP` suffix |
| `ETH-PERP` | `ETH` | Strip `-PERP` suffix |
| `AVAX-PERP` | `AVAX` | Strip `-PERP` suffix |
| `1MBONK-PERP` | `kBONK` | Denomination change: `1M` → `k` |
| `1MPEPE-PERP` | `kPEPE` | Denomination change: `1M` → `k` |
| Most others | Strip `-PERP` | General rule for simple cases |

### Symbol Conversion Rule

For Pacifica, the default conversion is:
1. Strip `-PERP` suffix
2. Handle special cases: `1MBONK` → `kBONK`, `1MPEPE` → `kPEPE`

The SymbolRegistry is populated at adapter initialization by calling Pacifica's `GET /api/v1/info` and building the mapping table from live data.

### Failure & Edge Case Handling

- **API unavailable at startup:** Fall back to a hardcoded mapping table compiled from the most recent successful fetch. Log a warning.
- **Symbol collisions:** Case-insensitive normalization. All lookups are case-insensitive (`sol` → `SOL-PERP`). If two internal symbols map to the same protocol symbol, fail loudly at initialization — this is a configuration error.
- **Unknown symbol in response:** If the adapter receives a position or fill with a protocol symbol not in the registry, log an error and use the raw protocol symbol prefixed with `UNKNOWN-` to prevent silent data loss.
- **Registry refresh:** The SymbolRegistry should be refreshable at runtime (e.g., when new markets are listed on Pacifica) without restarting the server. Adapter calls `registry.refresh()` which re-fetches `/api/v1/info`.

### CRITICAL: Fragmented `normalizeMarket()` Functions

The codebase currently has **three separate `normalizeMarket()` implementations** that strip suffixes/prefixes to compare symbols:

| File | Line | Logic |
|------|------|-------|
| `reconciliation-service.ts` | 13 | `.replace(/-PERP$/i, '').replace(/PERP$/i, '').replace(/USD[CT]?$/i, '').replace(/[-_/]/g, '')` |
| `position-service.ts` | 41 | Identical to reconciliation |
| `routes.ts` (inline) | Various | Ad-hoc comparisons like `p.market === bot.market` |

**Risk:** If an adapter returns a protocol-native symbol anywhere in its output (e.g., `"SOL"` instead of `"SOL-PERP"`), the strict `p.market === bot.market` comparisons in routes.ts will silently fail, breaking reconciliation and position matching.

**Solution:** The adapter interface contract states: **all `ProtocolPosition`, `OrderResult`, and `FillEvent` objects must return `internalSymbol` in canonical `SOL-PERP` format.** The SymbolRegistry conversion happens inside the adapter, not outside. Additionally, consolidate all `normalizeMarket()` copies into a single shared utility in `server/protocol/symbol-registry.ts`.

### Design Decision: Keep Internal Format

**Option A (chosen):** Keep `SOL-PERP` internally, convert at adapter boundary.  
**Option B (rejected):** Migrate to `SOL` everywhere.

Rationale: Option A requires zero data migration, zero risk of fragmenting historical PnL/trade data, and is future-proof — if a second adapter uses `SOL-PERP` natively (like Drift did), the mapping is trivial.

---

## 6. Pacifica Adapter — API Reference

### Base URLs

| Environment | REST | WebSocket |
|-------------|------|-----------|
| Mainnet | `https://api.pacifica.fi/api/v1` | `wss://ws.pacifica.fi/ws` |
| Testnet | `https://test-api.pacifica.fi/api/v1` | `wss://test-ws.pacifica.fi/ws` |

### REST Endpoints

| Category | Endpoint | Method | Notes |
|----------|----------|--------|-------|
| **Markets** | `/info` | GET | All available trading pairs (verified live — NOT `/markets`) |
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

### API Endpoint Correction

The correct markets endpoint is `GET /api/v1/info` (NOT `/api/v1/markets` or `/api/v1/info/markets` as stated in some docs). Verified via live API call.

---

## 7. Pacifica Adapter — Authentication & Signing

### How Pacifica Auth Works

All POST requests require a **Solana Ed25519 signature** over a canonicalized JSON payload:

1. Build the request payload (account, timestamp, symbol, amount, etc.)
2. Remove the `signature` field
3. **Recursively sort all JSON keys alphabetically**
4. Create compact JSON string (no spaces)
5. Sign the UTF-8 bytes with Ed25519 private key
6. Base58-encode the 64-byte signature

### Signing Module (`server/protocol/pacifica/pacifica-signer.ts`)

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

### Agent Wallet Delegation

Pacifica natively supports **agent wallets** — exactly what we already use:

- Generate an agent keypair (Solana Ed25519)
- Register via UI at `app.pacifica.fi/apikey` or via API
- For all POST requests, sign with the **agent wallet's private key** and include `agent_wallet: <AGENT_PUBKEY>` in the payload
- The `account` field still contains the **main wallet address**

### Impact on QuantumVault

Our existing `server/agent-wallet.ts` generates Solana keypairs and manages encryption. The keypair generation and storage is **fully reusable**. We only need to:
- Add a registration step (register the agent wallet pubkey with Pacifica)
- Implement the canonical JSON signing function (different from Drift's SDK-based signing)
- Include `builder_code` in order payloads if enrolled in Builder Program

### Key Difference from Drift

| | Drift | Pacifica |
|---|---|---|
| Auth method | SDK-managed (DriftClient handles signing internally) | Manual Ed25519 over canonical JSON |
| Agent concept | Drift subaccounts with delegate authority | Agent wallet pubkey registered via API |
| On-chain setup | Initialize user account + subaccounts on-chain | Deposit triggers account creation; subaccounts via API |

### Security Model (Unchanged)

The UMK (User Master Key) encryption model is completely independent of the protocol adapter:

- Agent wallet private keys are encrypted with a subkey derived from the UMK
- UMK = SHA256(walletAddress + userSalt + AGENT_ENCRYPTION_KEY)
- Per-user isolation: no shared vault, no admin key
- Auto-withdraw profits: profits move from exchange back to user's personal wallet automatically

The adapter receives a decrypted `agentSecretKey: Uint8Array` for signing — it never touches the encryption layer.

---

## 8. Subaccount System

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

### Adapter Abstraction

The `ProtocolAdapter` interface uses `subaccountId?: string` — a protocol-neutral string. Each adapter maps this to its own format:

| Protocol | subaccountId format | Notes |
|----------|-------------------|-------|
| Drift | Integer as string (`"0"`, `"1"`) | On-chain PDA index |
| Pacifica | UUID or string ID | Off-chain REST-created |

The `trading_bots` table gets a new `protocol_subaccount_id: text` column that stores whatever the active protocol's subaccount identifier is.

### Bot Isolation Model

Each bot trades in its own subaccount to prevent margin cross-contamination. This model maps cleanly to both Drift and Pacifica. The adapter handles subaccount creation — the bot management layer just calls `adapter.createSubaccount()` and stores the returned ID.

---

## 9. Market Coverage & Symbol Mapping

### Markets We Currently Trade (Drift)

Our `market-registry.ts` has 69 perp markets (indices 0–84 with gaps). The ones actively used by bots:

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

`AI16Z, APT, CLOUD, DBR, DRIFT, DYM, FWOG, GOAT, HNT, INJ, IO, IP, JTO, KAITO, KMNO, LAUNCHCOIN, ME, MELANIA, MET, MEW, MICHI, MNT, MOODENG, MOTHER, OP, PNUT, POL, POPCAT, PYTH, RAY, RENDER, RLB, SEI, TIA, TNSR, TON, W, WEN, ZEX`

Most are low-cap Solana ecosystem tokens. None are actively traded by our bots. **No impact on current operations.**

#### New Markets Available on Pacifica (34 not on Drift)

`AAVE, BCH, BP, CL, COPPER, CRCL, CRV, ENA, EURUSD, GOOGL, HOOD, ICP, LDO, MEGA, NATGAS, NEAR, NVDA, PIPPIN, PLATINUM, PLTR, SP500, STRK, TSLA, UNI, URNM, USDJPY, VIRTUAL, WLD, WLFI, XAG, XAU, XMR, ZK, ZRO`

Notable additions: **Equities** (TSLA, NVDA, GOOGL, PLTR, HOOD), **Commodities** (Gold, Silver, Oil, Gas, Copper), **Forex** (EUR/USD, USD/JPY), **Index** (S&P 500).

#### Leverage Differences

| Market | Drift Max | Pacifica Max | Notes |
|--------|----------|-------------|-------|
| SOL | 20x | 20x | Same |
| BTC | 20x | 50x | Pacifica higher |
| ETH | 20x | 50x | Pacifica higher |
| AVAX | 10x | 10x | Same |

---

## 10. Fee Structure & Revenue Model

### Trading Fees

| Tier | 14-Day Volume | Maker | Taker |
|------|---------------|-------|-------|
| 1 | $0+ | 0.015% (1.5 bps) | 0.040% (4.0 bps) |
| 2 | >$5M | 0.012% (1.2 bps) | 0.038% (3.8 bps) |
| 3 | >$10M | 0.009% (0.9 bps) | 0.036% (3.6 bps) |
| 4+ | Higher tiers available | Lower | Lower |

Comparison: Drift base taker fee ~0.05% (5 bps) vs Pacifica 0.04% (4 bps) — **slightly cheaper**.

Our commission constant: `0.0005` (5 bps) → update to `0.0004` (4 bps) for Pacifica.

Funding rates: **Hourly** interval (Drift uses variable intervals).

### Revenue Model — Three Tiers

#### Tier 1: Standard Referral (Open to all)

| Detail | Value |
|--------|-------|
| Eligibility | $10,000 in trading volume |
| Referrer reward | 10% of referred users' **points** |
| Referee bonus | 5% bonus in points |
| Distribution | Weekly, automatic |

Points-based — not direct fee revenue. Not primary revenue path.

#### Tier 2: Affiliate Program (Selective)

| Detail | Value |
|--------|-------|
| Fee share | Up to **40%** of trading fees from referred users |
| Spots | Limited — selective approval |
| Application | Discord ticket or contact ops@pacifica.fi |

Potentially better than Drift's 15% — but if referred user reaches VIP tier or joins market maker program, affiliate stops earning.

#### Tier 3: Builder Program (Best Fit for QuantumVault)

| Detail | Value |
|--------|-------|
| Revenue mechanism | Custom `fee_rate` charged on all orders routed through your builder code |
| Integration | `builder_code` parameter added to order payloads |
| User authorization | Users sign approval for your builder code + max fee rate |
| Application | ops@pacifica.fi, Discord ticket, or @PacificaTGPortalBot on Telegram |

**How it works:**
1. Apply to Builder Program → receive a `builder_code`
2. Set your `fee_rate` (e.g., `0.001` = 0.1% additional fee)
3. Users authorize your builder code by signing an approval payload
4. All orders include `builder_code` in the payload
5. You earn `fee_rate` on every order

**This is the closest equivalent to our Drift referral model and arguably better:** direct fee revenue, you control the rate, per-order (not per-account), works regardless of user's VIP tier, no expiration.

#### Revenue Comparison

| | Drift (Current) | Pacifica Builder | Pacifica Affiliate |
|---|---|---|---|
| Revenue type | 15% of taker fees | Custom fee_rate per order | Up to 40% of fees |
| Mechanism | On-chain referral PDA | `builder_code` in API payload | Off-chain attribution |
| Permanence | Permanent (on-chain) | Per-order (code must be included) | Subject to VIP/MM cutoff |
| Control | Fixed 15% | You set the rate | Scales with volume |

#### Recommended Approach

1. **Apply to Builder Program first** — prerequisite before migration makes financial sense
2. **Also apply to Affiliate Program** — layered revenue
3. Builder code integration is trivial — one extra field in order payloads
4. Since we control order creation, `builder_code` inclusion is guaranteed

---

## 11. Deposit & Withdrawal

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
Pacifica partners with **Rhinofi** for cross-chain bridging. Less relevant for us — our agent wallets already hold Solana-native USDC.

### Key Concern: $100K Equity Cap (Beta)
During beta, accounts are capped at $100K equity. Need to verify if this has been lifted.

### Adapter Impact

Deposits and withdrawals are the only operations that involve on-chain Solana transactions. The adapter's `deposit()` and `withdraw()` methods handle:

1. Building the on-chain USDC transfer transaction (destination = Pacifica bridge contract)
2. Signing with agent wallet
3. Submitting to Solana RPC
4. Confirming on-chain

The existing `agent-wallet.ts` USDC transfer logic is mostly reusable — we just change the destination address.

**CRITICAL:** The Pacifica deposit contract address must be verified before any funds transfer. See Risk 18.3.

---

## 12. Order Lifecycle & State Machine

### The Problem

Drift's execution model is on-chain and atomic — a `placeAndTakePerpOrder` either succeeds or fails in a single transaction. Pacifica is off-chain-first with asynchronous matching. Orders have intermediate states.

### Pacifica Order States

```
submitted → acknowledged → partial_fill → filled
                        → canceled
                        → rejected
                        → expired
```

### Required State Machine

The Pacifica adapter must implement an explicit order state machine:

1. **Submit** — REST `POST /orders/create_market` with a `client_order_id` (UUID)
2. **Track** — Listen for state changes via WebSocket `account_orders` channel
3. **Confirm** — Wait for `filled` or `partial_fill` status
4. **Fallback** — If WS is disconnected, poll `GET /orders/history/{id}` on 5-second intervals
5. **Timeout** — If no acknowledgment within 30 seconds, mark order as failed
6. **Retry** — `client_order_id` makes retries idempotent at the exchange level

### Partial Fill Handling

Our current system assumes atomic fills. With Pacifica, market orders may partially fill. The adapter must:

- Report `partial_fill` status with the filled amount
- The calling code (trade execution in routes.ts) decides whether to place a follow-up order for the remaining amount
- PnL calculations must handle partial close amounts correctly

### Webhook Idempotency

TradingView webhooks can retry. Current deduplication via `signalHash` continues to work. Additionally, `client_order_id` on Pacifica orders prevents duplicate submissions at the exchange level.

---

## 13. Reconciliation & Fill Confirmation

### Current System

The current `reconciliation-service.ts` verifies positions by reading on-chain Drift User account data (byte-parsing). It runs every 60 seconds, detects liquidations, and syncs DB positions with on-chain truth.

### Adapter-Based Reconciliation

With the adapter pattern, reconciliation becomes:

1. **Primary:** WebSocket `account_trades` / `account_positions` channels for real-time updates
2. **Fallback:** REST `GET /positions` polling when WS is disconnected
3. **Periodic:** 60-second reconciliation loop calls `adapter.getPositions()` and compares with DB
4. **Invariant:** Never record PnL or update `bot_trades` status to `filled` until position state is confirmed

### What Changes

| Aspect | Before (Drift) | After (Adapter) |
|--------|----------------|-----------------|
| Position source | On-chain byte parsing via RPC | `adapter.getPositions()` (REST or cached WS) |
| Liquidation detection | Position size decrease without matching trade | Same logic, different data source |
| Fill confirmation | Verify on-chain position after tx | WS fill event + REST polling fallback |
| Entry price | Parsed from on-chain User account | Returned in position JSON |

### What Stays the Same

The reconciliation **logic** is protocol-agnostic:
- Compare DB position size vs on-chain/exchange position size
- Detect discrepancies
- Detect liquidations (size decreased without matching trade)
- Sync DB to truth
- Record liquidation trades

Only the **data source** changes — from byte-parsing RPC calls to adapter method calls.

---

## 14. Current Codebase — File-by-File Impact

### Server — Core Drift Files (Replace with Adapter)

| File | Lines | Action | Becomes |
|------|-------|--------|---------|
| `drift-service.ts` | 4,120 | **Replace** | `server/protocol/pacifica/pacifica-adapter.ts` |
| `drift-executor.mjs` | 2,229 | **Delete** | Not needed — Pacifica is REST, no subprocess |
| `swift-executor.ts` | 425 | **Delete** | No equivalent |
| `swift-config.ts` | 164 | **Delete** | No equivalent |
| `swift-metrics.ts` | ~100 | **Delete** | No equivalent |
| `drift-price.ts` | 208 | **Replace** | Adapter's `getPrice()` / `getAllPrices()` |
| `drift-data-api.ts` | 190 | **Replace** | Adapter's `getEquityHistory()` / `getTradeHistory()` |

### Server — New Protocol Layer Files

| File | Purpose |
|------|---------|
| `server/protocol/adapter.ts` | ProtocolAdapter interface + protocol-neutral types |
| `server/protocol/symbol-registry.ts` | Bidirectional symbol mapping |
| `server/protocol/adapter-registry.ts` | Active adapter accessor |
| `server/protocol/pacifica/pacifica-adapter.ts` | Full Pacifica implementation |
| `server/protocol/pacifica/pacifica-signer.ts` | Canonical JSON signing |
| `server/protocol/pacifica/pacifica-ws.ts` | WebSocket connection manager |
| `server/protocol/pacifica/pacifica-types.ts` | Pacifica API response types |

### Server — Dependent Services (Refactor to Use Adapter)

| File | Lines | Current Coupling | Migration Effort | Notes |
|------|-------|-----------------|------------------|-------|
| `agent-wallet.ts` | 511 | **Low** | **Minor** | Add Pacifica agent wallet registration |
| `market-registry.ts` | 187 | **High** | **Rewrite** | Pull from adapter's `getMarkets()` instead of hardcoded Drift indices |
| `position-service.ts` | 450 | **High** | **Rewrite** | Use `adapter.getPositions()` instead of byte parsing. **Also:** hardcoded `MAINTENANCE_MARGIN_WEIGHTS` (lines 4-30) are Drift-specific — replace with `adapter.getMaintenanceMarginWeight()` |
| `reconciliation-service.ts` | 788 | **High** | **Refactor** | Replace `getPerpPositions()` with `adapter.getPositions()` |
| `trade-retry-service.ts` | 1,084 | **High** | **Refactor** | **Understated in original scope.** Directly imports `closePerpPosition`, `executePerpOrder`, `getPerpPositions`, `settleAllPnl`, `executeAgentDriftWithdraw` (line 2). Job shape assumes numeric `subAccountId` (line 19). Startup rebuilds jobs using `bot.driftSubaccountId` (line ~974). Must be fully rerouted through adapter, not patched |
| `leverage-cache-service.ts` | 212 | **High** | **Rewrite** | Currently imports `@drift-labs/sdk`, decodes on-chain PerpMarket accounts via Borsh to read `marginRatioInitial`. Replace entirely with adapter's `getMarkets()` which returns leverage per-market |
| `market-liquidity-service.ts` | 546 | **High** | **Rewrite** | Hardcoded Drift OI data (lines 149-219), Drift metadata defs (lines 57-127). Replace with adapter's market data + orderbook |
| `portfolio-snapshot-job.ts` | 126 | **Medium** | **Adapt** | Use `adapter.getAccountInfo()` |
| `pnl-snapshot-job.ts` | 148 | **Medium** | **Adapt** | Use adapter position data |
| `analytics-indexer.ts` | 250 | **Medium** | **Adapt** | Imports `drift-data-api.ts` (line 3) — must be refactored BEFORE `drift-data-api.ts` is deleted in Phase 5 |
| `orphaned-subaccount-cleanup.ts` | 83 | **High** | **Rewrite** | Use `adapter.listSubaccounts()` |
| `profit-share-retry-job.ts` | ~150 | **Low** | **Minor** | Profit share logic is exchange-agnostic |

### Server — Routes (Significant Refactor)

| Area | Endpoint Pattern | Count | Notes |
|------|-----------------|-------|-------|
| Deposit/Withdraw | `/api/agent/drift-deposit`, `/api/agent/drift-withdraw` | 2 | Rename to `/api/agent/deposit`, `/api/agent/withdraw` |
| Bot Balance | `/api/bots/:id/drift-balance` | 1 | Rename to `/api/bots/:id/balance` |
| Agent Balance | `/api/agent/drift-balance` | 1 | Rename to `/api/agent/balance` |
| Markets | `/api/drift/markets`, `/api/drift/markets/:symbol` | 2 | Rename to `/api/exchange/markets` |
| Leverage | `/api/drift/leverage-limits` | 1 | Rename to `/api/exchange/leverage-limits` |
| Non-tradable | `/api/drift/non-tradable-markets` | 1 | Rename to `/api/exchange/non-tradable-markets` |
| USDC APY | `/api/drift/usdc-apy` | 1 | **Remove** (Drift-specific lending feature) |
| User Deposit/Withdraw | `/api/drift/deposit`, `/api/drift/withdraw`, `/api/drift/balance` | 3 | Rename to `/api/exchange/*` |
| Account Reset | `/api/wallet/reset-drift-account` | 1 | Rethink — Pacifica has no on-chain account to reset |
| Cache Status | `/api/drift/markets/cache/status` | 1 | Rename to `/api/exchange/markets/cache/status` |
| Swift Metrics | Admin swift metrics endpoint | 1 | **Remove** |
| Trade Execution | Webhook handler, `computeTradeSizingAndTopUp` | — | Rewire to adapter calls |

**Total: 15+ Drift-named API endpoints to rename and rewire**

All route handlers switch from importing `drift-service.ts` directly to calling `getActiveAdapter()` methods.

### Client — Frontend Files (16 files)

| File | Drift Refs | Migration Effort | Notes |
|------|-----------|------------------|-------|
| `lib/drift-constants.ts` | **Complete** | **Rewrite** | Rename to `exchange-constants.ts` |
| `hooks/useLeverageLimits.ts` | **High** | **Adapt** | Update API endpoint reference |
| `lib/strategy-insights.ts` | **Medium** | **Adapt** | Uses `getDriftMaxLeverage` |
| `components/BotManagementDrawer.tsx` | **High** | **Adapt** | 6 Drift API calls, "Drift balance" UI labels |
| `components/CreateBotModal.tsx` | **Medium** | **Adapt** | Market fetch + deposit API calls |
| `pages/WalletManagement.tsx` | **High** | **Adapt** | "Drift deposit/withdraw" labels |
| `pages/App.tsx` | **Medium** | **Adapt** | "Reset Drift Account" flow |
| `pages/Docs.tsx` | **High** | **Rewrite** | 50 references to Drift/Swift |
| `pages/QuantumLab.tsx` | **Low** | **Adapt** | Deposit + non-tradable market calls |
| `hooks/useApi.ts` | **Low** | **Adapt** | `HealthMetrics.marketIndex` type |
| `pages/PitchDeck.tsx` | **Medium** | **Adapt** | 13 Drift references |
| `pages/Landing.tsx` | **Low** | **Adapt** | 3 Drift references |
| `pages/Analytics.tsx` | **Low** | **Adapt** | 1 Drift reference |
| `pages/Admin.tsx` | **Low** | **Adapt** | 1 Drift reference |
| `components/SubscribeBotModal.tsx` | **Low** | **Adapt** | 1 Drift reference |
| `components/WelcomePopup.tsx` | **Low** | **Adapt** | 1 Drift reference |
| `components/EquityHistory.tsx` | **Low** | **Adapt** | 2 Drift references |

### Server — Startup Sequence (`server/index.ts`)

The server startup initializes multiple Drift-coupled subsystems. ALL must be adapter-aware before Phase 5 can delete Drift files:

| Line(s) | Current Startup Call | Drift Coupling | Migration |
|---------|---------------------|---------------|-----------|
| 477 | `syncMarketRegistry()` (from `drift-service.ts`) | Direct import | Replace with `adapter.getMarkets()` → populate `market-registry.ts` |
| 488 | `initLeverageCache()` (from `leverage-cache-service.ts`) | Imports `@drift-labs/sdk`, decodes on-chain PerpMarket | Replace with adapter market data (leverage is in `ProtocolMarket.maxLeverage`) |
| 494 | `startOrphanedSubaccountCleanup()` | Uses Drift subaccount discovery | Replace with `adapter.discoverSubaccounts()` |
| 471 | `startPeriodicReconciliation()` | Uses `getPerpPositions()` | Replace with `adapter.getPositions()` |
| ~500 | Trade-retry job reconstruction | Loads `bot.driftSubaccountId` (line ~974 of trade-retry-service.ts) | Must use `bot.protocol_subaccount_id` and resolve adapter per-bot |

**Phase gate:** Phase 5 (delete Drift files) CANNOT proceed until ALL startup imports are de-drifted. A single remaining import will crash the server on boot.

### Server — Additional Files

| File | Drift Reference | Notes |
|------|----------------|-------|
| `server/index.ts` | Imports `syncMarketRegistry` from `drift-service` | Startup init → rewire to adapter |
| `server/storage.ts` | `getNextSubaccountId` (line 398, comment "Drift requires sequential"), `getAllocatedSubaccountIds` (line 419), `driftSubaccountId` column references throughout | Refactor subaccount allocation: remove sequential-integer assumption, add `getNextProtocolSubaccountId()` and `getAllocatedProtocolSubaccountIds()` that work with string IDs |
| `server/rpc-config.ts` | Drift RPC endpoint configuration | Evaluate — may still be needed for on-chain deposit/withdraw |
| `server/check-agent-referrer.mjs` | Drift on-chain referrer PDA checking | Delete — replaced by Builder Program |
| `server/docs-markdown.ts` | Documentation content references Drift/Swift | Content rewrite |

### Shared Schema (`shared/schema.ts`)

| Table | Column | Current (Drift) | Migration |
|-------|--------|----------------|-----------|
| `wallets` | `drift_subaccount` | Integer (on-chain PDA index) | Add `protocol_subaccount_id: text` |
| `trading_bots` | `drift_subaccount_id` | Integer (per-bot subaccount) | Add `protocol_subaccount_id: text` |
| `bot_trades` | `tx_signature` | Solana tx signature | Keep for deposits; add `protocol_order_id: text` |
| `bot_trades` | `execution_method` | `'legacy'` / `'swift'` | Add `'pacifica'` value |
| `bot_trades` | `swift_order_id` | Swift-specific UUID | Deprecate (keep for history) |
| `bot_trades` | `auction_duration_ms` | Drift JIT auction param | Deprecate |
| `equity_events` | `tx_signature` | On-chain deposit/withdraw tx | Keep — deposits are still on-chain |
| `orphaned_subaccounts` | `drift_subaccount_id` | On-chain PDA index | Replace with `protocol_subaccount_id` |
| `pending_profit_shares` | `drift_subaccount_id` | Integer (line 596) | Add `protocol_subaccount_id: text` — integer blocker for Pacifica string IDs |
| `bot_positions` | `market` | `SOL-PERP` format | Keep as-is — adapter converts at boundary |

### NPM Dependencies

| Package | Action |
|---------|--------|
| `@drift-labs/sdk` | **Remove** — largest Drift dependency, causes ESM/CJS issues, memory leaks |
| `@solana/web3.js` | **Keep** — still needed for on-chain deposit/withdraw transactions |
| `@coral-xyz/anchor` | **Evaluate** — may not be needed if all Pacifica interaction is REST |
| `bs58` | **Keep** — needed for Base58 signature encoding |
| `tweetnacl` or `@noble/ed25519` | **Add** — for Ed25519 signing (canonical JSON payloads) |

### Total Impact Summary

| Category | Files | Lines |
|----------|-------|-------|
| Server — Delete | 5 files | ~3,118 |
| Server — Replace | 2 files | ~4,328 |
| Server — Refactor | 12 files | ~4,535 |
| Server — New (protocol layer) | 7 files | ~2,500-3,500 est. |
| Server — Routes | 1 file | 15+ endpoints |
| Client — Adapt | 16 files | Various |
| Schema | 1 file | ~9 column additions |

### What Stays the Same

- `agent-wallet.ts` — keypair generation, encryption, USDC/SOL transfers (mostly unchanged)
- `server/lab/` — QuantumLab backtesting engine (no Drift dependency)
- `shared/schema.ts` — Structure intact, additive column changes only
- Bot management logic — create/start/stop/configure bot workflows
- Strategy engine — signal generation is independent of execution layer
- Notification service — exchange-agnostic
- Profit share system — exchange-agnostic (just needs correct PnL inputs)
- UMK encryption model — completely adapter-independent
- Pine Script engine — no execution layer coupling

---

## 15. Database Schema Changes

Schema changes are **additive only** — no column type changes, no drops of existing columns.

### New Columns

| Table | Column | Type | Purpose |
|-------|--------|------|---------|
| `trading_bots` | `protocol_subaccount_id` | `text` | Protocol's subaccount identifier |
| `trading_bots` | `active_protocol` | `text` | Which protocol this bot uses (default: `"pacifica"`) |
| `wallets` | `protocol_subaccount_id` | `text` | Master account's protocol subaccount |
| `bot_trades` | `protocol_order_id` | `text` | Protocol's order ID (UUID for Pacifica) |
| `bot_trades` | `client_order_id` | `text` | Our UUID — enables durable order correlation across restarts/timeouts |
| `pending_profit_shares` | `protocol_subaccount_id` | `text` | Protocol's subaccount ID (currently `drift_subaccount_id: integer` — line 596 of schema.ts) |
| `orphaned_subaccounts` | `protocol_subaccount_id` | `text` | Replaces current `drift_subaccount_id: integer` |

### Column Value Changes (No Schema Change)

| Table.Column | Old Values | New Values |
|-------------|------------|------------|
| `bot_trades.execution_method` | `'legacy'`, `'swift'` | Add `'pacifica'` |
| `bot_trades.tx_signature` | Always populated | Nullable for Pacifica trades (only deposits are on-chain) |
| `bot_trades.swift_order_id` | Swift UUID | Always null for new trades (keep column for history) |

### Constants

| Constant | Current | New | Location |
|----------|---------|-----|----------|
| Commission rate | `0.0005` (5 bps) | `0.0004` (4 bps) | Configurable per-adapter |
| Market format | `SOL-PERP` (with index) | Keep `SOL-PERP` internally | SymbolRegistry handles conversion |

### Data Migration Notes
- Existing PnL history, trade logs, and snapshots remain valid and untouched
- Old Drift columns (`drift_subaccount_id`, `swift_order_id`, etc.) kept for historical queries
- No data migration needed — schema is additive only
- New bots use `protocol_subaccount_id`; old bots retain `drift_subaccount_id` for history

---

## 16. Dead Code & Technical Debt Cleanup

### Functions to Remove

| File | Function | Reason |
|------|----------|--------|
| `drift-service.ts` | `getPerpPositionsSDK()` | Deprecated — replaced by byte-parsing, now replaced by adapter |
| `drift-service.ts` | `getAccountHealthMetrics()` | Deprecated — never called in production |
| `session-v3.ts` | `validateAndConsumeNonce()` | Deprecated — replaced by `verifySignatureAndConsumeNonce()` |
| `crypto.ts` | Entire file | Legacy v1 encryption — only kept for backward compat migration; remove once all wallets are on v3 |

### Files to Delete

| File | Lines | Reason |
|------|-------|--------|
| `drift-executor.mjs` | 2,229 | Subprocess SDK pattern — Pacifica is REST |
| `swift-executor.ts` | 425 | Swift protocol — Drift-specific |
| `swift-config.ts` | 164 | Swift configuration — Drift-specific |
| `swift-metrics.ts` | ~100 | Swift metrics — Drift-specific |
| `drift-data-api.ts` | 190 | Drift public data API client — replaced by adapter |
| `check-agent-referrer.mjs` | ~100 | Drift on-chain referrer PDA checker — replaced by Builder Program |
| `lab/pine/test-*.ts` | Various | Dead test files |

### Code Blocks to Clean Up

- Commented-out SDK import blocks in `drift-service.ts`
- Drift SDK subprocess spawning logic
- `getSubaccountInfo` Anchor byte-parsing fallbacks
- Market registry SDK sync (`syncFromSdk` function imports `@drift-labs/sdk`)
- Legacy `encrypt`/`decrypt` calls from `crypto.ts` (grep for `from './crypto'` imports)

### Git Preservation

Before deleting any Drift files, create a `drift-archive` branch preserving the full Drift integration for reference. All deletions happen on `main` only after the archive branch exists.

---

## 17. Migration Phases

### Phase 0: Business Prerequisites (Before any code)

- [ ] Apply to Builder Program (ops@pacifica.fi / Discord / Telegram)
- [ ] Apply to Affiliate Program (Discord ticket)
- [ ] Get Builder Code assigned
- [ ] Verify $100K equity cap status
- [ ] Verify deposit contract address on Solana mainnet
- [ ] Test agent wallet registration flow on testnet
- [ ] Create testnet account at https://test-app.pacifica.fi (code: `Pacifica`)

### Phase 1: Protocol Adapter Foundation (Est. 3-4 sessions)

- [ ] Create `server/protocol/` directory structure
- [ ] Define `ProtocolAdapter` interface in `server/protocol/adapter.ts`
- [ ] Define all protocol-neutral types (OrderResult, ProtocolPosition, AccountInfo, etc.)
- [ ] Build `SymbolRegistry` in `server/protocol/symbol-registry.ts`
- [ ] Build `AdapterRegistry` in `server/protocol/adapter-registry.ts`
- [ ] Implement `pacifica-signer.ts` (canonical JSON + Ed25519 signing)
- [ ] Implement `pacifica-types.ts` (Pacifica API response types)
- [ ] Schema migration: add `protocol_subaccount_id`, `protocol_order_id`, `active_protocol` columns
- [ ] Install `tweetnacl` or `@noble/ed25519` for signing
- [ ] Verify signing against Pacifica testnet

### Phase 2: Pacifica Adapter — Core Implementation (Est. 3-4 sessions)

- [ ] Implement `pacifica-adapter.ts` — market data methods (`getMarkets`, `getPrice`, `getAllPrices`)
- [ ] Implement account methods (`getAccountInfo`, `getPositions`, `getBalances`)
- [ ] Implement order methods (`placeMarketOrder`, `placeLimitOrder`, `cancelOrder`) with `builder_code`
- [ ] Implement position management (`closePosition`, `setLeverage`, `setMarginMode`)
- [ ] Implement `pacifica-ws.ts` — WebSocket connection manager for fills/positions
- [ ] Implement order state machine (submit → track → confirm → fallback)
- [ ] Implement subaccount methods (`createSubaccount`, `listSubaccounts`, `transferBetweenSubaccounts`)
- [ ] Implement deposit/withdraw (on-chain USDC transfer to Pacifica bridge contract)
- [ ] Implement agent wallet registration with Pacifica
- [ ] Test full order lifecycle on testnet

### Phase 3: Refactor Storage & Execution Paths (Est. 3-4 sessions)

- [ ] Refactor `storage.ts` — replace `getNextSubaccountId()` / `getAllocatedSubaccountIds()` with string-based `protocol_subaccount_id` methods
- [ ] Add `IStorage` methods for protocol-neutral subaccount allocation
- [ ] Refactor webhook handler to call `getAdapterForBot(bot).placeMarketOrder()` instead of drift-service
- [ ] Refactor `computeTradeSizingAndTopUp` to use adapter for balance/position checks
- [ ] Refactor `reconciliation-service.ts` — replace `getPerpPositions()` with `adapter.getPositions()`
- [ ] Refactor `market-registry.ts` — pull from `adapter.getMarkets()` instead of hardcoded indices
- [ ] Refactor `leverage-cache-service.ts` — use adapter market data
- [ ] Refactor `market-liquidity-service.ts` — use adapter orderbook data
- [ ] Refactor `trade-retry-service.ts` — replace all 5 Drift function imports (`closePerpPosition`, `executePerpOrder`, `getPerpPositions`, `settleAllPnl`, `executeAgentDriftWithdraw`), convert job shape to string subaccount IDs, update startup reconstruction (line ~974)
- [ ] Refactor `portfolio-snapshot-job.ts` and `pnl-snapshot-job.ts`
- [ ] Refactor `analytics-indexer.ts` — remove `drift-data-api` import (must happen before Phase 5 deletes that file)
- [ ] Refactor deposit/withdraw flows in `agent-wallet.ts` — preserve dual-path (user-signed + agent-signed)
- [ ] Refactor `orphaned-subaccount-cleanup.ts`
- [ ] Consolidate `normalizeMarket()` copies into single shared utility in `server/protocol/symbol-registry.ts`
- [ ] Refactor `position-service.ts` — replace hardcoded `MAINTENANCE_MARGIN_WEIGHTS` with `adapter.getMaintenanceMarginWeight()`
- [ ] Update `server/index.ts` startup to initialize adapter and orphaned-trade recovery (currently hardcodes `driftSubaccountId`)

### Phase 4: Route Renaming & Frontend Migration (Est. 2-3 sessions)

- [ ] Rename all 15+ `/api/drift/*` routes to `/api/exchange/*` or protocol-neutral names
- [ ] Update all `drift-service` imports in `routes.ts` to adapter calls
- [ ] Remove USDC APY endpoint (Drift-specific)
- [ ] Rethink "Reset Account" flow for Pacifica
- [ ] Rename `client/src/lib/drift-constants.ts` → `exchange-constants.ts`
- [ ] Update all 16 client files — API calls, UI labels, component props
- [ ] Update `Docs.tsx` documentation content (50 Drift/Swift references)
- [ ] Update `PitchDeck.tsx` and `Landing.tsx` content

### Phase 5: Cleanup & Testing (Est. 2-3 sessions)

**PHASE GATE — All must be true before proceeding:**
- [ ] ALL `server/index.ts` startup imports de-drifted (syncMarketRegistry, initLeverageCache, startOrphanedSubaccountCleanup, reconciliation, trade-retry reconstruction)
- [ ] `analytics-indexer.ts` no longer imports `drift-data-api.ts`
- [ ] `trade-retry-service.ts` fully rerouted through adapter (5 Drift function imports removed)
- [ ] `pending_profit_shares.protocol_subaccount_id` column populated for all active records
- [ ] No file in `server/` imports from `drift-service.ts`, `drift-price.ts`, or `drift-data-api.ts`

- [ ] Create `drift-archive` git branch
- [ ] Delete `drift-service.ts`, `drift-executor.mjs`, `drift-price.ts`, `drift-data-api.ts`
- [ ] Delete `swift-executor.ts`, `swift-config.ts`, `swift-metrics.ts`
- [ ] Remove `@drift-labs/sdk` from `package.json`
- [ ] Remove deprecated functions (see Section 16)
- [ ] Remove legacy `crypto.ts` (verify all wallets on v3 first)
- [ ] Clean up test files in `lab/pine/`
- [ ] End-to-end testing on Pacifica testnet
- [ ] Test full bot lifecycle: create → deposit → trade → close → withdraw
- [ ] Verify position/PnL reporting accuracy
- [ ] Verify builder code revenue attribution
- [ ] Verify subaccount isolation between bots
- [ ] Frontend smoke test: all pages, all flows

### Phase 6: Production Cutover & Canary (Est. 1-2 sessions)

- [ ] **Canary rollout:** Deploy with Pacifica adapter but only activate for 1-2 test bots (small positions)
- [ ] Monitor test bots for 24h — verify order placement, fills, PnL, reconciliation
- [ ] Verify builder code revenue is accruing on test trades
- [ ] **Gradual rollout:** Enable Pacifica adapter for all new bots
- [ ] Migrate existing bots by updating `active_protocol` column (no position migration — only switch after positions are closed)
- [ ] Monitor first 48h of full production trading
- [ ] Verify auto-withdraw profits flow
- [ ] Confirm WebSocket reconnection under network failures

### Existing Bot Migration Strategy

Existing bots with open positions on Drift cannot be switched mid-trade. The migration path:

1. **Bots with no open position:** Set `active_protocol = 'pacifica'` immediately. Next trade goes through Pacifica adapter.
2. **Bots with open positions:** Wait for position to close (via strategy signal or manual close). Then set `active_protocol = 'pacifica'`.
3. **Fund movement:** After bot's Drift position is closed, withdraw USDC from Drift subaccount → agent wallet → deposit to Pacifica subaccount. This is a manual or semi-automated process per bot.
4. **No forced position migration:** Never attempt to close on Drift and simultaneously open on Pacifica to "transfer" a position. This introduces execution risk and slippage.
5. **Timeline:** Phased over days/weeks as positions naturally close. Not a big-bang cutover.

### Rollback Plan

If critical issues are found during Phase 6:
1. **Immediate:** Set `defaultAdapterId` back to `'drift'` (if Drift adapter still exists) or pause all bot execution
2. **Per-bot:** Revert individual bots by setting `active_protocol = 'drift'` in the database
3. **Schema:** All schema changes are additive — old Drift columns are preserved, so rollback requires zero data migration
4. **Git:** `drift-archive` branch has all original code for full revert if needed
5. **No position migration needed:** Bots should only switch protocols when flat (no open positions). The canary phase enforces this.

**Total estimated effort: 15-20 active sessions** (excluding Phase 0 business prerequisites)

---

## 18. Critical Execution Risks

### 18.1 Order Lifecycle State Machine

**Problem:** Drift's execution is on-chain and atomic. Pacifica is off-chain-first with async matching. Orders have intermediate states that Drift doesn't have.

**Required:**
- Assign `client_order_id` (UUID) to every order for idempotent retries
- Track order state via WebSocket `account_orders` channel
- Handle partial fills (current system assumes atomic fills)
- Prevent duplicate submissions when TradingView webhooks retry
- Timeout orders not acknowledged within 30 seconds

### 18.2 Fill Confirmation & Reconciliation

**Problem:** Current system verifies trades by reading on-chain position state. With Pacifica, position state is off-chain.

**Risk:** If WebSocket events are delayed or lost, the system could report false success, record phantom PnL, or miss fills entirely.

**Required mitigation:**
1. Primary: WebSocket `account_trades` for real-time fill events
2. Fallback: REST `GET /positions` polling on 5-second intervals when WS disconnected
3. Reconciliation: Periodic (60s) position check via REST
4. Invariant: Never record PnL until position state is confirmed

### 18.3 Deposit Contract / Destination Validation

**Problem:** Sending USDC to the wrong on-chain address is irreversible.

**Required before Phase 1 (blocker — no code that touches funds without this):**
- Identify exact Pacifica bridge contract address on Solana mainnet
- Validate on testnet with small amounts first
- Hardcode and verify destination with a checksum
- Add pre-flight validation that destination account is owned by expected program

### 18.4 Symbol Canonicalization

**Decision made:** Keep `SOL-PERP` internally, convert at adapter boundary via SymbolRegistry (see Section 5). Zero data migration, zero fragmentation risk.

### 18.5 Webhook Idempotency

**Problem:** REST timeout doesn't mean order wasn't received. Retry creates duplicate order.

**Solution:** `client_order_id` on all orders makes retries idempotent at the exchange level.

---

## 19. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| $100K equity cap (beta) | **High** | Verify current limits; may block large portfolios |
| Builder Program rejection | **High** | Apply early; prepare pitch showing volume potential |
| Deposit contract address unknown | **Critical** | Must verify on testnet before any mainnet funds transfer |
| No TypeScript SDK | **Low** | REST API is simpler; we build our own thin client |
| Pacifica is newer/less battle-tested | **Medium** | Start with small positions; testnet first |
| WebSocket reliability unknown | **Medium** | Build reconnection logic + REST polling fallback |
| Rate limiting unknown specifics | **Medium** | API Config Keys available for higher limits |
| Signature format complexity | **Low** | Well-documented; Python SDK has reference implementation |
| Funding rate differences (hourly vs Drift) | **Low** | Update funding calculations in PnL reporting |
| Affiliate revenue cutoff at VIP tier | **Medium** | Builder Program revenue not subject to this |
| Pacifica itself getting hacked | **Medium** | Off-chain orderbook + on-chain settlement reduces surface area |
| Adapter abstraction overhead | **Low** | One extra function call layer — negligible latency |

---

## 20. What We Gain

1. **Protocol independence** — never locked to a single DEX again; swap adapters without touching bot logic
2. **No SDK dependency** — pure HTTP/WS, no memory leaks, no CJS/ESM compatibility issues
3. **No on-chain byte parsing** — positions/balances come as clean JSON
4. **No subprocess executor** — eliminate `drift-executor.mjs` complexity entirely
5. **Simpler subaccounts** — REST API calls vs on-chain PDA initialization
6. **Lower base fees** — 4 bps taker vs Drift's 5 bps
7. **Sub-10ms API latency** — off-chain matching engine
8. **~4,000 fewer lines of code** — removing SDK workarounds, byte parsing, Swift protocol, subprocess management
9. **Testnet available** — proper staging environment for integration testing
10. **Builder Program revenue** — potentially higher and more flexible than Drift's fixed 15% referral
11. **No Solana RPC dependency for trading** — eliminates rate limit issues, 429 errors, RPC failover complexity
12. **Future-proof** — adding Raydium, Flash Trade, or recovered Drift is just implementing a new adapter
13. **New asset classes** — Pacifica offers equities, commodities, forex, indices — strategy expansion possibilities

---

## 21. Open Questions

### Must-Answer Before Phase 1 (Blockers)

1. **Deposit contract address** — What is the exact on-chain Solana program/account for USDC deposits? **Funds-safety blocker.**
2. **Builder Program approval** — Has the application been submitted? Timeline? Revenue model depends on this.
3. **Beta equity cap** — Is $100K still the limit? Has it been raised?

### Should-Answer Before Phase 2

4. **Agent wallet registration** — Can this be done purely via API, or does it require UI interaction?
5. **Partial fill handling** — Does Pacifica support partial fills on market orders? How reported via WS?
6. **Order rejection codes** — Error codes for insufficient margin, invalid symbol, rate limit, etc.?
7. **WebSocket reconnection** — Resume tokens or sequence IDs for missed events?

### Nice-to-Know

8. **Subaccount limits** — How many subaccounts per master account?
9. **Builder fee_rate limits** — Max fee_rate cap?
10. **Historical data depth** — How far back does `/account/equity_history` go?
11. **Cross-margin behavior** — Per-subaccount or account-wide?
12. **Referral + Builder stacking** — Earn both affiliate and builder fee on same user's trades?

---

## 22. Decision Framework

### Go with Pacifica adapter if:
- Drift remains compromised or offline
- Builder Program application is accepted
- All four actively traded markets available (confirmed: yes)
- Beta equity cap is lifted or acceptable
- Testnet integration validates successfully

### Hold off if:
- Drift recovers quickly and funds are returned
- $100K cap blocks meaningful trading and no timeline to lift
- Another DEX emerges with better API/coverage

### The adapter architecture is built regardless:
Even if Drift recovers, the adapter pattern is worth building. It prevents future lock-in, cleans up significant technical debt, and positions QuantumVault as an execution layer rather than a Drift wrapper.

---

## 23. Future: Multi-Protocol & Smart Routing

### Phase 3: Second Adapter (After Pacifica Stabilization)

Candidates for a second adapter:

| Protocol | Pros | Cons |
|----------|------|------|
| Recovered Drift | We already know the protocol; existing users | Trust concerns post-hack |
| Raydium Perps | Large Solana ecosystem; high liquidity | API maturity unknown |
| Flash Trade | Growing Solana perp DEX | Newer, smaller |
| Zeta Markets | Established Solana perps | SDK-dependent |

Adding a second adapter requires:
1. Implement the `ProtocolAdapter` interface for the new protocol
2. Add symbol mappings to a new SymbolRegistry instance
3. Register in the AdapterRegistry
4. No changes to bot logic, strategies, or frontend

### Phase 4: Smart Routing

Once two or more adapters are active:

```
Bot Signal → Smart Router → evaluates each adapter:
                          → best price (orderbook depth)
                          → lowest fee
                          → fastest fill
                          → available leverage
                          → available balance
                          → routes order to optimal adapter
```

Smart routing is a competitive advantage — similar to what Ranger Finance does for Solana perps, but integrated into our AI trading platform.

### Revenue Implications

With multiple adapters:
- Builder code revenue from Pacifica
- Referral revenue from Drift (if recovered)
- Fee optimization across protocols
- Best execution for users = higher retention

---

## Appendix: Builder Program Deep Dive

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
| Implementation | Complex (PDA derivation, referrer lookup) | Simple (one field in JSON payload) |

### Pacifica Partner Ecosystem Context

- **Fuul** (fuul.xyz) powers referral/points infrastructure with on-chain tracking, anti-sybil, and payout automation
- **Privy** (privy.io) handles auth — not relevant for us since we use our own agent wallet system

/**
 * Flash Trade protocol adapter — Phase 1 foundation.
 *
 * Phase 1 scope (this file):
 *   ✅ initialize / shutdown / healthCheck
 *   ✅ getCapabilities
 *   ✅ getMarkets  — from static FLASH_MARKET_SPECS + PoolConfig
 *   ✅ getPrice    — Pyth Hermes HTTP API (per-symbol)
 *   ✅ getAllPrices — batch Pyth Hermes HTTP API
 *   ✅ getMaintenanceMarginWeight / quantizeOrderSize / quantizePrice stubs
 *   🔜 Phase 2: placeMarketOrder, closePosition, executeDeposit, executeWithdraw,
 *               createSubaccount, getPositions, getBalances, getAccountInfo, …
 *
 * Account model: independent_trader — each bot keypair IS the on-chain
 * position owner.  There are no Pacifica-style "subaccounts"; the bot wallet
 * address is the protocol subaccount ID stored in the DB.
 *
 * Collateral: USDC for short positions (target-custody = asset, collateral-
 * custody = USDC). Long positions use the target asset as collateral — Phase 2
 * will handle the USDC→asset swap step or restrict bots to shorts-only initially.
 *
 * Builder rebate: every trade instruction must include FLASH_BUILDER_WALLET
 * as the `builderKey` param to claim the 10% rebate. This is wired in Phase 2.
 */

import type {
  ProtocolAdapter,
  CreateSubaccountInput,
  SubaccountCaps,
  ReuseSubaccountInput,
  ReuseSubaccountResult,
} from '../adapter.js';
import type {
  ProtocolMarket,
  ProtocolPosition,
  MarketOrderParams,
  LimitOrderParams,
  OrderResult,
  CancelOrderParams,
  CancelAllOrdersParams,
  CancelResult,
  ClosePositionParams,
  SetLeverageParams,
  SetMarginModeParams,
  StopOrderParams,
  TpSlParams,
  CancelStopOrderParams,
  AgentDepositParams,
  AgentWithdrawParams,
  DepositResult,
  WithdrawResult,
  TransferParams,
  TransferResult,
  SubaccountInfo,
  AccountInfo,
  BalanceInfo,
  OrderbookSnapshot,
  FundingRateInfo,
  HistoryParams,
  EquityPoint,
  TradeRecord,
  AdapterCapabilities,
} from '../protocol-types.js';

import {
  FLASH_PYTH_PRICE_IDS,
  FLASH_MARKET_SPECS,
  FLASH_USDC_MINT,
  FLASH_MIN_TRANSFER_USDC,
} from './flash-constants.js';
import type { PythHermesResponse } from './flash-types.js';
import {
  getCachedMarkets,
  setCachedMarkets,
  getCachedPrice,
  setCachedPrice,
  invalidateAllCaches,
} from './flash-cache.js';

// ── Pyth Hermes endpoint ──────────────────────────────────────────────────────

const PYTH_HERMES_BASE = 'https://hermes.pyth.network';
const PYTH_FETCH_TIMEOUT_MS = 8_000;

// ── Not-implemented error ─────────────────────────────────────────────────────

function notImplemented(method: string): never {
  throw new Error(
    `FlashAdapter.${method}: not yet implemented — scheduled for Phase 2. ` +
    `Do not silently fall back; this bot must not execute trades through an unimplemented path.`,
  );
}

// ── Adapter class ─────────────────────────────────────────────────────────────

export class FlashAdapter implements ProtocolAdapter {
  readonly protocolName = 'flash';
  readonly protocolVersion = '15';
  readonly collateralMint = FLASH_USDC_MINT;
  readonly collateralSymbol = 'USDC';
  readonly minTransferAmount = FLASH_MIN_TRANSFER_USDC;

  readonly subaccountCaps: SubaccountCaps = {
    permanent: false,
    recyclable: false,
    maxPerAgent: null,
    accountModel: 'independent_trader',
  };

  private initialized = false;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;
    // Warm the market cache on startup so the first getMarkets() call is instant.
    await this.getMarkets();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    invalidateAllCaches();
    this.initialized = false;
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const price = await this._fetchPriceFromHermes(['SOL-PERP']);
      const latencyMs = Date.now() - start;
      const healthy = price['SOL-PERP'] != null && price['SOL-PERP'] > 0;
      return { healthy, latencyMs, error: healthy ? undefined : 'SOL price returned 0 or null' };
    } catch (err: unknown) {
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  getCapabilities(): AdapterCapabilities {
    return {
      supportsPartialFills: true,
      supportsStopOrders: true,
      supportsTpSl: true,
      supportsBatchOrders: false,
      supportsIsolatedMargin: true,
      supportsWebSocket: false,
      supportsSettlePnl: false,
      supportsCloseSubaccount: false,
      maxSubaccounts: null,
      settlementType: 'on-chain',
      requiresExternalSubaccountKey: true,
    };
  }

  // ── Markets ─────────────────────────────────────────────────────────────────

  async getMarkets(): Promise<ProtocolMarket[]> {
    const cached = getCachedMarkets();
    if (cached) return cached;

    const markets: ProtocolMarket[] = FLASH_MARKET_SPECS.map((spec) => ({
      internalSymbol: spec.internalSymbol,
      protocolSymbol: spec.flashSymbol,
      maxLeverage: spec.maxLeverage,
      minOrderSizeUsd: spec.minOrderSizeUsd,
      minOrderSizeBase: spec.minOrderSizeBase,
      tickSize: spec.tickSize,
      lotSize: spec.lotSize,
      isActive: true,
      category: spec.category,
      fullName: spec.fullName,
      maintenanceMarginWeight: spec.maintenanceMarginWeight,
      estimatedSlippagePct: spec.estimatedSlippagePct,
      riskTier: spec.riskTier,
    }));

    setCachedMarkets(markets);
    return markets;
  }

  getMaintenanceMarginWeight(internalSymbol: string): number {
    const spec = FLASH_MARKET_SPECS.find((s) => s.internalSymbol === internalSymbol);
    return spec?.maintenanceMarginWeight ?? 0.005;
  }

  quantizeOrderSize(internalSymbol: string, size: number): number {
    const spec = FLASH_MARKET_SPECS.find((s) => s.internalSymbol === internalSymbol);
    const lotSize = spec?.lotSize ?? 0.0001;
    return Math.floor(size / lotSize) * lotSize;
  }

  quantizePrice(internalSymbol: string, price: number): number {
    const spec = FLASH_MARKET_SPECS.find((s) => s.internalSymbol === internalSymbol);
    const tickSize = spec?.tickSize ?? 0.01;
    return Math.round(price / tickSize) * tickSize;
  }

  // ── Prices ──────────────────────────────────────────────────────────────────

  async getPrice(internalSymbol: string): Promise<number | null> {
    const cached = getCachedPrice(internalSymbol);
    if (cached !== null) return cached;

    const priceId = FLASH_PYTH_PRICE_IDS[internalSymbol];
    if (!priceId) return null;

    const prices = await this._fetchPriceFromHermes([internalSymbol]);
    return prices[internalSymbol] ?? null;
  }

  async getAllPrices(): Promise<Record<string, number>> {
    const symbols = Object.keys(FLASH_PYTH_PRICE_IDS);
    const cachedAll: Record<string, number> = {};
    const missing: string[] = [];

    for (const sym of symbols) {
      const cached = getCachedPrice(sym);
      if (cached !== null) {
        cachedAll[sym] = cached;
      } else {
        missing.push(sym);
      }
    }

    if (missing.length === 0) return cachedAll;

    const fetched = await this._fetchPriceFromHermes(missing);
    return { ...cachedAll, ...fetched };
  }

  // ── Internal: Pyth Hermes HTTP ──────────────────────────────────────────────

  private async _fetchPriceFromHermes(
    internalSymbols: string[],
  ): Promise<Record<string, number>> {
    const symbolsWithIds = internalSymbols
      .map((sym) => ({ sym, id: FLASH_PYTH_PRICE_IDS[sym] }))
      .filter((e): e is { sym: string; id: string } => e.id !== undefined);

    if (symbolsWithIds.length === 0) return {};

    const qs = symbolsWithIds.map((e) => `ids[]=${e.id}`).join('&');
    const url = `${PYTH_HERMES_BASE}/v2/updates/price/latest?${qs}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PYTH_FETCH_TIMEOUT_MS);

    let data: PythHermesResponse;
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Pyth Hermes HTTP ${res.status}: ${res.statusText}`);
      }
      data = (await res.json()) as PythHermesResponse;
    } finally {
      clearTimeout(timer);
    }

    // Build id → symbol reverse map.
    const idToSymbol = new Map<string, string>(
      symbolsWithIds.map((e) => [e.id.toLowerCase(), e.sym]),
    );

    const result: Record<string, number> = {};
    for (const entry of data.parsed ?? []) {
      const sym = idToSymbol.get(entry.id.toLowerCase());
      if (!sym) continue;
      const price = Number(entry.price.price) * Math.pow(10, entry.price.expo);
      if (Number.isFinite(price) && price > 0) {
        setCachedPrice(sym, price);
        result[sym] = price;
      }
    }
    return result;
  }

  // ── Orderbook / funding (Phase 2) ───────────────────────────────────────────

  async getOrderbook(_internalSymbol: string, _depth?: number): Promise<OrderbookSnapshot> {
    notImplemented('getOrderbook');
  }

  async getFundingRate(_internalSymbol: string): Promise<FundingRateInfo> {
    notImplemented('getFundingRate');
  }

  // ── Account / position reads (Phase 2) ─────────────────────────────────────

  async getAccountInfo(_agentPublicKey: string, _subaccountId?: string): Promise<AccountInfo> {
    notImplemented('getAccountInfo');
  }

  async getPositions(_agentPublicKey: string, _subaccountId?: string): Promise<ProtocolPosition[]> {
    notImplemented('getPositions');
  }

  async getBalances(_agentPublicKey: string, _subaccountId?: string): Promise<BalanceInfo> {
    notImplemented('getBalances');
  }

  async getEquityHistory(_agentPublicKey: string, _params?: HistoryParams): Promise<EquityPoint[]> {
    notImplemented('getEquityHistory');
  }

  async getTradeHistory(_agentPublicKey: string, _params?: HistoryParams): Promise<TradeRecord[]> {
    notImplemented('getTradeHistory');
  }

  async getBatchAccountInfo(_agentPublicKey: string, _subaccountIds: string[]): Promise<AccountInfo[]> {
    notImplemented('getBatchAccountInfo');
  }

  async getBatchPositions(
    _agentPublicKey: string,
    _subaccountIds: string[],
  ): Promise<Map<string, ProtocolPosition[]>> {
    notImplemented('getBatchPositions');
  }

  // ── Orders / positions (Phase 2) ────────────────────────────────────────────

  async placeMarketOrder(_params: MarketOrderParams): Promise<OrderResult> {
    notImplemented('placeMarketOrder');
  }

  async placeLimitOrder(_params: LimitOrderParams): Promise<OrderResult> {
    notImplemented('placeLimitOrder');
  }

  async cancelOrder(_params: CancelOrderParams): Promise<CancelResult> {
    notImplemented('cancelOrder');
  }

  async cancelAllOrders(_params: CancelAllOrdersParams): Promise<CancelResult> {
    notImplemented('cancelAllOrders');
  }

  async closePosition(_params: ClosePositionParams): Promise<OrderResult> {
    notImplemented('closePosition');
  }

  async setLeverage(_params: SetLeverageParams): Promise<void> {
    notImplemented('setLeverage');
  }

  async setMarginMode(_params: SetMarginModeParams): Promise<void> {
    // Flash uses per-market margin modes determined by custody configuration.
    // setMarginMode is a no-op for now; Phase 2 will map to market selection.
    return;
  }

  async placeStopOrder(_params: StopOrderParams): Promise<OrderResult> {
    notImplemented('placeStopOrder');
  }

  async setTpSl(_params: TpSlParams): Promise<OrderResult> {
    notImplemented('setTpSl');
  }

  async cancelStopOrder(_params: CancelStopOrderParams): Promise<CancelResult> {
    notImplemented('cancelStopOrder');
  }

  async cancelTpSlOrders(
    _params: { agentPublicKey: string; agentSecretKey: Uint8Array; mainWalletAddress: string; internalSymbol: string; subaccountId?: string },
  ): Promise<CancelResult> {
    notImplemented('cancelTpSlOrders');
  }

  // ── Deposits / withdrawals (Phase 2) ────────────────────────────────────────

  async executeDeposit(_params: AgentDepositParams): Promise<DepositResult> {
    notImplemented('executeDeposit');
  }

  async executeWithdraw(_params: AgentWithdrawParams): Promise<WithdrawResult> {
    notImplemented('executeWithdraw');
  }

  async transferBetweenSubaccounts(_params: TransferParams): Promise<TransferResult> {
    // Flash is independent_trader model — there is no concept of transferring
    // between subaccounts. Each bot wallet is independent.
    throw new Error(
      'FlashAdapter.transferBetweenSubaccounts: Flash uses the independent_trader model — ' +
      'fund/defund via executeDeposit/executeWithdraw on each individual bot wallet.',
    );
  }

  // ── Subaccount lifecycle (Phase 2) ───────────────────────────────────────────

  async createSubaccount(_input: CreateSubaccountInput): Promise<SubaccountInfo> {
    // Flash independent_trader model: "creating a subaccount" means generating
    // a fresh keypair and recording it. No on-chain transaction is needed at
    // account creation time — the first deposit creates the account implicitly.
    // Full implementation in Phase 2.
    notImplemented('createSubaccount');
  }

  async listSubaccounts(_agentPublicKey: string): Promise<SubaccountInfo[]> {
    notImplemented('listSubaccounts');
  }

  async discoverSubaccounts(_agentPublicKey: string): Promise<SubaccountInfo[]> {
    notImplemented('discoverSubaccounts');
  }

  // ── PnL settlement (on-chain perps; may not apply to Flash) ─────────────────

  async settlePnl(_params: import('../protocol-types.js').SettlePnlParams): Promise<import('../protocol-types.js').SettleResult> {
    notImplemented('settlePnl');
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  async getAdapterDiagnostics(): Promise<Record<string, unknown>> {
    const prices = await this.getAllPrices().catch(() => ({}));
    return {
      protocolName: this.protocolName,
      protocolVersion: this.protocolVersion,
      initialized: this.initialized,
      knownMarkets: FLASH_MARKET_SPECS.map((s) => s.internalSymbol),
      cachedPrices: prices,
    };
  }
}

export const flashAdapter = new FlashAdapter();

import type { ProtocolAdapter } from '../adapter.js';
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
  FillEvent,
  OrderUpdate,
  SettlePnlParams,
  SettleResult,
  AdapterCapabilities,
  Unsubscribe,
} from '../protocol-types.js';
import { SymbolRegistry, buildPacificaMappings } from '../symbol-registry.js';
import { PacificaSigner, OPERATION_TYPES } from './pacifica-signer.js';
import type {
  PacificaMarketInfo,
  PacificaPositionResponse,
  PacificaAccountResponse,
  PacificaOrderResponse,
  PacificaTradeResponse,
  PacificaEquityHistoryPoint,
  PacificaSubaccountResponse,
  PacificaOrderbookLevel,
  PacificaFundingResponse,
} from './pacifica-types.js';
import { mapPacificaSide, mapToProtocolSide } from './pacifica-types.js';

const MAX_MARKET_CACHE_SIZE = 200;
const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
const PRICE_CACHE_TTL_MS = 60 * 1000;
const MAX_PRICE_CACHE_SIZE = 200;

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

export interface PacificaAdapterConfig {
  baseUrl: string;
  wsUrl: string;
  builderCode?: string;
}

const DEFAULT_CONFIG: PacificaAdapterConfig = {
  baseUrl: 'https://api.pacifica.fi/api/v1',
  wsUrl: 'wss://ws.pacifica.fi/ws',
};

export class PacificaAdapter implements ProtocolAdapter {
  readonly protocolName = 'pacifica';
  readonly protocolVersion = '1.0.0';

  private config: PacificaAdapterConfig;
  private registry: SymbolRegistry | null = null;
  private marketCache: CacheEntry<ProtocolMarket[]> | null = null;
  private priceCache: Map<string, CacheEntry<number>> = new Map();
  private marketDetailsMap: Map<string, ProtocolMarket> = new Map();
  private initialized = false;

  constructor(config?: Partial<PacificaAdapterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async initialize(): Promise<void> {
    const markets = await this.fetchMarkets();
    const pacificaSymbols = markets.map((m) => m.protocolSymbol);
    const mappings = buildPacificaMappings(pacificaSymbols);
    this.registry = new SymbolRegistry(mappings);

    this.marketCache = { data: markets, fetchedAt: Date.now() };
    this.marketDetailsMap.clear();
    for (const market of markets) {
      this.marketDetailsMap.set(market.internalSymbol.toUpperCase(), market);
    }

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.priceCache.clear();
    this.marketCache = null;
    this.marketDetailsMap.clear();
    this.initialized = false;
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.get('/info');
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
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
      supportsBatchOrders: true,
      supportsIsolatedMargin: true,
      supportsWebSocket: true,
      supportsSettlePnl: false,
      supportsCloseSubaccount: false,
      maxSubaccounts: null,
      settlementType: 'hybrid',
    };
  }

  async getMarkets(): Promise<ProtocolMarket[]> {
    if (
      this.marketCache &&
      Date.now() - this.marketCache.fetchedAt < MARKET_CACHE_TTL_MS
    ) {
      return this.marketCache.data;
    }

    const markets = await this.fetchMarkets();
    this.marketCache = { data: markets, fetchedAt: Date.now() };
    this.marketDetailsMap.clear();
    for (const market of markets) {
      this.marketDetailsMap.set(market.internalSymbol.toUpperCase(), market);
    }
    return markets;
  }

  async getPrice(internalSymbol: string): Promise<number | null> {
    const cached = this.priceCache.get(internalSymbol.toUpperCase());
    if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
      return cached.data;
    }

    const prices = await this.getAllPrices();
    return prices[internalSymbol] ?? null;
  }

  async getAllPrices(): Promise<Record<string, number>> {
    const response = await this.get('/prices');
    const result: Record<string, number> = {};

    if (Array.isArray(response)) {
      for (const entry of response) {
        const protocolSymbol = entry.symbol || entry.coin;
        const price = parseFloat(entry.price || entry.mid);
        if (!protocolSymbol || isNaN(price)) continue;

        let internalSymbol: string;
        try {
          internalSymbol = this.getRegistry().protocolToInternal(protocolSymbol);
        } catch {
          internalSymbol = `UNKNOWN-${protocolSymbol}`;
        }

        result[internalSymbol] = price;

        if (this.priceCache.size >= MAX_PRICE_CACHE_SIZE) {
          this.evictStalePrices();
        }
        this.priceCache.set(internalSymbol.toUpperCase(), {
          data: price,
          fetchedAt: Date.now(),
        });
      }
    }

    return result;
  }

  async getOrderbook(internalSymbol: string, depth?: number): Promise<OrderbookSnapshot> {
    const protocolSymbol = this.getRegistry().internalToProtocol(internalSymbol);
    const params: Record<string, string> = { symbol: protocolSymbol };
    if (depth !== undefined) params.depth = String(depth);

    const response = await this.get('/book', params);

    return {
      bids: (response.bids || []).map((l: PacificaOrderbookLevel) => ({
        price: parseFloat(l.price),
        size: parseFloat(l.size),
      })),
      asks: (response.asks || []).map((l: PacificaOrderbookLevel) => ({
        price: parseFloat(l.price),
        size: parseFloat(l.size),
      })),
      timestamp: response.timestamp || Date.now(),
    };
  }

  async getFundingRate(internalSymbol: string): Promise<FundingRateInfo> {
    const protocolSymbol = this.getRegistry().internalToProtocol(internalSymbol);
    const response: PacificaFundingResponse = await this.get('/funding', {
      symbol: protocolSymbol,
    });

    return {
      internalSymbol,
      rate: parseFloat(String(response.rate)),
      nextFundingTime: response.next_funding_time,
      timestamp: response.timestamp,
    };
  }

  getMaintenanceMarginWeight(internalSymbol: string): number {
    this.ensureInitialized();
    const market = this.marketDetailsMap.get(internalSymbol.toUpperCase());
    if (!market) {
      throw new Error(
        `PacificaAdapter: unknown market "${internalSymbol}" — not in market cache`,
      );
    }
    return market.maintenanceMarginWeight;
  }

  quantizeOrderSize(internalSymbol: string, size: number): number {
    this.ensureInitialized();
    const market = this.marketDetailsMap.get(internalSymbol.toUpperCase());
    if (!market) {
      throw new Error(`PacificaAdapter: unknown market "${internalSymbol}"`);
    }
    return Math.floor(size / market.lotSize) * market.lotSize;
  }

  quantizePrice(internalSymbol: string, price: number): number {
    this.ensureInitialized();
    const market = this.marketDetailsMap.get(internalSymbol.toUpperCase());
    if (!market) {
      throw new Error(`PacificaAdapter: unknown market "${internalSymbol}"`);
    }
    return Math.round(price / market.tickSize) * market.tickSize;
  }

  async getAccountInfo(agentPublicKey: string, subaccountId?: string): Promise<AccountInfo> {
    const params: Record<string, string> = { account: agentPublicKey };
    if (subaccountId) params.subaccount_id = subaccountId;

    const response: PacificaAccountResponse = await this.get('/account', params);

    return {
      equity: parseFloat(response.equity),
      balance: parseFloat(response.balance),
      unrealizedPnl: parseFloat(response.unrealized_pnl),
      availableMargin: parseFloat(response.available_margin),
      maintenanceMargin: parseFloat(response.maintenance_margin),
      feeTier: response.fee_tier,
      subaccountId: response.subaccount_id,
    };
  }

  async getPositions(agentPublicKey: string, subaccountId?: string): Promise<ProtocolPosition[]> {
    const params: Record<string, string> = { account: agentPublicKey };
    if (subaccountId) params.subaccount_id = subaccountId;

    const response: PacificaPositionResponse[] = await this.get('/positions', params);

    return response.map((p) => this.mapPosition(p));
  }

  async getBalances(agentPublicKey: string, subaccountId?: string): Promise<BalanceInfo> {
    const info = await this.getAccountInfo(agentPublicKey, subaccountId);
    return {
      totalEquity: info.equity,
      freeCollateral: info.availableMargin,
      totalMarginUsed: info.maintenanceMargin,
      unrealizedPnl: info.unrealizedPnl,
    };
  }

  async getEquityHistory(agentPublicKey: string, params?: HistoryParams): Promise<EquityPoint[]> {
    const queryParams: Record<string, string> = { account: agentPublicKey };
    if (params?.startTime) queryParams.start_time = String(params.startTime);
    if (params?.endTime) queryParams.end_time = String(params.endTime);
    if (params?.limit) queryParams.limit = String(params.limit);

    const response: PacificaEquityHistoryPoint[] = await this.get(
      '/account/equity_history',
      queryParams,
    );

    return response.map((p) => ({
      equity: parseFloat(p.equity),
      timestamp: p.timestamp,
    }));
  }

  async getTradeHistory(agentPublicKey: string, params?: HistoryParams): Promise<TradeRecord[]> {
    const queryParams: Record<string, string> = { account: agentPublicKey };
    if (params?.startTime) queryParams.start_time = String(params.startTime);
    if (params?.endTime) queryParams.end_time = String(params.endTime);
    if (params?.limit) queryParams.limit = String(params.limit);
    if (params?.offset) queryParams.offset = String(params.offset);

    const response: PacificaTradeResponse[] = await this.get('/account/trades', queryParams);

    return response.map((t) => ({
      tradeId: t.trade_id,
      orderId: t.order_id,
      clientOrderId: t.client_order_id,
      internalSymbol: this.safeProtocolToInternal(t.symbol),
      side: mapPacificaSide(t.side),
      price: parseFloat(t.price),
      size: parseFloat(t.size),
      fee: parseFloat(t.fee),
      timestamp: t.timestamp,
      subaccountId: t.subaccount_id,
    }));
  }

  async getBatchAccountInfo(
    agentPublicKey: string,
    subaccountIds: string[],
  ): Promise<AccountInfo[]> {
    const results: AccountInfo[] = [];
    for (const subId of subaccountIds) {
      results.push(await this.getAccountInfo(agentPublicKey, subId));
    }
    return results;
  }

  async getBatchPositions(
    agentPublicKey: string,
    subaccountIds: string[],
  ): Promise<Map<string, ProtocolPosition[]>> {
    const result = new Map<string, ProtocolPosition[]>();
    for (const subId of subaccountIds) {
      const positions = await this.getPositions(agentPublicKey, subId);
      result.set(subId, positions);
    }
    return result;
  }

  async placeMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    const signer = new PacificaSigner(params.agentSecretKey);
    const protocolSymbol = this.getRegistry().internalToProtocol(params.internalSymbol);

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      amount: String(params.sizeBase),
      side: mapToProtocolSide(params.side),
      reduce_only: params.reduceOnly ?? false,
    };

    if (params.clientOrderId) {
      operationData.client_order_id = params.clientOrderId;
    }

    if (params.builderCode || this.config.builderCode) {
      operationData.builder_code = params.builderCode || this.config.builderCode;
    }

    const body = signer.buildRequestBody(
      OPERATION_TYPES.CREATE_MARKET_ORDER,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response: PacificaOrderResponse = await this.post('/orders/create_market', body);

    return this.mapOrderResponse(response, params.clientOrderId);
  }

  async placeLimitOrder(params: LimitOrderParams): Promise<OrderResult> {
    const signer = new PacificaSigner(params.agentSecretKey);
    const protocolSymbol = this.getRegistry().internalToProtocol(params.internalSymbol);

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      price: String(params.price),
      amount: String(params.sizeBase),
      side: mapToProtocolSide(params.side),
      tif: params.timeInForce,
      reduce_only: params.reduceOnly ?? false,
    };

    if (params.clientOrderId) {
      operationData.client_order_id = params.clientOrderId;
    }

    if (params.builderCode || this.config.builderCode) {
      operationData.builder_code = params.builderCode || this.config.builderCode;
    }

    const body = signer.buildRequestBody(
      OPERATION_TYPES.CREATE_ORDER,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response: PacificaOrderResponse = await this.post('/orders/create', body);

    return this.mapOrderResponse(response, params.clientOrderId);
  }

  async cancelOrder(params: CancelOrderParams): Promise<CancelResult> {
    const signer = new PacificaSigner(params.agentSecretKey);

    const operationData: Record<string, unknown> = {
      order_id: params.orderId,
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.CANCEL_ORDER,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response = await this.post('/orders/cancel', body);

    return {
      success: response.success !== false,
      canceledCount: 1,
      error: response.error,
    };
  }

  async cancelAllOrders(params: CancelAllOrdersParams): Promise<CancelResult> {
    const signer = new PacificaSigner(params.agentSecretKey);

    const operationData: Record<string, unknown> = {};

    if (params.symbol) {
      operationData.symbol = this.getRegistry().internalToProtocol(params.symbol);
    }

    const body = signer.buildRequestBody(
      OPERATION_TYPES.CANCEL_ALL_ORDERS,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response = await this.post('/orders/cancel_all', body);

    return {
      success: response.success !== false,
      canceledCount: response.canceled_count,
      error: response.error,
    };
  }

  async closePosition(params: ClosePositionParams): Promise<OrderResult> {
    const positions = await this.getPositions(
      params.agentPublicKey,
      params.subaccountId,
    );

    const position = positions.find(
      (p) => p.internalSymbol.toUpperCase() === params.internalSymbol.toUpperCase(),
    );

    if (!position || position.baseSize === 0) {
      return {
        success: true,
        status: 'filled',
        fillSize: 0,
        clientOrderId: params.clientOrderId,
      };
    }

    const closeSide: 'long' | 'short' = position.baseSize > 0 ? 'short' : 'long';
    const closeSize = Math.abs(position.baseSize);

    return this.placeMarketOrder({
      agentPublicKey: params.agentPublicKey,
      agentSecretKey: params.agentSecretKey,
      mainWalletAddress: params.mainWalletAddress,
      internalSymbol: params.internalSymbol,
      side: closeSide,
      sizeBase: closeSize,
      reduceOnly: true,
      clientOrderId: params.clientOrderId,
      subaccountId: params.subaccountId,
      builderCode: params.builderCode,
    });
  }

  async setLeverage(params: SetLeverageParams): Promise<void> {
    const signer = new PacificaSigner(params.agentSecretKey);
    const protocolSymbol = this.getRegistry().internalToProtocol(params.internalSymbol);

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      leverage: params.leverage,
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.UPDATE_LEVERAGE,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    await this.post('/account/leverage', body);
  }

  async setMarginMode(params: SetMarginModeParams): Promise<void> {
    const signer = new PacificaSigner(params.agentSecretKey);

    const operationData: Record<string, unknown> = {
      margin_mode: params.mode,
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.UPDATE_MARGIN_MODE,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    await this.post('/account/margin', body);
  }

  async placeStopOrder(params: StopOrderParams): Promise<OrderResult> {
    const signer = new PacificaSigner(params.agentSecretKey);
    const protocolSymbol = this.getRegistry().internalToProtocol(params.internalSymbol);

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      amount: String(params.sizeBase),
      side: mapToProtocolSide(params.side),
      trigger_price: String(params.triggerPrice),
    };

    if (params.clientOrderId) {
      operationData.client_order_id = params.clientOrderId;
    }

    if (params.builderCode || this.config.builderCode) {
      operationData.builder_code = params.builderCode || this.config.builderCode;
    }

    const body = signer.buildRequestBody(
      OPERATION_TYPES.CREATE_STOP_ORDER,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response: PacificaOrderResponse = await this.post('/orders/stop/create', body);

    return this.mapOrderResponse(response, params.clientOrderId);
  }

  async setTpSl(params: TpSlParams): Promise<OrderResult> {
    const signer = new PacificaSigner(params.agentSecretKey);
    const protocolSymbol = this.getRegistry().internalToProtocol(params.internalSymbol);

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
    };

    if (params.takeProfitPrice !== undefined) {
      operationData.take_profit_price = String(params.takeProfitPrice);
    }
    if (params.stopLossPrice !== undefined) {
      operationData.stop_loss_price = String(params.stopLossPrice);
    }

    const body = signer.buildRequestBody(
      OPERATION_TYPES.SET_POSITION_TPSL,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response: PacificaOrderResponse = await this.post('/positions/tpsl', body);

    return this.mapOrderResponse(response);
  }

  async cancelStopOrder(params: CancelStopOrderParams): Promise<CancelResult> {
    const signer = new PacificaSigner(params.agentSecretKey);

    const operationData: Record<string, unknown> = {
      order_id: params.orderId,
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.CANCEL_STOP_ORDER,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response = await this.post('/orders/stop/cancel', body);

    return {
      success: response.success !== false,
      canceledCount: 1,
      error: response.error,
    };
  }

  async executeDeposit(_params: AgentDepositParams): Promise<DepositResult> {
    throw new Error(
      'PacificaAdapter.executeDeposit: not yet implemented — ' +
      'requires deposit contract address (Phase 0 blocker)',
    );
  }

  async executeWithdraw(params: AgentWithdrawParams): Promise<WithdrawResult> {
    const signer = new PacificaSigner(params.agentSecretKey);

    const operationData: Record<string, unknown> = {
      amount: String(params.amount),
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.WITHDRAW,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response = await this.post('/account/withdraw', body);

    return {
      success: response.success !== false,
      txSignature: response.tx_signature,
      error: response.error,
    };
  }

  async transferBetweenSubaccounts(params: TransferParams): Promise<TransferResult> {
    const signer = new PacificaSigner(params.agentSecretKey);

    const operationData: Record<string, unknown> = {
      from_subaccount: params.fromSubaccountId,
      to_subaccount: params.toSubaccountId,
      amount: String(params.amount),
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.SUBACCOUNT_TRANSFER,
      operationData,
      params.mainWalletAddress,
      signer.getPublicKey(),
    );

    const response = await this.post('/account/subaccount/transfer', body);

    return {
      success: response.success !== false,
      error: response.error,
    };
  }

  async createSubaccount(
    _agentPublicKey: string,
    _label?: string,
  ): Promise<SubaccountInfo> {
    throw new Error(
      'PacificaAdapter.createSubaccount: Pacifica requires signing for subaccount creation. ' +
      'Use createSubaccountWithKey(agentSecretKey, mainWalletAddress, label) instead. ' +
      'This gap is resolved in Phase 3 when per-bot signer injection is implemented.',
    );
  }

  async createSubaccountWithKey(
    agentSecretKey: Uint8Array,
    mainWalletAddress: string,
    label?: string,
  ): Promise<SubaccountInfo> {
    const signer = new PacificaSigner(agentSecretKey);

    const initiateData: Record<string, unknown> = {};
    if (label) initiateData.label = label;

    const initiateBody = signer.buildRequestBody(
      OPERATION_TYPES.SUBACCOUNT_INITIATE,
      initiateData,
      mainWalletAddress,
      signer.getPublicKey(),
    );

    const initiateResponse: PacificaSubaccountResponse = await this.post(
      '/account/subaccount/create',
      initiateBody,
    );

    const confirmData: Record<string, unknown> = {
      subaccount_id: initiateResponse.subaccount_id,
    };

    const confirmBody = signer.buildRequestBody(
      OPERATION_TYPES.SUBACCOUNT_CONFIRM,
      confirmData,
      mainWalletAddress,
      signer.getPublicKey(),
    );

    const confirmResponse: PacificaSubaccountResponse = await this.post(
      '/account/subaccount/create',
      confirmBody,
    );

    return {
      subaccountId: confirmResponse.subaccount_id,
      label: confirmResponse.label,
      equity: confirmResponse.equity ? parseFloat(confirmResponse.equity) : undefined,
      status: 'confirmed',
    };
  }

  async listSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]> {
    const response: PacificaSubaccountResponse[] = await this.get(
      '/account/subaccounts',
      { account: agentPublicKey },
    );

    return response.map((s) => ({
      subaccountId: s.subaccount_id,
      label: s.label,
      equity: s.equity ? parseFloat(s.equity) : undefined,
      status: 'confirmed' as const,
    }));
  }

  async discoverSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]> {
    return this.listSubaccounts(agentPublicKey);
  }

  async registerAgentWallet(
    mainWalletSecretKey: Uint8Array,
    mainWalletAddress: string,
    agentPublicKey: string,
  ): Promise<void> {
    const signer = new PacificaSigner(mainWalletSecretKey);

    const operationData: Record<string, unknown> = {
      agent_public_key: agentPublicKey,
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.BIND_AGENT_WALLET,
      operationData,
      mainWalletAddress,
      null,
    );

    await this.post('/agent/bind', body);
  }

  async settlePnl(_params: SettlePnlParams): Promise<SettleResult> {
    return {
      success: true,
      settledAmount: 0,
    };
  }

  private getRegistry(): SymbolRegistry {
    if (!this.registry) {
      throw new Error(
        'PacificaAdapter: SymbolRegistry not initialized — call initialize() first',
      );
    }
    return this.registry;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('PacificaAdapter: not initialized — call initialize() first');
    }
  }

  private evictStalePrices(): void {
    const now = Date.now();
    const toDelete: string[] = [];
    this.priceCache.forEach((entry, key) => {
      if (now - entry.fetchedAt > PRICE_CACHE_TTL_MS) {
        toDelete.push(key);
      }
    });
    for (const key of toDelete) {
      this.priceCache.delete(key);
    }
    if (this.priceCache.size >= MAX_PRICE_CACHE_SIZE) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      this.priceCache.forEach((entry, key) => {
        if (entry.fetchedAt < oldestTime) {
          oldestTime = entry.fetchedAt;
          oldestKey = key;
        }
      });
      if (oldestKey) {
        this.priceCache.delete(oldestKey);
      }
    }
  }

  private async fetchMarkets(): Promise<ProtocolMarket[]> {
    const response = await this.get('/info');

    const rawMarkets: PacificaMarketInfo[] = Array.isArray(response)
      ? response
      : response.markets || response.universe || [];

    if (rawMarkets.length === 0) {
      throw new Error('PacificaAdapter: /info returned no markets');
    }

    if (rawMarkets.length > MAX_MARKET_CACHE_SIZE) {
      console.warn(
        `PacificaAdapter: /info returned ${rawMarkets.length} markets, ` +
        `capping at ${MAX_MARKET_CACHE_SIZE}`,
      );
    }

    return rawMarkets.slice(0, MAX_MARKET_CACHE_SIZE).map((m) => {
      const protocolSymbol = m.symbol;
      let internalSymbol: string;

      try {
        const tempMappings = buildPacificaMappings([protocolSymbol]);
        internalSymbol = tempMappings[0]?.internal || `${protocolSymbol.toUpperCase()}-PERP`;
      } catch {
        internalSymbol = `${protocolSymbol.toUpperCase()}-PERP`;
      }

      return {
        internalSymbol,
        protocolSymbol,
        maxLeverage: m.max_leverage ?? 1,
        minOrderSizeUsd: m.min_order_size_usd ?? 10,
        minOrderSizeBase: m.min_order_size ?? 0,
        tickSize: m.tick_size ?? 0.01,
        lotSize: m.lot_size ?? 0.01,
        isActive: m.is_active !== false,
        category: m.category || [],
        fullName: m.full_name || protocolSymbol,
        maintenanceMarginWeight: m.maintenance_margin_weight ?? 0.03,
        openInterestUsd: m.open_interest,
      };
    });
  }

  private mapPosition(p: PacificaPositionResponse): ProtocolPosition {
    const size = parseFloat(p.size);
    return {
      internalSymbol: this.safeProtocolToInternal(p.symbol),
      baseSize: size,
      entryPrice: parseFloat(p.entry_price),
      markPrice: parseFloat(p.mark_price),
      unrealizedPnl: parseFloat(p.unrealized_pnl),
      leverage: parseFloat(p.leverage),
      liquidationPrice: p.liquidation_price ? parseFloat(p.liquidation_price) : null,
      marginMode: p.margin_mode,
      subaccountId: p.subaccount_id,
    };
  }

  private mapOrderResponse(
    response: PacificaOrderResponse,
    clientOrderId?: string,
  ): OrderResult {
    const status = this.normalizeOrderStatus(response.status);
    return {
      success: status !== 'rejected' && !response.error,
      orderId: response.order_id,
      clientOrderId: clientOrderId || response.client_order_id,
      status,
      fillPrice: response.fill_price ? parseFloat(response.fill_price) : undefined,
      fillSize: response.fill_size ? parseFloat(response.fill_size) : undefined,
      fee: response.fee ? parseFloat(response.fee) : undefined,
      error: response.error,
      rawResponse: response,
    };
  }

  private normalizeOrderStatus(
    status: string,
  ): OrderResult['status'] {
    const normalized = status?.toLowerCase();
    switch (normalized) {
      case 'submitted':
      case 'new':
      case 'open':
        return 'submitted';
      case 'acknowledged':
      case 'accepted':
        return 'acknowledged';
      case 'filled':
      case 'complete':
        return 'filled';
      case 'partial_fill':
      case 'partially_filled':
        return 'partial_fill';
      case 'canceled':
      case 'cancelled':
        return 'canceled';
      case 'expired':
        return 'expired';
      case 'rejected':
      case 'failed':
        return 'rejected';
      default:
        return 'submitted';
    }
  }

  private safeProtocolToInternal(protocolSymbol: string): string {
    try {
      return this.getRegistry().protocolToInternal(protocolSymbol);
    } catch {
      console.error(
        `PacificaAdapter: unknown protocol symbol "${protocolSymbol}" — ` +
        `using UNKNOWN-${protocolSymbol}`,
      );
      return `UNKNOWN-${protocolSymbol}`;
    }
  }

  private async get(path: string, params?: Record<string, string>): Promise<any> {
    let url = `${this.config.baseUrl}${path}`;
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `PacificaAdapter GET ${path}: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }

    return response.json();
  }

  private async post(path: string, body: unknown): Promise<any> {
    const url = `${this.config.baseUrl}${path}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `PacificaAdapter POST ${path}: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }

    return response.json();
  }
}

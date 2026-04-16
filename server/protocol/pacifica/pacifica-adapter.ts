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
import { PacificaSigner, OPERATION_TYPES, buildSigningMessage } from './pacifica-signer.js';
import {
  PACIFICA_PROGRAM_ID,
  PACIFICA_CENTRAL_STATE,
  PACIFICA_USDC_VAULT,
  USDC_MINT,
  EVENT_AUTHORITY,
  buildDepositInstruction,
  getAssociatedTokenAddress,
  usdcToLamports,
} from './pacifica-tx-builder.js';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getPrimaryRpcUrl } from '../../rpc-config.js';
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

const DISPLAY_NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP',
  DOGE: 'Dogecoin', SUI: 'Sui', HYPE: 'Hyperliquid', AVAX: 'Avalanche',
  ADA: 'Cardano', ARB: 'Arbitrum', BNB: 'Binance Coin', LINK: 'Chainlink',
  LTC: 'Litecoin', JUP: 'Jupiter', TAO: 'Bittensor', WIF: 'dogwifhat',
  TRUMP: 'Trump', PENGU: 'Pudgy Penguins', PAXG: 'PAX Gold',
  FARTCOIN: 'Fartcoin', PUMP: 'Pump.fun', ASTER: 'Aster', XPL: 'XPL',
  '2Z': '2Z', ZEC: 'Zcash', LIT: 'Litentry', MON: 'Monad',
  kBONK: 'Bonk', kPEPE: 'Pepe', AAVE: 'Aave', BCH: 'Bitcoin Cash',
  CRV: 'Curve', ENA: 'Ethena', ICP: 'Internet Computer', LDO: 'Lido',
  NEAR: 'Near Protocol', UNI: 'Uniswap', VIRTUAL: 'Virtuals Protocol',
  WLD: 'Worldcoin', XMR: 'Monero', ZK: 'zkSync', ZRO: 'LayerZero',
  STRK: 'Starknet', MEGA: 'MegaETH', PIPPIN: 'Pippin', WLFI: 'World Liberty Financial',
  CRCL: 'Circle', SP500: 'S&P 500', EURUSD: 'EUR/USD', USDJPY: 'USD/JPY',
  NVDA: 'Nvidia', TSLA: 'Tesla', GOOGL: 'Alphabet', PLTR: 'Palantir',
  HOOD: 'Robinhood', XAU: 'Gold', XAG: 'Silver', CL: 'Crude Oil',
  BP: 'BP plc', NATGAS: 'Natural Gas', COPPER: 'Copper', PLATINUM: 'Platinum',
  URNM: 'Uranium Miners ETF',
};

function countDecimals(val: number): number {
  if (!Number.isFinite(val) || Math.floor(val) === val) return 0;
  const s = String(val);
  const dotIndex = s.indexOf('.');
  return dotIndex < 0 ? 0 : s.length - dotIndex - 1;
}

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
    const result: Record<string, number> = {};

    const markets = this.marketCache?.data || [];
    if (markets.length === 0) return result;

    const staleSymbols: { internal: string; protocol: string }[] = [];
    const now = Date.now();

    for (const m of markets) {
      const cached = this.priceCache.get(m.internalSymbol.toUpperCase());
      if (cached && now - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
        result[m.internalSymbol] = cached.data;
      } else {
        staleSymbols.push({ internal: m.internalSymbol, protocol: m.protocolSymbol });
      }
    }

    const BATCH_SIZE = 5;
    for (let i = 0; i < staleSymbols.length; i += BATCH_SIZE) {
      const batch = staleSymbols.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(
        batch.map(async ({ internal, protocol }) => {
          const book = await this.get('/book', { symbol: protocol, depth: '1' });
          const bids = book?.l?.[0];
          const asks = book?.l?.[1];
          const bestBid = bids?.[0]?.p ? parseFloat(bids[0].p) : NaN;
          const bestAsk = asks?.[0]?.p ? parseFloat(asks[0].p) : NaN;
          let mid: number;
          if (!isNaN(bestBid) && !isNaN(bestAsk)) {
            mid = (bestBid + bestAsk) / 2;
          } else if (!isNaN(bestBid)) {
            mid = bestBid;
          } else if (!isNaN(bestAsk)) {
            mid = bestAsk;
          } else {
            return;
          }
          return { internal, mid };
        }),
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) {
          result[s.value.internal] = s.value.mid;
          if (this.priceCache.size >= MAX_PRICE_CACHE_SIZE) {
            this.evictStalePrices();
          }
          this.priceCache.set(s.value.internal.toUpperCase(), {
            data: s.value.mid,
            fetchedAt: now,
          });
        }
      }
    }

    return result;
  }

  async getOrderbook(internalSymbol: string, depth?: number): Promise<OrderbookSnapshot> {
    const protocolSymbol = this.getRegistry().internalToProtocol(internalSymbol);
    const params: Record<string, string> = { symbol: protocolSymbol };
    if (depth !== undefined) params.depth = String(depth);

    const response = await this.get('/book', params);

    const bidsRaw = response.l?.[0] || response.bids || [];
    const asksRaw = response.l?.[1] || response.asks || [];

    return {
      bids: bidsRaw.map((l: any) => ({
        price: parseFloat(l.p || l.price),
        size: parseFloat(l.a || l.size),
      })),
      asks: asksRaw.map((l: any) => ({
        price: parseFloat(l.p || l.price),
        size: parseFloat(l.a || l.size),
      })),
      timestamp: response.t || response.timestamp || Date.now(),
    };
  }

  async getFundingRate(internalSymbol: string): Promise<FundingRateInfo> {
    this.ensureInitialized();
    const market = this.marketDetailsMap.get(internalSymbol.toUpperCase());
    if (market && market.fundingRate !== undefined) {
      return {
        internalSymbol,
        rate: market.fundingRate,
        nextFundingTime: undefined,
        timestamp: Date.now(),
      };
    }

    try {
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
    } catch {
      return {
        internalSymbol,
        rate: 0,
        nextFundingTime: undefined,
        timestamp: Date.now(),
      };
    }
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
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`PacificaAdapter: invalid order size ${size}`);
    }
    const market = this.marketDetailsMap.get(internalSymbol.toUpperCase());
    if (!market) {
      throw new Error(`PacificaAdapter: unknown market "${internalSymbol}"`);
    }
    const lotSize = market.lotSize;
    const decimals = countDecimals(lotSize);
    const raw = Math.floor(size / lotSize) * lotSize;
    return parseFloat(raw.toFixed(decimals));
  }

  quantizeOrderSizeCeil(internalSymbol: string, size: number): number {
    this.ensureInitialized();
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`PacificaAdapter: invalid order size ${size}`);
    }
    const market = this.marketDetailsMap.get(internalSymbol.toUpperCase());
    if (!market) {
      throw new Error(`PacificaAdapter: unknown market "${internalSymbol}"`);
    }
    const lotSize = market.lotSize;
    const decimals = countDecimals(lotSize);
    const raw = Math.ceil(size / lotSize) * lotSize;
    return parseFloat(raw.toFixed(decimals));
  }

  quantizePrice(internalSymbol: string, price: number): number {
    this.ensureInitialized();
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`PacificaAdapter: invalid price ${price}`);
    }
    const market = this.marketDetailsMap.get(internalSymbol.toUpperCase());
    if (!market) {
      throw new Error(`PacificaAdapter: unknown market "${internalSymbol}"`);
    }
    const tickSize = market.tickSize;
    const decimals = countDecimals(tickSize);
    const raw = Math.round(price / tickSize) * tickSize;
    return parseFloat(raw.toFixed(decimals));
  }

  async getAccountInfo(agentPublicKey: string, subaccountId?: string): Promise<AccountInfo> {
    const params: Record<string, string> = { account: agentPublicKey };
    if (subaccountId) params.subaccount_id = subaccountId;

    let response: PacificaAccountResponse;
    try {
      response = await this.get('/account', params);
    } catch (err: any) {
      if (err.message && err.message.includes('404')) {
        return {
          equity: 0,
          balance: 0,
          unrealizedPnl: 0,
          availableMargin: 0,
          maintenanceMargin: 0,
          feeTier: undefined,
          subaccountId: subaccountId || '0',
          exists: false,
        };
      }
      throw err;
    }

    const equity = parseFloat(response.account_equity);
    const balance = parseFloat(response.balance);
    const availableMargin = parseFloat(response.available_to_spend);
    const maintenanceMargin = parseFloat(response.total_margin_used);
    const unrealizedPnl = equity - balance;

    return {
      equity,
      balance,
      unrealizedPnl,
      availableMargin,
      maintenanceMargin,
      feeTier: String(response.fee_level),
      subaccountId: response.subaccount_id,
    };
  }

  async getPositions(agentPublicKey: string, subaccountId?: string): Promise<ProtocolPosition[]> {
    const params: Record<string, string> = { account: agentPublicKey };
    if (subaccountId) params.subaccount_id = subaccountId;

    let response: PacificaPositionResponse[];
    try {
      response = await this.get('/positions', params);
    } catch (err: any) {
      if (err.message && err.message.includes('404')) {
        return [];
      }
      throw err;
    }
    if (!Array.isArray(response)) return [];
    let prices: Record<string, number> = {};
    try {
      prices = await this.getAllPrices();
    } catch { /* prices unavailable, will use entry price fallback */ }
    return response.map((p) => this.mapPosition(p, prices));
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

    if (params.leverage && params.leverage > 0 && !params.reduceOnly) {
      await this.setLeverage({
        agentPublicKey: params.agentPublicKey,
        agentSecretKey: params.agentSecretKey,
        mainWalletAddress: params.mainWalletAddress,
        internalSymbol: params.internalSymbol,
        leverage: params.leverage,
        subaccountId: params.subaccountId,
      });
      console.log(`[PacificaAdapter] Set leverage to ${params.leverage}x for ${params.internalSymbol} before order`);
    }

    const slippagePct = params.maxSlippagePct ?? 0.5;
    const isReduceOnly = params.reduceOnly ?? false;
    const orderSize = isReduceOnly
      ? this.quantizeOrderSizeCeil(params.internalSymbol, params.sizeBase)
      : this.quantizeOrderSize(params.internalSymbol, params.sizeBase);
    if (orderSize <= 0) {
      throw new Error(`Order size ${params.sizeBase} rounds to zero for ${params.internalSymbol} (lot size too large)`);
    }

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      amount: String(orderSize),
      side: mapToProtocolSide(params.side),
      reduce_only: isReduceOnly,
      slippage_percent: String(slippagePct),
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
      params.agentPublicKey,
      null,
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
    const isReduceOnly = params.reduceOnly ?? false;
    const quantizedSize = isReduceOnly
      ? this.quantizeOrderSizeCeil(params.internalSymbol, params.sizeBase)
      : this.quantizeOrderSize(params.internalSymbol, params.sizeBase);
    if (quantizedSize <= 0) {
      throw new Error(`Order size ${params.sizeBase} rounds to zero for ${params.internalSymbol} (lot size too large)`);
    }
    const quantizedPrice = this.quantizePrice(params.internalSymbol, params.price);

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      price: String(quantizedPrice),
      amount: String(quantizedSize),
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
      params.agentPublicKey,
      null,
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
      params.agentPublicKey,
      null,
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
      params.agentPublicKey,
      null,
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
      leverage: Math.floor(params.leverage),
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.UPDATE_LEVERAGE,
      operationData,
      params.agentPublicKey,
      null,
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
      params.agentPublicKey,
      null,
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
      params.agentPublicKey,
      null,
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

    let positionSide: string = 'bid';
    try {
      const positions = await this.getPositions(params.agentPublicKey);
      const pos = positions.find(p => p.internalSymbol === params.internalSymbol);
      if (pos) {
        positionSide = pos.baseSize >= 0 ? 'bid' : 'ask';
      }
    } catch (err) {
      console.warn(`[SetTpSl] Could not fetch position side, defaulting to 'bid':`, err);
    }

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      side: positionSide,
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
      params.agentPublicKey,
      null,
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
      params.agentPublicKey,
      null,
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

  async executeDeposit(params: AgentDepositParams): Promise<DepositResult> {
    try {
      if (!Number.isFinite(params.amount) || params.amount <= 0) {
        return { success: false, error: 'Invalid deposit amount: must be a positive number' };
      }
      if (params.amount < 10) {
        return { success: false, error: 'Pacifica minimum deposit is $10' };
      }

      const agentKeypair = Keypair.fromSecretKey(params.agentSecretKey);
      const agentPubkey = agentKeypair.publicKey;

      if (params.agentPublicKey && agentPubkey.toBase58() !== params.agentPublicKey) {
        return {
          success: false,
          error: 'Deposit aborted: secret key does not match expected agent public key. ' +
            'Derived: ' + agentPubkey.toBase58() + ', expected: ' + params.agentPublicKey,
        };
      }

      const connection = new Connection(getPrimaryRpcUrl(), 'confirmed');

      const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

      const vaultInfo = await connection.getAccountInfo(PACIFICA_USDC_VAULT);
      if (!vaultInfo || vaultInfo.owner.toBase58() !== TOKEN_PROGRAM) {
        return {
          success: false,
          error: 'Deposit aborted: vault account owner mismatch. ' +
            'Expected Token Program, got: ' + (vaultInfo ? vaultInfo.owner.toBase58() : 'null'),
        };
      }

      if (vaultInfo.data.length >= 40) {
        const mintFromVault = new PublicKey(vaultInfo.data.slice(0, 32));
        if (mintFromVault.toBase58() !== USDC_MINT.toBase58()) {
          return {
            success: false,
            error: 'Deposit aborted: vault mint mismatch. ' +
              'Expected USDC ' + USDC_MINT.toBase58() + ', got: ' + mintFromVault.toBase58(),
          };
        }
      }

      const centralStateInfo = await connection.getAccountInfo(PACIFICA_CENTRAL_STATE);
      if (!centralStateInfo || centralStateInfo.owner.toBase58() !== PACIFICA_PROGRAM_ID.toBase58()) {
        return {
          success: false,
          error: 'Deposit aborted: central state owner mismatch. ' +
            'Expected Pacifica Program, got: ' + (centralStateInfo ? centralStateInfo.owner.toBase58() : 'null'),
        };
      }

      const agentUsdcAta = getAssociatedTokenAddress(USDC_MINT, agentPubkey);
      const ataInfo = await connection.getAccountInfo(agentUsdcAta);
      if (!ataInfo) {
        return {
          success: false,
          error: 'Agent wallet has no USDC token account. Fund the wallet with USDC first.',
        };
      }

      if (ataInfo.owner.toBase58() !== TOKEN_PROGRAM) {
        return {
          success: false,
          error: 'Deposit aborted: agent USDC ATA owner mismatch.',
        };
      }

      if (ataInfo.data.length >= 72) {
        const ataMint = new PublicKey(ataInfo.data.slice(0, 32));
        const ataOwner = new PublicKey(ataInfo.data.slice(32, 64));
        if (ataMint.toBase58() !== USDC_MINT.toBase58()) {
          return {
            success: false,
            error: 'Deposit aborted: agent ATA mint mismatch.',
          };
        }
        if (ataOwner.toBase58() !== agentPubkey.toBase58()) {
          return {
            success: false,
            error: 'Deposit aborted: agent ATA owner does not match agent wallet.',
          };
        }

        const amountBytes = ataInfo.data.slice(64, 72);
        const ataBalance = Number(amountBytes.readBigUInt64LE(0));
        const requiredLamports = Number(usdcToLamports(params.amount));
        if (ataBalance < requiredLamports) {
          return {
            success: false,
            error: 'Insufficient USDC balance. Have: ' +
              (ataBalance / 1_000_000).toFixed(6) + ', need: ' + params.amount.toFixed(6),
          };
        }
      }

      const amountLamports = usdcToLamports(params.amount);
      const depositIx = buildDepositInstruction(agentPubkey, agentUsdcAta, amountLamports);

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction();
      tx.recentBlockhash = blockhash;
      tx.feePayer = agentPubkey;
      tx.add(depositIx);

      const txSignature = await sendAndConfirmTransaction(connection, tx, [agentKeypair], {
        commitment: 'confirmed',
        maxRetries: 3,
      });

      return {
        success: true,
        txSignature,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        error: 'Deposit failed: ' + message,
      };
    }
  }

  async executeWithdraw(params: AgentWithdrawParams): Promise<WithdrawResult> {
    const signer = new PacificaSigner(params.agentSecretKey);

    const operationData: Record<string, unknown> = {
      amount: String(params.amount),
    };

    const body = signer.buildRequestBody(
      OPERATION_TYPES.WITHDRAW,
      operationData,
      params.agentPublicKey,
      null,
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
    const timestamp = Date.now();
    const expiryWindow = 5000;

    const fromAccount = params.fromSubaccountId || signer.getPublicKey();

    const payload: Record<string, unknown> = {
      to_account: params.toSubaccountId,
      amount: String(params.amount),
    };

    const message = buildSigningMessage(
      OPERATION_TYPES.SUBACCOUNT_TRANSFER,
      payload,
      timestamp,
      expiryWindow,
    );
    const signature = signer.signMessage(message);

    const response = await this.post('/account/subaccount/transfer', {
      account: fromAccount,
      ...payload,
      signature,
      timestamp,
      expiry_window: expiryWindow,
    });

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
      'PacificaAdapter.createSubaccount: Pacifica requires dual-signature subaccount creation. ' +
      'Use createSubaccountWithKey(mainSecretKey, subSecretKey) instead.',
    );
  }

  async createSubaccountWithKey(
    mainSecretKey: Uint8Array,
    subSecretKey: Uint8Array,
  ): Promise<SubaccountInfo> {
    const mainSigner = new PacificaSigner(mainSecretKey);
    const subSigner = new PacificaSigner(subSecretKey);
    const timestamp = Date.now();
    const expiryWindow = 5000;

    const subMessage = buildSigningMessage(
      OPERATION_TYPES.SUBACCOUNT_INITIATE,
      { account: mainSigner.getPublicKey() },
      timestamp,
      expiryWindow,
    );
    const subSignature = subSigner.signMessage(subMessage);

    const mainMessage = buildSigningMessage(
      OPERATION_TYPES.SUBACCOUNT_CONFIRM,
      { signature: subSignature },
      timestamp,
      expiryWindow,
    );
    const mainSignature = mainSigner.signMessage(mainMessage);

    const response = await this.post('/account/subaccount/create', {
      main_account: mainSigner.getPublicKey(),
      subaccount: subSigner.getPublicKey(),
      main_signature: mainSignature,
      sub_signature: subSignature,
      timestamp,
      expiry_window: expiryWindow,
    });

    console.log(`[PacificaAdapter] Subaccount created: ${subSigner.getPublicKey()} under ${mainSigner.getPublicKey()}`);

    return {
      subaccountId: subSigner.getPublicKey(),
      label: undefined,
      equity: 0,
      status: 'confirmed',
    };
  }

  async listSubaccountsWithKey(agentSecretKey: Uint8Array): Promise<SubaccountInfo[]> {
    const signer = new PacificaSigner(agentSecretKey);
    const timestamp = Date.now();
    const expiryWindow = 5000;

    const message = buildSigningMessage(
      OPERATION_TYPES.LIST_SUBACCOUNTS,
      {},
      timestamp,
      expiryWindow,
    );
    const signature = signer.signMessage(message);

    const response = await this.post('/account/subaccount/list', {
      account: signer.getPublicKey(),
      signature,
      timestamp,
      expiry_window: expiryWindow,
    });

    const subaccounts = response?.data?.subaccounts || response?.subaccounts || [];
    return subaccounts.map((s: any) => ({
      subaccountId: s.address,
      label: undefined,
      equity: s.balance ? parseFloat(s.balance) : 0,
      status: 'confirmed' as const,
    }));
  }

  async listSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]> {
    console.warn('[PacificaAdapter] listSubaccounts without key — use listSubaccountsWithKey for authenticated listing');
    return [];
  }

  async discoverSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]> {
    return this.listSubaccounts(agentPublicKey);
  }

  prepareBindMessage(
    mainWalletAddress: string,
    agentPublicKey: string,
  ): { message: string; timestamp: number; expiryWindow: number } {
    const timestamp = Date.now();
    const expiryWindow = 30000;
    const operationData = { agent_wallet: agentPublicKey };
    const message = buildSigningMessage(
      OPERATION_TYPES.BIND_AGENT_WALLET,
      operationData,
      timestamp,
      expiryWindow,
    );
    console.log(`[AgentBind] Prepared bind message for agent=${agentPublicKey.slice(0, 8)}... account=${mainWalletAddress.slice(0, 8)}...`);
    return { message, timestamp, expiryWindow };
  }

  async confirmBind(
    mainWalletAddress: string,
    agentPublicKey: string,
    signatureBase58: string,
    timestamp: number,
    expiryWindow: number,
  ): Promise<void> {
    const body = {
      account: mainWalletAddress,
      signature: signatureBase58,
      timestamp,
      expiry_window: expiryWindow,
      agent_wallet: agentPublicKey,
    };
    console.log(`[AgentBind] Confirming bind agent=${agentPublicKey.slice(0, 8)}... to account=${mainWalletAddress.slice(0, 8)}...`);
    await this.post('/agent/bind', body);
    console.log(`[AgentBind] Successfully bound agent=${agentPublicKey.slice(0, 8)}...`);
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
      : response.data || response.markets || response.universe || [];

    if (rawMarkets.length === 0) {
      throw new Error('PacificaAdapter: /info returned no markets');
    }

    if (rawMarkets.length > MAX_MARKET_CACHE_SIZE) {
      console.warn(
        `PacificaAdapter: /info returned ${rawMarkets.length} markets, ` +
        `capping at ${MAX_MARKET_CACHE_SIZE}`,
      );
    }

    const allProtocolSymbols = rawMarkets.slice(0, MAX_MARKET_CACHE_SIZE).map(m => m.symbol);
    const allMappings = buildPacificaMappings(allProtocolSymbols);
    const protocolToInternal = new Map<string, string>();
    for (const mapping of allMappings) {
      protocolToInternal.set(mapping.protocol.toUpperCase(), mapping.internal);
    }

    return rawMarkets.slice(0, MAX_MARKET_CACHE_SIZE).map((m) => {
      const protocolSymbol = m.symbol;
      const internalSymbol = protocolToInternal.get(protocolSymbol.toUpperCase()) || `${protocolSymbol.toUpperCase()}-PERP`;

      const maxLev = typeof m.max_leverage === 'number' ? m.max_leverage : parseFloat(String(m.max_leverage)) || 1;
      const minOrderUsd = parseFloat(String(m.min_order_size)) || 10;
      const tickSz = parseFloat(String(m.tick_size)) || 0.01;
      const lotSz = parseFloat(String(m.lot_size)) || 0.01;
      const fundRate = m.funding_rate !== undefined ? parseFloat(String(m.funding_rate)) : undefined;

      return {
        internalSymbol,
        protocolSymbol,
        maxLeverage: maxLev,
        minOrderSizeUsd: minOrderUsd,
        minOrderSizeBase: lotSz,
        tickSize: tickSz,
        lotSize: lotSz,
        isActive: true,
        category: m.instrument_type ? [m.instrument_type] : [],
        fullName: DISPLAY_NAMES[m.base_asset || protocolSymbol] || m.base_asset || protocolSymbol,
        maintenanceMarginWeight: maxLev > 0 ? 1 / maxLev : 0.03,
        fundingRate: isNaN(fundRate as number) ? undefined : fundRate,
        riskTier: PacificaAdapter.assessRiskTier(maxLev),
        estimatedSlippagePct: PacificaAdapter.assessSlippage(maxLev),
      };
    });
  }

  private mapPosition(p: PacificaPositionResponse, oraclePrices: Record<string, number> = {}): ProtocolPosition {
    const rawAmount = parseFloat(p.amount || p.size || '0');
    const size = p.side === 'ask' ? -rawAmount : rawAmount;
    const entryPrice = parseFloat(p.entry_price);
    const internalSymbol = this.safeProtocolToInternal(p.symbol);

    let markPrice = p.mark_price ? parseFloat(p.mark_price) : 0;
    if (!markPrice || markPrice === 0) {
      markPrice = oraclePrices[internalSymbol] || entryPrice;
    }

    let unrealizedPnl = p.unrealized_pnl ? parseFloat(p.unrealized_pnl) : 0;
    if (unrealizedPnl === 0 && Math.abs(size) > 0.0001 && markPrice > 0 && entryPrice > 0 && markPrice !== entryPrice) {
      unrealizedPnl = size > 0
        ? (markPrice - entryPrice) * Math.abs(size)
        : (entryPrice - markPrice) * Math.abs(size);
    }

    return {
      internalSymbol,
      baseSize: size,
      entryPrice,
      markPrice,
      unrealizedPnl,
      leverage: p.leverage ? parseFloat(p.leverage) : null,
      liquidationPrice: p.liquidation_price ? parseFloat(p.liquidation_price) : null,
      marginMode: p.margin_mode || (p.isolated ? 'isolated' : 'cross'),
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

  private unwrapEnvelope(json: any): any {
    if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
      if (json.success === false) {
        throw new Error(`Pacifica API error: ${json.error || 'unknown'} (code: ${json.code || 'none'})`);
      }
      return json.data;
    }
    return json;
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

    const json = await response.json();
    return this.unwrapEnvelope(json);
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

    const json = await response.json();
    return this.unwrapEnvelope(json);
  }

  private static assessRiskTier(maxLeverage: number): 'recommended' | 'caution' | 'high_risk' {
    if (maxLeverage >= 20) return 'recommended';
    if (maxLeverage >= 10) return 'caution';
    return 'high_risk';
  }

  private static assessSlippage(maxLeverage: number): number {
    if (maxLeverage >= 50) return 0.02;
    if (maxLeverage >= 20) return 0.05;
    if (maxLeverage >= 10) return 0.10;
    if (maxLeverage >= 5) return 0.25;
    return 0.50;
  }
}

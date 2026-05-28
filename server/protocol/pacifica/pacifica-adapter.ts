import type { ProtocolAdapter, CreateSubaccountInput } from '../adapter.js';
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
import { PACIFICA_USDC_MINT, PACIFICA_MIN_TRANSFER_USDC } from './pacifica-constants.js';

export { PACIFICA_MIN_TRANSFER_USDC } from './pacifica-constants.js';
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
import { pacificaQuota, QuotaExhaustedError, type RequestPriority } from './pacifica-quota.js';
import { pacificaCache } from './pacifica-cache.js';

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
  // Task 143: referral identifier (Pacifica wallet address) used by
  // claim_referral_code. Independent of builder code — referral claim is
  // best-effort and never gates order flow.
  referralAddress?: string;
  // Task 143: ceiling the user signs at builder-code approval time. Locked
  // at 2x Pacifica's actual fee_rate (0.001) so we can raise our take to
  // 0.002 in future without re-signing every existing user.
  builderMaxFeeRate?: string;
}

const DEFAULT_CONFIG: PacificaAdapterConfig = {
  baseUrl: 'https://api.pacifica.fi/api/v1',
  wsUrl: 'wss://ws.pacifica.fi/ws',
  builderMaxFeeRate: '0.002',
};

export class PacificaAdapter implements ProtocolAdapter {
  readonly protocolName = 'pacifica';
  readonly protocolVersion = '1.0.0';
  readonly collateralMint = PACIFICA_USDC_MINT;
  readonly collateralSymbol = 'USDC';
  readonly minTransferAmount = PACIFICA_MIN_TRANSFER_USDC;

  private config: PacificaAdapterConfig;
  private registry: SymbolRegistry | null = null;
  private marketCache: CacheEntry<ProtocolMarket[]> | null = null;
  private priceCache: Map<string, CacheEntry<number>> = new Map();
  private marketDetailsMap: Map<string, ProtocolMarket> = new Map();
  private initialized = false;
  private telemetryInterval: NodeJS.Timeout | null = null;
  // Task 143: per-wallet async mutex for enrollment. Concurrent first-trades
  // from the same user await a single in-flight approval+claim rather than
  // each firing their own (which would yield duplicate POSTs and racy flag
  // writes). Keyed on agent public key (the user's Pacifica main wallet).
  private enrollmentInFlight: Map<string, Promise<{ builderApproved: boolean; referralClaimed: boolean }>> = new Map();

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

    // Start credit-budget telemetry: emits one log line per minute summarizing
    // upstream credit consumption, cache hit rate, and any rejected requests.
    if (!this.telemetryInterval) {
      this.telemetryInterval = setInterval(() => this.logTelemetry(), 60_000);
      // Don't keep the event loop alive just for telemetry
      if (typeof this.telemetryInterval.unref === 'function') {
        this.telemetryInterval.unref();
      }
    }
  }

  async shutdown(): Promise<void> {
    this.priceCache.clear();
    this.marketCache = null;
    this.marketDetailsMap.clear();
    this.initialized = false;
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
    pacificaCache.invalidateAll();
  }

  private logTelemetry(): void {
    const q = pacificaQuota.snapshot();
    const c = pacificaCache.snapshot();
    const top = q.topEndpoints
      .map((e) => `${e.path}=${e.credits}c/${e.calls}x`)
      .join(' ');
    console.log(
      `[pacifica-telemetry] credits=${q.creditsUsed}/${q.totalBudget} (60s) | ` +
        `served=${q.requestsServed} rejected=${q.requestsRejected} | ` +
        `cache: ${c.entries} entries, ${c.hitRatePct}% hit, ${c.dedupedJoins} deduped | ` +
        `top: ${top || '(none)'}`,
    );
    pacificaQuota.resetCounters();
    pacificaCache.resetCounters();
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
      requiresExternalSubaccountKey: true,
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
          // Bulk price refresh is non-critical: trading reads fresh quotes
          // separately. Mark as background so it never starves /account or
          // /positions calls that the user dashboard depends on.
          const book = await this.get('/book', { symbol: protocol, depth: '1' }, { priority: 'background' });
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
      exists: true,
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

  async getWalletCollateralBalance(walletAddress: string): Promise<number> {
    try {
      const connection = new Connection(getPrimaryRpcUrl(), 'confirmed');
      const ownerPubkey = new PublicKey(walletAddress);
      const collateralMintPubkey = new PublicKey(this.collateralMint);
      const ata = getAssociatedTokenAddress(collateralMintPubkey, ownerPubkey);
      const accountInfo = await connection.getTokenAccountBalance(ata);
      return accountInfo.value.uiAmount || 0;
    } catch {
      return 0;
    }
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

  async getTradeHistory(agentPublicKey: string, params?: HistoryParams & { subaccountId?: string }): Promise<TradeRecord[]> {
    const queryParams: Record<string, string> = { account: agentPublicKey };
    if (params?.startTime) queryParams.start_time = String(params.startTime);
    if (params?.endTime) queryParams.end_time = String(params.endTime);
    if (params?.limit) queryParams.limit = String(params.limit);
    if (params?.offset) queryParams.offset = String(params.offset);
    if (params?.subaccountId) queryParams.subaccount_id = params.subaccountId;

    // Pacifica returns 404 when no trades exist in the queried window (rather
    // than an empty array). Treat that as "no trades" — consistent with how
    // getAccountInfo and getPositions handle 404 above.
    let response: PacificaTradeResponse[];
    try {
      response = await this.get('/account/trades', queryParams);
    } catch (err: any) {
      if (err?.message && err.message.includes('404')) {
        return [];
      }
      throw err;
    }

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
    const enrollment = await this.ensurePacificaEnrollment(params.agentPublicKey, params.agentSecretKey);
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

    // Task 143: fail-CLOSED on builder approval. Only inject our config'd
    // builder_code if the user is confirmed-approved; otherwise the order
    // would 403. Caller-supplied params.builderCode is passed through
    // verbatim (caller is responsible for its own approval).
    if (params.builderCode) {
      operationData.builder_code = params.builderCode;
    } else if (enrollment.builderApproved && this.config.builderCode) {
      operationData.builder_code = this.config.builderCode;
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
    const enrollment = await this.ensurePacificaEnrollment(params.agentPublicKey, params.agentSecretKey);
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

    // Task 143: fail-CLOSED on builder approval (see placeMarketOrder).
    if (params.builderCode) {
      operationData.builder_code = params.builderCode;
    } else if (enrollment.builderApproved && this.config.builderCode) {
      operationData.builder_code = this.config.builderCode;
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

    const operationData: Record<string, unknown> = {
      all_symbols: !params.symbol,
    };

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
    const enrollment = await this.ensurePacificaEnrollment(params.agentPublicKey, params.agentSecretKey);
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

    // Task 143: fail-CLOSED on builder approval (see placeMarketOrder).
    if (params.builderCode) {
      operationData.builder_code = params.builderCode;
    } else if (enrollment.builderApproved && this.config.builderCode) {
      operationData.builder_code = this.config.builderCode;
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
    const enrollment = await this.ensurePacificaEnrollment(params.agentPublicKey, params.agentSecretKey);
    const signer = new PacificaSigner(params.agentSecretKey);
    const protocolSymbol = this.getRegistry().internalToProtocol(params.internalSymbol);

    console.log(`[PacificaAdapter.setTpSl] account=${params.agentPublicKey.slice(0,8)}... symbol=${protocolSymbol} subaccountId=${params.subaccountId ?? 'none'} TP=${params.takeProfitPrice ?? 'none'} SL=${params.stopLossPrice ?? 'none'}`);

    let positionSide: string = 'bid';
    let havePosition = false;
    try {
      const positions = await this.getPositions(params.agentPublicKey, params.subaccountId);
      const pos = positions.find(p => p.internalSymbol === params.internalSymbol);
      if (pos && Math.abs(pos.baseSize) > 0.0001) {
        positionSide = pos.baseSize >= 0 ? 'bid' : 'ask';
        havePosition = true;
      }
    } catch (err) {
      console.warn(`[SetTpSl] Could not fetch position side, defaulting to 'bid':`, err);
    }

    const isLong = positionSide === 'bid';
    const TP_SLIPPAGE = 0.001;
    const closingSide = isLong ? 'ask' : 'bid';

    const tpRequested = params.takeProfitPrice !== undefined && params.takeProfitPrice > 0;
    const slRequested = params.stopLossPrice !== undefined && params.stopLossPrice > 0;

    // Pre-flight: validate trigger prices against current mark when a real position
    // exists and at least one leg was requested. Skips the cancel-only call path
    // (TP=0, SL=0) which is used by /cancel-tpsl to clear existing triggers.
    //
    // Note: the only callers of setTpSl in the codebase are the user-facing
    // /set-tpsl and /cancel-tpsl routes. There is no separate strategy-loop
    // call site that would need its own retry guard — a structured
    // { success: false } here is observed by the route, surfaced to the user,
    // and the bot's next strategy tick decides what to do.
    let droppedLegMessage: string | null = null;
    const droppedLegs: Array<{ leg: 'tp' | 'sl'; reason: string }> = [];
    let tpInvalid = false;
    let slInvalid = false;
    if (havePosition && (tpRequested || slRequested)) {
      let mark: number | null = null;
      try {
        mark = await this.getPrice(params.internalSymbol);
      } catch (err) {
        console.warn(`[SetTpSl] Could not fetch mark price for validation:`, err);
      }

      if (mark && mark > 0) {
        const sideLabel = isLong ? 'long' : 'short';
        const errs: string[] = [];

        if (tpRequested) {
          const tp = params.takeProfitPrice as number;
          const tpOk = isLong ? tp > mark : tp < mark;
          if (!tpOk) {
            tpInvalid = true;
            const direction = isLong ? 'above' : 'below';
            const reason = `Take profit ${tp} is already past the current price ${mark} for a ${sideLabel} position — choose a price ${direction} ${mark}`;
            errs.push(reason);
            droppedLegs.push({ leg: 'tp', reason });
          }
        }
        if (slRequested) {
          const sl = params.stopLossPrice as number;
          const slOk = isLong ? sl < mark : sl > mark;
          if (!slOk) {
            slInvalid = true;
            const direction = isLong ? 'below' : 'above';
            const reason = `Stop loss ${sl} is already past the current price ${mark} for a ${sideLabel} position — choose a price ${direction} ${mark}`;
            errs.push(reason);
            droppedLegs.push({ leg: 'sl', reason });
          }
        }

        const bothRequested = tpRequested && slRequested;
        const bothInvalid = bothRequested && tpInvalid && slInvalid;
        const onlyOneRequestedAndInvalid =
          (!bothRequested) && ((tpRequested && tpInvalid) || (slRequested && slInvalid));

        if (bothInvalid || onlyOneRequestedAndInvalid) {
          const message = errs.join('; ');
          console.warn(`[SetTpSl] Pre-flight rejection (no request sent): ${message}`);
          return {
            success: false,
            status: 'rejected',
            error: message,
            appliedTakeProfitPrice: null,
            appliedStopLossPrice: null,
            droppedLegs,
          };
        }

        if (tpInvalid || slInvalid) {
          droppedLegMessage = errs.join('; ');
          console.warn(`[SetTpSl] Dropping invalid leg, proceeding with the other: ${droppedLegMessage}`);
        }
      } else {
        console.warn(`[SetTpSl] Mark price unavailable; skipping pre-flight validation for ${params.internalSymbol}`);
      }
    }

    const appliedTp = tpRequested && !tpInvalid ? (params.takeProfitPrice as number) : null;
    const appliedSl = slRequested && !slInvalid ? (params.stopLossPrice as number) : null;

    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      side: closingSide,
    };

    // Task 143: inject builder_code at the TOP LEVEL of the TP/SL data object
    // (NOT inside take_profit / stop_loss sub-objects — per Pacifica docs).
    // Same fail-CLOSED gate as the order paths.
    if (enrollment.builderApproved && this.config.builderCode) {
      operationData.builder_code = this.config.builderCode;
    }

    if (tpRequested && !tpInvalid) {
      const tpStopQ = this.quantizePrice(params.internalSymbol, params.takeProfitPrice as number);
      const tpLimitRaw = isLong
        ? (params.takeProfitPrice as number) * (1 - TP_SLIPPAGE)
        : (params.takeProfitPrice as number) * (1 + TP_SLIPPAGE);
      const tpLimitQ = this.quantizePrice(params.internalSymbol, tpLimitRaw);
      operationData.take_profit = {
        stop_price: String(tpStopQ),
        limit_price: String(tpLimitQ),
      };
    }
    if (slRequested && !slInvalid) {
      const slStopQ = this.quantizePrice(params.internalSymbol, params.stopLossPrice as number);
      operationData.stop_loss = {
        stop_price: String(slStopQ),
      };
    }

    console.log(`[PacificaAdapter.setTpSl] positionSide=${positionSide} closingSide=${closingSide} isLong=${isLong} operationData:`, JSON.stringify(operationData));

    const body = signer.buildRequestBody(
      OPERATION_TYPES.SET_POSITION_TPSL,
      operationData,
      params.agentPublicKey,
      null,
    );

    if (params.subaccountId) {
      (body as Record<string, unknown>).subaccount_id = params.subaccountId;
    }

    const response = await this.post('/positions/tpsl', body);

    console.log(`[PacificaAdapter.setTpSl] response:`, JSON.stringify(response));

    if (response && typeof response === 'object' && 'order_id' in response) {
      const mapped = this.mapOrderResponse(response as PacificaOrderResponse);
      mapped.appliedTakeProfitPrice = appliedTp;
      mapped.appliedStopLossPrice = appliedSl;
      if (droppedLegs.length) mapped.droppedLegs = droppedLegs;
      if (droppedLegMessage) mapped.error = droppedLegMessage;
      return mapped;
    }

    return {
      success: true,
      orderId: response?.order_id ?? response?.id ?? `tpsl-${Date.now()}`,
      status: 'open' as const,
      rawResponse: response,
      appliedTakeProfitPrice: appliedTp,
      appliedStopLossPrice: appliedSl,
      ...(droppedLegs.length ? { droppedLegs } : {}),
      ...(droppedLegMessage ? { error: droppedLegMessage } : {}),
    };
  }

  async getOpenStopOrders(agentPublicKey: string, subaccountId?: string, symbol?: string): Promise<Array<{ order_id: string; symbol: string; side: string; stop_price: string; limit_price?: string; order_type?: string }>> {
    const params: Record<string, string> = { account: agentPublicKey };
    if (subaccountId) params.subaccount_id = subaccountId;
    if (symbol) params.symbol = symbol;
    try {
      const response = await this.get('/orders/stop', params);
      if (!Array.isArray(response)) return [];
      return response;
    } catch (err: any) {
      if (err.message && (err.message.includes('404') || err.message.includes('Not Found'))) {
        return [];
      }
      throw err;
    }
  }

  async cancelTpSlOrders(params: {
    agentPublicKey: string;
    agentSecretKey: Uint8Array;
    mainWalletAddress: string;
    internalSymbol: string;
    subaccountId?: string;
  }): Promise<CancelResult> {
    const protocolSymbol = this.getRegistry().internalToProtocol(params.internalSymbol);

    let stopOrders: Array<{ order_id: string }> = [];
    try {
      stopOrders = await this.getOpenStopOrders(params.agentPublicKey, params.subaccountId, protocolSymbol);
      console.log(`[PacificaAdapter.cancelTpSlOrders] Found ${stopOrders.length} stop orders for ${protocolSymbol}`);
    } catch (err: any) {
      console.log(`[PacificaAdapter.cancelTpSlOrders] Stop order listing failed (${err.message}), using cancelAllOrders fallback`);
    }

    if (stopOrders.length > 0) {
      let canceledCount = 0;
      const errors: string[] = [];
      for (const order of stopOrders) {
        try {
          const result = await this.cancelStopOrder({
            agentPublicKey: params.agentPublicKey,
            agentSecretKey: params.agentSecretKey,
            mainWalletAddress: params.mainWalletAddress,
            orderId: order.order_id,
            subaccountId: params.subaccountId,
          });
          if (result.success) canceledCount++;
          else if (result.error) errors.push(result.error);
        } catch (err: any) {
          errors.push(err.message || String(err));
        }
      }
      return {
        success: canceledCount > 0 || errors.length === 0,
        canceledCount,
        error: errors.length > 0 ? errors.join('; ') : undefined,
      };
    }

    console.log(`[PacificaAdapter.cancelTpSlOrders] Canceling all orders for ${protocolSymbol} via cancel_all`);
    try {
      const result = await this.cancelAllOrders({
        agentPublicKey: params.agentPublicKey,
        agentSecretKey: params.agentSecretKey,
        mainWalletAddress: params.mainWalletAddress,
        symbol: params.internalSymbol,
        subaccountId: params.subaccountId,
      });
      console.log(`[PacificaAdapter.cancelTpSlOrders] cancel_all result: canceled=${result.canceledCount}`);
      return result;
    } catch (err: any) {
      console.log(`[PacificaAdapter.cancelTpSlOrders] cancel_all also failed: ${err.message}`);
      return { success: true, canceledCount: 0 };
    }
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
      if (params.amount < PACIFICA_MIN_TRANSFER_USDC) {
        return { success: false, error: `Pacifica minimum deposit is $${PACIFICA_MIN_TRANSFER_USDC}` };
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

      // Retry loop with fresh blockhash on expiry. Solana blockhashes are valid
      // for ~150 slots (~60s); under RPC congestion the tx can age out before
      // it lands and fail with "block height exceeded". Each attempt fetches a
      // fresh blockhash and re-signs so we don't retry an already-expired tx.
      const MAX_DEPOSIT_ATTEMPTS = 3;
      let lastDepositErr: unknown = null;
      let txSignature: string | null = null;
      for (let attempt = 1; attempt <= MAX_DEPOSIT_ATTEMPTS; attempt++) {
        try {
          const { blockhash } = await connection.getLatestBlockhash('confirmed');
          const tx = new Transaction();
          tx.recentBlockhash = blockhash;
          tx.feePayer = agentPubkey;
          tx.add(depositIx);

          txSignature = await sendAndConfirmTransaction(connection, tx, [agentKeypair], {
            commitment: 'confirmed',
            maxRetries: 3,
          });
          break;
        } catch (sendErr: unknown) {
          lastDepositErr = sendErr;
          const msg = sendErr instanceof Error ? sendErr.message : String(sendErr);
          const isExpired =
            msg.includes('block height exceeded') ||
            msg.includes('TransactionExpiredBlockheightExceededError') ||
            msg.includes('Blockhash not found');
          if (!isExpired || attempt === MAX_DEPOSIT_ATTEMPTS) {
            throw sendErr;
          }
          console.warn(`[PacificaAdapter] deposit attempt ${attempt}/${MAX_DEPOSIT_ATTEMPTS} expired before landing — retrying with fresh blockhash: ${msg}`);
        }
      }

      if (!txSignature) {
        const msg = lastDepositErr instanceof Error ? lastDepositErr.message : String(lastDepositErr);
        throw new Error(msg || 'deposit failed without a signature');
      }

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
    if (!Number.isFinite(params.amount) || params.amount <= 0) {
      return { success: false, error: 'Invalid withdraw amount: must be a positive number' };
    }
    if (params.amount < PACIFICA_MIN_TRANSFER_USDC) {
      return { success: false, error: `Pacifica minimum withdraw is $${PACIFICA_MIN_TRANSFER_USDC}` };
    }

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

  async createSubaccount(input: CreateSubaccountInput): Promise<SubaccountInfo> {
    if (!input.subSecretKey) {
      throw new Error(
        'PacificaAdapter.createSubaccount: subSecretKey is required. ' +
        'Pacifica uses dual-signature subaccount creation — caller must pre-generate a subaccount keypair and pass its secret key.',
      );
    }
    const mainSigner = new PacificaSigner(input.mainSecretKey);
    const subSigner = new PacificaSigner(input.subSecretKey);
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

  /**
   * Atomic first-bot provisioning for Pacifica.
   *
   * Pacifica only registers a `main_account` record once it observes a USDC deposit
   * to its vault from that wallet. `subaccount/create` requires this record to exist.
   * For brand-new agent wallets we therefore must: deposit → wait for indexing →
   * create subaccount → transfer to subaccount, all in one server-side flow.
   *
   * For wallets that ALREADY have a registered Pacifica account, this method skips
   * the deposit step (gap calc returns 0 if main balance already covers fundingAmount)
   * and behaves identically to the existing two-step flow.
   *
   * Idempotency: if any step fails after the deposit lands, retrying recomputes the
   * gap from live state and won't double-deposit. Subaccount creation generates a
   * fresh keypair per call so a retry produces a NEW subaccount — caller must save
   * the bot row immediately on success and use the existing "Add Funds" path to
   * recover from a transfer-only failure.
   */
  async provisionFundedSubaccount(input: {
    mainSecretKey: Uint8Array;
    subSecretKey: Uint8Array;
    agentPublicKey: string;
    fundingAmount: number;
  }): Promise<{
    subaccountId: string;
    wasNewAccount: boolean;
    transferSucceeded: boolean;
    depositTxSignature?: string;
    warning?: string;
  }> {
    if (!Number.isFinite(input.fundingAmount) || input.fundingAmount < PACIFICA_MIN_TRANSFER_USDC) {
      throw new Error(
        `provisionFundedSubaccount: fundingAmount must be >= $${PACIFICA_MIN_TRANSFER_USDC} (Pacifica minimum). Got: ${input.fundingAmount}`,
      );
    }

    // 1. Read current state
    const initialInfo = await this.getAccountInfo(input.agentPublicKey);
    const wasNewAccount = !initialInfo.exists;
    const currentMainBalance = initialInfo.exists ? initialInfo.balance : 0;

    // 2. Compute deposit gap. If gap is positive but below minimum, bump to minimum.
    let depositTxSignature: string | undefined;
    const rawGap = input.fundingAmount - currentMainBalance;
    if (rawGap > 0) {
      const depositAmount = Math.max(rawGap, PACIFICA_MIN_TRANSFER_USDC);
      console.log(`[PacificaAdapter] provisionFundedSubaccount: depositing $${depositAmount} (gap=$${rawGap.toFixed(2)}, mainBalance=$${currentMainBalance.toFixed(2)}, fundingAmount=$${input.fundingAmount}, wasNewAccount=${wasNewAccount})`);

      const depositResult = await this.executeDeposit({
        agentPublicKey: input.agentPublicKey,
        agentSecretKey: input.mainSecretKey,
        amount: depositAmount,
      });
      if (!depositResult.success) {
        throw new Error(`provisionFundedSubaccount: deposit failed: ${depositResult.error}`);
      }
      depositTxSignature = depositResult.txSignature;

      // 3. Poll for Pacifica to index the deposit. Solana confirms quickly but
      // Pacifica's indexer can lag 30–60s under load, so we give it 90s before
      // surfacing a retry message. Funds are always safe — a timeout just means
      // the retry path will see them already credited.
      //
      // Pacifica's REST API is rate-limited (~300 req/hour). We use a stepped
      // backoff so the typical fast-path (indexed in 5–15s) only costs ~5
      // requests, and the worst-case 90s wait costs ~17 requests instead of 45.
      const pollStart = Date.now();
      const pollTimeoutMs = 90_000;
      let indexed = false;
      let lastBalance = currentMainBalance;
      while (Date.now() - pollStart < pollTimeoutMs) {
        const elapsedMs = Date.now() - pollStart;
        // 0–15s: poll every 2s (fast path — most deposits index here)
        // 15–45s: poll every 5s
        // 45–90s: poll every 8s
        const pollIntervalMs = elapsedMs < 15_000 ? 2_000 : elapsedMs < 45_000 ? 5_000 : 8_000;
        await new Promise(r => setTimeout(r, pollIntervalMs));
        const probe = await this.getAccountInfo(input.agentPublicKey).catch(() => null);
        if (probe?.exists && probe.balance >= input.fundingAmount) {
          indexed = true;
          lastBalance = probe.balance;
          break;
        }
        if (probe) lastBalance = probe.balance;
      }
      if (!indexed) {
        throw new Error(
          `provisionFundedSubaccount: Pacifica did not index deposit within 90s. ` +
          `Deposit txSignature=${depositTxSignature || 'unknown'}, lastObservedBalance=$${lastBalance}. ` +
          `Your funds are safe and will appear in your main account shortly — ` +
          `simply retry bot creation in a moment and it will use the already-deposited funds.`,
        );
      }
      console.log(`[PacificaAdapter] provisionFundedSubaccount: Pacifica indexed deposit in ${((Date.now() - pollStart) / 1000).toFixed(1)}s, mainBalance=$${lastBalance}`);
    } else {
      console.log(`[PacificaAdapter] provisionFundedSubaccount: skipping deposit (mainBalance=$${currentMainBalance} already covers fundingAmount=$${input.fundingAmount})`);
    }

    // 4. Create subaccount. Pacifica's eventual consistency means even after our
    // poll succeeds, create can still 422. Retry up to 3x with 5s backoff.
    let subaccountInfo: SubaccountInfo | null = null;
    let lastCreateError: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        subaccountInfo = await this.createSubaccount({
          mainSecretKey: input.mainSecretKey,
          subSecretKey: input.subSecretKey,
          agentPublicKey: input.agentPublicKey,
        });
        break;
      } catch (err: any) {
        lastCreateError = err;
        const is422 = (err?.message || '').includes('422') || (err?.message || '').includes('Account not found');
        if (is422 && attempt < 3) {
          console.warn(`[PacificaAdapter] provisionFundedSubaccount: createSubaccount attempt ${attempt}/3 failed with 422, retrying in 5s — ${err.message}`);
          await new Promise(r => setTimeout(r, 5_000));
          continue;
        }
        throw err;
      }
    }
    if (!subaccountInfo) {
      throw new Error(`provisionFundedSubaccount: createSubaccount failed after 3 attempts: ${lastCreateError?.message || 'unknown'}`);
    }
    const subaccountId = subaccountInfo.subaccountId;

    // 5. Transfer fundingAmount from main → new subaccount. If this fails, the
    // subaccount exists with $0 and funds remain in main. Caller saves the bot row
    // and surfaces the warning so user can recover via existing Add Funds flow.
    try {
      const transferResult = await this.transferBetweenSubaccounts({
        agentSecretKey: input.mainSecretKey,
        mainWalletAddress: input.agentPublicKey,
        fromSubaccountId: '', // empty = transfer from main account (adapter falls back to signer pubkey)
        toSubaccountId: subaccountId,
        amount: input.fundingAmount,
      });
      if (!transferResult.success) {
        return {
          subaccountId,
          wasNewAccount,
          transferSucceeded: false,
          depositTxSignature,
          warning: `Subaccount created but transfer failed: ${transferResult.error || 'unknown'}. Funds are safe in your main account — use Add Funds to retry.`,
        };
      }
    } catch (err: any) {
      return {
        subaccountId,
        wasNewAccount,
        transferSucceeded: false,
        depositTxSignature,
        warning: `Subaccount created but transfer threw: ${err.message}. Funds are safe in your main account — use Add Funds to retry.`,
      };
    }

    console.log(`[PacificaAdapter] provisionFundedSubaccount: complete. subaccount=${subaccountId} wasNewAccount=${wasNewAccount} funded=$${input.fundingAmount}`);
    return {
      subaccountId,
      wasNewAccount,
      transferSucceeded: true,
      depositTxSignature,
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

  /**
   * GET request with credit-budget control, response cache, and in-flight dedup.
   *
   * Layered behavior (caller transparent):
   *   1. Fresh cache hit → return immediately, zero upstream cost
   *   2. In-flight dedup → if an identical fetch is already running, await it
   *   3. Quota check → if budget exhausted, return STALE data (when available)
   *      or throw QuotaExhaustedError. Never blindly spend over budget.
   *   4. Fetch → record spend on Pacifica's 60s rolling counter
   *   5. On HTTP 429 → fall back to stale cache if available (graceful degrade)
   *
   * Options:
   *   - priority: 'critical' may use full budget (writes / urgent reconcile),
   *               'normal' (default) uses 80% of budget,
   *               'background' uses 50% of budget (cron sweeps)
   *   - bypassCache: skip cache lookup but still record + dedup. Use when the
   *                  caller absolutely needs fresh data (e.g. post-trade verify).
   */
  private async get(
    path: string,
    params?: Record<string, string>,
    options?: { priority?: RequestPriority; bypassCache?: boolean },
  ): Promise<any> {
    const priority = options?.priority ?? 'normal';
    const bypassCache = options?.bypassCache === true;
    const cacheKey = pacificaCache.buildKey(path, params);

    if (!bypassCache) {
      const fresh = pacificaCache.getFresh(cacheKey);
      if (fresh !== undefined) return fresh;
    }
    pacificaCache.noteMiss();

    return pacificaCache.dedup(cacheKey, async () => {
      // Re-check cache inside the dedup gate in case a sibling caller filled
      // it between our miss and acquiring the dedup slot.
      if (!bypassCache) {
        const fresh = pacificaCache.getFresh(cacheKey);
        if (fresh !== undefined) return fresh;
      }

      // Quota guardrail. If we cannot afford the call:
      //   - If stale cache is available → return it immediately (graceful)
      //   - Otherwise wait up to MAX_WAIT_MS for the sliding window to free
      //     credits before throwing. This handles cold-start fan-out without
      //     corrupting downstream callers that interpret "throw" as "value=0".
      if (!pacificaQuota.canAfford(path, priority)) {
        const stale = pacificaCache.getStale(cacheKey);
        if (stale) {
          pacificaQuota.noteRejection();
          console.warn(
            `[pacifica-quota] budget exhausted, serving stale ${path} ` +
              `(age=${Math.round(stale.ageMs / 1000)}s, used=${pacificaQuota.currentSpend()}c)`,
          );
          return stale.data;
        }

        // No stale fallback. Wait for budget to free up.
        const MAX_WAIT_MS = 8_000;
        const POLL_INTERVAL_MS = 250;
        const deadline = Date.now() + MAX_WAIT_MS;
        while (Date.now() < deadline) {
          const sleepMs = Math.min(
            POLL_INTERVAL_MS,
            Math.max(50, pacificaQuota.msUntilNextRefund()),
            deadline - Date.now(),
          );
          await new Promise((resolve) => setTimeout(resolve, sleepMs));
          if (pacificaQuota.canAfford(path, priority)) break;
        }

        if (!pacificaQuota.canAfford(path, priority)) {
          pacificaQuota.noteRejection();
          console.warn(
            `[pacifica-quota] gave up after ${MAX_WAIT_MS}ms wait for ${path} ` +
              `(used=${pacificaQuota.currentSpend()}c)`,
          );
          throw new QuotaExhaustedError(path, pacificaQuota.currentSpend());
        }
      }

      let url = `${this.config.baseUrl}${path}`;
      if (params && Object.keys(params).length > 0) {
        const searchParams = new URLSearchParams(params);
        url += `?${searchParams.toString()}`;
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
      } finally {
        // Pacifica meters the request whether it succeeds or fails (including
        // 4xx/5xx), so always record the spend.
        pacificaQuota.record(path);
      }

      if (!response.ok) {
        // Graceful fallback on rate-limit: serve stale cache if any.
        if (response.status === 429) {
          const stale = pacificaCache.getStale(cacheKey);
          if (stale) {
            console.warn(
              `[pacifica-quota] upstream 429 on ${path}, serving stale ` +
                `(age=${Math.round(stale.ageMs / 1000)}s)`,
            );
            return stale.data;
          }
        }
        const errorBody = await response.text().catch(() => '');
        throw new Error(
          `PacificaAdapter GET ${path}: ${response.status} ${response.statusText} — ${errorBody}`,
        );
      }

      const json = await response.json();
      const data = this.unwrapEnvelope(json);
      pacificaCache.set(cacheKey, path, data);
      return data;
    });
  }

  // ==========================================================================
  // Task 143: Pacifica Builder Code & Referral Wiring
  // ==========================================================================
  //
  // Pacifica grants QuantumVault a builder_code ("QuantumVault") and a
  // referral identifier. Every order tagged with our builder_code earns us a
  // share of the order fee (per Pacifica's configured `fee_rate`), and every
  // referred user counts toward our points/share. Both require a one-time
  // SIGNED approval/claim from the user before they take effect:
  //   - approve_builder_code → POST /account/builder_codes/approve
  //   - claim_referral_code  → POST /referral/user/code/claim
  //
  // Both flows are tied to the user's MAIN wallet (the agent public key on
  // Pacifica), not per-subaccount, so they fire at most once per user.
  // QuantumVault holds the user's agent keypair server-side, so we sign
  // both ops with PacificaSigner — no wallet popup, no frontend change.
  //
  // Failure-mode policy (deliberate, asymmetric):
  //   - Builder approval: fail-CLOSED. If approval hasn't landed, we MUST
  //     NOT inject builder_code on the order (Pacifica returns 403). Lose
  //     the fee on that one order; retry on the next.
  //   - Referral claim:   fail-OPEN.  Never block trade flow on referral.

  /**
   * Centralized pre-trade enrollment. Called at the top of every order/TpSl
   * adapter method. Reads current flags, fires any missing approval/claim
   * via a per-wallet async mutex (so concurrent first-trades coalesce into
   * a single in-flight call), and returns the resulting flag state.
   *
   * Safe to call on every trade: the steady-state path is one DB SELECT
   * plus the mutex map lookup (no POST) once both flags are true.
   */
  private async ensurePacificaEnrollment(
    agentPublicKey: string,
    agentSecretKey: Uint8Array,
  ): Promise<{ builderApproved: boolean; referralClaimed: boolean }> {
    try {
      const { storage } = await import('../../storage.js');
      // The Pacifica main account == whatever keypair is signing the order.
      // Two cases:
      //   1. User's server-managed agent key (legacy main-account trades) —
      //      tracked on wallets.agent_public_key + wallets enrollment flags.
      //   2. Per-bot subaccount key (Phase 4b — each bot is its OWN Pacifica
      //      main account, key in trading_bots.protocol_subaccount_id) —
      //      tracked on trading_bots enrollment flags.
      // We must look up both and flip flags on whichever table matched.
      const wallet = await storage.getWalletByAgentPublicKey(agentPublicKey);
      const bot = wallet ? null : await storage.getBotByAgentPublicKey(agentPublicKey);
      const row = wallet ?? bot;
      const kind: 'wallet' | 'bot' | null = wallet ? 'wallet' : bot ? 'bot' : null;

      // Steady-state fast path: both flags already true → no work.
      if (row?.pacificaBuilderApproved && row?.pacificaReferralClaimed) {
        return { builderApproved: true, referralClaimed: true };
      }
      // No matching row anywhere means we have nothing to flip — skip and
      // treat as not enrolled. Shouldn't fire in practice (trade implies a
      // known wallet or bot) but we never want to block a trade.
      if (!row || !kind) {
        return { builderApproved: false, referralClaimed: false };
      }

      // Per-key mutex: collapse concurrent callers into a single attempt.
      const existing = this.enrollmentInFlight.get(agentPublicKey);
      if (existing) return existing;

      const work = (async () => {
        let builderApproved = !!row.pacificaBuilderApproved;
        let referralClaimed = !!row.pacificaReferralClaimed;

        if (!builderApproved && this.config.builderCode) {
          builderApproved = await this.approveBuilderCodeForUser({
            agentPublicKey,
            agentSecretKey,
            accountKind: kind,
          });
        }
        if (!referralClaimed && this.config.referralAddress) {
          referralClaimed = await this.claimReferralCodeForUser({
            agentPublicKey,
            agentSecretKey,
            accountKind: kind,
          });
        }
        return { builderApproved, referralClaimed };
      })().finally(() => {
        this.enrollmentInFlight.delete(agentPublicKey);
      });

      this.enrollmentInFlight.set(agentPublicKey, work);
      return await work;
    } catch (err: any) {
      // Never let enrollment failures break a trade. Builder injection is
      // gated on the returned `builderApproved` flag (so fail-closed naturally
      // falls back to "place the order without our code"); referral is
      // best-effort anyway.
      console.error('[PacificaEnrollment] Unexpected error in ensurePacificaEnrollment:', err?.message || err);
      return { builderApproved: false, referralClaimed: false };
    }
  }

  /**
   * Sign and POST approve_builder_code. Returns true on success or if the
   * user is already approved upstream (idempotency tolerance).
   *
   * Public so the new-user provision flow in routes.ts can warm the flag
   * proactively after main-account creation. The mutex+flag fast-path
   * inside ensurePacificaEnrollment makes redundant calls cheap.
   */
  async approveBuilderCodeForUser(input: {
    agentPublicKey: string;
    agentSecretKey: Uint8Array;
    // Task 149: route the post-success flag flip to the correct table.
    // Defaults to 'wallet' for backward-compat with the provision warm-up
    // call site in routes.ts which always operates on the main agent key.
    accountKind?: 'wallet' | 'bot';
  }): Promise<boolean> {
    const builderCode = this.config.builderCode;
    if (!builderCode) return false;
    const maxFeeRate = this.config.builderMaxFeeRate ?? '0.002';

    const signer = new PacificaSigner(input.agentSecretKey);
    // Inner `data` dict ONLY — buildRequestBody wraps the envelope, sorts
    // keys, signs, and flattens. Never hand-build the outer message.
    const operationData: Record<string, unknown> = {
      builder_code: builderCode,
      max_fee_rate: maxFeeRate,
    };

    const ok = await this.postWithApprovalRetry(
      '/account/builder_codes/approve',
      () => signer.buildRequestBody(
        OPERATION_TYPES.APPROVE_BUILDER_CODE,
        operationData,
        input.agentPublicKey,
        null,
        5000, // approval expiry_window per Pacifica docs (orders use 30000)
      ),
      '[PacificaBuilderApprove]',
      /already.*approv/i,
    );

    if (ok) {
      try {
        const { storage } = await import('../../storage.js');
        if (input.accountKind === 'bot') {
          await storage.markBotPacificaBuilderApproved(input.agentPublicKey);
        } else {
          await storage.markPacificaBuilderApproved(input.agentPublicKey);
        }
      } catch (err: any) {
        console.error('[PacificaBuilderApprove] Flag persist failed (will retry next trade):', err?.message || err);
        return false;
      }
    }
    return ok;
  }

  /**
   * Sign and POST claim_referral_code. Returns true on success or if the
   * user has already claimed upstream. Fail-OPEN — never block trade flow.
   */
  async claimReferralCodeForUser(input: {
    agentPublicKey: string;
    agentSecretKey: Uint8Array;
    // Task 149: see approveBuilderCodeForUser. Defaults to 'wallet'.
    accountKind?: 'wallet' | 'bot';
  }): Promise<boolean> {
    const refAddress = this.config.referralAddress;
    if (!refAddress) return false;

    const signer = new PacificaSigner(input.agentSecretKey);
    // Pacifica spec: POST /referral/user/code/claim — body field name is
    // `referral_code`, NOT `code`. The signing payload must match exactly
    // (Pacifica verifies the signature over the same JSON shape the body
    // carries). Previously this was `{ code: refAddress }` and silently
    // failed for 100% of bots — see ROOT CAUSE note above ensurePacificaEnrollment.
    const operationData: Record<string, unknown> = { referral_code: refAddress };

    const ok = await this.postWithApprovalRetry(
      '/referral/user/code/claim',
      () => signer.buildRequestBody(
        OPERATION_TYPES.CLAIM_REFERRAL_CODE,
        operationData,
        input.agentPublicKey,
        null,
        5000,
      ),
      '[PacificaReferralClaim]',
      /already.*claim/i,
    );

    if (ok) {
      try {
        const { storage } = await import('../../storage.js');
        if (input.accountKind === 'bot') {
          await storage.markBotPacificaReferralClaimed(input.agentPublicKey);
        } else {
          await storage.markPacificaReferralClaimed(input.agentPublicKey);
        }
      } catch (err: any) {
        console.error('[PacificaReferralClaim] Flag persist failed (will retry next trade):', err?.message || err);
        return false;
      }
    }
    return ok;
  }

  /**
   * Shared POST helper for approval/claim with:
   *   - "already approved/claimed" tolerance (treat as success)
   *   - bounded 429 backoff (cap 3 attempts, jittered <2s total)
   *   - loud tagged logging on every other failure (returns false; caller
   *     leaves the flag false so the next trade retries naturally)
   *
   * Body is built lazily via a thunk because each retry needs a fresh
   * timestamp/signature (Pacifica rejects stale signed bodies).
   */
  private async postWithApprovalRetry(
    path: string,
    buildBody: () => unknown,
    logTag: string,
    alreadyMatcher: RegExp,
  ): Promise<boolean> {
    const delays = [250, 600, 1100]; // ~1.95s cumulative cap
    let lastError = '';
    for (let attempt = 0; attempt < delays.length; attempt++) {
      try {
        const body = buildBody();
        await this.post(path, body);
        return true;
      } catch (err: any) {
        const msg = err?.message || String(err);
        lastError = msg;
        // Tolerate "already approved/claimed" semantic on non-2xx — Pacifica
        // returns this when the user has already enrolled (e.g. from a prior
        // server instance, manual API call, or duplicate POST after restart).
        if (alreadyMatcher.test(msg)) {
          console.log(`${logTag} Already enrolled upstream (treating as success): ${msg}`);
          return true;
        }
        // Retry on 429 with jittered backoff; everything else is a hard fail
        // (we'll retry on the user's next trade).
        if (/\b429\b/.test(msg) && attempt < delays.length - 1) {
          const jitter = Math.floor(Math.random() * 150);
          const wait = delays[attempt] + jitter;
          console.warn(`${logTag} 429 rate-limited, retrying in ${wait}ms (attempt ${attempt + 1}/${delays.length})`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        console.error(`${logTag} POST ${path} failed: ${msg}`);
        return false;
      }
    }
    console.error(`${logTag} POST ${path} exhausted retries: ${lastError}`);
    return false;
  }

  private async post(path: string, body: unknown): Promise<any> {
    const url = `${this.config.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } finally {
      // POSTs also consume credits; charge default cost.
      pacificaQuota.record(path);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(
        `PacificaAdapter POST ${path}: ${response.status} ${response.statusText} — ${errorBody}`,
      );
    }

    const json = await response.json();
    const data = this.unwrapEnvelope(json);

    // Invalidate caches whose contents are mutated by this write so that the
    // next reader sees post-trade state rather than the pre-trade snapshot.
    // Path-based heuristic: any order/position/balance-mutating endpoint
    // invalidates positions + account cache for ALL subaccounts. Aggressive
    // but safe — worst case is one cold-cache fetch per subaccount.
    if (
      path.includes('/orders') ||
      path.includes('/positions') ||
      path.includes('/deposit') ||
      path.includes('/withdraw') ||
      path.includes('/transfer')
    ) {
      pacificaCache.invalidate('/positions');
      pacificaCache.invalidate('/account');
    }

    return data;
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

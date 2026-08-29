import type {
  ProtocolAdapter,
  CreateSubaccountInput,
  SubaccountCaps,
  ReuseSubaccountInput,
  ReuseSubaccountResult,
  AgentWalletResetState,
  FeeRateQuoteRequest,
  FeeRateQuoteResult,
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
  FillEvent,
  OrderUpdate,
  SettlePnlParams,
  SettleResult,
  AdapterCapabilities,
  Unsubscribe,
} from '../protocol-types.js';
import { SymbolRegistry, buildPacificaMappings } from '../symbol-registry.js';
import { PacificaSigner, OPERATION_TYPES, buildSigningMessage } from './pacifica-signer.js';
import { PACIFICA_USDC_MINT, PACIFICA_MIN_TRANSFER_USDC, PACIFICA_RECYCLE_EMPTY_USDC } from './pacifica-constants.js';

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
  PacificaAccountSettingsResponse,
  PacificaMarginSettingResponse,
  PacificaOrderResponse,
  PacificaTradeResponse,
  PacificaTradeHistoryEnvelope,
  PacificaEquityHistoryPoint,
  PacificaSubaccountResponse,
  PacificaOrderbookLevel,
  PacificaFundingResponse,
} from './pacifica-types.js';
import { mapToProtocolSide } from './pacifica-types.js';
import { pacificaQuota, QuotaExhaustedError, type RequestPriority } from './pacifica-quota.js';
import { pacificaCache } from './pacifica-cache.js';
import { appendTelemetry } from '../../telemetry.js';
import { UNCONFIRMED_LANDING_VERDICT_TOKEN } from '../tx-verdicts.js';

const MAX_MARKET_CACHE_SIZE = 200;
const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
const PRICE_CACHE_TTL_MS = 60 * 1000;
const MAX_PRICE_CACHE_SIZE = 200;
const PACIFICA_TRADE_HISTORY_PAGE_SIZE = 200;
const PACIFICA_TRADE_HISTORY_MAX_PAGES = 10;

export type PacificaPostRetryDisposition = 'after_authoritative_read' | 'never_automatic';
export type PacificaPostPriority = 'urgent_risk_reducing' | 'normal';

interface PacificaPostSettlementPolicy {
  mutationClass: string;
  authoritativeReads: readonly string[];
  stableIdentity: boolean;
  retryDisposition: PacificaPostRetryDisposition;
  priority: PacificaPostPriority;
  mutatesVenue: boolean;
}

export class PacificaPostOutcomeAmbiguousError extends Error {
  readonly code = 'PACIFICA_POST_OUTCOME_AMBIGUOUS';
  readonly endpoint: string;
  readonly mutationClass: string;
  readonly authoritativeReads: readonly string[];
  readonly stableIdentity: boolean;
  readonly retryDisposition: PacificaPostRetryDisposition;
  readonly priority: PacificaPostPriority;

  constructor(endpoint: string, detail: string, policy: PacificaPostSettlementPolicy) {
    super(
      `PacificaAdapter POST ${endpoint}: venue outcome ambiguous (${detail}); `
      + `authoritative_read=${policy.authoritativeReads.join('+') || 'none_conclusive'}; `
      + `stable_identity=${policy.stableIdentity}; retry=${policy.retryDisposition}; `
      + `priority=${policy.priority} ${UNCONFIRMED_LANDING_VERDICT_TOKEN}`,
    );
    this.name = 'PacificaPostOutcomeAmbiguousError';
    this.endpoint = endpoint;
    this.mutationClass = policy.mutationClass;
    this.authoritativeReads = policy.authoritativeReads;
    this.stableIdentity = policy.stableIdentity;
    this.retryDisposition = policy.retryDisposition;
    this.priority = policy.priority;
  }
}

function hasStablePostIdentity(body: unknown, ...fields: string[]): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const row = body as Record<string, unknown>;
  return fields.every((field) => {
    const value = row[field];
    return value !== null && value !== undefined && String(value).trim().length > 0;
  });
}

function pacificaPostSettlementPolicy(path: string, body: unknown): PacificaPostSettlementPolicy {
  const withIdentity = (
    mutationClass: string,
    authoritativeReads: readonly string[],
    identityFields: string[],
    priority: PacificaPostPriority = 'normal',
  ): PacificaPostSettlementPolicy => {
    const stableIdentity = hasStablePostIdentity(body, ...identityFields);
    return {
      mutationClass,
      authoritativeReads,
      stableIdentity,
      retryDisposition: stableIdentity ? 'after_authoritative_read' : 'never_automatic',
      priority,
      mutatesVenue: true,
    };
  };
  const noReplay = (
    mutationClass: string,
    authoritativeReads: readonly string[] = [],
    priority: PacificaPostPriority = 'normal',
  ): PacificaPostSettlementPolicy => ({
    mutationClass,
    authoritativeReads,
    stableIdentity: false,
    retryDisposition: 'never_automatic',
    priority,
    mutatesVenue: true,
  });

  switch (path) {
    case '/orders/create_market':
      return withIdentity('reduce_only_market_close', ['/positions:fresh', '/trades/history:client_order_id'], ['client_order_id'], 'urgent_risk_reducing');
    case '/orders/create':
      return withIdentity('limit_order_create', ['/orders/open:client_order_id', '/trades/history:client_order_id'], ['client_order_id']);
    case '/orders/stop/create':
      return withIdentity('stop_order_create', ['/orders/stop:client_order_id', '/trades/history:client_order_id'], ['client_order_id']);
    case '/orders/cancel':
      return withIdentity('order_cancel', ['/orders/open:order_id', '/orders/stop:order_id'], ['order_id'], 'urgent_risk_reducing');
    case '/orders/cancel_all': {
      const allSymbols = Boolean(
        body && typeof body === 'object' && !Array.isArray(body)
          && (body as Record<string, unknown>).all_symbols === true,
      );
      return withIdentity(
        'orders_cancel_all',
        ['/orders/open:scope', '/orders/stop:scope'],
        allSymbols ? ['account', 'all_symbols'] : ['account', 'all_symbols', 'symbol'],
        'urgent_risk_reducing',
      );
    }
    case '/orders/stop/cancel':
      return withIdentity('stop_order_cancel', ['/orders/stop:order_id'], ['order_id'], 'urgent_risk_reducing');
    case '/account/leverage':
      return withIdentity('leverage_update', ['/account/settings:symbol+leverage'], ['account', 'symbol', 'leverage']);
    case '/account/margin':
      return withIdentity('margin_mode_update', ['/account/settings:margin_mode'], ['account', 'margin_mode']);
    case '/positions/tpsl':
      return withIdentity('position_tpsl_update', ['/orders/stop:symbol+legs'], ['account', 'symbol']);
    case '/account/subaccount/create':
      return withIdentity('subaccount_create', ['/account/subaccount/list:subaccount'], ['main_account', 'subaccount']);
    case '/account/builder_codes/approve':
      return withIdentity('builder_code_approval', ['/account/builder_codes/approvals:builder_code'], ['account', 'builder_code']);
    case '/referral/user/code/claim':
      return withIdentity('referral_code_claim', ['/account:referral_code'], ['account', 'code']);
    case '/account/withdraw':
      return noReplay('withdrawal');
    case '/account/subaccount/transfer':
      return noReplay('subaccount_transfer');
    case '/agent/bind':
      return noReplay('agent_binding');
    case '/account/subaccount/list':
      return {
        mutationClass: 'authenticated_subaccount_read',
        authoritativeReads: [],
        stableIdentity: true,
        retryDisposition: 'after_authoritative_read',
        priority: 'normal',
        mutatesVenue: false,
      };
    default:
      throw new Error(`PacificaAdapter POST ${path}: settlement policy is not declared`);
  }
}

const PACIFICA_TRADE_SIDES = new Set([
  'open_long', 'open_short', 'close_long', 'close_short',
]);
const PACIFICA_TRADE_EVENT_TYPES = new Set(['fulfill_maker', 'fulfill_taker']);
const PACIFICA_TRADE_CAUSES = new Set([
  'normal', 'market_liquidation', 'backstop_liquidation', 'settlement',
]);

function requirePacificaTradeNumber(
  value: unknown,
  field: string,
  positive = false,
  allowNegative = false,
): number {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Pacifica trade history row ${field} malformed`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (!allowNegative && (positive ? parsed <= 0 : parsed < 0))) {
    throw new Error(`Pacifica trade history row ${field} malformed`);
  }
  return parsed;
}

function parsePacificaTradeHistoryEnvelope(value: unknown): PacificaTradeHistoryEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Pacifica trade history envelope malformed');
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.success !== true || !Array.isArray(envelope.data) || typeof envelope.has_more !== 'boolean') {
    throw new Error('Pacifica trade history envelope malformed');
  }
  if (envelope.has_more && (typeof envelope.next_cursor !== 'string' || envelope.next_cursor.trim().length === 0)) {
    throw new Error('Pacifica trade history cursor missing');
  }
  if (envelope.next_cursor !== undefined && envelope.next_cursor !== null && typeof envelope.next_cursor !== 'string') {
    throw new Error('Pacifica trade history cursor malformed');
  }

  const data = envelope.data.map((candidate, index): PacificaTradeResponse => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`Pacifica trade history row ${index} malformed`);
    }
    const row = candidate as Record<string, unknown>;
    if (!Number.isSafeInteger(row.history_id) || Number(row.history_id) < 0) {
      throw new Error(`Pacifica trade history row ${index} history_id malformed`);
    }
    if (!Number.isSafeInteger(row.order_id) || Number(row.order_id) < 0) {
      throw new Error(`Pacifica trade history row ${index} order_id malformed`);
    }
    if (row.client_order_id !== undefined && row.client_order_id !== null
        && (typeof row.client_order_id !== 'string' || row.client_order_id.length === 0)) {
      throw new Error(`Pacifica trade history row ${index} client_order_id malformed`);
    }
    if (typeof row.symbol !== 'string' || row.symbol.trim().length === 0) {
      throw new Error(`Pacifica trade history row ${index} symbol malformed`);
    }
    requirePacificaTradeNumber(row.amount, `${index} amount`, true);
    requirePacificaTradeNumber(row.price, `${index} price`, true);
    requirePacificaTradeNumber(row.entry_price, `${index} entry_price`, true);
    requirePacificaTradeNumber(row.fee, `${index} fee`);
    requirePacificaTradeNumber(row.pnl, `${index} pnl`, false, true);
    if (typeof row.event_type !== 'string' || !PACIFICA_TRADE_EVENT_TYPES.has(row.event_type)) {
      throw new Error(`Pacifica trade history row ${index} event_type malformed`);
    }
    if (typeof row.side !== 'string' || !PACIFICA_TRADE_SIDES.has(row.side)) {
      throw new Error(`Pacifica trade history row ${index} side malformed`);
    }
    if (!Number.isSafeInteger(row.created_at) || Number(row.created_at) < 0) {
      throw new Error(`Pacifica trade history row ${index} created_at malformed`);
    }
    if (typeof row.cause !== 'string' || !PACIFICA_TRADE_CAUSES.has(row.cause)) {
      throw new Error(`Pacifica trade history row ${index} cause malformed`);
    }
    return row as unknown as PacificaTradeResponse;
  });

  return {
    success: true,
    data,
    next_cursor: envelope.next_cursor as string | null | undefined,
    has_more: envelope.has_more,
  };
}

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

function parseFeeRateDecimal(value: unknown): number | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

type BuilderSuppressionReason =
  | 'builder_owner_unconfigured'
  | 'overview_read_failed'
  | 'overview_malformed'
  | 'overview_code_mismatch'
  | 'approval_read_failed'
  | 'approval_malformed'
  | 'approval_missing'
  | 'approval_below_rate';

const BUILDER_SUPPRESSION_REASONS: readonly BuilderSuppressionReason[] = [
  'builder_owner_unconfigured',
  'overview_read_failed',
  'overview_malformed',
  'overview_code_mismatch',
  'approval_read_failed',
  'approval_malformed',
  'approval_missing',
  'approval_below_rate',
];

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
  // Max fee rate the user signs at builder-code approval time.
  // Matches our registered Pacifica fee_rate: 0.001 (10 bps / 0.1%).
  builderMaxFeeRate?: string;
}

const DEFAULT_CONFIG: PacificaAdapterConfig = {
  baseUrl: 'https://api.pacifica.fi/api/v1',
  wsUrl: 'wss://ws.pacifica.fi/ws',
  builderMaxFeeRate: '0.001',
};

export class PacificaAdapter implements ProtocolAdapter {
  readonly protocolName = 'pacifica';
  readonly protocolVersion = '1.0.0';
  readonly collateralMint = PACIFICA_USDC_MINT;
  readonly collateralSymbol = 'USDC';
  readonly minTransferAmount = PACIFICA_MIN_TRANSFER_USDC;
  // Subaccount Recycling Plan §4.1 / §14.2. Pacifica has no delete-subaccount API (permanent)
  // and a hard 10-cap per agent. `recyclable` is true now that Phase E implements the full
  // sweep-empty → pool → reuse lifecycle (verifySubaccountEmpty + reuseSubaccount), so the
  // orchestrator may route creates through the spare pool (§14.5 invariant).
  readonly subaccountCaps: SubaccountCaps = {
    permanent: true,
    recyclable: true,
    maxPerAgent: 10,
    accountModel: 'subaccount',
  };

  private config: PacificaAdapterConfig;
  private registry: SymbolRegistry | null = null;
  private marketCache: CacheEntry<ProtocolMarket[]> | null = null;
  private priceCache: Map<string, CacheEntry<number>> = new Map();
  private marketDetailsMap: Map<string, ProtocolMarket> = new Map();
  private initialized = false;
  private telemetryInterval: NodeJS.Timeout | null = null;
  private builderSuppressionCounts = new Map<BuilderSuppressionReason, number>();
  // Task 143: per-wallet async mutex for enrollment. Concurrent first-trades
  // from the same user await a single in-flight approval+claim rather than
  // each firing their own (which would yield duplicate POSTs and racy flag
  // writes). Keyed on agent public key (the user's Pacifica main wallet).
  private enrollmentInFlight: Map<string, Promise<{ builderApproved: boolean; referralClaimed: boolean }>> = new Map();
  // Single-flight ownership for the full-market price sweep. At most one
  // sweep runs at a time; concurrent callers join this promise rather than
  // starting a replacement. Cleared in .finally() when the sweep settles.
  private _sweepOwner: Promise<Record<string, number>> | null = null;

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
    const builderSuppressed = BUILDER_SUPPRESSION_REASONS.reduce(
      (sum, reason) => sum + (this.builderSuppressionCounts.get(reason) ?? 0),
      0,
    );
    const builderReasons = BUILDER_SUPPRESSION_REASONS
      .map((reason) => `${reason}=${this.builderSuppressionCounts.get(reason) ?? 0}`)
      .join(',');
    console.log(
      `[pacifica-telemetry] credits=${q.creditsUsed}/${q.totalBudget} (60s) | ` +
        `served=${q.requestsServed} rejected=${q.requestsRejected} | ` +
        `cache: ${c.entries} entries, ${c.hitRatePct}% hit, ${c.dedupedJoins} deduped | ` +
        `builder_suppressed=${builderSuppressed} reasons=${builderReasons} | ` +
        `top: ${top || '(none)'}`,
    );
    this.builderSuppressionCounts.clear();
    pacificaQuota.resetCounters();
    pacificaCache.resetCounters();
  }

  private recordBuilderSuppression(reason: BuilderSuppressionReason): void {
    const count = (this.builderSuppressionCounts.get(reason) ?? 0) + 1;
    this.builderSuppressionCounts.set(reason, count);
    if (count !== 1) return;
    const line = `[PacificaBuilderSuppression] reason=${reason} count=${count}`;
    console.warn(line);
    appendTelemetry(line);
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
      // $1 per-withdraw fee + $10 transfer minimum make per-trade payouts
      // uneconomical → copy-bot profit-share must accumulate then claim, not
      // pay immediately on every close.
      supportsImmediateProfitShare: false,
      maxSubaccounts: null,
      settlementType: 'hybrid',
      requiresExternalSubaccountKey: true,
      // Each Pacifica bot's subaccount signing key is HD-derived from the owner's
      // agent recovery phrase (monotonic per-wallet index), exactly like Flash. This
      // gives the key a durable SECOND recovery source (seed + index) beyond the
      // encrypted V3 blob, so it survives a key-blob loss (corruption / AAD mismatch /
      // the one-time v1→v3 UMK regeneration that orphaned the early random-key bots).
      walletDerivation: 'agent_hd',
      // Borrow/carry (Vault borrow engine, Phase A): funds live in the exchange
      // subaccount (not a pledgeable wallet) → NO per-bot debt, NO carry-on-close.
      // Account-level borrow (agent-main → Jupiter Lend) is still available; the
      // $1 fee + $10 min make per-bot round-trips uneconomic.
      custodyModel: 'exchange_subaccount',
      supportsPerBotExternalDebt: false,
      supportsCarryOnClose: false,
      roundTripWithdrawalEconomics: 'fixed_fee_high_min',
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

  async getPrice(internalSymbol: string, opts?: { priority?: RequestPriority }): Promise<number | null> {
    const priority = opts?.priority ?? 'background';

    const cached = this.priceCache.get(internalSymbol.toUpperCase());
    if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_TTL_MS) {
      return cached.data;
    }

    // PRICE-STARVE fix: 'normal' / 'critical' callers (e.g. the analyze cycle)
    // fetch this one symbol's /book directly at the requested priority so they
    // are never starved by the background bulk sweep (getAllPrices) that the
    // dashboard uses and that is capped at 162 credits/min.
    if (priority !== 'background') {
      const market = (this.marketCache?.data ?? []).find(
        (m) => m.internalSymbol.toUpperCase() === internalSymbol.toUpperCase(),
      );
      if (!market) return null;
      try {
        const book = await this.get('/book', { symbol: market.protocolSymbol, depth: '1' }, { priority });
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
          return null;
        }
        if (this.priceCache.size >= MAX_PRICE_CACHE_SIZE) {
          this.evictStalePrices();
        }
        this.priceCache.set(internalSymbol.toUpperCase(), { data: mid, fetchedAt: Date.now() });
        return mid;
      } catch {
        return null;
      }
    }

    const prices = await this.getAllPrices();
    return prices[internalSymbol] ?? null;
  }

  /**
   * DASH-PRICE-FAILFAST-01 — synchronous cached-price snapshot.
   *
   * Reads from the in-memory priceCache without any network access, quota
   * consumption, or cache mutation. Stale entries are returned as-is — they
   * are display-only and MUST NOT be used for trading decisions. NaN,
   * Infinity, and non-positive values are excluded. Safe on the request path.
   */
  getCachedPrices(internalSymbols: string[]): Record<string, number> {
    const result: Record<string, number> = {};
    const seen = new Set<string>();
    for (const sym of internalSymbols) {
      const key = sym.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = this.priceCache.get(key);
      // Stale entries permitted — display-only. Exclude NaN, Infinity, ≤ 0.
      if (entry !== undefined && Number.isFinite(entry.data) && entry.data > 0) {
        // Return with the original-case symbol to match database market strings.
        result[sym] = entry.data;
      }
    }
    return result;
  }

  /**
   * DASH-PRICE-FAILFAST-02 — Staleness metadata companion.
   *
   * Returns the oldest fetchedAt among valid cache entries for the requested
   * symbols. Pure read — no mutation, no network access, no quota.
   */
  getCachedPriceMeta(internalSymbols: string[]): { oldestFetchedAt: number | null } {
    let oldest: number | null = null;
    for (const sym of internalSymbols) {
      const entry = this.priceCache.get(sym.toUpperCase());
      if (entry !== undefined && Number.isFinite(entry.data) && entry.data > 0) {
        if (oldest === null || entry.fetchedAt < oldest) {
          oldest = entry.fetchedAt;
        }
      }
    }
    return { oldestFetchedAt: oldest };
  }

  /**
   * In-memory market symbol list. Pure read — no network, no quota.
   * Used by the /api/prices fallback to enumerate cached prices without any
   * upstream work after a consumer deadline fires.
   */
  getCachedMarketSymbols(): string[] {
    const markets = this.marketCache?.data;
    if (!markets) return [];
    return markets.map((m) => m.internalSymbol);
  }

  getAllPrices(): Promise<Record<string, number>> {
    // NOT async: must return the stored Promise instance directly so all
    // concurrent callers get the SAME object reference (async functions always
    // allocate a new Promise wrapper, breaking the identity guarantee).
    //
    // Single-flight: join the running sweep rather than starting a replacement.
    // Timed-out display consumers (e.g. /api/prices with a 10 s deadline) fall
    // back to getCachedPrices(); the owned sweep continues and future callers
    // join it. A new sweep starts only once the owned one has fully settled.
    if (this._sweepOwner !== null) {
      return this._sweepOwner;
    }
    const sweep = this._runAllPrices().finally(() => {
      this._sweepOwner = null;
    });
    this._sweepOwner = sweep;
    return sweep;
  }

  private async _runAllPrices(): Promise<Record<string, number>> {
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
    // +epsilon before floor: float division of a clean lot multiple can yield e.g.
    // 0.3 / 0.1 === 2.9999999999999996, which would wrongly floor DOWN a whole lot
    // (0.3 -> 0.2) and push the order below the venue minimum notional (422 "Order amount
    // too low"). The nudge only affects values within 1e-9 of a lot boundary (float
    // artifacts), never genuine intent.
    const raw = Math.floor(size / lotSize + 1e-9) * lotSize;
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

  /**
   * Fresh Pacifica account + builder authority for risk-increasing admission.
   * Builder proof is optional commercial attribution: any builder-only failure
   * returns the proven base rate and binds the resulting order to suppression.
   */
  async getFeeRateQuote(input: FeeRateQuoteRequest): Promise<FeeRateQuoteResult> {
    if (input.liquidityRole !== 'taker') {
      return { availability: 'unavailable', reason: 'malformed_quote' };
    }
    const params: Record<string, string> = { account: input.account };
    if (input.subaccountId) params.subaccount_id = input.subaccountId;

    const response: PacificaAccountResponse = await this.get('/account', params, {
      priority: 'critical',
      cachePolicy: 'fresh-required',
    });
    const makerRate = parseFeeRateDecimal(response?.maker_fee);
    const takerRate = parseFeeRateDecimal(response?.taker_fee);
    if (makerRate === null || takerRate === null) {
      return { availability: 'unavailable', reason: 'malformed_quote' };
    }

    const requestedSubaccount = input.subaccountId ?? null;
    const responseSubaccount = response?.subaccount_id ?? null;
    if (responseSubaccount !== requestedSubaccount) {
      return { availability: 'unavailable', reason: 'identity_mismatch' };
    }

    const baseQuote = (): FeeRateQuoteResult => ({
      availability: 'available',
      protocol: this.protocolName,
      account: input.account,
      subaccountId: requestedSubaccount,
      liquidityRole: input.liquidityRole,
      baseRate: takerRate,
      effectiveRate: takerRate,
      provenance: 'pacifica:/account.taker_fee:fresh-required',
      observedAt: Date.now(),
      builder: { status: 'absent' },
    });

    const requestedBuilderCode = (input.builderCode || this.config.builderCode || '').trim();
    if (!requestedBuilderCode) return baseQuote();

    const suppress = (reason: BuilderSuppressionReason): FeeRateQuoteResult => {
      this.recordBuilderSuppression(reason);
      return baseQuote();
    };

    const builderOwnerCandidate = this.config.referralAddress?.trim();
    if (!builderOwnerCandidate) return suppress('builder_owner_unconfigured');

    let overview: unknown;
    try {
      overview = await this.get('/builder/overview', { account: builderOwnerCandidate }, {
        priority: 'critical',
        cachePolicy: 'fresh-required',
      });
    } catch {
      return suppress('overview_read_failed');
    }
    if (!Array.isArray(overview)) return suppress('overview_malformed');
    const overviewMatches = overview.filter((row) =>
      !!row && typeof row === 'object'
      && (row as Record<string, unknown>).builder_code === requestedBuilderCode,
    ) as Array<Record<string, unknown>>;
    if (overviewMatches.length === 0) return suppress('overview_code_mismatch');
    if (overviewMatches.length !== 1) return suppress('overview_malformed');
    const builderRate = parseFeeRateDecimal(overviewMatches[0].fee_rate);
    if (builderRate === null) return suppress('overview_malformed');

    let approvals: unknown;
    try {
      approvals = await this.get('/account/builder_codes/approvals', { account: input.account }, {
        priority: 'critical',
        cachePolicy: 'fresh-required',
      });
    } catch {
      return suppress('approval_read_failed');
    }
    if (!Array.isArray(approvals)) return suppress('approval_malformed');
    const approvalMatches = approvals.filter((row) =>
      !!row && typeof row === 'object'
      && (row as Record<string, unknown>).builder_code === requestedBuilderCode,
    ) as Array<Record<string, unknown>>;
    if (approvalMatches.length === 0) return suppress('approval_missing');
    if (approvalMatches.length !== 1) return suppress('approval_malformed');
    const approvalCeiling = parseFeeRateDecimal(approvalMatches[0].max_fee_rate);
    if (approvalCeiling === null) return suppress('approval_malformed');
    if (approvalCeiling < builderRate) return suppress('approval_below_rate');

    return {
      availability: 'available',
      protocol: this.protocolName,
      account: input.account,
      subaccountId: requestedSubaccount,
      liquidityRole: input.liquidityRole,
      baseRate: takerRate,
      effectiveRate: takerRate + builderRate,
      provenance: 'pacifica:/account.taker_fee+/builder/overview.fee_rate+/account/builder_codes/approvals.max_fee_rate:fresh-required',
      observedAt: Date.now(),
      builder: {
        status: 'included',
        code: requestedBuilderCode,
        rate: builderRate,
        provenance: 'pacifica:/builder/overview.fee_rate:fresh-required',
      },
    };
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
    // cross_mmr is the TRUE maintenance-margin requirement (liquidation when
    // equity < cross_mmr). total_margin_used is INITIAL margin — much higher.
    const crossMmr = parseFloat(response.cross_mmr);

    return {
      equity,
      balance,
      unrealizedPnl,
      availableMargin,
      maintenanceMargin,
      maintenanceMarginRequired: Number.isFinite(crossMmr) ? crossMmr : undefined,
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

  private async getStrictAccountLeverageForMarket(
    agentPublicKey: string,
    internalSymbol: string,
    subaccountId?: string,
  ): Promise<number | null> {
    const params: Record<string, string> = { account: agentPublicKey };
    if (subaccountId) params.subaccount_id = subaccountId;

    const response: unknown = await this.get('/account/settings', params, {
      priority: 'critical',
      cachePolicy: 'fresh-required',
    });
    if (response === null || typeof response !== 'object' || Array.isArray(response)) return null;

    const rows = (response as Partial<PacificaAccountSettingsResponse>).margin_settings;
    if (!Array.isArray(rows)) return null;
    if (rows.some((candidate) => (
      candidate === null
      || typeof candidate !== 'object'
      || typeof (candidate as PacificaMarginSettingResponse).symbol !== 'string'
      || (candidate as PacificaMarginSettingResponse).symbol.trim() === ''
    ))) return null;

    const protocolSymbol = this.getRegistry().internalToProtocol(internalSymbol).toUpperCase();
    const matches = rows.filter((candidate): candidate is PacificaMarginSettingResponse => (
      (candidate as PacificaMarginSettingResponse).symbol.toUpperCase() === protocolSymbol
    ));
    if (matches.length !== 1) return null;

    const rawLeverage: unknown = matches[0].leverage;
    if (rawLeverage === null || rawLeverage === undefined || String(rawLeverage).trim() === '') {
      return null;
    }
    const leverage = Number(rawLeverage);
    return Number.isSafeInteger(leverage) && leverage > 0 ? leverage : null;
  }

  async getStrictPositionForMarket(
    agentPublicKey: string,
    internalSymbol: string,
    subaccountId?: string,
  ): Promise<ProtocolPosition | null> {
    const params: Record<string, string> = { account: agentPublicKey };
    if (subaccountId) params.subaccount_id = subaccountId;

    const response: unknown = await this.get('/positions', params, {
      priority: 'critical',
      cachePolicy: 'fresh-required',
    });
    if (!Array.isArray(response)) {
      throw new Error('PacificaAdapter: strict /positions response is not an array');
    }

    const protocolSymbol = this.getRegistry().internalToProtocol(internalSymbol).toUpperCase();
    const matches = response.filter((candidate): candidate is PacificaPositionResponse => (
      candidate !== null
      && typeof candidate === 'object'
      && typeof (candidate as PacificaPositionResponse).symbol === 'string'
      && (candidate as PacificaPositionResponse).symbol.toUpperCase() === protocolSymbol
    ));
    if (matches.length === 0) {
      const hasUnclassifiedRow = response.some((candidate) => (
        candidate === null
        || typeof candidate !== 'object'
        || typeof (candidate as PacificaPositionResponse).symbol !== 'string'
      ));
      if (hasUnclassifiedRow) {
        throw new Error('PacificaAdapter: strict /positions cannot prove the requested market is absent');
      }
      return null;
    }
    if (matches.length !== 1) {
      throw new Error(`PacificaAdapter: strict /positions returned duplicate ${internalSymbol} rows`);
    }

    const position = matches[0];
    if (position.side !== 'bid' && position.side !== 'ask') {
      throw new Error(`PacificaAdapter: strict ${internalSymbol} position has invalid side`);
    }
    const amountValue = position.amount ?? position.size;
    const rawAmount = Number(amountValue);
    if (
      amountValue === null
      || amountValue === undefined
      || String(amountValue).trim() === ''
      || !Number.isFinite(rawAmount)
      || rawAmount < 0
    ) {
      throw new Error(`PacificaAdapter: strict ${internalSymbol} position has invalid amount`);
    }
    const entryValue = position.entry_price;
    const entryPrice = Number(entryValue);
    if (
      entryValue === null
      || entryValue === undefined
      || String(entryValue).trim() === ''
      || !Number.isFinite(entryPrice)
      || entryPrice < 0
      || (rawAmount > 0 && entryPrice <= 0)
    ) {
      throw new Error(`PacificaAdapter: strict ${internalSymbol} position has invalid entry price`);
    }

    const mapped = this.mapPosition(position, {});
    if (!Number.isFinite(mapped.baseSize) || !Number.isFinite(mapped.entryPrice)) {
      throw new Error(`PacificaAdapter: strict ${internalSymbol} position mapping is invalid`);
    }
    if (!Number.isFinite(mapped.markPrice) || mapped.markPrice <= 0) {
      mapped.markPrice = mapped.entryPrice;
    }
    if (!Number.isFinite(mapped.unrealizedPnl)) mapped.unrealizedPnl = 0;
    return mapped;
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
    const requestedLimit = params?.limit ?? PACIFICA_TRADE_HISTORY_PAGE_SIZE;
    const requestedMaxPages = params?.maxPages ?? PACIFICA_TRADE_HISTORY_MAX_PAGES;
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > PACIFICA_TRADE_HISTORY_PAGE_SIZE) {
      throw new Error(`Pacifica trade history limit must be an integer from 1 to ${PACIFICA_TRADE_HISTORY_PAGE_SIZE}`);
    }
    if (!Number.isInteger(requestedMaxPages) || requestedMaxPages < 1
        || requestedMaxPages > PACIFICA_TRADE_HISTORY_MAX_PAGES) {
      throw new Error(`Pacifica trade history maxPages must be an integer from 1 to ${PACIFICA_TRADE_HISTORY_MAX_PAGES}`);
    }
    const queryParams: Record<string, string> = {
      account: agentPublicKey,
      limit: String(requestedLimit),
    };
    if (params?.startTime !== undefined) queryParams.start_time = String(params.startTime);
    if (params?.endTime !== undefined) queryParams.end_time = String(params.endTime);
    if (params?.internalSymbol) {
      queryParams.symbol = this.getRegistry().internalToProtocol(params.internalSymbol).toUpperCase();
    }

    // The documented endpoint returns a cursor envelope. Malformed or failed
    // reads remain unavailable (throw); absence is represented only by a
    // successful empty data array.
    const response: PacificaTradeResponse[] = [];
    const seenHistoryIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let completed = false;
    for (let page = 0; page < requestedMaxPages; page += 1) {
      const envelope = parsePacificaTradeHistoryEnvelope(await this.get(
        '/trades/history',
        cursor ? { ...queryParams, cursor } : queryParams,
        { priority: 'critical', cachePolicy: 'fresh-required', responseShape: 'envelope' },
      ));
      for (const trade of envelope.data) {
        const historyId = String(trade.history_id);
        if (seenHistoryIds.has(historyId)) continue;
        seenHistoryIds.add(historyId);
        response.push(trade);
      }
      if (!envelope.has_more) {
        completed = true;
        break;
      }
      cursor = envelope.next_cursor!;
      if (seenCursors.has(cursor)) throw new Error('Pacifica trade history cursor repeated');
      seenCursors.add(cursor);
    }
    if (!completed) throw new Error(`Pacifica trade history exceeded ${requestedMaxPages} pages`);

    return response.map((t) => ({
      tradeId: String(t.history_id),
      orderId: String(t.order_id),
      clientOrderId: t.client_order_id ?? undefined,
      internalSymbol: this.safeProtocolToInternal(t.symbol),
      side: t.side === 'open_long' || t.side === 'close_short' ? 'long' : 'short',
      price: requirePacificaTradeNumber(t.price, 'price', true),
      size: requirePacificaTradeNumber(t.amount, 'amount', true),
      fee: requirePacificaTradeNumber(t.fee, 'fee'),
      timestamp: t.created_at,
      venueEventKind: t.side,
      realizedPnl: Number(t.pnl),
      liquidityRole: t.event_type === 'fulfill_maker' ? 'maker' : 'taker',
      cause: t.cause,
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
      const requestedLeverage = Math.floor(params.leverage);
      let currentLeverage: number | null = null;
      try {
        currentLeverage = await this.getStrictAccountLeverageForMarket(
          params.agentPublicKey,
          params.internalSymbol,
          params.subaccountId,
        );
      } catch {
        console.warn(
          `[PacificaAdapter] Fresh leverage settings unavailable for ${params.internalSymbol}; `
          + 'preserving signed leverage update gate',
        );
      }

      let shouldSetLeverage = currentLeverage !== requestedLeverage;
      if (currentLeverage !== null && currentLeverage > requestedLeverage) {
        let position: ProtocolPosition | null;
        try {
          position = await this.getStrictPositionForMarket(
            params.agentPublicKey,
            params.internalSymbol,
            params.subaccountId,
          );
        } catch {
          throw new Error(
            `${params.internalSymbol} position state could not be verified before applying lower leverage; `
            + 'no leverage update or order was attempted',
          );
        }

        if (position !== null && !Number.isFinite(position.baseSize)) {
          throw new Error(
            `${params.internalSymbol} position state could not be verified before applying lower leverage; `
            + 'no leverage update or order was attempted',
          );
        }
        if (position !== null && position.baseSize !== 0) {
          throw new Error(
            `${params.internalSymbol} position is already open; requested lower leverage cannot be applied while open; `
            + 'no leverage update or order was attempted',
          );
        }
        shouldSetLeverage = true;
      }

      if (shouldSetLeverage) {
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

    // A retained admission policy is authoritative over both the legacy
    // passthrough and enrollment cache. Enrollment still ran above, but cannot
    // re-attach a builder that the quote explicitly suppressed.
    if (params.builderAttachment?.mode === 'attach') {
      operationData.builder_code = params.builderAttachment.code;
    } else if (params.builderAttachment?.mode === 'suppress') {
      // Intentionally absent.
    } else if (params.builderCode) {
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

    if (isReduceOnly) {
      // Risk-reducing closes retain the existing throw/retry semantics. They
      // must never be stranded behind entry-only ambiguity quarantine.
      const response: PacificaOrderResponse = await this.post('/orders/create_market', body);
      return this.mapOrderResponse(response, params.clientOrderId);
    }

    return this.postRiskIncreasingMarketOrder(
      '/orders/create_market',
      body,
      params.clientOrderId,
    );
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
        success: false,
        status: 'unknown',
        fillSize: 0,
        clientOrderId: params.clientOrderId,
        error: 'close_position_flat_unconfirmed',
      };
    }

    const closeSide: 'long' | 'short' = position.baseSize > 0 ? 'short' : 'long';
    const closeSize = Math.abs(position.baseSize);

    const result = await this.placeMarketOrder({
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
      maxSlippagePct: params.maxSlippagePct,
    });

    if (result.success && result.status === 'filled') return result;
    return {
      ...result,
      success: false,
      error: result.error ?? `Close execution is not terminal (${result.status})`,
    };
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

    // Field layout verified against live Pacifica serde errors (2026-07-08).
    // Top-level: symbol, side, reduce_only (matches placeOrder contract).
    // Nested under stop_order: amount, stop_price.
    // builder_code, client_order_id → also top-level.
    const operationData: Record<string, unknown> = {
      symbol: protocolSymbol,
      side: mapToProtocolSide(params.side),
      reduce_only: params.reduceOnly ?? false,
      stop_order: {
        amount: String(this.quantizeOrderSize(params.internalSymbol, params.sizeBase)),
        stop_price: String(this.quantizePrice(params.internalSymbol, params.triggerPrice)),
      },
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
    let positionSide: 'bid' | 'ask' | null = null;
    try {
      const positions = await this.getPositions(params.agentPublicKey, params.subaccountId);
      const matches = positions.filter(p => p.internalSymbol === params.internalSymbol);
      if (matches.length === 1) {
        const positionSize = matches[0].baseSize;
        if (Number.isFinite(positionSize) && positionSize !== 0) {
          positionSide = positionSize > 0 ? 'bid' : 'ask';
        }
      }
    } catch {
      console.warn(`[SetTpSl] position_side_unavailable for ${params.internalSymbol}: position read failed`);
    }

    if (positionSide === null) {
      console.warn(`[SetTpSl] position_side_unavailable for ${params.internalSymbol}: no unique finite nonzero position`);
      return {
        success: false,
        status: 'rejected',
        error: 'position_side_unavailable',
        appliedTakeProfitPrice: null,
        appliedStopLossPrice: null,
      };
    }

    const enrollment = await this.ensurePacificaEnrollment(params.agentPublicKey, params.agentSecretKey);
    const signer = new PacificaSigner(params.agentSecretKey);
    const protocolSymbol = this.getRegistry().internalToProtocol(params.internalSymbol);

    console.log(`[PacificaAdapter.setTpSl] account=${params.agentPublicKey.slice(0,8)}... symbol=${protocolSymbol} subaccountId=${params.subaccountId ?? 'none'} TP=${params.takeProfitPrice ?? 'none'} SL=${params.stopLossPrice ?? 'none'}`);

    const isLong = positionSide === 'bid';
    const TP_SLIPPAGE = 0.001;
    const closingSide = isLong ? 'ask' : 'bid';

    const tpRequested = params.takeProfitPrice !== undefined && params.takeProfitPrice > 0;
    const slRequested = params.stopLossPrice !== undefined && params.stopLossPrice > 0;

    // Pre-flight: validate trigger prices against current mark when a real position
    // exists and at least one leg was requested. Skips the cancel-only call path
    // (TP=0, SL=0) which is used by /cancel-tpsl to clear existing triggers.
    //
    // Note: callers of setTpSl are the user-facing /set-tpsl and /cancel-tpsl
    // routes plus the AI Trader monitor (G10 bracket re-place and the
    // breakeven-protect move). All of them observe the structured
    // { success: false } / droppedLegs result and apply their own bounded
    // retry or fail-closed handling — no retry loop belongs here.
    let droppedLegMessage: string | null = null;
    const droppedLegs: Array<{ leg: 'tp' | 'sl'; reason: string }> = [];
    let tpInvalid = false;
    let slInvalid = false;
    if (tpRequested || slRequested) {
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

    // The retained admission policy is authoritative for AI Trader's bracket;
    // policy-less manual/recovery callers preserve the legacy enrollment gate.
    if (params.builderAttachment?.mode === 'attach') {
      operationData.builder_code = params.builderAttachment.code;
    } else if (params.builderAttachment?.mode === 'suppress') {
      // Intentionally absent.
    } else if (enrollment.builderApproved && this.config.builderCode) {
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
    if (symbol) {
      // Callers pass either an internal symbol ("SOL-PERP" — executor G10,
      // ai-trader monitor) or an already-converted protocol symbol ("SOL" —
      // verifyStopOrdersExist below). Normalize tolerantly: internal symbols
      // convert, everything else passes through raw. Forwarding an internal
      // symbol raw made Pacifica return an empty list, which the G10 path
      // reads as "bracket missing" — a money-path misread (force-close).
      const registry = this.getRegistry();
      params.symbol = registry.isKnownInternal(symbol) ? registry.internalToProtocol(symbol) : symbol;
    }
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

  async getOpenProtectiveOrders(
    agentPublicKey: string,
    internalSymbol: string,
  ): Promise<import('../adapter').OpenProtectiveOrderSnapshot> {
    const registry = this.getRegistry();
    const protocolSymbol = registry.internalToProtocol(internalSymbol);
    const params: Record<string, string> = { account: agentPublicKey };
    if (!pacificaQuota.canAfford('/orders', 'background')) {
      pacificaQuota.noteRejection();
      throw new QuotaExhaustedError('/orders', pacificaQuota.currentSpend());
    }
    const response = await this.get('/orders', params, {
      priority: 'background',
      cachePolicy: 'fresh-required',
    });
    if (!Array.isArray(response)) {
      throw new Error('Pacifica /orders returned a non-array protective-order response');
    }

    const decimalText = (value: unknown): string | null => {
      if (typeof value !== 'string' || value.trim() === '' || !Number.isFinite(Number(value))) {
        return null;
      }
      return value;
    };

    const orders: import('../adapter').OpenProtectiveOrder[] = [];
    let matchingProtectiveRowCount = 0;
    let incompleteProtectiveRowCount = 0;
    for (const raw of response) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Pacifica /orders returned a malformed order row');
      }
      const row = raw as Record<string, unknown>;
      if (row.symbol !== protocolSymbol) continue;
      const rawType = String(row.order_type ?? '').toLowerCase();
      let orderType: 'stop_loss' | 'take_profit';
      if (rawType === 'stop_loss_limit' || rawType === 'stop_loss_market') {
        orderType = 'stop_loss';
      } else if (rawType === 'take_profit_limit' || rawType === 'take_profit_market') {
        orderType = 'take_profit';
      } else {
        continue;
      }
      matchingProtectiveRowCount += 1;
      const rawSide = String(row.side ?? '').toLowerCase();
      const side = rawSide === 'ask' || rawSide === 'sell'
        ? 'sell'
        : rawSide === 'bid' || rawSide === 'buy'
          ? 'buy'
          : null;
      const orderId = String(row.order_id ?? '').trim();
      const triggerPrice = decimalText(row.stop_price);
      const initialSize = decimalText(row.initial_amount);
      const filledSize = decimalText(row.filled_amount);
      const cancelledSize = decimalText(row.cancelled_amount);
      if (!side || typeof row.reduce_only !== 'boolean' || !orderId
          || triggerPrice === null || initialSize === null
          || filledSize === null || cancelledSize === null) {
        incompleteProtectiveRowCount += 1;
        continue;
      }
      orders.push({
        orderId,
        internalSymbol,
        side,
        orderType,
        triggerPrice,
        reduceOnly: row.reduce_only,
        initialSize,
        filledSize,
        cancelledSize,
      });
    }
    return { orders, matchingProtectiveRowCount, incompleteProtectiveRowCount };
  }

  /**
   * List resting (non-stop) open orders for an account. Recycling Plan §7.2/§8 —
   * used to verify a subaccount holds no working orders before pooling it. A 404
   * (no account / no orders) is treated as an empty list, mirroring getPositions.
   */
  async getOpenOrders(agentPublicKey: string, subaccountId?: string): Promise<Array<{ orderId: string; symbol: string }>> {
    const params: Record<string, string> = { account: agentPublicKey };
    if (subaccountId) params.subaccount_id = subaccountId;
    try {
      const response = await this.get('/orders/open', params);
      if (!Array.isArray(response)) return [];
      return response.map((o: any) => ({
        orderId: String(o.order_id ?? o.id ?? ''),
        symbol: String(o.symbol ?? ''),
      }));
    } catch (err: any) {
      if (err.message && (err.message.includes('404') || err.message.includes('Not Found'))) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Recycling Plan §8 — a subaccount is "empty" (safe to pool/reuse) only when ALL
   * hold: equity at/below the dust threshold, no open positions, no resting orders,
   * no stop/TP-SL orders. We read equity (collateral + uPnL), not just balance, so an
   * account carrying an underwater position can never read as empty. Any read here
   * fails CLOSED — it throws so the caller aborts pooling rather than pooling blind.
   */
  async verifySubaccountEmpty(input: { agentPublicKey: string; subaccountId?: string }): Promise<boolean> {
    const { agentPublicKey, subaccountId } = input;
    const info = await this.getAccountInfo(agentPublicKey, subaccountId);
    // A non-existent account holds nothing — empty by definition.
    if (!info.exists) return true;
    const equity = Number.isFinite(info.equity) ? info.equity : 0;
    if (equity > PACIFICA_RECYCLE_EMPTY_USDC) return false;
    const positions = await this.getPositions(agentPublicKey, subaccountId);
    if (positions.some((p) => Math.abs(p.baseSize) > 0)) return false;
    const openOrders = await this.getOpenOrders(agentPublicKey, subaccountId);
    if (openOrders.length > 0) return false;
    const stopOrders = await this.getOpenStopOrders(agentPublicKey, subaccountId);
    if (stopOrders.length > 0) return false;
    return true;
  }

  /**
   * Reset Agent Wallet safety read. Unlike the normal cached/read-model
   * methods, this path performs a fresh authenticated inventory and never
   * turns transport or malformed-response failures into empty state.
   */
  async assessAgentWalletResetStateStrict(input: {
    agentPublicKey: string;
    agentSecretKey: Uint8Array;
  }): Promise<AgentWalletResetState> {
    const signer = new PacificaSigner(input.agentSecretKey);
    if (signer.getPublicKey() !== input.agentPublicKey) {
      throw new Error('reset signer does not match observed agent key');
    }

    const subaccounts = await this.listSubaccountsWithKey(input.agentSecretKey);
    const ids = new Set<string>();
    for (const sub of subaccounts) {
      if (typeof sub.subaccountId !== 'string' || sub.subaccountId.length === 0) {
        throw new Error('reset subaccount identity malformed');
      }
      if (ids.has(sub.subaccountId)) {
        throw new Error('reset subaccount inventory contains duplicates');
      }
      ids.add(sub.subaccountId);
    }

    const identities: Array<string | undefined> = [undefined, ...ids];
    let hasOpenPositions = false;
    let hasExchangeFunds = false;
    for (const subaccountId of identities) {
      const params: Record<string, string> = { account: input.agentPublicKey };
      if (subaccountId) params.subaccount_id = subaccountId;
      const snapshot = await this.getFreshResetAccountSnapshot(params);
      if (snapshot === null) {
        // A missing main account is a positive clean fact. A child returned by
        // the authenticated inventory but then missing is an incomplete read.
        if (subaccountId) throw new Error('reset subaccount inventory changed during read');
        continue;
      }

      const positionsCount = this.resetNonNegativeInteger(snapshot.positions_count, 'positions_count');
      const ordersCount = this.resetNonNegativeInteger(snapshot.orders_count, 'orders_count');
      const stopOrdersCount = this.resetNonNegativeInteger(snapshot.stop_orders_count, 'stop_orders_count');
      const marginUsed = this.resetFiniteNumber(snapshot.total_margin_used, 'total_margin_used');
      if (positionsCount > 0 || ordersCount > 0 || stopOrdersCount > 0 || Math.abs(marginUsed) > 0.001) {
        hasOpenPositions = true;
      }

      const custodyValues = [
        this.resetFiniteNumber(snapshot.balance, 'balance'),
        this.resetFiniteNumber(snapshot.account_equity, 'account_equity'),
        this.resetFiniteNumber(snapshot.spot_collateral, 'spot_collateral'),
        this.resetFiniteNumber(snapshot.pending_balance, 'pending_balance'),
        this.resetFiniteNumber(snapshot.pending_interest, 'pending_interest'),
      ];
      if (custodyValues.some((value) => Math.abs(value) > 0.01)) {
        hasExchangeFunds = true;
      }
    }

    return { hasOpenPositions, hasExchangeFunds };
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
   * Poll the MAIN Pacifica account until its USDC balance reaches `targetBalance`,
   * or until the timeout elapses. Pacifica's indexer can lag 30–60s after an
   * on-chain deposit OR an internal subaccount→main transfer, so any code that
   * then acts on the post-transfer main balance (create-path funding, delete-path
   * withdraw) MUST wait for the balance to be reflected first — otherwise the
   * follow-up withdraw/transfer reads $0 and 422s ("account value: 0").
   *
   * Pacifica's REST API is rate-limited (~300 credits / 60s). The stepped backoff
   * keeps the fast path (indexed in 5–15s) at ~5 requests and the worst-case 90s
   * wait at ~17 requests instead of 45.
   *
   * Never throws — returns `{ indexed:false }` on timeout so the caller decides
   * whether that is fatal (create path: cannot fund an unconfirmed account) or
   * merely deferred (delete path: funds are safe in main and the withdraw can be
   * retried later).
   */
  async waitForMainAccountBalance(
    agentPublicKey: string,
    targetBalance: number,
    opts?: { timeoutMs?: number; seedBalance?: number },
  ): Promise<{ indexed: boolean; lastBalance: number; elapsedMs: number }> {
    const pollStart = Date.now();
    const pollTimeoutMs = opts?.timeoutMs ?? 90_000;
    let indexed = false;
    let lastBalance = opts?.seedBalance ?? 0;
    while (Date.now() - pollStart < pollTimeoutMs) {
      const elapsedMs = Date.now() - pollStart;
      // 0–15s: every 2s (fast path — most deposits index here)
      // 15–45s: every 5s · 45–90s: every 8s
      const pollIntervalMs = elapsedMs < 15_000 ? 2_000 : elapsedMs < 45_000 ? 5_000 : 8_000;
      await new Promise(r => setTimeout(r, pollIntervalMs));
      const probe = await this.getAccountInfo(agentPublicKey).catch(() => null);
      if (probe?.exists && probe.balance >= targetBalance) {
        indexed = true;
        lastBalance = probe.balance;
        break;
      }
      if (probe) lastBalance = probe.balance;
    }
    return { indexed, lastBalance, elapsedMs: Date.now() - pollStart };
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

      // 3. Wait for Pacifica to index the deposit before creating the subaccount.
      // Funds are always safe — a timeout just means the retry path will see them
      // already credited. The create path treats a timeout as fatal (it cannot
      // proceed to fund a subaccount it hasn't confirmed), so we throw.
      const waitResult = await this.waitForMainAccountBalance(input.agentPublicKey, input.fundingAmount, {
        seedBalance: currentMainBalance,
      });
      if (!waitResult.indexed) {
        throw new Error(
          `provisionFundedSubaccount: Pacifica did not index deposit within 90s. ` +
          `Deposit txSignature=${depositTxSignature || 'unknown'}, lastObservedBalance=$${waitResult.lastBalance}. ` +
          `Your funds are safe and will appear in your main account shortly — ` +
          `simply retry bot creation in a moment and it will use the already-deposited funds.`,
        );
      }
      console.log(`[PacificaAdapter] provisionFundedSubaccount: Pacifica indexed deposit in ${(waitResult.elapsedMs / 1000).toFixed(1)}s, mainBalance=$${waitResult.lastBalance}`);
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

  /**
   * Re-fund an existing (swept-empty, pooled) subaccount for reuse (§8). This is
   * the create-path mirror of `provisionFundedSubaccount` MINUS the createSubaccount
   * step — the subaccount already exists on Pacifica and its retained key is already
   * held by the caller. We only:
   *   1. top the main account up by the deposit gap (if any) and wait for the
   *      indexer to reflect it (§7.1), then
   *   2. transfer `fundingAmount` from main → the existing subaccount.
   * Builder-code + referral enrollment is warmed best-effort (idempotent; a no-op
   * once the main account is already enrolled) and never blocks reuse.
   *
   * Fund-safety: if the transfer fails the subaccount simply stays empty and funds
   * remain in the main account (recoverable via Add Funds) — we return
   * `transferSucceeded:false` with a warning rather than throwing. We NEVER create
   * a new subaccount here, so reuse can never breach the per-agent cap.
   */
  async reuseSubaccount(input: ReuseSubaccountInput): Promise<ReuseSubaccountResult> {
    if (!Number.isFinite(input.fundingAmount) || input.fundingAmount < PACIFICA_MIN_TRANSFER_USDC) {
      throw new Error(
        `reuseSubaccount: fundingAmount must be >= $${PACIFICA_MIN_TRANSFER_USDC} (Pacifica minimum). Got: ${input.fundingAmount}`,
      );
    }
    if (!input.subaccountId) {
      throw new Error('reuseSubaccount: subaccountId is required (reuse never creates a subaccount)');
    }

    // 1. Read current main-account state. The agent main account must already exist
    // (a spare can only have been pooled from a previously-created bot), so a missing
    // main account is a real inconsistency — bail rather than silently re-create.
    const initialInfo = await this.getAccountInfo(input.agentPublicKey);
    if (!initialInfo.exists) {
      throw new Error(
        `reuseSubaccount: main account ${input.agentPublicKey.slice(0, 8)}... not found on Pacifica; cannot reuse subaccount ${input.subaccountId}`,
      );
    }
    const currentMainBalance = initialInfo.balance;

    // 2. Deposit the gap into the main account if it can't cover the funding amount.
    let depositTxSignature: string | undefined;
    const rawGap = input.fundingAmount - currentMainBalance;
    if (rawGap > 0) {
      const depositAmount = Math.max(rawGap, PACIFICA_MIN_TRANSFER_USDC);
      console.log(`[PacificaAdapter] reuseSubaccount: depositing $${depositAmount} (gap=$${rawGap.toFixed(2)}, mainBalance=$${currentMainBalance.toFixed(2)}, fundingAmount=$${input.fundingAmount}, subaccount=${input.subaccountId})`);

      const depositResult = await this.executeDeposit({
        agentPublicKey: input.agentPublicKey,
        agentSecretKey: input.mainSecretKey,
        amount: depositAmount,
      });
      if (!depositResult.success) {
        throw new Error(`reuseSubaccount: deposit failed: ${depositResult.error}`);
      }
      depositTxSignature = depositResult.txSignature;

      // 3. Wait for Pacifica to index the deposit before transferring. A timeout is
      // fatal for the create path (we cannot fund from a balance we haven't confirmed)
      // — funds are safe in main and the retry will see them already credited.
      const waitResult = await this.waitForMainAccountBalance(input.agentPublicKey, input.fundingAmount, {
        seedBalance: currentMainBalance,
      });
      if (!waitResult.indexed) {
        throw new Error(
          `reuseSubaccount: Pacifica did not index deposit within 90s. ` +
          `Deposit txSignature=${depositTxSignature || 'unknown'}, lastObservedBalance=$${waitResult.lastBalance}. ` +
          `Your funds are safe and will appear in your main account shortly — ` +
          `simply retry bot creation in a moment and it will use the already-deposited funds.`,
        );
      }
      console.log(`[PacificaAdapter] reuseSubaccount: Pacifica indexed deposit in ${(waitResult.elapsedMs / 1000).toFixed(1)}s, mainBalance=$${waitResult.lastBalance}`);
    } else {
      console.log(`[PacificaAdapter] reuseSubaccount: skipping deposit (mainBalance=$${currentMainBalance} already covers fundingAmount=$${input.fundingAmount})`);
    }

    // 4. Transfer fundingAmount from main → the existing subaccount. On failure the
    // subaccount stays empty and funds remain in main (recoverable) — never fatal.
    try {
      const transferResult = await this.transferBetweenSubaccounts({
        agentSecretKey: input.mainSecretKey,
        mainWalletAddress: input.agentPublicKey,
        fromSubaccountId: '', // empty = transfer from main account (adapter falls back to signer pubkey)
        toSubaccountId: input.subaccountId,
        amount: input.fundingAmount,
      });
      if (!transferResult.success) {
        return {
          subaccountId: input.subaccountId,
          transferSucceeded: false,
          depositTxSignature,
          warning: `Reused subaccount but transfer failed: ${transferResult.error || 'unknown'}. Funds are safe in your main account — use Add Funds to retry.`,
        };
      }
    } catch (err: any) {
      return {
        subaccountId: input.subaccountId,
        transferSucceeded: false,
        depositTxSignature,
        warning: `Reused subaccount but transfer threw: ${err.message}. Funds are safe in your main account — use Add Funds to retry.`,
      };
    }

    // 5. Warm builder-code + referral enrollment (idempotent; no-op once enrolled).
    // Fail-OPEN: enrollment retries on the first trade, so never block reuse on it.
    try {
      await Promise.allSettled([
        this.approveBuilderCodeForUser({
          agentPublicKey: input.agentPublicKey,
          agentSecretKey: input.mainSecretKey,
        }),
        this.claimReferralCodeForUser({
          agentPublicKey: input.agentPublicKey,
          agentSecretKey: input.mainSecretKey,
        }),
      ]);
    } catch (enrollErr: any) {
      console.warn('[PacificaAdapter] reuseSubaccount: enrollment warm-up failed (non-fatal, retries on next trade):', enrollErr?.message || enrollErr);
    }

    console.log(`[PacificaAdapter] reuseSubaccount: complete. subaccount=${input.subaccountId} funded=$${input.fundingAmount}`);
    return {
      subaccountId: input.subaccountId,
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

    const subaccounts = Array.isArray(response?.subaccounts)
      ? response.subaccounts
      : Array.isArray(response?.data?.subaccounts)
        ? response.data.subaccounts
        : null;
    if (!subaccounts) throw new Error('Pacifica subaccount inventory malformed');
    return subaccounts.map((s: any) => {
      if (!s || typeof s.address !== 'string' || s.address.length === 0) {
        throw new Error('Pacifica subaccount identity malformed');
      }
      const equity = s.balance == null ? 0 : Number(s.balance);
      if (!Number.isFinite(equity)) throw new Error('Pacifica subaccount balance malformed');
      return {
        subaccountId: s.address,
        label: undefined,
        equity,
        status: 'confirmed' as const,
      };
    });
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

      const parsedMaxLev = typeof m.max_leverage === 'number'
        ? m.max_leverage
        : parseFloat(String(m.max_leverage));
      const maxLeverageSource = Number.isFinite(parsedMaxLev) && parsedMaxLev > 0
        ? 'venue' as const
        : 'fallback' as const;
      // Preserve the existing compatibility value for non-admission consumers.
      // Signal Bot admission checks maxLeverageSource and never treats this
      // fallback as venue authority.
      const maxLev = typeof m.max_leverage === 'number' ? m.max_leverage : parsedMaxLev || 1;
      const minOrderUsd = parseFloat(String(m.min_order_size)) || 10;
      const tickSz = parseFloat(String(m.tick_size)) || 0.01;
      const lotSz = parseFloat(String(m.lot_size)) || 0.01;
      const fundRate = m.funding_rate !== undefined ? parseFloat(String(m.funding_rate)) : undefined;

      return {
        internalSymbol,
        protocolSymbol,
        maxLeverage: maxLev,
        maxLeverageSource,
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

  private unconfirmedMarketOrderResult(input: {
    message: string;
    rawResponse?: unknown;
    clientOrderId?: string;
    orderId?: string;
    status?: OrderResult['status'];
    acknowledged?: boolean;
  }): OrderResult {
    return {
      success: input.acknowledged === true,
      orderId: input.orderId,
      clientOrderId: input.clientOrderId,
      status: input.status ?? 'unknown',
      error: `${input.message} ${UNCONFIRMED_LANDING_VERDICT_TOKEN}`,
      rawResponse: input.rawResponse,
      landingDisposition: 'unconfirmed',
    };
  }

  private mapRiskIncreasingMarketOrderResponse(
    value: unknown,
    clientOrderId?: string,
  ): OrderResult {
    const envelope = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : null;
    if (envelope?.success === false) {
      return this.unconfirmedMarketOrderResult({
        message: `Pacifica returned a non-terminal success:false order envelope (${String(envelope.error ?? 'unknown')})`,
        rawResponse: value,
        clientOrderId,
      });
    }

    const raw = envelope && 'data' in envelope && envelope.data && typeof envelope.data === 'object'
      ? envelope.data as Record<string, unknown>
      : envelope;
    if (!raw) {
      return this.unconfirmedMarketOrderResult({
        message: 'Pacifica returned a malformed market-order acknowledgement',
        rawResponse: value,
        clientOrderId,
      });
    }

    const rawStatus = typeof raw.status === 'string' ? raw.status : '';
    const compactAcknowledgement = !rawStatus && ('i' in raw || 'I' in raw);
    const status = compactAcknowledgement ? 'acknowledged' : this.normalizeOrderStatus(rawStatus);
    const rawOrderId = raw.order_id ?? raw.i;
    const rawClientOrderId = raw.client_order_id ?? raw.I;
    const orderId = rawOrderId === undefined || rawOrderId === null ? undefined : String(rawOrderId);
    const resolvedClientOrderId = clientOrderId
      ?? (rawClientOrderId === undefined || rawClientOrderId === null ? undefined : String(rawClientOrderId));
    const response = raw as unknown as PacificaOrderResponse;

    if (status === 'filled') {
      return {
        ...this.mapOrderResponse(response, resolvedClientOrderId),
        success: true,
        orderId,
        clientOrderId: resolvedClientOrderId,
        status,
        rawResponse: value,
        landingDisposition: 'terminal',
      };
    }
    if (status === 'canceled' || status === 'expired' || status === 'rejected') {
      return {
        ...this.mapOrderResponse(response, resolvedClientOrderId),
        success: false,
        orderId,
        clientOrderId: resolvedClientOrderId,
        status,
        error: typeof raw.error === 'string'
          ? raw.error
          : `Pacifica market order reached terminal ${status} status`,
        rawResponse: value,
        landingDisposition: 'terminal',
      };
    }

    const acknowledged = compactAcknowledgement
      || status === 'submitted'
      || status === 'acknowledged'
      || status === 'partial_fill'
      || envelope?.success === true
      || orderId !== undefined;
    return this.unconfirmedMarketOrderResult({
      message: `Pacifica acknowledged the market order without a terminal outcome (status=${status})`,
      rawResponse: value,
      clientOrderId: resolvedClientOrderId,
      orderId,
      status,
      acknowledged,
    });
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
        return 'unknown';
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
   * fetch() bounded by BOTH a soft AbortSignal timeout and a hard
   * Promise.race deadline (2026-07-24 prod incident, second occurrence of
   * this failure mode): Node/undici can wedge in socket states where
   * AbortSignal.timeout NEVER fires, leaving the fetch promise pending
   * forever. The hard deadline abandons the request (any late response is
   * discarded) and rejects, so callers — and the dedup layer above them —
   * are guaranteed to settle.
   */
  private async fetchBounded(
    url: string,
    init: RequestInit,
    softMs: number,
    hardMs: number,
    label: string,
  ): Promise<Response> {
    // Use an explicit AbortController so abort() is driven by a JS-level
    // setTimeout rather than the system-managed AbortSignal.timeout(). In
    // the 2026-07-24 prod incident AbortSignal.timeout never fired on a
    // wedged socket; a plain setTimeout always fires regardless of socket
    // state because it runs entirely in the JS event loop.
    const controller = new AbortController();
    const softTimer = setTimeout(() => controller.abort(), softMs);
    const fetchPromise = fetch(url, { ...init, signal: controller.signal });
    // Suppress: once the hard cap has moved on, we do not want an unhandled
    // rejection if the late fetch eventually settles.
    fetchPromise.catch(() => {});

    let hardTimer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fetchPromise,
        new Promise<never>((_, reject) => {
          hardTimer = setTimeout(() => {
            // Belt-and-suspenders: the soft timer should already have called
            // abort(). If the socket is wedged and the soft abort did not
            // propagate, re-request abort here before rejecting.
            controller.abort();
            const msg =
              `[PacificaAdapter] HARD-TIMEOUT ${label} after ${hardMs}ms — ` +
              `abort signal did not propagate (wedged socket); abort re-requested`;
            console.error(msg);
            appendTelemetry(msg);
            reject(new Error(msg));
          }, hardMs);
          hardTimer.unref?.();
        }),
      ]);
    } finally {
      // Cancel both timers. Do NOT call controller.abort() here on the normal
      // success path — the caller still needs to read the response body;
      // aborting after headers arrive would corrupt the body stream.
      clearTimeout(softTimer);
      if (hardTimer) clearTimeout(hardTimer);
    }
  }

  /**
   * Bound a body read (response.json()/text()) with a hard deadline. The soft
   * AbortSignal normally aborts body reads too, but this incident proved the
   * abort can fail to fire on a wedged socket — and a socket can wedge AFTER
   * headers arrive. get() is backstopped by the cache-layer hard settle cap,
   * but post() does NOT go through dedup, so an unbounded body read there
   * could hang a money-path caller indefinitely.
   */
  private async readBodyBounded<T>(read: Promise<T>, ms: number, label: string): Promise<T> {
    // Abandoned after the deadline — must never surface as an unhandled rejection.
    read.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            const msg =
              `[PacificaAdapter] HARD-TIMEOUT ${label} body read after ${ms}ms ` +
              `(socket wedged after headers); abandoning read`;
            console.error(msg);
            appendTelemetry(msg);
            reject(new Error(msg));
          }, ms);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    options?: {
      priority?: RequestPriority;
      bypassCache?: boolean;
      cachePolicy?: 'default' | 'fresh-required';
      responseShape?: 'data' | 'envelope';
    },
  ): Promise<any> {
    const priority = options?.priority ?? 'normal';
    const freshRequired = options?.cachePolicy === 'fresh-required';
    const bypassCache = options?.bypassCache === true || freshRequired;
    const responseShape = options?.responseShape ?? 'data';
    const cacheKey = pacificaCache.buildKey(path, params)
      + (responseShape === 'envelope' ? ':envelope' : '');
    const dedupKey = freshRequired ? `fresh-required:${cacheKey}` : cacheKey;

    if (!bypassCache) {
      const fresh = pacificaCache.getFresh(cacheKey);
      if (fresh !== undefined) return fresh;
    }
    pacificaCache.noteMiss();

    return pacificaCache.dedup(dedupKey, async () => {
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
        const stale = freshRequired ? undefined : pacificaCache.getStale(cacheKey);
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
        // Node fetch has NO default timeout: one stalled connection here hung
        // forever and wedged every caller awaiting it (incl. the AI Trader
        // monitor tick, freezing ALL bot monitoring until restart). The soft
        // signal also aborts the body read below; the hard cap catches wedged
        // sockets where the abort itself never fires.
        response = await this.fetchBounded(
          url,
          { method: 'GET', headers: { 'Content-Type': 'application/json' } },
          15_000,
          20_000,
          `GET ${path}`,
        );
      } finally {
        // Pacifica meters the request whether it succeeds or fails (including
        // 4xx/5xx), so always record the spend.
        pacificaQuota.record(path);
      }

      if (!response.ok) {
        // Graceful fallback on rate-limit: serve stale cache if any.
        if (response.status === 429 && !freshRequired) {
          const stale = pacificaCache.getStale(cacheKey);
          if (stale) {
            console.warn(
              `[pacifica-quota] upstream 429 on ${path}, serving stale ` +
                `(age=${Math.round(stale.ageMs / 1000)}s)`,
            );
            return stale.data;
          }
        }
        // Bound the error-body read: the soft AbortSignal controls the header
        // phase but may not propagate to the body on a wedged socket.
        const errorBody = await this.readBodyBounded(
          response.text(), 10_000, `GET ${path} error-body`,
        ).catch(() => '');
        throw new Error(
          `PacificaAdapter GET ${path}: ${response.status} ${response.statusText} — ${errorBody}`,
        );
      }

      // Bound the success-body read for the same reason.
      const json = await this.readBodyBounded(response.json(), 10_000, `GET ${path}`);
      const data = responseShape === 'envelope' ? json : this.unwrapEnvelope(json);
      pacificaCache.set(cacheKey, path, data);
      return data;
    });
  }

  /** Fresh, uncached account read reserved for destructive key rotation. */
  private async getFreshResetAccountSnapshot(
    params: Record<string, string>,
  ): Promise<PacificaAccountResponse | null> {
    const searchParams = new URLSearchParams(params);
    const url = `${this.config.baseUrl}/account?${searchParams.toString()}`;
    let response: Response;
    try {
      response = await this.fetchBounded(
        url,
        { method: 'GET', headers: { 'Content-Type': 'application/json' } },
        15_000,
        20_000,
        'GET /account reset-safety',
      );
    } finally {
      pacificaQuota.record('/account');
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Pacifica reset account read failed with HTTP ${response.status}`);
    }
    const json = await this.readBodyBounded(response.json(), 10_000, 'GET /account reset-safety');
    const data = this.unwrapEnvelope(json);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Pacifica reset account response malformed');
    }
    return data as PacificaAccountResponse;
  }

  private resetFiniteNumber(value: unknown, field: string): number {
    if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
      throw new Error(`Pacifica reset ${field} missing`);
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`Pacifica reset ${field} malformed`);
    return parsed;
  }

  private resetNonNegativeInteger(value: unknown, field: string): number {
    const parsed = this.resetFiniteNumber(value, field);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(`Pacifica reset ${field} malformed`);
    }
    return parsed;
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

      // Referral is a MAIN-ACCOUNT-only concern. Pacifica requires the claiming
      // wallet to have itself deposited ("In order to claim a referral code you
      // must deposit" — gitbook docs). In Phase 4b each bot is a SUBACCOUNT
      // funded by an internal transfer from the user's main agent wallet, so it
      // never deposits and Pacifica rejects its claim with 500 "Only main
      // accounts can claim referral codes". Subaccount volume already aggregates
      // under the master account that claimed, so claiming once on the main
      // (kind==='wallet') account covers every bot beneath it. Builder-code
      // approval is unaffected — it is authorized per-subaccount and works on
      // bot keys. So: only attempt the referral claim for main accounts.
      const referralApplicable = kind === 'wallet';

      // Steady-state fast path: builder approved, and referral either already
      // claimed or not applicable (bots) → no work.
      if (row?.pacificaBuilderApproved && (!referralApplicable || row?.pacificaReferralClaimed)) {
        return { builderApproved: true, referralClaimed: !!row?.pacificaReferralClaimed };
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
        if (referralApplicable && !referralClaimed && this.config.referralAddress) {
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
    const maxFeeRate = this.config.builderMaxFeeRate ?? '0.001';

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
    // Pacifica spec (confirmed via gitbook docs + prod 400 error 2026-05-28):
    //   - body top-level field is `code` (NOT `referral_code` — a stale 3rd-
    //     party doc page misled an earlier fix)
    //   - body MUST include explicit `agent_wallet: null` for this endpoint;
    //     unlike approve_builder_code which tolerates the field being absent
    //     (succeeds 3/11 in prod), claim_referral_code uses stricter Rust
    //     serde deserialization that fails when the field is missing.
    // The shared signer.buildRequestBody() helper deletes agent_wallet when
    // null is passed, so we sign + assemble the body manually here to keep
    // the field present.
    const operationData: Record<string, unknown> = { code: refAddress };

    const ok = await this.postWithApprovalRetry(
      '/referral/user/code/claim',
      () => {
        const { signature, timestamp, expiryWindow } = signer.sign(
          OPERATION_TYPES.CLAIM_REFERRAL_CODE,
          operationData,
          5000,
        );
        return {
          account: input.agentPublicKey,
          agent_wallet: null,
          signature,
          timestamp,
          expiry_window: expiryWindow,
          ...operationData,
        };
      },
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
        if (err instanceof PacificaPostOutcomeAmbiguousError) {
          console.error(`${logTag} POST ${path} outcome ambiguous; automatic retry suppressed: ${msg}`);
          return false;
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
    const policy = pacificaPostSettlementPolicy(path, body);
    const ambiguous = (detail: string): PacificaPostOutcomeAmbiguousError => (
      new PacificaPostOutcomeAmbiguousError(path, detail, policy)
    );

    let response: Response;
    try {
      try {
        response = await this.fetchBounded(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          30_000,
          30_000,
          `POST ${path}`,
        );
      } catch (error) {
        if (!policy.mutatesVenue) throw error;
        throw ambiguous(`transport did not prove a terminal outcome: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (!response.ok) {
        let errorBody = '';
        try {
          errorBody = await this.readBodyBounded(response.text(), 10_000, `POST ${path}`);
        } catch (error) {
          if (!policy.mutatesVenue) throw error;
          throw ambiguous(`HTTP ${response.status} response body was unreadable`);
        }
        // A received 4xx response is an explicit client-side rejection, not
        // an unknown landing. In particular, 429 must remain visible to the
        // existing bounded approval retry loop.
        const terminalStatus = response.status >= 400 && response.status < 500;
        if (terminalStatus || !policy.mutatesVenue) {
          throw new Error(
            `PacificaAdapter POST ${path}: ${response.status} ${response.statusText} — ${errorBody}`,
          );
        }
        throw ambiguous(`HTTP ${response.status} did not prove rejection: ${errorBody || response.statusText}`);
      }

      let json: unknown;
      try {
        json = await this.readBodyBounded(response.json(), 10_000, `POST ${path}`);
      } catch (error) {
        if (!policy.mutatesVenue) throw error;
        throw ambiguous(`successful response body was unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
      return this.unwrapEnvelope(json);
    } finally {
      pacificaQuota.record(path);
      if (policy.mutatesVenue) this.invalidateMutationCaches();
    }
  }

  private invalidateMutationCaches(): void {
    pacificaCache.invalidate('/positions');
    pacificaCache.invalidate('/account');
  }

  private async postRiskIncreasingMarketOrder(
    path: string,
    body: unknown,
    clientOrderId?: string,
  ): Promise<OrderResult> {
    const url = `${this.config.baseUrl}${path}`;
    try {
      let response: Response;
      try {
        response = await this.fetchBounded(
          url,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
          30_000,
          30_000,
          `POST ${path}`,
        );
      } catch (error) {
        return this.unconfirmedMarketOrderResult({
          message: `Pacifica market-order transport did not prove a terminal outcome (${error instanceof Error ? error.message : String(error)})`,
          clientOrderId,
        });
      }

      if (!response.ok) {
        const terminalStatus = new Set([400, 401, 403, 404, 405, 422]).has(response.status);
        let detail = '';
        try {
          detail = await this.readBodyBounded(response.text(), 10_000, `POST ${path}`);
        } catch {
          detail = '';
        }
        if (terminalStatus) {
          return {
            success: false,
            clientOrderId,
            status: 'rejected',
            error: `PacificaAdapter POST ${path}: ${response.status} ${response.statusText} — ${detail}`,
            landingDisposition: 'terminal',
          };
        }
        return this.unconfirmedMarketOrderResult({
          message: `Pacifica market-order HTTP ${response.status} did not prove a terminal outcome (${detail || response.statusText})`,
          clientOrderId,
        });
      }

      let json: unknown;
      try {
        json = await this.readBodyBounded(response.json(), 10_000, `POST ${path}`);
      } catch (error) {
        return this.unconfirmedMarketOrderResult({
          message: `Pacifica market-order response body was unreadable (${error instanceof Error ? error.message : String(error)})`,
          clientOrderId,
        });
      }
      return this.mapRiskIncreasingMarketOrderResponse(json, clientOrderId);
    } finally {
      // Pacifica charges every attempted request, regardless of outcome. Any
      // request that may have reached the venue can also have mutated account
      // state, including requests whose response transport failed.
      pacificaQuota.record(path);
      this.invalidateMutationCaches();
    }
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

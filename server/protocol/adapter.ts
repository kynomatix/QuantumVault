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
  TransactionBuildResult,
  BuilderAttachmentPolicy,
} from './protocol-types.js';

export interface CreateSubaccountInput {
  mainSecretKey: Uint8Array;
  subSecretKey?: Uint8Array;
  agentPublicKey: string;
  label?: string;
}

/**
 * Input for re-funding an existing (swept-empty, pooled) subaccount for reuse
 * (Subaccount Recycling Plan §8). Unlike create, the subaccount already exists
 * on the exchange and we already hold its retained signing key — so reuse only
 * tops the subaccount back up from the main account and performs NO create step.
 */
export interface ReuseSubaccountInput {
  mainSecretKey: Uint8Array;
  agentPublicKey: string;
  /** The existing on-chain subaccount id being reused (a verified-empty spare). */
  subaccountId: string;
  fundingAmount: number;
}

/**
 * Result of `reuseSubaccount`. Mirrors the funding-relevant fields of the create
 * path: `transferSucceeded:false` means the subaccount exists but funds remain in
 * the main account (recoverable via Add Funds) — never a fund-loss.
 */
export interface ReuseSubaccountResult {
  subaccountId: string;
  transferSucceeded: boolean;
  depositTxSignature?: string;
  warning?: string;
}

/**
 * Destructive agent-key rotation may proceed only after the venue has produced
 * a fresh, complete account inventory. Implementations MUST throw on transport,
 * authentication, decode, or shape failures; sentinel empty/zero fallbacks are
 * forbidden on this path.
 */
export interface AgentWalletResetState {
  hasOpenPositions: boolean;
  hasExchangeFunds: boolean;
}

/**
 * Fee rates are decimal fractions (0.0004 = four basis points), never
 * percentages or basis-point integers. Admission callers in this unit are
 * taker-only; maker execution remains outside this authority.
 */
export type FeeRateLiquidityRole = 'taker';

export interface FeeRateQuoteRequest {
  /** Root venue account whose authenticated fee tier is being quoted. */
  account: string;
  /** Exact child account used for the order, or null/undefined for main. */
  subaccountId?: string | null;
  liquidityRole: FeeRateLiquidityRole;
  /** A caller-supplied builder that may be attached to this order. */
  builderCode?: string;
}

export interface FeeRateQuoteExpectedIdentity extends FeeRateQuoteRequest {
  protocol: string;
}

export type FeeRateQuoteUnavailableReason =
  | 'capability_unavailable'
  | 'read_failed'
  | 'malformed_quote'
  | 'identity_mismatch'
  | 'stale_quote'
  | 'future_quote'
  | 'ambiguous_builder'
  | 'builder_rate_unknown';

export type FeeRateBuilderState =
  | { status: 'absent' }
  | {
      status: 'included';
      /** Exact builder identifier the order will carry. */
      code: string;
      /** Venue-proven actual builder charge, in decimal-fraction units. */
      rate: number;
      provenance: string;
    };

export interface AvailableFeeRateQuote extends FeeRateQuoteExpectedIdentity {
  availability: 'available';
  /** Venue base charge for the requested liquidity role. */
  baseRate: number;
  /** Exact sum of baseRate and every proven charge the order will carry. */
  effectiveRate: number;
  provenance: string;
  observedAt: number;
  builder: FeeRateBuilderState;
}

export interface UnavailableFeeRateQuote {
  availability: 'unavailable';
  reason: FeeRateQuoteUnavailableReason;
}

export type FeeRateQuoteResult = AvailableFeeRateQuote | UnavailableFeeRateQuote;

export interface OrderFeeRateQuoteRequest extends FeeRateQuoteRequest {
  order: {
    internalSymbol: string;
    side: 'long' | 'short';
    sizeBase: number;
    leverage: number;
    maxSlippagePct: number;
  };
}

export interface OrderFeeRateQuoteExpectedIdentity extends OrderFeeRateQuoteRequest {
  protocol: string;
}

/** Exact integer micro-USD components retained for admission auditability. */
export interface FlashOrderFeeAudit {
  feeUnit: 'micro-usd';
  entryFeeUsd: string;
  volatilityFeeUsd: string;
  swapFeeUsd: string;
  totalFeeUsd: string;
  sizeUsd: string;
  swappedCollateralBaseUnits: string | null;
  pool: string;
  market: string;
  targetCustody: string;
  collateralCustody: string;
  /** Target-custody Pyth publish times in Unix seconds. */
  pricePublishTime: number;
  emaPublishTime: number;
}

export interface AvailableOrderFeeRateQuote extends OrderFeeRateQuoteExpectedIdentity {
  availability: 'available';
  baseRate: number;
  effectiveRate: number;
  provenance: string;
  observedAt: number;
  builder: { status: 'absent' };
  audit: FlashOrderFeeAudit;
}

export type OrderFeeRateQuoteResult = AvailableOrderFeeRateQuote | UnavailableFeeRateQuote;

/** Map only a validated retained quote into the order attachment decision. */
export function builderAttachmentFromFeeQuote(
  quote: AvailableFeeRateQuote | AvailableOrderFeeRateQuote,
): BuilderAttachmentPolicy {
  return quote.builder.status === 'included'
    ? { mode: 'attach', code: quote.builder.code }
    : { mode: 'suppress' };
}

/** The exact admission quote accompanies the open result for estimate reuse. */
export type FeeAuthorizedMarketOrderResult = OrderResult & {
  admissionFeeQuote?: AvailableFeeRateQuote | AvailableOrderFeeRateQuote;
};

export interface FeeRateQuoteValidationOptions {
  /** Injectable only for deterministic validation/tests. Defaults to Date.now(). */
  now?: number;
  /** Defaults to the ten-minute proposal lifetime. */
  maxAgeMs?: number;
}

export const FEE_RATE_QUOTE_MAX_AGE_MS = 10 * 60 * 1000;

const FEE_RATE_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  'capability_unavailable',
  'read_failed',
  'malformed_quote',
  'identity_mismatch',
  'stale_quote',
  'future_quote',
  'ambiguous_builder',
  'builder_rate_unknown',
]);

function unavailableFeeRate(reason: FeeRateQuoteUnavailableReason): UnavailableFeeRateQuote {
  return { availability: 'unavailable', reason };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isFiniteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Pure fail-closed validator for both freshly fetched and decision-retained
 * quotes. It returns a normalized result and never carries a numeric fallback
 * on an unavailable branch.
 */
export function validateFeeRateQuote(
  value: unknown,
  expected: FeeRateQuoteExpectedIdentity,
  options: FeeRateQuoteValidationOptions = {},
): FeeRateQuoteResult {
  if (!value || typeof value !== 'object') {
    return unavailableFeeRate('malformed_quote');
  }

  const candidate = value as Record<string, unknown>;
  if (candidate.availability === 'unavailable') {
    return typeof candidate.reason === 'string' && FEE_RATE_UNAVAILABLE_REASONS.has(candidate.reason)
      ? unavailableFeeRate(candidate.reason as FeeRateQuoteUnavailableReason)
      : unavailableFeeRate('malformed_quote');
  }
  if (candidate.availability !== 'available') {
    return unavailableFeeRate('malformed_quote');
  }

  const expectedSubaccount = expected.subaccountId ?? null;
  if (
    !isNonEmptyString(expected.protocol)
    || !isNonEmptyString(expected.account)
    || expected.liquidityRole !== 'taker'
    || candidate.protocol !== expected.protocol
    || candidate.account !== expected.account
    || candidate.subaccountId !== expectedSubaccount
    || candidate.liquidityRole !== expected.liquidityRole
  ) {
    return unavailableFeeRate('identity_mismatch');
  }

  if (
    !isFiniteNonnegative(candidate.baseRate)
    || !isFiniteNonnegative(candidate.effectiveRate)
    || !isNonEmptyString(candidate.provenance)
    || !isFiniteNonnegative(candidate.observedAt)
  ) {
    return unavailableFeeRate('malformed_quote');
  }

  const builder = candidate.builder;
  let normalizedBuilder: FeeRateBuilderState;
  let expectedEffectiveRate = candidate.baseRate;
  if (!builder || typeof builder !== 'object') {
    return unavailableFeeRate('ambiguous_builder');
  }
  const builderRecord = builder as Record<string, unknown>;
  if (builderRecord.status === 'absent') {
    if ('rate' in builderRecord || 'provenance' in builderRecord) {
      return unavailableFeeRate('ambiguous_builder');
    }
    normalizedBuilder = { status: 'absent' };
  } else if (builderRecord.status === 'included') {
    if (
      !isNonEmptyString(builderRecord.code)
      || !isFiniteNonnegative(builderRecord.rate)
      || !isNonEmptyString(builderRecord.provenance)
      || (isNonEmptyString(expected.builderCode) && builderRecord.code !== expected.builderCode)
    ) {
      return unavailableFeeRate('ambiguous_builder');
    }
    normalizedBuilder = {
      status: 'included',
      code: builderRecord.code,
      rate: builderRecord.rate,
      provenance: builderRecord.provenance,
    };
    expectedEffectiveRate += builderRecord.rate;
  } else {
    return unavailableFeeRate('ambiguous_builder');
  }

  if (isNonEmptyString(expected.builderCode) && normalizedBuilder.status !== 'included') {
    return unavailableFeeRate('ambiguous_builder');
  }

  if (candidate.effectiveRate !== expectedEffectiveRate) {
    return unavailableFeeRate('ambiguous_builder');
  }

  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? FEE_RATE_QUOTE_MAX_AGE_MS;
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return unavailableFeeRate('malformed_quote');
  }
  if (candidate.observedAt > now) {
    return unavailableFeeRate('future_quote');
  }
  if (now - candidate.observedAt > maxAgeMs) {
    return unavailableFeeRate('stale_quote');
  }

  return {
    availability: 'available',
    protocol: expected.protocol,
    account: expected.account,
    subaccountId: expectedSubaccount,
    liquidityRole: expected.liquidityRole,
    baseRate: candidate.baseRate,
    effectiveRate: candidate.effectiveRate,
    provenance: candidate.provenance,
    observedAt: candidate.observedAt,
    builder: normalizedBuilder,
  };
}

function isCanonicalNonnegativeIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);
}

/** Fail-closed validator for a venue/order-specific admission quote. */
export function validateOrderFeeRateQuote(
  value: unknown,
  expected: OrderFeeRateQuoteExpectedIdentity,
  options: FeeRateQuoteValidationOptions = {},
): OrderFeeRateQuoteResult {
  if (!value || typeof value !== 'object') return unavailableFeeRate('malformed_quote');
  const candidate = value as Record<string, unknown>;
  if (candidate.availability === 'unavailable') {
    return typeof candidate.reason === 'string' && FEE_RATE_UNAVAILABLE_REASONS.has(candidate.reason)
      ? unavailableFeeRate(candidate.reason as FeeRateQuoteUnavailableReason)
      : unavailableFeeRate('malformed_quote');
  }
  if (candidate.availability !== 'available') return unavailableFeeRate('malformed_quote');

  const expectedSubaccount = expected.subaccountId ?? null;
  const candidateOrder = candidate.order as Record<string, unknown> | null;
  if (
    !isNonEmptyString(expected.order.internalSymbol)
    || (expected.order.side !== 'long' && expected.order.side !== 'short')
    || !Number.isFinite(expected.order.sizeBase)
    || expected.order.sizeBase <= 0
    || !Number.isFinite(expected.order.leverage)
    || expected.order.leverage <= 0
    || !Number.isFinite(expected.order.maxSlippagePct)
    || expected.order.maxSlippagePct < 0
  ) {
    return unavailableFeeRate('malformed_quote');
  }
  if (
    !isNonEmptyString(expected.protocol)
    || !isNonEmptyString(expected.account)
    || expected.liquidityRole !== 'taker'
    || !candidateOrder
    || candidate.protocol !== expected.protocol
    || candidate.account !== expected.account
    || candidate.subaccountId !== expectedSubaccount
    || candidate.liquidityRole !== expected.liquidityRole
    || candidateOrder.internalSymbol !== expected.order.internalSymbol
    || candidateOrder.side !== expected.order.side
    || candidateOrder.sizeBase !== expected.order.sizeBase
    || candidateOrder.leverage !== expected.order.leverage
    || candidateOrder.maxSlippagePct !== expected.order.maxSlippagePct
  ) {
    return unavailableFeeRate('identity_mismatch');
  }

  if (isNonEmptyString(expected.builderCode)) return unavailableFeeRate('ambiguous_builder');
  const builder = candidate.builder as Record<string, unknown> | null;
  if (!builder || builder.status !== 'absent'
      || 'code' in builder || 'rate' in builder || 'provenance' in builder) {
    return unavailableFeeRate('ambiguous_builder');
  }

  if (
    !isFiniteNonnegative(candidate.baseRate)
    || !isFiniteNonnegative(candidate.effectiveRate)
    || candidate.baseRate !== candidate.effectiveRate
    || !isNonEmptyString(candidate.provenance)
    || !candidate.provenance.startsWith('flash:legacy-contract-helper:fresh-solana+pyth:')
    || !isFiniteNonnegative(candidate.observedAt)
  ) {
    return unavailableFeeRate('malformed_quote');
  }

  const audit = candidate.audit as Record<string, unknown> | null;
  if (
    !audit
    || audit.feeUnit !== 'micro-usd'
    || !isCanonicalNonnegativeIntegerString(audit.entryFeeUsd)
    || !isCanonicalNonnegativeIntegerString(audit.volatilityFeeUsd)
    || !isCanonicalNonnegativeIntegerString(audit.swapFeeUsd)
    || !isCanonicalNonnegativeIntegerString(audit.totalFeeUsd)
    || !isCanonicalNonnegativeIntegerString(audit.sizeUsd)
    || (audit.swappedCollateralBaseUnits !== null
      && !isCanonicalNonnegativeIntegerString(audit.swappedCollateralBaseUnits))
    || (expected.order.side === 'long' && audit.swappedCollateralBaseUnits === null)
    || (expected.order.side === 'short' && audit.swappedCollateralBaseUnits !== null)
    || !isNonEmptyString(audit.pool)
    || !isNonEmptyString(audit.market)
    || !isNonEmptyString(audit.targetCustody)
    || !isNonEmptyString(audit.collateralCustody)
    || !Number.isInteger(audit.pricePublishTime)
    || (audit.pricePublishTime as number) < 0
    || !Number.isInteger(audit.emaPublishTime)
    || (audit.emaPublishTime as number) < 0
  ) {
    return unavailableFeeRate('malformed_quote');
  }
  if (candidate.provenance !== (
    `flash:legacy-contract-helper:fresh-solana+pyth:${audit.pool}:${audit.market}`
  )) {
    return unavailableFeeRate('malformed_quote');
  }

  const entryFeeUsd = BigInt(audit.entryFeeUsd);
  const volatilityFeeUsd = BigInt(audit.volatilityFeeUsd);
  const swapFeeUsd = BigInt(audit.swapFeeUsd);
  const totalFeeUsd = BigInt(audit.totalFeeUsd);
  const sizeUsd = BigInt(audit.sizeUsd);
  if (sizeUsd <= 0n || entryFeeUsd + volatilityFeeUsd + swapFeeUsd !== totalFeeUsd) {
    return unavailableFeeRate('malformed_quote');
  }
  const expectedRate = Number(totalFeeUsd) / Number(sizeUsd);
  if (!Number.isFinite(expectedRate) || candidate.baseRate !== expectedRate) {
    return unavailableFeeRate('malformed_quote');
  }

  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? FEE_RATE_QUOTE_MAX_AGE_MS;
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return unavailableFeeRate('malformed_quote');
  }
  if ((candidate.observedAt as number) > now) return unavailableFeeRate('future_quote');
  if (now - (candidate.observedAt as number) > maxAgeMs) return unavailableFeeRate('stale_quote');

  return {
    availability: 'available',
    protocol: expected.protocol,
    account: expected.account,
    subaccountId: expectedSubaccount,
    liquidityRole: expected.liquidityRole,
    builderCode: expected.builderCode,
    order: { ...expected.order },
    baseRate: candidate.baseRate as number,
    effectiveRate: candidate.effectiveRate as number,
    provenance: candidate.provenance as string,
    observedAt: candidate.observedAt as number,
    builder: { status: 'absent' },
    audit: {
      feeUnit: 'micro-usd',
      entryFeeUsd: audit.entryFeeUsd,
      volatilityFeeUsd: audit.volatilityFeeUsd,
      swapFeeUsd: audit.swapFeeUsd,
      totalFeeUsd: audit.totalFeeUsd,
      sizeUsd: audit.sizeUsd,
      swappedCollateralBaseUnits: audit.swappedCollateralBaseUnits as string | null,
      pool: audit.pool,
      market: audit.market,
      targetCustody: audit.targetCustody,
      collateralCustody: audit.collateralCustody,
      pricePublishTime: audit.pricePublishTime as number,
      emaPublishTime: audit.emaPublishTime as number,
    },
  };
}

export async function resolveOrderFeeRateQuote(
  adapter: ProtocolAdapter,
  input: OrderFeeRateQuoteRequest,
  options: FeeRateQuoteValidationOptions = {},
): Promise<OrderFeeRateQuoteResult> {
  if (typeof adapter.getOrderFeeRateQuote !== 'function') {
    return unavailableFeeRate('capability_unavailable');
  }
  try {
    const value = await adapter.getOrderFeeRateQuote(input);
    return validateOrderFeeRateQuote(value, {
      protocol: adapter.protocolName,
      account: input.account,
      subaccountId: input.subaccountId ?? null,
      liquidityRole: input.liquidityRole,
      builderCode: input.builderCode,
      order: { ...input.order },
    }, options);
  } catch {
    return unavailableFeeRate('read_failed');
  }
}

/**
 * Fresh admission resolver. Missing adapter support, transport failures and
 * malformed responses are all unavailable; none can become an economic value.
 */
export async function resolveFeeRateQuote(
  adapter: ProtocolAdapter,
  input: FeeRateQuoteRequest,
  options: FeeRateQuoteValidationOptions = {},
): Promise<FeeRateQuoteResult> {
  if (typeof adapter.getFeeRateQuote !== 'function') {
    return unavailableFeeRate('capability_unavailable');
  }
  try {
    const value = await adapter.getFeeRateQuote(input);
    return validateFeeRateQuote(value, {
      protocol: adapter.protocolName,
      account: input.account,
      subaccountId: input.subaccountId ?? null,
      liquidityRole: input.liquidityRole,
      builderCode: input.builderCode,
    }, options);
  } catch {
    return unavailableFeeRate('read_failed');
  }
}

/**
 * Shared Signal Bot admission choke point. Existing reduce-only behavior is
 * deliberately untouched; every risk-increasing market order proves fresh fee
 * authority before the adapter can observe the order.
 */
export async function placeMarketOrderWithFeeAuthority(
  adapter: ProtocolAdapter,
  params: MarketOrderParams,
  options: FeeRateQuoteValidationOptions = {},
): Promise<FeeAuthorizedMarketOrderResult> {
  if (params.reduceOnly === true) {
    return adapter.placeMarketOrder(params);
  }

  const identity = {
    account: params.agentPublicKey,
    subaccountId: params.subaccountId ?? null,
    liquidityRole: 'taker' as const,
    builderCode: params.builderCode,
  };
  const quote = typeof adapter.getOrderFeeRateQuote === 'function'
    ? await resolveOrderFeeRateQuote(adapter, {
        ...identity,
        order: {
          internalSymbol: params.internalSymbol,
          side: params.side,
          sizeBase: params.sizeBase,
          leverage: params.leverage ?? 1,
          maxSlippagePct: params.maxSlippagePct ?? 1,
        },
      }, options)
    : await resolveFeeRateQuote(adapter, identity, options);
  if (quote.availability === 'unavailable') {
    return {
      success: false,
      status: 'rejected',
      error: `FEE_RATE_UNAVAILABLE:${quote.reason}`,
    };
  }
  const result = await adapter.placeMarketOrder({
    ...params,
    builderAttachment: builderAttachmentFromFeeQuote(quote),
  });
  return { ...result, admissionFeeQuote: quote };
}

/**
 * Static capability descriptor read by the core recycling orchestrator
 * (Subaccount Recycling Plan §4.1 / §14.2). Adapters that leave this undefined
 * are treated as create-only (today's behavior) — no spare pool, no reuse.
 */
export interface SubaccountCaps {
  /** True when subaccounts cannot be deleted on the exchange side and must be recycled instead (Pacifica). */
  permanent: boolean;
  /**
   * True ONLY when the adapter implements the full sweep-empty → pool → reuse
   * lifecycle (verifySubaccountEmpty + reuseSubaccount). Keep false until those
   * methods exist so the orchestrator never tries to reuse an unimplemented path.
   */
  recyclable: boolean;
  /**
   * Hard cap on accounts per agent wallet. null = no platform-enforced cap.
   * Never hardcode this number in the orchestrator — always read it at runtime.
   */
  maxPerAgent: number | null;
  /**
   * 'subaccount' = child of a master agent wallet (Pacifica, Drift).
   * 'independent_trader' = each bot keypair is its own registered trader (Flash, Phoenix).
   */
  accountModel: 'subaccount' | 'independent_trader';
}

export interface ProtocolAdapter {
  readonly protocolName: string;
  readonly protocolVersion: string;
  readonly collateralMint: string;
  readonly collateralSymbol: string;
  /** Minimum USDC (or collateral) amount for any single transfer or withdrawal on this exchange. */
  readonly minTransferAmount: number;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }>;
  getCapabilities(): AdapterCapabilities;

  getMarkets(): Promise<ProtocolMarket[]>;
  getPrice(internalSymbol: string, opts?: { priority?: 'critical' | 'normal' | 'background' }): Promise<number | null>;
  getAllPrices(): Promise<Record<string, number>>;
  /**
   * DASH-PRICE-FAILFAST-01 — Synchronous cached-price snapshot for display-only
   * enrichment on the dashboard request path.
   *
   * Contract (callers must rely on these):
   *   - Returns only finite positive values; stale values are permitted.
   *   - MUST NOT initiate any async work, network request, or quota operation.
   *   - MUST NOT mutate cache entries, timestamps, or expiry state.
   *   - Returns an ordinary Record, never a Promise.
   *
   * Optional: adapters without a suitable in-memory cache may omit this method.
   * Callers fall back to an empty map and use their own conservative fallbacks.
   */
  getCachedPrices?(internalSymbols: string[]): Record<string, number>;
  /**
   * DASH-PRICE-FAILFAST-02 — Staleness metadata companion to getCachedPrices.
   *
   * Returns the oldest fetchedAt (ms epoch) across requested symbols that had
   * a valid cached entry, or null when none did. MUST NOT mutate cache entries.
   *
   * Optional: adapters that implement getCachedPrices should also implement
   * this. Callers fall back to { oldestFetchedAt: null } when absent.
   */
  getCachedPriceMeta?(internalSymbols: string[]): { oldestFetchedAt: number | null };
  /**
   * In-memory market symbol list. Pure read — no network, no quota.
   * Used by the /api/prices fallback to enumerate cached prices without
   * any upstream work after a consumer deadline fires.
   * Optional: absent on adapters that do not maintain an internal market cache.
   */
  getCachedMarketSymbols?(): string[];
  getOrderbook(internalSymbol: string, depth?: number): Promise<OrderbookSnapshot>;
  getFundingRate(internalSymbol: string): Promise<FundingRateInfo>;
  getMaintenanceMarginWeight(internalSymbol: string): number;
  quantizeOrderSize(internalSymbol: string, size: number): number;
  quantizePrice(internalSymbol: string, price: number): number;

  getAccountInfo(agentPublicKey: string, subaccountId?: string): Promise<AccountInfo>;
  /**
   * Fresh venue authority for risk-increasing admission. Optional adapters are
   * fail-closed by resolveFeeRateQuote; implementers must not serve cached or
   * configured fee constants through this capability.
   */
  getFeeRateQuote?(input: FeeRateQuoteRequest): Promise<FeeRateQuoteResult>;
  /** Fresh, exact quote for adapters whose fee is a function of order inputs. */
  getOrderFeeRateQuote?(input: OrderFeeRateQuoteRequest): Promise<OrderFeeRateQuoteResult>;
  getPositions(agentPublicKey: string, subaccountId?: string): Promise<ProtocolPosition[]>;
  /**
   * Fresh, fail-closed single-market position authority for latency-sensitive
   * money paths. Implementations must return null only after a successful
   * authoritative read proves that the requested market is absent.
   */
  getStrictPositionForMarket?(
    agentPublicKey: string,
    internalSymbol: string,
    subaccountId?: string,
  ): Promise<ProtocolPosition | null>;
  getBalances(agentPublicKey: string, subaccountId?: string): Promise<BalanceInfo>;
  getEquityHistory(agentPublicKey: string, params?: HistoryParams): Promise<EquityPoint[]>;
  getTradeHistory(agentPublicKey: string, params?: HistoryParams): Promise<TradeRecord[]>;

  getBatchAccountInfo(agentPublicKey: string, subaccountIds: string[]): Promise<AccountInfo[]>;
  getBatchPositions(agentPublicKey: string, subaccountIds: string[]): Promise<Map<string, ProtocolPosition[]>>;

  placeMarketOrder(params: MarketOrderParams): Promise<OrderResult>;
  placeLimitOrder(params: LimitOrderParams): Promise<OrderResult>;
  cancelOrder(params: CancelOrderParams): Promise<CancelResult>;
  cancelAllOrders(params: CancelAllOrdersParams): Promise<CancelResult>;

  closePosition(params: ClosePositionParams): Promise<OrderResult>;
  setLeverage(params: SetLeverageParams): Promise<void>;
  setMarginMode(params: SetMarginModeParams): Promise<void>;

  placeStopOrder?(params: StopOrderParams): Promise<OrderResult>;
  setTpSl?(params: TpSlParams): Promise<OrderResult>;
  cancelStopOrder?(params: CancelStopOrderParams): Promise<CancelResult>;
  cancelTpSlOrders?(params: { agentPublicKey: string; agentSecretKey: Uint8Array; mainWalletAddress: string; internalSymbol: string; subaccountId?: string }): Promise<CancelResult>;

  executeDeposit(params: AgentDepositParams): Promise<DepositResult>;
  executeWithdraw(params: AgentWithdrawParams): Promise<WithdrawResult>;
  transferBetweenSubaccounts(params: TransferParams): Promise<TransferResult>;
  /**
   * Fund an independent-trader bot's OWN on-chain wallet directly from the user's
   * agent wallet (agent wallet → bot wallet USDC). For `accountModel ===
   * 'independent_trader'` adapters (Flash) there is no exchange "deposit" + main→
   * subaccount transfer — the bot wallet IS the trader and holds wallet-resident
   * collateral. Fail closed: if the transfer cannot be confirmed, NO funds move
   * (or `ambiguous` is set with the signature for manual verification).
   */
  fundBotWalletCollateral?(input: {
    mainSecretKey: Uint8Array;
    botWalletAddress: string;
    amount: number;
  }): Promise<{ success: boolean; txSignature?: string; ambiguous?: boolean; error?: string }>;

  createSubaccount(input: CreateSubaccountInput): Promise<SubaccountInfo>;
  listSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]>;
  discoverSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]>;
  closeSubaccount?(agentPublicKey: string, subaccountId: string): Promise<void>;
  subaccountExists?(walletAddress: string, subaccountId: string): Promise<boolean>;
  getWalletCollateralBalance?(walletAddress: string): Promise<number>;
  /** Static recycling capability descriptor (§4.1). Undefined ⇒ create-only adapter. */
  readonly subaccountCaps?: SubaccountCaps;
  /** List resting (non-stop) open orders. Used by the recycler to verify a subaccount is empty before pooling (§7.2/§8). */
  getOpenOrders?(agentPublicKey: string, subaccountId?: string): Promise<Array<{ orderId: string; symbol: string }>>;
  /** List open stop / TP-SL orders. Used by the recycler's flatten + verify-empty steps (§7.2/§8). */
  getOpenStopOrders?(agentPublicKey: string, subaccountId?: string, symbol?: string): Promise<Array<{ order_id: string; symbol: string }>>;
  /** True only when the subaccount has no equity above dust, no open positions, and no open/stop orders (§8). */
  verifySubaccountEmpty?(input: { agentPublicKey: string; subaccountId?: string }): Promise<boolean>;
  /**
   * Fresh authenticated venue assessment for Reset Agent Wallet. Optional at
   * the general adapter layer, but reset fails closed when the active adapter
   * does not implement it.
   */
  assessAgentWalletResetStateStrict?(input: {
    agentPublicKey: string;
    agentSecretKey: Uint8Array;
  }): Promise<AgentWalletResetState>;
  /**
   * Re-fund an existing (swept-empty, pooled) subaccount so it can back a new bot
   * (§8). The subaccount already exists and its retained key is already held — this
   * performs NO create step, only the deposit-gap top-up + main→subaccount transfer.
   * Recyclable adapters only (those with `subaccountCaps.recyclable === true`).
   */
  reuseSubaccount?(input: ReuseSubaccountInput): Promise<ReuseSubaccountResult>;
  /**
   * Poll the main account until its collateral balance reaches `targetBalance`,
   * or the timeout elapses. Exists for exchanges (e.g. Pacifica) whose indexer
   * lags after a deposit/internal transfer, so a follow-up withdraw must wait for
   * the balance to be reflected. Returns `indexed:false` on timeout (never throws);
   * adapters without an indexing lag may omit this.
   */
  waitForMainAccountBalance?(
    agentPublicKey: string,
    targetBalance: number,
    opts?: { timeoutMs?: number; seedBalance?: number },
  ): Promise<{ indexed: boolean; lastBalance: number; elapsedMs: number }>;
  getAdapterDiagnostics?(): Promise<Record<string, unknown>>;

  settlePnl(params: SettlePnlParams): Promise<SettleResult>;

  subscribeToFills?(agentPublicKey: string, callback: (fill: FillEvent) => void): Unsubscribe;
  subscribeToPositionUpdates?(agentPublicKey: string, callback: (pos: ProtocolPosition) => void): Unsubscribe;
  subscribeToOrderUpdates?(agentPublicKey: string, callback: (order: OrderUpdate) => void): Unsubscribe;

  prepareBindMessage?(
    userAddress: string,
    agentPublicKey: string,
  ): { message: string; timestamp: number; expiryWindow: number };

  confirmBind?(
    userAddress: string,
    agentPublicKey: string,
    signature: string,
    timestamp: number,
    expiryWindow: number,
  ): Promise<void>;
}

export interface UserTransactionBuilder {
  readonly protocolName: string;
  readonly collateralMint: string;
  readonly collateralSymbol: string;

  buildBindAgentWalletTransaction(
    mainWalletAddress: string,
    agentPublicKey: string,
  ): Promise<TransactionBuildResult>;

  buildDepositTransaction(
    walletAddress: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult>;

  buildWithdrawTransaction(
    walletAddress: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult>;

  buildTransferToSubaccountTransaction(
    walletAddress: string,
    subaccountId: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult>;

  buildTransferFromSubaccountTransaction(
    walletAddress: string,
    subaccountId: string,
    amountUsdc: number,
  ): Promise<TransactionBuildResult>;
}

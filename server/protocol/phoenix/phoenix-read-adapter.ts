import type { PhoenixObservation, PhoenixReadCapabilities, PhoenixMoneyOperation } from '../../../shared/phoenix-read-contract';
import { unknownPhoenixObservation } from '../../../shared/phoenix-read-contract';
import { PHOENIX_PUBLIC_ADDRESSES, PHOENIX_PUBLIC_API, phoenixLotSize, phoenixTickSizeUsd } from './sdk-boundary';
import type { PhoenixPublicTransport } from './transport';
import type { PublicReadAdapter } from '../adapter';

export interface PhoenixPublicMarket {
  internalSymbol: string;
  protocolSymbol: string;
  assetId: number;
  collateral: 'USDC';
  marketStatus: string;
  isActive: boolean;
  tickSizeRaw: string | null;
  baseLotsDecimals: number | null;
  tickSizeUsd: string | null;
  lotSizeBase: string | null;
  minOrderNotionalUsd: null;
  makerFeeRate: number | null;
  takerFeeRate: number | null;
  feeAuthority: 'public_schedule_only';
  isolatedOnly: boolean | null;
  maxLeverage: number | null;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed Phoenix object');
  return value as JsonObject;
}
function address(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}
function fee(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1 ? value : null;
}

export function parsePhoenixMarkets(input: unknown): PhoenixPublicMarket[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 1_000) throw new Error('Malformed Phoenix markets');
  const symbols = new Set<string>();
  const ids = new Set<number>();
  return input.map(value => {
    const row = object(value);
    if (typeof row.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(row.symbol)
      || typeof row.assetId !== 'number' || !Number.isSafeInteger(row.assetId) || row.assetId < 0
      || symbols.has(row.symbol.toUpperCase()) || ids.has(row.assetId)) throw new Error('Malformed Phoenix market identity');
    symbols.add(row.symbol.toUpperCase()); ids.add(row.assetId);
    const tick = typeof row.tickSize === 'string' && /^\d{1,30}$/.test(row.tickSize) && BigInt(row.tickSize) > 0n
      ? row.tickSize : typeof row.tickSize === 'number' && Number.isSafeInteger(row.tickSize) && row.tickSize > 0 ? String(row.tickSize) : null;
    const decimals = typeof row.baseLotsDecimals === 'number' && Number.isInteger(row.baseLotsDecimals)
      && Math.abs(row.baseLotsDecimals) <= 18 ? row.baseLotsDecimals : null;
    const params = tick !== null && decimals !== null ? { tickSize: tick, baseLotsDecimals: decimals } : null;
    const tiers = Array.isArray(row.leverageTiers) ? row.leverageTiers : [];
    const leverages = tiers.map(t => t && typeof t === 'object' ? (t as JsonObject).maxLeverage : null);
    const maxLeverage = leverages.length > 0 && leverages.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 1)
      ? Math.max(...leverages as number[]) : null;
    return {
      internalSymbol: `${row.symbol.toUpperCase()}-PERP`, protocolSymbol: row.symbol, assetId: row.assetId,
      collateral: 'USDC', marketStatus: typeof row.marketStatus === 'string' ? row.marketStatus : 'unknown',
      isActive: row.marketStatus === 'active', tickSizeRaw: tick, baseLotsDecimals: decimals,
      tickSizeUsd: params ? phoenixTickSizeUsd(params) : null,
      lotSizeBase: params ? phoenixLotSize(params) : null, minOrderNotionalUsd: null,
      makerFeeRate: fee(row.makerFee), takerFeeRate: fee(row.takerFee), feeAuthority: 'public_schedule_only',
      isolatedOnly: typeof row.isolatedOnly === 'boolean' ? row.isolatedOnly : null, maxLeverage,
    };
  });
}

const MONEY_OPERATIONS: PhoenixMoneyOperation[] = [
  'register', 'deposit', 'withdraw', 'transfer', 'trade', 'close', 'cancel', 'settle', 'recycle', 'borrow', 'carry', 'park',
];

/** Deliberately does not implement ProtocolAdapter: no fabricated money/price/minimum values. */
export class PhoenixReadAdapter implements PublicReadAdapter<PhoenixObservation<PhoenixPublicMarket[]>, PhoenixReadCapabilities> {
  readonly protocolName = 'phoenix';
  private markets = unknownPhoenixObservation<PhoenixPublicMarket[]>('not_loaded');
  private status = unknownPhoenixObservation<{ active: boolean; gated: boolean; runningState: string }>('not_loaded');
  private availability = unknownPhoenixObservation<boolean>('not_loaded');
  private queue = unknownPhoenixObservation<string>('not_loaded');
  private mids = unknownPhoenixObservation<Record<string, number>>('not_loaded');
  private refreshing: Promise<void> | null = null;
  private nextRefreshAt = 0;
  private closed = false;
  private streamGeneration = 0;

  constructor(
    private readonly transport: PhoenixPublicTransport,
    private readonly now: () => number = Date.now,
    private readonly staleAfterMs = 120_000,
    private readonly refreshIntervalMs = 60_000,
  ) {
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 1_000 || staleAfterMs > 120_000
      || !Number.isFinite(refreshIntervalMs) || refreshIntervalMs < 10_000 || refreshIntervalMs > staleAfterMs) {
      throw new Error('Invalid Phoenix snapshot budget');
    }
  }

  private observed<T>(value: T, path: string): PhoenixObservation<T> {
    return { state: 'fresh', value, observedAt: this.now(), source: PHOENIX_PUBLIC_API + path, reason: null };
  }

  private read<T>(observation: PhoenixObservation<T>): PhoenixObservation<T> {
    const value = structuredClone(observation);
    if (value.state === 'fresh' && (value.observedAt === null || this.now() < value.observedAt
      || this.now() - value.observedAt >= this.staleAfterMs)) {
      value.state = 'stale'; value.reason = 'expired';
    }
    return value;
  }

  private invalidate(reason: string): void {
    for (const observation of [this.markets, this.status, this.availability, this.queue]) {
      observation.state = observation.value === null ? 'unknown' : 'stale';
      observation.reason = reason;
    }
  }

  /**
   * Future SDK stream boundary: no deltas grant authority. A gap/reconnect/update
   * invalidates the snapshot immediately; the next budgeted REST refresh repairs it.
   * No event queue or unbounded retries. Display prices have their own short TTL.
   */
  onPublicStreamInvalidation(event: 'update' | 'gap' | 'disconnect' | 'reconnect'): void {
    this.streamGeneration++;
    this.invalidate('stream_requires_snapshot');
    if (event !== 'update') this.invalidatePrices('stream_requires_snapshot');
  }

  private invalidatePrices(reason: string): void {
    this.mids.state = this.mids.value === null ? 'unknown' : 'stale';
    this.mids.reason = reason;
  }

  onPublicMids(input: unknown): void {
    if (this.closed) return;
    try {
      const entries = Object.entries(object(input));
      if (!entries.length || entries.length > 1_000 || entries.some(([symbol, price]) =>
        !/^[A-Za-z0-9._-]{1,40}$/.test(symbol) || typeof price !== 'number' || !Number.isFinite(price) || price <= 0)) throw new Error('Malformed mids');
      this.mids = { state: 'fresh', value: Object.fromEntries(entries) as Record<string, number>,
        observedAt: this.now(), source: 'wss://perp-api.phoenix.trade/v1/ws#allMids', reason: null };
    } catch {
      this.invalidatePrices('malformed_prices');
      throw new Error('Phoenix public prices unavailable');
    }
  }

  getPrices(): PhoenixObservation<Record<string, number>> {
    const prices = this.read(this.mids);
    if (prices.state === 'fresh' && this.now() - prices.observedAt! >= 15_000) {
      prices.state = 'stale'; prices.reason = 'expired';
    }
    const markets = this.getMarkets();
    if (!markets.value || !prices.value) return unknownPhoenixObservation('prices_or_markets_missing');
    if (markets.state !== 'fresh') { prices.state = 'stale'; prices.reason = 'market_metadata_stale'; }
    prices.value = Object.fromEntries(markets.value.flatMap(m => Object.hasOwn(prices.value!, m.protocolSymbol)
      ? [[m.internalSymbol, prices.value![m.protocolSymbol]]] : []));
    return prices;
  }

  getPrice(symbol: string): PhoenixObservation<number> {
    const prices = this.getPrices();
    const internalSymbol = this.getMarket(symbol).value?.internalSymbol;
    return internalSymbol && prices.value && Object.hasOwn(prices.value, internalSymbol)
      ? { ...prices, value: prices.value[internalSymbol] } : unknownPhoenixObservation('price_missing');
  }

  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Phoenix reader stopped'));
    if (this.refreshing) return this.refreshing;
    if (this.now() < this.nextRefreshAt) return Promise.resolve();
    this.nextRefreshAt = this.now() + this.refreshIntervalMs;
    this.refreshing = this.refreshSnapshot().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshSnapshot(): Promise<void> {
    const generation = this.streamGeneration;
    try {
      const exchange = object(await this.transport.get('/v1/view/exchange'));
      const keys = object(exchange.keys);
      if (keys.canonicalMint !== PHOENIX_PUBLIC_ADDRESSES.collateralMint) throw new Error('Unexpected Phoenix collateral');
      const markets = parsePhoenixMarkets(exchange.markets);
      const status = object(await this.transport.get('/v1/view/exchange/status'));
      if (typeof status.active !== 'boolean' || typeof status.gated !== 'boolean'
        || typeof status.runningState !== 'string') throw new Error('Malformed Phoenix status');
      if (this.closed || generation !== this.streamGeneration) { this.invalidate('snapshot_interrupted'); return; }
      // Atomic snapshot: no mixed old collateral/markets and newly fetched status.
      this.markets = this.observed(markets, '/v1/view/exchange');
      this.status = this.observed({ active: status.active, gated: status.gated, runningState: status.runningState }, '/v1/view/exchange/status');
      this.availability = typeof status.withdrawalsAvailable === 'boolean'
        ? this.observed(status.withdrawalsAvailable, '/v1/view/exchange/status') : unknownPhoenixObservation();
      this.queue = address(keys.withdrawQueue)
        ? this.observed(keys.withdrawQueue, '/v1/view/exchange') : unknownPhoenixObservation();
    } catch {
      this.invalidate('snapshot_failed');
      throw new Error('Phoenix public snapshot unavailable');
    }
  }

  getMarkets(): PhoenixObservation<PhoenixPublicMarket[]> { return this.read(this.markets); }

  getMarket(symbol: string): PhoenixObservation<PhoenixPublicMarket> {
    const snapshot = this.getMarkets();
    const market = snapshot.value?.find(m => m.internalSymbol === symbol || m.protocolSymbol === symbol);
    return market ? { ...snapshot, value: market } : unknownPhoenixObservation('market_missing');
  }

  getCapabilities(): PhoenixReadCapabilities {
    const markets = this.getMarkets();
    const status = this.read(this.status);
    return {
      venue: 'phoenix', mode: 'read-only', enabled: !this.closed,
      publicReads: this.closed ? 'disabled' : markets.state === 'fresh' && status.state === 'fresh' ? 'ready'
        : markets.state === 'stale' || status.state === 'stale' ? 'stale' : 'unknown',
      operations: Object.fromEntries(MONEY_OPERATIONS.map(op => [op, { ready: false, reason: 'not_implemented' }])) as PhoenixReadCapabilities['operations'],
      identity: null,
      custody: {
        walletAuthority: 'separate_from_trader', venueCollateral: 'ember_wrapped_usdc', requiresDeposit: true,
        walletAvailableUsdc: unknownPhoenixObservation('account_reads_unsupported'),
        venueCollateralUsdc: unknownPhoenixObservation('account_reads_unsupported'),
        withdrawableUsdc: unknownPhoenixObservation('account_reads_unsupported'),
        queuedReturnUsdc: unknownPhoenixObservation('account_reads_unsupported'),
      },
      recycling: { supported: false, permanent: 'unknown', maxPerAuthority: null },
      supportsPerBotExternalDebt: false, supportsCarryOnClose: false, exchangeStatus: status,
      withdrawals: {
        availability: this.read(this.availability), queueAccount: this.read(this.queue),
        queueLength: unknownPhoenixObservation(), settlementEndpoint: unknownPhoenixObservation(),
        delay: unknownPhoenixObservation('not_measured_or_published'),
      },
    };
  }

  shutdown(): void { this.closed = true; this.invalidate('reader_stopped'); this.invalidatePrices('reader_stopped'); }
}

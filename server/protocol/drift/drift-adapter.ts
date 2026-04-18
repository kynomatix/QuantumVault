import bs58 from 'bs58';
import { Connection, Keypair } from '@solana/web3.js';

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
  SettlePnlParams,
  SettleResult,
  AdapterCapabilities,
} from '../protocol-types.js';

import { encrypt } from '../../crypto.js';
import { CANONICAL_PERP_MARKETS, PERP_ALIASES } from '../../market-registry.js';
import { getMarketPrice, getAllPrices as getDriftAllPrices } from '../../drift-price.js';
import {
  getDriftBalance,
  getDriftAccountInfo,
  getBatchDriftAccountInfo,
  getPerpPositions,
  getBatchPerpPositions,
  executePerpOrder,
  closePerpPosition,
  executeAgentDriftDeposit,
  executeAgentDriftWithdraw,
  executeAgentTransferBetweenSubaccounts,
  getNextOnChainSubaccountId,
  discoverOnChainSubaccounts,
  closeDriftSubaccount,
  subaccountExists as driftSubaccountExists,
  getUsdcBalance as getDriftWalletCollateralBalance,
  settleAllPnl,
  syncMarketRegistry,
  getSwiftHealthTracker,
  type DriftAccountInfo,
  type PerpPosition,
} from '../../drift-service.js';
import { getActiveRpcUrl } from './drift-rpc-failover.js';

// ============================================================================
// Constants
// ----------------------------------------------------------------------------
// Per the migration plan (Group D item 15 + audit table line 2820), Drift's
// post-recovery relaunch is expected to use USDT as collateral, not USDC. The
// adapter declares the future-state collateral mint here. The underlying
// drift-service.ts code paths still use USDC internally (see USDC_MINT in
// drift-service.ts:293) — that internal swap is intentionally deferred until
// Drift actually relaunches with USDT, since touching execution paths while the
// system is dormant offers no validation. When Drift relaunches, the swap is
// tracked in the audit table at PACIFICA_MIGRATION.md line ~2820 (item 15).
// ============================================================================
export const USDT_MINT_MAINNET = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Returns parsed integer if input is a canonical decimal-digit string
// representing a safe non-negative integer; otherwise null. Rejects whitespace
// (`' '`, `'\t'`), scientific notation (`'1e2'`), hex (`'0x2'`), signs
// (`'+5'`, `'-5'`), decimals (`'5.0'`), and other non-canonical forms that
// `Number()` would silently coerce. Shared by DriftAdapter (strict + tolerant
// parsers) and DriftTxBuilder so all subaccount-id parsing is consistent.
export function tryParseCanonicalSubaccountId(
  subaccountId: string | undefined | null,
): number | null {
  if (subaccountId === undefined || subaccountId === null) return null;
  if (!/^[0-9]+$/.test(subaccountId)) return null;
  const n = Number(subaccountId);
  if (!Number.isSafeInteger(n) || n < 0) return null;
  return n;
}

const DEFAULT_TICK_SIZE = 0.01;
const DEFAULT_LOT_SIZE = 0.01;
const DEFAULT_MAX_LEVERAGE = 20;
const DEFAULT_MIN_ORDER_USD = 10;
const DEFAULT_MAINTENANCE_MARGIN_WEIGHT = 0.05;
const DEFAULT_SLIPPAGE_BPS = 50;

// ============================================================================
// NotSupportedError — thrown for ProtocolAdapter methods that DriftAdapter
// cannot satisfy today. See PACIFICA_MIGRATION.md §Appendix DriftAdapter Build
// Notes, Category C, for the full list and rationale.
// ============================================================================
export class NotSupportedError extends Error {
  constructor(
    public readonly protocol: string,
    public readonly method: string,
    public readonly reason?: string,
  ) {
    super(
      `${protocol}.${method} is not supported${reason ? ` — ${reason}` : ''}`,
    );
    this.name = 'NotSupportedError';
  }
}

// ============================================================================
// DriftAdapter
//
// Wraps the existing drift-service.ts implementation behind ProtocolAdapter.
// NOT registered in adapter-registry.ts by this file — registration is item 17
// (atomic with the four bundled cleanups). Until then this class is purely
// a class declaration; constructing or registering it is not yet wired in.
//
// Three contracts inherited from earlier 12-series work, satisfied below:
//   * 12g/12f: getCapabilities().requiresExternalSubaccountKey === false
//             so routes.ts skips Pacifica's keypair-generation branch and the
//             bot row is created with subaccountAuthMode = 'main_plus_id'.
//   * 12h-A:   createSubaccount() returns SubaccountInfo.subaccountId as a
//              parseable non-negative integer string (Number.isSafeInteger,
//              fits Postgres int max). Bot creation parses + validates.
//   * 12i:     read methods accept subaccountId as a string and parse it
//              internally; never throw on the string shape; treat
//              agentPublicKey as the bot owner's main wallet pubkey (not a
//              sub pubkey — that's a Pacifica-only branch).
// ============================================================================
export class DriftAdapter implements ProtocolAdapter {
  readonly protocolName = 'drift';
  readonly protocolVersion = '2';
  readonly collateralMint = USDT_MINT_MAINNET;
  readonly collateralSymbol = 'USDT';
  readonly minTransferAmount = 0.1;

  private initialized = false;

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await syncMarketRegistry();
    } catch (err) {
      console.warn(
        `[DriftAdapter] syncMarketRegistry failed during initialize: ${
          err instanceof Error ? err.message : String(err)
        }. Continuing with canonical market list.`,
      );
    }
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    // drift-service is stateless from this layer's perspective — the subprocess
    // executor manages its own lifecycle via /tmp/drift_rpc_failover_state.json.
    this.initialized = false;
  }

  async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const connection = new Connection(getActiveRpcUrl(), 'confirmed');
      await connection.getSlot();
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
      supportsStopOrders: false,
      supportsTpSl: false,
      supportsBatchOrders: false,
      supportsIsolatedMargin: false,
      supportsWebSocket: false,
      supportsSettlePnl: true,
      // Currently false because closeSubaccount() throws NotSupportedError —
      // the ProtocolAdapter signature does not pass an agent secret key, but
      // drift-service.closeDriftSubaccount requires an encrypted private key
      // to sign the on-chain close. Flip back to true once the interface
      // grows a key parameter (or we wrap with a key lookup helper).
      supportsCloseSubaccount: false,
      maxSubaccounts: 8,
      settlementType: 'on-chain',
      // 12g/12f contract — Drift derives subaccount keys from the main key,
      // routes.ts must NOT generate a fresh sub keypair for Drift bots.
      requiresExternalSubaccountKey: false,
    };
  }

  // ------------------------------------------------------------------
  // Markets / prices
  // ------------------------------------------------------------------

  async getMarkets(): Promise<ProtocolMarket[]> {
    // Drift's per-market metadata (tick/lot/maxLev) lives in the SDK perp
    // market accounts. We don't have an in-process fetcher today; fall back to
    // sensible defaults. When Drift relaunches and we wire up SDK metadata
    // reads, swap these defaults for live values.
    const markets: ProtocolMarket[] = Object.entries(CANONICAL_PERP_MARKETS).map(
      ([_idx, symbol]) => ({
        internalSymbol: symbol,
        protocolSymbol: symbol,
        maxLeverage: DEFAULT_MAX_LEVERAGE,
        minOrderSizeUsd: DEFAULT_MIN_ORDER_USD,
        minOrderSizeBase: DEFAULT_LOT_SIZE,
        tickSize: DEFAULT_TICK_SIZE,
        lotSize: DEFAULT_LOT_SIZE,
        isActive: true,
        category: ['perp'],
        fullName: symbol.replace(/-PERP$/, ''),
        maintenanceMarginWeight: DEFAULT_MAINTENANCE_MARGIN_WEIGHT,
        riskTier: 'recommended',
        estimatedSlippagePct: 0.05,
      }),
    );
    return markets;
  }

  async getPrice(internalSymbol: string): Promise<number | null> {
    return getMarketPrice(internalSymbol);
  }

  async getAllPrices(): Promise<Record<string, number>> {
    return getDriftAllPrices();
  }

  getMaintenanceMarginWeight(_internalSymbol: string): number {
    return DEFAULT_MAINTENANCE_MARGIN_WEIGHT;
  }

  quantizeOrderSize(_internalSymbol: string, size: number): number {
    if (!Number.isFinite(size) || size <= 0) {
      throw new Error(`DriftAdapter: invalid order size ${size}`);
    }
    const rounded = Math.floor(size / DEFAULT_LOT_SIZE) * DEFAULT_LOT_SIZE;
    return parseFloat(rounded.toFixed(2));
  }

  quantizePrice(_internalSymbol: string, price: number): number {
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`DriftAdapter: invalid price ${price}`);
    }
    const rounded = Math.round(price / DEFAULT_TICK_SIZE) * DEFAULT_TICK_SIZE;
    return parseFloat(rounded.toFixed(2));
  }

  // ------------------------------------------------------------------
  // Account / position / balance reads (string subaccountId → number)
  // ------------------------------------------------------------------

  async getAccountInfo(agentPublicKey: string, subaccountId?: string): Promise<AccountInfo> {
    const numericId = this.parseSubaccountIdForRead(subaccountId);
    const driftInfo = await getDriftAccountInfo(agentPublicKey, numericId);
    return this.mapAccountInfo(driftInfo, subaccountId, numericId);
  }

  async getPositions(agentPublicKey: string, subaccountId?: string): Promise<ProtocolPosition[]> {
    const numericId = this.parseSubaccountIdForRead(subaccountId);
    const positions = await getPerpPositions(agentPublicKey, numericId);
    return positions.map((p) => this.mapPosition(p, subaccountId));
  }

  async getBalances(agentPublicKey: string, subaccountId?: string): Promise<BalanceInfo> {
    const numericId = this.parseSubaccountIdForRead(subaccountId);
    const driftInfo = await getDriftAccountInfo(agentPublicKey, numericId);
    // NOTE: drift-service computes totalCollateral as usdcBalance +
    // totalUnrealizedPnl already (drift-service.ts:1538), so totalCollateral
    // IS the equity. Do not add unrealizedPnl on top — that double-counts.
    return {
      totalEquity: driftInfo.totalCollateral,
      freeCollateral: driftInfo.freeCollateral,
      totalMarginUsed: driftInfo.marginUsed,
      unrealizedPnl: driftInfo.unrealizedPnl,
    };
  }

  async getBatchAccountInfo(
    agentPublicKey: string,
    subaccountIds: string[],
  ): Promise<AccountInfo[]> {
    const numericIds = subaccountIds.map((id) => this.parseSubaccountIdForRead(id));
    const driftMap = await getBatchDriftAccountInfo(agentPublicKey, numericIds);
    const emptyInfo: DriftAccountInfo = {
      usdcBalance: 0,
      totalCollateral: 0,
      freeCollateral: 0,
      hasOpenPositions: false,
      marginUsed: 0,
      unrealizedPnl: 0,
      totalPositionNotional: 0,
    };
    return numericIds.map((numericId, i) => {
      const info = driftMap.get(numericId) ?? emptyInfo;
      return this.mapAccountInfo(info, subaccountIds[i], numericId);
    });
  }

  async getBatchPositions(
    agentPublicKey: string,
    subaccountIds: string[],
  ): Promise<Map<string, ProtocolPosition[]>> {
    const numericIds = subaccountIds.map((id) => this.parseSubaccountIdForRead(id));
    const numericMap = await getBatchPerpPositions(agentPublicKey, numericIds);
    const result = new Map<string, ProtocolPosition[]>();
    subaccountIds.forEach((stringId, i) => {
      const numericId = numericIds[i];
      // getBatchPerpPositions may key by number or string depending on impl;
      // probe both shapes to be defensive.
      const positions =
        (numericMap as unknown as Map<unknown, PerpPosition[]>).get(numericId) ||
        (numericMap as unknown as Map<unknown, PerpPosition[]>).get(stringId) ||
        [];
      result.set(stringId, positions.map((p) => this.mapPosition(p, stringId)));
    });
    return result;
  }

  // ------------------------------------------------------------------
  // Orders — most are NotSupported (Category C in the appendix)
  // ------------------------------------------------------------------

  async placeMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    const numericSubId = this.parseSubaccountId(params.subaccountId);
    const slippageBps = params.maxSlippagePct
      ? Math.round(params.maxSlippagePct * 100)
      : DEFAULT_SLIPPAGE_BPS;
    const privateKeyBase58 = bs58.encode(params.agentSecretKey);
    const encryptedPrivateKey = encrypt(privateKeyBase58);

    const result = await executePerpOrder(
      encryptedPrivateKey,
      params.internalSymbol,
      params.side,
      params.sizeBase,
      numericSubId,
      params.reduceOnly ?? false,
      slippageBps,
      privateKeyBase58,
      params.agentPublicKey,
    );

    return {
      success: result.success,
      orderId: result.signature || result.txSignature,
      clientOrderId: params.clientOrderId,
      status: result.success ? 'filled' : 'rejected',
      fillPrice: result.fillPrice,
      fee: result.actualFee,
      error: result.error,
      rawResponse: result,
    };
  }

  async placeLimitOrder(_params: LimitOrderParams): Promise<OrderResult> {
    throw new NotSupportedError(
      'drift',
      'placeLimitOrder',
      'drift-service exposes only market orders via executePerpOrder; add when Drift relaunches with verified Limit support.',
    );
  }

  async cancelOrder(_params: CancelOrderParams): Promise<CancelResult> {
    throw new NotSupportedError('drift', 'cancelOrder');
  }

  async cancelAllOrders(_params: CancelAllOrdersParams): Promise<CancelResult> {
    throw new NotSupportedError('drift', 'cancelAllOrders');
  }

  async closePosition(params: ClosePositionParams): Promise<OrderResult> {
    const numericSubId = this.parseSubaccountId(params.subaccountId);
    const privateKeyBase58 = bs58.encode(params.agentSecretKey);
    const encryptedPrivateKey = encrypt(privateKeyBase58);

    const result = await closePerpPosition(
      encryptedPrivateKey,
      params.internalSymbol,
      numericSubId,
      undefined,
      DEFAULT_SLIPPAGE_BPS,
      privateKeyBase58,
      params.agentPublicKey,
    );

    return {
      success: result.success,
      orderId: result.signature,
      clientOrderId: params.clientOrderId,
      status: result.success ? 'filled' : 'rejected',
      fillPrice: result.fillPrice,
      error: result.error,
      rawResponse: result,
    };
  }

  async setLeverage(_params: SetLeverageParams): Promise<void> {
    throw new NotSupportedError(
      'drift',
      'setLeverage',
      'Drift sets leverage per-order in executePerpOrder, not per-subaccount.',
    );
  }

  async setMarginMode(_params: SetMarginModeParams): Promise<void> {
    throw new NotSupportedError(
      'drift',
      'setMarginMode',
      'Drift uses a single cross-margin model per subaccount; mode is fixed.',
    );
  }

  // ------------------------------------------------------------------
  // Deposits / withdrawals / transfers
  //
  // The adapter interface passes agentSecretKey as Uint8Array; drift-service
  // accepts an encrypted base58 string. We bridge by base58-encoding the raw
  // bytes and re-encrypting with the server's encryption key. Round-trip cost
  // is negligible for a code path that ultimately hits a subprocess.
  // ------------------------------------------------------------------

  async executeDeposit(params: AgentDepositParams): Promise<DepositResult> {
    const numericSubId = this.parseSubaccountId(params.subaccountId);
    const privateKeyBase58 = bs58.encode(params.agentSecretKey);

    const result = await executeAgentDriftDeposit(
      params.agentPublicKey,
      privateKeyBase58,
      params.amount,
      numericSubId,
      true, // isPreDecrypted — privateKeyBase58 is the raw key, not ciphertext
    );

    return {
      success: result.success,
      txSignature: result.signature,
      error: result.error,
    };
  }

  async executeWithdraw(params: AgentWithdrawParams): Promise<WithdrawResult> {
    const numericSubId = this.parseSubaccountId(params.subaccountId);
    const encryptedPrivateKey = encrypt(bs58.encode(params.agentSecretKey));

    const result = await executeAgentDriftWithdraw(
      params.agentPublicKey,
      encryptedPrivateKey,
      params.amount,
      numericSubId,
    );

    return {
      success: result.success,
      txSignature: result.signature,
      error: result.error,
    };
  }

  async transferBetweenSubaccounts(params: TransferParams): Promise<TransferResult> {
    const fromSubId = this.parseSubaccountId(params.fromSubaccountId);
    const toSubId = this.parseSubaccountId(params.toSubaccountId);
    const encryptedPrivateKey = encrypt(bs58.encode(params.agentSecretKey));

    // Group D item 17a: TransferParams.agentPublicKey was dropped because it
    // was never read by Pacifica and the routes.ts call sites passed the bot
    // sub pubkey rather than the agent main pubkey — wrong for Drift. Derive
    // the agent pubkey directly from the agent secret key (the canonical
    // source for any agent-signed write). This is the only signer involved.
    const agentPublicKey = Keypair.fromSecretKey(params.agentSecretKey).publicKey.toString();

    const result = await executeAgentTransferBetweenSubaccounts(
      agentPublicKey,
      encryptedPrivateKey,
      fromSubId,
      toSubId,
      params.amount,
    );

    return {
      success: result.success,
      error: result.error,
    };
  }

  // ------------------------------------------------------------------
  // Subaccounts
  // ------------------------------------------------------------------

  async createSubaccount(input: CreateSubaccountInput): Promise<SubaccountInfo> {
    // Drift derives sub keys from main key, so input.subSecretKey is unused.
    // Subaccount lifecycle: routes.ts allocates the next ID via this method;
    // the on-chain User account is then created lazily on first deposit
    // (executeAgentDriftDeposit handles initialization). We return 'requested'
    // status to reflect that on-chain init has not yet happened.
    const numericId = await getNextOnChainSubaccountId(input.agentPublicKey);

    // 12h-A contract: subaccountId must be a parseable non-negative integer
    // string that satisfies Number.isSafeInteger AND fits Postgres int max.
    if (!Number.isSafeInteger(numericId) || numericId < 0 || numericId > 2147483647) {
      throw new Error(
        `DriftAdapter.createSubaccount: getNextOnChainSubaccountId returned ${numericId}, ` +
          `which violates the Postgres int contract (must be a safe non-negative integer ≤ 2147483647).`,
      );
    }

    return {
      subaccountId: String(numericId),
      label: input.label,
      equity: 0,
      status: 'requested',
    };
  }

  async listSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]> {
    const ids = await discoverOnChainSubaccounts(agentPublicKey);
    return ids.map((id) => ({
      subaccountId: String(id),
      equity: 0,
      status: 'confirmed' as const,
    }));
  }

  async discoverSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]> {
    return this.listSubaccounts(agentPublicKey);
  }

  async closeSubaccount(_agentPublicKey: string, _subaccountId: string): Promise<void> {
    // The ProtocolAdapter signature does not pass an agent secret key, but
    // drift-service's closeDriftSubaccount requires it (the close is an
    // on-chain transaction signed by the agent wallet). Until the interface
    // grows a secret-key parameter (or routes.ts wraps this with a key
    // lookup), this method cannot perform the close. Throwing is honest.
    throw new NotSupportedError(
      'drift',
      'closeSubaccount',
      'requires agent secret key, which the ProtocolAdapter signature does not currently pass; route.ts must call drift-service.closeDriftSubaccount directly until the interface grows a key parameter.',
    );
  }

  async subaccountExists(walletAddress: string, subaccountId: string): Promise<boolean> {
    return driftSubaccountExists(walletAddress, this.parseSubaccountId(subaccountId));
  }

  async getWalletCollateralBalance(walletAddress: string): Promise<number> {
    // NOTE: drift-service's getUsdcBalance currently reads the USDC ATA. When
    // Drift relaunches with USDT, that underlying function must be updated to
    // accept a mint parameter (tracked in PACIFICA_MIGRATION.md item 15).
    // The adapter surface (this method) is collateral-neutral.
    return getDriftWalletCollateralBalance(walletAddress);
  }

  // ------------------------------------------------------------------
  // Settle PnL
  // ------------------------------------------------------------------

  async settlePnl(params: SettlePnlParams): Promise<SettleResult> {
    const numericSubId = this.parseSubaccountId(params.subaccountId);
    const encryptedPrivateKey = encrypt(bs58.encode(params.agentSecretKey));

    const result = await settleAllPnl(encryptedPrivateKey, numericSubId);

    return {
      success: result.success,
      error: result.error,
    };
  }

  // ------------------------------------------------------------------
  // Unsupported reads (Category C)
  // ------------------------------------------------------------------

  async getOrderbook(_internalSymbol: string, _depth?: number): Promise<OrderbookSnapshot> {
    throw new NotSupportedError(
      'drift',
      'getOrderbook',
      'Drift uses vAMM + DLOB; not a flat orderbook. Could synthesize from getDLOBSnapshot later.',
    );
  }

  async getFundingRate(_internalSymbol: string): Promise<FundingRateInfo> {
    throw new NotSupportedError('drift', 'getFundingRate');
  }

  async getEquityHistory(_agentPublicKey: string, _params?: HistoryParams): Promise<EquityPoint[]> {
    throw new NotSupportedError(
      'drift',
      'getEquityHistory',
      'drift-data-api does not expose equity timeseries; would need direct Drift Data API queries.',
    );
  }

  async getTradeHistory(_agentPublicKey: string, _params?: HistoryParams): Promise<TradeRecord[]> {
    throw new NotSupportedError('drift', 'getTradeHistory');
  }

  // ------------------------------------------------------------------
  // Diagnostics
  // ------------------------------------------------------------------

  async getAdapterDiagnostics(): Promise<Record<string, unknown>> {
    return {
      activeRpcUrl: getActiveRpcUrl(),
      swiftHealth: getSwiftHealthTracker().getSnapshot(),
      canonicalMarketCount: Object.keys(CANONICAL_PERP_MARKETS).length,
      perpAliasCount: Object.keys(PERP_ALIASES).length,
    };
  }

  // ------------------------------------------------------------------
  // Private helpers
  // ------------------------------------------------------------------

  // Strict parser for write paths (orders, deposits, transfers, settle).
  // We DO want to throw rather than silently route a write to subaccount 0
  // when the caller passed garbage — that would cause real loss.
  // Empty/undefined is allowed and means "default to 0" (callers without a
  // subaccountId field, e.g. legacy single-account flows).
  private parseSubaccountId(subaccountId?: string): number {
    if (subaccountId === undefined || subaccountId === null || subaccountId === '') {
      return 0;
    }
    const parsed = tryParseCanonicalSubaccountId(subaccountId);
    if (parsed === null) {
      throw new Error(
        `DriftAdapter: invalid subaccountId "${subaccountId}" — must be a canonical non-negative integer string (decimal digits only, no whitespace, no scientific/hex notation)`,
      );
    }
    return parsed;
  }

  // 12i contract: read methods (getAccountInfo / getPositions / getBalances /
  // Batch*) MUST NOT throw on the string shape. The snapshot, reconciliation,
  // and portfolio jobs call these in fan-out loops and a single bad row should
  // not bring down a batch. We log loudly and fall back to subaccount 0 for
  // unparseable input — the caller will see "exists: false" and skip cleanly.
  private parseSubaccountIdForRead(subaccountId?: string): number {
    if (subaccountId === undefined || subaccountId === null || subaccountId === '') {
      return 0;
    }
    const parsed = tryParseCanonicalSubaccountId(subaccountId);
    if (parsed === null) {
      console.warn(
        `[DriftAdapter] parseSubaccountIdForRead: unparseable subaccountId "${subaccountId}" ` +
          `received in a read method; defaulting to 0 to keep the batch alive (12i contract). ` +
          `This usually indicates upstream data corruption — investigate the caller.`,
      );
      return 0;
    }
    return parsed;
  }

  private mapAccountInfo(
    drift: DriftAccountInfo,
    originalSubId: string | undefined,
    numericSubId: number,
  ): AccountInfo {
    // drift-service computes totalCollateral as usdcBalance + totalUnrealizedPnl
    // (drift-service.ts:1538), so totalCollateral IS the equity. Adding
    // unrealizedPnl on top would double-count.
    const equity = drift.totalCollateral;
    const exists =
      drift.totalCollateral > 0 ||
      drift.usdcBalance > 0 ||
      drift.hasOpenPositions ||
      drift.marginUsed > 0;
    return {
      equity,
      balance: drift.usdcBalance,
      unrealizedPnl: drift.unrealizedPnl,
      availableMargin: drift.freeCollateral,
      maintenanceMargin: drift.marginUsed,
      feeTier: undefined,
      subaccountId: originalSubId ?? String(numericSubId),
      exists,
    };
  }

  private mapPosition(p: PerpPosition, subaccountId?: string): ProtocolPosition {
    const sideLong = p.side === 'LONG';
    return {
      internalSymbol: p.market,
      baseSize: sideLong ? Math.abs(p.baseAssetAmount) : -Math.abs(p.baseAssetAmount),
      entryPrice: p.entryPrice,
      markPrice: p.markPrice,
      unrealizedPnl: p.unrealizedPnl,
      leverage: 0, // Drift sets leverage per-order, not stored on position
      liquidationPrice: null,
      marginMode: 'cross',
      subaccountId,
    };
  }
}

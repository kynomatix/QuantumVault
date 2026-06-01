/**
 * Flash Trade protocol adapter — Phase 2 (Adapter Core).
 *
 * Phase 1 (foundation): lifecycle, capabilities, getMarkets, Pyth Hermes prices,
 * margin-weight / quantize helpers.
 *
 * Phase 2 (this file) — ON-CHAIN via flash-sdk `PerpetualsClient`:
 *   ✅ Reads:   getPositions / getAccountInfo / getBalances / batch variants,
 *               getOrderbook (synthetic oracle±slippage), getFundingRate (see note).
 *   ✅ Trades:  placeMarketOrder (open via openPosition[short]/swapAndOpen[long];
 *               reduceOnly via decreaseSize), closePosition (closePosition[short]/
 *               closeAndSwap[long]), placeStopOrder / setTpSl / cancelTpSlOrders /
 *               cancelAllOrders via the SDK trigger-order surface.
 *   ✅ Capital: executeWithdraw (real SPL USDC transfer bot→main), executeDeposit
 *               (honest no-op — see below), subaccount methods mapped to the bot
 *               wallet (independent_trader model), settlePnl (auto-settled).
 *
 * Account model: independent_trader — each bot keypair IS the on-chain position
 * owner. There are NO Pacifica-style subaccounts; the bot wallet address is the
 * "subaccount id" stored in the DB, so subaccount methods resolve to that wallet.
 *
 * Collateral: shorts use USDC collateral (openPosition). Longs use the target
 * asset as collateral, so we open longs via swapAndOpen (USDC→asset) and close
 * them via closeAndSwap (asset→USDC) — the bot only ever holds USDC.
 *
 * Deposit: Flash has NO trader collateral-deposit instruction. USDC is wallet-
 * resident and is committed atomically inside openPosition/swapAndOpen at trade
 * time. executeDeposit is therefore an honest no-op (it does not fabricate a tx);
 * funding a bot means transferring USDC into its wallet ATA on-chain.
 *
 * Referral / builder attribution: Flash has no string builder code (that is a
 * Pacifica concept). Attribution is on-chain: every FEE-BEARING trade ix
 * (open/close/increase/decrease) carries `privilege: Referral` plus the partner
 * tokenStakeAccount PDA and the trader userReferralAccount PDA via
 * getReferralAccounts(). The 10% rebate accrues to FLASH_BUILDER_WALLET. Trigger
 * placement/cancel ix are not fee events and take no privilege param.
 *
 * MagicBlock seams (§4.5, deferred to Flash V2): transaction signing is isolated
 * behind FlashTransactionSigner (flash-signer.ts), account streaming behind
 * FlashAccountStreamTransport (flash-ws.ts). This adapter only depends on those
 * interfaces, so the session-key / ER-gRPC implementations can drop in later
 * without touching call sites.
 *
 * Fail-closed: validation problems return a structured `{ success:false }`
 * result (explicit failure — never a silent success), and genuine exceptions are
 * caught into the same shape. Read helpers that legitimately have "no data"
 * (missing ATA, no indexer) return zero/empty, which is truthful, not a money
 * fallback.
 */

import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  type TransactionInstruction,
  type Signer,
} from '@solana/web3.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import BN from 'bn.js';
import {
  getAssociatedTokenAddressSync,
  getAccount,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { PerpetualsClient, PoolConfig, OraclePrice } from 'flash-sdk';
import type { ContractOraclePrice, Side, Privilege } from 'flash-sdk';

import type {
  ProtocolAdapter,
  CreateSubaccountInput,
  SubaccountCaps,
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
  SettlePnlParams,
  SettleResult,
  AdapterCapabilities,
} from '../protocol-types.js';

import {
  FLASH_PROGRAM_ID,
  FLASH_COMPOSABILITY_PROGRAM_ID,
  FLASH_FB_NFT_REWARD_PROGRAM_ID,
  FLASH_REWARD_DISTRIBUTION_PROGRAM_ID,
  FLASH_PYTH_PRICE_IDS,
  FLASH_USDC_MINT,
  FLASH_MIN_TRANSFER_USDC,
  type FlashMarketSpec,
} from './flash-constants.js';
import { getFlashMarketSpecs } from './flash-markets.js';
import type { PythHermesResponse } from './flash-types.js';
import {
  getCachedMarkets,
  setCachedMarkets,
  getCachedPrice,
  setCachedPrice,
  invalidateAllCaches,
} from './flash-cache.js';
import { FlashKeypairSigner, createReadOnlyWallet, type FlashTransactionSigner } from './flash-signer.js';
import {
  getReferralAccounts,
  FLASH_SIDE_LONG,
  FLASH_SIDE_SHORT,
  FLASH_PRIVILEGE_REFERRAL,
} from './flash-referral.js';
import { getPrimaryRpcUrl } from '../../rpc-config.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const PYTH_HERMES_BASE = 'https://hermes.pyth.network';
const PYTH_FETCH_TIMEOUT_MS = 8_000;
const FLASH_CLUSTER = 'mainnet-beta' as const;

/**
 * Default market-order slippage tolerance (percent) when the caller does not
 * specify maxSlippagePct. 1% is conservative for on-chain perp execution where
 * the priceWithSlippage acts as a protective limit; the trade fails-closed
 * on-chain if the oracle moves beyond this band rather than filling at a bad
 * price.
 */
const DEFAULT_SLIPPAGE_PCT = 1;

/** Price exponent used when encoding a float price into a ContractOraclePrice. */
const PRICE_EXPONENT = -8;

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

  // Lazily-built shared infrastructure (bounded: one connection, one read
  // client, one PoolConfig per pool, one market index).
  private _connection: Connection | null = null;
  private _readClient: PerpetualsClient | null = null;
  private readonly _poolConfigs = new Map<string, PoolConfig>();
  private _marketIndex: Map<string, { poolName: string; internalSymbol: string; side: 'long' | 'short' }> | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.getMarkets();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    invalidateAllCaches();
    this._readClient = null;
    this._connection = null;
    this._poolConfigs.clear();
    this._marketIndex = null;
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

    const markets: ProtocolMarket[] = getFlashMarketSpecs().map((spec) => ({
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
    const spec = this._specBySymbol(internalSymbol);
    return spec?.maintenanceMarginWeight ?? 0.005;
  }

  quantizeOrderSize(internalSymbol: string, size: number): number {
    const spec = this._specBySymbol(internalSymbol);
    const lotSize = spec?.lotSize ?? 0.0001;
    return Math.floor(size / lotSize) * lotSize;
  }

  quantizePrice(internalSymbol: string, price: number): number {
    const spec = this._specBySymbol(internalSymbol);
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

  // ── Orderbook / funding ─────────────────────────────────────────────────────

  async getOrderbook(internalSymbol: string, _depth?: number): Promise<OrderbookSnapshot> {
    // Flash is an oracle/AMM venue with no central limit order book. We synthesize
    // a single-level book around the Pyth oracle price using the market's
    // estimated slippage band, which is what downstream slippage estimation needs.
    const price = await this.getPrice(internalSymbol);
    if (price == null) {
      throw new Error(`FlashAdapter.getOrderbook: no oracle price for ${internalSymbol}`);
    }
    const spec = this._specBySymbol(internalSymbol);
    const slip = (spec?.estimatedSlippagePct ?? 0.05) / 100;
    const size = spec ? Math.max(spec.minOrderSizeBase, 1) : 1;
    return {
      bids: [{ price: price * (1 - slip), size }],
      asks: [{ price: price * (1 + slip), size }],
      timestamp: Date.now(),
    };
  }

  async getFundingRate(internalSymbol: string): Promise<FundingRateInfo> {
    // Flash "funding" is a ONE-WAY, asymmetric borrow rate accrued continuously to
    // the side that borrows pool liquidity — NOT a symmetric periodic funding
    // payment. A precise read (getBorrowRateSync against the decoded custody
    // account) is a Phase 4 calibration item. Until then we report rate:0 with a
    // continuous (hourly) nextFundingTime rather than fabricate a symmetric rate
    // the engine would mis-model. Do NOT interpret this as "zero funding cost".
    return {
      internalSymbol,
      rate: 0,
      nextFundingTime: Date.now() + 3_600_000,
      timestamp: Date.now(),
    };
  }

  // ── Account / position reads ────────────────────────────────────────────────

  async getPositions(agentPublicKey: string, subaccountId?: string): Promise<ProtocolPosition[]> {
    const wallet = new PublicKey(subaccountId ?? agentPublicKey);
    const raw = await this._readRawPositions(wallet);
    const idx = this._getMarketIndex();

    const out: ProtocolPosition[] = [];
    for (const p of raw) {
      const info = idx.get(p.market.toBase58());
      if (!info) continue;

      const entryPrice = this._contractPriceToFloat(p.entryPrice);
      const sizeAbs = this._bnToFloat(p.sizeAmount, p.sizeDecimals);
      const baseSize = info.side === 'short' ? -sizeAbs : sizeAbs;
      const markPrice = (await this.getPrice(info.internalSymbol)) ?? entryPrice;
      const unrealizedPnl = this._bnToFloat(p.unsettledValueUsd, 6);
      const collateralUsd = this._bnToFloat(p.collateralUsd, 6);
      const sizeUsd = this._bnToFloat(p.sizeUsd, 6);
      const leverage = collateralUsd > 0 ? sizeUsd / collateralUsd : 0;

      out.push({
        internalSymbol: info.internalSymbol,
        baseSize,
        entryPrice,
        markPrice,
        unrealizedPnl,
        leverage,
        liquidationPrice: null,
        marginMode: 'isolated',
        subaccountId: wallet.toBase58(),
      });
    }
    return out;
  }

  async getAccountInfo(agentPublicKey: string, subaccountId?: string): Promise<AccountInfo> {
    const wallet = new PublicKey(subaccountId ?? agentPublicKey);
    const [raw, walletUsdc] = await Promise.all([
      this._readRawPositions(wallet),
      this.getWalletCollateralBalance(wallet.toBase58()),
    ]);
    const idx = this._getMarketIndex();

    let collateralSum = 0;
    let pnlSum = 0;
    let maintMargin = 0;
    for (const p of raw) {
      const info = idx.get(p.market.toBase58());
      const collateralUsd = this._bnToFloat(p.collateralUsd, 6);
      const sizeUsd = this._bnToFloat(p.sizeUsd, 6);
      const unrealized = this._bnToFloat(p.unsettledValueUsd, 6);
      collateralSum += collateralUsd;
      pnlSum += unrealized;
      const mmw = info ? this.getMaintenanceMarginWeight(info.internalSymbol) : 0.005;
      maintMargin += sizeUsd * mmw;
    }

    const equity = walletUsdc + collateralSum + pnlSum;
    return {
      equity,
      balance: walletUsdc,
      unrealizedPnl: pnlSum,
      availableMargin: walletUsdc,
      maintenanceMargin: maintMargin,
      subaccountId: wallet.toBase58(),
      exists: walletUsdc > 0 || raw.length > 0,
    };
  }

  async getBalances(agentPublicKey: string, subaccountId?: string): Promise<BalanceInfo> {
    const info = await this.getAccountInfo(agentPublicKey, subaccountId);
    // totalMarginUsed = collateral locked in positions = equity − freeUsdc − pnl.
    return {
      totalEquity: info.equity,
      freeCollateral: info.balance,
      totalMarginUsed: info.equity - info.balance - info.unrealizedPnl,
      unrealizedPnl: info.unrealizedPnl,
    };
  }

  async getEquityHistory(_agentPublicKey: string, _params?: HistoryParams): Promise<EquityPoint[]> {
    // No on-chain source for historical equity curves; a Flash indexer feed is a
    // Phase 3 item. Returns empty (no data available) rather than throwing so
    // charting callers degrade gracefully.
    return [];
  }

  async getTradeHistory(_agentPublicKey: string, _params?: HistoryParams): Promise<TradeRecord[]> {
    // No on-chain cheap source for fill history; a Flash indexer feed is a Phase 3
    // item. Returns empty (no data available) rather than throwing.
    return [];
  }

  async getBatchAccountInfo(agentPublicKey: string, subaccountIds: string[]): Promise<AccountInfo[]> {
    return Promise.all(subaccountIds.map((id) => this.getAccountInfo(agentPublicKey, id)));
  }

  async getBatchPositions(
    agentPublicKey: string,
    subaccountIds: string[],
  ): Promise<Map<string, ProtocolPosition[]>> {
    const results = await Promise.all(subaccountIds.map((id) => this.getPositions(agentPublicKey, id)));
    const map = new Map<string, ProtocolPosition[]>();
    subaccountIds.forEach((id, i) => map.set(id, results[i]));
    return map;
  }

  // ── Order execution ─────────────────────────────────────────────────────────

  async placeMarketOrder(params: MarketOrderParams): Promise<OrderResult> {
    try {
      const spec = this._specBySymbol(params.internalSymbol);
      if (!spec) return this._reject(`Unknown market ${params.internalSymbol}`);
      if (!Number.isFinite(params.sizeBase) || params.sizeBase <= 0) {
        return this._reject(`Invalid order size ${params.sizeBase}`);
      }
      if (params.maxSlippagePct != null && (!Number.isFinite(params.maxSlippagePct) || params.maxSlippagePct < 0)) {
        return this._reject(`Invalid maxSlippagePct ${params.maxSlippagePct}`);
      }
      if (params.leverage != null && (!Number.isFinite(params.leverage) || params.leverage <= 0)) {
        return this._reject(`Invalid leverage ${params.leverage}`);
      }

      const price = await this.getPrice(params.internalSymbol);
      if (price == null || !Number.isFinite(price) || price <= 0) {
        return this._reject(`No valid oracle price for ${params.internalSymbol}`);
      }

      const signer = new FlashKeypairSigner(params.agentSecretKey);
      const botWallet = signer.publicKey;
      const poolConfig = this._getPoolConfig(spec.pool);
      const token = poolConfig.getTokenFromSymbol(spec.flashSymbol);
      const referral = getReferralAccounts(botWallet);
      const slipPct = (params.maxSlippagePct ?? DEFAULT_SLIPPAGE_PCT) / 100;

      const client = this._buildWriteClient(signer);
      let built: BuiltIx;

      if (params.reduceOnly) {
        // Reduce/close existing exposure → decreaseSize on the open position.
        const pos = await this._findPosition(botWallet, spec);
        if (!pos) return this._reject('reduceOnly requested but no open position');
        const collatSym = pos.side === 'short' ? 'USDC' : spec.flashSymbol;
        const sideEnum = pos.side === 'short' ? FLASH_SIDE_SHORT : FLASH_SIDE_LONG;
        // Reducing a short buys back (price up); reducing a long sells (price down).
        const limitPrice = pos.side === 'short' ? price * (1 + slipPct) : price * (1 - slipPct);
        const sizeDelta = this._toBaseUnits(params.sizeBase, token.decimals);
        built = await client.decreaseSize(
          spec.flashSymbol,
          collatSym,
          sideEnum as unknown as Side,
          pos.pubkey,
          poolConfig,
          this._floatToContractPrice(limitPrice),
          sizeDelta,
          FLASH_PRIVILEGE_REFERRAL as unknown as Privilege,
          referral.tokenStakeAccount,
          referral.userReferralAccount,
        );
      } else {
        const leverage = params.leverage && params.leverage > 0 ? params.leverage : 1;
        const notionalUsd = params.sizeBase * price;
        const collateralUsdc = notionalUsd / leverage;
        const collateralBN = this._toBaseUnits(collateralUsdc, 6);
        const sizeBN = this._toBaseUnits(params.sizeBase, token.decimals);
        const referralArgs = [
          FLASH_PRIVILEGE_REFERRAL as unknown as Privilege,
          referral.tokenStakeAccount,
          referral.userReferralAccount,
        ] as const;

        if (params.side === 'short') {
          // Short open = sell; accept fills down to price*(1−slip). USDC collateral.
          const limitPrice = price * (1 - slipPct);
          built = await client.openPosition(
            spec.flashSymbol,
            'USDC',
            this._floatToContractPrice(limitPrice),
            collateralBN,
            sizeBN,
            FLASH_SIDE_SHORT as unknown as Side,
            poolConfig,
            ...referralArgs,
          );
        } else {
          // Long open = buy; accept fills up to price*(1+slip). swapAndOpen turns
          // the bot's USDC into target-asset collateral, then opens the long.
          const limitPrice = price * (1 + slipPct);
          built = await client.swapAndOpen(
            spec.flashSymbol,
            spec.flashSymbol,
            'USDC',
            collateralBN,
            this._floatToContractPrice(limitPrice),
            sizeBN,
            FLASH_SIDE_LONG as unknown as Side,
            poolConfig,
            ...referralArgs,
          );
        }
      }

      const signature = await this._send(client, poolConfig, built);
      return {
        success: true,
        status: 'filled',
        orderId: signature,
        fillPrice: price,
        fillSize: params.sizeBase,
        rawResponse: signature,
      };
    } catch (err: unknown) {
      return this._reject(err instanceof Error ? err.message : String(err));
    }
  }

  async placeLimitOrder(_params: LimitOrderParams): Promise<OrderResult> {
    // Flash is an oracle/AMM perp venue without resting maker limit orders. Use
    // placeMarketOrder for entries and placeStopOrder/setTpSl for conditional
    // execution. Explicit rejection (never a silent no-op).
    return this._reject(
      'Flash does not support resting limit orders (oracle/AMM venue). ' +
        'Use placeMarketOrder, or placeStopOrder/setTpSl for conditional execution.',
    );
  }

  async cancelOrder(_params: CancelOrderParams): Promise<CancelResult> {
    // Flash open orders are on-chain trigger orders, not id-addressable resting
    // orders in our flow. Cancel via cancelTpSlOrders(symbol) or cancelAllOrders.
    return {
      success: false,
      error:
        'Flash cancelOrder-by-id is not supported — cancel via cancelTpSlOrders(symbol) or cancelAllOrders.',
    };
  }

  async cancelAllOrders(params: CancelAllOrdersParams): Promise<CancelResult> {
    try {
      const signer = new FlashKeypairSigner(params.agentSecretKey);
      const botWallet = signer.publicKey;
      const idx = this._getMarketIndex();
      const client = this._buildWriteClient(signer);
      const specs = getFlashMarketSpecs();
      const readClient = this._getReadClient();

      let canceled = 0;
      // One transaction per pool — each pool has its own address lookup table.
      for (const poolConfig of this._getAllPoolConfigs()) {
        const orderAccts = await readClient.getUserOrderAccounts(botWallet, poolConfig);
        const instructions: TransactionInstruction[] = [];
        const signers: Signer[] = [];

        for (const oa of orderAccts) {
          const info = idx.get(oa.market.toBase58());
          if (!info) continue;
          if (params.symbol && info.internalSymbol !== params.symbol) continue;
          const openCount = oa.openTp + oa.openSl;
          if (openCount === 0) continue;

          const spec = specs.find((s) => s.internalSymbol === info.internalSymbol);
          if (!spec) continue;
          const collatSym = info.side === 'short' ? 'USDC' : spec.flashSymbol;
          const sideEnum = info.side === 'short' ? FLASH_SIDE_SHORT : FLASH_SIDE_LONG;
          const built = await client.cancelAllTriggerOrders(
            spec.flashSymbol,
            collatSym,
            sideEnum as unknown as Side,
            poolConfig,
          );
          instructions.push(...built.instructions);
          signers.push(...built.additionalSigners);
          canceled += openCount;
        }

        if (instructions.length > 0) {
          await this._send(client, poolConfig, { instructions, additionalSigners: signers });
        }
      }
      return { success: true, canceledCount: canceled };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async closePosition(params: ClosePositionParams): Promise<OrderResult> {
    try {
      const spec = this._specBySymbol(params.internalSymbol);
      if (!spec) return this._reject(`Unknown market ${params.internalSymbol}`);

      const signer = new FlashKeypairSigner(params.agentSecretKey);
      const botWallet = signer.publicKey;
      const poolConfig = this._getPoolConfig(spec.pool);
      const referral = getReferralAccounts(botWallet);

      const pos = await this._findPosition(botWallet, spec);
      if (!pos) return this._reject(`No open ${params.internalSymbol} position to close`);

      const price = await this.getPrice(params.internalSymbol);
      if (price == null) return this._reject(`No oracle price for ${params.internalSymbol}`);

      const slipPct = DEFAULT_SLIPPAGE_PCT / 100;
      const client = this._buildWriteClient(signer);
      const referralArgs = [
        FLASH_PRIVILEGE_REFERRAL as unknown as Privilege,
        referral.tokenStakeAccount,
        referral.userReferralAccount,
      ] as const;
      let built: BuiltIx;

      if (pos.side === 'short') {
        // Closing a short buys back; accept fills up to price*(1+slip).
        const limitPrice = price * (1 + slipPct);
        built = await client.closePosition(
          spec.flashSymbol,
          'USDC',
          this._floatToContractPrice(limitPrice),
          FLASH_SIDE_SHORT as unknown as Side,
          poolConfig,
          ...referralArgs,
        );
      } else {
        // Closing a long sells the asset back to USDC; accept fills down to price*(1−slip).
        const limitPrice = price * (1 - slipPct);
        built = await client.closeAndSwap(
          spec.flashSymbol,
          'USDC',
          spec.flashSymbol,
          this._floatToContractPrice(limitPrice),
          FLASH_SIDE_LONG as unknown as Side,
          poolConfig,
          ...referralArgs,
        );
      }

      const signature = await this._send(client, poolConfig, built);
      return {
        success: true,
        status: 'filled',
        orderId: signature,
        fillPrice: price,
        fillSize: pos.sizeBase,
        rawResponse: signature,
      };
    } catch (err: unknown) {
      return this._reject(err instanceof Error ? err.message : String(err));
    }
  }

  async setLeverage(_params: SetLeverageParams): Promise<void> {
    // Flash applies leverage per-trade via the collateral/notional ratio at open
    // (collateralWithfee in openPosition/swapAndOpen). There is no standalone
    // set-leverage instruction — placeMarketOrder honors params.leverage. No-op.
  }

  async setMarginMode(_params: SetMarginModeParams): Promise<void> {
    // Flash margin mode is fixed per market by custody configuration (isolated).
    // No-op.
  }

  async placeStopOrder(params: StopOrderParams): Promise<OrderResult> {
    try {
      const spec = this._specBySymbol(params.internalSymbol);
      if (!spec) return this._reject(`Unknown market ${params.internalSymbol}`);
      if (!Number.isFinite(params.sizeBase) || params.sizeBase <= 0) {
        return this._reject(`Invalid stop order size ${params.sizeBase}`);
      }
      if (!Number.isFinite(params.triggerPrice) || params.triggerPrice <= 0) {
        return this._reject(`Invalid trigger price ${params.triggerPrice}`);
      }

      const signer = new FlashKeypairSigner(params.agentSecretKey);
      const poolConfig = this._getPoolConfig(spec.pool);
      const token = poolConfig.getTokenFromSymbol(spec.flashSymbol);
      const collatSym = params.side === 'short' ? 'USDC' : spec.flashSymbol;
      const sideEnum = params.side === 'short' ? FLASH_SIDE_SHORT : FLASH_SIDE_LONG;
      const deltaBN = this._toBaseUnits(params.sizeBase, token.decimals);

      const client = this._buildWriteClient(signer);
      const built = await client.placeTriggerOrder(
        spec.flashSymbol,
        collatSym,
        'USDC',
        sideEnum as unknown as Side,
        this._floatToContractPrice(params.triggerPrice),
        deltaBN,
        true, // isStopLoss
        poolConfig,
      );
      const signature = await this._send(client, poolConfig, built);
      return { success: true, status: 'submitted', orderId: signature, rawResponse: signature };
    } catch (err: unknown) {
      return this._reject(err instanceof Error ? err.message : String(err));
    }
  }

  async setTpSl(params: TpSlParams): Promise<OrderResult> {
    try {
      const spec = this._specBySymbol(params.internalSymbol);
      if (!spec) return this._reject(`Unknown market ${params.internalSymbol}`);

      const signer = new FlashKeypairSigner(params.agentSecretKey);
      const botWallet = signer.publicKey;
      const poolConfig = this._getPoolConfig(spec.pool);
      const token = poolConfig.getTokenFromSymbol(spec.flashSymbol);

      const pos = await this._findPosition(botWallet, spec);
      if (!pos) return this._reject(`No open ${params.internalSymbol} position for TP/SL`);

      const mark = await this.getPrice(params.internalSymbol);
      if (mark == null) return this._reject(`No oracle price for ${params.internalSymbol}`);

      const sideEnum = pos.side === 'short' ? FLASH_SIDE_SHORT : FLASH_SIDE_LONG;
      const collatSym = pos.side === 'short' ? 'USDC' : spec.flashSymbol;
      const deltaBN = this._toBaseUnits(pos.sizeBase, token.decimals);

      const client = this._buildWriteClient(signer);
      const instructions: TransactionInstruction[] = [];
      const signers: Signer[] = [];
      const droppedLegs: Array<{ leg: 'tp' | 'sl'; reason: string }> = [];
      let appliedTakeProfitPrice: number | null = null;
      let appliedStopLossPrice: number | null = null;

      if (params.takeProfitPrice != null) {
        // TP is in profit direction: above mark for a long, below mark for a short.
        const valid = pos.side === 'long' ? params.takeProfitPrice > mark : params.takeProfitPrice < mark;
        if (!valid) {
          droppedLegs.push({
            leg: 'tp',
            reason: `TP ${params.takeProfitPrice} is on the wrong side of mark ${mark} for a ${pos.side}`,
          });
        } else {
          const built = await client.placeTriggerOrder(
            spec.flashSymbol,
            collatSym,
            'USDC',
            sideEnum as unknown as Side,
            this._floatToContractPrice(params.takeProfitPrice),
            deltaBN,
            false, // isStopLoss=false → take-profit
            poolConfig,
          );
          instructions.push(...built.instructions);
          signers.push(...built.additionalSigners);
          appliedTakeProfitPrice = params.takeProfitPrice;
        }
      }

      if (params.stopLossPrice != null) {
        // SL is in loss direction: below mark for a long, above mark for a short.
        const valid = pos.side === 'long' ? params.stopLossPrice < mark : params.stopLossPrice > mark;
        if (!valid) {
          droppedLegs.push({
            leg: 'sl',
            reason: `SL ${params.stopLossPrice} is on the wrong side of mark ${mark} for a ${pos.side}`,
          });
        } else {
          const built = await client.placeTriggerOrder(
            spec.flashSymbol,
            collatSym,
            'USDC',
            sideEnum as unknown as Side,
            this._floatToContractPrice(params.stopLossPrice),
            deltaBN,
            true, // isStopLoss=true
            poolConfig,
          );
          instructions.push(...built.instructions);
          signers.push(...built.additionalSigners);
          appliedStopLossPrice = params.stopLossPrice;
        }
      }

      if (instructions.length === 0) {
        return {
          success: false,
          status: 'rejected',
          error: 'No valid TP/SL legs (all dropped on wrong-side-of-mark guard)',
          appliedTakeProfitPrice,
          appliedStopLossPrice,
          droppedLegs,
        };
      }

      const signature = await this._send(client, poolConfig, { instructions, additionalSigners: signers });
      return {
        success: true,
        status: 'submitted',
        orderId: signature,
        appliedTakeProfitPrice,
        appliedStopLossPrice,
        droppedLegs,
        rawResponse: signature,
      };
    } catch (err: unknown) {
      return this._reject(err instanceof Error ? err.message : String(err));
    }
  }

  async cancelStopOrder(_params: CancelStopOrderParams): Promise<CancelResult> {
    // No id-addressable cancel in our flow — cancel via cancelTpSlOrders(symbol)
    // or cancelAllOrders.
    return {
      success: false,
      error:
        'Flash cancelStopOrder-by-id is not supported — cancel via cancelTpSlOrders(symbol) or cancelAllOrders.',
    };
  }

  async cancelTpSlOrders(params: {
    agentPublicKey: string;
    agentSecretKey: Uint8Array;
    mainWalletAddress: string;
    internalSymbol: string;
    subaccountId?: string;
  }): Promise<CancelResult> {
    try {
      const spec = this._specBySymbol(params.internalSymbol);
      if (!spec) return { success: false, error: `Unknown market ${params.internalSymbol}` };

      const signer = new FlashKeypairSigner(params.agentSecretKey);
      const botWallet = signer.publicKey;
      const poolConfig = this._getPoolConfig(spec.pool);
      const idx = this._getMarketIndex();
      const orderAccts = await this._getReadClient().getUserOrderAccounts(botWallet, poolConfig);

      const client = this._buildWriteClient(signer);
      const instructions: TransactionInstruction[] = [];
      const signers: Signer[] = [];
      let canceled = 0;

      for (const oa of orderAccts) {
        const info = idx.get(oa.market.toBase58());
        if (info?.internalSymbol !== spec.internalSymbol) continue;
        const openCount = oa.openTp + oa.openSl;
        if (openCount === 0) continue;
        const collatSym = info.side === 'short' ? 'USDC' : spec.flashSymbol;
        const sideEnum = info.side === 'short' ? FLASH_SIDE_SHORT : FLASH_SIDE_LONG;
        const built = await client.cancelAllTriggerOrders(
          spec.flashSymbol,
          collatSym,
          sideEnum as unknown as Side,
          poolConfig,
        );
        instructions.push(...built.instructions);
        signers.push(...built.additionalSigners);
        canceled += openCount;
      }

      if (instructions.length === 0) return { success: true, canceledCount: 0 };
      await this._send(client, poolConfig, { instructions, additionalSigners: signers });
      return { success: true, canceledCount: canceled };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Deposits / withdrawals ──────────────────────────────────────────────────

  async executeDeposit(_params: AgentDepositParams): Promise<DepositResult> {
    // Flash (independent_trader) has NO trader collateral-deposit instruction —
    // collateral is wallet-resident USDC committed atomically inside
    // openPosition/swapAndOpen at trade time. "Depositing" means USDC already
    // sits in the bot wallet's USDC ATA (funded by the user's on-chain transfer).
    // Honest no-op: we do NOT fabricate a deposit tx signature. Trades fail-closed
    // on insufficient balance, so an over-reported deposit cannot cause loss.
    return { success: true };
  }

  async executeWithdraw(params: AgentWithdrawParams): Promise<WithdrawResult> {
    try {
      if (params.amount < this.minTransferAmount) {
        return { success: false, error: `Amount ${params.amount} below minimum ${this.minTransferAmount} USDC` };
      }

      const signer = new FlashKeypairSigner(params.agentSecretKey);
      const botWallet = signer.publicKey;
      const mainWallet = new PublicKey(params.mainWalletAddress);
      const usdcMint = new PublicKey(FLASH_USDC_MINT);
      const fromAta = getAssociatedTokenAddressSync(usdcMint, botWallet, true);
      const toAta = getAssociatedTokenAddressSync(usdcMint, mainWallet, true);
      const connection = this._getConnection();

      // Fail-closed: verify the source ATA covers the withdrawal before sending.
      const fromAcc = await getAccount(connection, fromAta);
      const have = Number(fromAcc.amount.toString()) / 1e6;
      if (have + 1e-9 < params.amount) {
        return { success: false, error: `Insufficient USDC: have ${have}, need ${params.amount}` };
      }

      const instructions: TransactionInstruction[] = [];
      const toInfo = await connection.getAccountInfo(toAta);
      if (!toInfo) {
        instructions.push(createAssociatedTokenAccountInstruction(botWallet, toAta, mainWallet, usdcMint));
      }
      const amountBase = BigInt(this._toBaseUnits(params.amount, 6).toString());
      instructions.push(createTransferInstruction(fromAta, toAta, botWallet, amountBase));

      const { blockhash } = await connection.getLatestBlockhash('confirmed');
      const tx = new Transaction();
      tx.feePayer = botWallet;
      tx.recentBlockhash = blockhash;
      tx.add(...instructions);
      await signer.signTransaction(tx);
      const signature = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(signature, 'confirmed');

      return { success: true, txSignature: signature };
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async transferBetweenSubaccounts(_params: TransferParams): Promise<TransferResult> {
    // Flash independent_trader model: there is no inter-subaccount transfer.
    // Fund/defund each bot wallet via executeDeposit/executeWithdraw.
    return {
      success: false,
      error:
        'Flash uses the independent_trader model — fund/defund via executeDeposit/executeWithdraw on each bot wallet.',
    };
  }

  // ── Subaccount lifecycle (mapped to the bot wallet) ─────────────────────────

  async createSubaccount(input: CreateSubaccountInput): Promise<SubaccountInfo> {
    // Flash independent_trader: the bot's own agent wallet IS the on-chain trader.
    // There is no separate subaccount and no creation instruction — the position
    // account is created implicitly by the first openPosition. We report the bot
    // wallet as the (already-usable) subaccount id.
    const subaccountId = input.agentPublicKey;
    const equity = await this.getWalletCollateralBalance(subaccountId).catch(() => 0);
    return { subaccountId, label: input.label, equity, status: 'confirmed' };
  }

  async listSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]> {
    const equity = await this.getWalletCollateralBalance(agentPublicKey).catch(() => 0);
    return [{ subaccountId: agentPublicKey, equity, status: 'confirmed' }];
  }

  async discoverSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]> {
    return this.listSubaccounts(agentPublicKey);
  }

  async subaccountExists(walletAddress: string, _subaccountId: string): Promise<boolean> {
    const bal = await this.getWalletCollateralBalance(walletAddress).catch(() => 0);
    if (bal > 0) return true;
    const positions = await this._readRawPositions(new PublicKey(walletAddress)).catch(() => []);
    return positions.length > 0;
  }

  async getWalletCollateralBalance(walletAddress: string): Promise<number> {
    const owner = new PublicKey(walletAddress);
    const ata = getAssociatedTokenAddressSync(new PublicKey(FLASH_USDC_MINT), owner, true);
    try {
      const acc = await getAccount(this._getConnection(), ata);
      return Number(acc.amount.toString()) / 1e6;
    } catch {
      // No ATA / not found = zero balance. Truthful "no account", not a money fallback.
      return 0;
    }
  }

  // ── PnL settlement ──────────────────────────────────────────────────────────

  async settlePnl(_params: SettlePnlParams): Promise<SettleResult> {
    // Flash settles realized PnL atomically inside closePosition/closeAndSwap;
    // there is no standalone settle instruction. Reported as auto-settled.
    return { success: true, settledAmount: 0 };
  }

  // ── Diagnostics ─────────────────────────────────────────────────────────────

  async getAdapterDiagnostics(): Promise<Record<string, unknown>> {
    const prices = await this.getAllPrices().catch(() => ({}));
    return {
      protocolName: this.protocolName,
      protocolVersion: this.protocolVersion,
      initialized: this.initialized,
      accountModel: this.subaccountCaps.accountModel,
      knownMarkets: getFlashMarketSpecs().map((s) => s.internalSymbol),
      poolsLoaded: Array.from(new Set(getFlashMarketSpecs().map((s) => s.pool))),
      readClientReady: this._readClient !== null,
      cachedPrices: prices,
    };
  }

  // ── Internal: Pyth Hermes HTTP ──────────────────────────────────────────────

  private async _fetchPriceFromHermes(internalSymbols: string[]): Promise<Record<string, number>> {
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

    const idToSymbol = new Map<string, string>(symbolsWithIds.map((e) => [e.id.toLowerCase(), e.sym]));

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

  // ── Internal: infrastructure ────────────────────────────────────────────────

  private _getConnection(): Connection {
    if (!this._connection) {
      this._connection = new Connection(getPrimaryRpcUrl(), 'confirmed');
    }
    return this._connection;
  }

  private _newPerpClient(provider: AnchorProvider): PerpetualsClient {
    return new PerpetualsClient(
      provider,
      new PublicKey(FLASH_PROGRAM_ID),
      new PublicKey(FLASH_COMPOSABILITY_PROGRAM_ID),
      new PublicKey(FLASH_FB_NFT_REWARD_PROGRAM_ID),
      new PublicKey(FLASH_REWARD_DISTRIBUTION_PROGRAM_ID),
      { prioritizationFee: 0 } as unknown as ConstructorParameters<typeof PerpetualsClient>[5],
      false,
    );
  }

  private _getReadClient(): PerpetualsClient {
    if (!this._readClient) {
      const provider = new AnchorProvider(this._getConnection(), createReadOnlyWallet(), { commitment: 'confirmed' });
      this._readClient = this._newPerpClient(provider);
    }
    return this._readClient;
  }

  private _buildWriteClient(signer: FlashTransactionSigner): PerpetualsClient {
    // A WRITE client must be built with the agent wallet so the SDK derives the
    // correct fee payer and position/referral PDAs and signs with it. Ephemeral
    // per money-path call — never cached, so the key goes out of scope promptly.
    const provider = new AnchorProvider(this._getConnection(), signer.asAnchorWallet(), { commitment: 'confirmed' });
    return this._newPerpClient(provider);
  }

  private _getPoolConfig(poolName: string): PoolConfig {
    let pc = this._poolConfigs.get(poolName);
    if (!pc) {
      pc = PoolConfig.fromIdsByName(poolName, FLASH_CLUSTER);
      this._poolConfigs.set(poolName, pc);
    }
    return pc;
  }

  private _getAllPoolConfigs(): PoolConfig[] {
    const names = Array.from(new Set(getFlashMarketSpecs().map((s) => s.pool)));
    return names.map((n) => this._getPoolConfig(n));
  }

  private _getMarketIndex(): Map<string, { poolName: string; internalSymbol: string; side: 'long' | 'short' }> {
    if (this._marketIndex) return this._marketIndex;
    const idx = new Map<string, { poolName: string; internalSymbol: string; side: 'long' | 'short' }>();
    const specs = getFlashMarketSpecs();

    for (const pc of this._getAllPoolConfigs()) {
      for (const market of pc.markets) {
        const custody = pc.custodies.find((c) => c.custodyAccount.equals(market.targetCustody));
        if (!custody) continue;
        const spec = specs.find((s) => s.pool === pc.poolName && s.flashSymbol === custody.symbol);
        if (!spec) continue;
        const side: 'long' | 'short' = 'long' in market.side ? 'long' : 'short';
        idx.set(market.marketAccount.toBase58(), {
          poolName: pc.poolName,
          internalSymbol: spec.internalSymbol,
          side,
        });
      }
    }
    this._marketIndex = idx;
    return idx;
  }

  private _specBySymbol(internalSymbol: string): FlashMarketSpec | undefined {
    return getFlashMarketSpecs().find((s) => s.internalSymbol === internalSymbol);
  }

  /** Read the active, non-zero positions across all pools for a wallet. */
  private async _readRawPositions(wallet: PublicKey): Promise<RawPosition[]> {
    const positions = await this._getReadClient().getUserPositionsMultiPool(wallet, this._getAllPoolConfigs());
    return positions.filter((p) => p.isActive && !p.sizeAmount.isZero());
  }

  /** Find the open position for a symbol and resolve its side + signed-magnitude base size. */
  private async _findPosition(
    wallet: PublicKey,
    spec: FlashMarketSpec,
  ): Promise<{ pubkey: PublicKey; side: 'long' | 'short'; sizeBase: number } | null> {
    const poolConfig = this._getPoolConfig(spec.pool);
    const positions = await this._getReadClient().getUserPositions(wallet, poolConfig);
    const idx = this._getMarketIndex();
    for (const p of positions) {
      if (!p.isActive || p.sizeAmount.isZero()) continue;
      const info = idx.get(p.market.toBase58());
      if (info?.internalSymbol === spec.internalSymbol) {
        return { pubkey: p.pubkey, side: info.side, sizeBase: this._bnToFloat(p.sizeAmount, p.sizeDecimals) };
      }
    }
    return null;
  }

  /** Load the pool's address lookup tables and send the built instructions. */
  private async _send(client: PerpetualsClient, poolConfig: PoolConfig, built: BuiltIx): Promise<string> {
    const { addressLookupTables } = await client.getOrLoadAddressLookupTable(poolConfig);
    const { signature } = await client.sendTransactionV3(built.instructions, {
      additionalSigners: built.additionalSigners,
      alts: addressLookupTables,
    });
    return signature;
  }

  // ── Internal: numeric conversions ───────────────────────────────────────────

  private _bnToFloat(bn: BN, decimals: number): number {
    return Number(bn.toString()) / Math.pow(10, decimals);
  }

  private _contractPriceToFloat(p: ContractOraclePrice): number {
    // value = price * 10^exponent (exponent is negative, e.g. -8).
    return Number(p.price.toString()) * Math.pow(10, p.exponent);
  }

  private _floatToContractPrice(price: number): ContractOraclePrice {
    const scaled = this._toBaseUnits(price, -PRICE_EXPONENT);
    return new OraclePrice({ price: scaled, exponent: new BN(PRICE_EXPONENT), confidence: new BN(0) }).toContractOraclePrice();
  }

  /** Convert a UI float to integer base units, string-safe against float overflow. */
  private _toBaseUnits(amount: number, decimals: number): BN {
    const fixed = amount.toFixed(decimals);
    const negative = fixed.startsWith('-');
    const [whole, frac = ''] = (negative ? fixed.slice(1) : fixed).split('.');
    const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
    const digits = (whole + fracPadded).replace(/^0+(?=\d)/, '');
    const bn = new BN(digits === '' ? '0' : digits);
    return negative ? bn.neg() : bn;
  }

  private _reject(error: string): OrderResult {
    return { success: false, status: 'rejected', error };
  }
}

// ── Local SDK shape aliases ───────────────────────────────────────────────────

type BuiltIx = { instructions: TransactionInstruction[]; additionalSigners: Signer[] };

type RawPosition = Awaited<ReturnType<PerpetualsClient['getUserPositionsMultiPool']>>[number];

export const flashAdapter = new FlashAdapter();

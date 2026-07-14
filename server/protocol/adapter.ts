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
  getOrderbook(internalSymbol: string, depth?: number): Promise<OrderbookSnapshot>;
  getFundingRate(internalSymbol: string): Promise<FundingRateInfo>;
  getMaintenanceMarginWeight(internalSymbol: string): number;
  quantizeOrderSize(internalSymbol: string, size: number): number;
  quantizePrice(internalSymbol: string, price: number): number;

  getAccountInfo(agentPublicKey: string, subaccountId?: string): Promise<AccountInfo>;
  getPositions(agentPublicKey: string, subaccountId?: string): Promise<ProtocolPosition[]>;
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

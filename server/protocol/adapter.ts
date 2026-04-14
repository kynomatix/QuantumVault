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

export interface ProtocolAdapter {
  readonly protocolName: string;
  readonly protocolVersion: string;

  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }>;
  getCapabilities(): AdapterCapabilities;

  getMarkets(): Promise<ProtocolMarket[]>;
  getPrice(internalSymbol: string): Promise<number | null>;
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

  executeDeposit(params: AgentDepositParams): Promise<DepositResult>;
  executeWithdraw(params: AgentWithdrawParams): Promise<WithdrawResult>;
  transferBetweenSubaccounts(params: TransferParams): Promise<TransferResult>;

  createSubaccount(agentPublicKey: string, label?: string): Promise<SubaccountInfo>;
  listSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]>;
  discoverSubaccounts(agentPublicKey: string): Promise<SubaccountInfo[]>;
  closeSubaccount?(agentPublicKey: string, subaccountId: string): Promise<void>;

  settlePnl(params: SettlePnlParams): Promise<SettleResult>;

  subscribeToFills?(agentPublicKey: string, callback: (fill: FillEvent) => void): Unsubscribe;
  subscribeToPositionUpdates?(agentPublicKey: string, callback: (pos: ProtocolPosition) => void): Unsubscribe;
  subscribeToOrderUpdates?(agentPublicKey: string, callback: (order: OrderUpdate) => void): Unsubscribe;
}

export interface UserTransactionBuilder {
  readonly protocolName: string;

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

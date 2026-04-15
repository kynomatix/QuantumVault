export type RiskTier = 'recommended' | 'caution' | 'high_risk';

export interface ProtocolMarket {
  internalSymbol: string;
  protocolSymbol: string;
  maxLeverage: number;
  minOrderSizeUsd: number;
  minOrderSizeBase: number;
  tickSize: number;
  lotSize: number;
  isActive: boolean;
  category: string[];
  fullName: string;
  maintenanceMarginWeight: number;
  openInterestUsd?: number;
  warning?: string;
  fundingRate?: number;
  riskTier: RiskTier;
  estimatedSlippagePct: number;
}

export interface ProtocolPosition {
  internalSymbol: string;
  baseSize: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  leverage: number;
  liquidationPrice: number | null;
  marginMode: 'cross' | 'isolated';
  subaccountId?: string;
}

export interface MarketOrderParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  internalSymbol: string;
  side: 'long' | 'short';
  sizeBase: number;
  reduceOnly?: boolean;
  clientOrderId?: string;
  subaccountId?: string;
  builderCode?: string;
  maxSlippagePct?: number;
  leverage?: number;
}

export interface LimitOrderParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  internalSymbol: string;
  side: 'long' | 'short';
  sizeBase: number;
  price: number;
  timeInForce: 'GTC' | 'IOC' | 'ALO' | 'TOB';
  reduceOnly?: boolean;
  clientOrderId?: string;
  subaccountId?: string;
  builderCode?: string;
}

export type OrderStatus =
  | 'submitted'
  | 'acknowledged'
  | 'filled'
  | 'partial_fill'
  | 'canceled'
  | 'expired'
  | 'rejected';

export interface OrderResult {
  success: boolean;
  orderId?: string;
  clientOrderId?: string;
  status: OrderStatus;
  fillPrice?: number;
  fillSize?: number;
  fee?: number;
  error?: string;
  rawResponse?: unknown;
}

export interface CancelOrderParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  orderId: string;
  subaccountId?: string;
}

export interface CancelAllOrdersParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  symbol?: string;
  subaccountId?: string;
}

export interface CancelResult {
  success: boolean;
  canceledCount?: number;
  error?: string;
}

export interface ClosePositionParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  internalSymbol: string;
  subaccountId?: string;
  clientOrderId?: string;
  builderCode?: string;
}

export interface SetLeverageParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  internalSymbol: string;
  leverage: number;
  subaccountId?: string;
}

export interface SetMarginModeParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  mode: 'cross' | 'isolated';
  subaccountId?: string;
}

export interface StopOrderParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  internalSymbol: string;
  side: 'long' | 'short';
  sizeBase: number;
  triggerPrice: number;
  clientOrderId?: string;
  subaccountId?: string;
  builderCode?: string;
}

export interface TpSlParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  internalSymbol: string;
  takeProfitPrice?: number;
  stopLossPrice?: number;
  subaccountId?: string;
}

export interface CancelStopOrderParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  orderId: string;
  subaccountId?: string;
}

export interface AgentDepositParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  amount: number;
  subaccountId?: string;
}

export interface AgentWithdrawParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  amount: number;
  subaccountId?: string;
}

export interface DepositResult {
  success: boolean;
  txSignature?: string;
  error?: string;
}

export interface WithdrawResult {
  success: boolean;
  txSignature?: string;
  error?: string;
}

export interface TransferParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  mainWalletAddress: string;
  fromSubaccountId: string;
  toSubaccountId: string;
  amount: number;
}

export interface TransferResult {
  success: boolean;
  error?: string;
}

export interface SubaccountInfo {
  subaccountId: string;
  label?: string;
  equity?: number;
  status: 'requested' | 'initiated' | 'confirmed' | 'failed' | 'orphaned';
}

export interface AccountInfo {
  equity: number;
  balance: number;
  unrealizedPnl: number;
  availableMargin: number;
  maintenanceMargin: number;
  feeTier?: string;
  subaccountId?: string;
  exists?: boolean;
}

export interface BalanceInfo {
  totalEquity: number;
  freeCollateral: number;
  totalMarginUsed: number;
  unrealizedPnl: number;
}

export interface OrderbookSnapshot {
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
  timestamp: number;
}

export interface FundingRateInfo {
  internalSymbol: string;
  rate: number;
  nextFundingTime: number;
  timestamp: number;
}

export interface HistoryParams {
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

export interface EquityPoint {
  equity: number;
  timestamp: number;
}

export interface TradeRecord {
  tradeId: string;
  orderId: string;
  clientOrderId?: string;
  internalSymbol: string;
  side: 'long' | 'short';
  price: number;
  size: number;
  fee: number;
  timestamp: number;
  subaccountId?: string;
}

export interface FillEvent {
  fillId: string;
  orderId: string;
  clientOrderId?: string;
  internalSymbol: string;
  side: 'long' | 'short';
  price: number;
  size: number;
  fee: number;
  timestamp: number;
  subaccountId?: string;
}

export interface OrderUpdate {
  orderId: string;
  clientOrderId?: string;
  internalSymbol: string;
  status: OrderStatus;
  filledSize?: number;
  remainingSize?: number;
  averageFillPrice?: number;
  timestamp: number;
  subaccountId?: string;
}

export interface SettlePnlParams {
  agentPublicKey: string;
  agentSecretKey: Uint8Array;
  subaccountId?: string;
}

export interface SettleResult {
  success: boolean;
  settledAmount?: number;
  error?: string;
}

export interface AdapterCapabilities {
  supportsPartialFills: boolean;
  supportsStopOrders: boolean;
  supportsTpSl: boolean;
  supportsBatchOrders: boolean;
  supportsIsolatedMargin: boolean;
  supportsWebSocket: boolean;
  supportsSettlePnl: boolean;
  supportsCloseSubaccount: boolean;
  maxSubaccounts: number | null;
  settlementType: 'on-chain' | 'off-chain' | 'hybrid';
}

export type Unsubscribe = () => void;

export interface TransactionBuildResult {
  transaction: string;
  blockhash: string;
  lastValidBlockHeight: number;
  message: string;
}

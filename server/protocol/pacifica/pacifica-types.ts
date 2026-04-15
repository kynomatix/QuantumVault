export interface PacificaMarketInfo {
  symbol: string;
  tick_size: string;
  min_tick: string;
  max_tick: string;
  lot_size: string;
  max_leverage: number;
  isolated_only: boolean;
  min_order_size: string;
  max_order_size: string;
  funding_rate: string;
  next_funding_rate: string;
  created_at: number;
  instrument_type: string;
  base_asset: string;
}

export interface PacificaPriceEntry {
  symbol: string;
  price: string;
  timestamp: number;
}

export interface PacificaPricesResponse {
  prices: PacificaPriceEntry[];
}

export interface PacificaOrderbookLevel {
  p: string;
  a: string;
  n: number;
}

export interface PacificaOrderbookResponse {
  s: string;
  l: PacificaOrderbookLevel[][];
  t: number;
}

export interface PacificaFundingResponse {
  symbol: string;
  rate: string;
  next_funding_time: number;
  timestamp: number;
}

export interface PacificaAccountResponse {
  equity: string;
  balance: string;
  unrealized_pnl: string;
  available_margin: string;
  maintenance_margin: string;
  fee_tier: string;
  subaccount_id?: string;
}

export interface PacificaPositionResponse {
  symbol: string;
  size: string;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  leverage: string;
  liquidation_price: string | null;
  margin_mode: 'cross' | 'isolated';
  subaccount_id?: string;
}

export interface PacificaOrderResponse {
  order_id: string;
  client_order_id?: string;
  status: string;
  fill_price?: string;
  fill_size?: string;
  fee?: string;
  error?: string;
}

export interface PacificaCancelResponse {
  success: boolean;
  canceled_count?: number;
  error?: string;
}

export interface PacificaTradeResponse {
  trade_id: string;
  order_id: string;
  client_order_id?: string;
  symbol: string;
  side: 'bid' | 'ask';
  price: string;
  size: string;
  fee: string;
  timestamp: number;
  subaccount_id?: string;
}

export interface PacificaEquityHistoryPoint {
  equity: string;
  timestamp: number;
}

export interface PacificaSubaccountResponse {
  subaccount_id: string;
  label?: string;
  equity?: string;
  status: string;
}

export interface PacificaWithdrawResponse {
  success: boolean;
  tx_signature?: string;
  error?: string;
}

export interface PacificaTransferResponse {
  success: boolean;
  error?: string;
}

export interface PacificaWsFillEvent {
  fill_id: string;
  order_id: string;
  client_order_id?: string;
  symbol: string;
  side: 'bid' | 'ask';
  price: string;
  size: string;
  fee: string;
  timestamp: number;
  subaccount_id?: string;
}

export interface PacificaWsOrderUpdate {
  order_id: string;
  client_order_id?: string;
  symbol: string;
  status: string;
  filled_size?: string;
  remaining_size?: string;
  average_fill_price?: string;
  timestamp: number;
  subaccount_id?: string;
}

export interface PacificaWsPositionUpdate {
  symbol: string;
  size: string;
  entry_price: string;
  mark_price: string;
  unrealized_pnl: string;
  leverage: string;
  liquidation_price: string | null;
  margin_mode: 'cross' | 'isolated';
  subaccount_id?: string;
}

export interface PacificaApiError {
  error: string;
  message?: string;
  code?: number;
}

export function mapPacificaSide(side: 'bid' | 'ask'): 'long' | 'short' {
  return side === 'bid' ? 'long' : 'short';
}

export function mapToProtocolSide(side: 'long' | 'short'): 'bid' | 'ask' {
  return side === 'long' ? 'bid' : 'ask';
}

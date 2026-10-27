import type { CloseSnapshot } from '../protocol/close-outcome';

export type CloseSendOutcome = {
  kind: 'not_entered' | 'ambiguous' | 'acknowledged' | 'rejected_terminal';
  orderId?: string;
  httpStatus?: number;
  cause?: string;
};

export interface PreparedReduceOnlyMarketOrder {
  account: string;
  environment: string;
  market: string;
  operationData: Readonly<Record<string, unknown>> & {
    amount: string; symbol: string; side: 'bid' | 'ask'; reduce_only: true; client_order_id: string;
  };
}

export interface CloseAttempt {
  attemptId: string;
  timestamp: number;
  expiry_window: number;
  admittedAt: number;
  priorProof?: { attemptId: string; committedAt: number; watermark: number };
  outcome?: CloseSendOutcome;
  receivedAt?: number;
}

export interface CloseIntent {
  id: string;
  source_key: string;
  owner_wallet: string;
  bot_id: string;
  original_trade_id: string;
  protocol: 'pacifica';
  environment: string;
  original_account: string;
  original_subaccount_id: null;
  signer_public_key: string;
  signer_mode: 'external_key' | 'wallet_agent';
  authority_ref: Record<string, unknown>;
  position_epoch: {
    sizeSource: 'strict' | 'db_cache_bounded_fallback';
    strict: boolean;
    cacheBaseSizeText: string | null;
    strictBaseline: CloseSnapshot | null;
    baseSize: string | null;
    lastTradeId: string | null;
  };
  market: string;
  close_kind: 'full' | 'partial';
  position_side: 'long' | 'short';
  /** Full-close objective as admitted; position_epoch.sizeSource identifies provenance. */
  original_position_size_base: string;
  requested_size_base: string;
  client_order_id: string;
  request_payload: PreparedReduceOnlyMarketOrder['operationData'] & { account: string };
  status: 'pending' | 'needs_user' | 'confirmed' | 'released';
  release_mode: 'flat' | 'still_open' | 'residual' | 'not_sent' | null;
  dispatch_state: 'not_admitted' | 'admitted_unknown' | 'proven_not_landed';
  attempt_count: number;
  attempt_log: CloseAttempt[];
  last_evidence: Record<string, unknown>;
  last_observed_at: Date | null;
  next_action_at: Date;
  last_error_code: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

export type NewCloseIntent = Pick<CloseIntent, 'source_key' | 'owner_wallet' | 'bot_id'
  | 'environment' | 'original_account' | 'signer_public_key' | 'signer_mode' | 'authority_ref'
  | 'position_epoch' | 'market' | 'close_kind' | 'position_side' | 'original_position_size_base'
  | 'requested_size_base' | 'client_order_id' | 'request_payload'>;

export interface CloseScope {
  readonly environment: string;
  readonly account: string;
  readonly market: string;
  /** In-process handle; storage alone owns the connection and transaction. */
  readonly token: object;
}

export interface StrictCloseOpenOrders {
  account: string;
  environment: string;
  dispatchedAt: number;
  receivedAt: number;
  complete: true;
  fresh: true;
  noDedup: true;
  lastOrderId: number;
  orders: Array<{ market: string; orderType: string }>;
}

export const CLOSE_IN_PROGRESS = "A close is already in progress for this position. We'll update it when that finishes.";
export const CLOSE_NOT_SENT = "Close was not sent. The position may still be open. You can close it again.";
export const CLOSE_SAVE_FAILED = "We couldn't save your close request. Please try again.";
export function closeIntentMessage(intent: Pick<CloseIntent, 'status' | 'release_mode' | 'close_kind' | 'position_epoch'>): string {
  if (intent.status === 'confirmed') return intent.close_kind === 'partial' ? 'Position reduced.' : 'Position closed.';
  if (intent.status === 'released') {
    if (intent.release_mode === 'flat') return 'Position closed. Accounting is unavailable.';
    if (intent.release_mode === 'still_open') return 'Close expired without confirmation. The position is still open. You can close it again.';
    if (intent.release_mode === 'residual') return 'Part of the position is still open.';
    return CLOSE_NOT_SENT;
  }
  return intent.status === 'needs_user' ? 'Close needs your attention. The position may still be open.'
    : 'Close not confirmed yet; we keep checking.';
}

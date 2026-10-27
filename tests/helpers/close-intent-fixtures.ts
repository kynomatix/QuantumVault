import type { CloseIntent, NewCloseIntent, StrictCloseOpenOrders } from '../../server/trading/signal-bot-close-intent-types';
import type { CloseSnapshot } from '../../server/protocol/close-outcome';
import { randomUUID } from 'node:crypto';
export function snapshot(size = '1', watermark = 7): CloseSnapshot {
  const now = Date.now();
  return { positions: size === '0' ? [] : [{ internalSymbol: 'BTC-PERP', baseSize: Number(size), sizeBaseExact: size, entryPrice: 100 } as any],
    evidence: { account: 'EXAMPLE_ACCOUNT', environment: 'EXAMPLE', requestId: randomUUID(), startedAt: now, dispatchedAt: now, receivedAt: now,
      lastOrderId: watermark, venueClockMs: now, complete: true, fresh: true, noDedup: true } };
}
export function newIntent(source: string = randomUUID()): NewCloseIntent {
  const clientId = randomUUID();
  return { source_key: source, owner_wallet: 'EXAMPLE_OWNER', bot_id: 'EXAMPLE_BOT', environment: 'EXAMPLE', original_account: 'EXAMPLE_ACCOUNT',
    signer_public_key: 'EXAMPLE_ACCOUNT', signer_mode: 'external_key', authority_ref: { mode: 'EXAMPLE' },
    position_epoch: { sizeSource: 'strict', strict: true, cacheBaseSizeText: null, strictBaseline: snapshot(), baseSize: '1', lastTradeId: 'EXAMPLE_ENTRY' },
    market: 'BTC-PERP', close_kind: 'full', position_side: 'long', original_position_size_base: '1', requested_size_base: '1', client_order_id: clientId,
    request_payload: { account: 'EXAMPLE_ACCOUNT', symbol: 'BTC', side: 'ask', amount: '1', reduce_only: true, client_order_id: clientId } };
}
export function intent(): CloseIntent {
  const now = Date.now();
  return { ...newIntent(), id: randomUUID(), original_trade_id: randomUUID(), protocol: 'pacifica', original_subaccount_id: null,
    status: 'pending', release_mode: null, dispatch_state: 'admitted_unknown', attempt_count: 1,
    attempt_log: [{ attemptId: randomUUID(), timestamp: now - 400000, expiry_window: 5000, admittedAt: now - 400000 }],
    last_evidence: { watermarkLowerBound: 7 }, last_observed_at: null, next_action_at: new Date(now), last_error_code: null,
    revision: '1', created_at: new Date(now - 400000), updated_at: new Date(now), completed_at: null };
}
export function orders(): StrictCloseOpenOrders {
  return { account: 'EXAMPLE_ACCOUNT', environment: 'EXAMPLE', dispatchedAt: Date.now(), receivedAt: Date.now(), complete: true, fresh: true,
    noDedup: true, lastOrderId: 7, orders: [] };
}

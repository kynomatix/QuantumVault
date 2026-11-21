import { vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter';
import { SymbolRegistry } from '../../server/protocol/symbol-registry';

// Mock the HTTP response below the shared parser so each caller sees Pacifica's actual admission and mapping.
export function pacificaCloseHistory(input: {
  symbol: string; orderId: string | number; amount: string; price: string;
  entryPrice: string; fee: string; pnl: string; timestamp?: number;
}) {
  const adapter = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
  (adapter as any).registry = new SymbolRegistry([{ internal: input.symbol + '-PERP', protocol: input.symbol, aliases: [] }]);
  (adapter as any).initialized = true;
  const transport = vi.spyOn(adapter as any, 'get').mockImplementation(async (_path, query) => ({
    success: true, has_more: false, next_cursor: null, data: [{
      history_id: 901, order_id: input.orderId, symbol: input.symbol, amount: input.amount,
      price: input.price, entry_price: input.entryPrice, fee: input.fee, pnl: input.pnl,
      event_type: 'fulfill_taker', side: 'close_long', cause: 'normal',
      created_at: input.timestamp ?? Number((query as Record<string, string>).start_time),
    }],
  }));
  return { getTradeHistory: adapter.getTradeHistory.bind(adapter), transport };
}

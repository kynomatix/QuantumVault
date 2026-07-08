// WO-6 review fix: getOpenStopOrders was the ONLY adapter method forwarding
// its symbol filter raw to /orders/stop. External callers (executor G10,
// ai-trader monitor) pass the INTERNAL symbol ("SOL-PERP"); Pacifica knows
// only protocol symbols ("SOL"), so the filter returned an empty list and the
// G10 path read every healthy bracket as "missing" — a money-path misread
// whose failure mode is force-closing live positions. The fix normalizes
// tolerantly inside the adapter so every caller (internal or already
// converted) is correct at once.
import { describe, it, expect, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';

function createAdapter(): PacificaAdapter {
  return new PacificaAdapter({
    baseUrl: 'https://api.pacifica.fi/api/v1',
    wsUrl: 'wss://ws.pacifica.fi/ws',
  });
}

const ACCT = 'SubAccountPubkey1111111111111111111111111111';

function stubRegistry(a: any) {
  a.getRegistry = () => ({
    isKnownInternal: (s: string) => s.toUpperCase() === 'SOL-PERP',
    internalToProtocol: (s: string) => {
      if (s.toUpperCase() !== 'SOL-PERP') throw new Error(`unknown internal symbol "${s}"`);
      return 'SOL';
    },
  });
}

describe('PacificaAdapter.getOpenStopOrders — symbol normalization', () => {
  it('converts an INTERNAL symbol ("SOL-PERP") to the protocol symbol ("SOL")', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    const get = vi.fn(async () => [{ order_id: 'st-1', symbol: 'SOL' }]);
    a.get = get;

    const orders = await a.getOpenStopOrders(ACCT, 'sub-1', 'SOL-PERP');

    expect(get).toHaveBeenCalledWith('/orders/stop', {
      account: ACCT,
      subaccount_id: 'sub-1',
      symbol: 'SOL',
    });
    expect(orders).toHaveLength(1);
  });

  it('passes an already-converted PROTOCOL symbol ("SOL") through untouched', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    const get = vi.fn(async () => []);
    a.get = get;

    await a.getOpenStopOrders(ACCT, undefined, 'SOL');

    expect(get).toHaveBeenCalledWith('/orders/stop', { account: ACCT, symbol: 'SOL' });
  });

  it('omits the symbol param entirely when none is given (unfiltered read)', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    const get = vi.fn(async () => []);
    a.get = get;

    await a.getOpenStopOrders(ACCT);

    expect(get).toHaveBeenCalledWith('/orders/stop', { account: ACCT });
  });

  it('still maps 404 to an empty list and rethrows other errors', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    a.get = async () => { throw new Error('HTTP 404 Not Found'); };
    expect(await a.getOpenStopOrders(ACCT, undefined, 'SOL-PERP')).toEqual([]);

    a.get = async () => { throw new Error('HTTP 500 server error'); };
    await expect(a.getOpenStopOrders(ACCT, undefined, 'SOL-PERP')).rejects.toThrow('500');
  });
});

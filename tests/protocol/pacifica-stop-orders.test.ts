// WO-6 review fix: getOpenStopOrders was the ONLY adapter method forwarding
// its symbol filter raw to /orders/stop. External callers (executor G10,
// ai-trader monitor) pass the INTERNAL symbol ("SOL-PERP"); Pacifica knows
// only protocol symbols ("SOL"), so the filter returned an empty list and the
// G10 path read every healthy bracket as "missing" — a money-path misread
// whose failure mode is force-closing live positions. The fix normalizes
// tolerantly inside the adapter so every caller (internal or already
// converted) is correct at once.
//
// placeStopOrder body layout pinned after WO-5 live serde verification
// (2026-07-08): 7 live 400 errors revealed the correct Pacifica field
// structure — symbol/side/reduce_only at the top level, amount/stop_price
// nested under stop_order:{}.
import { describe, it, expect, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer.js';

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

describe('PacificaAdapter.placeStopOrder — body layout (WO-5 live serde verification)', () => {
  it('sends symbol/side/reduce_only at top-level and amount/stop_price nested under stop_order', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    a.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: false }));
    // Pass values through unchanged so the test assertions are deterministic
    a.quantizeOrderSize = vi.fn((_sym: string, size: number) => size);
    a.quantizePrice = vi.fn((_sym: string, price: number) => price);
    a.mapOrderResponse = vi.fn(() => ({ success: true, orderId: 'probe-id', status: 'submitted' }));
    a.post = vi.fn(async () => ({ order_id: 'probe-id', status: 'submitted' }));

    let capturedOperationData: Record<string, unknown> | undefined;
    const buildSpy = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_opType: string, data: Record<string, unknown>) => {
        capturedOperationData = data;
        // Return a minimal body so post() has something to work with
        return { ...data, account: 'fake', signature: 'sig', timestamp: 0, expiry_window: 5000 } as any;
      },
    );

    try {
      await a.placeStopOrder({
        agentPublicKey: ACCT,
        agentSecretKey: new Uint8Array(64),
        internalSymbol: 'SOL-PERP',
        side: 'short',
        sizeBase: 0.01,
        triggerPrice: 38.89,
        reduceOnly: false,
      });
    } finally {
      buildSpy.mockRestore();
    }

    // Verified against 7 live Pacifica 400 errors (2026-07-08).
    // Correct layout: symbol, side, reduce_only are TOP-LEVEL.
    // amount and stop_price are NESTED under stop_order:{}.
    expect(capturedOperationData?.symbol).toBe('SOL');
    expect(capturedOperationData?.reduce_only).toBe(false);
    // side is top-level (mapped via mapToProtocolSide: 'short' → 'ask')
    expect(capturedOperationData?.side).toBe('ask');
    expect(capturedOperationData?.stop_order).toEqual({ amount: '0.01', stop_price: '38.89' });

    // Old wrong field names / wrong nesting must NOT appear at top level
    expect(capturedOperationData).not.toHaveProperty('trigger_price'); // previous wrong name
    expect(capturedOperationData).not.toHaveProperty('amount');        // was incorrectly flat
    expect(capturedOperationData).not.toHaveProperty('stop_price');    // was incorrectly flat

    // Confirm it POSTed to the correct endpoint
    expect(a.post).toHaveBeenCalledWith('/orders/stop/create', expect.any(Object));
  });

  it('omits subaccount_id from the signed operationData and adds it to the outer body only when provided', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    a.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: false }));
    a.quantizeOrderSize = vi.fn((_sym: string, size: number) => size);
    a.quantizePrice = vi.fn((_sym: string, price: number) => price);
    a.mapOrderResponse = vi.fn(() => ({ success: true, orderId: 'probe-id', status: 'submitted' }));

    let capturedBody: Record<string, unknown> | undefined;
    a.post = vi.fn(async (path: string, body: Record<string, unknown>) => {
      capturedBody = body;
      return { order_id: 'probe-id', status: 'submitted' };
    });

    const buildSpy = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_opType: string, data: Record<string, unknown>) =>
        ({ ...data, account: 'fake', signature: 'sig', timestamp: 0, expiry_window: 5000 } as any),
    );

    try {
      await a.placeStopOrder({
        agentPublicKey: ACCT,
        agentSecretKey: new Uint8Array(64),
        internalSymbol: 'SOL-PERP',
        side: 'long',
        sizeBase: 0.01,
        triggerPrice: 100.0,
        reduceOnly: true,
        subaccountId: 'sub-42',
      });
    } finally {
      buildSpy.mockRestore();
    }

    // subaccount_id is injected into the OUTER body after buildRequestBody (not in operationData)
    expect(capturedBody?.subaccount_id).toBe('sub-42');
    expect(capturedBody?.reduce_only).toBe(true);
  });
});

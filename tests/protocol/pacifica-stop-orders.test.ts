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
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer.js';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota.js';
import {
  liveBreakevenFingerprint,
  type LiveBreakevenAuthorityPermit,
} from '../../server/protocol/protocol-types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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
    protocolToInternal: (s: string) => {
      if (s.toUpperCase() !== 'SOL') throw new Error(`unknown protocol symbol "${s}"`);
      return 'SOL-PERP';
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

describe('PacificaAdapter.getOpenProtectiveOrders — documented /orders authority', () => {
  it('requests a fresh account order list and normalizes only the requested protective legs', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(true);
    const get = vi.fn(async () => [
      { order_id: 41, symbol: 'SOL', side: 'ask', stop_price: '145', order_type: 'stop_loss_market', reduce_only: true, initial_amount: '2', filled_amount: '0', cancelled_amount: '0' },
      { order_id: 42, symbol: 'SOL', side: 'ask', stop_price: '160', order_type: 'take_profit_market', reduce_only: true, initial_amount: '2', filled_amount: '0', cancelled_amount: '0' },
      { order_id: 43, symbol: 'SOL', side: 'bid', price: '150', order_type: 'limit', reduce_only: false, initial_amount: '1', filled_amount: '0', cancelled_amount: '0' },
      { order_id: 44, symbol: 'ETH', side: 'ask', stop_price: '2000', order_type: 'stop_loss_market', reduce_only: true, initial_amount: '1', filled_amount: '0', cancelled_amount: '0' },
    ]);
    a.get = get;

    const snapshot = await a.getOpenProtectiveOrders(ACCT, 'SOL-PERP');

    expect(get).toHaveBeenCalledWith('/orders', { account: ACCT }, {
      priority: 'background', cachePolicy: 'fresh-required',
    });
    expect(snapshot).toEqual({
      matchingProtectiveRowCount: 2,
      incompleteProtectiveRowCount: 0,
      orders: [
        { orderId: '41', internalSymbol: 'SOL-PERP', side: 'sell', orderType: 'stop_loss', triggerPrice: '145', reduceOnly: true, initialSize: '2', filledSize: '0', cancelledSize: '0' },
        { orderId: '42', internalSymbol: 'SOL-PERP', side: 'sell', orderType: 'take_profit', triggerPrice: '160', reduceOnly: true, initialSize: '2', filledSize: '0', cancelledSize: '0' },
      ],
    });
  });

  it('marks incomplete matching rows inconclusive and rejects a non-array response', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(true);
    a.get = vi.fn(async () => [{ order_id: 41, symbol: 'SOL', side: 'ask', stop_price: '145', order_type: 'stop_loss_market', reduce_only: true, initial_amount: '2', filled_amount: '0' }]);
    await expect(a.getOpenProtectiveOrders(ACCT, 'SOL-PERP')).resolves.toEqual({
      orders: [],
      matchingProtectiveRowCount: 1,
      incompleteProtectiveRowCount: 1,
    });
    a.get = vi.fn(async () => ({ orders: [] }));
    await expect(a.getOpenProtectiveOrders(ACCT, 'SOL-PERP')).rejects.toThrow('non-array');
  });

  it('skips the observation immediately when background quota is unavailable', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    const get = vi.fn();
    a.get = get;
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(false);
    vi.spyOn(pacificaQuota, 'noteRejection').mockImplementation(() => undefined);

    await expect(a.getOpenProtectiveOrders(ACCT, 'SOL-PERP')).rejects.toThrow('quota');
    expect(get).not.toHaveBeenCalled();
    expect(pacificaQuota.noteRejection).toHaveBeenCalledTimes(1);
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
    expect(capturedOperationData?.stop_order).toEqual({
      amount: '0.01',
      stop_price: '38.89',
    });

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

describe('PacificaAdapter generic TP/SL trigger-basis isolation', () => {
  it('does not change the omitted-basis semantics of initial, G10, or manual callers', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    a.getPositions = vi.fn(async () => [{ internalSymbol: 'SOL-PERP', baseSize: 2 }]);
    a.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: false }));
    a.getPrice = vi.fn(async () => 100);
    a.quantizePrice = vi.fn((_sym: string, price: number) => price);
    a.mapOrderResponse = vi.fn(() => ({ success: true, orderId: 'bracket-1', status: 'submitted' }));
    a.post = vi.fn(async () => ({ order_id: 'bracket-1', status: 'submitted' }));
    let operationData: Record<string, any> | undefined;
    vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_opType: string, data: Record<string, unknown>) => {
        operationData = data;
        return { ...data, account: ACCT, signature: 'sig' } as any;
      },
    );

    await expect(a.setTpSl({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      internalSymbol: 'SOL-PERP',
      takeProfitPrice: 110,
      stopLossPrice: 90,
    })).resolves.toMatchObject({ success: true });

    expect(operationData?.take_profit).toMatchObject({ stop_price: '110' });
    expect(operationData?.stop_loss).toEqual({ stop_price: '90' });
    expect(operationData?.take_profit).not.toHaveProperty('trigger_price_type');
    expect(operationData?.stop_loss).not.toHaveProperty('trigger_price_type');
  });

  it('prices the strict recent-trade read in the conservative account class', () => {
    expect(pacificaQuota.estimateCost('/trades')).toBe(3);
  });
});

describe('PacificaAdapter live breakeven authority', () => {
  const NOW = Date.UTC(2026, 8, 13, 0, 0, 0);

  beforeEach(() => {
    vi.spyOn(PacificaSigner.prototype, 'getPublicKey').mockReturnValue(ACCT);
  });

  it('uses only normal quota for every strict authority endpoint', async () => {
    const a = createAdapter() as any;
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const claim = vi.spyOn(pacificaQuota, 'tryClaimImmediate').mockReturnValue(false);
    for (const path of ['/positions', '/orders', '/trades']) {
      await expect(a.strictBreakevenGet(path, {}, NOW + 5_000)).rejects.toThrow('quota');
    }
    expect(claim.mock.calls).toEqual([
      ['/positions', 'normal'],
      ['/orders', 'normal'],
      ['/trades', 'normal'],
    ]);
  });

  function permit(): LiveBreakevenAuthorityPermit {
    const binding: LiveBreakevenAuthorityPermit['binding'] = {
      policyVersion: 'owner-accepted-v1.1',
      decisionId: 'decision-1',
      botId: 'bot-1',
      protocol: 'pacifica',
      account: ACCT,
      subaccountId: null,
      internalSymbol: 'SOL-PERP',
      protocolSymbol: 'SOL',
      side: 'long',
      entryPrice: '100.00000000',
      takeProfitPrice: '110.00000000',
      currentStopPrice: '95.00000000',
      candidateStopPrice: '100.15000000',
      positionSize: '2.00000000',
      analyticalProgress: '0.75',
      nativeProgress: '0.8',
      analyticalWindowFingerprint: 'A'.repeat(64),
      nativeSourceFingerprint: 'B'.repeat(64),
      positionEpochFingerprint: 'E'.repeat(64),
      positionStateFingerprint: 'C'.repeat(64),
      bracketFingerprint: 'D'.repeat(64),
      positionLastOrderId: '41',
      ordersLastOrderId: '42',
      tradesLastOrderId: '4001',
      sourceTimeMs: NOW,
      readStartedAtMs: NOW,
      readCompletedAtMs: NOW,
      issuedAtMs: NOW,
      expiresAtMs: NOW + 5_000,
      triggerBasis: 'last_trade_price',
    };
    return { schemaVersion: 1, binding, fingerprint: liveBreakevenFingerprint(binding) };
  }

  function authoritySnapshot(
    p: LiveBreakevenAuthorityPermit,
    stopPrice: string,
    bracketFingerprint = p.binding.bracketFingerprint,
  ) {
    return {
      schemaVersion: 1,
      protocol: 'pacifica',
      account: ACCT,
      subaccountId: null,
      internalSymbol: 'SOL-PERP',
      protocolSymbol: 'SOL',
      readStartedAtMs: NOW,
      readCompletedAtMs: NOW,
      position: {
        sourceRecordId: p.binding.positionEpochFingerprint,
        side: 'long',
        baseSize: '2.00000000',
        entryPrice: '100.00000000',
      },
      positionLastOrderId: '41',
      ordersLastOrderId: '42',
      triggerBasisStatus: 'last_trade_price' as const,
      protectiveOrders: [
        { orderId: '41', orderAccount: ACCT, orderType: 'stop_loss', side: 'sell', triggerBasis: 'last_trade_price', triggerPrice: stopPrice, initialSize: '2.00000000', remainingSize: '2.00000000', reduceOnly: true },
        { orderId: '42', orderAccount: ACCT, orderType: 'take_profit', side: 'sell', triggerBasis: 'last_trade_price', triggerPrice: '110.00000000', initialSize: '2.00000000', remainingSize: '2.00000000', reduceOnly: true },
      ],
      recentTrades: {
        lastOrderId: '4001',
        rows: [{
          symbol: 'SOL',
          createdAtMs: NOW,
          price: '108.00000000',
          sourceRecordFingerprint: '1'.repeat(64),
        }],
      },
      positionFingerprint: p.binding.positionStateFingerprint,
      bracketFingerprint,
      stateFingerprint: 'E'.repeat(64),
      sourceFingerprint: 'F'.repeat(64),
    };
  }

  it('reads positions, protective orders, and trades sequentially without losing decimal strings', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const strict = vi.fn(async (path: string) => {
      if (path === '/positions') return {
        envelope: {
          success: true,
          last_order_id: '41',
          data: [{ symbol: 'SOL', side: 'bid', amount: '2.00000000', entry_price: '100.00000000', created_at: NOW }],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
      if (path === '/orders') return {
        envelope: {
          success: true,
          last_order_id: '42',
          data: [
            { order_id: 41, symbol: 'SOL', side: 'ask', stop_price: '95.00000000', order_type: 'stop_loss_market', reduce_only: true, trigger_price_type: 'last_trade_price', initial_amount: '2.00000000', filled_amount: '0.00000000', cancelled_amount: '0.00000000' },
            { order_id: 42, symbol: 'SOL', side: 'ask', stop_price: '110.00000000', order_type: 'take_profit_market', reduce_only: true, trigger_price_type: 'last_trade_price', initial_amount: '2.00000000', filled_amount: '0.00000000', cancelled_amount: '0.00000000' },
          ],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
      return {
        envelope: {
          success: true,
          last_order_id: '4001',
          data: [{ price: '108.00000000', created_at: NOW }],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
    });
    a.strictBreakevenGet = strict;

    const snapshot = await a.getLiveBreakevenAuthoritySnapshot({
      agentPublicKey: ACCT,
      internalSymbol: 'SOL-PERP',
      deadlineAtMs: NOW + 5_000,
    });

    expect(strict.mock.calls.map((call) => call[0])).toEqual(['/positions', '/orders', '/trades']);
    expect(snapshot.position).toMatchObject({ baseSize: '2.00000000', entryPrice: '100.00000000' });
    expect(snapshot.protectiveOrders.map((order: any) => [order.orderType, order.triggerBasis, order.triggerPrice])).toEqual([
      ['stop_loss', 'last_trade_price', '95.00000000'],
      ['take_profit', 'last_trade_price', '110.00000000'],
    ]);
    expect(snapshot.recentTrades).toEqual({
      lastOrderId: '4001',
      rows: [{
        symbol: 'SOL',
        price: '108.00000000',
        createdAtMs: NOW,
        sourceRecordFingerprint: liveBreakevenFingerprint({ price: '108.00000000', created_at: NOW }),
      }],
    });
    expect(snapshot.ordersLastOrderId).toBe('42');
    expect(snapshot.positionLastOrderId).toBe('41');
    expect(snapshot.positionFingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(snapshot.bracketFingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(snapshot.stateFingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(snapshot.sourceFingerprint).toMatch(/^[0-9A-F]{64}$/);
  });

  it('does not invent ordering between independent endpoint watermarks', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    a.strictBreakevenGet = vi.fn(async (path: string) => {
      if (path === '/positions') return {
        envelope: {
          success: true,
          last_order_id: '50',
          data: [{
            symbol: 'SOL', side: 'bid', amount: '2.00000000',
            entry_price: '100.00000000', created_at: NOW,
          }],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
      if (path === '/orders') return {
        envelope: {
          success: true,
          last_order_id: '40',
          data: [
            { order_id: 41, symbol: 'SOL', side: 'ask', stop_price: '95.00000000', order_type: 'stop_loss_market', reduce_only: true, trigger_price_type: 'last_trade_price', initial_amount: '2.00000000', filled_amount: '0.00000000', cancelled_amount: '0.00000000' },
            { order_id: 42, symbol: 'SOL', side: 'ask', stop_price: '110.00000000', order_type: 'take_profit_market', reduce_only: true, trigger_price_type: 'last_trade_price', initial_amount: '2.00000000', filled_amount: '0.00000000', cancelled_amount: '0.00000000' },
          ],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
      return {
        envelope: { success: true, last_order_id: '60', data: [{ price: '108.00000000', created_at: NOW }] },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
    });

    const snapshot = await a.getLiveBreakevenAuthoritySnapshot({
      agentPublicKey: ACCT,
      internalSymbol: 'SOL-PERP',
      deadlineAtMs: NOW + 5_000,
    });
    expect(snapshot.positionLastOrderId).toBe('50');
    expect(snapshot.ordersLastOrderId).toBe('40');
    expect(snapshot.recentTrades.lastOrderId).toBe('60');
  });

  it('returns a fingerprinted structural snapshot when /orders omits trigger_price_type', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    a.strictBreakevenGet = vi.fn(async (path: string) => {
      if (path === '/positions') return {
        envelope: {
          success: true,
          last_order_id: '41',
          data: [{ symbol: 'SOL', side: 'bid', amount: '2.00000000', entry_price: '100.00000000', created_at: NOW }],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
      if (path === '/orders') return {
        envelope: {
          success: true,
          last_order_id: '42',
          data: [
            { order_id: 41, symbol: 'SOL', side: 'ask', stop_price: '95.00000000', order_type: 'stop_loss_market', reduce_only: true, initial_amount: '2.00000000', filled_amount: '0.00000000', cancelled_amount: '0.00000000' },
            { order_id: 42, symbol: 'SOL', side: 'ask', stop_price: '110.00000000', order_type: 'take_profit_market', reduce_only: true, initial_amount: '2.00000000', filled_amount: '0.00000000', cancelled_amount: '0.00000000' },
          ],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
      return {
        envelope: { success: true, last_order_id: '4001', data: [{ price: '108.00000000', created_at: NOW }] },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
    });

    const snapshot = await a.getLiveBreakevenAuthoritySnapshot({
      agentPublicKey: ACCT,
      internalSymbol: 'SOL-PERP',
      deadlineAtMs: NOW + 5_000,
    });

    expect(snapshot.triggerBasisStatus).toBe('absent');
    expect(snapshot.protectiveOrders.map((row: any) => row.triggerBasis)).toEqual(['absent', 'absent']);
    expect(snapshot.bracketFingerprint).toMatch(/^[0-9A-F]{64}$/);
    expect(snapshot.sourceFingerprint).toMatch(/^[0-9A-F]{64}$/);
  });

  it('returns malformed side and reduce-only evidence for structural classification instead of throwing', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    a.strictBreakevenGet = vi.fn(async (path: string) => {
      if (path === '/positions') return {
        envelope: {
          success: true,
          last_order_id: '41',
          data: [{
            symbol: 'SOL', side: 'bid', amount: '2.00000000',
            entry_price: '100.00000000', created_at: NOW,
          }],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
      if (path === '/orders') return {
        envelope: {
          success: true,
          last_order_id: '42',
          data: [
            { order_id: 41, symbol: 'SOL', side: 'unknown', stop_price: '95.00000000', order_type: 'stop_loss_market', reduce_only: true, trigger_price_type: 'last_trade_price', initial_amount: '2.00000000', filled_amount: '0.00000000', cancelled_amount: '0.00000000' },
            { order_id: 42, symbol: 'SOL', side: 'ask', stop_price: '110.00000000', order_type: 'take_profit_market', reduce_only: false, trigger_price_type: 'last_trade_price', initial_amount: '2.00000000', filled_amount: '0.00000000', cancelled_amount: '0.00000000' },
          ],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
      return {
        envelope: {
          success: true,
          last_order_id: '4001',
          data: [{ price: '108.00000000', created_at: NOW }],
        },
        readStartedAtMs: NOW,
        readCompletedAtMs: NOW,
      };
    });

    const snapshot = await a.getLiveBreakevenAuthoritySnapshot({
      agentPublicKey: ACCT,
      internalSymbol: 'SOL-PERP',
      deadlineAtMs: NOW + 5_000,
    });

    expect(snapshot.protectiveOrders).toEqual([
      expect.objectContaining({ orderId: '41', side: 'malformed', reduceOnly: true }),
      expect.objectContaining({ orderId: '42', side: 'sell', reduceOnly: false }),
    ]);
    expect(snapshot.bracketFingerprint).toMatch(/^[0-9A-F]{64}$/);
  });

  it('claims immediately before signing and sends both legs with explicit LTP basis', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    const order: string[] = [];
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    let snapshotCall = 0;
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => {
      snapshotCall += 1;
      order.push(snapshotCall === 1 ? 'snapshot-pre' : 'snapshot-post');
      return snapshotCall === 1
        ? authoritySnapshot(p, p.binding.currentStopPrice)
        : authoritySnapshot(p, p.binding.candidateStopPrice, '9'.repeat(64));
    });
    a.quantizePrice = vi.fn((_symbol: string, value: number) => value);
    a.mapOrderResponse = vi.fn(() => ({ success: true, orderId: 'moved-1', status: 'submitted' }));
    a.post = vi.fn(async () => {
      order.push('post');
      return { order_id: 'moved-1', status: 'submitted' };
    });
    let operationData: Record<string, any> | undefined;
    const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType, data) => {
        order.push('sign');
        operationData = data;
        return { ...data, account: ACCT, signature: 'sig', timestamp: NOW, expiry_window: 5_000 } as any;
      },
    );
    const claimAttempt = vi.fn(async () => {
      order.push('claim');
      return { status: 'claimed' as const, attemptId: 'protective:decision-1:1', ordinal: 1 };
    });

    try {
      const result = await a.moveLiveBreakevenStop({
        agentPublicKey: ACCT,
        agentSecretKey: new Uint8Array(64),
        mainWalletAddress: 'main-wallet-1',
        internalSymbol: 'SOL-PERP',
        permit: p,
        claimAttempt,
        recordPendingPersistence: async () => {
          order.push('persist');
          return true;
        },
      });
      expect(result).toMatchObject({
        success: true,
        appliedTakeProfitPrice: 110,
        appliedStopLossPrice: 100.15,
        attemptId: 'protective:decision-1:1',
        attemptOrdinal: 1,
        authorityFingerprint: p.fingerprint,
      });
    } finally {
      sign.mockRestore();
    }

    expect(order).toEqual(['snapshot-pre', 'claim', 'persist', 'sign', 'post', 'snapshot-post']);
    expect(operationData?.take_profit?.trigger_price_type).toBe('last_trade_price');
    expect(operationData?.stop_loss?.trigger_price_type).toBe('last_trade_price');
    expect(a.post).toHaveBeenCalledWith('/positions/tpsl', expect.any(Object));
  });

  it('does not sign or post when the durable attempt claim is denied', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => authoritySnapshot(p, p.binding.currentStopPrice));
    a.post = vi.fn();
    const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody');

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt: async () => ({ status: 'duplicate' }),
    });

    expect(result).toMatchObject({ success: false, error: 'live_breakeven_claim_duplicate' });
    expect(sign).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });

  it('consumes the claim but does not sign or post when the durable persistence intent cannot be recorded', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => authoritySnapshot(p, p.binding.currentStopPrice));
    a.post = vi.fn();
    const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody');
    const claimAttempt = vi.fn(async () => ({
      status: 'claimed' as const,
      attemptId: 'protective:decision-1:1',
      ordinal: 1,
    }));
    const recordPendingPersistence = vi.fn(async () => false);

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt,
      recordPendingPersistence,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'live_breakeven_persistence_intent_unavailable',
      attemptId: 'protective:decision-1:1',
      attemptOrdinal: 1,
    });
    expect(claimAttempt).toHaveBeenCalledTimes(1);
    expect(recordPendingPersistence).toHaveBeenCalledWith({
      attemptId: 'protective:decision-1:1',
      ordinal: 1,
    });
    expect(sign).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });

  it('recomputes the native 75% threshold immediately before claiming', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    const belowThreshold = authoritySnapshot(p, p.binding.currentStopPrice);
    belowThreshold.recentTrades.rows[0].price = '107.00000000';
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => belowThreshold);
    a.post = vi.fn();
    const claimAttempt = vi.fn();
    const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody');

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'live_breakeven_native_threshold_not_met_preclaim',
    });
    expect(claimAttempt).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });

  it('rejects a trade timestamp that was future at the preclaim response receipt', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 100);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    const futureAtReceipt = authoritySnapshot(p, p.binding.currentStopPrice);
    futureAtReceipt.recentTrades.rows[0].createdAtMs = NOW + 1;
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => futureAtReceipt);
    a.post = vi.fn();
    const claimAttempt = vi.fn();

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'live_breakeven_trade_stale_or_future',
    });
    expect(claimAttempt).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });

  it('rejects a preclaim snapshot older than the permit watermarks', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    const regressed = authoritySnapshot(p, p.binding.currentStopPrice);
    regressed.ordersLastOrderId = '40';
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => regressed);
    a.post = vi.fn();
    const claimAttempt = vi.fn();

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'live_breakeven_source_watermark_regressed',
    });
    expect(claimAttempt).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });

  it('rejects a checksum-valid permit for a different protocol symbol before builder lookup', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    const base = permit();
    const binding = { ...base.binding, protocolSymbol: 'BTC' };
    const forged = { ...base, binding, fingerprint: liveBreakevenFingerprint(binding) };
    a.readBreakevenBuilderApproval = vi.fn();
    a.post = vi.fn();
    const claimAttempt = vi.fn();

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: forged,
      claimAttempt,
    });

    expect(result).toMatchObject({ success: false, error: 'live_breakeven_permit_invalid' });
    expect(a.readBreakevenBuilderApproval).not.toHaveBeenCalled();
    expect(claimAttempt).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });

  it('rejects a signer that does not derive the permit account before reads or claim', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.mocked(PacificaSigner.prototype.getPublicKey).mockReturnValue('different-account');
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn();
    a.getLiveBreakevenAuthoritySnapshot = vi.fn();
    a.post = vi.fn();
    const claimAttempt = vi.fn();

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'live_breakeven_signer_account_mismatch',
    });
    expect(a.readBreakevenBuilderApproval).not.toHaveBeenCalled();
    expect(a.getLiveBreakevenAuthoritySnapshot).not.toHaveBeenCalled();
    expect(claimAttempt).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });

  it('consumes the claim but does not post if the permit expires during request construction', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => authoritySnapshot(p, p.binding.currentStopPrice));
    a.quantizePrice = vi.fn((_symbol: string, value: number) => value);
    a.post = vi.fn();
    const claimAttempt = vi.fn(async () => ({
      status: 'claimed' as const,
      attemptId: 'protective:decision-1:1',
      ordinal: 1,
    }));
    const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType, data) => {
        now.mockReturnValue(NOW + 5_001);
        return { ...data, account: ACCT, signature: 'sig' } as any;
      },
    );

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt,
      recordPendingPersistence: async () => true,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'live_breakeven_permit_expired_after_claim',
      attemptId: 'protective:decision-1:1',
      attemptOrdinal: 1,
    });
    expect(claimAttempt).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(a.post).not.toHaveBeenCalled();
  });

  it('restores and verifies the original bracket after an unverified replacement', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    a.quantizePrice = vi.fn((_symbol: string, value: number) => value);
    let read = 0;
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => {
      read += 1;
      if (read === 1) return authoritySnapshot(p, p.binding.currentStopPrice);
      if (read === 2) {
        const partial = authoritySnapshot(p, p.binding.candidateStopPrice, '8'.repeat(64));
        partial.protectiveOrders = partial.protectiveOrders.filter((row) => row.orderType === 'stop_loss');
        return partial;
      }
      return authoritySnapshot(p, p.binding.currentStopPrice, '7'.repeat(64));
    });
    a.post = vi.fn(async () => ({ order_id: `call-${a.post.mock.calls.length}` }));
    const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType, data) => ({ ...data, account: ACCT, signature: 'sig' } as any),
    );
    const claimAttempt = vi.fn(async () => ({
      status: 'claimed' as const,
      attemptId: 'protective:decision-1:1',
      ordinal: 1,
    }));

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt,
      recordPendingPersistence: async () => true,
    });

    expect(result).toMatchObject({
      success: false,
      restorationOutcome: 'restored_verified',
      requiresCloseAndPause: false,
      attemptOrdinal: 1,
    });
    expect(claimAttempt).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(sign.mock.calls[1][1]).toMatchObject({
      take_profit: { stop_price: p.binding.takeProfitPrice, trigger_price_type: 'last_trade_price' },
      stop_loss: { stop_price: p.binding.currentStopPrice, trigger_price_type: 'last_trade_price' },
    });
    expect(a.post).toHaveBeenCalledTimes(2);
  });

  it('requires close-and-pause when restoration cannot be verified', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    a.quantizePrice = vi.fn((_symbol: string, value: number) => value);
    let read = 0;
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => {
      read += 1;
      if (read === 1) return authoritySnapshot(p, p.binding.currentStopPrice);
      const partial = authoritySnapshot(p, p.binding.candidateStopPrice, '8'.repeat(64));
      partial.protectiveOrders = partial.protectiveOrders.filter((row) => row.orderType === 'stop_loss');
      return partial;
    });
    a.post = vi.fn(async () => ({ order_id: 'ambiguous' }));
    vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType, data) => ({ ...data, account: ACCT, signature: 'sig' } as any),
    );

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt: async () => ({
        status: 'claimed',
        attemptId: 'protective:decision-1:1',
        ordinal: 1,
      }),
      recordPendingPersistence: async () => true,
    });

    expect(result).toMatchObject({
      success: false,
      restorationOutcome: 'restoration_unverified',
      requiresCloseAndPause: true,
      attemptOrdinal: 1,
    });
    expect(a.post).toHaveBeenCalledTimes(2);
  });

  it('does not overwrite a tighter concurrent stop while handling an ambiguous call', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const p = permit();
    a.readBreakevenBuilderApproval = vi.fn(async () => false);
    a.quantizePrice = vi.fn((_symbol: string, value: number) => value);
    let read = 0;
    a.getLiveBreakevenAuthoritySnapshot = vi.fn(async () => {
      read += 1;
      return read === 1
        ? authoritySnapshot(p, p.binding.currentStopPrice)
        : authoritySnapshot(p, '101.00000000', '9'.repeat(64));
    });
    a.post = vi.fn(async () => ({ order_id: 'ambiguous' }));
    const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType, data) => ({ ...data, account: ACCT, signature: 'sig' } as any),
    );

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: p,
      claimAttempt: async () => ({
        status: 'claimed',
        attemptId: 'protective:decision-1:1',
        ordinal: 1,
      }),
      recordPendingPersistence: async () => true,
    });

    expect(result).toMatchObject({
      success: false,
      error: 'live_breakeven_post_state_unsafe_for_restoration',
      restorationOutcome: 'restoration_unverified',
      requiresCloseAndPause: true,
    });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(a.post).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown permit field before builder lookup, claim, or venue access', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    const base = permit();
    const binding = { ...base.binding, unreviewed: true } as any;
    const forged = { ...base, binding, fingerprint: liveBreakevenFingerprint(binding) };
    a.readBreakevenBuilderApproval = vi.fn();
    a.post = vi.fn();
    const claimAttempt = vi.fn();

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: forged,
      claimAttempt,
    });

    expect(result).toMatchObject({ success: false, error: 'live_breakeven_permit_invalid' });
    expect(a.readBreakevenBuilderApproval).not.toHaveBeenCalled();
    expect(claimAttempt).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });

  it('rejects number-coerced permit decimals before builder lookup, claim, or venue access', async () => {
    const a = createAdapter() as any;
    stubRegistry(a);
    const base = permit();
    const binding = { ...base.binding, entryPrice: 100 } as any;
    const forged = { ...base, binding, fingerprint: liveBreakevenFingerprint(binding) };
    a.readBreakevenBuilderApproval = vi.fn();
    a.post = vi.fn();
    const claimAttempt = vi.fn();

    const result = await a.moveLiveBreakevenStop({
      agentPublicKey: ACCT,
      agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'main-wallet-1',
      internalSymbol: 'SOL-PERP',
      permit: forged,
      claimAttempt,
    });

    expect(result).toMatchObject({ success: false, error: 'live_breakeven_permit_invalid' });
    expect(a.readBreakevenBuilderApproval).not.toHaveBeenCalled();
    expect(claimAttempt).not.toHaveBeenCalled();
    expect(a.post).not.toHaveBeenCalled();
  });
});

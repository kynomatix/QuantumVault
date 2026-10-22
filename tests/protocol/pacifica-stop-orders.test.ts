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
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache.js';
import { isConfirmedCancellation } from '../../server/protocol/protocol-types.js';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer.js';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota.js';
import { observePacificaConstraints } from '../../server/protocol/market-constraints.js';
import {
  liveBreakevenFingerprint,
  type LiveBreakevenAuthorityPermit,
} from '../../server/protocol/protocol-types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function createAdapter(): PacificaAdapter {
  const adapter = new PacificaAdapter({
    baseUrl: 'http://test-pacifica.invalid',
    wsUrl: 'ws://test-pacifica.invalid',
  });
  (adapter as any).get = vi.fn(async (path: string) => {
    if (path === '/info') return [{ symbol: 'SOL', tick_size: '0.01', lot_size: '0.01', min_order_size: '0.1', max_leverage: 50 }];
    if (path === '/info/prices') return { success: true, data: [{ symbol: 'SOL', mark: '100', timestamp: Date.now() }] };
    throw new Error(`Unmocked venue read: ${path}`);
  });
  return adapter;
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

function stubOrderConstraints(a: any) {
  a.getMarkets = vi.fn(async () => {
    const constraintObservation = observePacificaConstraints({
      tick_size: '0.01', lot_size: '0.01', min_order_size: '0.1',
    }, 'SOL-PERP', Date.now());
    a.marketDetailsMap.set('SOL-PERP', { constraintObservation });
    return [{ internalSymbol: 'SOL-PERP', constraintObservation }];
  });
  a.getMarkPrice = vi.fn(async () => ({ kind: 'available', venue: 'pacifica', internalSymbol: 'SOL-PERP', protocolSymbol: 'SOL', source: '/info/prices', field: 'mark', exact: '100', observedAt: Date.now(), receivedAt: Date.now(), expiresAt: Date.now() + 5_000 }));
  a.getStrictPositionForMarket = vi.fn(async () => ({ baseSize: -0.01 }));
  a.getExitStep = vi.fn(async (_symbol: string, field: string) => field === 'lot' ? 0.01 : 0.01);
}

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
    stubOrderConstraints(a);
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
    stubOrderConstraints(a);
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
    a.getStrictPositionForMarket = vi.fn(async () => (await a.getPositions())[0]);
    a.getExitStep = vi.fn(async () => 0.01);
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


// Install before module evaluation; restored spies return to a denying transport.
const deniedHttp = vi.hoisted(() => {
  const attempts: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    attempts.push(String(input));
    throw new Error('Unmocked HTTP denied by test network boundary');
  }) as typeof fetch;
  return attempts;
});
afterEach(() => {
  const unexpected = deniedHttp.splice(0);
  expect(unexpected, 'Every HTTP read must be explicitly mocked').toEqual([]);
});

describe('Pacifica cancellation HTTP outcomes and scoped absence', () => {
  const account = 'EXAMPLE_ACCOUNT';
  const params = { agentPublicKey: account, agentSecretKey: new Uint8Array(64),
    mainWalletAddress: 'EXAMPLE_WALLET', internalSymbol: 'SOL-PERP', symbol: 'SOL-PERP', orderId: '12' };
  const row = (order_id = 12, extra = {}) => ({ order_id, symbol: 'SOL', side: 'ask',
    order_type: 'stop_loss_market', reduce_only: true, stop_price: '90', price: null, ...extra });
  const snapshot = (data: unknown[] = [], last_order_id = 20, extra = {}) => ({ success: true,
    data, error: null, code: null, last_order_id, ...extra });
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  let a: any;
  let fetchMock: ReturnType<typeof vi.spyOn>;
  let sign: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    pacificaCache.invalidateAll();
    pacificaQuota.resetCounters();
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(true);
    a = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
    stubRegistry(a);
    fetchMock = vi.spyOn(globalThis, 'fetch');
    sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_type, data, acct) => ({ ...data, account: acct, signature: 'EXAMPLE' }) as any);
  });
  afterEach(() => { vi.useRealTimers(); });

  it.each(['SOL', 'SOL-PERP', undefined])('projects documented stop inventory for %s', async (symbol) => {
    fetchMock.mockImplementation(async () => reply(snapshot([row()])));
    expect(await a.getOpenStopOrders(account, undefined, symbol)).toEqual([
      { order_id: '12', symbol: 'SOL', side: 'ask', stop_price: '90', limit_price: undefined, order_type: 'stop_loss_market' },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://test-pacifica.invalid/orders?account=EXAMPLE_ACCOUNT');
  });

  it.each([
    null, [], { success: true, data: [] }, snapshot([], 20, { success: false }),
    snapshot([], 20, { error: 'EXAMPLE' }), snapshot([], 20, { account: 'WRONG' }),
    snapshot([], 20, { has_more: true }), snapshot([], 20, { next_cursor: 'EXAMPLE' }),
    snapshot([row(), row()]), snapshot([row(12, { symbol: 'UNKNOWN' })]),
    snapshot([row(12, { reduce_only: null })]), snapshot([row(12, { order_type: 'future' })]),
    snapshot([row(12, { stop_price: '' })]), snapshot([row(12, { side: 'unknown' })]),
    snapshot([row(12, { account: 'WRONG' })]), snapshot([row(12, { li: 30 })]),
    snapshot([row(1.5)]), snapshot([row(Number.MAX_SAFE_INTEGER + 1)]),
  ])('fails closed on malformed inventory %#', async (body) => {
    fetchMock.mockResolvedValue(reply(body));
    expect(await a.cancelTpSlOrders(params)).toMatchObject({ success: false, outcome: 'unknown', dispatch: 'unsent' });
    expect(sign).not.toHaveBeenCalled();
    await expect(a.getOpenOrders(account)).rejects.toThrow();
  });

  it.each([404, 500, 202])('does not turn inventory HTTP %s into empty', async (status) => {
    fetchMock.mockResolvedValue(reply(snapshot(), status));
    await expect(a.getOpenStopOrders(account)).rejects.toThrow();
  });

  it.each(['', '0', '-1', '01', '1.0', '1e2', '1.5', '9007199254740992', '12\n', 'EXAMPLE'])('rejects unsafe identity %j before signer/read', async (orderId) => {
    expect(await a.cancelStopOrder({ ...params, orderId })).toMatchObject({ success: false, dispatch: 'unsent' });
    expect(sign).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([{ symbol: undefined }, { symbol: 'UNKNOWN' }, { subaccountId: '1' }])('rejects unsupported scope %# before signer/read', async (extra) => {
    expect(await a.cancelStopOrder({ ...params, internalSymbol: undefined, ...extra })).toMatchObject({ success: false, dispatch: 'unsent' });
    expect(sign).not.toHaveBeenCalled(); expect(fetchMock).not.toHaveBeenCalled();
  });

  it('empty discovery proves absence without any mutation', async () => {
    fetchMock.mockResolvedValue(reply(snapshot()));
    const result = await a.cancelTpSlOrders(params);
    expect(isConfirmedCancellation(result, { account, symbol: 'SOL-PERP', operation: 'tpsl' })).toBe(true);
    expect(result.canceledCount).toBe(0); expect(sign).not.toHaveBeenCalled();
  });

  it.each(['cancelOrder', 'cancelStopOrder'])('signs exact numeric ID and symbol for %s and confirms separately', async (method) => {
    const initial = row(12, method === 'cancelOrder' ? { order_type: 'limit', stop_price: null } : {});
    fetchMock.mockResolvedValueOnce(reply(snapshot([initial])))
      .mockResolvedValueOnce(reply({ success: true })).mockResolvedValueOnce(reply(snapshot([], 21)));
    const result = await a[method](params);
    expect(result).toMatchObject({ success: true, outcome: 'confirmed_absent', canceledCount: 1 });
    expect(sign.mock.calls[0][1]).toEqual({ order_id: 12, symbol: 'SOL' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toMatchObject({ order_id: 12, symbol: 'SOL' });
    expect(result.targets[0].requestOutcome).toBe('acknowledged');
  });

  it.each([
    [200, { success: true }, 'acknowledged'], [200, {}, 'unknown'],
    [200, { success: false }, 'unknown'], [200, { success: true, error: 'EXAMPLE' }, 'unknown'],
    [200, { success: true, data: {} }, 'unknown'], [202, { success: true }, 'unknown'],
    [400, { error: 'EXAMPLE', code: 400 }, 'rejected'], [404, { error: 'EXAMPLE', code: 404 }, 'unknown'],
    [500, { error: 'EXAMPLE', code: 500 }, 'unknown'], [408, { error: 'EXAMPLE', code: 408 }, 'unknown'],
  ])('retains request outcome for HTTP %s fixture %# without false completion', async (status, body, outcome) => {
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce(reply(body, status as number)).mockResolvedValueOnce(reply(snapshot([row()], 21)));
    const result = await a.cancelStopOrder(params);
    expect(result).toMatchObject({ success: false, outcome, targets: [{ state: 'live', requestOutcome: outcome }] });
    expect(result.canceledCount).toBeUndefined();
  });

  it.each([0, 1, 999])('cancel-all acknowledgement count %s does not establish absence', async (count) => {
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce(reply({ cancelled_count: count })).mockResolvedValueOnce(reply(snapshot([row()], 21)));
    expect(await a.cancelAllOrders({ ...params, excludeReduceOnly: false })).toMatchObject({ success: false, outcome: 'acknowledged', acknowledgedCount: count });
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined])('rejects malformed cancel-all count %s', async (count) => {
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce(reply({ cancelled_count: count })).mockResolvedValueOnce(reply(snapshot([row()], 21)));
    expect(await a.cancelAllOrders({ ...params, excludeReduceOnly: false })).toMatchObject({ success: false, outcome: 'unknown' });
  });
  it.each([true, false])('signs explicit cancel-all policy %s', async (excludeReduceOnly) => {
    const opening = row(13, { order_type: 'limit', stop_price: null, reduce_only: false });
    fetchMock.mockResolvedValueOnce(reply(snapshot([row(), opening])))
      .mockResolvedValueOnce(reply({ cancelled_count: 1 })).mockResolvedValueOnce(reply(snapshot(excludeReduceOnly ? [row()] : [], 21)));
    expect(await a.cancelAllOrders({ ...params, symbol: undefined, internalSymbol: undefined, excludeReduceOnly })).toMatchObject({ success: true });
    expect(sign.mock.calls[0][1]).toEqual({ all_symbols: true, exclude_reduce_only: excludeReduceOnly });
  });
  it('requires explicit cancel-all policy before reading or signing', async () => {
    expect(await a.cancelAllOrders(params)).toMatchObject({ success: false, dispatch: 'unsent' });
    expect(fetchMock).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
  });
  it('signs a symbol-scoped cancel-all without broadening its scope', async () => {
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce(reply({ cancelled_count: 1 })).mockResolvedValueOnce(reply(snapshot([], 21)));
    const result = await a.cancelAllOrders({ ...params, excludeReduceOnly: false });
    expect(result).toMatchObject({ success: true, scope: { symbol: 'SOL-PERP', excludeReduceOnly: false } });
    expect(sign.mock.calls[0][1]).toEqual({ all_symbols: false, symbol: 'SOL', exclude_reduce_only: false });
  });
  it('keeps targets unknown if confirmation inventory fails', async () => {
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce(reply({ success: true })).mockResolvedValueOnce(reply({}, 500));
    expect(await a.cancelTpSlOrders(params)).toMatchObject({ success: false, outcome: 'acknowledged', targets: [{ state: 'unknown' }] });
    expect(sign).toHaveBeenCalledOnce();
  });
  it('records a known unsent signing failure without a POST', async () => {
    sign.mockImplementation(() => { throw new Error('EXAMPLE signing unavailable'); });
    fetchMock.mockImplementation(async () => reply(snapshot([row()])));
    expect(await a.cancelTpSlOrders(params)).toMatchObject({ success: false, outcome: 'rejected', dispatch: 'unsent', targets: [{ state: 'live', requestOutcome: 'unsent' }] });
    expect(fetchMock.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true);
  });

  it('cancels only captured protection and reports successors without touching opening orders', async () => {
    const opening = row(14, { reduce_only: false, order_type: 'stop_market' });
    const limit = row(15, { order_type: 'limit', stop_price: null });
    fetchMock.mockResolvedValueOnce(reply(snapshot([row(), row(13), opening, limit])))
      .mockResolvedValueOnce(reply({ success: true })).mockResolvedValueOnce(reply({ error: 'EXAMPLE', code: 400 }, 400))
      .mockResolvedValueOnce(reply(snapshot([row(13), row(16), opening, limit], 21)));
    const result = await a.cancelTpSlOrders(params);
    expect(result).toMatchObject({ success: false, outcome: 'partial', targets: [
      { orderId: '12', state: 'absent', requestOutcome: 'acknowledged' },
      { orderId: '13', state: 'live', requestOutcome: 'rejected' }], successors: [{ orderId: '16', state: 'live' }] });
    expect(sign.mock.calls.map(call => call[1].order_id)).toEqual([12, 13]);
    expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST').every(call => String(call[0]).endsWith('/orders/stop/cancel'))).toBe(true);
  });
  it('retains ambiguous request history when fresh observation proves absence', async () => {
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockRejectedValueOnce(new Error('EXAMPLE transport')).mockResolvedValueOnce(reply(snapshot([], 21)));
    expect(await a.cancelTpSlOrders(params)).toMatchObject({ success: true, targets: [{ state: 'absent', requestOutcome: 'unknown' }] });
    expect(sign).toHaveBeenCalledOnce();
  });
  it.each([19, 20])('does not confirm disappearing targets on watermark %s', async (watermark) => {
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce(reply({ success: true })).mockResolvedValueOnce(reply(snapshot([], watermark)));
    expect(await a.cancelTpSlOrders(params)).toMatchObject({ success: false, outcome: 'acknowledged', targets: [{ state: 'unknown' }] });
  });
  it('does not accept the target on a different market as absence evidence', async () => {
    a.getRegistry = () => ({ isKnownInternal: (s: string) => s.endsWith('-PERP'),
      internalToProtocol: (s: string) => s.replace('-PERP', ''), protocolToInternal: (s: string) => s + '-PERP' });
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce(reply({ success: true })).mockResolvedValueOnce(reply(snapshot([row(12, { symbol: 'BTC' })], 21)));
    expect(await a.cancelTpSlOrders(params)).toMatchObject({ success: false, targets: [{ state: 'unknown' }] });
  });
  it('does not share an earlier fresh-required GET or concurrent confirmation reads', async () => {
    let releaseOld!: (value: Response) => void;
    const oldResponse = new Promise<Response>(resolve => { releaseOld = resolve; });
    fetchMock.mockReturnValueOnce(oldResponse)
      .mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce(reply({ success: true }))
      .mockResolvedValueOnce(reply(snapshot([], 21)));
    const oldRead = a.get('/orders', { account }, { cachePolicy: 'fresh-required', responseShape: 'envelope' });
    const result = await a.cancelTpSlOrders(params);
    expect(result.success).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(4);
    releaseOld(reply(snapshot([row()]))); await oldRead;
    fetchMock.mockImplementation(async () => reply(snapshot([], 22)));
    const [one, two] = await Promise.all([a.cancelTpSlOrders(params), a.cancelTpSlOrders(params)]);
    expect(one.evidence.requestId).not.toBe(two.evidence.requestId);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });
  it('bounds a stalled response body and never retries the mutation', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(reply(snapshot([row()])))
      .mockResolvedValueOnce({ status: 200, ok: true, json: () => new Promise(() => {}) } as Response)
      .mockResolvedValueOnce(reply(snapshot([row()], 21)));
    const pending = a.cancelTpSlOrders(params);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(await pending).toMatchObject({ success: false, outcome: 'unknown' });
    expect(sign).toHaveBeenCalledOnce();
  });
  it('quota refusal cannot fall back to cached empty inventory', async () => {
    vi.useFakeTimers();
    pacificaCache.set('/orders?account=EXAMPLE_ACCOUNT:envelope', '/orders', snapshot());
    vi.mocked(pacificaQuota.canAfford).mockReturnValue(false);
    const pending = a.cancelTpSlOrders(params);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(await pending).toMatchObject({ success: false, outcome: 'unknown', dispatch: 'unsent' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

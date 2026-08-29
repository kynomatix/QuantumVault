import { describe, expect, it, vi } from 'vitest';
import {
  protectiveReadNeedsTelemetry,
  verifyLiveProtectiveStop,
  verifyProtectiveStop,
} from '../../server/ai-trader/bracket-verification';
import type {
  OpenProtectiveOrder,
  OpenProtectiveOrderSnapshot,
  ProtocolAdapter,
} from '../../server/protocol/adapter';

const exactLongStop: OpenProtectiveOrder = {
  orderId: 'sl-1',
  internalSymbol: 'SOL-PERP',
  side: 'sell',
  orderType: 'stop_loss',
  triggerPrice: '145',
  reduceOnly: true,
  initialSize: '6.66',
  filledSize: '0',
  cancelledSize: '0',
};

function snapshot(
  orders: OpenProtectiveOrder[],
  incompleteProtectiveRowCount = 0,
  matchingProtectiveRowCount = orders.length + incompleteProtectiveRowCount,
): OpenProtectiveOrderSnapshot {
  return { orders, matchingProtectiveRowCount, incompleteProtectiveRowCount };
}

function classify(
  overrides: Partial<OpenProtectiveOrder> = {},
  input: Partial<{
    internalSymbol: string;
    positionBaseSize: number;
    quantizedStopLossPrice: number;
    incompleteProtectiveRowCount: number;
    matchingProtectiveRowCount: number;
  }> = {},
) {
  const orders = [{ ...exactLongStop, ...overrides }];
  return verifyProtectiveStop({
    snapshot: snapshot(
      orders,
      input.incompleteProtectiveRowCount ?? 0,
      input.matchingProtectiveRowCount ?? orders.length,
    ),
    internalSymbol: input.internalSymbol ?? 'SOL-PERP',
    positionBaseSize: input.positionBaseSize ?? 6.66,
    quantizedStopLossPrice: input.quantizedStopLossPrice ?? 145,
  });
}

describe('verifyProtectiveStop', () => {
  it('accepts an exact quantized reduce-only SL covering a long position', () => {
    expect(classify()).toMatchObject({ status: 'verified', orderId: 'sl-1' });
  });

  it('accepts a tighter long stop and rejects a looser long stop', () => {
    expect(classify({ triggerPrice: '146' }).status).toBe('verified');
    expect(classify({ triggerPrice: '144' }).status).toBe('off_spec');
  });

  it('accepts an equal or tighter buy stop for a short and rejects a looser one', () => {
    expect(classify({ side: 'buy' }, { positionBaseSize: -6.66 }).status).toBe('verified');
    expect(classify({ side: 'buy', triggerPrice: '144' }, { positionBaseSize: -6.66 }).status).toBe('verified');
    expect(classify({ side: 'buy', triggerPrice: '146' }, { positionBaseSize: -6.66 }).status).toBe('off_spec');
  });

  it.each([
    ['wrong side', { side: 'buy' as const }],
    ['wrong market', { internalSymbol: 'ETH-PERP' }],
    ['take profit', { orderType: 'take_profit' as const }],
    ['not reduce-only', { reduceOnly: false }],
    ['undersized remainder', { initialSize: '6.66', filledSize: '0.01' }],
  ])('classifies %s as off-spec when the endpoint row is complete', (_label, order) => {
    expect(classify(order).status).toBe('off_spec');
  });

  it('classifies zero documented rows and incomplete rows as inconclusive', () => {
    expect(verifyProtectiveStop({
      snapshot: snapshot([], 0, 0),
      internalSymbol: 'SOL-PERP',
      positionBaseSize: 6.66,
      quantizedStopLossPrice: 145,
    }).status).toBe('inconclusive');
    expect(verifyProtectiveStop({
      snapshot: snapshot([], 1, 1),
      internalSymbol: 'SOL-PERP',
      positionBaseSize: 6.66,
      quantizedStopLossPrice: 145,
    }).status).toBe('inconclusive');
  });

  it('classifies invalid position, quantization and malformed complete decimals without throwing', () => {
    expect(classify({}, { positionBaseSize: 0 }).status).toBe('unavailable');
    expect(classify({}, { quantizedStopLossPrice: Number.NaN }).status).toBe('unavailable');
    expect(classify({ triggerPrice: 'not-a-decimal' }).status).toBe('off_spec');
  });

  it('rejects exhausted remaining coverage', () => {
    expect(classify({
      initialSize: '6.66',
      filledSize: '1',
      cancelledSize: '5.66',
    }).status).toBe('off_spec');
  });

  it('accepts the one protective stop among duplicate and unrelated rows', () => {
    const orders = [
      { ...exactLongStop, orderId: 'tp', orderType: 'take_profit' as const },
      { ...exactLongStop, orderId: 'loose', triggerPrice: '144' },
      { ...exactLongStop, orderId: 'tight', triggerPrice: '146' },
    ];
    expect(verifyProtectiveStop({
      snapshot: snapshot(orders),
      internalSymbol: 'SOL-PERP',
      positionBaseSize: 6.66,
      quantizedStopLossPrice: 145,
    })).toMatchObject({ status: 'verified', orderId: 'tight' });
  });
});

describe('verifyLiveProtectiveStop', () => {
  function adapter(overrides: Record<string, unknown> = {}): ProtocolAdapter {
    return {
      getOpenProtectiveOrders: vi.fn(async () => snapshot([exactLongStop])),
      getOpenStopOrders: vi.fn(async () => [{ order_id: 'legacy-1', symbol: 'SOL' }]),
      quantizePrice: vi.fn(() => 145),
      ...overrides,
    } as unknown as ProtocolAdapter;
  }

  const input = {
    agentPublicKey: 'account',
    subaccountId: undefined,
    internalSymbol: 'SOL-PERP',
    positionBaseSize: 6.66,
    expectedStopLossPrice: 145.004,
  };

  it('observes exact semantics but keeps legacy presence as action authority', async () => {
    const a = adapter();
    const proof = await verifyLiveProtectiveStop({ adapter: a, ...input });
    expect(proof).toMatchObject({
      status: 'legacy_present',
      legacyRowCount: 1,
      semantic: { status: 'verified', orderId: 'sl-1' },
    });
    expect(a.getOpenProtectiveOrders).toHaveBeenCalledWith('account', 'SOL-PERP');
    expect(a.getOpenStopOrders).toHaveBeenCalledWith('account', undefined, 'SOL-PERP');
    expect(protectiveReadNeedsTelemetry(proof)).toBe(false);
  });

  it('does not turn a semantic disagreement into a money action while legacy is present', async () => {
    const proof = await verifyLiveProtectiveStop({
      adapter: adapter({
        getOpenProtectiveOrders: vi.fn(async () => snapshot([
          { ...exactLongStop, triggerPrice: '144' },
        ])),
      }),
      ...input,
    });
    expect(proof).toMatchObject({ status: 'legacy_present', semantic: { status: 'off_spec' } });
    expect(protectiveReadNeedsTelemetry(proof)).toBe(true);
  });

  it('uses legacy absence as missing even when the semantic read is inconclusive', async () => {
    const proof = await verifyLiveProtectiveStop({
      adapter: adapter({
        getOpenProtectiveOrders: vi.fn(async () => snapshot([], 0, 0)),
        getOpenStopOrders: vi.fn(async () => []),
      }),
      ...input,
    });
    expect(proof).toMatchObject({ status: 'legacy_missing', legacyRowCount: 0, semantic: { status: 'inconclusive' } });
  });

  it('preserves legacy authority when semantic observation fails or is unavailable', async () => {
    const failed = await verifyLiveProtectiveStop({
      adapter: adapter({ getOpenProtectiveOrders: vi.fn(async () => { throw new Error('429'); }) }),
      ...input,
    });
    expect(failed).toMatchObject({ status: 'legacy_present', semantic: { status: 'unavailable' } });

    const absent = await verifyLiveProtectiveStop({
      adapter: adapter({ getOpenProtectiveOrders: undefined }),
      ...input,
    });
    expect(absent).toMatchObject({ status: 'legacy_present', semantic: { status: 'unavailable' } });
  });

  it('classifies a legacy read failure as unavailable regardless of semantic observation', async () => {
    const proof = await verifyLiveProtectiveStop({
      adapter: adapter({ getOpenStopOrders: vi.fn(async () => { throw new Error('legacy 503'); }) }),
      ...input,
    });
    expect(proof).toMatchObject({ status: 'legacy_unavailable', detail: expect.stringContaining('503') });
  });

  it('makes a quantization throw semantic-unavailable without disabling legacy G10', async () => {
    const proof = await verifyLiveProtectiveStop({
      adapter: adapter({ quantizePrice: vi.fn(() => { throw new Error('registry cold'); }) }),
      ...input,
    });
    expect(proof).toMatchObject({ status: 'legacy_present', semantic: { status: 'unavailable' } });
  });
});

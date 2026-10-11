import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PacificaAdapter } from '../../server/protocol/pacifica/pacifica-adapter.js';
import { pacificaCache } from '../../server/protocol/pacifica/pacifica-cache.js';
import { pacificaQuota } from '../../server/protocol/pacifica/pacifica-quota.js';
import { updateMarketCache, getMarketInfo } from '../../server/market-registry.js';
import { getMinOrderSize, getMinOrderSizeUsd } from '../../server/market-liquidity-service.js';
import { evaluateNotionalFloor } from '../../server/trade-sizing-math.js';
import { PacificaSigner } from '../../server/protocol/pacifica/pacifica-signer.js';
import {
  observePacificaConstraints, checkEntryConstraints, evaluateOpeningMinimum,
  isValidMultiple, checkMarkPrice, unavailableMark, parseVenueDecimal, marketConstraintView, checkOpeningEffectAuthority,
} from '../../server/protocol/market-constraints.js';

afterEach(() => vi.restoreAllMocks());

describe('Pacifica market constraint authority', () => {
  describe.each([
    ['min_order_size', 'openingMinimum'], ['tick_size', 'tick'], ['lot_size', 'lot'],
  ] as const)('invalid %s authority', (field, observedField) => {
    it.each([
      ['missing', undefined], ['null', null], ['empty', ''], ['whitespace', ' \t\n'],
      ['malformed', 'abc'], ['prefix junk', '1junk'], ['zero', '0'], ['negative', '-1'],
      ['string NaN', 'NaN'], ['string Infinity', 'Infinity'], ['string -Infinity', '-Infinity'],
      ['overflow', '1e999'], ['numeric NaN', NaN], ['numeric Infinity', Infinity],
      ['numeric -Infinity', -Infinity], ['numeric zero', 0], ['numeric negative', -1],
      ['numeric positive', 10], ['boolean true', true], ['boolean false', false],
      ['object', {}], ['array', ['10']],
    ])('rejects %s through cache, registry, liquidity, sizing and submission', async (_label, raw) => {
      const row: Record<string, unknown> = { symbol: 'SOL', tick_size: '0.1', lot_size: '0.01',
        min_order_size: '10', max_leverage: 10 };
      if (raw === undefined) delete row[field];
      else row[field] = raw;
      const adapter = new PacificaAdapter();
      const get = vi.spyOn(adapter as any, 'get').mockResolvedValue([row]);
      const enrollment = vi.spyOn(adapter as any, 'ensurePacificaEnrollment');
      const post = vi.spyOn(adapter as any, 'post');
      const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody');
      try {
        await adapter.initialize();
        const markets = await adapter.getMarkets();
        const observation = markets[0].constraintObservation!;
        expect(observation[observedField]).toBeNull();
        for (const validField of ['openingMinimum', 'tick', 'lot'] as const) {
          if (validField !== observedField) expect(observation[validField]).not.toBeNull();
        }
        expect((adapter as any).marketDetailsMap.get('SOL-PERP').constraintObservation).toBe(observation);
        updateMarketCache(markets);
        const registered = getMarketInfo('SOL-PERP')!;
        expect(registered.constraintObservation).toBe(observation);
        expect(checkEntryConstraints(observation, 'SOL-PERP', Date.now()))
          .toMatchObject({ ok: false, code: 'constraint_unavailable' });
        for (const market of [markets[0], registered, (adapter as any).marketDetailsMap.get('SOL-PERP')]) {
          for (const name of ['tickSize', 'lotSize', 'minOrderSizeBase', 'minOrderSizeUsd']) {
            expect(market[name]).toBeUndefined();
          }
        }
        const lot = getMinOrderSize('sol');
        const minimum = getMinOrderSizeUsd('sol-perp');
        expect(lot).toBeNull();
        expect(minimum).toBeNull();
        expect(evaluateNotionalFloor(1, 100, minimum as any, lot as any)).toMatchObject({ rejected: true });
        expect(evaluateOpeningMinimum({ kind: 'market', quantityBase: 1, mark: 100 }, minimum as any))
          .toMatchObject({ ok: false });
        expect(() => adapter.quantizeOrderSize('SOL-PERP', 1)).toThrow(/constraints unavailable/);
        const intent = { agentPublicKey: 'account', agentSecretKey: new Uint8Array(64),
          mainWalletAddress: 'wallet', internalSymbol: 'SOL-PERP', side: 'long' as const, sizeBase: 1 };
        const results = [await adapter.placeMarketOrder(intent),
          await adapter.placeLimitOrder({ ...intent, price: 100, timeInForce: 'GTC' }),
          await adapter.placeStopOrder({ ...intent, triggerPrice: 100 })];
        for (const result of results) expect(result.constraintRejection)
          .toMatchObject({ code: 'constraint_unavailable' });
        expect(enrollment).not.toHaveBeenCalled();
        expect(sign).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        expect(get).toHaveBeenCalledTimes(1);
      } finally {
        updateMarketCache([]);
        await adapter.shutdown();
      }
    });
  });

  it('retains exact values and the original observation time', () => {
    const observation = observePacificaConstraints({
      tick_size: '0.1', lot_size: '0.0001', min_order_size: '10.00',
    }, 'ETH-PERP', 1_000);
    expect(observation.openingMinimum).toEqual({ exact: '10.00', value: 10, unit: 'USD' });
    expect(observation.tick?.unit).toBe('price');
    expect(observation.lot?.unit).toBe('base');
    expect(checkEntryConstraints(observation, 'ETH-PERP', 301_000)).toEqual({ ok: true });
    expect(checkEntryConstraints(observation, 'ETH-PERP', 301_001).ok).toBe(false);
    expect(checkEntryConstraints(observation, 'BTC-PERP', 1_000).ok).toBe(false);
    observation.refreshFailed = true;
    expect(checkEntryConstraints(observation, 'ETH-PERP', 1_001).ok).toBe(false);
  });

  it('checks the binding signed limit and current mark independently', () => {
    const base = { kind: 'limit' as const, quantityBase: 0.1, limit: 99,
      mark: 101 };
    expect(evaluateOpeningMinimum(base, 10)).toMatchObject({
      ok: false, code: 'below_opening_minimum', candidate: 'limit', floorUsd: 10,
    });
    expect(evaluateOpeningMinimum({ ...base, limit: 105, mark: 99 }, 10)).toMatchObject({
      ok: false, candidate: 'mark',
    });
    expect(evaluateOpeningMinimum({ ...base, limit: 105, ...{ oracle: 1 } }, 10)).toEqual({ ok: true });
  });

  it('checks a market opening only at the mark', () => {
    expect(evaluateOpeningMinimum({ kind: 'market', quantityBase: 1,
      mark: 10.02, ...{ oracle: 1, marketSlippagePercent: 99 } }, 10))
      .toEqual({ ok: true });
  });

  it('checks a stop opening at both its trigger and the mark', () => {
    expect(evaluateOpeningMinimum({ kind: 'stop_market', quantityBase: 1,
      mark: 11, trigger: 9.9 }, 10)).toMatchObject({
      ok: false, candidate: 'trigger',
    });
    expect(evaluateOpeningMinimum({ kind: 'stop_market', quantityBase: 1,
      mark: 9.9, trigger: 11 }, 10)).toMatchObject({
      ok: false, candidate: 'mark', floorUsd: 10,
    });
    expect(evaluateOpeningMinimum({ kind: 'stop_market', quantityBase: 1,
      mark: 11, trigger: 10 }, 10)).toEqual({ ok: true });
  });

  it('rejects a missing mark with the typed unavailable price and floor', () => {
    expect(evaluateOpeningMinimum({ kind: 'market', quantityBase: 1 }, 10)).toMatchObject({
      ok: false, code: 'price_unavailable', candidate: 'mark', floorUsd: 10,
    });
    expect(evaluateOpeningMinimum({ kind: 'limit', quantityBase: 1, limit: 11 }, 10))
      .toMatchObject({ ok: false, code: 'price_unavailable', candidate: 'mark', floorUsd: 10 });
  });

  it('bypasses the opening floor for a sub-$10 reduce-only close and validates increments', () => {
    expect(evaluateOpeningMinimum({ kind: 'market', quantityBase: 0.001,
      reduceOnly: true }, 10)).toEqual({ ok: true });
    expect(evaluateOpeningMinimum({ kind: 'limit', quantityBase: 0.4, limit: 10,
      mark: 10, reduceOnly: true }, 10)).toEqual({ ok: true });
    expect(isValidMultiple(0.0003, 0.0001)).toBe(true);
    expect(isValidMultiple(0.00035, 0.0001)).toBe(false);
  });

  it('rejects a direct market entry on the binding fresh mark before enrollment', async () => {
    const adapter = new PacificaAdapter();
    const get = vi.fn(async (path: string) => path === '/info'
      ? [{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 }]
      : { success: true, data: [{ symbol: 'SOL', mark: '9.9', oracle: '11', timestamp: Date.now() }] });
    Object.defineProperty(adapter, 'get', { value: get });
    await adapter.initialize();
    const result = await adapter.placeMarketOrder({
      agentPublicKey: 'account', agentSecretKey: new Uint8Array(64), mainWalletAddress: 'wallet',
      internalSymbol: 'SOL-PERP', side: 'long', sizeBase: 1,
    });
    expect(result.constraintRejection).toMatchObject({ code: 'below_opening_minimum',
      candidate: 'mark', floorUsd: 10 });
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/info', '/info/prices']);
    await adapter.shutdown();
  });

  it('admits a direct opening with a fresh mark and no oracle', async () => {
    const adapter = new PacificaAdapter();
    const get = vi.fn(async (path: string) => path === '/info'
      ? [{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 }]
      : { success: true, data: [{ symbol: 'SOL', mark: '11', timestamp: Date.now() }] });
    const enrollment = vi.fn(async () => { throw new Error('enrollment reached'); });
    Object.defineProperty(adapter, 'get', { value: get });
    Object.defineProperty(adapter, 'ensurePacificaEnrollment', { value: enrollment });
    await adapter.initialize();
    await expect(adapter.placeMarketOrder({
      agentPublicKey: 'account', agentSecretKey: new Uint8Array(64), mainWalletAddress: 'wallet',
      internalSymbol: 'SOL-PERP', side: 'long', sizeBase: 1,
    })).rejects.toThrow('enrollment reached');
    expect(enrollment).toHaveBeenCalledOnce();
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/info', '/info/prices']);
    await adapter.shutdown();
  });

  it('rejects a direct opening with a missing mark before enrollment', async () => {
    const adapter = new PacificaAdapter();
    const get = vi.fn(async (path: string) => path === '/info'
      ? [{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 }]
      : { success: true, data: [{ symbol: 'SOL', oracle: '11', timestamp: Date.now() }] });
    const enrollment = vi.fn();
    Object.defineProperty(adapter, 'get', { value: get });
    Object.defineProperty(adapter, 'ensurePacificaEnrollment', { value: enrollment });
    await adapter.initialize();
    const result = await adapter.placeMarketOrder({
      agentPublicKey: 'account', agentSecretKey: new Uint8Array(64), mainWalletAddress: 'wallet',
      internalSymbol: 'SOL-PERP', side: 'long', sizeBase: 1,
    });
    expect(result.constraintRejection).toMatchObject({ code: 'mark_price_unavailable',
      candidate: 'mark', floorUsd: 10 });
    expect(enrollment).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([path]) => path)).toEqual(['/info', '/info/prices']);
    await adapter.shutdown();
  });

  it('rejects an incomplete direct entry before an order effect', async () => {
    const adapter = new PacificaAdapter();
    const get = vi.fn(async () => [{ symbol: 'SOL', tick_size: '0.1', lot_size: '',
      min_order_size: '10', max_leverage: 10 }]);
    Object.defineProperty(adapter, 'get', { value: get });
    await adapter.initialize();
    const result = await adapter.placeStopOrder({
      agentPublicKey: 'account', agentSecretKey: new Uint8Array(64), mainWalletAddress: 'wallet',
      internalSymbol: 'SOL-PERP', side: 'long', sizeBase: 1, triggerPrice: 10,
    });
    expect(result.constraintRejection).toMatchObject({ code: 'constraint_unavailable' });
    expect(get).toHaveBeenCalledTimes(1);
    await adapter.shutdown();
  });

  it.each(['market quantity', 'limit price', 'stop trigger'] as const)(
    'rejects an off-increment direct %s before enrollment or signing', async (field) => {
      const adapter = new PacificaAdapter();
      const get = vi.fn(async (_path: string) => [{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1',
        min_order_size: '10', max_leverage: 10 }]);
      const enrollment = vi.fn();
      Object.defineProperty(adapter, 'get', { value: get });
      Object.defineProperty(adapter, 'ensurePacificaEnrollment', { value: enrollment });
      await adapter.initialize();
      const shared = { agentPublicKey: 'account', agentSecretKey: new Uint8Array(64),
        mainWalletAddress: 'wallet', internalSymbol: 'SOL-PERP', side: 'long' as const };
      const result = field === 'market quantity'
        ? await adapter.placeMarketOrder({ ...shared, sizeBase: 1.05 })
        : field === 'limit price'
          ? await adapter.placeLimitOrder({ ...shared, sizeBase: 1, price: 10.05, timeInForce: 'GTC' })
          : await adapter.placeStopOrder({ ...shared, sizeBase: 1, triggerPrice: 10.05 });
      expect(result.constraintRejection).toMatchObject({ code: 'invalid_intended_order' });
      expect(enrollment).not.toHaveBeenCalled();
      expect(get.mock.calls.map(([path]) => path)).toEqual(['/info']);
      await adapter.shutdown();
    },
  );

  it.each(['market', 'limit', 'stop'] as const)(
    'rejects the near-lot opening counterexample on the %s path before effects', async (kind) => {
      const adapter = new PacificaAdapter();
      const get = vi.fn(async (path: string) => path === '/info'
        ? [{ symbol: 'SOL', tick_size: '0.00000001', lot_size: '0.1',
          min_order_size: '10', max_leverage: 10 }]
        : { success: true, data: [{ symbol: 'SOL', mark: '99.99999997', timestamp: Date.now() }] });
      const enrollment = vi.fn();
      Object.defineProperty(adapter, 'get', { value: get });
      Object.defineProperty(adapter, 'ensurePacificaEnrollment', { value: enrollment });
      await adapter.initialize();
      const shared = { agentPublicKey: 'account', agentSecretKey: new Uint8Array(64),
        mainWalletAddress: 'wallet', internalSymbol: 'SOL-PERP', side: 'long' as const,
        sizeBase: 0.10000000005 };
      const result = kind === 'market'
        ? await adapter.placeMarketOrder(shared)
        : kind === 'limit'
          ? await adapter.placeLimitOrder({ ...shared, price: 99.99999997, timeInForce: 'GTC' })
          : await adapter.placeStopOrder({ ...shared, triggerPrice: 99.99999997 });
      expect(result.constraintRejection).toMatchObject({ code: 'invalid_intended_order' });
      expect(enrollment).not.toHaveBeenCalled();
      expect(get.mock.calls.map((call) => call[0])).toEqual(['/info']);
      await adapter.shutdown();
    },
  );

  it('reads a fresh tick before quantizing a reduction', async () => {
    const adapter = new PacificaAdapter();
    const get = vi.fn()
      .mockResolvedValueOnce([{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1',
        min_order_size: '10', max_leverage: 10 }])
      .mockResolvedValueOnce([{ symbol: 'SOL', tick_size: '0.01', lot_size: '0.1',
        min_order_size: '10', max_leverage: 10 }]);
    Object.defineProperty(adapter, 'get', { value: get });
    await adapter.initialize();
    (adapter as any).marketDetailsMap.get('SOL-PERP').constraintObservation.refreshFailed = true;
    expect(await adapter.quantizeReductionPrice('SOL-PERP', 10.04)).toBe(10.04);
    expect(get).toHaveBeenCalledTimes(2);
    await adapter.shutdown();
  });

  it('uses a bounded saved tick for a reduction after a failed fresh read', async () => {
    const adapter = new PacificaAdapter();
    const get = vi.fn()
      .mockResolvedValueOnce([{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1',
        min_order_size: '10', max_leverage: 10 }])
      .mockRejectedValueOnce(new Error('offline'));
    Object.defineProperty(adapter, 'get', { value: get });
    await adapter.initialize();
    (adapter as any).marketDetailsMap.get('SOL-PERP').constraintObservation.refreshFailed = true;
    expect(await adapter.quantizeReductionPrice('SOL-PERP', 10.04)).toBe(10);
    expect(get).toHaveBeenCalledTimes(2);
    const market = (await adapter.getMarkets()).find(m => m.internalSymbol === 'SOL-PERP');
    expect(checkEntryConstraints(market?.constraintObservation, 'SOL-PERP', Date.now()).ok).toBe(false);
    await adapter.shutdown();
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

describe('Round 2 mark and exit settlements', () => {
  function subject() {
    const adapter = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' }) as any;
    adapter.getRegistry = () => ({ internalToProtocol: () => 'SOL', protocolToInternal: () => 'SOL-PERP' });
    return adapter;
  }
  const intent = { agentPublicKey: 'account', internalSymbol: 'SOL-PERP', subaccountId: '1' };
  const evidence = (baseSize = 2, observedAt = Date.now()) => ({ venue: 'pacifica', source: '/positions',
    account: 'account', internalSymbol: 'SOL-PERP', subaccountId: '1', observedAt, baseSize });

  it('proves the network-denying fallback fires on an unmocked HTTP call', async () => {
    await expect(fetch('https://unmocked.invalid/info')).rejects.toThrow('Unmocked HTTP denied');
    expect(deniedHttp.splice(0)).toEqual(['https://unmocked.invalid/info']);
  });

  it.each([
    [undefined, 'invalid_envelope'], [{ success: false, data: [] }, 'invalid_envelope'],
    [{ success: true, data: [] }, 'symbol_missing'],
    [{ success: true, data: [{ symbol: 'SOL' }, { symbol: 'SOL' }] }, 'symbol_ambiguous'],
    [{ success: true, data: [{ symbol: 'SOL', mark: '1junk', timestamp: 1000 }] }, 'invalid_mark'],
    [{ success: true, data: [{ symbol: 'SOL', mark: '1', timestamp: '1000' }] }, 'invalid_timestamp'],
  ])('rejects malformed mark envelope %# with typed provenance', async (envelope, reason) => {
    const a = subject(); a.get = vi.fn(async () => envelope);
    expect(await a.getMarkPrice('SOL-PERP')).toMatchObject({ kind: 'unavailable', code: 'mark_price_unavailable',
      reason, internalSymbol: 'SOL-PERP', protocolSymbol: 'SOL', source: '/info/prices', field: 'mark' });
    expect(a.get).toHaveBeenCalledWith('/info/prices', undefined,
      { priority: 'normal', cachePolicy: 'fresh-required', responseShape: 'envelope' });
  });

  it('uses original venue time and accepts exactly five seconds without requiring oracle', async () => {
    const a = subject(); vi.spyOn(Date, 'now').mockReturnValue(6000);
    a.get = vi.fn(async () => ({ success: true, data: [{ symbol: 'SOL', mark: '10.00', timestamp: 1000 }] }));
    const mark = await a.getMarkPrice('SOL-PERP');
    expect(mark).toMatchObject({ kind: 'available', exact: '10.00', observedAt: 1000, receivedAt: 6000, expiresAt: 6000 });
    expect(checkMarkPrice(mark, 'SOL-PERP', 6001)).toMatchObject({ reason: 'stale' });
    expect(checkMarkPrice(mark, 'SOL-PERP', 5999)).toMatchObject({ reason: 'clock_regression' });
    a.get.mockResolvedValue({ success: true, data: [{ symbol: 'SOL', mark: '10', timestamp: 6001 }] });
    expect(await a.getMarkPrice('SOL-PERP')).toMatchObject({ reason: 'future_timestamp' });
  });

  it('omits all compatibility numbers when one field is unavailable', () => {
    const view = marketConstraintView(observePacificaConstraints({ tick_size: '1', lot_size: '1', min_order_size: '' }, 'SOL-PERP', 1000), 1000);
    expect(view.constraintAuthority.state).toBe('unavailable');
    for (const field of ['tickSize', 'lotSize', 'minOrderSizeBase', 'minOrderSizeUsd']) expect(Object.hasOwn(view, field)).toBe(false);
  });

  it('uses caller venue evidence during strict outage with ceil lot quantization', async () => {
    const a = subject(); a.getStrictPositionForMarket = vi.fn(async () => { throw new Error('outage'); });
    a.getExitStep = vi.fn(async () => 0.1);
    expect(await a.prepareReduction({ ...intent, side: 'short', sizeBase: 0.25, reductionContext: evidence() }, false))
      .toEqual({ ok: true, size: 0.3, tick: null });
  });

  it('submits a fallback reduction above its retained observation under venue reduce-only enforcement', async () => {
    const a = subject(); a.getStrictPositionForMarket = vi.fn(async () => { throw new Error('outage'); });
    a.getExitStep = vi.fn(async () => 0.1);
    a.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: false }));
    a.post = vi.fn(async () => ({ order_id: 'reduction-1', status: 'filled' }));
    a.mapOrderResponse = vi.fn(() => ({ success: true, status: 'filled' }));
    const signed = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType: string, data: Record<string, unknown>) => ({ ...data, signature: 'test' }) as any,
    );
    await a.placeMarketOrder({ ...intent, agentSecretKey: new Uint8Array(64), mainWalletAddress: 'owner',
      side: 'short', sizeBase: 3, reduceOnly: true, reductionContext: evidence(2) });
    expect(signed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      amount: '3', reduce_only: true, side: 'ask',
    }), 'account', null);
    expect(a.post).toHaveBeenCalledWith('/orders/create_market', expect.objectContaining({
      amount: '3', reduce_only: true,
    }));
  });

  it('r2j fallback full close never rounds above its requested size and preserves partial outcome', async () => {
    const a = subject();
    a.getStrictPositionForMarket = vi.fn(async () => { throw new Error('outage'); });
    a.getExitStep = vi.fn(async () => 0.01);
    a.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: false }));
    a.post = vi.fn(async () => ({ order_id: 'fallback-close', status: 'partial' }));
    a.mapOrderResponse = vi.fn(() => ({ success: true, status: 'partial', fillSize: 0.01, remainingSize: 0.005 }));
    const signed = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
      (_operationType: string, data: Record<string, unknown>) => ({ ...data, signature: 'test' }) as any,
    );
    const result = await a.closePosition({ ...intent, agentSecretKey: new Uint8Array(64),
      mainWalletAddress: 'owner', reductionContext: evidence(0.015) });
    expect(signed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      amount: '0.015', reduce_only: true, side: 'ask',
    }), 'account', null);
    expect(a.post).toHaveBeenCalledOnce();
    expect(a.post).toHaveBeenCalledWith('/orders/create_market', expect.objectContaining({ amount: '0.015', reduce_only: true }));
    expect(result).toMatchObject({ success: false, status: 'partial', fillSize: 0.01,
      remainingSize: 0.005, error: 'Close execution is not terminal (partial)' });
  });

  it('keeps the local ceiling for a current authoritative position', async () => {
    const a = subject(); a.getStrictPositionForMarket = vi.fn(async () => ({ baseSize: 2 }));
    a.getExitStep = vi.fn(async () => 0.1);
    expect(await a.prepareReduction({ ...intent, side: 'short', sizeBase: 3, reductionContext: evidence(2) }, false))
      .toMatchObject({ ok: true, size: 2 });
  });

  it.each([
    ['provision deposit', 'provision', 0, 1],
    ['provision create', 'provision', 100, 1],
    ['provision transfer', 'provision', 100, 2],
    ['reuse deposit', 'reuse', 0, 1],
    ['reuse transfer', 'reuse', 100, 1],
  ] as const)('rechecks before %s and makes no lapsed effect', async (_site, flow, balance, failAt) => {
    const a = subject();
    a.getAccountInfo = vi.fn(async () => ({ exists: true, balance }));
    a.executeDeposit = vi.fn(async () => ({ success: true }));
    a.createSubaccount = vi.fn(async () => ({ subaccountId: 'sub' }));
    a.transferBetweenSubaccounts = vi.fn(async () => ({ success: true }));
    let checks = 0;
    const beforeOpeningEffect = vi.fn(async () => { if (++checks === failAt) throw new Error('authority lapsed'); });
    const input = { mainSecretKey: new Uint8Array(64), subSecretKey: new Uint8Array(64),
      agentPublicKey: 'account', fundingAmount: 10, subaccountId: 'sub', beforeOpeningEffect };
    try {
      if (flow === 'provision') await a.provisionFundedSubaccount(input);
      else await a.reuseSubaccount(input);
    } catch (error) { expect(String(error)).toContain('authority lapsed'); }
    expect(beforeOpeningEffect).toHaveBeenCalledTimes(failAt);
    if (_site.endsWith('deposit')) expect(a.executeDeposit).not.toHaveBeenCalled();
    if (_site.endsWith('create')) expect(a.createSubaccount).not.toHaveBeenCalled();
    if (_site.endsWith('transfer')) expect(a.transferBetweenSubaccounts).not.toHaveBeenCalled();
  });

  it.each([
    ['provision deposit', 'provision', 0, 1],
    ['provision create', 'provision', 100, 1],
    ['provision transfer', 'provision', 100, 2],
    ['reuse deposit', 'reuse', 0, 1],
    ['reuse transfer', 'reuse', 100, 1],
  ] as const)('denies lapsed venue authority before %s', async (site, flow, balance, failAt) => {
    for (const lapse of ['stale_mark', 'failed_read', 'expired_constraints'] as const) {
      const a = subject();
      const now = Date.now();
      let checks = 0;
      a.getMarkets = vi.fn(async () => [{ internalSymbol: 'SOL-PERP', protocolSymbol: 'SOL',
        constraintObservation: observePacificaConstraints({ tick_size: '0.1', lot_size: '0.1', min_order_size: '10' },
          'SOL-PERP', lapse === 'expired_constraints' && checks === failAt ? now - 301_000 : now) }]);
      a.getMarkPrice = vi.fn(async () => lapse === 'failed_read' && checks === failAt
        ? unavailableMark('SOL-PERP', 'SOL', 'transport_failed')
        : { kind: 'available' as const, venue: 'pacifica' as const, internalSymbol: 'SOL-PERP',
          protocolSymbol: 'SOL', source: '/info/prices' as const, field: 'mark' as const, exact: '11',
          observedAt: lapse === 'stale_mark' && checks === failAt ? now - 5_001 : now,
          receivedAt: now, expiresAt: lapse === 'stale_mark' && checks === failAt ? now - 1 : now + 5_000 });
      a.getAccountInfo = vi.fn(async () => ({ exists: true, balance }));
      a.executeDeposit = vi.fn(async () => ({ success: true }));
      a.createSubaccount = vi.fn(async () => ({ subaccountId: 'sub' }));
      a.transferBetweenSubaccounts = vi.fn(async () => ({ success: true }));
      expect((await checkOpeningEffectAuthority(a, 'SOL-PERP')).ok).toBe(true);
      const beforeOpeningEffect = async () => {
        checks++;
        const authority = await checkOpeningEffectAuthority(a, 'SOL-PERP');
        if (!authority.ok) throw new Error(authority.reason);
      };
      const input = { mainSecretKey: new Uint8Array(64), subSecretKey: new Uint8Array(64),
        agentPublicKey: 'account', fundingAmount: 10, subaccountId: 'sub', beforeOpeningEffect };
      try {
        if (flow === 'provision') await a.provisionFundedSubaccount(input);
        else await a.reuseSubaccount(input);
      } catch (error) { expect(String(error)).toMatch(/SOL-PERP|mark|constraint|stale|transport_failed/); }
      expect(checks).toBe(failAt);
      if (site.endsWith('deposit')) expect(a.executeDeposit).not.toHaveBeenCalled();
      if (site.endsWith('create')) expect(a.createSubaccount).not.toHaveBeenCalled();
      if (site.endsWith('transfer')) expect(a.transferBetweenSubaccounts).not.toHaveBeenCalled();
    }
  });

  it.each(['stale', 'read_failed', 'constraint_expired'] as const)(
    'denies a lapsed %s immediately before an opening effect', async (caseName) => {
      const now = Date.now();
      const observation = observePacificaConstraints({ tick_size: '0.1', lot_size: '0.1', min_order_size: '10' },
        'SOL-PERP', caseName === 'constraint_expired' ? now - 301_000 : now);
      const effect = vi.fn();
      const adapter = { protocolName: 'pacifica',
        getMarkets: vi.fn(async () => [{ internalSymbol: 'SOL-PERP', protocolSymbol: 'SOL', constraintObservation: observation }]),
        getMarkPrice: vi.fn(async () => caseName === 'read_failed'
          ? unavailableMark('SOL-PERP', 'SOL', 'transport_failed')
          : { kind: 'available' as const, venue: 'pacifica' as const, internalSymbol: 'SOL-PERP',
            protocolSymbol: 'SOL', source: '/info/prices' as const, field: 'mark' as const, exact: '11',
            observedAt: now - 5_001, receivedAt: now, expiresAt: now - 1 }),
      };
      const authority = await checkOpeningEffectAuthority(adapter as any, 'SOL-PERP');
      if (authority.ok) effect();
      expect(authority.ok).toBe(false);
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it('uses retained validated evidence and rejects identity-conflicting caller evidence', async () => {
    const a = subject();
    a.get = vi.fn(async () => [{ symbol: 'SOL', side: 'bid', amount: '2', entry_price: '10' }]);
    await a.getStrictPositionForMarket('account', 'SOL-PERP', '1');
    a.get.mockRejectedValue(new Error('outage'));
    const result = await a.resolveReductionPosition({ ...intent, reductionContext: { ...evidence(99), account: 'wrong' } });
    expect(result).toMatchObject({ ok: true, position: { baseSize: 2 } });
    expect(await a.resolveReductionPosition({ ...intent, subaccountId: 'different' })).toMatchObject({ ok: false,
      rejection: { code: 'exit_position_sources_exhausted', missing: ['side', 'amount'] } });
  });

  it('does not override valid current absence with old caller or retained evidence', async () => {
    const a = subject(); a.get = vi.fn(async () => []);
    const old = evidence(2, Date.now() - 1000);
    expect(await a.resolveReductionPosition({ ...intent, reductionContext: old })).toEqual({ ok: true, position: null });
    a.get.mockRejectedValue(new Error('outage'));
    expect(await a.resolveReductionPosition({ ...intent, reductionContext: old })).toMatchObject({ ok: false,
      rejection: { code: 'exit_position_sources_exhausted' } });
  });

  it('stops after enrollment when refreshed mark authority fails before signing', async () => {
    const a = subject();
    a.getMarkets = vi.fn(async () => { a.marketDetailsMap.set('SOL-PERP', { constraintObservation:
      observePacificaConstraints({ tick_size: '0.1', lot_size: '0.1', min_order_size: '10' }, 'SOL-PERP', Date.now()) }); return []; });
    a.getMarkPrice = vi.fn().mockResolvedValueOnce({ kind: 'available', venue: 'pacifica', internalSymbol: 'SOL-PERP',
      protocolSymbol: 'SOL', source: '/info/prices', field: 'mark', exact: '11', observedAt: Date.now(), receivedAt: Date.now(), expiresAt: Date.now() + 5000 })
      .mockResolvedValue(unavailableMark('SOL-PERP', 'SOL', 'transport_failed'));
    a.ensurePacificaEnrollment = vi.fn(async () => ({ builderApproved: false }));
    a.post = vi.fn();
    const result = await a.placeMarketOrder({ ...intent, side: 'long', sizeBase: 1,
      agentSecretKey: new Uint8Array(64), mainWalletAddress: 'wallet' });
    expect(result.constraintRejection).toMatchObject({ code: 'mark_price_unavailable' });
    expect(a.ensurePacificaEnrollment).toHaveBeenCalledOnce();
    expect(a.post).not.toHaveBeenCalled();
  });
});


describe('H.53 exit rounding and display refresh', () => {
  it.each([[0.03, 0.02], [0.017, 0.017], [0.01, 0.01]])(
    'rounds a 0.015 partial reduction up to the 0.01 lot capped at position %s', async (position, expected) => {
      const a = new PacificaAdapter() as any;
      a.getStrictPositionForMarket = vi.fn(async () => ({ baseSize: position }));
      a.getExitStep = vi.fn(async () => 0.01);
      for (const needsTick of [false, true]) {
        expect(await a.prepareReduction({ agentPublicKey: 'account', internalSymbol: 'SOL-PERP',
          side: 'short', sizeBase: 0.015 }, needsTick)).toMatchObject({ ok: true, size: expected });
      }
    });
  it('rounds an ordinary fallback partial reduction up without treating its evidence as a current cap', async () => {
    const a = new PacificaAdapter() as any;
    a.resolveReductionPosition = vi.fn(async () => ({ ok: true, position: { baseSize: 0.015 }, current: false }));
    a.getExitStep = vi.fn(async () => 0.01);
    expect(await a.prepareReduction({ agentPublicKey: 'account', internalSymbol: 'SOL-PERP',
      side: 'short', sizeBase: 0.015 }, false)).toMatchObject({ ok: true, size: 0.02 });
  });
  it.each([[0.21, 1, 0.3], [0.3, 0.3, 0.3], [0.21, 0.25, 0.25], [3, 2, 2]])(
    'ceil reduction %s remains capped at position %s', async (requested, position, expected) => {
      const residualReport = vi.spyOn(console, 'info').mockImplementation(() => {});
      const a = new PacificaAdapter() as any;
      a.getStrictPositionForMarket = vi.fn(async () => ({ baseSize: position }));
      a.getExitStep = vi.fn(async () => 0.1);
      expect(await a.prepareReduction({ agentPublicKey: 'account', internalSymbol: 'SOL-PERP',
        side: 'short', sizeBase: requested }, false)).toMatchObject({ ok: true, size: expected });
      if (position > expected) expect(residualReport).toHaveBeenCalledWith(expect.stringContaining('residual base size'));
      residualReport.mockRestore();
    });
  it('ceil uses a refreshed lot after the saved observation expires', async () => {
    const adapter = new PacificaAdapter();
    const get = vi.fn().mockResolvedValue([{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 }]);
    Object.defineProperty(adapter, 'get', { value: get });
    await adapter.initialize();
    (adapter as any).marketDetailsMap.get('SOL-PERP').constraintObservation.observedAt = Date.now() - 300001;
    await expect(adapter.quantizeOrderSizeCeil('SOL-PERP', 0.21)).resolves.toBe(0.3);
    expect(get).toHaveBeenCalledTimes(2);
    await adapter.shutdown();
  });
  it('successful refresh does not permanently revoke shared display observations; failure does', async () => {
    const adapter = new PacificaAdapter();
    const get = vi.fn().mockResolvedValue([{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 }]);
    Object.defineProperty(adapter, 'get', { value: get });
    await adapter.initialize();
    const before = (await adapter.getMarkets())[0];
    (adapter as any).marketCache.fetchedAt = 0;
    const after = (await adapter.getMarkets())[0];
    expect(before.constraintObservation?.refreshFailed).toBe(false);
    expect(after.constraintObservation?.refreshFailed).toBe(false);
    (adapter as any).marketCache.fetchedAt = 0;
    get.mockRejectedValueOnce(new Error('refresh failed'));
    await expect(adapter.getMarkets()).rejects.toThrow('refresh failed');
    expect(after.constraintObservation?.refreshFailed).toBe(true);
    expect(after.constraintAuthority?.state).toBe('unavailable');
    await adapter.shutdown();
  });
});


describe('constraint observation boundary regressions', () => {
  it.each(['10\n', '10\r\n', '10\t', ' 10', '10 '])('rejects whitespace in every decimal field: %j', raw => {
    for (const unit of ['base', 'price', 'USD'] as const) expect(parseVenueDecimal(raw, unit)).toBeNull();
  });

  it('keeps independent exit fields across invalid refreshes without renewing their age', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const adapter = new PacificaAdapter();
    const valid = { symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 };
    const get = vi.fn().mockResolvedValue([valid]);
    Object.defineProperty(adapter, 'get', { value: get });
    try {
      await adapter.initialize();
      const prior = (await adapter.getMarkets())[0];
      clock.mockReturnValue(1_001_000);
      (adapter as any).marketCache.fetchedAt = 0;
      get.mockResolvedValue([{ ...valid, lot_size: '', tick_size: '0.5' }]);
      const invalid = (await adapter.getMarkets())[0];
      expect(prior.constraintObservation?.refreshFailed).toBe(true);
      expect(invalid.constraintAuthority?.state).toBe('unavailable');
      get.mockRejectedValue(new Error('offline'));
      await expect(adapter.quantizeOrderSizeCeil('SOL-PERP', 0.21)).resolves.toBe(0.3);
      await expect(adapter.quantizeReductionPrice('SOL-PERP', 10.2)).resolves.toBe(10);
      clock.mockReturnValue(1_300_001);
      await expect(adapter.quantizeOrderSizeCeil('SOL-PERP', 0.21)).rejects.toThrow();
      // The later tick observation is still independently valid.
      await expect(adapter.quantizeReductionPrice('SOL-PERP', 10.2)).resolves.toBe(10);
    } finally { await adapter.shutdown(); clock.mockRestore(); }
  });

  it('revokes entry authority when a refresh omits a market, retaining bounded exit evidence', async () => {
    const adapter = new PacificaAdapter();
    const row = { symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 };
    const get = vi.fn().mockResolvedValue([row]);
    Object.defineProperty(adapter, 'get', { value: get });
    try {
      await adapter.initialize();
      const prior = (await adapter.getMarkets())[0];
      (adapter as any).marketCache.fetchedAt = 0;
      get.mockResolvedValue([{ ...row, symbol: 'BTC' }]);
      await adapter.getMarkets();
      expect(prior.constraintAuthority?.state).toBe('unavailable');
      get.mockRejectedValue(new Error('offline'));
      await expect(adapter.quantizeOrderSizeCeil('SOL-PERP', 0.21)).resolves.toBe(0.3);
    } finally { await adapter.shutdown(); }
  });

  it('rejects duplicate market rows rather than selecting arbitrary constraints', async () => {
    const adapter = new PacificaAdapter();
    const row = { symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 };
    Object.defineProperty(adapter, 'get', { value: vi.fn().mockResolvedValue([row, { ...row, lot_size: '1' }]) });
    await expect(adapter.initialize()).rejects.toThrow('ambiguous market symbols');
    await adapter.shutdown();
  });

  it('rejects a mark response if the local clock regresses during transport', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const adapter = new PacificaAdapter();
    const get = vi.fn().mockResolvedValue([{ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 }]);
    Object.defineProperty(adapter, 'get', { value: get });
    try {
      await adapter.initialize();
      get.mockImplementation(async () => {
        clock.mockReturnValue(999_999);
        return { success: true, data: [{ symbol: 'SOL', mark: '10', timestamp: 999_999 }] };
      });
      await expect(adapter.getMarkPrice('SOL-PERP')).resolves.toMatchObject({ kind: 'unavailable', reason: 'clock_regression' });
    } finally { await adapter.shutdown(); clock.mockRestore(); }
  });
});

describe('review corrections: independent exit authority', () => {
  it.each(['minimum', 'tick', 'minimum and tick'])(
    'submits a market close with missing %s and a valid lot', async missing => {
      const adapter = new PacificaAdapter();
      const row: Record<string, unknown> = { symbol: 'SOL', tick_size: '0.1', lot_size: '0.1',
        min_order_size: '10', max_leverage: 10 };
      if (missing.includes('minimum')) delete row.min_order_size;
      if (missing.includes('tick')) delete row.tick_size;
      const get = vi.spyOn(adapter as any, 'get').mockResolvedValue([row]);
      vi.spyOn(adapter as any, 'getStrictPositionForMarket').mockResolvedValue({ baseSize: 0.3 });
      vi.spyOn(adapter as any, 'ensurePacificaEnrollment').mockResolvedValue({ builderApproved: false });
      const post = vi.spyOn(adapter as any, 'post').mockResolvedValue({ order_id: 'close', status: 'filled' });
      vi.spyOn(adapter as any, 'mapOrderResponse').mockReturnValue({ success: true, status: 'filled', fillSize: 0.3 });
      const sign = vi.spyOn(PacificaSigner.prototype, 'buildRequestBody').mockImplementation(
        (_type: string, data: Record<string, unknown>) => ({ ...data, signature: 'EXAMPLE' }) as any);
      const exitStep = vi.spyOn(adapter as any, 'getExitStep');
      const mark = vi.spyOn(adapter, 'getMarkPrice');
      try {
        await adapter.initialize();
        const observation = (await adapter.getMarkets())[0].constraintObservation!;
        expect(observation.lot?.value).toBe(0.1);
        if (missing.includes('minimum')) expect(observation.openingMinimum).toBeNull();
        if (missing.includes('tick')) expect(observation.tick).toBeNull();
        expect(checkEntryConstraints(observation, 'SOL-PERP', Date.now()).ok).toBe(false);
        const result = await adapter.closePosition({ agentPublicKey: 'account',
          agentSecretKey: new Uint8Array(64), mainWalletAddress: 'owner', internalSymbol: 'SOL-PERP' });
        expect(result).toMatchObject({ success: true, status: 'filled', fillSize: 0.3 });
        expect(sign).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
          amount: '0.3', reduce_only: true, side: 'ask',
        }), 'account', null);
        expect(post).toHaveBeenCalledOnce();
        expect(post).toHaveBeenCalledWith('/orders/create_market', expect.objectContaining({
          amount: '0.3', reduce_only: true,
        }));
        expect(exitStep.mock.calls).toEqual([['SOL-PERP', 'lot']]);
        expect(mark).not.toHaveBeenCalled();
        expect(get).toHaveBeenCalledTimes(1);
      } finally { await adapter.shutdown(); }
    });

  it.each(['SOL-PERP', 'sol-perp', 'SoL-PeRp'])(
    'normalizes %s exit lookups without revoking shared entry authority', async symbol => {
      const adapter = new PacificaAdapter();
      const get = vi.spyOn(adapter as any, 'get').mockResolvedValue([{ symbol: 'SOL',
        tick_size: '0.1', lot_size: '0.1', min_order_size: '10', max_leverage: 10 }]);
      try {
        await adapter.initialize();
        const shared = (await adapter.getMarkets())[0];
        updateMarketCache([shared]);
        const registered = getMarketInfo('SOL-PERP')!;
        await expect(adapter.quantizeReductionPrice(symbol, 10.04)).resolves.toBe(10);
        await expect(adapter.quantizeOrderSizeCeil(symbol, 0.21)).resolves.toBe(0.3);
        expect(get).toHaveBeenCalledTimes(1);
        expect(registered.constraintObservation).toBe(shared.constraintObservation);
        expect(shared.constraintObservation?.refreshFailed).toBe(false);
        expect(checkEntryConstraints(registered.constraintObservation, 'SOL-PERP', Date.now())).toEqual({ ok: true });
        expect(adapter.quantizeOrderSize('SOL-PERP', 0.3)).toBe(0.3);
      } finally {
        updateMarketCache([]);
        await adapter.shutdown();
      }
    });
});

describe('review corrections: fresh-required HTTP cache authority', () => {
  const initialTime = 1_800_000_000_000;
  const row = (minimum = '10') => ({ symbol: 'SOL', tick_size: '0.1', lot_size: '0.1',
    min_order_size: minimum, max_leverage: 10 });
  const prices = (mark = '100') => ({ success: true,
    data: [{ symbol: 'SOL', mark, timestamp: Date.now() }] });
  const ok = (data: unknown) => new Response(JSON.stringify(data), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  const rateLimited = () => new Response('rate limited', { status: 429 });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(initialTime);
    pacificaCache.invalidateAll();
    vi.spyOn(pacificaQuota, 'canAfford').mockReturnValue(true);
    vi.spyOn(pacificaQuota, 'record').mockImplementation(() => {});
    vi.spyOn(pacificaQuota, 'noteRejection').mockImplementation(() => {});
  });
  afterEach(() => {
    pacificaCache.invalidateAll();
    vi.useRealTimers();
  });

  async function seed() {
    const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const path = new URL(String(input)).pathname;
      if (path === '/info') return ok({ success: true, data: [row()] });
      if (path === '/info/prices') return ok(prices());
      throw new Error(`Unexpected HTTP path: ${path}`);
    });
    const adapter = new PacificaAdapter({ baseUrl: 'http://test-pacifica.invalid' });
    await adapter.initialize();
    const previous = (await adapter.getMarkets())[0];
    expect(await adapter.getMarkPrice('SOL-PERP')).toMatchObject({ kind: 'available', exact: '100' });
    vi.setSystemTime(initialTime + 300_001);
    transport.mockClear();
    // Both real REST cache entries remain present, but neither is trading authority.
    expect(pacificaCache.getStale('/info')?.ageMs).toBe(300_001);
    expect(pacificaCache.getStale('/info/prices:envelope')?.ageMs).toBe(300_001);
    return { adapter, transport, previous };
  }

  it.each(['quota', '429'] as const)(
    'does not serve stale constraints or marks under %s, although display fallback can', async failure => {
      const { adapter, transport, previous } = await seed();
      try {
        if (failure === 'quota') vi.mocked(pacificaQuota.canAfford).mockReturnValue(false);
        transport.mockImplementation(async () => rateLimited());
        const markets = adapter.getMarkets().then(() => 'unexpected success', error => error);
        const mark = adapter.getMarkPrice('SOL-PERP');
        if (failure === 'quota') await vi.advanceTimersByTimeAsync(8_001);
        expect(await markets).toBeInstanceOf(Error);
        expect(await mark).toMatchObject({ kind: 'unavailable',
          reason: failure === 'quota' ? 'quota_unavailable' : 'rate_limited' });
        expect(previous.constraintObservation?.refreshFailed).toBe(true);
        expect(previous.constraintObservation?.observedAt).toBe(initialTime);
        expect(checkEntryConstraints(previous.constraintObservation, 'SOL-PERP', Date.now()).ok).toBe(false);
        expect(() => adapter.quantizeOrderSize('SOL-PERP', 1)).toThrow();
        expect(transport).toHaveBeenCalledTimes(failure === 'quota' ? 0 : 2);
        // Positive control: the same cache really can supply the default policy's fallback.
        expect(await (adapter as any).get('/info', undefined, { bypassCache: true })).toEqual([row()]);
        expect(await (adapter as any).get('/info/prices', undefined,
          { bypassCache: true, responseShape: 'envelope' })).toMatchObject({
          data: [{ mark: '100', timestamp: initialTime }],
        });
      } finally { await adapter.shutdown(); }
    });

  it.each(['success', '429'] as const)(
    'deduplicates concurrent refreshes with %s and never resolves callers with stale data', async outcome => {
      const { adapter, transport, previous } = await seed();
      const releases = new Map<string, (response: Response) => void>();
      transport.mockImplementation(input => new Promise<Response>(resolve => {
        const path = new URL(String(input)).pathname;
        if (releases.has(path)) throw new Error(`Duplicate fetch storm: ${path}`);
        releases.set(path, resolve);
      }));
      try {
        let settled = 0;
        const markets = Array.from({ length: 8 }, () => adapter.getMarkets().finally(() => { settled++; }));
        const marks = Array.from({ length: 8 }, () => adapter.getMarkPrice('SOL-PERP').finally(() => { settled++; }));
        const allMarkets = Promise.allSettled(markets);
        const allMarks = Promise.all(marks);
        await vi.advanceTimersByTimeAsync(0);
        expect(transport).toHaveBeenCalledTimes(2);
        expect([...releases.keys()].sort()).toEqual(['/info', '/info/prices']);
        expect(settled).toBe(0);
        expect(checkEntryConstraints(previous.constraintObservation, 'SOL-PERP', Date.now()).ok).toBe(false);
        releases.get('/info')!(outcome === '429' ? rateLimited()
          : ok({ success: true, data: [row('20')] }));
        releases.get('/info/prices')!(outcome === '429' ? rateLimited() : ok(prices('120')));
        const marketResults = await allMarkets;
        const markResults = await allMarks;
        expect(settled).toBe(16);
        for (const result of marketResults) {
          if (outcome === '429') expect(result.status).toBe('rejected');
          else {
            expect(result.status).toBe('fulfilled');
            if (result.status !== 'fulfilled') throw result.reason;
            expect(result.value[0].constraintObservation).toMatchObject({
              openingMinimum: { value: 20 }, observedAt: Date.now(), refreshFailed: false,
            });
            expect(checkEntryConstraints(result.value[0].constraintObservation, 'SOL-PERP', Date.now())).toEqual({ ok: true });
          }
        }
        for (const result of markResults) expect(result).toMatchObject(outcome === '429'
          ? { kind: 'unavailable', reason: 'rate_limited' }
          : { kind: 'available', exact: '120', observedAt: Date.now() });
        expect(previous.constraintObservation?.observedAt).toBe(initialTime);
        expect(pacificaCache.snapshot().inflight).toBe(0);
        expect(transport).toHaveBeenCalledTimes(2);
        // A settled failed wave must release its slots so a later fresh read can recover.
        if (outcome === '429') {
          transport.mockImplementation(async input => new URL(String(input)).pathname === '/info'
            ? ok({ success: true, data: [row('20')] }) : ok(prices('120')));
          expect((await adapter.getMarkets())[0].minOrderSizeUsd).toBe(20);
          expect(await adapter.getMarkPrice('SOL-PERP')).toMatchObject({ kind: 'available', exact: '120' });
          expect(transport).toHaveBeenCalledTimes(4);
        }
      } finally { await adapter.shutdown(); }
    });
});
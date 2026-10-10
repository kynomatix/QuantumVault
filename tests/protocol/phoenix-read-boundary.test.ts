import { afterEach, describe, expect, it, vi } from 'vitest';
import { PhoenixReadAdapter, parsePhoenixMarkets } from '../../server/protocol/phoenix/phoenix-read-adapter';
import { PHOENIX_PUBLIC_ADDRESSES, phoenixBaseUnitsToLots, phoenixPriceUsdToTicks, phoenixLotSize, phoenixTickSizeUsd } from '../../server/protocol/phoenix/sdk-boundary';
import { PhoenixRestTransport } from '../../server/protocol/phoenix/transport';
import { getPhoenixReader, phoenixReadsEnabled, phoenixReadRefreshMs, startPhoenixPublicReads, stopPhoenixPublicReads } from '../../server/protocol/phoenix/runtime';
import { getDefaultAdapter, listAdapters, registerAdapter, unregisterAdapter } from '../../server/protocol/adapter-registry';
import type { ProtocolAdapter } from '../../server/protocol/adapter';
import { requirePhoenixMoneyCapability, phoenixWithdrawalDelayText, unknownPhoenixObservation } from '../../shared/phoenix-read-contract';

const market = (symbol = 'BTC', decimals = 4) => ({ symbol, assetId: 1, baseLotsDecimals: decimals, tickSize: 100,
  marketStatus: 'active', makerFee: 0.00005, takerFee: 0.00035, leverageTiers: [{ maxLeverage: 20 }], isolatedOnly: false });
const exchange = (markets: unknown[] = [market()]) => ({ keys: { canonicalMint: PHOENIX_PUBLIC_ADDRESSES.collateralMint,
  withdrawQueue: 'EXAMPLE'.padEnd(32, '1') }, markets });
const status = { active: true, gated: true, runningState: 'active', withdrawalsAvailable: true };
function fixture() {
  let now = 1_000_000;
  const get = vi.fn(async (path: string): Promise<unknown> => path.endsWith('/status') ? { ...status } : exchange());
  const reader = new PhoenixReadAdapter({ get }, () => now);
  return { reader, get, advance: (ms: number) => { now += ms; }, now: () => now };
}
afterEach(() => { stopPhoenixPublicReads(); unregisterAdapter('pacifica'); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Rise 0.6.1 decimal wire boundary', () => {
  it.each([[4, '1.23459', 12345n], [0, '1.99', 1n], [-2, '1234.5', 12n], [3, '9007199254740993.123', 9007199254740993123n]])(
    'floors exact base lots for decimals %s', (decimals, input, expected) => expect(phoenixBaseUnitsToLots(input, decimals)).toBe(expected));
  it.each([[4, '100', '1', '0.0001'], [3, '100', '0.1', '0.001'], [2, '100', '0.01', '0.01'], [-2, '10', '0.0000001', '100']])(
    'derives dollar ticks and base lots for decimals %s', (baseLotsDecimals, tickSize, tickUsd, lot) => {
      const params = { baseLotsDecimals, tickSize };
      expect(phoenixTickSizeUsd(params)).toBe(tickUsd); expect(phoenixLotSize(params)).toBe(lot);
    });
  it('matches the SDK micro-USD floor before tick conversion', () => {
    expect(phoenixPriceUsdToTicks('123.999', { baseLotsDecimals: 4, tickSize: '100' })).toBe(123n);
    expect(phoenixPriceUsdToTicks('0.0000019', { baseLotsDecimals: -2, tickSize: '10' })).toBe(10n);
  });
  it.each(['-1', 'NaN', 'Infinity', '1e3', '', '1.2.3'])('rejects invalid amount %s', value => {
    expect(() => phoenixBaseUnitsToLots(value, 4)).toThrow();
  });
  it('rejects invalid precision and zero tick', () => {
    expect(() => phoenixBaseUnitsToLots('1', 1.5)).toThrow();
    expect(() => phoenixBaseUnitsToLots('1', 99)).toThrow();
    expect(() => phoenixPriceUsdToTicks('1', { baseLotsDecimals: 4, tickSize: '0' })).toThrow();
  });
});

describe('public snapshots never authorize money', () => {
  it('covers the full catalog, negative decimals, disabled markets and missing symbols', async () => {
    const f = fixture();
    const catalog = Array.from({ length: 94 }, (_, i) => ({ ...market(`ASSET${i}`, i % 2 ? -2 : 4), assetId: i,
      marketStatus: i === 93 ? 'disabled' : 'active' }));
    f.get.mockImplementation(async path => path.endsWith('/status') ? status : exchange(catalog));
    await f.reader.refresh();
    expect(f.reader.getMarkets().value).toHaveLength(94);
    expect(f.reader.getMarket('ASSET93-PERP').value?.isActive).toBe(false);
    expect(f.reader.getMarket('ASSET1').value?.lotSizeBase).toBe('100');
    expect(f.reader.getMarket('MISSING').state).toBe('unknown');
  });
  it('keeps unavailable precision, fees and minimums unknown', () => {
    const [result] = parsePhoenixMarkets([{ ...market(), makerFee: undefined, takerFee: '0.1', tickSize: 0,
      baseLotsDecimals: undefined, leverageTiers: [], marketStatus: undefined }]);
    expect(result).toMatchObject({ tickSizeUsd: null, lotSizeBase: null, minOrderNotionalUsd: null,
      makerFeeRate: null, takerFeeRate: null, maxLeverage: null, isActive: false, marketStatus: 'unknown' });
  });
  it.each([null, {}, [], [market(), market()], [{ ...market(), assetId: '1' }]])('rejects malformed/duplicate snapshots', value => {
    expect(() => parsePhoenixMarkets(value)).toThrow();
  });
  it('separates public availability, queue identity, unknown delay and account cash', async () => {
    const f = fixture(); await f.reader.refresh();
    const caps = f.reader.getCapabilities();
    expect(caps.withdrawals.availability).toMatchObject({ state: 'fresh', value: true });
    expect(caps.withdrawals.queueAccount.state).toBe('fresh');
    expect(caps.withdrawals.queueLength.state).toBe('unknown');
    expect(caps.withdrawals.delay.state).toBe('unknown');
    expect(caps.withdrawals.settlementEndpoint.state).toBe('unknown');
    expect(caps.custody.requiresDeposit).toBe(true);
    for (const name of ['walletAvailableUsdc', 'venueCollateralUsdc', 'withdrawableUsdc', 'queuedReturnUsdc'] as const)
      expect(caps.custody[name]).toMatchObject({ state: 'unknown', value: null });
    for (const [operation, authority] of Object.entries(caps.operations)) {
      expect(authority.ready).toBe(false);
      expect(() => requirePhoenixMoneyCapability(caps, operation as keyof typeof caps.operations)).toThrow();
    }
    expect(() => requirePhoenixMoneyCapability(undefined, 'trade')).toThrow();
    expect(caps.supportsCarryOnClose).toBe(false); expect(caps.supportsPerBotExternalDebt).toBe(false);
    expect(caps.recycling).toEqual({ supported: false, permanent: 'unknown', maxPerAuthority: null });
  });
  it('preserves false availability and never coerces an unknown value', async () => {
    const f = fixture();
    f.get.mockImplementation(async path => path.endsWith('/status') ? { ...status, withdrawalsAvailable: false } : exchange());
    await f.reader.refresh(); expect(f.reader.getCapabilities().withdrawals.availability.value).toBe(false);
    f.advance(60_000); f.get.mockImplementation(async path => path.endsWith('/status') ? { ...status, withdrawalsAvailable: 'true' } : exchange());
    await f.reader.refresh(); expect(f.reader.getCapabilities().withdrawals.availability.state).toBe('unknown');
  });
  it('expires observations and does not expose mutable cached authority', async () => {
    const f = fixture(); await f.reader.refresh();
    f.reader.getMarkets().value![0].isActive = false;
    expect(f.reader.getMarket('BTC').value?.isActive).toBe(true);
    f.advance(120_000);
    expect(f.reader.getCapabilities().publicReads).toBe('stale');
    expect(f.reader.getCapabilities().withdrawals.availability.state).toBe('stale');
  });
  it('invalidates cached data on HTTP failure without substituting an empty catalog', async () => {
    const f = fixture(); await f.reader.refresh(); f.advance(60_000);
    f.get.mockRejectedValue(new Error('offline'));
    await expect(f.reader.refresh()).rejects.toThrow('unavailable');
    expect(f.reader.getMarkets()).toMatchObject({ state: 'stale', reason: 'snapshot_failed' });
    expect(f.reader.getMarkets().value).toHaveLength(1);
  });
  it('rejects a wrong canonical mint and malformed status atomically', async () => {
    const f = fixture(); f.get.mockResolvedValue({ ...exchange(), keys: { canonicalMint: 'EXAMPLE' } });
    await expect(f.reader.refresh()).rejects.toThrow(); expect(f.reader.getMarkets().state).toBe('unknown');
    f.advance(60_000); f.get.mockImplementation(async path => path.endsWith('/status') ? { ...status, gated: 'true' } : exchange());
    await expect(f.reader.refresh()).rejects.toThrow(); expect(f.reader.getMarkets().state).toBe('unknown');
  });
  it('coalesces concurrent refreshes and refuses tight-loop retries', async () => {
    const f = fixture(); await Promise.all([f.reader.refresh(), f.reader.refresh(), f.reader.refresh()]);
    expect(f.get).toHaveBeenCalledTimes(2); await f.reader.refresh(); expect(f.get).toHaveBeenCalledTimes(2);
  });
  it('requires a new REST snapshot after WS gaps and rejects an interrupted snapshot', async () => {
    const f = fixture(); await f.reader.refresh(); f.reader.onPublicStreamInvalidation('gap');
    expect(f.reader.getMarkets().state).toBe('stale');
    f.advance(60_000); await f.reader.refresh(); expect(f.reader.getMarkets().state).toBe('fresh');
    f.advance(60_000); const pending = f.reader.refresh(); f.reader.onPublicStreamInvalidation('disconnect'); await pending;
    expect(f.reader.getMarkets().state).toBe('stale');
  });
  it('does not let in-flight reads resurrect a stopped reader', async () => {
    const f = fixture(); const pending = f.reader.refresh(); f.reader.shutdown(); await pending;
    expect(f.reader.getCapabilities().publicReads).toBe('disabled');
    await expect(f.reader.refresh()).rejects.toThrow('stopped');
  });
});

describe('isolation and budgets', () => {
  it('accepts only conservative configured snapshot budgets', () => {
    expect(phoenixReadRefreshMs({ PHOENIX_READ_REFRESH_MS: '30000' })).toBe(30_000);
    for (const value of [undefined, '0', 'NaN', '29999', '60001']) expect(phoenixReadRefreshMs({ PHOENIX_READ_REFRESH_MS: value })).toBe(60_000);
  });
  it('is disabled by default and only accepts the exact explicit flag', () => {
    const create = vi.fn(); startPhoenixPublicReads({}, create);
    expect(create).not.toHaveBeenCalled(); expect(getPhoenixReader()).toBeNull();
    for (const value of [undefined, 'false', '1', 'TRUE']) expect(phoenixReadsEnabled({ PHOENIX_READS_ENABLED: value })).toBe(false);
    expect(phoenixReadsEnabled({ PHOENIX_READS_ENABLED: 'true' })).toBe(true);
  });
  it('contains Phoenix startup/read failure and preserves the Pacifica default', async () => {
    vi.useFakeTimers();
    const pacifica = { protocolName: 'pacifica' } as ProtocolAdapter; registerAdapter(pacifica);
    startPhoenixPublicReads({ PHOENIX_READS_ENABLED: 'true' }, () => { throw new Error('startup'); });
    expect(getDefaultAdapter()).toBe(pacifica); expect(listAdapters()).toEqual(['pacifica']);
    const f = fixture(); f.get.mockRejectedValue(new Error('offline'));
    const stream = { start: vi.fn(), shutdown: vi.fn() };
    startPhoenixPublicReads({ PHOENIX_READS_ENABLED: 'true' }, () => f.reader, () => stream as any);
    await vi.advanceTimersByTimeAsync(0);
    expect(getPhoenixReader()?.getCapabilities().publicReads).toBe('unknown');
    expect(getDefaultAdapter()).toBe(pacifica);
    expect(() => registerAdapter(f.reader as unknown as ProtocolAdapter)).toThrow('execution is not implemented');
  });
  it('enforces fixed GET paths, size caps and Retry-After', async () => {
    let now = 1_000_000;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
    const transport = new PhoenixRestTransport(fetcher as typeof fetch, () => now);
    await expect(transport.get('/v1/view/exchange')).rejects.toThrow('429');
    now += 60_000; await expect(transport.get('/v1/view/exchange/status')).rejects.toThrow('budget');
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 60_000; fetcher.mockResolvedValue(new Response('x'.repeat(2_000_001)));
    await expect(transport.get('/v1/view/exchange')).rejects.toThrow('too large');
    await expect(transport.get('/v1/trade' as any)).rejects.toThrow('Unsupported');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'error' });
  });
  it('aborts stalled public requests within the configured timeout', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_url, options) => new Promise<Response>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const transport = new PhoenixRestTransport(fetcher as typeof fetch);
    const assertion = expect(transport.get('/v1/view/exchange')).rejects.toThrow('aborted');
    await vi.advanceTimersByTimeAsync(5_000); await assertion;
  });
});

describe('withdrawal display', () => {
  it('uses unknown wording until fresh sourced measurements/publications exist', () => {
    const details = new PhoenixReadAdapter({ get: vi.fn() }).getCapabilities().withdrawals;
    expect(phoenixWithdrawalDelayText(details)).toBe('Withdrawal delay not yet measured');
    details.delay = { state: 'fresh', value: { seconds: 42, basis: 'published' }, observedAt: 1000, source: 'EXAMPLE', reason: null };
    expect(phoenixWithdrawalDelayText(details, 1000)).toBe('Published withdrawal delay: 42 seconds');
    details.delay.value!.basis = 'measured'; expect(phoenixWithdrawalDelayText(details, 1000)).toContain('Measured');
    expect(phoenixWithdrawalDelayText(details, 122_000)).toBe('Withdrawal delay not yet measured');
    details.delay = unknownPhoenixObservation(); expect(phoenixWithdrawalDelayText(details)).toBe('Withdrawal delay not yet measured');
  });
});


describe('display-only public mids', () => {
  it('maps exact venue symbols, expires prices and never turns missing data into zero', async () => {
    const f = fixture();
    f.get.mockImplementation(async path => path.endsWith('/status') ? status : exchange([{ ...market('kBONK', -2), assetId: 9 }]));
    await f.reader.refresh(); f.reader.onPublicMids({ kBONK: 0.003, UNKNOWN: 123 });
    expect(f.reader.getPrices().value).toEqual({ 'KBONK-PERP': 0.003 });
    expect(f.reader.getPrice('kBONK')).toMatchObject({ state: 'fresh', value: 0.003 });
    expect(f.reader.getPrice('BTC').value).toBeNull();
    f.advance(15_000); expect(f.reader.getPrice('kBONK').state).toBe('stale');
    f.reader.onPublicMids({ kBONK: 0.004 }); f.reader.onPublicStreamInvalidation('disconnect');
    expect(f.reader.getPrice('kBONK')).toMatchObject({ state: 'stale', value: 0.004 });
    expect(f.reader.getCapabilities().operations.trade.ready).toBe(false);
  });
  it.each([{}, [], { BTC: 0 }, { BTC: -1 }, { BTC: '42' }, { BTC: Infinity }, { BTC: NaN }])('rejects malformed price snapshots', async input => {
    const f = fixture(); await f.reader.refresh(); f.reader.onPublicMids({ BTC: 42 });
    expect(() => f.reader.onPublicMids(input)).toThrow();
    expect(f.reader.getPrice('BTC')).toMatchObject({ state: 'stale', value: 42 });
  });
  it('does not resurrect prices after shutdown or expose mutable snapshots', async () => {
    const f = fixture(); await f.reader.refresh(); f.reader.onPublicMids({ BTC: 42 });
    f.reader.getPrices().value!['BTC-PERP'] = 1;
    expect(f.reader.getPrice('BTC').value).toBe(42);
    f.reader.shutdown(); f.reader.onPublicMids({ BTC: 99 });
    expect(f.reader.getPrice('BTC')).toMatchObject({ state: 'stale', value: 42 });
  });
});
